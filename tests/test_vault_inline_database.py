"""Tests for inline markdown databases in vault notes."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json
import tempfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src import vault_inline_database as vid
from routes.note_vault_routes import setup_note_vault_routes
from core.database import Base


# ---------------------------------------------------------------------------
# Parser tests
# ---------------------------------------------------------------------------

def test_parse_markers_finds_database():
    content = """Some text.

<!-- database: db-abc123 -->
| Name | Status |
| --- | --- |
| [[Business tips]] | Draft |

More text.
"""
    found = vid.parse_markers(content)
    assert len(found) == 1
    db = found[0]
    assert db["marker"] == "db-abc123"
    assert db["headers"] == ["Name", "Status"]
    assert db["rows"] == [["[[Business tips]]", "Draft"]]


def test_parse_markers_ignores_regular_table():
    content = """| A | B |
| --- | --- |
| 1 | 2 |
"""
    found = vid.parse_markers(content)
    assert found == []


def test_edit_cell():
    content = """<!-- database: db-1 -->
| Name | Status |
| --- | --- |
| Alpha | Draft |
"""
    new = vid.edit_cell(content, "db-1", 0, 1, "Done")
    assert "| Alpha | Done |" in new


def test_add_column():
    content = """<!-- database: db-1 -->
| Name |
| --- |
| Alpha |
"""
    new = vid.add_column(content, "db-1", "Tag", "untagged")
    assert "| Name | Tag |" in new
    assert "| Alpha | untagged |" in new


def test_remove_column():
    content = """<!-- database: db-1 -->
| Name | Status |
| --- | --- |
| Alpha | Draft |
"""
    new = vid.remove_column(content, "db-1", 1)
    assert "| Name |" in new
    assert "| Alpha |" in new
    assert "Status" not in new


def test_add_row():
    content = """<!-- database: db-1 -->
| Name | Status |
| --- | --- |
| Alpha | Draft |
"""
    new = vid.add_row(content, "db-1", ["Beta", "Done"])
    assert "| Beta | Done |" in new


def test_remove_row():
    content = """<!-- database: db-1 -->
| Name | Status |
| --- | --- |
| Alpha | Draft |
| Beta | Done |
"""
    new = vid.remove_row(content, "db-1", 0)
    assert "Alpha" not in new
    assert "Beta" in new


def test_promote_and_demote_table():
    content = """Before.

| Name | Status |
| --- | --- |
| Alpha | Draft |

After.
"""
    # table starts at line 2 (0-indexed)
    new, marker = vid.promote_table(content, 2)
    assert marker.startswith("db-")
    assert f"<!-- database: {marker} -->" in new

    demoted = vid.demote_table(new, marker)
    assert "<!-- database:" not in demoted
    assert "| Name | Status |" in demoted


# ---------------------------------------------------------------------------
# API tests
# ---------------------------------------------------------------------------

@pytest.fixture(scope="function")
def client():
    from sqlalchemy import create_engine
    from sqlalchemy.exc import OperationalError
    from core.database import Base as _Base, SessionLocal as _SessionLocal

    from sqlalchemy.orm import sessionmaker

    test_db_file = tempfile.mktemp(suffix=".db")
    test_engine = create_engine(
        f"sqlite:///{test_db_file}", connect_args={"check_same_thread": False}
    )
    # Create tables individually so an existing index on one table doesn't abort all
    for table in _Base.metadata.sorted_tables:
        try:
            table.create(test_engine, checkfirst=True)
        except OperationalError as exc:
            if "already exists" in str(exc.orig or exc).lower():
                pass
            else:
                raise
    # Replace the global SessionLocal with a fresh sessionmaker bound to the test engine
    import core.database as _db_mod

    _db_mod.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

    import importlib
    import routes.note_vault_routes

    importlib.reload(routes.note_vault_routes)
    from routes.note_vault_routes import setup_note_vault_routes

    app = FastAPI()
    router = setup_note_vault_routes()
    app.include_router(router)

    from unittest.mock import MagicMock, patch

    mock_auth = MagicMock()
    mock_auth.is_configured = True
    mock_auth.is_admin.return_value = True
    app.state.auth_manager = mock_auth

    # Disable the file watcher so tests do not lock temp files or spawn threads
    watcher_mock = MagicMock()
    watcher_mock.is_connected.return_value = True
    watcher_mock.connect.return_value = (True, "ok")
    watcher_mock.disconnect_all.return_value = None
    patch("routes.note_vault_routes.get_watcher", return_value=watcher_mock).start()
    patch("src.vault_watcher.get_watcher", return_value=watcher_mock).start()

    @app.middleware("http")
    async def _mock_user(request, call_next):
        request.state.current_user = "admin_user"
        response = await call_next(request)
        return response

    tc = TestClient(app)
    yield tc

    _Base.metadata.drop_all(test_engine)
    test_engine.dispose()
    try:
        os.remove(test_db_file)
    except FileNotFoundError:
        pass


def _connect_vault(client, vault: Path):
    r = client.post("/api/vault/connect", json={"vault_path": str(vault)})
    assert r.status_code == 200, r.text
    return r.json()["vault_id"]


def test_promote_inline_database(client):
    with tempfile.TemporaryDirectory() as td:
        vault = Path(td) / "v"
        vault.mkdir()
        (vault / "note.md").write_text("| Name | Status |\n| --- | --- |\n| Alpha | Draft |\n")
        _connect_vault(client, vault)

        r = client.post("/api/vault/notes/note.md/databases", json={"table_start_line": 0})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["ok"] is True
        marker = data["marker"]

        # Marker should be written to the file
        note = (vault / "note.md").read_text()
        assert f"<!-- database: {marker} -->" in note

        # Schema should exist in DB
        r2 = client.get(f"/api/vault/databases/{data['schema']['id']}")
        assert r2.status_code == 200
        schema = r2.json()
        assert schema["columns"] == [{"name": "Name", "type": "text"}, {"name": "Status", "type": "text"}]



def test_list_inline_databases(client):
    with tempfile.TemporaryDirectory() as td:
        vault = Path(td) / "v"
        vault.mkdir()
        (vault / "note.md").write_text(
            "| Name |\n| --- |\n| Alpha |\n\n| Other |\n| --- |\n| Beta |\n"
        )
        _connect_vault(client, vault)

        r = client.post("/api/vault/notes/note.md/databases", json={"table_start_line": 0})
        assert r.status_code == 200

        r2 = client.get("/api/vault/notes/note.md/databases")
        assert r2.status_code == 200
        dbs = r2.json()["databases"]
        assert len(dbs) == 1
        assert dbs[0]["headers"] == ["Name"]



def test_edit_cell_endpoint(client):
    with tempfile.TemporaryDirectory() as td:
        vault = Path(td) / "v"
        vault.mkdir()
        (vault / "note.md").write_text("| Name |\n| --- |\n| Alpha |\n")
        _connect_vault(client, vault)

        r = client.post("/api/vault/notes/note.md/databases", json={"table_start_line": 0})
        schema = r.json()["schema"]
        db_id = schema["id"]

        r2 = client.post(
            f"/api/vault/databases/{db_id}/cell",
            json={"row": 0, "col": 0, "value": "Beta"},
        )
        assert r2.status_code == 200, r2.text

        note = (vault / "note.md").read_text()
        assert "| Beta |" in note
        assert "Alpha" not in note

        client.post("/api/vault/disconnect")


def test_add_and_remove_column_endpoint(client):
    with tempfile.TemporaryDirectory() as td:
        vault = Path(td) / "v"
        vault.mkdir()
        (vault / "note.md").write_text("| Name |\n| --- |\n| Alpha |\n")
        _connect_vault(client, vault)

        r = client.post("/api/vault/notes/note.md/databases", json={"table_start_line": 0})
        schema = r.json()["schema"]
        db_id = schema["id"]

        r2 = client.post(
            f"/api/vault/databases/{db_id}/column",
            json={"name": "Status", "default_value": "Draft"},
        )
        assert r2.status_code == 200, r2.text
        assert schema["id"] == r2.json()["schema"]["id"]

        note = (vault / "note.md").read_text()
        assert "| Status |" in note

        r3 = client.delete(f"/api/vault/databases/{db_id}/columns/1")
        assert r3.status_code == 200

        note = (vault / "note.md").read_text()
        assert "Status" not in note



def test_add_and_remove_row_endpoint(client):
    with tempfile.TemporaryDirectory() as td:
        vault = Path(td) / "v"
        vault.mkdir()
        (vault / "note.md").write_text("| Name |\n| --- |\n| Alpha |\n")
        _connect_vault(client, vault)

        r = client.post("/api/vault/notes/note.md/databases", json={"table_start_line": 0})
        db_id = r.json()["schema"]["id"]

        r2 = client.post(f"/api/vault/databases/{db_id}/row", json={"values": ["Beta"]})
        assert r2.status_code == 200

        note = (vault / "note.md").read_text()
        assert "| Beta |" in note

        r3 = client.delete(f"/api/vault/databases/{db_id}/rows/0")
        assert r3.status_code == 200

        note = (vault / "note.md").read_text()
        assert "Alpha" not in note



def test_demote_inline_database(client):
    with tempfile.TemporaryDirectory() as td:
        vault = Path(td) / "v"
        vault.mkdir()
        (vault / "note.md").write_text("| Name |\n| --- |\n| Alpha |\n")
        _connect_vault(client, vault)

        r = client.post("/api/vault/notes/note.md/databases", json={"table_start_line": 0})
        db_id = r.json()["schema"]["id"]

        r2 = client.delete(f"/api/vault/databases/{db_id}")
        assert r2.status_code == 200, r2.text

        note = (vault / "note.md").read_text()
        assert "<!-- database:" not in note
        assert "| Name |" in note

        # DB record should be gone
        r3 = client.get(f"/api/vault/databases/{db_id}")
        assert r3.status_code == 404

        client.post("/api/vault/disconnect")
