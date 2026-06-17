"""Vault file watcher — read-only sync into Vault rows."""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from src.vault_fs import invalidate_cache

logger = logging.getLogger(__name__)

# Lightweight frontmatter parse (no heavy deps) --------------------------------

_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_WIKI_LINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")
_MD_LINK_RE = re.compile(r"(?<!\!)\[([^\]]*)\]\(([^)]+)\)")


def _parse_frontmatter(raw: str) -> Tuple[str, str]:
    """Return (frontmatter_raw, body). Frontmatter is empty string if absent."""
    m = _FM_RE.match(raw)
    if m:
        return m.group(1), raw[m.end():]
    return "", raw


def _parse_yaml_tags(yaml_text: str) -> List[str]:
    """Naive tag extraction: look for 'tags:' key and comma/list values."""
    tags: List[str] = []
    in_tags = False
    for line in yaml_text.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("tags:"):
            in_tags = True
            # Inline list or string after colon
            val = stripped.split(":", 1)[1].strip()
            if val.startswith("["):
                # YAML inline list
                tags = [t.strip().strip('"').strip("'") for t in val.strip("[]").split(",") if t.strip()]
            elif val:
                tags = [t.strip() for t in val.split(",") if t.strip()]
            continue
        if in_tags:
            if stripped.startswith("-"):
                tags.append(stripped.lstrip("-").strip().strip('"').strip("'"))
            else:
                in_tags = False
    return tags


def _extract_links(body: str, vault_root: Path, note_rel_path: str) -> List[str]:
    """Extract all wiki-links and markdown links from body, normalize targets."""
    targets: Set[str] = set()
    note_dir = Path(note_rel_path).parent

    # [[WikiLink]] or [[WikiLink|alias]]
    for m in _WIKI_LINK_RE.finditer(body):
        target = m.group(1).strip()
        # Vault: [[Note]] resolves to Note.md in same folder or vault root
        target_path = _resolve_vault_link(target, note_dir, vault_root)
        if target_path:
            targets.add(target_path)

    # [text](path.md) or [text](path)
    for m in _MD_LINK_RE.finditer(body):
        href = m.group(2).strip()
        # Skip external URLs and anchors
        if href.startswith("http://") or href.startswith("https://") or href.startswith("#"):
            continue
        target_path = _resolve_relative_link(href, note_dir, vault_root)
        if target_path:
            targets.add(target_path)

    return sorted(targets)


def _resolve_vault_link(target: str, note_dir: Path, vault_root: Path) -> Optional[str]:
    """Resolve [[Target]] to a relative path inside the vault."""
    # Vault: [[Folder/Note]] is a subfolder reference
    target_path = Path(target.replace("\\", "/"))
    if target_path.suffix != ".md":
        target_path = target_path.with_suffix(".md")

    # Try relative to note's folder first, then vault root
    candidates = [
        note_dir / target_path,
        vault_root / target_path,
    ]
    for cand in candidates:
        try:
            cand.relative_to(vault_root)  # ensure it's inside vault
            # Check if file exists (case-insensitive on some systems)
            resolved = _find_file_case_insensitive(cand)
            if resolved:
                return str(Path(resolved).relative_to(vault_root)).replace("\\", "/")
        except ValueError:
            pass
    # Even if file doesn't exist yet, return the canonical path
    rel = str(target_path).replace("\\", "/")
    return rel


def _resolve_relative_link(href: str, note_dir: Path, vault_root: Path) -> Optional[str]:
    """Resolve [text](href) to a relative path inside the vault."""
    href_path = Path(href.replace("\\", "/"))
    if href_path.suffix != ".md":
        href_path = href_path.with_suffix(".md")
    candidate = note_dir / href_path
    try:
        resolved = _find_file_case_insensitive(candidate)
        if resolved:
            return str(Path(resolved).relative_to(vault_root)).replace("\\", "/")
    except ValueError:
        pass
    return str(href_path).replace("\\", "/")


def _find_file_case_insensitive(path: Path) -> Optional[str]:
    """Return the actual on-disk path if it exists (case-insensitive check)."""
    if path.exists():
        return str(path.resolve())
    # Try case-insensitive search in parent directory
    parent = path.parent
    name_lower = path.name.lower()
    if parent.exists():
        for child in parent.iterdir():
            if child.name.lower() == name_lower:
                return str(child.resolve())
    return None


# Debounce ----------------------------------------------------------------------

_DEBOUNCE_SECONDS = 0.5
_debounce_timers: Dict[str, Any] = {}


def _debounced_invalidate(vault_path: str) -> None:
    """Invalidate cache after a short delay, resetting on repeated calls."""
    key = vault_path
    existing = _debounce_timers.get(key)
    if existing:
        existing.cancel()

    def _do():
        _debounce_timers.pop(key, None)
        invalidate_cache(vault_path)

    import threading
    t = threading.Timer(_DEBOUNCE_SECONDS, _do)
    _debounce_timers[key] = t
    t.start()


# Watcher -----------------------------------------------------------------------

class VaultWatcher:
    """Per-vault file watcher. Manages one Observer keyed by (owner, vault_path)."""

    def __init__(self) -> None:
        self._watchers: Dict[Tuple[str, str], "_VaultObserver"] = {}

    def connect(self, owner: str, vault_path: str) -> Tuple[bool, str]:
        """Start watching a vault for a user. Returns (ok, message)."""
        key = (owner, vault_path)
        if key in self._watchers:
            return True, "Already connected"

        vault = Path(vault_path).resolve()
        if not vault.exists():
            return False, f"Vault path does not exist: {vault_path}"
        if not vault.is_dir():
            return False, f"Vault path is not a directory: {vault_path}"

        try:
            obs = _VaultObserver(owner, str(vault))
            obs.start()
            self._watchers[key] = obs
            logger.info(f"Vault watcher started for {owner} at {vault}")
            return True, "Connected"
        except Exception as e:
            logger.exception(f"Failed to start watcher for {owner} at {vault}")
            return False, str(e)

    def disconnect(self, owner: str, vault_path: str) -> None:
        """Stop watching a vault for a user."""
        key = (owner, vault_path)
        obs = self._watchers.pop(key, None)
        if obs:
            obs.stop()
            logger.info(f"Vault watcher stopped for {owner} at {vault_path}")

    def disconnect_all(self) -> None:
        """Stop all watchers (called on app shutdown)."""
        for key, obs in list(self._watchers.items()):
            obs.stop()
            logger.info(f"Vault watcher stopped for {key}")
        self._watchers.clear()

    def is_connected(self, owner: str, vault_path: str) -> bool:
        return (owner, vault_path) in self._watchers

    def get_connected_vaults(self, owner: str) -> List[str]:
        """Return list of vault paths connected for this owner."""
        return [vp for o, vp in self._watchers if o == owner]


class _VaultObserver:
    """Wraps watchdog for a single vault."""

    def __init__(self, owner: str, vault_path: str) -> None:
        self.owner = owner
        self.vault_path = Path(vault_path)
        self._observer: Optional[object] = None
        self._handler: Optional[object] = None

    def start(self) -> None:
        try:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler
        except ImportError:
            logger.warning("watchdog not installed; falling back to one-time scan")
            import threading
            threading.Thread(target=self._initial_scan, daemon=True, name=f"vault-scan-{self.owner}").start()
            return

        self._handler = _VaultEventHandler(self.owner, self.vault_path)
        self._observer = Observer()
        self._observer.schedule(self._handler, str(self.vault_path), recursive=True)
        self._observer.start()
        # Initial scan runs in background so connect() returns instantly
        import threading
        threading.Thread(target=self._initial_scan, daemon=True, name=f"vault-scan-{self.owner}").start()

    def stop(self) -> None:
        if self._observer:
            self._observer.stop()
            self._observer.join()
            self._observer = None
        _mark_disconnected(self.owner, str(self.vault_path))

    def _initial_scan(self) -> None:
        """Scan all .md files in the vault and sync them."""
        for md_file in self.vault_path.rglob("*.md"):
            try:
                _sync_file(self.owner, self.vault_path, md_file)
            except Exception:
                logger.exception(f"Failed to sync {md_file}")


class _VaultEventHandler:
    """watchdog event handler for markdown file changes."""

    def __init__(self, owner: str, vault_path: Path) -> None:
        self.owner = owner
        self.vault_path = vault_path

    def on_created(self, event):
        logger.debug(f"[watcher] created: {event.src_path} is_dir={event.is_directory}")
        _debounced_invalidate(str(self.vault_path))
        if not event.is_directory and event.src_path.endswith(".md"):
            _sync_file(self.owner, self.vault_path, Path(event.src_path))

    def on_modified(self, event):
        logger.debug(f"[watcher] modified: {event.src_path} is_dir={event.is_directory}")
        _debounced_invalidate(str(self.vault_path))
        if not event.is_directory and event.src_path.endswith(".md"):
            _sync_file(self.owner, self.vault_path, Path(event.src_path))

    def on_deleted(self, event):
        logger.debug(f"[watcher] deleted: {event.src_path} is_dir={event.is_directory}")
        _debounced_invalidate(str(self.vault_path))
        if not event.is_directory and event.src_path.endswith(".md"):
            _mark_deleted(self.owner, self.vault_path, Path(event.src_path))

    def on_moved(self, event):
        logger.debug(f"[watcher] moved: {event.src_path} -> {event.dest_path} is_dir={event.is_directory}")
        _debounced_invalidate(str(self.vault_path))
        if not event.is_directory:
            if event.src_path.endswith(".md"):
                _mark_deleted(self.owner, self.vault_path, Path(event.src_path))
            if event.dest_path.endswith(".md"):
                _sync_file(self.owner, self.vault_path, Path(event.dest_path))


# Sync logic --------------------------------------------------------------------

def _sync_file(owner: str, vault_root: Path, file_path: Path) -> None:
    """Read a markdown file and upsert into the database."""
    try:
        rel_path = str(file_path.relative_to(vault_root)).replace("\\", "/")
    except ValueError:
        logger.warning(f"File outside vault: {file_path}")
        return

    # Skip hidden / dot-folders (Vault .vault/, .trash/)
    parts = Path(rel_path).parts
    if any(p.startswith(".") for p in parts):
        return

    try:
        raw = file_path.read_text(encoding="utf-8")
    except (IOError, UnicodeDecodeError) as e:
        logger.warning(f"Cannot read {file_path}: {e}")
        return

    frontmatter_raw, body = _parse_frontmatter(raw)
    tags = _parse_yaml_tags(frontmatter_raw)
    links = _extract_links(body, vault_root, rel_path)
    title = _extract_title(frontmatter_raw, file_path)
    folder = str(Path(rel_path).parent) if Path(rel_path).parent != Path(".") else ""
    stat = file_path.stat()
    mtime = datetime.fromtimestamp(stat.st_mtime)
    birth_time = datetime.fromtimestamp(getattr(stat, 'st_birthtime', None) or getattr(stat, 'st_ctime', stat.st_mtime))

    _upsert_note(owner, str(vault_root), rel_path, folder, title, body,
                 frontmatter_raw, tags, links, mtime, birth_time)


def _extract_title(frontmatter_raw: str, file_path: Path) -> str:
    """Extract title from frontmatter or fall back to filename stem."""
    for line in frontmatter_raw.splitlines():
        if line.lower().strip().startswith("title:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
    return file_path.stem


def _upsert_note(owner: str, vault_path: str, rel_path: str, folder: str,
                 title: str, body: str, frontmatter: str, tags: List[str],
                 links: List[str], mtime: datetime, birth_time: datetime = None) -> None:
    """Upsert a Vault row and recompute backlinks."""
    from core.database import SessionLocal, Vault
    import uuid

    db = SessionLocal()
    try:
        note_id = f"{owner}:{vault_path}:{rel_path}"
        existing = db.query(Vault).filter_by(
            owner=owner, vault_path=vault_path, rel_path=rel_path
        ).first()

        if existing:
            existing.title = title
            existing.content = body
            existing.frontmatter = frontmatter
            existing.tags = json.dumps(tags)
            existing.outbound_links = json.dumps(links)
            existing.folder = folder
            existing.last_modified_src = mtime
            existing.sync_status = "synced"
            # Do NOT overwrite created_at on updates — preserve first-seen birth time
        else:
            db.add(Vault(
                id=note_id,
                owner=owner,
                vault_path=vault_path,
                rel_path=rel_path,
                folder=folder,
                title=title,
                content=body,
                frontmatter=frontmatter,
                tags=json.dumps(tags),
                outbound_links=json.dumps(links),
                backlinks="[]",
                created_at=birth_time or mtime,
                last_modified_src=mtime,
                sync_status="synced",
            ))
        db.commit()
        _recompute_backlinks(db, owner, vault_path)
    finally:
        db.close()


def _mark_deleted(owner: str, vault_root: Path, file_path: Path) -> None:
    """Mark a note as deleted (file removed from vault)."""
    from core.database import SessionLocal, Vault
    try:
        rel_path = str(file_path.relative_to(vault_root)).replace("\\", "/")
    except ValueError:
        return

    db = SessionLocal()
    try:
        note = db.query(Vault).filter_by(
            owner=owner, vault_path=str(vault_root), rel_path=rel_path
        ).first()
        if note:
            note.sync_status = "deleted"
            db.commit()
            _recompute_backlinks(db, owner, str(vault_root))
    finally:
        db.close()


def _mark_disconnected(owner: str, vault_path: str) -> None:
    """Set sync_status to disconnected for all notes in this vault."""
    from core.database import SessionLocal, Vault
    db = SessionLocal()
    try:
        db.query(Vault).filter_by(
            owner=owner, vault_path=vault_path
        ).update({"sync_status": "disconnected"}, synchronize_session=False)
        db.commit()
    finally:
        db.close()


def _recompute_backlinks(db, owner: str, vault_path: str) -> None:
    """Recompute the backlinks column for all notes in this vault."""
    from sqlalchemy import text
    notes = db.execute(
        text("""
        SELECT id, rel_path, outbound_links FROM vault
        WHERE owner = :owner AND vault_path = :vault_path
          AND sync_status NOT IN ('deleted', 'disconnected')
        """),
        {"owner": owner, "vault_path": vault_path}
    ).fetchall()

    # Build reverse index
    backlink_map: Dict[str, List[str]] = {}
    for note_id, rel_path, outbound_raw in notes:
        try:
            targets = json.loads(outbound_raw or "[]")
        except json.JSONDecodeError:
            targets = []
        for target in targets:
            backlink_map.setdefault(target, []).append(rel_path)

    # Update backlinks
    from sqlalchemy import text
    for note_id, rel_path, _ in notes:
        bl = json.dumps(backlink_map.get(rel_path, []))
        db.execute(
            text("UPDATE vault SET backlinks = :bl WHERE id = :id"),
            {"bl": bl, "id": note_id}
        )
    db.commit()


# Singleton ----------------------------------------------------------------------

_vault_watcher: Optional[VaultWatcher] = None


def get_watcher() -> VaultWatcher:
    global _vault_watcher
    if _vault_watcher is None:
        _vault_watcher = VaultWatcher()
    return _vault_watcher
