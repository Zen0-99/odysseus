"""Graph and timeline pre-computation for Obsidian vault notes."""

from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import text

logger = logging.getLogger(__name__)

# Odysseus CSS variable color palette for graph groups
GROUP_COLORS = [
    "#ff6b6b",   # --red-ish
    "#4dabf7",   # --blue-ish
    "#51cf66",   # --green-ish
    "#9775fa",   # --purple-ish
    "#ff922b",   # --orange-ish
    "#22b8cf",   # --cyan-ish
    "#fcc419",   # --yellow-ish
    "#ff8787",   # --pink-ish
    "#69db7c",   # --lime-ish
    "#748ffc",   # --indigo-ish
]


def build_graph(owner: str, vault_path: str, db) -> Dict[str, Any]:
    """Return {nodes, edges, groups} for vis-network rendering."""
    rows = db.execute(
        text("""
        SELECT id, rel_path, folder, title, tags, outbound_links, backlinks
        FROM obsidian
        WHERE owner = :owner AND vault_path = :vault_path
          AND sync_status NOT IN ('deleted', 'disconnected')
        """),
        {"owner": owner, "vault_path": vault_path}
    ).fetchall()

    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    group_index: Dict[str, int] = {}
    group_counter = 0

    # First pass: build nodes and assign groups
    for row in rows:
        note_id, rel_path, folder, title, tags_raw, outbound_raw, backlinks_raw = row
        group_key = _derive_group(folder, tags_raw)
        if group_key not in group_index:
            group_index[group_key] = group_counter % len(GROUP_COLORS)
            group_counter += 1

        try:
            bl = json.loads(backlinks_raw or "[]")
        except json.JSONDecodeError:
            bl = []

        nodes.append({
            "id": rel_path,
            "label": title or rel_path,
            "group": group_key,
            "value": len(bl) + 1,  # size by backlink count
            "color": GROUP_COLORS[group_index[group_key]],
            "title": f"{title}\n{rel_path}",  # tooltip
        })

    # Second pass: build edges
    rel_paths = {row[1] for row in rows}
    for row in rows:
        note_id, rel_path, folder, title, tags_raw, outbound_raw, _ = row
        try:
            targets = json.loads(outbound_raw or "[]")
        except json.JSONDecodeError:
            targets = []
        for target in targets:
            if target in rel_paths:
                edges.append({
                    "from": rel_path,
                    "to": target,
                    "arrows": "to",
                })

    groups = [
        {"id": gk, "color": GROUP_COLORS[group_index[gk]]}
        for gk in sorted(group_index.keys())
    ]

    return {"nodes": nodes, "edges": edges, "groups": groups}


def build_timeline(owner: str, vault_path: str, db) -> List[Dict[str, Any]]:
    """Return chronological frames for timeline animation."""
    rows = db.execute(
        text("""
        SELECT rel_path, title, outbound_links, created_at
        FROM obsidian
        WHERE owner = :owner AND vault_path = :vault_path
          AND sync_status NOT IN ('deleted', 'disconnected')
        ORDER BY created_at ASC
        """),
        {"owner": owner, "vault_path": vault_path}
    ).fetchall()

    # Map rel_path -> created_at for edge dating
    creation_dates: Dict[str, datetime] = {}
    for rel_path, title, outbound_raw, created_at in rows:
        creation_dates[rel_path] = created_at

    frames: List[Dict[str, Any]] = []
    current_nodes: set = set()
    current_edges: set = set()

    for rel_path, title, outbound_raw, created_at in rows:
        try:
            targets = json.loads(outbound_raw or "[]")
        except json.JSONDecodeError:
            targets = []

        nodes_added = []
        edges_added = []

        if rel_path not in current_nodes:
            current_nodes.add(rel_path)
            nodes_added.append({
                "id": rel_path,
                "label": title or rel_path,
            })

        for target in targets:
            edge_key = f"{rel_path}->{target}"
            if edge_key not in current_edges:
                current_edges.add(edge_key)
                edges_added.append({
                    "from": rel_path,
                    "to": target,
                })

        if nodes_added or edges_added:
            frames.append({
                "timestamp": created_at.isoformat() if isinstance(created_at, datetime) else str(created_at),
                "note_count": len(current_nodes),
                "link_count": len(current_edges),
                "nodes_added": nodes_added,
                "edges_added": edges_added,
            })

    return frames


def _derive_group(folder: Optional[str], tags_raw: Optional[str]) -> str:
    """Derive a group key from folder path or most frequent tag."""
    if folder:
        top = folder.split("/")[0] if "/" in folder else folder
        if top:
            return top
    try:
        tags = json.loads(tags_raw or "[]")
    except json.JSONDecodeError:
        tags = []
    if tags:
        return str(tags[0])
    return "Uncategorized"
