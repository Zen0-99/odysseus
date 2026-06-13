"""Graph and timeline pre-computation for Shard vault notes."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Set

# Neutral gray palette matching Odysseus aesthetic
NODE_BG = "#5c6370"
NODE_BORDER = "#3e4451"
NODE_HIGHLIGHT = "#abb2bf"


def build_graph(notes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Return {nodes, edges, groups, tags} for vis-network rendering from note dicts."""
    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    all_tags: Set[str] = set()

    # Build lookup maps for link resolution
    rel_paths = {n["rel_path"] for n in notes}
    title_to_path: Dict[str, str] = {}
    for note in notes:
        rp = note["rel_path"]
        # Map filename (with and without .md)
        stem = rp.rsplit("/", 1)[-1] if "/" in rp else rp
        if stem not in title_to_path:
            title_to_path[stem] = rp
        if stem.endswith(".md") and stem[:-3] not in title_to_path:
            title_to_path[stem[:-3]] = rp
        # Map title
        t = note.get("title", "")
        if t and t not in title_to_path:
            title_to_path[t] = rp

    # First pass: compute connection counts for proportional sizing
    connection_counts = {}
    for note in notes:
        conn = len(note.get("outbound_links", [])) + len(note.get("backlinks", []))
        connection_counts[note["rel_path"]] = conn

    max_conn = max(connection_counts.values()) if connection_counts else 1
    if max_conn == 0:
        max_conn = 1

    # Second pass: build nodes with proportional sizes (min 1, max 3)
    for note in notes:
        rel_path = note["rel_path"]
        folder = note.get("folder", "")
        title = note.get("title", rel_path)
        tags = _normalize_tags(note.get("tags", []))
        backlinks = note.get("backlinks", [])
        outbound = note.get("outbound_links", [])
        all_tags.update(tags)

        conn = connection_counts[rel_path]
        # Scale: 1 (no connections) to 3 (most connections), proportional
        base_value = 1 + (conn / max_conn) * 2

        nodes.append({
            "id": rel_path,
            "label": title or rel_path,
            "value": round(base_value, 2),
            "color": {
                "background": NODE_BG,
                "border": NODE_BORDER,
                "highlight": { "background": NODE_HIGHLIGHT, "border": NODE_BORDER },
                "hover": { "background": NODE_HIGHLIGHT, "border": NODE_BORDER },
            },
            "title": f"{title}\n{rel_path}\nLinks: {conn}",
            "folder": folder,
            "tags": tags,
            "backlinks_count": len(backlinks),
            "outbound_count": len(outbound),
        })

    # Second pass: build edges (deduplicated, undirected, resolve titles)
    seen_edges: Set[tuple] = set()
    for note in notes:
        rel_path = note["rel_path"]
        targets = note.get("outbound_links", [])
        for target in targets:
            resolved = target
            if resolved not in rel_paths:
                # Try title/filename resolution
                t_key = target[:-3] if target.endswith(".md") else target
                resolved = title_to_path.get(t_key, target)
            if resolved not in rel_paths or resolved == rel_path:
                continue
            key = tuple(sorted([rel_path, resolved]))
            if key in seen_edges:
                continue
            seen_edges.add(key)
            edges.append({
                "id": f"{key[0]}--{key[1]}",
                "from": rel_path,
                "to": resolved,
            })

    return {
        "nodes": nodes,
        "edges": edges,
        "groups": [],
        "tags": sorted(all_tags),
    }


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


def _normalize_tags(tags_raw) -> List[str]:
    """Normalize tags to a plain string list."""
    if isinstance(tags_raw, list):
        return [str(t) for t in tags_raw]
    if isinstance(tags_raw, str):
        try:
            return [str(t) for t in json.loads(tags_raw or "[]")]
        except json.JSONDecodeError:
            return []
    return []
