import json
import os
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest

from src.plugin_manager import (
    PluginManager,
    _detect_tags,
    _hash_file,
    _to_raw_url,
    _validate_manifest,
    _verify_file_hashes,
)


class TestValidateManifest:
    def test_missing_required_fields(self):
        ok, err = _validate_manifest({})
        assert not ok
        assert "Missing required fields" in err

    def test_valid_manifest(self):
        ok, err = _validate_manifest({
            "id": "test.plugin",
            "name": "Test",
            "version": "1.0.0",
            "description": "A test plugin",
            "entrypoints": {"frontend": "index.js"},
            "file_hashes": {"index.js": "abc123"},
        })
        assert ok
        assert err == ""

    def test_invalid_plugin_id(self):
        ok, err = _validate_manifest({
            "id": "../evil",
            "name": "Evil",
            "version": "1.0.0",
            "description": "x",
            "entrypoints": {"frontend": "index.js"},
            "file_hashes": {"index.js": "abc123"},
        })
        assert not ok
        assert "Invalid plugin id" in err

    def test_invalid_frontend_entrypoint(self):
        ok, err = _validate_manifest({
            "id": "test.plugin",
            "name": "Test",
            "version": "1.0.0",
            "description": "x",
            "entrypoints": {"frontend": "../../etc/passwd"},
            "file_hashes": {"../../etc/passwd": "abc123"},
        })
        assert not ok
        assert "Invalid frontend entrypoint" in err

    def test_missing_file_hashes(self):
        ok, err = _validate_manifest({
            "id": "test.plugin",
            "name": "Test",
            "version": "1.0.0",
            "description": "x",
            "entrypoints": {"frontend": "index.js"},
        })
        assert not ok
        assert "file_hashes" in err

    def test_file_hashes_traversal(self):
        ok, err = _validate_manifest({
            "id": "test.plugin",
            "name": "Test",
            "version": "1.0.0",
            "description": "x",
            "entrypoints": {"frontend": "index.js"},
            "file_hashes": {"../secret.txt": "abc123"},
        })
        assert not ok
        assert "Invalid file_hashes key" in err


class TestVerifyFileHashes:
    def test_all_match(self, tmp_path):
        (tmp_path / "a.txt").write_text("hello")
        manifest = {"file_hashes": {"a.txt": _hash_file(str(tmp_path / "a.txt"))}}
        ok, err = _verify_file_hashes(str(tmp_path), manifest)
        assert ok
        assert err == ""

    def test_mismatch(self, tmp_path):
        (tmp_path / "a.txt").write_text("hello")
        manifest = {"file_hashes": {"a.txt": "0000000000000000000000000000000000000000000000000000000000000000"}}
        ok, err = _verify_file_hashes(str(tmp_path), manifest)
        assert not ok
        assert "Hash mismatch" in err

    def test_missing_file(self, tmp_path):
        manifest = {"file_hashes": {"a.txt": "abc123"}}
        ok, err = _verify_file_hashes(str(tmp_path), manifest)
        assert not ok
        assert "Missing file" in err

    def test_sha256_prefix(self, tmp_path):
        (tmp_path / "a.txt").write_text("hello")
        h = _hash_file(str(tmp_path / "a.txt"))
        manifest = {"file_hashes": {"a.txt": f"sha256:{h}"}}
        ok, err = _verify_file_hashes(str(tmp_path), manifest)
        assert ok


class TestDetectTags:
    def test_frontend_from_entrypoint(self):
        tags = _detect_tags({"entrypoints": {"frontend": "index.js"}})
        assert "Frontend" in tags

    def test_backend_from_entrypoint(self):
        tags = _detect_tags({"entrypoints": {"backend": "plugin.py"}})
        assert "Backend" in tags

    def test_panels(self):
        tags = _detect_tags({"panels": [{"id": "p", "label": "P"}]})
        assert "Panels" in tags

    def test_permissions(self):
        tags = _detect_tags({"permissions": ["storage", "network"]})
        assert "Storage" in tags
        assert "Network" in tags


class TestServePath:
    def test_valid_file(self, tmp_path):
        with patch("src.plugin_manager.PLUGINS_DIR", str(tmp_path)):
            pm = PluginManager()
            plugin_dir = tmp_path / "test.plugin"
            plugin_dir.mkdir()
            (plugin_dir / "index.js").write_text("//")
            result = pm.serve_path("test.plugin", "index.js")
            assert result == str(plugin_dir / "index.js")

    def test_traversal_blocked(self, tmp_path):
        with patch("src.plugin_manager.PLUGINS_DIR", str(tmp_path)):
            pm = PluginManager()
            result = pm.serve_path("test.plugin", "../secret.txt")
            assert result is None

    def test_absolute_blocked(self, tmp_path):
        with patch("src.plugin_manager.PLUGINS_DIR", str(tmp_path)):
            pm = PluginManager()
            result = pm.serve_path("test.plugin", "/etc/passwd")
            assert result is None


class TestInstallUninstall:
    @patch("src.plugin_manager.httpx.get")
    def test_install_verify_hashes_and_uninstall(self, mock_get, tmp_path):
        with patch("src.plugin_manager.PLUGINS_DIR", str(tmp_path)):
            # Build a fake repo ZIP
            repo_dir = tmp_path / "repo"
            repo_dir.mkdir()
            plugin_dir = repo_dir / "hello-plugin"
            plugin_dir.mkdir()
            manifest = {
                "id": "hello.plugin",
                "name": "Hello",
                "version": "1.0.0",
                "description": "A hello plugin",
                "entrypoints": {"frontend": "index.js"},
                "file_hashes": {},
            }
            (plugin_dir / "index.js").write_text("console.log('hi')")
            manifest["file_hashes"]["index.js"] = _hash_file(str(plugin_dir / "index.js"))
            with open(plugin_dir / "odysseus-plugin.json", "w") as f:
                json.dump(manifest, f)
            with open(repo_dir / "plugins.json", "w") as f:
                json.dump({"plugins": ["hello-plugin"]}, f)

            # Create ZIP
            zip_path = tmp_path / "repo.zip"
            with zipfile.ZipFile(zip_path, "w") as z:
                for root, _dirs, files in os.walk(repo_dir):
                    for file in files:
                        full = Path(root) / file
                        arc = os.path.relpath(str(full), str(repo_dir))
                        z.write(str(full), f"repo-main/{arc}")

            mock_get.return_value.status_code = 200
            mock_get.return_value.content = zip_path.read_bytes()
            mock_get.return_value.raise_for_status = lambda: None

            pm = PluginManager()
            result = pm.install("https://github.com/user/repo", ["hello.plugin"])
            assert result["installed"] == ["hello.plugin"]
            assert not result["failed"]
            assert pm.is_installed("hello.plugin")

            # verify_hashes should report ok
            hashes = pm.verify_hashes()
            assert hashes["hello.plugin"]["ok"] is True

            assert pm.uninstall("hello.plugin")
            assert not pm.is_installed("hello.plugin")


class TestToRawUrl:
    def test_github(self):
        assert _to_raw_url("https://github.com/owner/repo", "file.txt") == (
            "https://raw.githubusercontent.com/owner/repo/main/file.txt"
        )

    def test_gitlab(self):
        assert _to_raw_url("https://gitlab.com/owner/repo", "file.txt") == (
            "https://gitlab.com/owner/repo/-/raw/main/file.txt"
        )

    def test_unknown_host(self):
        assert _to_raw_url("https://example.com/repo", "file.txt") is None
