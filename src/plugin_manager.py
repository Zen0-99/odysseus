"""Plugin manager — discover, install, and uninstall repo-based plugins."""
import hashlib
import json
import os
import shutil
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from src.constants import DATA_DIR

PLUGINS_DIR = os.path.join(DATA_DIR, "plugins")


def _registry_file() -> str:
    return os.path.join(PLUGINS_DIR, "registry.json")


def _install_log() -> str:
    return os.path.join(PLUGINS_DIR, "install.log")


def _ensure_dirs():
    os.makedirs(PLUGINS_DIR, exist_ok=True)


def _load_registry() -> dict:
    _ensure_dirs()
    try:
        with open(_registry_file(), "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_registry(data: dict):
    _ensure_dirs()
    registry_file = _registry_file()
    tmp = f"{registry_file}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, registry_file)


def _hash_file(path: str) -> str:
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
    except Exception:
        return ""
    return h.hexdigest()


def _log_install(url: str, plugin_id: str, action: str = "install"):
    _ensure_dirs()
    line = f"{datetime.utcnow().isoformat()}Z  {action:10}  {plugin_id:40}  {url}\n"
    with open(_install_log(), "a", encoding="utf-8") as f:
        f.write(line)


def _to_raw_url(repo_url: str, rel_path: str) -> str | None:
    """Convert a GitHub/GitLab repo URL to a raw file URL."""
    parsed = urlparse(repo_url.rstrip("/"))
    host = parsed.hostname or ""
    path = parsed.path.strip("/").split("/")
    if len(path) < 2:
        return None
    owner, repo = path[0], path[1]
    # Strip .git suffix from repo
    repo = repo.removesuffix(".git")
    rest = "/".join(path[2:])
    if "github.com" in host:
        branch = "main"
        if rest.startswith("tree/") or rest.startswith("blob/"):
            parts = rest.split("/", 2)
            if len(parts) >= 2:
                branch = parts[1]
                rest = parts[2] if len(parts) > 2 else ""
        raw = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{rel_path}"
        return raw
    if "gitlab.com" in host:
        branch = "main"
        raw = f"https://gitlab.com/{owner}/{repo}/-/raw/{branch}/{rel_path}"
        return raw
    # Unknown host — unsupported to avoid arbitrary-URL / SSRF risk
    return None


def _fetch_json(url: str, timeout: float = 10.0) -> Any | None:
    try:
        r = httpx.get(url, timeout=timeout, follow_redirects=True)
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


def _detect_tags(manifest: dict) -> list[str]:
    """Infer what a plugin affects/tags from its manifest.
    Auto-detected categories always come first.
    Plugins may declare custom items via the 'affects' list (max 10)."""
    auto = []
    entrypoints = manifest.get("entrypoints", {})
    # Handle entrypoints as dict
    if isinstance(entrypoints, dict):
        if entrypoints.get("frontend"):
            auto.append("Frontend")
        if entrypoints.get("backend"):
            auto.append("Backend")
        if entrypoints.get("main"):
            auto.append("Frontend")
        for k, v in entrypoints.items():
            if isinstance(v, str):
                if v.endswith(".js") and "Frontend" not in auto:
                    auto.append("Frontend")
                if v.endswith(".py") and "Backend" not in auto:
                    auto.append("Backend")
    # Handle entrypoints as plain string
    elif isinstance(entrypoints, str):
        if entrypoints.endswith(".js") and "Frontend" not in auto:
            auto.append("Frontend")
        if entrypoints.endswith(".py") and "Backend" not in auto:
            auto.append("Backend")
    # Handle entrypoints as list
    elif isinstance(entrypoints, list):
        for ep in entrypoints:
            if isinstance(ep, str):
                if ep.endswith(".js") and "Frontend" not in auto:
                    auto.append("Frontend")
                if ep.endswith(".py") and "Backend" not in auto:
                    auto.append("Backend")
    if manifest.get("panels"):
        auto.append("Panels")
    if manifest.get("settings"):
        auto.append("Settings")
    if manifest.get("themes") or manifest.get("styles"):
        auto.append("Themes")
    if manifest.get("hooks"):
        auto.append("Hooks")
    perms = manifest.get("permissions", [])
    if isinstance(perms, list):
        p_set = {str(p).lower() for p in perms}
        if "storage" in p_set:
            auto.append("Storage")
        if "network" in p_set or "fetch" in p_set:
            auto.append("Network")
        if "dom" in p_set or "document" in p_set:
            auto.append("DOM")
    # Type / category hints
    t = str(manifest.get("type", "")).lower()
    if t in ("frontend", "ui", "theme", "style") and "Frontend" not in auto:
        auto.append("Frontend")
    if t in ("backend", "api", "integration", "tool") and "Backend" not in auto:
        auto.append("Backend")
    cat = str(manifest.get("category", "")).lower()
    if cat in ("frontend", "ui") and "Frontend" not in auto:
        auto.append("Frontend")
    if cat in ("backend", "api", "service") and "Backend" not in auto:
        auto.append("Backend")
    # Description-based heuristics
    desc = str(manifest.get("description", "")).lower()
    if any(w in desc for w in ("title", "brand", "logo", "ui", "theme", "style", "frontend")) and "Frontend" not in auto:
        auto.append("Frontend")
    if any(w in desc for w in ("api", "route", "endpoint", "server", "backend")) and "Backend" not in auto:
        auto.append("Backend")
    if not auto:
        auto.append("Other")

    declared = manifest.get("affects")
    custom = []
    if isinstance(declared, list):
        for a in declared[:10]:
            s = str(a).strip()
            if s and s not in auto and s not in custom:
                custom.append(s)

    return auto + custom


def _verify_file_hashes(plugin_dir: str, manifest: dict) -> tuple[bool, str]:
    """Compare on-disk SHA-256 against manifest-declared hashes."""
    file_hashes = manifest.get("file_hashes", {})
    if not isinstance(file_hashes, dict):
        return False, "file_hashes is not a dict"
    for fname, expected in file_hashes.items():
        expected = str(expected)
        if expected.startswith("sha256:"):
            expected = expected[7:]
        fp = os.path.join(plugin_dir, fname)
        if not os.path.isfile(fp):
            return False, f"Missing file: {fname}"
        actual = _hash_file(fp)
        if actual != expected.lower():
            return False, f"Hash mismatch for {fname}"
    return True, ""


def _validate_manifest(manifest: dict) -> tuple[bool, str]:
    required = {"id", "name", "version", "description", "entrypoints", "file_hashes"}
    missing = required - set(manifest.keys())
    if missing:
        return False, f"Missing required fields: {', '.join(missing)}"
    plugin_id = manifest.get("id", "")
    if not plugin_id or "/" in plugin_id or "\\" in plugin_id or ".." in plugin_id:
        return False, "Invalid plugin id"
    frontend = manifest.get("entrypoints", {}).get("frontend", "")
    if not frontend or ".." in frontend:
        return False, "Invalid frontend entrypoint"
    file_hashes = manifest.get("file_hashes")
    if not isinstance(file_hashes, dict) or not file_hashes:
        return False, "file_hashes must be a non-empty dict"
    for fname in file_hashes:
        if ".." in fname or fname.startswith("/") or "\\" in fname:
            return False, f"Invalid file_hashes key: {fname}"
    return True, ""


class PluginManager:
    def discover(self, repo_url: str) -> list[dict]:
        """Fetch root plugins.json and each sub-plugin manifest."""
        root_url = _to_raw_url(repo_url, "plugins.json")
        if not root_url:
            return []
        root = _fetch_json(root_url)
        if not root or not isinstance(root, dict):
            return []
        plugin_paths = root.get("plugins", [])
        if not isinstance(plugin_paths, list):
            return []
        results = []
        for p in plugin_paths:
            manifest_url = _to_raw_url(repo_url, f"{p}/odysseus-plugin.json")
            if not manifest_url:
                continue
            manifest = _fetch_json(manifest_url)
            if not manifest or not isinstance(manifest, dict):
                continue
            ok, err = _validate_manifest(manifest)
            if ok:
                manifest["_repo_url"] = repo_url
                manifest["_path"] = p
                manifest["_tags"] = _detect_tags(manifest)
                results.append(manifest)
        return results

    def list_installed(self) -> list[dict]:
        registry = _load_registry()
        installed = []
        for plugin_id, info in registry.items():
            manifest_path = os.path.join(PLUGINS_DIR, plugin_id, "odysseus-plugin.json")
            if os.path.exists(manifest_path):
                try:
                    with open(manifest_path, "r", encoding="utf-8") as f:
                        manifest = json.load(f)
                    manifest["installed_at"] = info.get("installed_at")
                    manifest["_repo_url"] = info.get("repo_url")
                    # Integrity verification against manifest-declared hashes
                    hash_ok, _ = _verify_file_hashes(
                        os.path.join(PLUGINS_DIR, plugin_id), manifest
                    )
                    manifest["_hash_ok"] = hash_ok
                    manifest["_last_verified"] = info.get("last_verified")
                    manifest["_tags"] = _detect_tags(manifest)
                    installed.append(manifest)
                except Exception:
                    pass
        return installed

    def verify_hashes(self) -> dict[str, dict]:
        """Verify all installed plugins against their manifest file_hashes."""
        registry = _load_registry()
        results = {}
        for plugin_id, info in registry.items():
            plugin_dir = os.path.join(PLUGINS_DIR, plugin_id)
            manifest_path = os.path.join(plugin_dir, "odysseus-plugin.json")
            ok_ = None
            if os.path.exists(manifest_path):
                try:
                    with open(manifest_path, "r", encoding="utf-8") as f:
                        manifest = json.load(f)
                    ok_, _ = _verify_file_hashes(plugin_dir, manifest)
                except Exception:
                    pass
            results[plugin_id] = {"ok": ok_}
            info["last_verified"] = datetime.utcnow().isoformat() + "Z"
        _save_registry(registry)
        return results

    def is_installed(self, plugin_id: str) -> bool:
        registry = _load_registry()
        return plugin_id in registry and os.path.isdir(os.path.join(PLUGINS_DIR, plugin_id))

    def install(self, repo_url: str, plugin_ids: list[str]) -> dict:
        """Download repo ZIP, extract selected plugins."""
        _ensure_dirs()
        # Derive ZIP URL from repo URL
        parsed = urlparse(repo_url.rstrip("/"))
        host = parsed.hostname or ""
        path = parsed.path.strip("/").split("/")
        if len(path) < 2:
            return {"installed": [], "failed": ["Invalid repo URL"], "needs_restart": False}
        owner, repo = path[0], path[1].removesuffix(".git")
        branch = "main"
        zip_urls = []
        if "github.com" in host:
            zip_urls = [
                f"https://github.com/{owner}/{repo}/archive/refs/heads/main.zip",
                f"https://github.com/{owner}/{repo}/archive/refs/heads/master.zip",
            ]
        elif "gitlab.com" in host:
            zip_urls = [
                f"https://gitlab.com/{owner}/{repo}/-/archive/main/{repo}-main.zip",
                f"https://gitlab.com/{owner}/{repo}/-/archive/master/{repo}-master.zip",
            ]
        else:
            return {"installed": [], "failed": ["Unsupported git host"], "needs_restart": False}

        installed = []
        failed = []
        needs_restart = False

        r = None
        last_err = None
        for zip_url in zip_urls:
            try:
                r = httpx.get(zip_url, timeout=30.0, follow_redirects=True)
                r.raise_for_status()
                break
            except Exception as e:
                last_err = e
        if r is None:
            return {"installed": [], "failed": [str(last_err)], "needs_restart": False}

        with tempfile.TemporaryDirectory() as tmpdir:
            zip_path = os.path.join(tmpdir, "repo.zip")
            with open(zip_path, "wb") as f:
                f.write(r.content)
            extract_dir = os.path.join(tmpdir, "extracted")
            os.makedirs(extract_dir, exist_ok=True)
            with zipfile.ZipFile(zip_path, "r") as z:
                z.extractall(extract_dir)
            # Find the extracted root folder
            entries = [e for e in os.listdir(extract_dir) if os.path.isdir(os.path.join(extract_dir, e))]
            if not entries:
                return {"installed": [], "failed": ["Empty ZIP"], "needs_restart": False}
            repo_root = os.path.join(extract_dir, entries[0])

            # Read plugins.json from extracted ZIP (no network re-fetch)
            root_manifest_path = os.path.join(repo_root, "plugins.json")
            id_to_path: dict[str, str] = {}
            if os.path.isfile(root_manifest_path):
                try:
                    with open(root_manifest_path, "r", encoding="utf-8") as f:
                        root_manifest = json.load(f)
                    for p in root_manifest.get("plugins", []):
                        mp = os.path.join(repo_root, p, "odysseus-plugin.json")
                        if os.path.isfile(mp):
                            try:
                                with open(mp, "r", encoding="utf-8") as mf:
                                    m = json.load(mf)
                                ok, _ = _validate_manifest(m)
                                if ok:
                                    id_to_path[m["id"]] = p
                            except Exception:
                                pass
                except Exception:
                    pass

            for plugin_id in plugin_ids:
                rel_path = id_to_path.get(plugin_id)
                if not rel_path:
                    failed.append(f"{plugin_id}: not found in repo manifest")
                    continue
                src = os.path.join(repo_root, rel_path)
                if not os.path.isdir(src):
                    failed.append(f"{plugin_id}: folder not in archive")
                    continue
                manifest_path_src = os.path.join(src, "odysseus-plugin.json")
                m: dict = {}
                try:
                    with open(manifest_path_src, "r", encoding="utf-8") as mf:
                        m = json.load(mf)
                except Exception:
                    failed.append(f"{plugin_id}: could not read manifest")
                    continue
                ok, err = _validate_manifest(m)
                if not ok:
                    failed.append(f"{plugin_id}: {err}")
                    continue
                # Supply-chain verification: manifest-declared hashes vs extracted files
                hash_ok, hash_err = _verify_file_hashes(src, m)
                if not hash_ok:
                    failed.append(f"{plugin_id}: {hash_err}")
                    continue
                version = m.get("version", "0.0.0")
                dest = os.path.join(PLUGINS_DIR, plugin_id)
                if os.path.exists(dest):
                    shutil.rmtree(dest)
                shutil.copytree(src, dest)
                registry = _load_registry()
                registry[plugin_id] = {
                    "installed_at": datetime.utcnow().isoformat() + "Z",
                    "repo_url": repo_url,
                    "version": version,
                    "source_verified": True,
                    "last_verified": datetime.utcnow().isoformat() + "Z",
                }
                _save_registry(registry)
                _log_install(repo_url, plugin_id, "install")
                installed.append(plugin_id)
                # Trigger backend install hook
                try:
                    from src.plugin_runtime import call_hook
                    call_hook(plugin_id, "on_install")
                except Exception:
                    pass

        return {"installed": installed, "failed": failed, "needs_restart": needs_restart}

    def uninstall(self, plugin_id: str) -> bool:
        _ensure_dirs()
        # Trigger backend uninstall hook before removing files
        try:
            from src.plugin_runtime import call_hook
            call_hook(plugin_id, "on_uninstall")
        except Exception:
            pass
        dest = os.path.join(PLUGINS_DIR, plugin_id)
        if os.path.exists(dest):
            shutil.rmtree(dest)
        registry = _load_registry()
        if plugin_id in registry:
            repo_url = registry[plugin_id].get("repo_url", "")
            del registry[plugin_id]
            _save_registry(registry)
            _log_install(repo_url, plugin_id, "uninstall")
            return True
        return False

    def check_updates(self) -> dict[str, str]:
        """Check installed plugins for available updates. Returns {id: remote_version}."""
        registry = _load_registry()
        updates = {}
        for plugin_id, info in registry.items():
            repo_url = info.get("repo_url", "")
            if not repo_url:
                continue
            # Re-discover to get latest manifest versions
            try:
                manifests = self.discover(repo_url)
                for m in manifests:
                    if m.get("id") == plugin_id:
                        remote_ver = m.get("version", "0.0.0")
                        local_ver = info.get("version", "0.0.0")
                        if remote_ver != local_ver:
                            updates[plugin_id] = remote_ver
                        break
            except Exception:
                pass
        return updates

    def serve_path(self, plugin_id: str, file_path: str) -> str | None:
        """Return safe filesystem path for a plugin static file, or None."""
        if "/" in plugin_id or "\\" in plugin_id or ".." in plugin_id:
            return None
        base = os.path.join(PLUGINS_DIR, plugin_id)
        target = os.path.normpath(os.path.join(base, file_path))
        if not target.startswith(os.path.normpath(base)):
            return None
        if os.path.exists(target) and os.path.isfile(target):
            return target
        return None
