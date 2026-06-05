"""Direct filesystem access for Obsidian vaults — no watcher, no DB cache."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_TAG_RE = re.compile(r"#([a-zA-Z0-9_\-/]+)")
_WIKI_LINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")


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
    folder = str(Path(rel_path).parent) if Path(rel_path).parent != Path(".") else ""
    mtime = file_path.stat().st_mtime

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
        "sync_status": "synced",
    }


def list_notes(vault_path: str, folder: Optional[str] = None, q: Optional[str] = None) -> List[Dict[str, Any]]:
    """Walk the vault and return all .md files as note dicts."""
    root = Path(vault_path)
    if not root.exists() or not root.is_dir():
        return []

    notes = []
    for file_path in root.rglob("*.md"):
        # Skip hidden / dot-folders
        rel = str(file_path.relative_to(root)).replace("\\", "/")
        parts = Path(rel).parts
        if any(p.startswith(".") for p in parts):
            continue

        note = _read_note_file(root, rel)
        if note:
            notes.append(note)

    # Filter by folder
    if folder is not None:
        folder_norm = folder.replace("\\", "/")
        notes = [n for n in notes if (n["folder"] or "").replace("\\", "/") == folder_norm]

    # Search filter
    if q:
        q_lower = q.lower()
        notes = [n for n in notes if q_lower in (n["title"] + " " + n["content"]).lower()]

    notes.sort(key=lambda n: n["title"].lower())
    return notes


def list_folders(vault_path: str) -> List[str]:
    """Return all folder paths inside the vault."""
    root = Path(vault_path)
    if not root.exists() or not root.is_dir():
        return []

    folders = set()
    for file_path in root.rglob("*.md"):
        rel = str(file_path.relative_to(root)).replace("\\", "/")
        parts = Path(rel).parts
        if any(p.startswith(".") for p in parts):
            continue
        parent = str(Path(rel).parent)
        if parent and parent != ".":
            folders.add(parent)

    return sorted(folders)


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
