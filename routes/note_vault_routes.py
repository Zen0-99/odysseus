# routes/note_vault_routes.py
"""Vault vault sync API — read-only by default, write gated by permission."""

from __future__ import annotations

import json
import logging
import os
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel

from core.database import SessionLocal, VaultNote, Vault, VaultPermission, VaultInlineDatabase, VaultInlineDatabaseRow
from core.middleware import require_admin
from src.auth_helpers import effective_user, get_current_user
from src.vault_fs import invalidate_cache
from src.vault_graph import build_graph, build_timeline
from src.vault_graph_cache import get_cached_graph, save_graph_cache, invalidate_graph_cache
from src.vault_watcher import get_watcher, suppress_api_write
from src.vault_inline_database import (
    _MARKER_RE,
    parse_markers,
    promote_table,
    demote_table,
    edit_cell,
    add_column as db_add_column,
    remove_column as db_remove_column,
    add_row as db_add_row,
    remove_row as db_remove_row,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class ConnectRequest(BaseModel):
    vault_path: str
    name: Optional[str] = None
    read_enabled: bool = True
    write_enabled: bool = True


class VaultUpdateRequest(BaseModel):
    name: Optional[str] = None
    read_enabled: Optional[bool] = None
    write_enabled: Optional[bool] = None
    is_active: Optional[bool] = None


class PermissionRequest(BaseModel):
    path_pattern: str
    pattern_type: str = "file"
    permission: str = "read"
    priority: int = 0
    description: Optional[str] = None


class EditRequest(BaseModel):
    content: str


class MoveRequest(BaseModel):
    folder: str


class RenameRequest(BaseModel):
    new_path: str


class InlineDbPromoteRequest(BaseModel):
    table_start_line: Optional[int] = None
    marker: Optional[str] = None


class InlineDbCreateRequest(BaseModel):
    note_id: str
    columns: Optional[List[str]] = None
    title: Optional[str] = None


class InlineDbCellEditRequest(BaseModel):
    row: int
    col: int
    value: str


class InlineDbAddColumnRequest(BaseModel):
    name: str
    default_value: str = ""
    col_type: str = "text"


class InlineDbAddRowRequest(BaseModel):
    values: Optional[List[str]] = None


class InlineDbSchemaUpdateRequest(BaseModel):
    columns: Optional[List[Dict[str, Any]]] = None
    views: Optional[Dict[str, Any]] = None
    filters: Optional[List[Dict[str, Any]]] = None
    sort: Optional[List[Dict[str, Any]]] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _user(request: Request) -> str:
    u = effective_user(request)
    if not u:
        raise HTTPException(401, "Authentication required")
    return u


def _validate_vault_path(vault_path: str) -> Path:
    """Security: validate vault path exists, is a directory, and prevent traversal."""
    p = Path(vault_path).resolve()
    if ".." in str(p):
        raise HTTPException(400, "Invalid vault path: path traversal detected")
    if not p.exists():
        raise HTTPException(400, f"Vault path does not exist: {vault_path}")
    if not p.is_dir():
        raise HTTPException(400, f"Vault path is not a directory: {vault_path}")
    # Reject symlinks that point outside (safety check)
    if p.is_symlink():
        real = p.resolve()
        try:
            real.relative_to(Path(vault_path).resolve().parent)
        except ValueError:
            raise HTTPException(400, "Symlink outside vault root is not allowed")
    return p


def _vault_to_dict(v: Vault) -> Dict[str, Any]:
    return {
        "id": v.id,
        "name": v.name,
        "path": v.path,
        "read_enabled": v.read_enabled,
        "write_enabled": v.write_enabled,
        "is_active": v.is_active,
        "last_sync_at": v.last_sync_at.isoformat() if v.last_sync_at else None,
        "note_count": v.note_count or 0,
        "created_at": v.created_at.isoformat() if v.created_at else None,
        "updated_at": v.updated_at.isoformat() if v.updated_at else None,
    }


def _perm_to_dict(p: VaultPermission) -> Dict[str, Any]:
    return {
        "id": p.id,
        "vault_id": p.vault_id,
        "path_pattern": p.path_pattern,
        "pattern_type": p.pattern_type,
        "permission": p.permission,
        "priority": p.priority,
        "description": p.description,
    }


def _effective_permission(
    db, owner: str, vault_id: str, rel_path: str
) -> str:
    """Return effective permission for a note path: none | read | write.

    Resolution order (highest priority first):
    1. Specific file rules
    2. Folder rules (longest match)
    3. Regex rules
    4. Vault default (write_enabled -> write, else read)
    """
    vault = db.query(Vault).filter_by(id=vault_id, owner=owner).first()
    if not vault:
        return "write"
    if not vault.read_enabled:
        return "none"

    rules = (
        db.query(VaultPermission)
        .filter_by(vault_id=vault_id, owner=owner)
        .order_by(VaultPermission.priority.desc())
        .all()
    )

    best = None
    best_score = -1

    for rule in rules:
        score = rule.priority
        matched = False

        if rule.pattern_type == "file":
            matched = rule.path_pattern == rel_path
            score += 1000
        elif rule.pattern_type == "folder":
            folder_pat = rule.path_pattern.rstrip("/") + "/"
            matched = rel_path.startswith(folder_pat)
            score += 500
        elif rule.pattern_type == "regex":
            import re
            matched = bool(re.search(rule.path_pattern, rel_path))
            score += 250
        elif rule.pattern_type == "link":
            continue

        if matched and score > best_score:
            best = rule.permission
            best_score = score

    if best:
        return best

    return "write"


def _ensure_watcher(owner: str, vault_path: str) -> None:
    """Auto-start the file watcher for a vault if not already connected (fire-and-forget)."""
    def _connect():
        try:
            watcher = get_watcher()
            if not watcher.is_connected(owner, vault_path):
                ok, msg = watcher.connect(owner, vault_path)
                if not ok:
                    logger.warning(f"_ensure_watcher failed for {owner} @ {vault_path}: {msg}")
        except Exception:
            logger.exception("_ensure_watcher error")

    import threading
    threading.Thread(target=_connect, daemon=True, name=f"vault-watcher-{owner}").start()


def _note_to_dict(note: VaultNote) -> Dict[str, Any]:
    """Serialize Vault note to API-friendly dict (hides vault_path)."""
    return {
        "id": note.id,
        "rel_path": note.rel_path,
        "folder": note.folder,
        "title": note.title,
        "content": note.content,
        "frontmatter": note.frontmatter,
        "tags": _safe_json(note.tags, []),
        "outbound_links": _safe_json(note.outbound_links, []),
        "backlinks": _safe_json(note.backlinks, []),
        "last_modified_src": note.last_modified_src.isoformat() if note.last_modified_src else None,
        "sync_status": note.sync_status,
        "created_at": note.created_at.isoformat() if note.created_at else None,
        "updated_at": note.updated_at.isoformat() if note.updated_at else None,
    }


def _safe_json(raw: Optional[str], default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def _active_vault_and_path(db, owner: str) -> Tuple[Vault, str]:
    """Return (vault_record, vault_path) for the active vault."""
    vault = db.query(Vault).filter_by(owner=owner, is_active=True).first()
    vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
    if not vault_path:
        raise HTTPException(400, "No vault connected")
    _ensure_watcher(owner, vault_path)
    return vault, vault_path


def _read_note_raw(vault_path: str, note_id: str) -> str:
    root = Path(vault_path)
    target = root / note_id.replace("/", os.sep)
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "Note not found")
    try:
        return target.read_text(encoding="utf-8")
    except (IOError, UnicodeDecodeError) as e:
        raise HTTPException(500, f"Failed to read note: {e}")


def _write_note_raw(vault_path: str, note_id: str, content: str) -> None:
    root = Path(vault_path)
    target = root / note_id.replace("/", os.sep)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

def setup_note_vault_routes() -> APIRouter:
    router = APIRouter(prefix="/api/vault", tags=["vault"])

    # -----------------------------------------------------------------------
    # Connection management
    # -----------------------------------------------------------------------

    @router.post("/connect")
    async def vault_connect(req: ConnectRequest, request: Request):
        """Connect a vault — creates a vault record if new."""
        require_admin(request)
        owner = _user(request)
        vault = _validate_vault_path(req.vault_path)
        vault_id = f"{owner}:{vault}"

        watcher = get_watcher()
        ok, msg = watcher.connect(owner, str(vault))
        if not ok:
            raise HTTPException(400, msg)

        db = SessionLocal()
        try:
            existing = db.query(Vault).filter_by(id=vault_id).first()
            if existing:
                existing.is_active = True
                existing.read_enabled = req.read_enabled
                existing.write_enabled = req.write_enabled
                if req.name:
                    existing.name = req.name
            else:
                db.add(Vault(
                    id=vault_id,
                    owner=owner,
                    name=req.name or vault.name,
                    path=str(vault),
                    read_enabled=req.read_enabled,
                    write_enabled=req.write_enabled,
                    is_active=True,
                ))
            db.commit()

            count = db.query(VaultNote).filter_by(
                owner=owner, vault_path=str(vault)
            ).count()
            # Update vault note_count
            v = db.query(Vault).filter_by(id=vault_id).first()
            if v:
                v.note_count = count
                db.commit()
        finally:
            db.close()

        os.environ[f"_ODY_VAULT_{owner}"] = str(vault)
        return {"ok": True, "vault_id": vault_id, "vault_path": vault.name, "synced_notes": count}

    @router.post("/disconnect")
    async def vault_disconnect(request: Request):
        """Disconnect the legacy single vault."""
        require_admin(request)
        owner = _user(request)
        vault_env = os.environ.get(f"_ODY_VAULT_{owner}")
        if not vault_env:
            raise HTTPException(400, "No vault currently connected")

        watcher = get_watcher()
        watcher.disconnect(owner, vault_env)
        os.environ.pop(f"_ODY_VAULT_{owner}", None)

        db = SessionLocal()
        try:
            vault_id = f"{owner}:{vault_env}"
            v = db.query(Vault).filter_by(id=vault_id).first()
            if v:
                v.is_active = False
                db.commit()
        finally:
            db.close()

        return {"ok": True}

    @router.get("/status")
    async def vault_status(request: Request):
        """Return connection status for current user."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vaults = db.query(Vault).filter_by(owner=owner, is_active=True).all()
            # Update note_count from disk for each vault
            from src.vault_fs import list_notes
            result = []
            for v in vaults:
                d = _vault_to_dict(v)
                try:
                    notes = list_notes(v.path)
                    d["note_count"] = len(notes)
                except Exception:
                    pass
                result.append(d)
            vault_env = os.environ.get(f"_ODY_VAULT_{owner}")
            watcher = get_watcher()
            connected = watcher.is_connected(owner, vault_env) if vault_env else False
            return {
                "connected": connected,
                "vault_path": Path(vault_env).name if vault_env else None,
                "vaults": result,
            }
        finally:
            db.close()

    # -----------------------------------------------------------------------
    # Vault CRUD
    # -----------------------------------------------------------------------

    @router.get("/vaults")
    async def list_vaults(request: Request):
        """List all vaults for the current user."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vaults = db.query(Vault).filter_by(owner=owner).order_by(
                Vault.updated_at.desc()
            ).all()
            return {"vaults": [_vault_to_dict(v) for v in vaults]}
        finally:
            db.close()

    @router.post("/vaults")
    async def add_vault(req: ConnectRequest, request: Request):
        """Add and connect a new vault."""
        return await vault_connect(req, request)

    @router.delete("/vaults/{vault_id}")
    async def remove_vault(vault_id: str, request: Request):
        """Remove a vault and disconnect its watcher."""
        require_admin(request)
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(id=vault_id, owner=owner).first()
            if not vault:
                raise HTTPException(404, "Vault not found")

            watcher = get_watcher()
            watcher.disconnect(owner, vault.path)
            vault.is_active = False
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    @router.patch("/vaults/{vault_id}")
    async def update_vault(vault_id: str, req: VaultUpdateRequest, request: Request):
        """Update vault settings (name, read/write toggles, active state)."""
        require_admin(request)
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(id=vault_id, owner=owner).first()
            if not vault:
                raise HTTPException(404, "Vault not found")
            if req.name is not None:
                vault.name = req.name
            if req.read_enabled is not None:
                vault.read_enabled = req.read_enabled
            if req.write_enabled is not None:
                vault.write_enabled = req.write_enabled
            if req.is_active is not None:
                vault.is_active = req.is_active
            db.commit()
            return _vault_to_dict(vault)
        finally:
            db.close()

    # -----------------------------------------------------------------------
    # Permission rules
    # -----------------------------------------------------------------------

    @router.get("/vaults/{vault_id}/permissions")
    async def list_permissions(vault_id: str, request: Request):
        """List permission rules for a vault."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(id=vault_id, owner=owner).first()
            if not vault:
                raise HTTPException(404, "Vault not found")
            rules = (
                db.query(VaultPermission)
                .filter_by(vault_id=vault_id, owner=owner)
                .order_by(VaultPermission.priority.desc())
                .all()
            )
            return {"permissions": [_perm_to_dict(r) for r in rules]}
        finally:
            db.close()

    @router.post("/vaults/{vault_id}/permissions")
    async def add_permission(vault_id: str, req: PermissionRequest, request: Request):
        """Add a permission rule to a vault."""
        require_admin(request)
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(id=vault_id, owner=owner).first()
            if not vault:
                raise HTTPException(404, "Vault not found")
            rule = VaultPermission(
                id=uuid.uuid4().hex,
                vault_id=vault_id,
                owner=owner,
                path_pattern=req.path_pattern,
                pattern_type=req.pattern_type,
                permission=req.permission,
                priority=req.priority,
                description=req.description,
            )
            db.add(rule)
            db.commit()
            return _perm_to_dict(rule)
        finally:
            db.close()

    @router.delete("/vaults/{vault_id}/permissions/{perm_id}")
    async def remove_permission(vault_id: str, perm_id: str, request: Request):
        """Remove a permission rule."""
        require_admin(request)
        owner = _user(request)
        db = SessionLocal()
        try:
            rule = (
                db.query(VaultPermission)
                .filter_by(id=perm_id, vault_id=vault_id, owner=owner)
                .first()
            )
            if not rule:
                raise HTTPException(404, "Permission rule not found")
            db.delete(rule)
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    # -----------------------------------------------------------------------
    # CRUD
    # -----------------------------------------------------------------------

    @router.get("/notes")
    async def vault_list_notes(
        request: Request,
        vault_id: Optional[str] = None,
        q: Optional[str] = None,
        tag: Optional[str] = None,
        folder: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ):
        """List Vault notes directly from filesystem."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(id=vault_id, owner=owner).first() if vault_id else None
            if vault_id and not vault:
                raise HTTPException(404, "Vault not found")
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                return {"total": 0, "offset": offset, "limit": limit, "notes": []}
            _ensure_watcher(owner, vault_path)

            from src.vault_fs import list_notes
            notes = list_notes(vault_path, folder=folder, q=q)
            if tag:
                notes = [n for n in notes if tag in n.get("tags", [])]
            total = len(notes)
            notes = notes[offset:offset + limit]
            return {"total": total, "offset": offset, "limit": limit, "notes": notes}
        finally:
            db.close()


    # -----------------------------------------------------------------------
    # Inline databases — DB is source of truth, note holds marker + snapshot
    # -----------------------------------------------------------------------

    def _inline_db_to_dict(d: VaultInlineDatabase, rows: List[VaultInlineDatabaseRow] = None) -> Dict[str, Any]:
        if rows is None:
            rows = []
        columns = d.columns or []
        row_data = []
        for r in sorted(rows, key=lambda x: x.position):
            cells = r.cells or {}
            row_data.append([cells.get(str(i), "") for i in range(len(columns))])
        return {
            "id": d.id,
            "marker": d.marker,
            "note_path": d.note_path,
            "title": d.title or "Database",
            "columns": columns,
            "views": d.views or {},
            "filters": d.filters or [],
            "sort": d.sort or [],
            "rows": row_data,
            "created_at": d.created_at.isoformat() if d.created_at else None,
            "updated_at": d.updated_at.isoformat() if d.updated_at else None,
        }

    def _ensure_inline_db_write(db, owner: str, vault_id: str, note_id: str) -> None:
        perm = _effective_permission(db, owner, vault_id, note_id)
        if perm == "none":
            raise HTTPException(403, "Vault is not readable.")
        if perm == "read":
            raise HTTPException(403, "This note is read-only.")

    def _generate_snapshot(record: VaultInlineDatabase, rows: List[VaultInlineDatabaseRow]) -> str:
        """Regenerate the markdown table snapshot from DB record + rows."""
        columns = record.columns or []
        headers = [c.get("name", "Unnamed") for c in columns]
        lines = []
        lines.append(f"<!-- database: {record.marker} -->")
        lines.append("| " + " | ".join(headers) + " |")
        lines.append("| " + " | ".join(["---"] * len(headers)) + " |")
        for r in sorted(rows, key=lambda x: x.position):
            cells = r.cells or {}
            values = [cells.get(str(i), "") for i in range(len(headers))]
            lines.append("| " + " | ".join(values) + " |")
        return "\n".join(lines)

    def _write_snapshot_to_note(vault_path: str, note_path: str, marker: str, snapshot_md: str) -> None:
        """Replace the marker+table region in the note with the new snapshot."""
        content = _read_note_raw(vault_path, note_path)
        lines = content.split("\n")
        marker_idx = None
        for i, line in enumerate(lines):
            m = _MARKER_RE.match(line)
            if m and m.group(1) == marker:
                marker_idx = i
                break
        if marker_idx is None:
            # Marker not in note — append it
            if content and not content.endswith("\n"):
                content += "\n"
            if content and not content.endswith("\n\n"):
                content += "\n"
            content += snapshot_md + "\n"
        else:
            # Find table end: marker line + header + separator + data rows
            table_end = marker_idx + 1
            # Skip header line
            if table_end < len(lines) and lines[table_end].strip().startswith("|"):
                table_end += 1
            # Skip separator line
            if table_end < len(lines) and lines[table_end].strip().startswith("|") and "---" in lines[table_end]:
                table_end += 1
            # Skip data rows
            while table_end < len(lines) and lines[table_end].strip().startswith("|"):
                table_end += 1
            # Replace marker_idx..table_end with snapshot lines
            snapshot_lines = snapshot_md.split("\n")
            new_lines = lines[:marker_idx] + snapshot_lines + lines[table_end:]
            content = "\n".join(new_lines)
        _write_note_raw(vault_path, note_path, content)
        invalidate_cache(vault_path)

    def _sync_snapshot(db_session, record: VaultInlineDatabase, vault_path: str) -> None:
        """Regenerate snapshot from DB rows and write to note file."""
        rows = db_session.query(VaultInlineDatabaseRow).filter_by(
            db_id=record.id, owner=record.owner
        ).all()
        snapshot = _generate_snapshot(record, rows)
        _write_snapshot_to_note(vault_path, record.note_path, record.marker, snapshot)

    def _sync_snapshot_sync(db_id: str, owner: str, vault_path: str, note_path: str, marker: str) -> None:
        """Synchronous snapshot sync for background tasks."""
        db = SessionLocal()
        try:
            record = db.query(VaultInlineDatabase).filter_by(id=db_id, owner=owner).first()
            if not record:
                return
            rows = db.query(VaultInlineDatabaseRow).filter_by(
                db_id=db_id, owner=owner
            ).all()
            snapshot = _generate_snapshot(record, rows)
            file_path = str(Path(vault_path) / note_path.replace("/", os.sep))
            suppress_api_write(file_path)
            _write_snapshot_to_note(vault_path, note_path, marker, snapshot)
        finally:
            db.close()

    def _migrate_legacy_db(db_session, record: VaultInlineDatabase, vault_path: str, content: str) -> None:
        """Import existing markdown-table rows into VaultInlineDatabaseRow table.
        Only runs if no rows exist yet for this database."""
        existing = db_session.query(VaultInlineDatabaseRow).filter_by(db_id=record.id).first()
        if existing:
            return
        parsed = parse_markers(content)
        db_info = next((d for d in parsed if d["marker"] == record.marker), None)
        if not db_info:
            return
        columns = record.columns or []
        for pos, row_values in enumerate(db_info["rows"]):
            cells = {}
            for ci, val in enumerate(row_values):
                if ci < len(columns):
                    cells[str(ci)] = val
            db_session.add(VaultInlineDatabaseRow(
                id=uuid.uuid4().hex,
                db_id=record.id,
                owner=record.owner,
                position=pos,
                cells=cells,
            ))
        db_session.commit()

    @router.get("/notes/{note_id:path}/databases")
    async def vault_list_inline_databases(note_id: str, request: Request):
        """List all inline databases inside a note. Migrates legacy markdown-table
        databases on first read (imports rows into VaultInlineDatabaseRow)."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault, vault_path = _active_vault_and_path(db, owner)
            content = _read_note_raw(vault_path, note_id)
            found = parse_markers(content)
            records = {
                r.marker: r for r in db.query(VaultInlineDatabase)
                .filter_by(owner=owner, vault_id=vault.id, note_path=note_id)
                .all()
            }

            # Legacy migration: for any marker in the note that has a DB record
            # but no rows yet, import the markdown table rows into the rows table.
            for d in found:
                rec = records.get(d["marker"])
                if rec:
                    _migrate_legacy_db(db, rec, vault_path, content)

            result = []
            for d in found:
                rec = records.get(d["marker"])
                if rec:
                    rows = db.query(VaultInlineDatabaseRow).filter_by(
                        db_id=rec.id, owner=owner
                    ).all()
                    result.append({
                        "marker": d["marker"],
                        "marker_line": d["marker_line"],
                        "table_start": d["table_start"],
                        "table_end": d["table_end"],
                        "headers": d["headers"],
                        "rows": d["rows"],
                        "schema": _inline_db_to_dict(rec, rows),
                    })
                else:
                    result.append({
                        "marker": d["marker"],
                        "marker_line": d["marker_line"],
                        "table_start": d["table_start"],
                        "table_end": d["table_end"],
                        "headers": d["headers"],
                        "rows": d["rows"],
                        "schema": None,
                    })
            return {"databases": result}
        finally:
            db.close()

    @router.post("/databases")
    async def vault_create_inline_database(req: InlineDbCreateRequest, request: Request, background_tasks: BackgroundTasks):
        """Eagerly create a new inline database: DB record + first empty row +
        write marker+snapshot into the note file."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault, vault_path = _active_vault_and_path(db, owner)
            _ensure_inline_db_write(db, owner, vault.id, req.note_id)

            col_names = req.columns or ["Name"]
            columns = [{"name": n, "type": "text"} for n in col_names]
            marker = f"db-{uuid.uuid4().hex[:12]}"
            db_id = uuid.uuid4().hex

            record = VaultInlineDatabase(
                id=db_id,
                owner=owner,
                vault_id=vault.id,
                note_path=req.note_id,
                marker=marker,
                title=req.title or "Database",
                columns=columns,
                views={"default": {"type": "table"}},
                filters=[],
                sort=[],
            )
            db.add(record)
            db.flush()

            # Create first empty row
            first_row = VaultInlineDatabaseRow(
                id=uuid.uuid4().hex,
                db_id=db_id,
                owner=owner,
                position=0,
                cells={str(i): "" for i in range(len(columns))},
            )
            db.add(first_row)
            db.commit()

            # Write marker + snapshot into note
            rows = [first_row]
            background_tasks.add_task(_sync_snapshot_sync, record.id, owner, vault_path, record.note_path, record.marker)

            return {"ok": True, "marker": marker, "schema": _inline_db_to_dict(record, rows)}
        finally:
            db.close()

    @router.post("/notes/{note_id:path}/databases")
    async def vault_promote_inline_database(
        note_id: str, req: InlineDbPromoteRequest, request: Request
    ):
        """Promote a regular markdown table into a database (legacy/compat).
        Imports existing rows into VaultInlineDatabaseRow table."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault, vault_path = _active_vault_and_path(db, owner)
            _ensure_inline_db_write(db, owner, vault.id, note_id)
            content = _read_note_raw(vault_path, note_id)

            if req.marker:
                parsed = parse_markers(content)
                db_info = next((d for d in parsed if d["marker"] == req.marker), None)
                if not db_info:
                    raise HTTPException(400, f"Marker '{req.marker}' not found in note")
                marker = req.marker
                columns = [{"name": h, "type": "text"} for h in db_info["headers"]]
            else:
                if req.table_start_line is None:
                    raise HTTPException(400, "Either marker or table_start_line is required")
                lines = content.split("\n")
                existing_marker = None
                for idx in range(req.table_start_line, -1, -1):
                    if idx >= len(lines):
                        continue
                    m = _MARKER_RE.match(lines[idx])
                    if m:
                        existing_marker = m.group(1)
                        break

            if req.marker:
                pass
            elif existing_marker:
                marker = existing_marker
                parsed = parse_markers(content)
                db_info = next((d for d in parsed if d["marker"] == marker), None)
                if not db_info:
                    raise HTTPException(400, "Existing marker has no valid table")
                columns = [{"name": h, "type": "text"} for h in db_info["headers"]]
            else:
                new_content, marker = promote_table(content, req.table_start_line)
                _write_note_raw(vault_path, note_id, new_content)
                invalidate_cache(vault_path)
                parsed = parse_markers(new_content)
                db_info = next((d for d in parsed if d["marker"] == marker), None)
                columns = []
                if db_info:
                    columns = [{"name": h, "type": "text"} for h in db_info["headers"]]

            record = db.query(VaultInlineDatabase).filter_by(
                marker=marker, owner=owner, vault_id=vault.id, note_path=note_id
            ).first()
            if not record:
                record = VaultInlineDatabase(
                    id=uuid.uuid4().hex,
                    owner=owner,
                    vault_id=vault.id,
                    note_path=note_id,
                    marker=marker,
                    columns=columns,
                    views={"default": {"type": "table"}},
                    filters=[],
                    sort=[],
                )
                db.add(record)
                db.commit()

            # Import markdown rows into DB rows table (legacy migration)
            # Re-read note content to ensure marker is present (line-based promotion may have just written it)
            fresh_content = _read_note_raw(vault_path, note_id)
            _migrate_legacy_db(db, record, vault_path, fresh_content)

            rows = db.query(VaultInlineDatabaseRow).filter_by(
                db_id=record.id, owner=owner
            ).all()
            return {"ok": True, "marker": marker, "schema": _inline_db_to_dict(record, rows)}
        finally:
            db.close()

    @router.get("/databases/{db_id}")
    async def vault_get_inline_database(db_id: str, request: Request):
        """Get schema, rows, and view state for an inline database."""
        owner = _user(request)
        db = SessionLocal()
        try:
            record = db.query(VaultInlineDatabase).filter_by(id=db_id, owner=owner).first()
            if not record:
                raise HTTPException(404, "Database not found")
            rows = db.query(VaultInlineDatabaseRow).filter_by(
                db_id=db_id, owner=owner
            ).all()
            return _inline_db_to_dict(record, rows)
        finally:
            db.close()

    @router.patch("/databases/{db_id}")
    async def vault_update_inline_database(
        db_id: str, req: InlineDbSchemaUpdateRequest, request: Request, background_tasks: BackgroundTasks
    ):
        """Update schema, views, filters, or sort for an inline database."""
        owner = _user(request)
        db = SessionLocal()
        try:
            record = db.query(VaultInlineDatabase).filter_by(id=db_id, owner=owner).first()
            if not record:
                raise HTTPException(404, "Database not found")
            vault = db.query(Vault).filter_by(id=record.vault_id, owner=owner).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_inline_db_write(db, owner, record.vault_id, record.note_path)
            if req.columns is not None:
                record.columns = req.columns
            if req.views is not None:
                record.views = req.views
            if req.filters is not None:
                record.filters = req.filters
            if req.sort is not None:
                record.sort = req.sort
            db.commit()
            background_tasks.add_task(_sync_snapshot_sync, record.id, owner, vault_path, record.note_path, record.marker)
            rows = db.query(VaultInlineDatabaseRow).filter_by(
                db_id=db_id, owner=owner
            ).all()
            return _inline_db_to_dict(record, rows)
        finally:
            db.close()

    @router.delete("/databases/{db_id}")
    async def vault_demote_inline_database(db_id: str, request: Request):
        """Remove a database: delete DB record + rows, remove marker from note."""
        owner = _user(request)
        db = SessionLocal()
        try:
            record = db.query(VaultInlineDatabase).filter_by(id=db_id, owner=owner).first()
            if not record:
                raise HTTPException(404, "Database not found")
            vault = db.query(Vault).filter_by(id=record.vault_id, owner=owner).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_inline_db_write(db, owner, record.vault_id, record.note_path)
            content = _read_note_raw(vault_path, record.note_path)
            new_content = demote_table(content, record.marker)
            _write_note_raw(vault_path, record.note_path, new_content)
            invalidate_cache(vault_path)
            # Delete rows first, then record
            db.query(VaultInlineDatabaseRow).filter_by(db_id=db_id).delete()
            db.delete(record)
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    @router.post("/databases/{db_id}/cell")
    async def vault_edit_inline_database_cell(
        db_id: str, req: InlineDbCellEditRequest, request: Request, background_tasks: BackgroundTasks
    ):
        """Edit a single cell in an inline database (DB rows as source of truth)."""
        owner = _user(request)
        db = SessionLocal()
        try:
            record = db.query(VaultInlineDatabase).filter_by(id=db_id, owner=owner).first()
            if not record:
                raise HTTPException(404, "Database not found")
            vault = db.query(Vault).filter_by(id=record.vault_id, owner=owner).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_inline_db_write(db, owner, record.vault_id, record.note_path)
            rows = db.query(VaultInlineDatabaseRow).filter_by(
                db_id=db_id, owner=owner
            ).order_by(VaultInlineDatabaseRow.position).all()
            if req.row < 0 or req.row >= len(rows):
                raise HTTPException(400, f"Row index {req.row} out of range (have {len(rows)} rows)")
            row = rows[req.row]
            cells = dict(row.cells or {})
            cells[str(req.col)] = req.value
            row.cells = cells
            db.commit()
            background_tasks.add_task(_sync_snapshot_sync, record.id, owner, vault_path, record.note_path, record.marker)
            return {"ok": True}
        finally:
            db.close()

    @router.post("/databases/{db_id}/column")
    async def vault_add_inline_database_column(
        db_id: str, req: InlineDbAddColumnRequest, request: Request, background_tasks: BackgroundTasks
    ):
        """Add a column to an inline database. Updates schema + all row cells."""
        owner = _user(request)
        db = SessionLocal()
        try:
            record = db.query(VaultInlineDatabase).filter_by(id=db_id, owner=owner).first()
            if not record:
                raise HTTPException(404, "Database not found")
            vault = db.query(Vault).filter_by(id=record.vault_id, owner=owner).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_inline_db_write(db, owner, record.vault_id, record.note_path)
            columns = list(record.columns or [])
            new_col_idx = len(columns)
            columns.append({"name": req.name, "type": req.col_type})
            record.columns = columns
            # Add default value to all existing rows
            rows = db.query(VaultInlineDatabaseRow).filter_by(
                db_id=db_id, owner=owner
            ).all()
            for r in rows:
                cells = dict(r.cells or {})
                cells[str(new_col_idx)] = req.default_value
                r.cells = cells
            db.commit()
            background_tasks.add_task(_sync_snapshot_sync, record.id, owner, vault_path, record.note_path, record.marker)
            return {"ok": True, "schema": _inline_db_to_dict(record, rows)}
        finally:
            db.close()

    @router.delete("/databases/{db_id}/columns/{col_idx}")
    async def vault_remove_inline_database_column(db_id: str, col_idx: int, request: Request, background_tasks: BackgroundTasks):
        """Remove a column from an inline database. Updates schema + all row cells."""
        owner = _user(request)
        db = SessionLocal()
        try:
            record = db.query(VaultInlineDatabase).filter_by(id=db_id, owner=owner).first()
            if not record:
                raise HTTPException(404, "Database not found")
            vault = db.query(Vault).filter_by(id=record.vault_id, owner=owner).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_inline_db_write(db, owner, record.vault_id, record.note_path)
            columns = list(record.columns or [])
            if col_idx < 0 or col_idx >= len(columns):
                raise HTTPException(400, "Column index out of range")
            columns.pop(col_idx)
            record.columns = columns
            # Remap cell keys in all rows: shift keys > col_idx down by 1
            rows = db.query(VaultInlineDatabaseRow).filter_by(
                db_id=db_id, owner=owner
            ).all()
            for r in rows:
                cells = dict(r.cells or {})
                new_cells = {}
                for k, v in cells.items():
                    ki = int(k)
                    if ki == col_idx:
                        continue
                    elif ki > col_idx:
                        new_cells[str(ki - 1)] = v
                    else:
                        new_cells[str(ki)] = v
                r.cells = new_cells
            db.commit()
            background_tasks.add_task(_sync_snapshot_sync, record.id, owner, vault_path, record.note_path, record.marker)
            return {"ok": True, "schema": _inline_db_to_dict(record, rows)}
        finally:
            db.close()

    @router.post("/databases/{db_id}/row")
    async def vault_add_inline_database_row(
        db_id: str, req: InlineDbAddRowRequest, request: Request, background_tasks: BackgroundTasks
    ):
        """Add a row to an inline database (DB rows as source of truth)."""
        owner = _user(request)
        db = SessionLocal()
        try:
            record = db.query(VaultInlineDatabase).filter_by(id=db_id, owner=owner).first()
            if not record:
                raise HTTPException(404, "Database not found")
            vault = db.query(Vault).filter_by(id=record.vault_id, owner=owner).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_inline_db_write(db, owner, record.vault_id, record.note_path)
            columns = record.columns or []
            existing_rows = db.query(VaultInlineDatabaseRow).filter_by(
                db_id=db_id, owner=owner
            ).all()
            new_pos = len(existing_rows)
            values = req.values or []
            cells = {}
            for i in range(len(columns)):
                cells[str(i)] = values[i] if i < len(values) else ""
            new_row = VaultInlineDatabaseRow(
                id=uuid.uuid4().hex,
                db_id=db_id,
                owner=owner,
                position=new_pos,
                cells=cells,
            )
            db.add(new_row)
            db.commit()
            background_tasks.add_task(_sync_snapshot_sync, record.id, owner, vault_path, record.note_path, record.marker)
            all_rows = db.query(VaultInlineDatabaseRow).filter_by(
                db_id=db_id, owner=owner
            ).all()
            return {"ok": True, "schema": _inline_db_to_dict(record, all_rows)}
        finally:
            db.close()

    @router.delete("/databases/{db_id}/rows/{row_idx}")
    async def vault_remove_inline_database_row(db_id: str, row_idx: int, request: Request, background_tasks: BackgroundTasks):
        """Remove a row from an inline database (DB rows as source of truth)."""
        owner = _user(request)
        db = SessionLocal()
        try:
            record = db.query(VaultInlineDatabase).filter_by(id=db_id, owner=owner).first()
            if not record:
                raise HTTPException(404, "Database not found")
            vault = db.query(Vault).filter_by(id=record.vault_id, owner=owner).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_inline_db_write(db, owner, record.vault_id, record.note_path)
            rows = db.query(VaultInlineDatabaseRow).filter_by(
                db_id=db_id, owner=owner
            ).order_by(VaultInlineDatabaseRow.position).all()
            if row_idx < 0 or row_idx >= len(rows):
                raise HTTPException(400, "Row index out of range")
            db.delete(rows[row_idx])
            db.flush()
            # Reindex remaining rows
            remaining = db.query(VaultInlineDatabaseRow).filter_by(
                db_id=db_id, owner=owner
            ).order_by(VaultInlineDatabaseRow.position).all()
            for i, r in enumerate(remaining):
                r.position = i
            db.commit()
            background_tasks.add_task(_sync_snapshot_sync, record.id, owner, vault_path, record.note_path, record.marker)
            return {"ok": True}
        finally:
            db.close()

    @router.get("/notes/{note_id:path}")
    async def vault_get_note(note_id: str, request: Request):
        """Get a single note directly from filesystem."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(owner=owner, is_active=True).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_watcher(owner, vault_path)

            from src.vault_fs import get_note
            note = get_note(vault_path, note_id)
            if not note:
                raise HTTPException(404, "Note not found")
            # Resolve backlinks
            from src.vault_fs import list_notes, compute_backlinks
            all_notes = list_notes(vault_path)
            compute_backlinks(all_notes)
            resolved = []
            for bp in note.get("backlinks", []):
                bp_note = next((n for n in all_notes if n["rel_path"] == bp), None)
                resolved.append({"rel_path": bp, "title": bp_note["title"] if bp_note else bp})
            note["backlinks_resolved"] = resolved
            return note
        finally:
            db.close()

    # -----------------------------------------------------------------------
    # Folders & Tags
    # -----------------------------------------------------------------------

    @router.get("/folders")
    async def vault_folders(request: Request, vault_id: Optional[str] = None):
        """Return folder tree for a vault from filesystem."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(id=vault_id, owner=owner).first() if vault_id else None
            if vault_id and not vault:
                raise HTTPException(404, "Vault not found")
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                return {"folders": []}
            _ensure_watcher(owner, vault_path)

            from src.vault_fs import list_folders
            return {"folders": list_folders(vault_path)}
        finally:
            db.close()

    @router.get("/last-modified")
    async def vault_last_modified(request: Request, vault_id: Optional[str] = None):
        """Return the latest filesystem mtime for a vault (cheap poll endpoint)."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(id=vault_id, owner=owner).first() if vault_id else None
            if vault_id and not vault:
                raise HTTPException(404, "Vault not found")
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                return {"mtime": 0}
            _ensure_watcher(owner, vault_path)
            from src.vault_fs import vault_modified_ts
            return {"mtime": vault_modified_ts(vault_path)}
        finally:
            db.close()

    @router.get("/tags")
    async def vault_tags(request: Request, vault_id: Optional[str] = None):
        """Return unique tags with note counts from filesystem."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(id=vault_id, owner=owner).first() if vault_id else None
            if vault_id and not vault:
                raise HTTPException(404, "Vault not found")
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                return {"tags": []}
            _ensure_watcher(owner, vault_path)

            from src.vault_fs import list_tags
            return {"tags": list_tags(vault_path)}
        finally:
            db.close()

    # -----------------------------------------------------------------------
    # Graph & Timeline
    # -----------------------------------------------------------------------

    @router.post("/vaults/{vault_id}/resync")
    async def resync_vault(vault_id: str, request: Request):
        """Force a full resync of a vault's notes from disk."""
        require_admin(request)
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(id=vault_id, owner=owner).first()
            if not vault:
                raise HTTPException(404, "Vault not found")
            from src.vault_watcher import get_watcher
            watcher = get_watcher()
            ok, msg = watcher.connect(owner, vault.path)
            if not ok:
                raise HTTPException(400, msg)
            invalidate_cache(vault.path)
            return {"ok": True, "message": "Resync started"}
        finally:
            db.close()

    @router.get("/graph")
    async def vault_graph(request: Request, vault_id: Optional[str] = None, rebuild: bool = False):
        """Return graph nodes/edges/groups for vis-network canvas.

        Query params:
          rebuild=1 — force full rebuild, ignore cache
        """
        owner = _user(request)
        db = SessionLocal()
        try:
            if vault_id:
                vault = db.query(Vault).filter_by(id=vault_id, owner=owner).first()
                if not vault:
                    raise HTTPException(404, "Vault not found")
                vault_env = vault.path
            else:
                vault_env = os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_env:
                raise HTTPException(400, "No vault connected")
            _ensure_watcher(owner, vault_env)
            from src.vault_fs import list_notes
            notes = list_notes(vault_env)

            if not rebuild:
                cached = get_cached_graph(vault_env, notes)
                if cached is not None:
                    return cached

            graph = build_graph(notes)
            save_graph_cache(vault_env, notes, graph)
            return graph
        finally:
            db.close()

    @router.get("/timeline")
    async def vault_timeline(request: Request, vault_id: Optional[str] = None):
        """Return chronological frames for timeline animation player."""
        owner = _user(request)
        db = SessionLocal()
        try:
            if vault_id:
                vault = db.query(Vault).filter_by(id=vault_id, owner=owner).first()
                if not vault:
                    raise HTTPException(404, "Vault not found")
                vault_env = vault.path
            else:
                vault_env = os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_env:
                raise HTTPException(400, "No vault connected")
            _ensure_watcher(owner, vault_env)
            from src.vault_fs import list_notes
            notes = list_notes(vault_env)
            return {"frames": build_timeline(notes)}
        finally:
            db.close()

    # -----------------------------------------------------------------------
    # Editing (gated)
    # -----------------------------------------------------------------------

    @router.post("/notes/{note_id:path}/edit")
    async def vault_edit_note(note_id: str, req: EditRequest, request: Request):
        """Edit a note — gated by vault + per-path permissions."""
        owner = _user(request)
        db = SessionLocal()
        try:
            # Find active vault
            vault = db.query(Vault).filter_by(owner=owner, is_active=True).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_watcher(owner, vault_path)

            vault_id = vault.id if vault else f"{owner}:{vault_path}"
            perm = _effective_permission(db, owner, vault_id, note_id)
            if perm == "none":
                raise HTTPException(403, "Vault is not readable.")
            if perm == "read":
                raise HTTPException(403, "This note is read-only. Add a write permission rule to allow edits.")

            strategy = VAULT_EDIT_STRATEGIES.get("override")
            if not strategy:
                raise HTTPException(400, "Edit strategy not available")

            from types import SimpleNamespace
            note = SimpleNamespace(vault_path=vault_path, rel_path=note_id)
            result = strategy(note, req.content)
            invalidate_cache(vault_path)
            return {"ok": True, "mode": "override", "result": result}
        finally:
            db.close()

    @router.post("/notes/{note_id:path}/move")
    async def vault_move_note(note_id: str, req: MoveRequest, request: Request):
        """Move a note file to a different folder within the vault."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(owner=owner, is_active=True).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_watcher(owner, vault_path)

            vault_id = vault.id if vault else f"{owner}:{vault_path}"
            perm = _effective_permission(db, owner, vault_id, note_id)
            if perm == "none":
                raise HTTPException(403, "Vault is not readable.")
            if perm == "read":
                raise HTTPException(403, "This note is read-only.")

            root = Path(vault_path)
            src = root / note_id.replace("/", os.sep)
            if not src.exists():
                raise HTTPException(404, "Note not found")

            folder = req.folder.replace("/", os.sep) if req.folder else ""
            dest_dir = root / folder if folder else root
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / src.name
            if dest.exists() and dest != src:
                raise HTTPException(409, "Destination already exists")

            src.rename(dest)
            new_rel = str(dest.relative_to(root)).replace(os.sep, "/")
            invalidate_cache(vault_path)
            return {"ok": True, "new_path": new_rel}
        finally:
            db.close()

    @router.post("/notes/{note_id:path}/rename")
    async def vault_rename_note(note_id: str, req: RenameRequest, request: Request):
        """Rename a note file (change its filename / rel_path)."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(owner=owner, is_active=True).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_watcher(owner, vault_path)

            vault_id = vault.id if vault else f"{owner}:{vault_path}"
            perm = _effective_permission(db, owner, vault_id, note_id)
            if perm == "none":
                raise HTTPException(403, "Vault is not readable.")
            if perm == "read":
                raise HTTPException(403, "This note is read-only.")

            root = Path(vault_path)
            src = root / note_id.replace("/", os.sep)
            if not src.exists():
                raise HTTPException(404, "Note not found")

            new_path = req.new_path.replace("/", os.sep)
            dest = root / new_path
            if dest.exists() and dest != src:
                raise HTTPException(409, "Destination already exists")
            dest.parent.mkdir(parents=True, exist_ok=True)
            src.rename(dest)
            new_rel = str(dest.relative_to(root)).replace(os.sep, "/")
            invalidate_cache(vault_path)
            return {"ok": True, "new_path": new_rel}
        finally:
            db.close()

    @router.post("/folders/rename")
    async def vault_rename_folder(request: Request):
        """Rename (move) a folder within the vault."""
        owner = _user(request)
        data = await request.json()
        old_path = data.get("old_path", "").replace("/", os.sep)
        new_path = data.get("new_path", "").replace("/", os.sep)
        if not old_path or not new_path:
            raise HTTPException(400, "old_path and new_path required")
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(owner=owner, is_active=True).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_watcher(owner, vault_path)

            root = Path(vault_path)
            src = root / old_path
            if not src.exists() or not src.is_dir():
                raise HTTPException(404, "Folder not found")
            dest = root / new_path
            if dest.exists() and dest != src:
                raise HTTPException(409, "Destination already exists")
            dest.parent.mkdir(parents=True, exist_ok=True)
            src.rename(dest)
            invalidate_cache(vault_path)
            return {"ok": True}
        finally:
            db.close()

    @router.get("/notes/bulk")
    async def vault_bulk_notes(request: Request, ids: str = ""):
        """Return full content for a comma-separated list of note IDs."""
        from src.vault_fs import list_notes
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(owner=owner, is_active=True).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_watcher(owner, vault_path)

            id_list = [i.strip() for i in ids.split(",") if i.strip()]
            all_notes = list_notes(vault_path)
            notes = [n for n in all_notes if n["id"] in id_list or n["rel_path"] in id_list]
            return {"notes": notes}
        finally:
            db.close()

    @router.post("/semantic-search")
    async def vault_semantic_search(request: Request):
        """Semantic search across all notes in the active vault.

        Body: {"query": "string", "top_k": 20}
        """
        from src.vault_semantic_search import semantic_search
        from src.vault_fs import list_notes

        owner = _user(request)
        data = await request.json()
        query = data.get("query", "").strip()
        top_k = data.get("top_k", 20)

        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(owner=owner, is_active=True).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_watcher(owner, vault_path)

            notes = list_notes(vault_path)
            results = semantic_search(vault_path, notes, query, top_k=top_k)
            return {"query": query, "total": len(notes), "results": results}
        finally:
            db.close()

    @router.post("/folders")
    async def vault_create_folder(request: Request):
        """Create a new folder inside the vault."""
        owner = _user(request)
        data = await request.json()
        folder_path = data.get("path", "").replace("/", os.sep)
        if not folder_path:
            raise HTTPException(400, "path required")
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(owner=owner, is_active=True).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_watcher(owner, vault_path)

            root = Path(vault_path)
            target = root / folder_path
            if target.exists():
                raise HTTPException(409, "Folder already exists")
            target.mkdir(parents=True, exist_ok=True)
            invalidate_cache(vault_path)
            return {"ok": True, "path": folder_path.replace(os.sep, "/")}
        finally:
            db.close()

    @router.delete("/notes/{note_id:path}")
    async def vault_delete_note(note_id: str, request: Request):
        """Delete a note file from the vault."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(owner=owner, is_active=True).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_watcher(owner, vault_path)

            root = Path(vault_path)
            target = root / note_id.replace("/", os.sep)
            if not target.exists() or not target.is_file():
                raise HTTPException(404, "Note not found")

            target.unlink()
            invalidate_cache(vault_path)
            return {"ok": True}
        finally:
            db.close()

    @router.post("/folders/delete")
    async def vault_delete_folder(request: Request):
        """Delete a folder and all its contents from the vault."""
        owner = _user(request)
        data = await request.json()
        folder_path = data.get("folder_path", "").replace("/", os.sep)
        if not folder_path:
            raise HTTPException(400, "folder_path required")
        db = SessionLocal()
        try:
            vault = db.query(Vault).filter_by(owner=owner, is_active=True).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")
            _ensure_watcher(owner, vault_path)

            root = Path(vault_path)
            target = root / folder_path
            if not target.exists() or not target.is_dir():
                raise HTTPException(404, "Folder not found")

            import shutil
            shutil.rmtree(target)
            invalidate_cache(vault_path)
            return {"ok": True}
        finally:
            db.close()

    return router


# ---------------------------------------------------------------------------
# Edit strategies (extensible — Phase 4 fills in real implementations)
# ---------------------------------------------------------------------------

def _strategy_readonly(note, content):
    raise RuntimeError("readonly should have been rejected at route level")


def _strategy_duplicate(note, content):
    """Create a duplicate file with _EDITED_YYYY-MM-DD suffix."""
    vault = Path(note.vault_path)
    original = vault / note.rel_path
    from datetime import date
    suffix = f"_EDITED_{date.today().isoformat()}"
    dup_name = original.stem + suffix + ".md"
    dup_path = original.parent / dup_name
    dup_path.write_text(content, encoding="utf-8")
    return {"action": "duplicate", "path": str(dup_path.relative_to(vault)).replace("\\", "/")}


def _strategy_append(note, content):
    """Append an edit block near the end of the original file."""
    vault = Path(note.vault_path)
    original = vault / note.rel_path
    timestamp = datetime.utcnow().isoformat(timespec="seconds")
    block = f"\n\n> **Odysseus edit** ({timestamp}):\n> {content.replace(chr(10), chr(10)+'> ')}\n"
    existing = original.read_text(encoding="utf-8")
    original.write_text(existing + block, encoding="utf-8")
    return {"action": "append"}


def _strategy_override(note, content):
    """Overwrite the original file atomically with a persisted backup."""
    vault = Path(note.vault_path)
    original = vault / note.rel_path
    original.parent.mkdir(parents=True, exist_ok=True)

    temp_path = original.with_suffix(original.suffix + ".tmp")
    try:
        # Write to temp file first so the original is never in a partial state.
        temp_path.write_text(content, encoding="utf-8")

        # Backup the existing file before overwriting it.
        if original.exists():
            backup_dir = vault / ".odysseus" / "backups" / Path(note.rel_path).parent
            backup_dir.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S-%f")
            backup_name = f"{original.stem}-{timestamp}{original.suffix}"
            backup_path = backup_dir / backup_name
            shutil.copy2(original, backup_path)

            # Keep only the most recent 10 backups per note.
            backups = sorted(
                backup_dir.glob(f"{original.stem}-*{original.suffix}"),
                key=lambda p: p.stat().st_mtime,
            )
            for old in backups[:-10]:
                old.unlink(missing_ok=True)

        # Atomic rename: temp -> original.
        os.replace(temp_path, original)
    except Exception as e:
        logger.exception("Failed to save note %s", note.rel_path)
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)
        raise HTTPException(500, f"Failed to save note: {e}") from e
    return {"action": "override"}


VAULT_EDIT_STRATEGIES: Dict[str, Any] = {
    "readonly": _strategy_readonly,
    "duplicate": _strategy_duplicate,
    "append": _strategy_append,
    "override": _strategy_override,
}
