## Summary

Fixes Windows test failures (hardcoded `/tmp` paths, bash availability, mocked `HTTPException`), an inter-test module reference staleness bug in `test_llm_core_list_model_ids_uses_cached_configured_proxy`, and a Windows llama.cpp serve bug where the post-build `ln -s` step fails because the binary is in a `Debug/` subdirectory and symlinks require admin privileges on Windows. The serve bootstrap now uses `find` to locate the built binary regardless of CMake generator and copies it on Windows instead of symlinking.

## Target branch

- [x] This PR targets **`dev`**, not `main`. All PRs land in `dev`; `main` is curated by the maintainer at each release. If your PR is on `main` by accident, click "Edit" on this PR and change the base.

## Linked Issue

Fixes #2662

## Type of Change

- [x] Bug fix (non-breaking — fixes a confirmed issue)
- [ ] New feature (non-breaking — adds new behaviour)
- [ ] Breaking change (changes or removes existing behaviour)
- [ ] Refactor / cleanup (behaviour unchanged)
- [ ] Documentation only
- [ ] CI / tooling / configuration

## Checklist

- [x] I searched [open issues](https://github.com/pewdiepie-archdaemon/odysseus/issues) and [open PRs](https://github.com/pewdiepie-archdaemon/odysseus/pulls) — this is not a duplicate.
- [x] This PR targets `dev`
- [x] My changes are limited to the scope described above — no unrelated refactors or whitespace changes mixed in.
- [x] I actually ran the app (`docker compose up` or `uvicorn app:app`) and verified the change works end-to-end. Type-checks and unit tests are not enough.

## How to Test

1. Run the fixed tests on Windows:
   ```bash
   python -m pytest tests/test_edit_file.py tests/test_cookbook_helpers.py \
     tests/test_model_routes.py::test_llm_core_list_model_ids_uses_cached_configured_proxy \
     tests/test_webhook_ssrf_resilience.py::test_webhook_delivery_uses_naive_utc_timestamps \
     tests/test_archived_sessions_model_filter.py -q
   ```
   Expected: `50 passed, 6 skipped` (6 skipped are bash-dependent tests on Windows).

2. Verify llama.cpp serve works on Windows:
   - Open Cookbook → Serve tab.
   - Select a GGUF model (e.g., `LFM2-8B-A1B-GGUF`).
   - Click Serve.
   - The build should complete and the serve should start without the `ln: failed to create symbolic link` error.

## Visual / UI changes — REQUIRED if you touched anything that renders

This PR contains no UI/visual changes (backend and test fixes only).
