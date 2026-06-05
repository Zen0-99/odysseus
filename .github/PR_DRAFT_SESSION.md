# Draft: Session PRs — Bug Fixes + Small Feature

These are the changes from the coding session (on top of the already-rebased `fix/windows-cookbook-gguf-only` branch).

The working tree changes have been committed to branch `fix/windows-serve-and-code-runner`.

Because the changes span bug fixes and one small feature, they are documented below as **two separate PRs** so you can cherry-pick / open them individually if preferred.

---

## PR 1 — Bug Fixes: Code Runner, Windows Serve, Endpoint Cache

**Branch:** `fix/windows-serve-and-code-runner`

```bash
git push origin fix/windows-serve-and-code-runner
```

**Base branch:** `dev`
**Compare URL:** https://github.com/pewdiepie-archdaemon/odysseus/compare/dev...fix/windows-serve-and-code-runner

**Title:** `fix(code-runner, serve, endpoints): base64 encoding, Windows path quoting, stale cache cleanup`

**Body:**

```markdown
## Summary

Fixes four Windows/user-facing bugs discovered during interactive use:

1. **Code runner `SyntaxError` on multi-line Python** — `codeRunner.js` was passing AI-generated Python scripts via `python3 -c` with `JSON.stringify(code)`, which turns real newlines into `\n` escape sequences that Python interprets as backslash-n characters. Fixed by base64-encoding the script before transmission and decoding it server-side.

2. **"Invalid characters in cmd" when serving GGUF models on Windows** — `_selectedGgufExpr` in `cookbookServe.js` emitted bash `$(printf %s 'path')` syntax for the `--model` argument even on Windows. The backend validator rejects `$()` in non-prelude commands, and PowerShell doesn't have `printf`. Fixed by returning plain Windows paths (`C:\Users\...`) when `_isWindows()` is true.

3. **Stale endpoint model list after re-serving on the same port** — When a new model is served on a port previously used by another model (e.g. stop qwen, start gemma on `:8080`), `_auto_register_llm_endpoint` reuses the existing endpoint record but preserves the old `cached_models` list, causing the model picker/settings to keep showing the old model name. Fixed by wiping `cached_models` and `hidden_models` when updating an existing endpoint.

4. **Copy-log buttons fail silently when no log content exists** — Added guards in `cookbookRunning.js` to show a toast instead of copying empty strings.

Also includes a small reliability fix:
- `cookbook-hwfit.js` propagates the detected `platform` from the hardware scan into `_envState.platform` so Windows detection works correctly for local tasks.

## Target branch

- [x] This PR targets **`dev`**, not `main`.

## Linked Issue

    Fixes #2631

## How to Test

1. **Code runner base64 fix**
   - Open the code-runner panel, ask an AI to generate a multi-line Python script (e.g. a calculator with `def add(a,b):`)
   - Click "Run"
   - Before: `SyntaxError: unexpected character after line continuation character`
   - After: script executes correctly (decoded from base64 server-side)

2. **Windows serve path fix**
   - On Windows, go to Cookbook → Serve, select a GGUF model
   - Click "Launch"
   - Before: `Failed to start: Invalid characters in cmd` (because `--model` contained bash `$(printf ...)` syntax)
   - After: serve command uses a plain Windows path (`C:\Users\...`) and launches successfully

3. **Stale endpoint cache fix**
   - Serve model A on port 8080, then stop it
   - Serve model B on the same port 8080
   - Open the model picker / endpoint settings
   - Before: still shows model A's name
   - After: shows model B's name (endpoint cache was wiped on re-registration)

4. **Copy-log guards**
   - Start a serve task, immediately click "Copy last 50 lines" before any output appears
   - Before: copies empty string, no feedback
   - After: toast says "No log content available yet"

## Type of Change

- [x] Bug fix (non-breaking — fixes confirmed issues)

## Checklist

- [x] I searched open issues and open PRs — this is not a duplicate.
- [x] My changes are limited to the scope described above.

## Files changed

- `static/js/codeRunner.js` — base64 encode Python/bash scripts for `runServer`
- `static/js/cookbookServe.js` — Windows-aware path generation in `_selectedGgufExpr`, `_ggufSearchDirExpr`, and `_mmproj_path`
- `routes/cookbook_routes.py` — wipe `cached_models`/`hidden_models` in `_auto_register_llm_endpoint`
- `static/js/cookbookRunning.js` — copy-log guards
- `static/js/cookbook-hwfit.js` — propagate `platform` from hardware scan
```

---

## PR 2 — Feature: Remove-from-Recent in Model Picker

**Branch:** `fix/windows-serve-and-code-runner` *(same branch — can be cherry-picked into a separate branch if desired)*

If you want it on its own branch:

```bash
git checkout -b feature/model-picker-remove-recent
git checkout fix/windows-serve-and-code-runner -- static/js/modelPicker.js static/style.css
git commit -m "feat(model-picker): add remove-from-recent button"
git push origin feature/model-picker-remove-recent
```

**Base branch:** `dev`
**Compare URL:** https://github.com/pewdiepie-archdaemon/odysseus/compare/dev...feature/model-picker-remove-recent

**Title:** `feat(model-picker): add × button to remove models from Recent list`

**Body:**

```markdown
## Summary

Adds a small "×" remove button next to each model in the model picker's **Recent** section. Clicking it removes the model ID from `localStorage` under `odysseus-model-recent` and re-renders the picker.

This addresses the common case where a model (e.g. a stale local endpoint) keeps reappearing in Recent despite no longer being available.

## Target branch

- [x] This PR targets **`dev`**, not `main`.

## Type of Change

- [x] New feature (non-breaking — adds new behaviour)

## Visual / UI changes

- A 24×24 "×" button appears on hover/focus of Recent rows.
- Uses existing CSS variables (`--fg`, `--red`) and transitions.
- No new component patterns — extends the existing `_addRow` helper.

## Files changed

- `static/js/modelPicker.js` — `_removeRecent()` helper, `onRemove` callback in `_addRow`, wired in `_populate()`
- `static/style.css` — `.mp-remove-dot` button styles
```

---

## Note on separation

The session commit (`a647183`) contains **both** bug fixes and the feature in one commit because they were made interactively in the same working tree. To open as two separate PRs, cherry-pick the file subsets as shown above, or open one PR and include the feature as a second commit.
