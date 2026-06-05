# routes/obsidian_routes.py
"""Obsidian vault sync API — read-only by default, write gated by permission."""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from core.database import SessionLocal, Obsidian, ObsidianVault, ObsidianPermission
from core.middleware import require_admin
from src.auth_helpers import effective_user, get_current_user
from src.obsidian_graph import build_graph, build_timeline
from src.obsidian_watcher import get_watcher

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class ConnectRequest(BaseModel):
    vault_path: str
    name: Optional[str] = None
    read_enabled: bool = True
    write_enabled: bool = False


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


def _vault_to_dict(v: ObsidianVault) -> Dict[str, Any]:
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


def _perm_to_dict(p: ObsidianPermission) -> Dict[str, Any]:
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
    vault = db.query(ObsidianVault).filter_by(id=vault_id, owner=owner).first()
    if not vault or not vault.read_enabled:
        return "none"

    rules = (
        db.query(ObsidianPermission)
        .filter_by(vault_id=vault_id, owner=owner)
        .order_by(ObsidianPermission.priority.desc())
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

    return "write" if vault.write_enabled else "read"


def _note_to_dict(note: Obsidian) -> Dict[str, Any]:
    """Serialize Obsidian note to API-friendly dict (hides vault_path)."""
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


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

def setup_obsidian_routes() -> APIRouter:
    router = APIRouter(prefix="/api/obsidian", tags=["obsidian"])

    # -----------------------------------------------------------------------
    # Connection management
    # -----------------------------------------------------------------------

    @router.post("/connect")
    async def obsidian_connect(req: ConnectRequest, request: Request):
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
            existing = db.query(ObsidianVault).filter_by(id=vault_id).first()
            if existing:
                existing.is_active = True
                existing.read_enabled = req.read_enabled
                existing.write_enabled = req.write_enabled
                if req.name:
                    existing.name = req.name
            else:
                db.add(ObsidianVault(
                    id=vault_id,
                    owner=owner,
                    name=req.name or vault.name,
                    path=str(vault),
                    read_enabled=req.read_enabled,
                    write_enabled=req.write_enabled,
                    is_active=True,
                ))
            db.commit()

            count = db.query(Obsidian).filter_by(
                owner=owner, vault_path=str(vault)
            ).count()
            # Update vault note_count
            v = db.query(ObsidianVault).filter_by(id=vault_id).first()
            if v:
                v.note_count = count
                db.commit()
        finally:
            db.close()

        os.environ[f"_ODY_OBSIDIAN_VAULT_{owner}"] = str(vault)
        return {"ok": True, "vault_id": vault_id, "vault_path": vault.name, "synced_notes": count}

    @router.post("/disconnect")
    async def obsidian_disconnect(request: Request):
        """Disconnect the legacy single vault."""
        require_admin(request)
        owner = _user(request)
        vault_env = os.environ.get(f"_ODY_OBSIDIAN_VAULT_{owner}")
        if not vault_env:
            raise HTTPException(400, "No vault currently connected")

        watcher = get_watcher()
        watcher.disconnect(owner, vault_env)
        os.environ.pop(f"_ODY_OBSIDIAN_VAULT_{owner}", None)

        db = SessionLocal()
        try:
            vault_id = f"{owner}:{vault_env}"
            v = db.query(ObsidianVault).filter_by(id=vault_id).first()
            if v:
                v.is_active = False
                db.commit()
        finally:
            db.close()

        return {"ok": True}

    @router.get("/status")
    async def obsidian_status(request: Request):
        """Return connection status for current user."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vaults = db.query(ObsidianVault).filter_by(owner=owner, is_active=True).all()
            # Update note_count from disk for each vault
            from src.obsidian_fs import list_notes
            result = []
            for v in vaults:
                d = _vault_to_dict(v)
                try:
                    notes = list_notes(v.path)
                    d["note_count"] = len(notes)
                except Exception:
                    pass
                result.append(d)
            vault_env = os.environ.get(f"_ODY_OBSIDIAN_VAULT_{owner}")
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
            vaults = db.query(ObsidianVault).filter_by(owner=owner).order_by(
                ObsidianVault.updated_at.desc()
            ).all()
            return {"vaults": [_vault_to_dict(v) for v in vaults]}
        finally:
            db.close()

    @router.post("/vaults")
    async def add_vault(req: ConnectRequest, request: Request):
        """Add and connect a new vault."""
        return await obsidian_connect(req, request)

    @router.delete("/vaults/{vault_id}")
    async def remove_vault(vault_id: str, request: Request):
        """Remove a vault and disconnect its watcher."""
        require_admin(request)
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(ObsidianVault).filter_by(id=vault_id, owner=owner).first()
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
            vault = db.query(ObsidianVault).filter_by(id=vault_id, owner=owner).first()
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
            vault = db.query(ObsidianVault).filter_by(id=vault_id, owner=owner).first()
            if not vault:
                raise HTTPException(404, "Vault not found")
            rules = (
                db.query(ObsidianPermission)
                .filter_by(vault_id=vault_id, owner=owner)
                .order_by(ObsidianPermission.priority.desc())
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
            vault = db.query(ObsidianVault).filter_by(id=vault_id, owner=owner).first()
            if not vault:
                raise HTTPException(404, "Vault not found")
            rule = ObsidianPermission(
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
                db.query(ObsidianPermission)
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
    async def obsidian_list_notes(
        request: Request,
        vault_id: Optional[str] = None,
        q: Optional[str] = None,
        tag: Optional[str] = None,
        folder: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ):
        """List Obsidian notes directly from filesystem."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(ObsidianVault).filter_by(id=vault_id, owner=owner).first() if vault_id else None
            if vault_id and not vault:
                raise HTTPException(404, "Vault not found")
            vault_path = vault.path if vault else os.environ.get(f"_ODY_OBSIDIAN_VAULT_{owner}")
            if not vault_path:
                return {"total": 0, "offset": offset, "limit": limit, "notes": []}

            from src.obsidian_fs import list_notes
            notes = list_notes(vault_path, folder=folder, q=q)
            if tag:
                notes = [n for n in notes if tag in n.get("tags", [])]
            total = len(notes)
            notes = notes[offset:offset + limit]
            return {"total": total, "offset": offset, "limit": limit, "notes": notes}
        finally:
            db.close()

    @router.get("/notes/{note_id:path}")
    async def obsidian_get_note(note_id: str, request: Request):
        """Get a single note directly from filesystem."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(ObsidianVault).filter_by(owner=owner, is_active=True).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_OBSIDIAN_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")

            from src.obsidian_fs import get_note
            note = get_note(vault_path, note_id)
            if not note:
                raise HTTPException(404, "Note not found")
            # Resolve backlinks
            from src.obsidian_fs import list_notes, compute_backlinks
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
    async def obsidian_folders(request: Request, vault_id: Optional[str] = None):
        """Return folder tree for a vault from filesystem."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(ObsidianVault).filter_by(id=vault_id, owner=owner).first() if vault_id else None
            if vault_id and not vault:
                raise HTTPException(404, "Vault not found")
            vault_path = vault.path if vault else os.environ.get(f"_ODY_OBSIDIAN_VAULT_{owner}")
            if not vault_path:
                return {"folders": []}

            from src.obsidian_fs import list_folders
            return {"folders": list_folders(vault_path)}
        finally:
            db.close()

    @router.get("/tags")
    async def obsidian_tags(request: Request, vault_id: Optional[str] = None):
        """Return unique tags with note counts from filesystem."""
        owner = _user(request)
        db = SessionLocal()
        try:
            vault = db.query(ObsidianVault).filter_by(id=vault_id, owner=owner).first() if vault_id else None
            if vault_id and not vault:
                raise HTTPException(404, "Vault not found")
            vault_path = vault.path if vault else os.environ.get(f"_ODY_OBSIDIAN_VAULT_{owner}")
            if not vault_path:
                return {"tags": []}

            from src.obsidian_fs import list_tags
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
            vault = db.query(ObsidianVault).filter_by(id=vault_id, owner=owner).first()
            if not vault:
                raise HTTPException(404, "Vault not found")
            from src.obsidian_watcher import get_watcher
            watcher = get_watcher()
            ok, msg = watcher.connect(owner, vault.path)
            if not ok:
                raise HTTPException(400, msg)
            return {"ok": True, "message": "Resync started"}
        finally:
            db.close()

    @router.get("/graph")
    async def obsidian_graph(request: Request, vault_id: Optional[str] = None):
        """Return graph nodes/edges/groups for vis-network canvas."""
        owner = _user(request)
        db = SessionLocal()
        try:
            if vault_id:
                vault = db.query(ObsidianVault).filter_by(id=vault_id, owner=owner).first()
                if not vault:
                    raise HTTPException(404, "Vault not found")
                vault_env = vault.path
            else:
                vault_env = os.environ.get(f"_ODY_OBSIDIAN_VAULT_{owner}")
            if not vault_env:
                raise HTTPException(400, "No vault connected")
            from src.obsidian_fs import list_notes
            notes = list_notes(vault_env)
            return build_graph(notes)
        finally:
            db.close()

    @router.get("/timeline")
    async def obsidian_timeline(request: Request, vault_id: Optional[str] = None):
        """Return chronological frames for timeline animation player."""
        owner = _user(request)
        db = SessionLocal()
        try:
            if vault_id:
                vault = db.query(ObsidianVault).filter_by(id=vault_id, owner=owner).first()
                if not vault:
                    raise HTTPException(404, "Vault not found")
                vault_env = vault.path
            else:
                vault_env = os.environ.get(f"_ODY_OBSIDIAN_VAULT_{owner}")
            if not vault_env:
                raise HTTPException(400, "No vault connected")
            from src.obsidian_fs import list_notes
            notes = list_notes(vault_env)
            return {"frames": build_timeline(notes)}
        finally:
            db.close()

    # -----------------------------------------------------------------------
    # Editing (gated)
    # -----------------------------------------------------------------------

    @router.post("/notes/{note_id:path}/edit")
    async def obsidian_edit_note(note_id: str, req: EditRequest, request: Request):
        """Edit a note — gated by vault + per-path permissions."""
        require_admin(request)
        owner = _user(request)
        db = SessionLocal()
        try:
            # Find active vault
            vault = db.query(ObsidianVault).filter_by(owner=owner, is_active=True).first()
            vault_path = vault.path if vault else os.environ.get(f"_ODY_OBSIDIAN_VAULT_{owner}")
            if not vault_path:
                raise HTTPException(400, "No vault connected")

            vault_id = vault.id if vault else f"{owner}:{vault_path}"
            perm = _effective_permission(db, owner, vault_id, note_id)
            if perm == "none":
                raise HTTPException(403, "Vault is not readable.")
            if perm == "read":
                raise HTTPException(403, "This note is read-only. Add a write permission rule to allow edits.")

            strategy = OBSIDIAN_EDIT_STRATEGIES.get("override")
            if not strategy:
                raise HTTPException(400, "Edit strategy not available")

            from types import SimpleNamespace
            note = SimpleNamespace(vault_path=vault_path, rel_path=note_id)
            result = strategy(note, req.content)
            return {"ok": True, "mode": "override", "result": result}
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
    """Overwrite the original file directly."""
    vault = Path(note.vault_path)
    original = vault / note.rel_path
    original.write_text(content, encoding="utf-8")
    return {"action": "override"}


OBSIDIAN_EDIT_STRATEGIES: Dict[str, Any] = {
    "readonly": _strategy_readonly,
    "duplicate": _strategy_duplicate,
    "append": _strategy_append,
    "override": _strategy_override,
}
