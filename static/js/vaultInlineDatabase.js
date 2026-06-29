/**
 * Inline database tables inside vault notes.
 *
 * A markdown table becomes a database when preceded by a hidden marker:
 *   <!-- database: db-abc123 -->
 *   | Name | Status |
 *   | --- | --- |
 *   | [[Business tips]] | Draft |
 *
 * This module parses those markers and renders an interactive table with a
 * hover toolbar. Row/cell data lives in the markdown table; schema and view
 * state are fetched from the backend.
 */

const API_BASE = window.location.origin;

const _svg = (path) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const ICONS = {
  plus: _svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  filter: _svg('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),
  sort: _svg('<path d="M11 5h10"/><path d="M11 9h7"/><path d="M11 13h4"/><path d="M7 17l-4-4"/><path d="M3 17h8"/>'),
  trash: _svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  table: _svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>'),
};

const MARKER_RE = /^\s*<!--\s+database:\s*([a-zA-Z0-9_-]+)\s*-->\s*$/;

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _splitRow(line) {
  const text = line.trim();
  if (!text.includes('|')) return [];
  let t = text;
  if (!t.startsWith('|')) t = '|' + t;
  if (!t.endsWith('|')) t = t + '|';
  return t.slice(1, -1).split('|').map((c) => c.trim());
}

function _isSeparator(line) {
  const t = line.trim();
  if (!t.includes('|')) return false;
  return t.replace(/\|/g, '').replace(/-/g, '').replace(/ /g, '') === '';
}

function _parseTable(lines) {
  const headers = [];
  const rows = [];
  for (const line of lines) {
    const cells = _splitRow(line);
    if (cells.length === 0) continue;
    if (_isSeparator(line)) continue;
    if (headers.length === 0) headers.push(...cells);
    else rows.push(cells);
  }
  return { headers, rows };
}

/**
 * Find all inline database markers in a markdown string.
 * Returns an array of { marker, markerLine, tableStart, tableEnd, headers, rows }.
 */
export function parseInlineDatabases(markdown) {
  const lines = markdown.split('\n');
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MARKER_RE);
    if (!m) continue;
    const marker = m[1];
    let start = i + 1;
    while (start < lines.length && lines[start].trim() === '') start++;
    let end = start;
    while (end < lines.length && lines[end].includes('|')) end++;
    if (end <= start) continue;
    const { headers, rows } = _parseTable(lines.slice(start, end));
    results.push({
      marker,
      markerLine: i,
      tableStart: start,
      tableEnd: end,
      headers,
      rows,
    });
  }
  return results;
}

/**
 * Build a plain HTML table from parsed markdown rows.
 */
export function buildMarkdownTable(headers, rows) {
  const thead = headers.map((h) => `<th>${_esc(h)}</th>`).join('');
  const tbody = rows
    .map((row) => {
      const cells = row
        .map((c, idx) => {
          const padding = idx >= row.length ? '' : _esc(c);
          return `<td>${padding}</td>`;
        })
        .join('');
      // pad missing cells
      let html = cells;
      for (let i = row.length; i < headers.length; i++) html += `<td></td>`;
      return `<tr>${html}</tr>`;
    })
    .join('');
  return `<table class="vault-inline-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
}

/**
 * Render an interactive database table inside a container.
 *
 * db: object from /api/vault/notes/{id}/databases
 * callbacks: { onCellEdit, onAddColumn, onRemoveColumn, onAddRow, onRemoveRow, onDeleteDatabase }
 */
export function renderDatabaseTable(container, db, callbacks = {}) {
  if (!container) return;
  container.className = 'vault-inline-database';
  container.dataset.marker = db.marker;

  const headers = db.headers || [];
  const rows = db.rows || [];
  const schema = db.schema || {};
  const columns = schema.columns || headers.map((h) => ({ name: h, type: 'text' }));
  const filters = schema.filters || [];
  const sort = schema.sort || [];

  let filteredRows = rows.map((r, idx) => ({ cells: r, originalIndex: idx }));
  for (const f of filters) {
    if (!f.column || !f.op || f.value === undefined) continue;
    const colIdx = headers.findIndex((h) => h === f.column);
    if (colIdx < 0) continue;
    const v = String(f.value).toLowerCase();
    filteredRows = filteredRows.filter((r) => {
      const cell = String(r.cells[colIdx] || '').toLowerCase();
      if (f.op === 'contains') return cell.includes(v);
      if (f.op === 'equals') return cell === v;
      if (f.op === 'not') return !cell.includes(v);
      return true;
    });
  }
  for (const s of sort.slice().reverse()) {
    if (!s.column) continue;
    const colIdx = headers.findIndex((h) => h === s.column);
    if (colIdx < 0) continue;
    const dir = s.direction === 'desc' ? -1 : 1;
    filteredRows.sort((a, b) => {
      const av = String(a.cells[colIdx] || '').toLowerCase();
      const bv = String(b.cells[colIdx] || '').toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }

  const table = document.createElement('table');
  table.className = 'vault-inline-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach((col, idx) => {
    const th = document.createElement('th');
    th.textContent = col.name || headers[idx] || '';
    th.title = 'Click header to sort';
    th.addEventListener('click', () => {
      if (callbacks.onSort) callbacks.onSort(col.name, idx);
    });
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  filteredRows.forEach(({ cells, originalIndex }) => {
    const tr = document.createElement('tr');
    tr.dataset.rowIndex = originalIndex;
    columns.forEach((col, idx) => {
      const td = document.createElement('td');
      td.dataset.colIndex = idx;
      const raw = cells[idx] || '';
      // Render wikilinks as clickable links
      td.innerHTML = _renderCellLinks(_esc(raw));
      td.addEventListener('click', () => {
        if (callbacks.onCellEdit) {
          _startCellEdit(td, raw, (value) => callbacks.onCellEdit(originalIndex, idx, value));
        }
      });
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  // Hover toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'vault-inline-db-toolbar';
  toolbar.innerHTML = `
    <button class="vault-inline-db-btn vault-inline-db-add-row" title="Add row">${ICONS.plus}</button>
    <button class="vault-inline-db-btn vault-inline-db-add-col" title="Add column">${ICONS.table}</button>
    <button class="vault-inline-db-btn vault-inline-db-filter" title="Filter">${ICONS.filter}</button>
    <button class="vault-inline-db-btn vault-inline-db-sort" title="Sort">${ICONS.sort}</button>
    <button class="vault-inline-db-btn vault-inline-db-delete" title="Delete database">${ICONS.trash}</button>
  `;
  toolbar.querySelector('.vault-inline-db-add-row').addEventListener('click', () => {
    if (callbacks.onAddRow) callbacks.onAddRow();
  });
  toolbar.querySelector('.vault-inline-db-add-col').addEventListener('click', () => {
    const name = window.prompt('Column name');
    if (name) callbacks.onAddColumn(name);
  });
  toolbar.querySelector('.vault-inline-db-filter').addEventListener('click', () => {
    const col = window.prompt('Filter column name');
    if (!col) return;
    const value = window.prompt('Value to contain');
    if (value === null) return;
    if (callbacks.onFilter) callbacks.onFilter(col, value);
  });
  toolbar.querySelector('.vault-inline-db-sort').addEventListener('click', () => {
    const col = window.prompt('Sort column name');
    if (!col) return;
    const dir = window.prompt('Direction (asc/desc)', 'asc');
    if (callbacks.onSort) callbacks.onSort(col, dir);
  });
  toolbar.querySelector('.vault-inline-db-delete').addEventListener('click', () => {
    if (callbacks.onDeleteDatabase && confirm('Delete this database? The table will remain as plain markdown.')) {
      callbacks.onDeleteDatabase();
    }
  });

  container.innerHTML = '';
  container.appendChild(toolbar);
  container.appendChild(table);
}

function _renderCellLinks(text) {
  return text.replace(/\[\[([^\]]+)\]\]/g, (match, content) => {
    const pipeIdx = content.indexOf('|');
    const target = pipeIdx >= 0 ? content.slice(0, pipeIdx).trim() : content.trim();
    const display = pipeIdx >= 0 ? content.slice(pipeIdx + 1).trim() : target;
    return `<a class="wikilink" href="#" data-note="${_esc(target)}">${_esc(display)}</a>`;
  });
}

function _startCellEdit(td, raw, onDone) {
  if (td.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = raw;
  input.className = 'vault-inline-db-cell-input';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();

  const finish = () => {
    const value = input.value;
    td.innerHTML = _renderCellLinks(_esc(value));
    if (value !== raw) onDone(value);
  };
  input.addEventListener('blur', finish, { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      td.innerHTML = _renderCellLinks(_esc(raw));
    }
  });
}

/**
 * Fetch schema and row data for all databases inside a note.
 */
export async function fetchInlineDatabases(noteId) {
  const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(noteId)}/databases`, {
    credentials: 'same-origin',
  });
  if (!r.ok) return [];
  const data = await r.json();
  return data.databases || [];
}

/**
 * Promote a plain markdown table at the given line into a database.
 */
export async function promoteInlineDatabase(noteId, tableStartLine) {
  const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(noteId)}/databases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ table_start_line: tableStartLine }),
  });
  if (!r.ok) throw new Error('Failed to promote table');
  return r.json();
}

/**
 * Edit a single cell in a database.
 */
export async function editInlineDatabaseCell(dbId, row, col, value) {
  const r = await fetch(`${API_BASE}/api/vault/databases/${encodeURIComponent(dbId)}/cell`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ row, col, value }),
  });
  if (!r.ok) throw new Error('Failed to edit cell');
  return r.json();
}

/**
 * Add a column to a database.
 */
export async function addInlineDatabaseColumn(dbId, name, defaultValue = '') {
  const r = await fetch(`${API_BASE}/api/vault/databases/${encodeURIComponent(dbId)}/column`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ name, default_value: defaultValue }),
  });
  if (!r.ok) throw new Error('Failed to add column');
  return r.json();
}

/**
 * Remove a column from a database.
 */
export async function removeInlineDatabaseColumn(dbId, colIdx) {
  const r = await fetch(`${API_BASE}/api/vault/databases/${encodeURIComponent(dbId)}/columns/${colIdx}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!r.ok) throw new Error('Failed to remove column');
  return r.json();
}

/**
 * Add a row to a database.
 */
export async function addInlineDatabaseRow(dbId, values) {
  const r = await fetch(`${API_BASE}/api/vault/databases/${encodeURIComponent(dbId)}/row`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ values }),
  });
  if (!r.ok) throw new Error('Failed to add row');
  return r.json();
}

/**
 * Remove a row from a database.
 */
export async function removeInlineDatabaseRow(dbId, rowIdx) {
  const r = await fetch(`${API_BASE}/api/vault/databases/${encodeURIComponent(dbId)}/rows/${rowIdx}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!r.ok) throw new Error('Failed to remove row');
  return r.json();
}

/**
 * Update schema/views/filters/sort for a database.
 */
export async function updateInlineDatabaseSchema(dbId, { columns, views, filters, sort }) {
  const body = {};
  if (columns !== undefined) body.columns = columns;
  if (views !== undefined) body.views = views;
  if (filters !== undefined) body.filters = filters;
  if (sort !== undefined) body.sort = sort;
  const r = await fetch(`${API_BASE}/api/vault/databases/${encodeURIComponent(dbId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Failed to update schema');
  return r.json();
}

/**
 * Demote a database back to a plain markdown table.
 */
export async function deleteInlineDatabase(dbId) {
  const r = await fetch(`${API_BASE}/api/vault/databases/${encodeURIComponent(dbId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!r.ok) throw new Error('Failed to delete database');
  return r.json();
}

/**
 * Convert a plain markdown table block into a database by inserting a marker.
 */
export async function convertTableToDatabase(noteId, tableStartLine) {
  return promoteInlineDatabase(noteId, tableStartLine);
}
