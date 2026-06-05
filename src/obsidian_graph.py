"""Graph and timeline pre-computation for Obsidian vault notes."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional


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


def build_graph(notes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Return {nodes, edges, groups} for vis-network rendering from note dicts."""
    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    group_index: Dict[str, int] = {}
    group_counter = 0

    # First pass: build nodes and assign groups
    for note in notes:
        rel_path = note["rel_path"]
        folder = note.get("folder", "")
        title = note.get("title", rel_path)
        tags_raw = note.get("tags", [])
        backlinks = note.get("backlinks", [])
        group_key = _derive_group(folder, tags_raw)
        if group_key not in group_index:
            group_index[group_key] = group_counter % len(GROUP_COLORS)
            group_counter += 1

        nodes.append({
            "id": rel_path,
            "label": title or rel_path,
            "group": group_key,
            "value": len(backlinks) + 1,  # size by backlink count
            "color": GROUP_COLORS[group_index[group_key]],
            "title": f"{title}\n{rel_path}",  # tooltip
        })

    # Second pass: build edges
    rel_paths = {n["rel_path"] for n in notes}
    for note in notes:
        rel_path = note["rel_path"]
        targets = note.get("outbound_links", [])
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


def build_timeline(notes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return chronological frames for timeline animation from note dicts."""
    # Sort by mtime (last_modified_src) as proxy for creation time
    sorted_notes = sorted(notes, key=lambda n: n.get("last_modified_src", 0))

    frames: List[Dict[str, Any]] = []
    current_nodes: set = set()
    current_edges: set = set()

    for note in sorted_notes:
        rel_path = note["rel_path"]
        title = note.get("title", rel_path)
        targets = note.get("outbound_links", [])
        mtime = note.get("last_modified_src", 0)

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
                "timestamp": mtime,
                "note_count": len(current_nodes),
                "link_count": len(current_edges),
                "nodes_added": nodes_added,
                "edges_added": edges_added,
            })

    return frames


def _derive_group(folder: Optional[str], tags_raw) -> str:
    """Derive a group key from folder path or most frequent tag."""
    if folder:
        top = folder.split("/")[0] if "/" in folder else folder
        if top:
            return top
    tags = []
    if isinstance(tags_raw, list):
        tags = tags_raw
    elif isinstance(tags_raw, str):
        try:
            tags = json.loads(tags_raw or "[]")
        except json.JSONDecodeError:
            tags = []
    if tags:
        return str(tags[0])
    return "Uncategorized"
