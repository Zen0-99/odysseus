"""Run graphify on Odysseus with semantic extraction disabled (code-only)."""
import sys
from pathlib import Path

# Patch graphify to skip semantic extraction before importing its main module
import graphify.__main__ as gm
import inspect

_src = inspect.getsource(gm)
_lines = _src.split('\n')

# Find line 4164 where semantic_files is defined and replace it
for i, line in enumerate(_lines):
    if 'semantic_files = doc_files + paper_files + image_files' in line:
        _lines[i] = '        semantic_files = []  # PATCHED: skip semantic extraction'
        break

# Also patch the needs_llm check to not require a backend for docs
for i, line in enumerate(_lines):
    if 'needs_llm = bool(semantic_files) or dedup_llm' in line:
        _lines[i] = '        needs_llm = dedup_llm  # PATCHED: no LLM needed for docs'
        break

_new_src = '\n'.join(_lines)
exec(compile(_new_src, gm.__file__, 'exec'), gm.__dict__)

# Now run graphify with the same arguments
if __name__ == '__main__':
    sys.argv = ['graphify', '.', '--no-viz'] + sys.argv[1:]
    gm.main()
