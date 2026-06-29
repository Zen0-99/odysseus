"""Graph and timeline pre-computation for Vault vault notes.

Adopts Graphify's NetworkX-based pipeline while preserving the Odysseus
vault graph UX.  Key additions:
  • NetworkX undirected Graph as the canonical model
  • Typed edges (relation, confidence, _src/_tgt direction metadata)
  • Schema validation with dangling-edge warnings
  • Incremental build support (see vault_graph_cache.py)
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Set

try:
    import networkx as nx
except ImportError:  # pragma: no cover
    nx = None  # type: ignore[assignment]

# Neutral gray palette matching Odysseus aesthetic
NODE_BG = "#5c6370"
NODE_BORDER = "#3e4451"
NODE_HIGHLIGHT = "#abb2bf"


def _norm_source_file(p: str | None) -> str | None:
    """Normalise path separators to forward slashes."""
    if not p:
        return p
    return p.replace("\\", "/")


def _validate_notes(notes: List[Dict[str, Any]]) -> List[str]:
    """Lightweight validation; returns warnings."""
    warnings: List[str] = []
    ids = set()
    for note in notes:
        rp = note.get("rel_path")
        if not rp:
            warnings.append("note missing rel_path")
            continue
        if rp in ids:
            warnings.append(f"duplicate rel_path: {rp}")
        ids.add(rp)
    return warnings


def _build_nx_graph(notes: List[Dict[str, Any]]) -> "nx.Graph":
    """Build a NetworkX Graph from note dicts."""
    if nx is None:
        raise RuntimeError("networkx is required for graph building")

    G: nx.Graph = nx.Graph()

    # Build lookup maps for link resolution
    rel_paths = {n["rel_path"] for n in notes}
    title_to_path: Dict[str, str] = {}
    for note in notes:
        rp = _norm_source_file(note["rel_path"]) or note["rel_path"]
        stem = rp.rsplit("/", 1)[-1] if "/" in rp else rp
        if stem not in title_to_path:
            title_to_path[stem] = rp
        if stem.endswith(".md") and stem[:-3] not in title_to_path:
            title_to_path[stem[:-3]] = rp
        t = note.get("title", "")
        if t and t not in title_to_path:
            title_to_path[t] = rp

    # Compute connection counts for sizing
    connection_counts: Dict[str, int] = {}
    for note in notes:
        conn = len(note.get("outbound_links", [])) + len(note.get("backlinks", []))
        connection_counts[note["rel_path"]] = conn

    max_conn = max(connection_counts.values()) if connection_counts else 1
    if max_conn == 0:
        max_conn = 1

    # Add nodes
    all_tags: Set[str] = set()
    for note in notes:
        rel_path = note["rel_path"]
        folder = note.get("folder", "")
        title = note.get("title", rel_path)
        tags = _normalize_tags(note.get("tags", []))
        backlinks = note.get("backlinks", [])
        outbound = note.get("outbound_links", [])
        all_tags.update(tags)

        conn = connection_counts[rel_path]
        base_value = 1 + (conn / max_conn) * 2
        created = note.get("birth_time") or note.get("last_modified_src", 0)

        G.add_node(
            rel_path,
            id=rel_path,
            label=title or rel_path,
            value=round(base_value, 2),
            color={
                "background": NODE_BG,
                "border": NODE_BORDER,
                "highlight": {"background": NODE_HIGHLIGHT, "border": NODE_BORDER},
                "hover": {"background": NODE_HIGHLIGHT, "border": NODE_BORDER},
            },
            title=f"{title}\n{rel_path}\nLinks: {conn}",
            folder=folder,
            tags=tags,
            backlinks_count=len(backlinks),
            outbound_count=len(outbound),
            created=created,
            source_file=_norm_source_file(rel_path),
        )

    # Add edges (deduplicated, undirected)
    seen_edges: Set[tuple] = set()
    dangling: List[str] = []
    for note in notes:
        rel_path = note["rel_path"]
        targets = note.get("outbound_links", [])
        for target in targets:
            resolved = target
            if resolved not in rel_paths:
                t_key = target[:-3] if target.endswith(".md") else target
                resolved = title_to_path.get(t_key, target)
            if resolved not in rel_paths:
                dangling.append(f"{rel_path} -> {resolved}")
                continue
            if resolved == rel_path:
                continue
            key = tuple(sorted([rel_path, resolved]))
            if key in seen_edges:
                continue
            seen_edges.add(key)
            G.add_edge(
                rel_path,
                resolved,
                **{
                    "id": f"{key[0]}--{key[1]}",
                    "from": rel_path,
                    "to": resolved,
                    "relation": "links_to",
                    "confidence": "EXTRACTED",
                    "source_file": _norm_source_file(rel_path),
                    "_src": rel_path,
                    "_tgt": resolved,
                },
            )

    if dangling:
        # Only warn for the first few to avoid log spam
        for d in dangling[:5]:
            print(f"[vault_graph] dangling edge: {d}", file=sys.stderr)
        if len(dangling) > 5:
            print(f"[vault_graph] ... and {len(dangling) - 5} more dangling edges", file=sys.stderr)

    G.graph["tags"] = sorted(all_tags)
    return G


def _nx_to_dict(G: "nx.Graph") -> Dict[str, Any]:
    """Serialize a NetworkX graph to the frontend-compatible dict format."""
    nodes = []
    for node_id, data in G.nodes(data=True):
        nd = dict(data)
        nd.setdefault("id", node_id)
        nodes.append(nd)

    edges = []
    for u, v, data in G.edges(data=True):
        ed = dict(data)
        ed.setdefault("from", u)
        ed.setdefault("to", v)
        edges.append(ed)

    return {
        "nodes": nodes,
        "edges": edges,
        "groups": [],
        "tags": G.graph.get("tags", []),
    }


def build_graph(notes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Return {nodes, edges, groups, tags} for vis-network rendering."""
    warnings = _validate_notes(notes)
    if warnings:
        for w in warnings[:3]:
            print(f"[vault_graph] validation: {w}", file=sys.stderr)
    G = _build_nx_graph(notes)
    return _nx_to_dict(G)


def build_timeline(notes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return chronological frames for timeline animation from note dicts.

    Uses birth_time when available, falling back to last_modified_src.
    """
    sorted_notes = sorted(notes, key=lambda n: n.get("birth_time") or n.get("last_modified_src", 0))

    frames: List[Dict[str, Any]] = []
    current_nodes: set = set()
    current_edges: set = set()

    for note in sorted_notes:
        rel_path = note["rel_path"]
        title = note.get("title", rel_path)
        targets = note.get("outbound_links", [])
        created = note.get("birth_time") or note.get("last_modified_src", 0)

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
                "timestamp": created,
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
