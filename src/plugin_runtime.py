"""Plugin runtime API for backend Python hooks.

Provides a controlled `odysseus` module that installed plugins can import
to interact with the host application safely.
"""

import importlib.util
import json
import logging
import os
import subprocess
import sys
import types
from typing import Any

from src.constants import DATA_DIR

PLUGINS_DIR = os.path.join(DATA_DIR, "plugins")

logger = logging.getLogger(__name__)

# Scoped plugin storage (in-memory + persisted JSON file)
_plugin_settings: dict[str, dict[str, Any]] = {}


def _plugin_settings_path() -> str:
    return os.path.join(PLUGINS_DIR, "plugin_settings.json")


def _load_settings():
    global _plugin_settings
    try:
        with open(_plugin_settings_path(), "r", encoding="utf-8") as f:
            _plugin_settings = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        _plugin_settings = {}


def _save_settings():
    try:
        with open(_plugin_settings_path(), "w", encoding="utf-8") as f:
            json.dump(_plugin_settings, f, indent=2)
    except Exception as e:
        logger.warning("Failed to save plugin settings: %s", e)


class PluginContext:
    """Runtime context exposed to a backend plugin."""

    def __init__(self, plugin_id: str):
        self.plugin_id = plugin_id

    def get_setting(self, key: str) -> Any | None:
        _load_settings()
        return _plugin_settings.get(self.plugin_id, {}).get(key)

    def set_setting(self, key: str, value: Any):
        _load_settings()
        if self.plugin_id not in _plugin_settings:
            _plugin_settings[self.plugin_id] = {}
        _plugin_settings[self.plugin_id][key] = value
        _save_settings()

    def log(self, level: str, message: str):
        lvl = getattr(logging, level.upper(), logging.INFO)
        logger.log(lvl, "[%s] %s", self.plugin_id, message)

    def manifest(self) -> dict:
        """Return the plugin's manifest as a dict."""
        manifest_path = os.path.join(PLUGINS_DIR, self.plugin_id, "odysseus-plugin.json")
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}


def _make_module(plugin_id: str) -> Any:
    """Return a fake 'odysseus' module for the given plugin id."""
    ctx = PluginContext(plugin_id)
    mod = type(sys)("odysseus")
    mod.get_setting = ctx.get_setting
    mod.set_setting = ctx.set_setting
    mod.log = ctx.log
    mod.manifest = ctx.manifest
    return mod


def _run_sandbox(plugin_dir: str, entrypoint: str, hook_name: str) -> Any | None:
    """Run a plugin hook in an isolated subprocess with restricted sys.path."""
    python = sys.executable
    cmd = [
        python, "-m", "src.plugin_runtime",
        "--sandbox", plugin_dir, entrypoint, hook_name,
    ]
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)}
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30.0,
            env=env,
        )
        if result.returncode != 0:
            logger.warning(
                "Sandbox %s/%s failed (rc=%d): %s",
                entrypoint, hook_name, result.returncode, result.stderr,
            )
            return None
        if not result.stdout.strip():
            return None
        data = json.loads(result.stdout.strip().splitlines()[-1])
        if data.get("status") == "ok":
            return data.get("result")
        elif data.get("status") == "error":
            logger.warning("Hook %s error: %s", hook_name, data.get("message"))
            return None
    except Exception as e:
        logger.warning("Failed to run sandbox for %s: %s", hook_name, e)
        return None


def call_hook(plugin_id: str, hook_name: str, *args, **kwargs) -> Any:
    """Call a named hook on a plugin's backend module via an isolated subprocess."""
    plugin_dir = os.path.join(PLUGINS_DIR, plugin_id)
    manifest_path = os.path.join(plugin_dir, "odysseus-plugin.json")
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except Exception:
        return None
    be = manifest.get("entrypoints", {}).get("backend", "")
    if not be:
        return None
    return _run_sandbox(plugin_dir, be, hook_name)


def _load_registry() -> dict:
    registry_path = os.path.join(PLUGINS_DIR, "registry.json")
    try:
        with open(registry_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def startup_all():
    """Call on_startup() for every installed plugin that has a backend entrypoint."""
    registry = _load_registry()
    for plugin_id in registry:
        call_hook(plugin_id, "on_startup")


def shutdown_all():
    """Call on_shutdown() for every installed plugin that has a backend entrypoint."""
    registry = _load_registry()
    for plugin_id in registry:
        call_hook(plugin_id, "on_shutdown")


# ---------------------------------------------------------------------------
# Subprocess sandbox entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse

    _parser = argparse.ArgumentParser()
    _parser.add_argument("--sandbox", required=True)
    _parser.add_argument("entrypoint")
    _parser.add_argument("hook_name")
    _parsed = _parser.parse_args()

    _plugin_dir = _parsed.sandbox
    _entrypoint = _parsed.entrypoint
    _hook_name = _parsed.hook_name

    # Restrict sys.path to plugin dir + stdlib
    _stdlib = os.path.dirname(os.__file__)
    sys.path = [_plugin_dir, _stdlib]

    _settings_file = os.path.join(os.path.dirname(_plugin_dir), "plugin_settings.json")

    def _sb_get_setting(key: str) -> Any | None:
        try:
            with open(_settings_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            data = {}
        return data.get(os.path.basename(_plugin_dir), {}).get(key)

    def _sb_set_setting(key: str, value: Any):
        try:
            with open(_settings_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            data = {}
        pid = os.path.basename(_plugin_dir)
        if pid not in data:
            data[pid] = {}
        data[pid][key] = value
        with open(_settings_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    def _sb_log(level: str, message: str):
        print(
            f"[odysseus:{os.path.basename(_plugin_dir)}] {level.upper()}: {message}",
            file=sys.stderr,
        )

    def _sb_manifest() -> dict:
        mp = os.path.join(_plugin_dir, "odysseus-plugin.json")
        try:
            with open(mp, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    _odysseus_mod = types.ModuleType("odysseus")
    _odysseus_mod.get_setting = _sb_get_setting
    _odysseus_mod.set_setting = _sb_set_setting
    _odysseus_mod.log = _sb_log
    _odysseus_mod.manifest = _sb_manifest
    sys.modules["odysseus"] = _odysseus_mod

    _path = os.path.join(_plugin_dir, _entrypoint)
    if not os.path.isfile(_path):
        print(json.dumps({"status": "error", "message": f"Entrypoint not found: {_entrypoint}"}))
        sys.exit(1)

    _spec = importlib.util.spec_from_file_location("_plugin_backend", _path)
    if not _spec or not _spec.loader:
        print(json.dumps({"status": "error", "message": "Failed to create module spec"}))
        sys.exit(1)

    _mod = importlib.util.module_from_spec(_spec)
    try:
        _spec.loader.exec_module(_mod)
    except Exception as _exc:
        print(json.dumps({"status": "error", "message": f"Failed to load module: {_exc}"}))
        sys.exit(1)

    _fn = getattr(_mod, _hook_name, None)
    if not callable(_fn):
        print(json.dumps({"status": "error", "message": f"Hook {_hook_name} not found"}))
        sys.exit(1)

    try:
        _hook_result = _fn()
        try:
            _serialized = json.dumps({"status": "ok", "result": _hook_result})
        except (TypeError, ValueError):
            _serialized = json.dumps({"status": "ok", "result": None})
        print(_serialized)
    except Exception as _exc:
        print(json.dumps({"status": "error", "message": str(_exc)}))
        sys.exit(1)
