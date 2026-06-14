"""Plugin system API — discover, install, list, and uninstall plugins."""
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse, FileResponse

from src.plugin_manager import PluginManager
from src.auth_helpers import get_current_user
from core.middleware import require_admin


def setup_plugin_routes():
    router = APIRouter(prefix="/api/plugins", tags=["plugins"])
    pm = PluginManager()

    @router.get("")
    async def list_plugins(request: Request):
        require_admin(request)
        return {"installed": pm.list_installed()}

    @router.post("/discover")
    async def discover_plugins(request: Request, body: dict):
        require_admin(request)
        url = (body.get("url") or "").strip()
        if not url:
            raise HTTPException(400, "url required")
        results = pm.discover(url)
        # Mark already-installed
        for r in results:
            r["_installed"] = pm.is_installed(r.get("id", ""))
        return {"plugins": results}

    @router.post("/install")
    async def install_plugins(request: Request, body: dict):
        require_admin(request)
        url = (body.get("url") or "").strip()
        ids = body.get("ids", [])
        if not url or not ids:
            raise HTTPException(400, "url and ids required")
        if not isinstance(ids, list):
            raise HTTPException(400, "ids must be a list")
        result = pm.install(url, ids)
        return result

    @router.delete("/{plugin_id}")
    async def uninstall_plugin(request: Request, plugin_id: str):
        require_admin(request)
        if pm.uninstall(plugin_id):
            return {"ok": True}
        raise HTTPException(404, "Plugin not found")

    @router.post("/updates")
    async def check_updates(request: Request):
        require_admin(request)
        updates = pm.check_updates()
        return {"updates": updates}

    @router.post("/verify")
    async def verify_plugins(request: Request):
        require_admin(request)
        results = pm.verify_hashes()
        return {"results": results}

    @router.get("/static/{plugin_id}/{filepath:path}")
    async def plugin_static(request: Request, plugin_id: str, filepath: str):
        target = pm.serve_path(plugin_id, filepath)
        if not target:
            raise HTTPException(404, "Not found")
        return FileResponse(target)

    return router
