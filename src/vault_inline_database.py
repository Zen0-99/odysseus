"""Parser and rewriter for inline markdown databases inside vault notes.

A markdown table is promoted to a database by placing a hidden HTML comment
marker above it:

    <!-- database: db-abc123 -->
    | Name | Status |
    | --- | --- |
    | [[Business tips]] | Draft |

The row/cell data stays in the markdown table. Schema, views, filters, and
sort state live in the VaultInlineDatabase DB table keyed by the marker.
"""

from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List, Optional, Tuple

_MARKER_RE = re.compile(r"^\s*<!--\s+database:\s*([a-zA-Z0-9_-]+)\s*-->\s*$")


def _split_lines(content: str) -> List[str]:
    return content.split("\n")


def _join_lines(lines: List[str]) -> str:
    return "\n".join(lines)


def _is_table_line(line: str) -> bool:
    return "|" in line


def _find_table_region(lines: List[str], marker_idx: int) -> Tuple[int, int]:
    """Return (start, end) line indices of the table following a marker.

    start is the first table line, end is one past the last table line.
    """
    i = marker_idx + 1
    n = len(lines)
    # Skip empty lines after marker
    while i < n and lines[i].strip() == "":
        i += 1
    start = i
    while i < n and _is_table_line(lines[i]):
        i += 1
    return start, i


def parse_markers(content: str) -> List[Dict[str, Any]]:
    """Find all database markers and their table regions in markdown content.

    Returns a list of dicts:
      { marker, marker_line, table_start, table_end, headers, rows }
    """
    lines = _split_lines(content)
    results: List[Dict[str, Any]] = []
    for idx, line in enumerate(lines):
        m = _MARKER_RE.match(line)
        if not m:
            continue
        marker = m.group(1)
        start, end = _find_table_region(lines, idx)
        if start >= end:
            continue
        headers, rows = _parse_table(lines[start:end])
        results.append({
            "marker": marker,
            "marker_line": idx,
            "table_start": start,
            "table_end": end,
            "headers": headers,
            "rows": rows,
        })
    return results


def _parse_table(table_lines: List[str]) -> Tuple[List[str], List[List[str]]]:
    """Parse markdown table lines into headers and rows.

    The separator line (containing only - and |) is dropped. All cells are
    stripped of leading/trailing whitespace.
    """
    rows: List[List[str]] = []
    headers: List[str] = []
    for line in table_lines:
        cells = _split_row(line)
        if not cells:
            continue
        if _is_separator(line):
            continue
        if headers:
            rows.append(cells)
        else:
            headers = cells
    return headers, rows


def _is_separator(line: str) -> bool:
    stripped = line.strip()
    if "|" not in stripped:
        return False
    inner = stripped.replace("|", "").replace("-", "").replace(" ", "")
    return inner == ""


def _split_row(line: str) -> List[str]:
    """Split a | a | b | c | row into trimmed cells."""
    text = line.strip()
    if not text.startswith("|"):
        text = "|" + text
    if not text.endswith("|"):
        text = text + "|"
    parts = text[1:-1].split("|")
    return [p.strip() for p in parts]


def _serialize_row(cells: List[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def _serialize_table(headers: List[str], rows: List[List[str]]) -> str:
    separator = "| " + " | ".join(["---"] * len(headers)) + " |"
    lines = [_serialize_row(headers), separator]
    for row in rows:
        # Pad row to match header count to keep table valid
        padded = row + [""] * (len(headers) - len(row))
        padded = padded[: len(headers)]
        lines.append(_serialize_row(padded))
    return "\n".join(lines)


def replace_table(content: str, marker: str, headers: List[str], rows: List[List[str]]) -> str:
    """Replace the table region for the given marker with new headers/rows."""
    lines = _split_lines(content)
    for idx, line in enumerate(lines):
        m = _MARKER_RE.match(line)
        if m and m.group(1) == marker:
            start, end = _find_table_region(lines, idx)
            if start >= end:
                raise ValueError(f"No table found for marker {marker}")
            new_table = _serialize_table(headers, rows)
            new_lines = lines[:start] + new_table.split("\n") + lines[end:]
            return _join_lines(new_lines)
    raise ValueError(f"Marker {marker} not found")


def edit_cell(content: str, marker: str, row_idx: int, col_idx: int, value: str) -> str:
    """Edit a single cell (row_idx, col_idx) in the database table."""
    markers = parse_markers(content)
    db = next((d for d in markers if d["marker"] == marker), None)
    if not db:
        raise ValueError(f"Marker {marker} not found")
    headers = list(db["headers"])
    rows = [list(r) for r in db["rows"]]
    if row_idx < 0 or row_idx >= len(rows):
        raise ValueError(f"Row {row_idx} out of range")
    if col_idx < 0 or col_idx >= len(headers):
        raise ValueError(f"Column {col_idx} out of range")
    # Ensure row has enough cells
    while len(rows[row_idx]) <= col_idx:
        rows[row_idx].append("")
    rows[row_idx][col_idx] = value
    return replace_table(content, marker, headers, rows)


def add_column(content: str, marker: str, column_name: str, default_value: str = "") -> str:
    """Add a new column to the database table."""
    markers = parse_markers(content)
    db = next((d for d in markers if d["marker"] == marker), None)
    if not db:
        raise ValueError(f"Marker {marker} not found")
    headers = list(db["headers"])
    rows = [list(r) for r in db["rows"]]
    headers.append(column_name)
    for row in rows:
        row.append(default_value)
    return replace_table(content, marker, headers, rows)


def remove_column(content: str, marker: str, col_idx: int) -> str:
    """Remove a column from the database table."""
    markers = parse_markers(content)
    db = next((d for d in markers if d["marker"] == marker), None)
    if not db:
        raise ValueError(f"Marker {marker} not found")
    headers = list(db["headers"])
    rows = [list(r) for r in db["rows"]]
    if col_idx < 0 or col_idx >= len(headers):
        raise ValueError(f"Column {col_idx} out of range")
    headers.pop(col_idx)
    for row in rows:
        if col_idx < len(row):
            row.pop(col_idx)
    return replace_table(content, marker, headers, rows)


def add_row(content: str, marker: str, values: Optional[List[str]] = None) -> str:
    """Add a new row to the database table."""
    markers = parse_markers(content)
    db = next((d for d in markers if d["marker"] == marker), None)
    if not db:
        raise ValueError(f"Marker {marker} not found")
    headers = list(db["headers"])
    rows = [list(r) for r in db["rows"]]
    row = list(values) if values else []
    while len(row) < len(headers):
        row.append("")
    row = row[: len(headers)]
    rows.append(row)
    return replace_table(content, marker, headers, rows)


def remove_row(content: str, marker: str, row_idx: int) -> str:
    """Remove a row from the database table."""
    markers = parse_markers(content)
    db = next((d for d in markers if d["marker"] == marker), None)
    if not db:
        raise ValueError(f"Marker {marker} not found")
    headers = list(db["headers"])
    rows = [list(r) for r in db["rows"]]
    if row_idx < 0 or row_idx >= len(rows):
        raise ValueError(f"Row {row_idx} out of range")
    rows.pop(row_idx)
    return replace_table(content, marker, headers, rows)


def promote_table(content: str, table_start_line: int) -> Tuple[str, str]:
    """Promote a regular markdown table at a given line into a database.

    Inserts a marker comment above the table and returns the new content plus
    the generated marker id.
    """
    lines = _split_lines(content)
    if table_start_line < 0 or table_start_line >= len(lines):
        raise ValueError("Invalid table start line")
    # Validate that the target line is a table line
    if not _is_table_line(lines[table_start_line]):
        raise ValueError("Target line is not a table")
    marker = f"db-{uuid.uuid4().hex}"
    # Insert marker right before the table, preserving surrounding context
    insert_idx = table_start_line
    # Add a blank line before marker if the preceding line is not blank
    prefix = []
    if insert_idx > 0 and lines[insert_idx - 1].strip() != "":
        prefix.append("")
    new_lines = (
        lines[:insert_idx]
        + prefix
        + [f"<!-- database: {marker} -->"]
        + lines[insert_idx:]
    )
    return _join_lines(new_lines), marker


def demote_table(content: str, marker: str) -> str:
    """Remove the database marker, leaving the plain markdown table."""
    lines = _split_lines(content)
    for idx, line in enumerate(lines):
        m = _MARKER_RE.match(line)
        if m and m.group(1) == marker:
            # Remove marker line and any immediately preceding blank line we added
            start = idx
            if idx > 0 and lines[idx - 1].strip() == "":
                start = idx - 1
            new_lines = lines[:start] + lines[idx + 1 :]
            return _join_lines(new_lines)
    raise ValueError(f"Marker {marker} not found")


def list_databases(content: str) -> List[Dict[str, Any]]:
    """Return a lightweight summary of every database in the note."""
    return [
        {
            "marker": d["marker"],
            "marker_line": d["marker_line"],
            "table_start": d["table_start"],
            "table_end": d["table_end"],
            "headers": d["headers"],
            "row_count": len(d["rows"]),
        }
        for d in parse_markers(content)
    ]
