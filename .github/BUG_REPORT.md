# Bug Report: Windows Code Runner, Serve Path Quoting, Stale Endpoint Cache

## Prerequisites

- [x] I searched open issues and discussions and did not find an existing report of this bug.
- [x] This is not a security vulnerability.
- [x] I am running the latest code from `dev`.

## Install Method

Windows native (launch-windows.ps1)

## Operating System

Windows 11

## Steps to Reproduce

1. Run Odysseus on Windows with an NVIDIA GPU
2. Open the Cookbook and click "Rescan" to detect hardware
3. Select any GGUF-capable model (e.g. `Qwen/Qwen2.5-3B-Instruct` with a GGUF source) in the Serve panel
4. Click "Launch"
5. Observe the error: `Failed to start: Invalid characters in cmd`

## Expected Behaviour

The serve command should contain a valid Windows path for the `--model` argument (e.g. `C:\Users\...\.cache\huggingface\hub\models--Qwen--Qwen2.5-3B-Instruct-GGUF\snapshots\...`) and llama.cpp should start successfully.

## Actual Behaviour

The serve command contains bash `$(printf %s 'path')` syntax in the `--model` argument, which:
- Is rejected by the backend command validator (`Invalid characters in cmd`)
- Is incompatible with PowerShell on Windows (PowerShell has no `printf`)

Additionally:
- **Code runner:** Multi-line Python scripts passed via `python3 -c` with JSON-escaped newlines cause `SyntaxError: unexpected character after line continuation character`
- **Stale endpoint cache:** After stopping model A on port 8080 and serving model B on the same port, the model picker still shows model A's name because `cached_models` is not cleared when an existing endpoint is updated

## Logs / Screenshots

```
Failed to start: Invalid characters in cmd
```

## Model / Backend

Any GGUF model + llama.cpp on Windows

## Are you willing to submit a fix?

Yes — I have a PR ready: `fix/windows-serve-and-code-runner`

## Additional Information

The `_selectedGgufExpr` function in `static/js/cookbookServe.js` unconditionally returns bash `$(printf %s ...)` syntax even on Windows. It needs a Windows-aware branch that returns plain paths like `C:\Users\...` when `_isWindows()` is true. The same applies to `_ggufSearchDirExpr` and the `_mmproj_path` fallback.

The code runner in `static/js/codeRunner.js` passes the script as a JSON string literal to `python3 -c`, which converts real newlines into `\n` escape sequences that Python reads as backslash-n characters.

The `_auto_register_llm_endpoint` function in `routes/cookbook_routes.py` updates `is_enabled`, `model_type`, and `name` when re-registering an existing endpoint, but does not clear `cached_models` and `hidden_models`, causing the UI to show stale model names.
