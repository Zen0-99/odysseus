import json
import os
import tempfile
from unittest.mock import patch

import pytest

from src.plugin_runtime import (
    PluginContext,
    _load_settings,
    _save_settings,
    call_hook,
    startup_all,
)


class TestPluginContext:
    def test_settings_roundtrip(self, tmp_path):
        with patch("src.plugin_runtime.PLUGINS_DIR", str(tmp_path)):
            _load_settings()
            ctx = PluginContext("test.plugin")
            ctx.set_setting("greeting", "hello")
            _load_settings()
            assert ctx.get_setting("greeting") == "hello"

    def test_manifest(self, tmp_path):
        with patch("src.plugin_runtime.PLUGINS_DIR", str(tmp_path)):
            plugin_dir = tmp_path / "test.plugin"
            plugin_dir.mkdir()
            manifest = {"id": "test.plugin", "name": "Test"}
            with open(plugin_dir / "odysseus-plugin.json", "w") as f:
                json.dump(manifest, f)
            ctx = PluginContext("test.plugin")
            assert ctx.manifest()["id"] == "test.plugin"


class TestCallHook:
    def test_hook_runs_in_subprocess(self, tmp_path):
        with patch("src.plugin_runtime.PLUGINS_DIR", str(tmp_path)):
            plugin_dir = tmp_path / "test.plugin"
            plugin_dir.mkdir()
            backend = plugin_dir / "plugin.py"
            backend.write_text(
                "import odysseus\n"
                "_called = False\n"
                "def on_startup():\n"
                "    global _called\n"
                "    _called = True\n"
                "    odysseus.log('info', 'started')\n"
            )
            manifest = {
                "id": "test.plugin",
                "name": "Test",
                "version": "1.0.0",
                "description": "x",
                "entrypoints": {"backend": "plugin.py", "frontend": "index.js"},
                "file_hashes": {},
            }
            with open(plugin_dir / "odysseus-plugin.json", "w") as f:
                json.dump(manifest, f)

            result = call_hook("test.plugin", "on_startup")
            # on_startup returns None in the plugin code
            assert result is None

    def test_missing_backend_returns_none(self, tmp_path):
        with patch("src.plugin_runtime.PLUGINS_DIR", str(tmp_path)):
            plugin_dir = tmp_path / "test.plugin"
            plugin_dir.mkdir()
            manifest = {
                "id": "test.plugin",
                "name": "Test",
                "version": "1.0.0",
                "description": "x",
                "entrypoints": {"frontend": "index.js"},
            }
            with open(plugin_dir / "odysseus-plugin.json", "w") as f:
                json.dump(manifest, f)
            assert call_hook("test.plugin", "on_startup") is None

    def test_missing_hook_returns_none(self, tmp_path):
        with patch("src.plugin_runtime.PLUGINS_DIR", str(tmp_path)):
            plugin_dir = tmp_path / "test.plugin"
            plugin_dir.mkdir()
            backend = plugin_dir / "plugin.py"
            backend.write_text("# no hooks\n")
            manifest = {
                "id": "test.plugin",
                "name": "Test",
                "version": "1.0.0",
                "description": "x",
                "entrypoints": {"backend": "plugin.py", "frontend": "index.js"},
            }
            with open(plugin_dir / "odysseus-plugin.json", "w") as f:
                json.dump(manifest, f)
            assert call_hook("test.plugin", "on_nonexistent") is None

    def test_backend_exception_returns_none(self, tmp_path):
        with patch("src.plugin_runtime.PLUGINS_DIR", str(tmp_path)):
            plugin_dir = tmp_path / "test.plugin"
            plugin_dir.mkdir()
            backend = plugin_dir / "plugin.py"
            backend.write_text(
                "def on_startup():\n    raise RuntimeError('boom')\n"
            )
            manifest = {
                "id": "test.plugin",
                "name": "Test",
                "version": "1.0.0",
                "description": "x",
                "entrypoints": {"backend": "plugin.py", "frontend": "index.js"},
            }
            with open(plugin_dir / "odysseus-plugin.json", "w") as f:
                json.dump(manifest, f)
            assert call_hook("test.plugin", "on_startup") is None

    def test_hook_with_return_value(self, tmp_path):
        with patch("src.plugin_runtime.PLUGINS_DIR", str(tmp_path)):
            plugin_dir = tmp_path / "test.plugin"
            plugin_dir.mkdir()
            backend = plugin_dir / "plugin.py"
            backend.write_text(
                "def on_install():\n    return {'status': 'ok'}\n"
            )
            manifest = {
                "id": "test.plugin",
                "name": "Test",
                "version": "1.0.0",
                "description": "x",
                "entrypoints": {"backend": "plugin.py", "frontend": "index.js"},
            }
            with open(plugin_dir / "odysseus-plugin.json", "w") as f:
                json.dump(manifest, f)
            result = call_hook("test.plugin", "on_install")
            assert result == {"status": "ok"}
