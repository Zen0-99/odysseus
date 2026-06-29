"""Tests for Vault API routes."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routes.note_vault_routes import setup_note_vault_routes
from core.database import engine, Base, SessionLocal, VaultNote


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(engine)
    app = FastAPI()
    router = setup_note_vault_routes()
    app.include_router(router)

    from unittest.mock import MagicMock

    # Auth bypass for testing
    mock_auth = MagicMock()
    mock_auth.is_configured = True
    mock_auth.is_admin.return_value = True
    app.state.auth_manager = mock_auth

    @app.middleware("http")
    async def _mock_user(request, call_next):
        request.state.current_user = "admin_user"
        response = await call_next(request)
        return response

    tc = TestClient(app)
    yield tc
    Base.metadata.drop_all(engine)


def test_connect_disconnect(client):
    with tempfile.TemporaryDirectory() as td:
        vault = Path(td) / "vault"
        vault.mkdir()
        (vault / "hello.md").write_text("# Hello")

        r = client.post("/api/vault/connect", json={"vault_path": str(vault)})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["ok"] is True
        assert data["vault_path"] == "vault"

        r2 = client.get("/api/vault/status")
        assert r2.status_code == 200
        assert r2.json()["connected"] is True

        r3 = client.post("/api/vault/disconnect")
        assert r3.status_code == 200
        assert r3.json()["ok"] is True


def test_connect_rejects_missing_path(client):
    r = client.post("/api/vault/connect", json={"vault_path": "/no/such/vault"})
    assert r.status_code == 400
    assert "does not exist" in r.json()["detail"]


def test_list_notes(client):
    with tempfile.TemporaryDirectory() as td:
        vault = Path(td) / "v"
        vault.mkdir()
        (vault / "a.md").write_text("---\ntitle: Alpha\ntags: [idea]\n---\nBody A")
        (vault / "b.md").write_text("---\ntitle: Beta\ntags: [task]\n---\nBody B")

        client.post("/api/vault/connect", json={"vault_path": str(vault)})

        r = client.get("/api/vault/notes")
        assert r.status_code == 200
        data = r.json()
        assert data["total"] >= 2
        titles = {n["title"] for n in data["notes"]}
        assert "Alpha" in titles
        assert "Beta" in titles

        # Search filter
        r2 = client.get("/api/vault/notes?q=Alpha")
        assert r2.status_code == 200
        assert all("Alpha" in (n["title"] + n["content"]) for n in r2.json()["notes"])

        client.post("/api/vault/disconnect")


def test_get_note(client):
    with tempfile.TemporaryDirectory() as td:
        vault = Path(td) / "v"
        vault.mkdir()
        (vault / "x.md").write_text("# X")

        client.post("/api/vault/connect", json={"vault_path": str(vault)})

        # Need to find the note id
        r = client.get("/api/vault/notes")
        notes = r.json()["notes"]
        assert len(notes) >= 1
        note_id = notes[0]["id"]

        r2 = client.get(f"/api/vault/notes/{note_id}")
        assert r2.status_code == 200
        assert r2.json()["rel_path"] == notes[0]["rel_path"]

        client.post("/api/vault/disconnect")


def test_graph_endpoint(client):
    with tempfile.TemporaryDirectory() as td:
        vault = Path(td) / "v"
        vault.mkdir()
        (vault / "a.md").write_text("---\ntitle: A\n---\n[[b]]")
        (vault / "b.md").write_text("---\ntitle: B\n---\n")

        client.post("/api/vault/connect", json={"vault_path": str(vault)})

        r = client.get("/api/vault/graph")
        assert r.status_code == 200
        g = r.json()
        assert "nodes" in g
        assert "edges" in g
        assert "groups" in g

        client.post("/api/vault/disconnect")


def test_timeline_endpoint(client):
    with tempfile.TemporaryDirectory() as td:
        vault = Path(td) / "v"
        vault.mkdir()
        (vault / "a.md").write_text("---\ntitle: A\n---\n")

        client.post("/api/vault/connect", json={"vault_path": str(vault)})

        r = client.get("/api/vault/timeline")
        assert r.status_code == 200
        t = r.json()
        assert "frames" in t
        assert len(t["frames"]) >= 1

        client.post("/api/vault/disconnect")


def test_edit_readonly_rejected(client):
    with tempfile.TemporaryDirectory() as td:
        vault = Path(td) / "v"
        vault.mkdir()
        (vault / "lock.md").write_text("---\ntitle: Locked\n---\nsecret")

        client.post("/api/vault/connect", json={"vault_path": str(vault)})

        r = client.get("/api/vault/notes")
        notes = r.json()["notes"]
        note_id = notes[0]["id"]

        # Default edit_permission is "readonly"
        r2 = client.post(f"/api/vault/notes/{note_id}/edit", json={"content": "hacked"})
        assert r2.status_code == 403
        assert "read-only" in r2.json()["detail"].lower()

        client.post("/api/vault/disconnect")


def test_strategy_override_is_atomic_and_creates_backup():
    """The override save strategy must write to a temp file, backup the
    original, and atomically rename so the original is never partial."""
    from types import SimpleNamespace
    from routes.note_vault_routes import _strategy_override

    with tempfile.TemporaryDirectory() as td:
        vault = Path(td)
        original = vault / "note.md"
        original.write_text("original content", encoding="utf-8")
        note = SimpleNamespace(vault_path=str(vault), rel_path="note.md")

        result = _strategy_override(note, "updated content")

        assert original.read_text(encoding="utf-8") == "updated content"
        assert result["action"] == "override"
        backup_dir = vault / ".odysseus" / "backups"
        backups = sorted(backup_dir.glob("note-*.md"))
        assert len(backups) == 1
        assert backups[0].read_text(encoding="utf-8") == "original content"
