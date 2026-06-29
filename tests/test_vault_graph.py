"""Tests for Vault graph and timeline pre-computation."""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.vault_graph import build_graph, build_timeline


def _make_notes():
    """Return a minimal list of note dicts matching vault_fs output."""
    return [
        {
            "id": "a.md", "rel_path": "a.md", "folder": "",
            "title": "Alpha", "content": "x",
            "tags": ["tag1"], "outbound_links": ["b.md"],
            "backlinks": [], "last_modified_src": 1,
            "birth_time": 1,
        },
        {
            "id": "b.md", "rel_path": "b.md", "folder": "projects",
            "title": "Beta", "content": "y",
            "tags": ["tag2"], "outbound_links": ["c.md"],
            "backlinks": ["a.md"], "last_modified_src": 2,
            "birth_time": 2,
        },
        {
            "id": "c.md", "rel_path": "c.md", "folder": "projects",
            "title": "Gamma", "content": "z",
            "tags": ["tag2"], "outbound_links": [],
            "backlinks": ["b.md"], "last_modified_src": 3,
            "birth_time": 3,
        },
    ]


def test_build_graph_nodes():
    g = build_graph(_make_notes())
    ids = {n["id"] for n in g["nodes"]}
    assert {"a.md", "b.md", "c.md"}.issubset(ids)
    # Each node should have new typed-edge schema attributes
    for n in g["nodes"]:
        assert "source_file" in n


def test_build_graph_edges():
    g = build_graph(_make_notes())
    pairs = {(e["from"], e["to"]) for e in g["edges"]}
    assert ("a.md", "b.md") in pairs
    assert ("b.md", "c.md") in pairs
    # Typed edge schema
    for e in g["edges"]:
        assert e.get("relation") == "links_to"
        assert e.get("confidence") == "EXTRACTED"
        assert "_src" in e
        assert "_tgt" in e
        assert "source_file" in e


def test_build_graph_tags():
    g = build_graph(_make_notes())
    assert set(g["tags"]) == {"tag1", "tag2"}


def test_build_timeline_frames():
    t = build_timeline(_make_notes())
    assert len(t) >= 3
    first = t[0]
    assert "timestamp" in first
    assert first["note_count"] >= 1
    assert first["link_count"] >= 0


def test_build_timeline_edges_are_directed():
    t = build_timeline(_make_notes())
    for frame in t:
        for e in frame.get("edges_added", []):
            assert "from" in e
            assert "to" in e
