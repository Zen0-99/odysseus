## Bug Report: Windows test failures + llama.cpp serve post-build symlink failure

### Describe the bug

Multiple upstream tests fail on Windows due to cross-platform assumptions (`/tmp` paths, bash availability, mocked `HTTPException`). Additionally, when serving a GGUF model with llama.cpp on Windows, the Visual Studio build succeeds but the post-build `ln -s` step fails because:
1. The binary is at `~/llama.cpp/build/bin/Debug/llama-server.exe`, not `~/llama.cpp/build/bin/llama-server`.
2. `ln -s` requires admin privileges on Windows and silently fails in Git Bash.

This causes the serve bootstrap to think the build failed, fall back to Python bindings, and ultimately error out with "llama.cpp serving is not available."

### Actual behavior

**Tests:**
- `test_edit_file.py` → `FileNotFoundError` on all tests because `/tmp/ef_block.txt` does not exist on Windows.
- `test_cookbook_helpers.py` → `FileNotFoundError: [WinError 2] bash not found` on 6 tests that shell out to bash; `TypeError: Expected a BaseException type, but got 'MagicMock'` on 4 tests that call `pytest.raises(HTTPException)` when FastAPI is not installed.
- `test_llm_core_list_model_ids_uses_cached_configured_proxy` → Returns `[]` instead of `['cached-model']` when run after `test_webhook_ssrf_resilience.py` because the monkeypatch targets a stale `src.database` module reference.
- `test_webhook_delivery_uses_naive_utc_timestamps` and `test_archived_sessions_model_filter` → `ModuleNotFoundError: No module named 'sqlalchemy.pool'` when `sqlalchemy`/`python-multipart` are not installed (environment issue, not a code bug).

**Serve (Windows, any GGUF model e.g. `LFM2-8B-A1B-GGUF`):**
1. Cookbook generates a bash bootstrap script and launches it.
2. `cmake --build` succeeds. Visual Studio places `llama-server.exe` under `~/llama.cpp/build/bin/Debug/llama-server.exe`.
3. The script then runs `ln -sf ~/llama.cpp/build/bin/llama-server ~/bin/llama-server`.
4. `ln` fails with `No such file or directory` (the binary is in `Debug/` and has `.exe`; also `ln -s` requires admin privileges on Windows).
5. The failure cascades: the bootstrap interprets this as "build failed" and attempts to install `llama-cpp-python[server]` as a fallback.
6. If the Python bindings are not available or the install fails, the serve exits with code 127 and the UI shows:  
   *"llama.cpp build stopped before the server became reachable."*

### To Reproduce

**Tests:**
```bash
python -m pytest tests/test_edit_file.py tests/test_cookbook_helpers.py \
  tests/test_model_routes.py::test_llm_core_list_model_ids_uses_cached_configured_proxy \
  tests/test_webhook_ssrf_resilience.py::test_webhook_delivery_uses_naive_utc_timestamps \
  tests/test_archived_sessions_model_filter.py
```

**Serve (Windows):**
1. Open Cookbook → Serve tab.
2. Select a GGUF model (e.g., `LFM2-8B-A1B-GGUF`).
3. Click Serve.
4. Observe: llama.cpp clones and builds successfully via Visual Studio.
5. Observe: `ln: failed to create symbolic link ... No such file or directory`.
6. Serve aborts and tries Python bindings fallback.

### Expected behavior

- Tests should skip or adapt when running on Windows without bash/fastapi.
- After a successful llama.cpp build on Windows, the binary should be copied (not symlinked) to `~/bin/llama-server.exe` and the serve should continue.

### Environment

- OS: Windows 10/11
- Shell: Git Bash (MSYS2)
- CMake generator: Visual Studio (multi-config)

### Screenshots / Logs

```
llama-server.vcxproj -> C:\Users\karol\llama.cpp\build\bin\Debug\llama-server.exe
ln: failed to create symbolic link '/c/Users/karol/bin/llama-server': No such file or directory
llama-server build failed — installing Python bindings as fallback...
ERROR: llama.cpp serving is not available after install/build attempts.
```

### Root cause analysis

1. `tests/test_edit_file.py` uses `/tmp/ef_block.txt` — `FileNotFoundError` on Windows.
2. `src/tool_execution.py::_tool_path_roots()` only includes `/tmp`, not Windows temp.
3. `tests/test_cookbook_helpers.py` runs `bash -c` unconditionally.
4. `tests/test_model_routes.py` monkeypatches `src_database.ModelEndpoint` but the module-level `import src.database as src_database` points to a stale object after webhook tests delete `sys.modules["src.database"]`.
5. `routes/cookbook_helpers.py` and `routes/cookbook_routes.py` hardcode `ln -sf ~/llama.cpp/build/bin/llama-server ~/bin/llama-server` which is wrong for Windows Visual Studio builds.

### Proposed fix

See PR `fix/windows-llama-cpp-serve-and-test-upstream`.
