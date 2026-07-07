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

import { styledConfirm, styledPrompt } from './ui.js';

const API_BASE = window.location.origin;

const _svg = (path) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const ICONS = {
  plus: _svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  filter: _svg('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),
  sort: _svg('<path d="M11 5h10"/><path d="M11 9h7"/><path d="M11 13h4"/><path d="M7 17l-4-4"/><path d="M3 17h8"/>'),
  trash: _svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  table: _svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>'),
  dots: _svg('<circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/>'),
  eye: _svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: _svg('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.88 9.88 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-3.73 3.73L3 3"/><path d="M1 1l22 22"/>'),
  drag: _svg('<line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/>'),
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
function _reconstructRaw(db) {
  const lines = [`<!-- database: ${db.marker} -->`];
  const headers = db.headers || [];
  const rows = db.rows || [];
  if (headers.length) {
    lines.push('| ' + headers.join(' | ') + ' |');
    lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
    for (const row of rows) {
      lines.push('| ' + row.map((c) => (c == null ? '' : String(c))).join(' | ') + ' |');
    }
  }
  return lines.join('\n');
}

export function renderDatabaseTable(container, db, callbacks = {}) {
  if (!container) return;
  container.className = 'vault-inline-database';
  container.dataset.marker = db.marker;
  container.dataset.raw = _reconstructRaw(db);

  const schema = db.schema || {};
  // Prefer schema data (DB source of truth) over markdown-parsed data
  const columns = schema.columns || db.headers?.map((h) => ({ name: h, type: 'text', visible: true })) || [];
  const headers = columns.map((c) => c.name);
  const rows = (schema.rows && schema.rows.length >= 0) ? schema.rows : (db.rows || []);
  const filters = schema.filters || [];
  const sort = schema.sort || [];

  // Determine visible columns
  const visibleColumns = columns.map((col, idx) => ({ ...col, idx })).filter((col) => col.visible !== false);
  const visibleIndices = new Set(visibleColumns.map((c) => c.idx));

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

  visibleColumns.forEach((col) => {
    const th = document.createElement('th');
    if (col.width) {
      th.style.width = col.width + 'px';
      th.style.minWidth = col.width + 'px';
    }
    th.innerHTML = `<span class="vault-db-header-label">${_esc(col.name || headers[col.idx] || '')}</span>`;
    th.querySelector('.vault-db-header-label').addEventListener('click', () => {
      if (callbacks.onSort) callbacks.onSort(col.name, col.idx);
    });

    // Resize handle
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = th.offsetWidth;

      const onMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        const newWidth = Math.max(60, startWidth + delta);
        th.style.width = newWidth + 'px';
        th.style.minWidth = newWidth + 'px';
        // Also update all data cells in this column
        const cells = table.querySelectorAll(`td[data-col-index="${col.idx}"]`);
        cells.forEach((cell) => {
          cell.style.width = newWidth + 'px';
          cell.style.minWidth = newWidth + 'px';
        });
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // Persist width in schema
        const newWidth = th.offsetWidth;
        const updatedColumns = columns.map((c, i) =>
          i === col.idx ? { ...c, width: newWidth } : { ...c }
        );
        db.schema.columns = updatedColumns;
        if (callbacks.onColumnResize) {
          callbacks.onColumnResize(col.idx, newWidth);
        } else if (schema.id) {
          updateInlineDatabaseSchema(schema.id, { columns: updatedColumns }).catch((e) =>
            console.warn('[vault] column width update failed', e)
          );
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    th.appendChild(handle);
    headerRow.appendChild(th);
  });

  // Last header cell: + and ⋮ buttons, only visible on header-row hover
  const actionTh = document.createElement('th');
  actionTh.className = 'vault-db-header-actions';
  actionTh.style.width = '60px';
  actionTh.style.minWidth = '60px';
  actionTh.innerHTML = `
    <div class="vault-db-header-actions-wrap">
      <button class="vault-db-header-btn" title="Add column">${ICONS.plus}</button>
      <button class="vault-db-header-btn" title="Property visibility">${ICONS.dots}</button>
    </div>
  `;
  const [addBtn, menuBtn] = actionTh.querySelectorAll('.vault-db-header-btn');
  addBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const name = await styledPrompt('New column name', { title: 'Add Column', placeholder: 'Column name' });
    if (name && callbacks.onAddColumn) callbacks.onAddColumn(name.trim());
  });
  menuBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (callbacks.onShowColumnMenu) {
      callbacks.onShowColumnMenu(-1, columns, menuBtn);
    }
  });
  headerRow.appendChild(actionTh);

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  filteredRows.forEach(({ cells, originalIndex }) => {
    const tr = document.createElement('tr');
    tr.dataset.rowIndex = originalIndex;
    visibleColumns.forEach((col) => {
      const td = document.createElement('td');
      td.dataset.colIndex = col.idx;
      if (col.width) {
        td.style.width = col.width + 'px';
        td.style.minWidth = col.width + 'px';
      }
      const raw = cells[col.idx] || '';
      td.innerHTML = _renderCellLinks(_esc(raw)) || '&nbsp;';
      td.addEventListener('click', () => {
        if (callbacks.onCellEdit) {
          _startCellEdit(td, raw, (value) => callbacks.onCellEdit(originalIndex, col.idx, value));
        }
      });
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  // Hover toolbar: add-row on left, filter/sort/delete on right
  const toolbar = document.createElement('div');
  toolbar.className = 'vault-inline-db-toolbar';
  toolbar.innerHTML = `
    <div class="vault-inline-db-toolbar-left">
      <button class="vault-inline-db-btn vault-inline-db-add-row" title="Add row">${ICONS.plus}</button>
    </div>
    <div class="vault-inline-db-toolbar-right">
      <button class="vault-inline-db-btn vault-inline-db-filter" title="Filter">${ICONS.filter}</button>
      <button class="vault-inline-db-btn vault-inline-db-sort" title="Sort">${ICONS.sort}</button>
      <button class="vault-inline-db-btn vault-inline-db-delete" title="Delete database">${ICONS.trash}</button>
    </div>
  `;
  toolbar.querySelector('.vault-inline-db-add-row').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (callbacks.onAddRow) callbacks.onAddRow();
  });
  toolbar.querySelector('.vault-inline-db-filter').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (callbacks.onShowFilterMenu) {
      callbacks.onShowFilterMenu(columns, e.currentTarget);
    }
  });
  toolbar.querySelector('.vault-inline-db-sort').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (callbacks.onShowSortMenu) {
      callbacks.onShowSortMenu(columns, e.currentTarget);
    }
  });
  toolbar.querySelector('.vault-inline-db-delete').addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const confirmed = await styledConfirm('Delete this database?', { confirmText: 'Delete', cancelText: 'Cancel', danger: true });
    if (confirmed && callbacks.onDeleteDatabase) callbacks.onDeleteDatabase();
  });

  container.innerHTML = '';
  container.appendChild(toolbar);
  container.appendChild(table);
}

let _activeSelectMenu = null;
let _activeSelectMenuClickAway = null;

/**
 * Show a simple dropdown menu listing column names.
 * Used for Sort by / Filter by selection.
 */
export function showPropertySelectMenu(columns, anchorEl, onSelect, opts = {}) {
  // Clean up any existing menu and its listener
  if (_activeSelectMenu) {
    _activeSelectMenu.remove();
    if (_activeSelectMenuClickAway) {
      document.removeEventListener('click', _activeSelectMenuClickAway, true);
    }
    _activeSelectMenu = null;
    _activeSelectMenuClickAway = null;
  }

  const menu = document.createElement('div');
  menu.className = 'vault-db-select-menu';
  const title = opts.title || 'Select property';
  menu.innerHTML = `
    <div class="vault-db-select-header">${_esc(title)}</div>
    <div class="vault-db-select-search-wrap">
      <input type="text" class="vault-db-select-search" placeholder="Search for a property...">
    </div>
    <div class="vault-db-select-list"></div>
  `;
  const list = menu.querySelector('.vault-db-select-list');
  const searchInput = menu.querySelector('.vault-db-select-search');

  const visibleColumns = columns.filter((col) => col.visible !== false);

  function _renderList(filter = '') {
    list.innerHTML = '';
    const q = filter.toLowerCase();
    let hasMatch = false;
    visibleColumns.forEach((col) => {
      if (q && !(col.name || '').toLowerCase().includes(q)) return;
      hasMatch = true;
      const item = document.createElement('div');
      item.className = 'vault-db-select-item';
      item.innerHTML = `<span class="vault-db-select-icon">Aa</span><span class="vault-db-select-name">${_esc(col.name)}</span>`;
      item.addEventListener('click', () => {
        if (onSelect) onSelect(col.name);
        _closeSelectMenu();
      });
      list.appendChild(item);
    });
    if (!hasMatch) {
      const empty = document.createElement('div');
      empty.className = 'vault-db-select-empty';
      empty.textContent = 'No properties match your search.';
      empty.style.padding = '8px 12px';
      empty.style.fontSize = '12px';
      empty.style.opacity = '0.5';
      list.appendChild(empty);
    }
  }

  _renderList();
  searchInput.focus();
  searchInput.addEventListener('input', (e) => _renderList(e.target.value));

  function _closeSelectMenu() {
    menu.remove();
    if (_activeSelectMenuClickAway) {
      document.removeEventListener('click', _activeSelectMenuClickAway, true);
    }
    _activeSelectMenu = null;
    _activeSelectMenuClickAway = null;
  }

  _activeSelectMenu = menu;
  _activeSelectMenuClickAway = function clickAway(e) {
    if (!menu.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
      _closeSelectMenu();
    }
  };
  document.addEventListener('click', _activeSelectMenuClickAway, true);

  const rect = anchorEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.zIndex = '9999';

  document.body.appendChild(menu);
}

let _activePropDialog = null;
let _activePropDialogClickAway = null;

/**
 * Show a property visibility dialog for database columns.
 * columns: array of { name, visible } objects
 * onChange: (updatedColumns) => void
 */
export function showPropertyVisibilityDialog(columns, anchorEl, onChange) {
  // Clean up any existing dialog and its listener
  if (_activePropDialog) {
    _activePropDialog.remove();
    if (_activePropDialogClickAway) {
      document.removeEventListener('click', _activePropDialogClickAway, true);
    }
    _activePropDialog = null;
    _activePropDialogClickAway = null;
  }

  const dialog = document.createElement('div');
  dialog.className = 'vault-db-prop-dialog';
  dialog.innerHTML = `
    <div class="vault-db-prop-header">
      <span>Property visibility</span>
      <button class="vault-db-prop-close">${_esc('×')}</button>
    </div>
    <div class="vault-db-prop-search-wrap">
      <input type="text" class="vault-db-prop-search" placeholder="Search for a property...">
    </div>
    <div class="vault-db-prop-section">
      <div class="vault-db-prop-section-title">Shown in table</div>
      <div class="vault-db-prop-shown"></div>
    </div>
    <div class="vault-db-prop-section">
      <div class="vault-db-prop-section-title">Hidden in table</div>
      <div class="vault-db-prop-hidden"></div>
    </div>
  `;

  const shownWrap = dialog.querySelector('.vault-db-prop-shown');
  const hiddenWrap = dialog.querySelector('.vault-db-prop-hidden');
  const searchInput = dialog.querySelector('.vault-db-prop-search');

  function _renderList(filter = '') {
    const q = filter.toLowerCase();
    shownWrap.innerHTML = '';
    hiddenWrap.innerHTML = '';

    columns.forEach((col, idx) => {
      if (q && !col.name.toLowerCase().includes(q)) return;
      const row = document.createElement('div');
      row.className = 'vault-db-prop-row';
      row.innerHTML = `
        <span class="vault-db-prop-drag">${ICONS.drag}</span>
        <span class="vault-db-prop-type-icon">Aa</span>
        <span class="vault-db-prop-name">${_esc(col.name)}</span>
        <button class="vault-db-prop-toggle" title="Toggle visibility">${col.visible !== false ? ICONS.eye : ICONS.eyeOff}</button>
      `;
      row.querySelector('.vault-db-prop-toggle').addEventListener('click', () => {
        col.visible = col.visible === false ? true : false;
        _renderList(filter);
        if (onChange) onChange(columns);
      });
      if (col.visible !== false) shownWrap.appendChild(row);
      else hiddenWrap.appendChild(row);
    });
  }

  _renderList();

  searchInput.addEventListener('input', (e) => _renderList(e.target.value));

  function _closePropDialog() {
    dialog.remove();
    if (_activePropDialogClickAway) {
      document.removeEventListener('click', _activePropDialogClickAway, true);
    }
    _activePropDialog = null;
    _activePropDialogClickAway = null;
  }
  dialog.querySelector('.vault-db-prop-close').addEventListener('click', _closePropDialog);
  _activePropDialog = dialog;
  _activePropDialogClickAway = function clickAway(e) {
    if (!dialog.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
      _closePropDialog();
    }
  };
  document.addEventListener('click', _activePropDialogClickAway, true);

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  dialog.style.position = 'fixed';
  dialog.style.left = `${rect.left}px`;
  dialog.style.top = `${rect.bottom + 4}px`;
  dialog.style.zIndex = '9999';

  document.body.appendChild(dialog);
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
  // Remove any existing floating editor
  const existing = document.querySelector('.vault-inline-db-cell-editor');
  if (existing) existing.remove();

  const textarea = document.createElement('textarea');
  textarea.value = raw;
  textarea.className = 'vault-inline-db-cell-editor';
  textarea.spellcheck = false;

  // Position using fixed coordinates from cell rect so it never gets clipped
  const rect = td.getBoundingClientRect();
  const padding = 4;
  textarea.style.left = (rect.left + window.scrollX - padding) + 'px';
  textarea.style.top = (rect.top + window.scrollY - padding) + 'px';
  textarea.style.width = Math.max(rect.width + padding * 2, 200) + 'px';
  textarea.style.minHeight = (rect.height + padding * 2) + 'px';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.setSelectionRange(0, textarea.value.length);

  // Auto-expand height as user types
  const adjustHeight = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };
  textarea.addEventListener('input', adjustHeight);
  requestAnimationFrame(adjustHeight);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const value = textarea.value;
    textarea.remove();
    if (value !== raw) onDone(value);
  };
  const cancel = () => {
    if (done) return;
    done = true;
    textarea.remove();
  };

  textarea.addEventListener('blur', finish, { once: true });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      textarea.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
}

/**
 * Fetch schema and row data for all databases inside a note.
 */
export async function fetchInlineDatabases(noteId) {
  const url = `${API_BASE}/api/vault/notes/${encodeURIComponent(noteId)}/databases`;
  const r = await fetch(url, { credentials: 'same-origin' });
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
 * Promote a markdown table into a database using its marker string.
 * This avoids fragile line-number translation between frontend and backend.
 */
export async function promoteInlineDatabaseByMarker(noteId, marker) {
  const url = `${API_BASE}/api/vault/notes/${encodeURIComponent(noteId)}/databases`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ marker }),
  });
  if (!r.ok) {
    let detail = 'Failed to promote table by marker';
    try { const d = await r.json(); detail = d.detail || JSON.stringify(d); } catch {}
    throw new Error(detail);
  }
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

/**
 * Eagerly create a new inline database. Creates DB record + first row + writes
 * marker+snapshot into the note file.
 */
export async function createInlineDatabase(noteId, columns, title) {
  const r = await fetch(`${API_BASE}/api/vault/databases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ note_id: noteId, columns, title }),
  });
  if (!r.ok) throw new Error('Failed to create database');
  return r.json();
}
