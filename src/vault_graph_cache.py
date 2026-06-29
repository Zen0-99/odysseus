"""Incremental graph cache for vault notes.

Stores a serialized graph JSON plus a manifest of note mtimes.
If no notes have changed since the last cache, the cached graph is returned
instantly without rebuilding the NetworkX model.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

_CACHE_DIR: Optional[Path] = None


def _cache_dir() -> Path:
    global _CACHE_DIR
    if _CACHE_DIR is not None:
        return _CACHE_DIR
    data_dir = Path(os.environ.get("ODY_DATA_DIR", "data"))
    _CACHE_DIR = data_dir / "vault_graph_cache"
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _CACHE_DIR


def _vault_hash(vault_path: str) -> str:
    """Stable hash for a vault path to use as cache filename."""
    return hashlib.sha256(vault_path.encode()).hexdigest()[:16]


def _manifest_path(vault_path: str) -> Path:
    return _cache_dir() / f"{_vault_hash(vault_path)}.manifest.json"


def _graph_path(vault_path: str) -> Path:
    return _cache_dir() / f"{_vault_hash(vault_path)}.graph.json"


def invalidate_graph_cache(vault_path: str) -> None:
    """Remove all cached graphs and manifests for a vault (call on any write)."""
    h = _vault_hash(vault_path)
    for suffix in (".manifest.json", ".graph.json"):
        p = _cache_dir() / f"{h}{suffix}"
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass


def get_cached_graph(vault_path: str, notes: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Return cached graph if all note mtimes match the manifest; else None."""
    mp = _manifest_path(vault_path)
    gp = _graph_path(vault_path)
    if not mp.exists() or not gp.exists():
        return None

    try:
        manifest: Dict[str, Any] = json.loads(mp.read_text(encoding="utf-8"))
        cached_mtimes: Dict[str, float] = manifest.get("mtimes", {})
    except Exception:
        return None

    # Build current mtime map from notes
    current_mtimes = {}
    for note in notes:
        # notes from vault_fs may have last_modified_src as ISO string or mtime as float
        lm = note.get("last_modified_src", 0)
        if isinstance(lm, str):
            try:
                from datetime import datetime
                lm = datetime.fromisoformat(lm).timestamp()
            except Exception:
                lm = 0
        current_mtimes[note["rel_path"]] = float(lm)

    # Check for any mismatch
    if set(cached_mtimes.keys()) != set(current_mtimes.keys()):
        return None
    for rel_path, mtime in current_mtimes.items():
        if abs(cached_mtimes.get(rel_path, 0) - mtime) > 0.001:
            return None

    try:
        return json.loads(gp.read_text(encoding="utf-8"))
    except Exception:
        return None


def save_graph_cache(vault_path: str, notes: List[Dict[str, Any]], graph: Dict[str, Any]) -> None:
    """Write graph JSON and mtime manifest to cache."""
    mp = _manifest_path(vault_path)
    gp = _graph_path(vault_path)

    mtimes = {}
    for note in notes:
        lm = note.get("last_modified_src", 0)
        if isinstance(lm, str):
            try:
                from datetime import datetime
                lm = datetime.fromisoformat(lm).timestamp()
            except Exception:
                lm = 0
        mtimes[note["rel_path"]] = float(lm)

    manifest = {"vault_path": vault_path, "mtimes": mtimes, "note_count": len(notes)}
    mp.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    gp.write_text(json.dumps(graph, indent=2), encoding="utf-8")
