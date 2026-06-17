"""Tests for Vault file watcher and link extraction."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

# Ensure project root is on sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.vault_watcher import (
    _parse_frontmatter,
    _parse_yaml_tags,
    _extract_links,
    _resolve_vault_link,
    _sync_file,
    _recompute_backlinks,
    get_watcher,
)


# ---------------------------------------------------------------------------
# Frontmatter parsing
# ---------------------------------------------------------------------------

def test_parse_frontmatter_present():
    raw = "---\ntitle: Hello\ntags: [a, b]\n---\nBody here"
    fm, body = _parse_frontmatter(raw)
    assert "title: Hello" in fm
    assert body == "Body here"


def test_parse_frontmatter_absent():
    raw = "No frontmatter here\nJust body"
    fm, body = _parse_frontmatter(raw)
    assert fm == ""
    assert body == raw


# ---------------------------------------------------------------------------
# Tag extraction
# ---------------------------------------------------------------------------

def test_parse_yaml_tags_inline_list():
    yaml_text = "title: x\ntags: [foo, bar, baz]\nother: 1"
    assert _parse_yaml_tags(yaml_text) == ["foo", "bar", "baz"]


def test_parse_yaml_tags_bullet_list():
    yaml_text = "tags:\n  - alpha\n  - beta\nother: 1"
    assert _parse_yaml_tags(yaml_text) == ["alpha", "beta"]


def test_parse_yaml_tags_string():
    yaml_text = "tags: red, green, blue\n"
    assert _parse_yaml_tags(yaml_text) == ["red", "green", "blue"]


def test_parse_yaml_tags_none():
    assert _parse_yaml_tags("") == []


# ---------------------------------------------------------------------------
# Link extraction
# ---------------------------------------------------------------------------

def test_extract_wiki_links():
    body = "See [[Target Note]] and [[Another|Alias]]"
    vault = Path("/tmp/vault")
    # Create stub files so resolution works
    (vault / "Target Note.md").parent.mkdir(parents=True, exist_ok=True)
    (vault / "Target Note.md").write_text("x")
    (vault / "Another.md").write_text("x")
    links = _extract_links(body, vault, "root.md")
    assert "Target Note.md" in links
    assert "Another.md" in links


def test_extract_md_links():
    body = "Read [this](folder/file.md) and [that](other)"
    vault = Path("/tmp/vault2")
    (vault / "folder").mkdir(parents=True, exist_ok=True)
    (vault / "folder" / "file.md").write_text("x")
    (vault / "other.md").write_text("x")
    links = _extract_links(body, vault, "root.md")
    assert "folder/file.md" in links
    assert "other.md" in links


def test_extract_skips_external_urls():
    body = "See [Google](https://google.com) and [anchor](#top)"
    links = _extract_links(body, Path("/tmp/v"), "r.md")
    assert links == []


# ---------------------------------------------------------------------------
# Full file sync
# ---------------------------------------------------------------------------

def test_sync_file_with_links(tmp_path):
    from core.database import SessionLocal, VaultNote, engine, Base

    # Ensure table exists (in-memory SQLite for test isolation)
    Base.metadata.create_all(engine)

    vault = tmp_path / "vault"
    vault.mkdir()
    note_a = vault / "A.md"
    note_a.write_text("---\ntitle: Note A\ntags: [alpha]\n---\nLink to [[B]]")
    note_b = vault / "B.md"
    note_b.write_text("---\ntitle: Note B\ntags: [beta]\n---\nNo links")

    owner = "test_user"
    _sync_file(owner, vault, note_a)
    _sync_file(owner, vault, note_b)

    db = SessionLocal()
    try:
        a = db.query(VaultNote).filter_by(rel_path="A.md").first()
        assert a is not None
        assert a.title == "Note A"
        assert json.loads(a.tags) == ["alpha"]
        # B may not resolve yet if file doesn't exist
        b = db.query(VaultNote).filter_by(rel_path="B.md").first()
        assert b.title == "Note B"
    finally:
        db.close()


def test_recompute_backlinks():
    from core.database import SessionLocal, VaultNote, engine, Base
    Base.metadata.create_all(engine)

    db = SessionLocal()
    try:
        # Insert two notes manually
        db.add(VaultNote(
            id="u:v:A.md", owner="u", vault_path="v", rel_path="A.md",
            title="A", content="x", outbound_links='["B.md"]',
            backlinks="[]", sync_status="synced"
        ))
        db.add(VaultNote(
            id="u:v:B.md", owner="u", vault_path="v", rel_path="B.md",
            title="B", content="y", outbound_links='[]',
            backlinks="[]", sync_status="synced"
        ))
        db.commit()
        _recompute_backlinks(db, "u", "v")

        b = db.query(VaultNote).filter_by(rel_path="B.md").first()
        assert json.loads(b.backlinks) == ["A.md"]
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Watcher singleton
# ---------------------------------------------------------------------------

def test_watcher_connect_disconnect(tmp_path):
    watcher = get_watcher()
    vault = tmp_path / "watch_vault"
    vault.mkdir()
    (vault / "note.md").write_text("hello")

    ok, msg = watcher.connect("alice", str(vault))
    assert ok, msg
    assert watcher.is_connected("alice", str(vault))

    watcher.disconnect("alice", str(vault))
    assert not watcher.is_connected("alice", str(vault))


def test_watcher_rejects_missing_path():
    watcher = get_watcher()
    ok, msg = watcher.connect("bob", "/nonexistent/vault")
    assert not ok
    assert "does not exist" in msg
