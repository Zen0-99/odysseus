"""Direct filesystem access for Vault vaults — with in-memory index cache."""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_TAG_RE = re.compile(r"#([a-zA-Z0-9_\-/]+)")
_WIKI_LINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")

# ── In-memory vault index cache ────────────────────────────
# Maps vault_path -> {"notes": [...], "folders": [...], "ts": float}
# Eliminates rglob on every list_notes / list_folders call.
_VAULT_INDEX: Dict[str, Dict[str, Any]] = {}

CACHE_TTL_SECONDS = 3600  # Rebuild cache if older than 1 hour (watcher invalidates on change)


def _build_index(vault_path: str) -> Dict[str, Any]:
    """Incremental filesystem scan — only re-reads changed .md files."""
    root = Path(vault_path)
    if not root.exists() or not root.is_dir():
        _VAULT_INDEX[vault_path] = {"notes": [], "folders": [], "mtimes": {}, "ts": time.time()}
        return _VAULT_INDEX[vault_path]

    old_cache = _VAULT_INDEX.get(vault_path, {})
    old_notes = {n["rel_path"]: n for n in old_cache.get("notes", [])}
    old_mtimes = old_cache.get("mtimes", {})

    notes = []
    folders = set()
    mtimes = {}
    seen_rels = set()

    # Collect notes from .md files — only re-read if mtime changed
    for file_path in root.rglob("*.md"):
        rel = str(file_path.relative_to(root)).replace("\\", "/")
        parts = Path(rel).parts
        if any(p.startswith(".") for p in parts):
            continue
        seen_rels.add(rel)
        try:
            mtime = file_path.stat().st_mtime
        except (OSError, IOError):
            continue
        mtimes[rel] = mtime
        if rel in old_notes and old_mtimes.get(rel) == mtime:
            notes.append(old_notes[rel])
        else:
            note = _read_note_file(root, rel)
            if note:
                notes.append(note)

    # Collect ALL directories (including empty ones) under the vault root
    _EXCLUDED_DIRS = {".obsidian", ".trash", "Tags"}
    for dir_path in root.rglob("*"):
        if not dir_path.is_dir():
            continue
        rel = str(dir_path.relative_to(root)).replace("\\", "/")
        parts = Path(rel).parts
        if any(p.startswith(".") or p in _EXCLUDED_DIRS for p in parts):
            continue
        folders.add(rel)

    notes.sort(key=lambda n: n["title"].lower())
    folders = sorted(folders)
    _VAULT_INDEX[vault_path] = {"notes": notes, "folders": folders, "mtimes": mtimes, "ts": time.time()}
    return _VAULT_INDEX[vault_path]


def _get_index(vault_path: str) -> Dict[str, Any]:
    """Return cached index, rebuilding if missing or stale."""
    cached = _VAULT_INDEX.get(vault_path)
    if cached is None or (time.time() - cached["ts"]) > CACHE_TTL_SECONDS:
        return _build_index(vault_path)
    return cached


def invalidate_cache(vault_path: str) -> None:
    """Clear the in-memory index for a vault (call after any write)."""
    _VAULT_INDEX.pop(vault_path, None)


def vault_modified_ts(vault_path: str) -> float:
    """Return the latest mtime among all .md files and directories (cheap check)."""
    root = Path(vault_path)
    if not root.exists() or not root.is_dir():
        return 0.0
    max_ts = 0.0
    for p in root.rglob("*"):
        try:
            mtime = p.stat().st_mtime
            if mtime > max_ts:
                max_ts = mtime
        except (OSError, IOError):
            continue
    return max_ts


def update_note_in_cache(vault_path: str, note_id: str, content: str) -> None:
    """Surgically update a single note's content in the cache."""
    cached = _VAULT_INDEX.get(vault_path)
    if not cached:
        return
    for note in cached["notes"]:
        if note["id"] == note_id or note["rel_path"] == note_id:
            note["content"] = content
            note["last_modified_src"] = time.time()
            break


def remove_note_from_cache(vault_path: str, note_id: str) -> None:
    """Remove a note from the cached index."""
    cached = _VAULT_INDEX.get(vault_path)
    if not cached:
        return
    cached["notes"] = [n for n in cached["notes"] if n["id"] != note_id and n["rel_path"] != note_id]
    # Rebuild folder list from remaining notes
    folders = set()
    for n in cached["notes"]:
        parent = str(Path(n["rel_path"]).parent)
        if parent and parent != ".":
            folders.add(parent)
    cached["folders"] = sorted(folders)


def add_note_to_cache(vault_path: str, note: Dict[str, Any]) -> None:
    """Insert a newly created note into the cache."""
    cached = _VAULT_INDEX.get(vault_path)
    if not cached:
        return
    cached["notes"].append(note)
    cached["notes"].sort(key=lambda n: n["title"].lower())
    parent = str(Path(note["rel_path"]).parent)
    if parent and parent != "." and parent not in cached["folders"]:
        cached["folders"].append(parent)
        cached["folders"].sort()


def rename_note_in_cache(vault_path: str, old_id: str, new_id: str, new_content: Optional[str] = None) -> None:
    """Update a note's id/path in the cache after a rename or move."""
    cached = _VAULT_INDEX.get(vault_path)
    if not cached:
        return
    for note in cached["notes"]:
        if note["id"] == old_id or note["rel_path"] == old_id:
            note["id"] = new_id
            note["rel_path"] = new_id
            folder = str(Path(new_id).parent).replace("\\", "/")
            note["folder"] = folder if folder != "." else ""
            note["title"] = Path(new_id).stem
            if new_content is not None:
                note["content"] = new_content
            break
    # Rebuild folders
    folders = set()
    for n in cached["notes"]:
        parent = str(Path(n["rel_path"]).parent)
        if parent and parent != ".":
            folders.add(parent)
    cached["folders"] = sorted(folders)


def _parse_frontmatter(raw: str) -> Tuple[str, str]:
    m = _FM_RE.match(raw)
    if m:
        return m.group(1), raw[m.end():]
    return "", raw


def _extract_yaml_tags(yaml_text: str) -> List[str]:
    tags: List[str] = []
    in_tags = False
    for line in yaml_text.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("tags:"):
            in_tags = True
            val = stripped.split(":", 1)[1].strip()
            if val.startswith("["):
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


def _extract_title(frontmatter_raw: str, file_path: Path) -> str:
    for line in frontmatter_raw.splitlines():
        if line.lower().strip().startswith("title:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
    return file_path.stem


def _read_note_file(vault_path: Path, rel_path: str) -> Optional[Dict[str, Any]]:
    """Read a single .md file from disk and return its metadata + content."""
    file_path = vault_path / rel_path.replace("/", os.sep)
    if not file_path.exists():
        return None
    try:
        raw = file_path.read_text(encoding="utf-8")
    except (IOError, UnicodeDecodeError):
        return None

    frontmatter_raw, body = _parse_frontmatter(raw)
    tags = _extract_yaml_tags(frontmatter_raw)
    # Also scan body for #inline tags
    inline_tags = _TAG_RE.findall(body)
    tags = list(dict.fromkeys(tags + inline_tags))  # preserve order, dedupe

    title = _extract_title(frontmatter_raw, file_path)
    folder = str(Path(rel_path).parent).replace("\\", "/") if Path(rel_path).parent != Path(".") else ""
    mtime = file_path.stat().st_mtime
    # Birth time: st_birthtime on Windows/macOS, st_ctime as Linux fallback
    stat = file_path.stat()
    birth_time = getattr(stat, 'st_birthtime', None) or getattr(stat, 'st_ctime', mtime)

    # Extract outbound links from body
    outbound = []
    for m in _WIKI_LINK_RE.finditer(body):
        link = m.group(1).strip()
        # Normalize to relative path
        if "/" in link:
            link = link.replace("\\", "/")
        if not link.endswith(".md"):
            link += ".md"
        outbound.append(link)

    from datetime import datetime
    return {
        "id": rel_path,
        "rel_path": rel_path,
        "folder": folder,
        "title": title,
        "content": body,
        "frontmatter": frontmatter_raw,
        "tags": tags,
        "outbound_links": outbound,
        "backlinks": [],
        "last_modified_src": datetime.fromtimestamp(mtime).isoformat(),
        "birth_time": datetime.fromtimestamp(birth_time).isoformat(),
        "sync_status": "synced",
    }


def list_notes(vault_path: str, folder: Optional[str] = None, q: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return all .md files as note dicts — reads from in-memory cache."""
    root = Path(vault_path)
    if not root.exists() or not root.is_dir():
        return []

    notes = _get_index(vault_path)["notes"].copy()

    # Filter by folder
    if folder is not None:
        folder_norm = folder.replace("\\", "/")
        notes = [n for n in notes if (n["folder"] or "").replace("\\", "/") == folder_norm]

    # Search filter
    if q:
        q_lower = q.lower()
        notes = [n for n in notes if q_lower in (n["title"] + " " + n["content"]).lower()]

    return notes


def list_folders(vault_path: str) -> List[str]:
    """Return all folder paths inside the vault — reads from in-memory cache."""
    root = Path(vault_path)
    if not root.exists() or not root.is_dir():
        return []

    return _get_index(vault_path)["folders"].copy()


def list_tags(vault_path: str) -> List[Dict[str, Any]]:
    """Return all unique tags with note counts."""
    notes = list_notes(vault_path)
    tag_counts: Dict[str, int] = {}
    for note in notes:
        for tag in note.get("tags", []):
            tag_counts[tag] = tag_counts.get(tag, 0) + 1
    return [{"tag": t, "count": c} for t, c in sorted(tag_counts.items())]


def get_note(vault_path: str, note_id: str) -> Optional[Dict[str, Any]]:
    """Read a single note by its relative path (note_id = rel_path)."""
    root = Path(vault_path)
    if not root.exists():
        return None
    return _read_note_file(root, note_id)


def compute_backlinks(notes: List[Dict[str, Any]]) -> None:
    """Populate backlinks field on each note from outbound_links of others."""
    rel_to_note = {n["rel_path"]: n for n in notes}
    for note in notes:
        note["backlinks"] = []
    for note in notes:
        for target in note.get("outbound_links", []):
            target_note = rel_to_note.get(target)
            if target_note:
                if note["rel_path"] not in target_note["backlinks"]:
                    target_note["backlinks"].append(note["rel_path"])
