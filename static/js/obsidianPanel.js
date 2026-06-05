/**
 * Obsidian Vault — floating modal panel for vault sync, graph, and timeline.
 */

import { makeWindowDraggable } from './windowDrag.js';
import { obsidianMdToHtml, buildNoteCache } from './obsidianMarkdown.js';

const API_BASE = window.location.origin;

let _open = false;
let _notes = [];
let _noteCache = new Map();
let _activeTab = 'list';
let _searchQuery = '';
let _selectedNoteId = null;
let _selectedFolder = null;
let _expandedFolders = new Set();
let _dragWired = false;
let _vaults = [];
let _selectedVaultId = null;
let _permissions = [];

export function openPanel() {
  console.log('[obsidian] openPanel called');
  const modal = document.getElementById('obsidian-modal');
  if (!modal) return;
  if (_open) { _bringToFront(); return; }
  _open = true;

  modal.classList.remove('hidden');
  _bringToFront();
  _wireDrag();
  _loadVaults();

  // Restore saved position / fullscreen state
  const content = modal.querySelector('.modal-content');
  if (content) {
    try {
      const saved = JSON.parse(localStorage.getItem('obsidian-pos'));
      if (saved && saved.fullscreen) {
        _enterObsidianFullscreen(content);
      } else if (saved && saved.left && saved.top) {
        content.style.position = 'fixed';
        content.style.left = saved.left;
        content.style.top = saved.top;
        content.style.transform = 'none';
        content.style.margin = '0';
      }
    } catch (_) {}
  }

  document.getElementById('tool-obsidian-btn')?.classList.add('active');
}

export function closePanel() {
  const modal = document.getElementById('obsidian-modal');
  if (!modal || !_open) return;
  _open = false;
  modal.classList.add('hidden');
  document.getElementById('tool-obsidian-btn')?.classList.remove('active');
}

export function togglePanel() {
  console.log('[obsidian] togglePanel; _open=', _open);
  if (_open) closePanel(); else openPanel();
}

export function isOpen() { return _open; }

function _bringToFront() {
  const modal = document.getElementById('obsidian-modal');
  if (!modal) return;
  const z = 260;
  modal.style.zIndex = z;
}

function _enterObsidianFullscreen(content) {
  const modal = document.getElementById('obsidian-modal');
  if (!modal || !content) return;
  if (modal.classList.contains('obsidian-fullscreen')) return;
  modal.classList.add('obsidian-fullscreen');
  content.style.position = 'fixed';
  content.style.left = '0';
  content.style.top = '0';
  content.style.width = '100vw';
  content.style.maxWidth = '100vw';
  content.style.height = '100vh';
  content.style.maxHeight = '100vh';
  content.style.borderRadius = '0';
  content.style.margin = '0';
  content.style.transform = 'none';
  try { localStorage.setItem('obsidian-pos', JSON.stringify({ fullscreen: true })); } catch {}
}

function _exitObsidianFullscreen(content, cx, cy) {
  const modal = document.getElementById('obsidian-modal');
  if (!modal || !content) return;
  if (!modal.classList.contains('obsidian-fullscreen')) return;
  modal.classList.remove('obsidian-fullscreen');
  content.style.width = '';
  content.style.maxWidth = '';
  content.style.height = '';
  content.style.maxHeight = '';
  content.style.borderRadius = '';
  content.style.margin = '';
  // Reposition centered on cursor
  const w = Math.min(720, window.innerWidth * 0.9);
  const h = Math.min(window.innerHeight * 0.78, window.innerHeight - 40);
  const left = Math.max(0, Math.min(cx - w / 2, window.innerWidth - w));
  const top = Math.max(0, Math.min(cy - 30, window.innerHeight - h));
  content.style.position = 'fixed';
  content.style.left = left + 'px';
  content.style.top = top + 'px';
  content.style.transform = 'none';
}

function _wireDrag() {
  if (_dragWired) return;
  const modal = document.getElementById('obsidian-modal');
  const content = modal?.querySelector('.modal-content');
  const header = modal?.querySelector('.modal-header');
  if (!modal || !content || !header) return;
  _dragWired = true;

  try {
    makeWindowDraggable(modal, {
      content,
      header,
      fsClass: 'obsidian-fullscreen',
      enableDock: true,
      enableLeftDock: true,
      onEnterFullscreen: () => _enterObsidianFullscreen(content),
      onExitFullscreen: (cx, cy) => _exitObsidianFullscreen(content, cx, cy),
      onDragEnd: () => {
        try {
          localStorage.setItem('obsidian-pos', JSON.stringify({ left: content.style.left, top: content.style.top }));
        } catch {}
      },
    });
  } catch (e) {
    console.warn('[obsidian] makeWindowDraggable failed:', e);
  }

  document.getElementById('close-obsidian-modal')?.addEventListener('click', closePanel);

  // Tab switching
  document.querySelectorAll('[data-obsidian-tab]').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.obsidianTab));
  });

  // Search
  const searchInput = document.getElementById('obsidian-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      _searchQuery = e.target.value;
      _renderNoteList();
    });
  }

  // Vault management
  document.getElementById('obsidian-add-vault-btn')?.addEventListener('click', _showAddVaultForm);
  document.getElementById('obsidian-save-vault-btn')?.addEventListener('click', _saveNewVault);
  document.getElementById('obsidian-cancel-vault-btn')?.addEventListener('click', _hideAddVaultForm);
  document.getElementById('obsidian-vault-select')?.addEventListener('change', (e) => {
    _selectVault(e.target.value);
    try { localStorage.setItem('obsidian-last-vault', e.target.value); } catch {}
  });

  // Permission management
  document.getElementById('obsidian-vault-read-all')?.addEventListener('change', _updateVaultToggles);
  document.getElementById('obsidian-vault-write-all')?.addEventListener('change', _updateVaultToggles);
  document.getElementById('obsidian-add-perm-btn')?.addEventListener('click', _addPermission);

  // Connect / Disconnect (legacy - keep for compatibility)
  document.getElementById('obsidian-connect-btn')?.addEventListener('click', _connectVault);
  document.getElementById('obsidian-disconnect-btn')?.addEventListener('click', _disconnectVault);
}

// ── Vault Management ───────────────────────────────────────

async function _loadVaults() {
  try {
    const r = await fetch(`${API_BASE}/api/obsidian/status`, { credentials: 'same-origin' });
    const s = r.ok ? await r.json() : {};
    _vaults = s.vaults || [];
    _renderVaultList();
    _populateVaultSelect();
    if (_vaults.length > 0 && !_selectedVaultId) {
      let lastVault = null;
      try { lastVault = localStorage.getItem('obsidian-last-vault'); } catch {}
      const target = _vaults.find(v => v.id === lastVault) ? lastVault : _vaults[0].id;
      _selectVault(target);
    }
  } catch (e) {
    console.error('[obsidian] load vaults failed', e);
    _vaults = [];
    _renderVaultList();
  }
}

function _renderVaultList() {
  const list = document.getElementById('obsidian-vault-list');
  if (!list) return;
  list.classList.remove('hidden');
  if (!_vaults.length) {
    list.innerHTML = '<div style="padding:12px;text-align:center;opacity:0.5;font-size:12px;">No vaults connected</div>';
    return;
  }
  list.innerHTML = _vaults.map(v => `
    <div class="obsidian-vault-row ${_selectedVaultId === v.id ? 'selected' : ''}" data-id="${v.id}">
      <div class="obsidian-vault-name">${_esc(v.name)}</div>
      <div class="obsidian-vault-badges">
        ${v.read_enabled ? '<span class="obsidian-badge read">R</span>' : '<span class="obsidian-badge none">R</span>'}
        ${v.write_enabled ? '<span class="obsidian-badge write">W</span>' : ''}
        <button class="obsidian-vault-remove" data-id="${v.id}" title="Remove vault">&times;</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('.obsidian-vault-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.obsidian-vault-remove')) return;
      _selectVault(row.dataset.id);
    });
  });
  list.querySelectorAll('.obsidian-vault-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _removeVault(btn.dataset.id);
    });
  });
}

function _populateVaultSelect() {
  const sel = document.getElementById('obsidian-vault-select');
  if (!sel) return;
  sel.innerHTML = _vaults.map(v => `<option value="${v.id}" ${_selectedVaultId === v.id ? 'selected' : ''}>${_esc(v.name)}</option>`).join('');
}

async function _selectVault(vaultId) {
  _selectedVaultId = vaultId;
  const vault = _vaults.find(v => v.id === vaultId);
  const mainPanel = document.getElementById('obsidian-main-panel');
  const statusBar = document.getElementById('obsidian-status-bar');
  const vaultList = document.getElementById('obsidian-vault-list');
  const folderTree = document.getElementById('obsidian-folder-tree');

  _renderVaultList();
  _populateVaultSelect();

  if (!vault) {
    if (mainPanel) mainPanel.classList.add('hidden');
    if (statusBar) statusBar.textContent = '';
    if (vaultList) vaultList.classList.remove('hidden');
    if (folderTree) folderTree.classList.add('hidden');
    return;
  }

  if (mainPanel) mainPanel.classList.remove('hidden');
  if (statusBar) statusBar.textContent = `${_esc(vault.name)} — ${vault.note_count || 0} notes`;
  if (vaultList) vaultList.classList.add('hidden');
  if (folderTree) folderTree.classList.remove('hidden');

  // Update permission toggles
  const readCb = document.getElementById('obsidian-vault-read-all');
  const writeCb = document.getElementById('obsidian-vault-write-all');
  if (readCb) readCb.checked = vault.read_enabled;
  if (writeCb) writeCb.checked = vault.write_enabled;

  // Update badges
  const badges = document.getElementById('obsidian-vault-badges');
  if (badges) {
    badges.innerHTML = `
      ${vault.read_enabled ? '<span class="obsidian-badge read">Read</span>' : '<span class="obsidian-badge none">No Read</span>'}
      ${vault.write_enabled ? '<span class="obsidian-badge write">Write</span>' : '<span class="obsidian-badge none">No Write</span>'}
    `;
  }

  _loadNotes();
  _loadPermissions();
  _loadFolders();
}

// ── Folder Tree ──────────────────────────────────────────────

let _folders = [];

async function _loadFolders() {
  if (!_selectedVaultId) return;
  try {
    const r = await fetch(`${API_BASE}/api/obsidian/folders?vault_id=${encodeURIComponent(_selectedVaultId)}`, { credentials: 'same-origin' });
    if (!r.ok) return;
    const data = await r.json();
    _folders = data.folders || [];
    _renderFolderTree();
  } catch (e) {
    console.error('[obsidian] load folders failed', e);
    _folders = [];
    _renderFolderTree();
  }
}

function _buildFolderTree(paths) {
  const root = { name: '', children: {} };
  for (const p of paths) {
    if (!p) continue;
    const parts = p.split('/').filter(Boolean);
    let node = root;
    for (const part of parts) {
      if (!node.children[part]) node.children[part] = { name: part, children: {} };
      node = node.children[part];
    }
  }
  return root;
}

function _renderFolderTreeNode(node, pathPrefix, depth) {
  const fullPath = pathPrefix ? `${pathPrefix}/${node.name}` : node.name;
  const isExpanded = _expandedFolders.has(fullPath);
  const hasChildren = Object.keys(node.children).length > 0;
  const isSelected = _selectedFolder === fullPath;
  let html = '';
  if (node.name) {
    const indent = 'padding-left:' + (depth * 14 + 4) + 'px;';
    const chevron = hasChildren ? (isExpanded ? '▼' : '▶') : '<span style="opacity:0.3">◦</span>';
    html += `<div class="obsidian-folder-item ${isSelected ? 'selected' : ''}" data-folder="${_esc(fullPath)}" style="${indent}">
      <span class="obsidian-folder-chevron" style="width:14px;text-align:center;flex-shrink:0;font-size:9px;opacity:0.6;">${chevron}</span>
      <span class="obsidian-folder-icon">📁</span>
      <span class="obsidian-folder-name">${_esc(node.name)}</span>
    </div>`;
  }
  if (hasChildren && isExpanded) {
    const childNames = Object.keys(node.children).sort();
    for (const childName of childNames) {
      html += _renderFolderTreeNode(node.children[childName], fullPath, depth + 1);
    }
  }
  return html;
}

function _renderFolderTree() {
  const tree = document.getElementById('obsidian-folder-tree');
  if (!tree) return;
  if (!_folders.length) {
    tree.innerHTML = '<div style="padding:8px;text-align:center;opacity:0.5;font-size:11px;">No folders</div>';
    return;
  }
  const root = _buildFolderTree(_folders);
  let html = '';
  const childNames = Object.keys(root.children).sort();
  for (const childName of childNames) {
    html += _renderFolderTreeNode(root.children[childName], '', 0);
  }
  tree.innerHTML = html || '<div style="padding:8px;text-align:center;opacity:0.5;font-size:11px;">No folders</div>';

  tree.querySelectorAll('.obsidian-folder-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const folder = item.dataset.folder;
      const chevron = item.querySelector('.obsidian-folder-chevron');
      // Toggle expand if clicking chevron area
      if (e.target.closest('.obsidian-folder-chevron') && chevron.textContent.trim() && chevron.textContent !== '◦') {
        if (_expandedFolders.has(folder)) _expandedFolders.delete(folder);
        else _expandedFolders.add(folder);
        _renderFolderTree();
        return;
      }
      // Select folder
      _selectedFolder = folder;
      _renderFolderTree();
      _renderNoteList();
    });
  });
}

function _showAddVaultForm() {
  document.getElementById('obsidian-add-vault-form')?.classList.remove('hidden');
  document.getElementById('obsidian-vault-list')?.classList.add('hidden');
}

function _hideAddVaultForm() {
  document.getElementById('obsidian-add-vault-form')?.classList.add('hidden');
  document.getElementById('obsidian-vault-list')?.classList.remove('hidden');
  const status = document.getElementById('obsidian-add-vault-status');
  if (status) status.textContent = '';
}

async function _saveNewVault() {
  const nameInput = document.getElementById('obsidian-new-vault-name');
  const pathInput = document.getElementById('obsidian-new-vault-path');
  const statusEl = document.getElementById('obsidian-add-vault-status');
  const name = nameInput?.value.trim();
  const path = pathInput?.value.trim();
  if (!path) { if (statusEl) statusEl.textContent = 'Enter a vault path'; return; }

  if (statusEl) statusEl.textContent = 'Connecting...';
  try {
    const r = await fetch(`${API_BASE}/api/obsidian/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ vault_path: path, name: name || undefined, read_enabled: true, write_enabled: false }),
    });
    const data = await r.json();
    if (r.ok) {
      if (nameInput) nameInput.value = '';
      if (pathInput) pathInput.value = '';
      _hideAddVaultForm();
      await _loadVaults();
      if (data.vault_id) _selectVault(data.vault_id);
    } else {
      if (statusEl) statusEl.textContent = data.detail || 'Connection failed';
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Connection error';
  }
}

// ── Legacy single-vault connect/disconnect (kept for compatibility) ──

async function _connectVault() {
  const pathInput = document.getElementById('obsidian-vault-path');
  const statusEl = document.getElementById('obsidian-connect-status');
  const path = pathInput?.value.trim();
  if (!path) { if (statusEl) statusEl.textContent = 'Enter a vault path'; return; }

  if (statusEl) statusEl.textContent = 'Connecting...';
  try {
    const r = await fetch(`${API_BASE}/api/obsidian/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ vault_path: path, read_enabled: true, write_enabled: false }),
    });
    const data = await r.json();
    if (r.ok) {
      await _loadVaults();
      if (data.vault_id) _selectVault(data.vault_id);
      if (statusEl) statusEl.textContent = '';
    } else {
      if (statusEl) statusEl.textContent = data.detail || 'Connection failed';
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Connection error';
  }
}

async function _disconnectVault() {
  try {
    await fetch(`${API_BASE}/api/obsidian/disconnect`, { method: 'POST', credentials: 'same-origin' });
    _selectedVaultId = null;
    await _loadVaults();
  } catch (e) { /* ignore */ }
}

async function _removeVault(vaultId) {
  const vault = _vaults.find(v => v.id === vaultId);
  if (!vault) return;
  if (!confirm(`Remove vault "${_esc(vault.name)}" from Odysseus?\n\nNotes stay on disk. This only removes the connection.`)) return;
  try {
    const r = await fetch(`${API_BASE}/api/obsidian/vaults/${encodeURIComponent(vaultId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (r.ok) {
      if (_selectedVaultId === vaultId) _selectedVaultId = null;
      await _loadVaults();
    }
  } catch (e) {
    console.error('[obsidian] remove vault failed', e);
  }
}

// ── Tabs ───────────────────────────────────────────────────

function _switchTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('[data-obsidian-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.obsidianTab === tab);
  });
  document.querySelectorAll('[data-obsidian-content]').forEach(p => {
    const isActive = p.dataset.obsidianContent === tab;
    p.classList.toggle('hidden', !isActive);
  });
  if (tab === 'graph') _renderGraph();
  if (tab === 'timeline') _renderTimeline();
  if (tab === 'permissions') _renderPermissions();
}

// ── Data ───────────────────────────────────────────────────

async function _loadNotes() {
  try {
    const qs = new URLSearchParams();
    if (_selectedVaultId) qs.set('vault_id', _selectedVaultId);
    if (_searchQuery) qs.set('q', _searchQuery);
    const r = await fetch(`${API_BASE}/api/obsidian/notes?${qs.toString()}`);
    if (!r.ok) return;
    const data = await r.json();
    _notes = data.notes || [];
    _noteCache = buildNoteCache(_notes);
    _renderNoteList();
  } catch (e) {
    console.error('Obsidian load failed', e);
  }
}

// ── List View ────────────────────────────────────────────────

function _renderNoteList() {
  const list = document.getElementById('obsidian-note-list');
  if (!list) return;

  let filtered = _notes;
  // Folder filter
  if (_selectedFolder) {
    filtered = filtered.filter(n => (n.folder || '') === _selectedFolder);
  }
  // Search filter
  if (_searchQuery) {
    const q = _searchQuery.toLowerCase();
    filtered = filtered.filter(n => (n.title + n.content + (n.tags?.join('') || '')).toLowerCase().includes(q));
  }

  if (!filtered.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;font-size:12px;">No notes found</div>';
    return;
  }

  list.innerHTML = filtered.map(n => `
    <div class="obsidian-note-card ${n.id === _selectedNoteId ? 'selected' : ''}" data-id="${n.id}">
      <div class="obsidian-note-card-title">${_esc(n.title)}</div>
      <div class="obsidian-note-card-preview">${_esc(n.content?.slice(0, 120) || '')}</div>
      <div class="obsidian-note-card-meta">
        ${(n.tags || []).map(t => `<span class="obsidian-tag">${_esc(t)}</span>`).join('')}
        <span class="obsidian-note-date">${n.last_modified_src?.slice(0, 10) || ''}</span>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.obsidian-note-card').forEach(card => {
    card.addEventListener('click', () => _selectNote(card.dataset.id));
  });
}

let _previewMode = 'preview'; // 'preview' | 'edit'

async function _selectNote(id) {
  _selectedNoteId = id;
  document.querySelectorAll('.obsidian-note-card').forEach(c => c.classList.toggle('selected', c.dataset.id === id));

  const preview = document.getElementById('obsidian-preview');
  if (!preview) return;

  try {
    const r = await fetch(`${API_BASE}/api/obsidian/notes/${encodeURIComponent(id)}`);
    if (!r.ok) { preview.style.display = 'none'; return; }
    const note = await r.json();
    preview.style.display = 'block';
    preview.innerHTML = `
      <div class="obsidian-preview-header">
        <strong>${_esc(note.title)}</strong>
        <div style="display:flex;gap:6px;align-items:center;">
          <button class="obsidian-mode-toggle" data-mode="preview">Preview</button>
          <button class="obsidian-mode-toggle" data-mode="edit">Edit</button>
          <button class="obsidian-use-context-btn">Use as context</button>
        </div>
      </div>
      <div class="obsidian-preview-body"></div>
    `;
    const bodyEl = preview.querySelector('.obsidian-preview-body');
    const updateBody = () => {
      if (_previewMode === 'edit') {
        bodyEl.innerHTML = `
          <textarea class="obsidian-edit-textarea">${_esc(note.content)}</textarea>
          <div style="margin-top:6px;display:flex;gap:6px;align-items:center;">
            <button class="obsidian-save-btn" style="padding:4px 10px;font-size:11px;">Save</button>
            <span class="obsidian-save-status" style="font-size:11px;opacity:0.7;"></span>
          </div>
        `;
        const saveBtn = bodyEl.querySelector('.obsidian-save-btn');
        const statusEl = bodyEl.querySelector('.obsidian-save-status');
        saveBtn?.addEventListener('click', async () => {
          const ta = bodyEl.querySelector('.obsidian-edit-textarea');
          if (!ta) return;
          try {
            const r = await fetch(`${API_BASE}/api/obsidian/notes/${encodeURIComponent(note.id)}/edit`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ content: ta.value }),
            });
            if (r.ok) {
              note.content = ta.value;
              _noteCache.set(note.title, note);
              statusEl.textContent = 'Saved';
              setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
            } else {
              const d = await r.json().catch(() => ({}));
              statusEl.textContent = 'Error: ' + (d.detail || r.status);
            }
          } catch (e) {
            statusEl.textContent = 'Save failed';
          }
        });
      } else {
        bodyEl.innerHTML = obsidianMdToHtml(note.content || '', _noteCache);
        // Wire wikilink clicks
        bodyEl.querySelectorAll('a.wikilink').forEach(a => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            const targetTitle = a.dataset.note;
            const target = _notes.find(n => n.title === targetTitle);
            if (target) _selectNote(target.id);
          });
        });
      }
    };
    updateBody();
    preview.querySelectorAll('.obsidian-mode-toggle').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === _previewMode);
      btn.addEventListener('click', () => {
        _previewMode = btn.dataset.mode;
        preview.querySelectorAll('.obsidian-mode-toggle').forEach(b => b.classList.toggle('active', b.dataset.mode === _previewMode));
        updateBody();
      });
    });
    preview.querySelector('.obsidian-use-context-btn')?.addEventListener('click', () => {
      _injectAsContext(note);
    });
    _renderRightSidebar(note);
  } catch (e) {
    preview.style.display = 'none';
  }
}

function _renderRightSidebar(note) {
  const pane = document.getElementById('obsidian-right-pane');
  if (!pane) return;
  const placeholder = pane.querySelector('.obsidian-right-placeholder');
  if (placeholder) placeholder.classList.add('hidden');

  // Properties
  const props = document.getElementById('obsidian-properties-panel');
  if (props) {
    const fm = note.frontmatter || {};
    const rows = Object.entries(fm).map(([k, v]) => `<div class="obsidian-prop-row"><span class="obsidian-prop-key">${_esc(k)}</span><span class="obsidian-prop-val">${_esc(String(v))}</span></div>`).join('');
    props.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Properties</h4>${rows || '<div style="opacity:0.5;font-size:11px;">No properties</div>'}`;
    props.classList.remove('hidden');
  }

  // Backlinks
  const bl = document.getElementById('obsidian-backlinks-panel');
  if (bl) {
    const links = note.backlinks_resolved || [];
    bl.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin:12px 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Backlinks (${links.length})</h4>` +
      (links.length ? links.map(b => `<div class="obsidian-sidebar-link" data-id="${_esc(b.id)}">${_esc(b.title)}</div>`).join('') : '<div style="opacity:0.5;font-size:11px;">No backlinks</div>');
    bl.querySelectorAll('.obsidian-sidebar-link').forEach(el => {
      el.addEventListener('click', () => _selectNote(el.dataset.id));
    });
    bl.classList.remove('hidden');
  }

  // Outgoing links
  const out = document.getElementById('obsidian-outgoing-panel');
  if (out) {
    const links = note.outbound_links || [];
    out.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin:12px 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Outgoing (${links.length})</h4>` +
      (links.length ? links.map(t => {
        const target = _notes.find(n => n.title === t);
        return `<div class="obsidian-sidebar-link ${target ? '' : 'ghost'}" data-title="${_esc(t)}">${_esc(t)}</div>`;
      }).join('') : '<div style="opacity:0.5;font-size:11px;">No outgoing links</div>');
    out.querySelectorAll('.obsidian-sidebar-link').forEach(el => {
      el.addEventListener('click', () => {
        const target = _notes.find(n => n.title === el.dataset.title);
        if (target) _selectNote(target.id);
      });
    });
    out.classList.remove('hidden');
  }

  // Tags
  const tags = document.getElementById('obsidian-tags-panel');
  if (tags) {
    const t = note.tags || [];
    tags.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin:12px 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Tags</h4>` +
      (t.length ? t.map(tag => `<span class="obsidian-tag" style="cursor:pointer;">${_esc(tag)}</span>`).join(' ') : '<div style="opacity:0.5;font-size:11px;">No tags</div>');
    tags.classList.remove('hidden');
  }

  // Outline
  const outline = document.getElementById('obsidian-outline-panel');
  if (outline) {
    const headings = [];
    const lines = (note.content || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
      if (m) headings.push({ level: m[1].length, text: m[2].trim(), line: i });
    }
    outline.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin:12px 0 6px;text-transform:uppercase;letter-spacing:0.05em;">Outline</h4>` +
      (headings.length ? headings.map(h => `<div class="obsidian-outline-item" data-line="${h.line}" style="padding-left:${(h.level - 1) * 10}px;font-size:12px;cursor:pointer;padding-top:2px;padding-bottom:2px;border-radius:3px;">${_esc(h.text)}</div>`).join('') : '<div style="opacity:0.5;font-size:11px;">No headings</div>');
    outline.querySelectorAll('.obsidian-outline-item').forEach(el => {
      el.addEventListener('click', () => {
        const previewBody = document.querySelector('.obsidian-preview-body');
        if (previewBody) previewBody.scrollTop = 0; // Simple scroll reset; scroll-to-heading can be enhanced later
      });
    });
    outline.classList.remove('hidden');
  }
}

function _injectAsContext(note) {
  window.dispatchEvent(new CustomEvent('odysseus-obsidian-context', {
    detail: { label: `Obsidian: ${note.title}`, content: note.content }
  }));
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(`[[${note.title}]]\n\n${note.content.slice(0, 2000)}`);
  }
}

// ── Graph / Timeline ───────────────────────────────────────

function _renderGraph() {
  const container = document.getElementById('obsidian-graph-canvas');
  if (!container || !window.vis) return;
  import('./obsidianGraphCanvas.js').then(mod => {
    mod.renderObsidianGraph(container, _selectedVaultId);
  }).catch(err => {
    container.innerHTML = `<div class="obsidian-error">Graph error: ${err.message}</div>`;
  });
}

function _renderTimeline() {
  const wrap = document.getElementById('obsidian-timeline-wrap');
  if (!wrap) return;
  import('./obsidianTimeline.js').then(mod => {
    mod.renderObsidianTimeline(wrap, _selectedVaultId);
  }).catch(err => {
    wrap.innerHTML = `<div class="obsidian-error">Timeline error: ${err.message}</div>`;
  });
}

// ── Permissions ────────────────────────────────────────────

async function _loadPermissions() {
  if (!_selectedVaultId) return;
  try {
    const r = await fetch(`${API_BASE}/api/obsidian/vaults/${_selectedVaultId}/permissions`, { credentials: 'same-origin' });
    if (!r.ok) return;
    const data = await r.json();
    _permissions = data.permissions || [];
    _renderPermissions();
  } catch (e) {
    console.error('[obsidian] load permissions failed', e);
  }
}

function _renderPermissions() {
  const table = document.getElementById('obsidian-permissions-table');
  if (!table) return;
  if (!_permissions.length) {
    table.innerHTML = '<div style="padding:12px;text-align:center;opacity:0.5;font-size:12px;">No permission rules yet</div>';
    return;
  }
  table.innerHTML = `
    <div class="obsidian-perm-header">
      <span>Type</span><span>Pattern</span><span>Perm</span><span>Prio</span><span></span>
    </div>
    ${_permissions.map(p => `
      <div class="obsidian-perm-row" data-id="${p.id}">
        <span class="obsidian-perm-type">${_esc(p.pattern_type)}</span>
        <span class="obsidian-perm-pattern" title="${_esc(p.path_pattern)}">${_esc(p.path_pattern)}</span>
        <span class="obsidian-perm-level ${_esc(p.permission)}">${_esc(p.permission)}</span>
        <span class="obsidian-perm-priority">${p.priority}</span>
        <button class="obsidian-perm-del" data-id="${p.id}">&times;</button>
      </div>
    `).join('')}
  `;
  table.querySelectorAll('.obsidian-perm-del').forEach(btn => {
    btn.addEventListener('click', () => _removePermission(btn.dataset.id));
  });
}

async function _updateVaultToggles() {
  if (!_selectedVaultId) return;
  const readCb = document.getElementById('obsidian-vault-read-all');
  const writeCb = document.getElementById('obsidian-vault-write-all');
  const read_enabled = readCb?.checked ?? true;
  const write_enabled = writeCb?.checked ?? false;
  try {
    await fetch(`${API_BASE}/api/obsidian/vaults/${_selectedVaultId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ read_enabled, write_enabled }),
    });
    // Refresh vault state
    const vault = _vaults.find(v => v.id === _selectedVaultId);
    if (vault) {
      vault.read_enabled = read_enabled;
      vault.write_enabled = write_enabled;
    }
    _renderVaultList();
    _selectVault(_selectedVaultId);
  } catch (e) {
    console.error('[obsidian] update vault toggles failed', e);
  }
}

async function _addPermission() {
  if (!_selectedVaultId) return;
  const typeSel = document.getElementById('obsidian-new-perm-type');
  const patternInput = document.getElementById('obsidian-new-perm-pattern');
  const levelSel = document.getElementById('obsidian-new-perm-level');
  const priorityInput = document.getElementById('obsidian-new-perm-priority');

  const pattern = patternInput?.value.trim();
  if (!pattern) return;

  try {
    const r = await fetch(`${API_BASE}/api/obsidian/vaults/${_selectedVaultId}/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        path_pattern: pattern,
        pattern_type: typeSel?.value || 'file',
        permission: levelSel?.value || 'read',
        priority: parseInt(priorityInput?.value || '0', 10),
      }),
    });
    if (r.ok) {
      patternInput.value = '';
      await _loadPermissions();
    }
  } catch (e) {
    console.error('[obsidian] add permission failed', e);
  }
}

async function _removePermission(permId) {
  if (!_selectedVaultId || !permId) return;
  try {
    await fetch(`${API_BASE}/api/obsidian/vaults/${_selectedVaultId}/permissions/${permId}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    await _loadPermissions();
  } catch (e) {
    console.error('[obsidian] remove permission failed', e);
  }
}

// ── Helpers ────────────────────────────────────────────────

function _esc(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ── Init wiring ──────────────────────────────────────────────

// Event wiring is handled centrally in app.js (tool-obsidian-btn + rail-obsidian
// via _railToolMap). We keep _init empty so this module can be imported safely
// without double-listening.
function _init() {}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}

const obsidianModule = { openPanel, closePanel, togglePanel, isOpen };
export default obsidianModule;
window.obsidianModule = obsidianModule;
