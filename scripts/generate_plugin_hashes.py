#!/usr/bin/env python3
"""CLI tool to compute SHA-256 hashes for plugin files and inject them into the manifest.

Usage:
    python scripts/generate_plugin_hashes.py <plugin-folder>

Example:
    python scripts/generate_plugin_hashes.py hello-odysseus
"""
import hashlib
import json
import os
import sys


def _hash_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def generate_hashes(plugin_dir: str):
    manifest_path = os.path.join(plugin_dir, "odysseus-plugin.json")
    if not os.path.isfile(manifest_path):
        print(f"Manifest not found: {manifest_path}")
        sys.exit(1)

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    file_hashes: dict[str, str] = {}
    for root, _dirs, files in os.walk(plugin_dir):
        for filename in files:
            if filename == "odysseus-plugin.json":
                continue
            full_path = os.path.join(root, filename)
            rel_path = os.path.relpath(full_path, plugin_dir).replace("\\", "/")
            file_hashes[rel_path] = _hash_file(full_path)

    manifest["file_hashes"] = file_hashes

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(f"Updated {manifest_path} with {len(file_hashes)} file hash(es).")


def validate_manifest(plugin_dir: str) -> bool:
    manifest_path = os.path.join(plugin_dir, "odysseus-plugin.json")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    required = {"id", "name", "version", "description", "entrypoints", "file_hashes"}
    missing = required - set(manifest.keys())
    if missing:
        print(f"Missing required fields: {', '.join(missing)}")
        return False

    file_hashes = manifest.get("file_hashes", {})
    if not isinstance(file_hashes, dict) or not file_hashes:
        print("file_hashes must be a non-empty dict")
        return False

    for fname in file_hashes:
        if ".." in fname or fname.startswith("/") or "\\" in fname:
            print(f"Invalid file_hashes key: {fname}")
            return False
        fp = os.path.join(plugin_dir, fname)
        if not os.path.isfile(fp):
            print(f"Missing file referenced in file_hashes: {fname}")
            return False
        expected = str(file_hashes[fname])
        if expected.startswith("sha256:"):
            expected = expected[7:]
        actual = _hash_file(fp)
        if actual != expected.lower():
            print(f"Hash mismatch for {fname}")
            return False

    print("Manifest validation passed.")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python generate_plugin_hashes.py <plugin-folder>")
        sys.exit(1)

    target_dir = sys.argv[1]
    if not os.path.isdir(target_dir):
        print(f"Not a directory: {target_dir}")
        sys.exit(1)

    generate_hashes(target_dir)
    validate_manifest(target_dir)
