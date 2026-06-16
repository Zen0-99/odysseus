"""Plugin runtime API for backend Python hooks.

Provides a controlled `odysseus` module that installed plugins can import
to interact with the host application safely.
"""

import importlib.util
import json
import logging
import os
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


def call_hook(plugin_id: str, hook_name: str, *args, **kwargs) -> Any:
    """Call a named hook on a plugin's backend module in-process."""
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
    entry_path = os.path.join(plugin_dir, be)
    if not os.path.isfile(entry_path):
        logger.warning("Backend entrypoint not found: %s", entry_path)
        return None
    spec = importlib.util.spec_from_file_location(f"_plugin_{plugin_id}", entry_path)
    if not spec or not spec.loader:
        logger.warning("Failed to create module spec for %s", plugin_id)
        return None
    # Inject the odysseus module before loading the plugin
    sys.modules["odysseus"] = _make_module(plugin_id)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:
        logger.warning("Failed to load plugin %s: %s", plugin_id, e)
        return None
    fn = getattr(mod, hook_name, None)
    if not callable(fn):
        return None
    try:
        return fn(*args, **kwargs)
    except Exception as e:
        logger.warning("Hook %s failed in plugin %s: %s", hook_name, plugin_id, e)
        return None


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


