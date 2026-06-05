"""Tests for Obsidian graph and timeline pre-computation."""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.database import engine, Base, SessionLocal, Obsidian
from src.obsidian_graph import build_graph, build_timeline, _derive_group


@pytest.fixture(autouse=True)
def _db():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    db = SessionLocal()
    # Seed notes
    db.add(Obsidian(
        id="u:v:a.md", owner="u", vault_path="v", rel_path="a.md",
        folder="", title="Alpha", content="x",
        tags='["tag1"]', outbound_links='["b.md"]',
        backlinks='[]', sync_status="synced"
    ))
    db.add(Obsidian(
        id="u:v:b.md", owner="u", vault_path="v", rel_path="b.md",
        folder="projects", title="Beta", content="y",
        tags='["tag2"]', outbound_links='["c.md"]',
        backlinks='["a.md"]', sync_status="synced"
    ))
    db.add(Obsidian(
        id="u:v:c.md", owner="u", vault_path="v", rel_path="c.md",
        folder="projects", title="Gamma", content="z",
        tags='["tag2"]', outbound_links='[]',
        backlinks='["b.md"]', sync_status="synced"
    ))
    db.commit()
    yield db
    db.close()
    Base.metadata.drop_all(engine)


def test_build_graph_nodes(_db):
    g = build_graph("u", "v", _db)
    ids = {n["id"] for n in g["nodes"]}
    assert {"a.md", "b.md", "c.md"}.issubset(ids)


def test_build_graph_edges(_db):
    g = build_graph("u", "v", _db)
    pairs = {(e["from"], e["to"]) for e in g["edges"]}
    assert ("a.md", "b.md") in pairs
    assert ("b.md", "c.md") in pairs


def test_build_graph_groups(_db):
    g = build_graph("u", "v", _db)
    assert len(g["groups"]) >= 1
    # Folder "projects" and tag "tag1"/"tag2" map to groups
    group_ids = {g["id"] for g in g["groups"]}
    assert "projects" in group_ids or "tag2" in group_ids or "tag1" in group_ids


def test_build_timeline_frames(_db):
    t = build_timeline("u", "v", _db)
    assert len(t) >= 3  # At least one frame per seeded note
    first = t[0]
    assert "timestamp" in first
    assert first["note_count"] >= 1
    assert first["link_count"] >= 0


def test_derive_group_from_folder():
    assert _derive_group("projects/design", '[]') == "projects"


def test_derive_group_from_tag():
    assert _derive_group("", '["ideas"]') == "ideas"


def test_derive_group_uncategorized():
    assert _derive_group(None, None) == "Uncategorized"
