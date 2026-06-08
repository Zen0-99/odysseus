/**
 * Shard Vault — floating modal panel for vault sync, graph, and timeline.
 */

import { makeWindowDraggable } from './windowDrag.js';
import { shardMdToHtml, buildNoteCache } from './shardMarkdown.js';
import { styledConfirm, styledPrompt } from './ui.js';
import {
  PluginManager, createAppApi, CORE_PLUGINS,
  GraphPlugin, BacklinksPlugin, OutgoingLinksPlugin,
  UnlinkedMentionsPlugin, OutlinePlugin, OrphansPlugin,
  BookmarksPlugin, TagsPlugin, SearchPlugin,
  DailyNotesPlugin, TemplatesPlugin, PagePreviewPlugin,
  WordCountPlugin, RandomNotePlugin,
} from './shardPluginApi.js';

const API_BASE = window.location.origin;

let _open = false;
let _notes = [];
let _noteCache = new Map();
let _activeTab = 'note';
let _searchQuery = '';
let _selectedNoteId = null;
let _selectedFolder = null;
let _historyStack = [];
let _historyIndex = -1;
let _noteContentCache = new Map();
let _expandedFolders = new Set();
let _dragWired = false;
let _rootDropWired = false;
let _openTabs = [];
let _vaults = [];
let _selectedVaultId = null;
let _permissions = [];
let _pluginManager = null;
let _shardApp = null;

function _showLoading(text = 'Loading vault...') {
  const overlay = document.getElementById('shard-loading-overlay');
  const txt = overlay?.querySelector('.shard-loading-text');
  if (overlay) overlay.classList.remove('hidden');
  if (txt) txt.textContent = text;
}
function _hideLoading() {
  document.getElementById('shard-loading-overlay')?.classList.add('hidden');
}

export async function openPanel() {
  console.log('[shard] openPanel called');
  const modal = document.getElementById('shard-modal');
  if (!modal) return;
  if (_open) { _bringToFront(); return; }
  _open = true;

  // Restore saved position / fullscreen state BEFORE showing modal so it
  // opens directly in the right place and never jumps from the default
  // centred position after loading.
  const content = modal.querySelector('.modal-content');
  if (content) {
    try {
      const saved = JSON.parse(localStorage.getItem('shard-pos'));
      if (saved && saved.fullscreen) {
        _enterShardFullscreen(content);
      } else if (saved && saved.left && saved.top) {
        content.style.position = 'fixed';
        content.style.left = saved.left;
        content.style.top = saved.top;
        content.style.transform = 'none';
        content.style.margin = '0';
      }
    } catch (_) {}
  }

  modal.classList.remove('hidden');
  _bringToFront();
  _wireDrag();
  // Only show loading on first open or if no vaults cached
  const hasVaults = _vaults && _vaults.length > 0;
  if (!hasVaults) {
    // Skip loading overlay if we have a recent cache — the vault list will
    // restore instantly and the fetch can run silently in background.
    let hasCache = false;
    try {
      const cached = localStorage.getItem('shard-vaults');
      if (cached) {
        const { ts } = JSON.parse(cached);
        if (Date.now() - ts < 10 * 60 * 1000) hasCache = true;
      }
    } catch {}
    if (!hasCache) _showLoading('Loading vaults...');
    try {
      await _loadVaults();
    } finally {
      _hideLoading();
    }
  } else {
    // Still refresh vaults in background but don't block UI
    _loadVaults().catch(() => {});
  }

  document.getElementById('tool-shard-btn')?.classList.add('active');
  document.addEventListener('keydown', _shardKeyHandler);
}

export function closePanel() {
  const modal = document.getElementById('shard-modal');
  console.log('[shard] closePanel called; _open=', _open, 'modal=', !!modal);
  if (!modal || !_open) return;
  // Don't close if quick switcher or command palette is open — close those first
  if (_quickSwitcherEl) { _hideQuickSwitcher(); return; }
  if (_commandPaletteEl) { _hideCommandPalette(); return; }
  _open = false;
  _rootDropWired = false;
  modal.classList.add('hidden');
  document.getElementById('tool-shard-btn')?.classList.remove('active');
  document.removeEventListener('keydown', _shardKeyHandler);
  _hideQuickSwitcher();
  _hideCommandPalette();
}

export function togglePanel() {
  console.log('[shard] togglePanel; _open=', _open);
  if (_open) closePanel(); else openPanel();
}

// Wire close button immediately at module load (module scripts are deferred,
// so the DOM element already exists). Use capture phase so the handler
// fires before windowDrag's synthetic-click swallow listener.
document.getElementById('close-shard-modal')?.addEventListener('click', () => closePanel(), true);

// Keep _open in sync when the modal is hidden via backdrop click (ui.js
// adds .hidden directly without calling our closePanel).
document.getElementById('shard-modal')?.addEventListener('mousedown', (e) => {
  if (e.target === e.currentTarget && _open) {
    console.log('[shard] backdrop click detected, syncing _open');
    closePanel();
  }
});

export function isOpen() { return _open; }

function _bringToFront() {
  const modal = document.getElementById('shard-modal');
  if (!modal) return;
  const z = 260;
  modal.style.zIndex = z;
}

function _enterShardFullscreen(content) {
  const modal = document.getElementById('shard-modal');
  if (!modal || !content) return;
  if (modal.classList.contains('shard-fullscreen')) return;
  modal.classList.add('shard-fullscreen');
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
  try { localStorage.setItem('shard-pos', JSON.stringify({ fullscreen: true })); } catch {}
}

function _exitShardFullscreen(content, cx, cy) {
  const modal = document.getElementById('shard-modal');
  if (!modal || !content) return;
  if (!modal.classList.contains('shard-fullscreen')) return;
  modal.classList.remove('shard-fullscreen');
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
  const modal = document.getElementById('shard-modal');
  const content = modal?.querySelector('.modal-content');
  const header = modal?.querySelector('.modal-header');
  if (!modal || !content || !header) return;
  _dragWired = true;

  try {
    makeWindowDraggable(modal, {
      content,
      header,
      fsClass: 'shard-fullscreen',
      enableDock: true,
      enableLeftDock: true,
      onEnterFullscreen: () => _enterShardFullscreen(content),
      onExitFullscreen: (cx, cy) => _exitShardFullscreen(content, cx, cy),
      onDragEnd: () => {
        try {
          localStorage.setItem('shard-pos', JSON.stringify({ left: content.style.left, top: content.style.top }));
        } catch {}
      },
    });
  } catch (e) {
    console.warn('[shard] makeWindowDraggable failed:', e);
  }

  // Note tab bar — event delegation for tab switching, closing, and new tab
  document.getElementById('shard-note-tabs')?.addEventListener('click', (e) => {
    const newBtn = e.target.closest('.shard-tab-new');
    if (newBtn) {
      _showNewNotePrompt();
      return;
    }
    const closeBtn = e.target.closest('.shard-tab-close');
    const tabBtn = e.target.closest('.shard-tab');
    if (!tabBtn) return;
    const noteId = tabBtn.dataset.noteId;
    if (closeBtn && noteId) {
      e.stopPropagation();
      _openTabs = _openTabs.filter(id => id !== noteId);
      if (_selectedNoteId === noteId) {
        if (_openTabs.length > 0) {
          _navigateToNote(_openTabs[_openTabs.length - 1], false);
        } else {
          _closeCurrentTab();
        }
      } else {
        _renderNoteTabs();
      }
      return;
    }
    if (noteId && noteId !== _selectedNoteId) {
      _selectedNoteId = noteId;
      _renderNoteTabs();
      const note = _notes.find(n => n.id === noteId);
      if (note) {
        _renderBreadcrumb(note);
        _selectNote(noteId);
      }
    }
  });

  // Tab bar drag-and-drop
  const tabBar = document.getElementById('shard-note-tabs');
  if (tabBar) {
    let dragCounter = 0;
    tabBar.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      tabBar.style.background = 'color-mix(in srgb, var(--accent, var(--red, #4a9eff)) 10%, transparent)';
    });
    tabBar.addEventListener('dragleave', () => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        tabBar.style.background = '';
      }
    });
    tabBar.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    tabBar.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      tabBar.style.background = '';
      const noteId = e.dataTransfer.getData('text/plain');
      if (!noteId) return;
      const note = _notes.find(n => n.id === noteId);
      if (!note) return;
      const droppedOnTab = e.target.closest('.shard-tab');
      if (droppedOnTab) {
        // Dropped on existing tab: replace that tab's note
        const existingId = droppedOnTab.dataset.noteId;
        if (existingId && existingId !== noteId) {
          const idx = _openTabs.indexOf(existingId);
          if (idx !== -1) {
            _openTabs[idx] = noteId;
          }
          _navigateToNote(noteId, false);
        }
      } else {
        // Dropped in empty space: open as new tab
        _navigateToNote(noteId, true, true);
      }
    });
  }

  // Back / Forward navigation
  document.getElementById('shard-back-btn')?.addEventListener('click', _goBack);
  document.getElementById('shard-forward-btn')?.addEventListener('click', _goForward);

  // Search — debounced backend fetch that updates the tree
  const searchInput = document.getElementById('shard-search');
  if (searchInput) {
    let searchDebounce;
    searchInput.addEventListener('input', (e) => {
      _searchQuery = e.target.value;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(async () => {
        await _loadNotes();
        _renderFolderTree();
      }, 300);
    });
  }

  // Vault management
  document.getElementById('shard-save-vault-btn')?.addEventListener('click', _saveNewVault);
  document.getElementById('shard-cancel-vault-btn')?.addEventListener('click', _hideAddVaultForm);

  // Browse button — use File System Access API when available, else file input
  const browseBtn = document.getElementById('shard-browse-vault-btn');
  const fileInput = document.getElementById('shard-vault-file-input');
  if (browseBtn && fileInput) {
    browseBtn.addEventListener('click', async () => {
      if (window.showDirectoryPicker) {
        try {
          const handle = await window.showDirectoryPicker();
          const pathInput = document.getElementById('shard-new-vault-path');
          if (pathInput) pathInput.value = handle.name;
        } catch (err) {
          if (err.name !== 'AbortError') console.warn('[shard] directory picker failed:', err);
        }
        return;
      }
      // Fallback: legacy file input (webkitdirectory)
      fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
      const files = e.target.files;
      if (!files || !files.length) return;
      const pathInput = document.getElementById('shard-new-vault-path');
      const relPath = files[0].webkitRelativePath || '';
      const folderName = relPath.split('/')[0] || '';
      const fullPath = files[0].path || '';
      const displayPath = fullPath || folderName;
      if (pathInput && displayPath) pathInput.value = displayPath;
      e.target.value = '';
    });
  }

  _wireVaultDropdown();

  // Permissions button
  document.getElementById('shard-vault-perm-btn')?.addEventListener('click', () => {
    _switchTab('permissions');
  });

  // Permission management
  document.getElementById('shard-vault-read-all')?.addEventListener('change', _updateVaultToggles);
  document.getElementById('shard-vault-write-all')?.addEventListener('change', _updateVaultToggles);
  document.getElementById('shard-add-perm-btn')?.addEventListener('click', _addPermission);

  // Refresh button
  document.getElementById('shard-refresh-btn')?.addEventListener('click', _refreshVault);

  // Connect / Disconnect (legacy - keep for compatibility)
  document.getElementById('shard-connect-btn')?.addEventListener('click', _connectVault);
  document.getElementById('shard-disconnect-btn')?.addEventListener('click', _disconnectVault);

  // Resize panes
  _wireResizeHandles();

  // Mode icon custom tooltip
  const modeIcon = document.getElementById('shard-mode-icon');
  if (modeIcon) {
    modeIcon.addEventListener('mouseenter', () => _showModeTooltip(modeIcon));
    modeIcon.addEventListener('mouseleave', _hideModeTooltip);
  }
}

// ── Vault Management ───────────────────────────────────────

async function _loadVaults() {
  try {
    // Restore from cache first
    try {
      const cached = localStorage.getItem('shard-vaults');
      if (cached) {
        const { vaults, ts } = JSON.parse(cached);
        if (Date.now() - ts < 10 * 60 * 1000) {
          _vaults = vaults;
          _populateVaultDropdown();
          if (_vaults.length > 0 && !_selectedVaultId) {
            let lastVault = null;
            try { lastVault = localStorage.getItem('shard-last-vault'); } catch {}
            const target = _vaults.find(v => v.id === lastVault) ? lastVault : _vaults[0].id;
            _selectVault(target);
          }
        }
      }
    } catch {}
    const r = await fetch(`${API_BASE}/api/shard/status`, { credentials: 'same-origin' });
    const s = r.ok ? await r.json() : {};
    _vaults = s.vaults || [];
    try { localStorage.setItem('shard-vaults', JSON.stringify({ vaults: _vaults, ts: Date.now() })); } catch {}
    _populateVaultDropdown();
    if (_vaults.length > 0 && !_selectedVaultId) {
      let lastVault = null;
      try { lastVault = localStorage.getItem('shard-last-vault'); } catch {}
      const target = _vaults.find(v => v.id === lastVault) ? lastVault : _vaults[0].id;
      _selectVault(target);
    }
  } catch (e) {
    console.error('[shard] load vaults failed', e);
    // Keep cached vaults if fetch fails
    if (!_vaults.length) _vaults = [];
  }
}

function _populateVaultDropdown() {
  const menu = document.getElementById('shard-vault-dropdown-menu');
  const label = document.getElementById('shard-vault-dropdown-label');
  if (!menu) return;

  const vault = _vaults.find(v => v.id === _selectedVaultId);
  const noteCount = _notes.length;
  if (label) label.textContent = vault ? `${_esc(vault.name)} (${noteCount})` : 'Select vault...';

  let html = '';
  if (!_vaults.length) {
    html = '<div class="shard-vault-dropdown-item" style="opacity:0.5;cursor:default;"><span class="vault-name">No vaults</span></div>';
  } else {
    html = _vaults.map(v => `
      <div class="shard-vault-dropdown-item ${_selectedVaultId === v.id ? 'selected' : ''}" data-id="${v.id}">
        <span class="vault-name">${_esc(v.name)} <span style="opacity:0.5;font-size:11px;">(${v.note_count || 0})</span></span>
        <button class="vault-menu-btn" data-id="${v.id}" title="Vault options" aria-label="Vault options">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
        </button>
      </div>
    `).join('');
  }

  html += `
    <div class="shard-vault-dropdown-item shard-vault-dropdown-add" id="shard-add-vault-item">
      <span class="vault-name">+ Add new vault</span>
    </div>
  `;
  menu.innerHTML = html;

  document.getElementById('shard-add-vault-item')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _closeVaultDropdown();
    _showAddVaultForm();
  });

  // Wire vault selection
  menu.querySelectorAll('.shard-vault-dropdown-item:not(.shard-vault-dropdown-add)').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.vault-menu-btn')) return;
      _closeVaultDropdown();
      _selectVault(item.dataset.id);
      try { localStorage.setItem('shard-last-vault', item.dataset.id); } catch {}
    });
  });

  // Wire three-dot menu buttons
  menu.querySelectorAll('.vault-menu-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _closeVaultDropdown();
      _openVaultDialog(btn.dataset.id);
    });
  });
}

function _wireVaultDropdown() {
  const wrap = document.getElementById('shard-vault-dropdown-wrap');
  const trigger = document.getElementById('shard-vault-dropdown-trigger');
  if (!trigger || !wrap) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('shard-vault-dropdown-menu');
    if (!menu) return;
    const isHidden = menu.classList.contains('hidden');
    if (isHidden) {
      _populateVaultDropdown();
      menu.classList.remove('hidden');
      wrap.classList.add('open');
    } else {
      _closeVaultDropdown();
    }
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) _closeVaultDropdown();
  });
}

function _closeVaultDropdown() {
  const menu = document.getElementById('shard-vault-dropdown-menu');
  const wrap = document.getElementById('shard-vault-dropdown-wrap');
  if (menu) menu.classList.add('hidden');
  if (wrap) wrap.classList.remove('open');
}

async function _selectVault(vaultId) {
  _selectedVaultId = vaultId;
  _selectedFolder = null;
  _searchQuery = '';
  _historyStack = [];
  _historyIndex = -1;
  _selectedNoteId = null;
  _noteContentCache.clear();
  _renderNoteTabs();
  _renderBreadcrumb(null);
  _updateNavButtons();
  const preview = document.getElementById('shard-preview');
  if (preview) { preview.innerHTML = ''; preview.style.display = 'none'; }
  const rightPane = document.getElementById('shard-right-pane');
  if (rightPane) {
    rightPane.querySelector('#shard-right-placeholder')?.classList.remove('hidden');
    document.getElementById('shard-right-tabs')?.classList.add('hidden');
    document.getElementById('shard-right-panes')?.classList.add('hidden');
  }
  const searchInput = document.getElementById('shard-search');
  if (searchInput) searchInput.value = '';
  const vault = _vaults.find(v => v.id === vaultId);
  const mainPanel = document.getElementById('shard-main-panel');
  const folderTree = document.getElementById('shard-folder-tree');

  _populateVaultDropdown();
  _hideAddVaultForm();

  if (!vault) {
    if (mainPanel) mainPanel.classList.add('hidden');
    if (folderTree) folderTree.classList.add('hidden');
    _notes = [];
    _folders = [];
    _renderNoteList();
    if (folderTree) folderTree.innerHTML = '';
    return;
  }

  if (mainPanel) mainPanel.classList.remove('hidden');
  if (folderTree) folderTree.classList.remove('hidden');

  // Update permission toggles
  const readCb = document.getElementById('shard-vault-read-all');
  const writeCb = document.getElementById('shard-vault-write-all');
  if (readCb) readCb.checked = vault.read_enabled;
  if (writeCb) writeCb.checked = vault.write_enabled;

  // Restore from cache immediately if available, then fetch fresh data in background
  const hadCachedNotes = _restoreCachedNotes(vaultId);
  const hadCachedFolders = _restoreCachedFolders(vaultId);
  if (!hadCachedNotes || !hadCachedFolders) _showLoading('Loading notes...');
  try {
    await _loadNotes();
    await _loadFolders();
    _loadPermissions();
  } finally {
    _hideLoading();
  }
}

// ── Folder Tree ──────────────────────────────────────────────

let _folders = [];

function _restoreCachedFolders(vaultId) {
  try {
    const cached = localStorage.getItem(`shard-folders-${vaultId}`);
    if (cached) {
      const { folders, ts } = JSON.parse(cached);
      if (Date.now() - ts < 10 * 60 * 1000) {
        _folders = folders;
        _renderFolderTree();
        return true;
      }
    }
  } catch {}
  return false;
}

async function _loadFolders() {
  if (!_selectedVaultId) return;
  try {
    const r = await fetch(`${API_BASE}/api/shard/folders?vault_id=${encodeURIComponent(_selectedVaultId)}`, { credentials: 'same-origin' });
    if (!r.ok) return;
    const data = await r.json();
    _folders = data.folders || [];
    _renderFolderTree();
    try {
      localStorage.setItem(`shard-folders-${_selectedVaultId}`, JSON.stringify({ folders: _folders, ts: Date.now() }));
    } catch {}
  } catch (e) {
    console.error('[shard] load folders failed', e);
    _folders = [];
    _renderFolderTree();
  }
}

function _buildFolderTree(paths) {
  const root = { name: '', path: '', children: {}, files: [] };
  for (const raw of paths) {
    if (!raw) continue;
    // Normalize Windows backslashes to forward slashes
    const p = raw.replace(/\\/g, '/');
    const parts = p.split('/').filter(Boolean);
    let node = root;
    for (const part of parts) {
      if (!node.children[part]) node.children[part] = { name: part, path: (node.path ? node.path + '/' : '') + part, children: {}, files: [] };
      node = node.children[part];
    }
  }
  return root;
}

function _sortTreeEntries(node) {
  const childNames = Object.keys(node.children).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const files = [...node.files].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  return { childNames, files };
}

function _renderFolderTreeNode(node, depth = 0) {
  const isExpanded = _expandedFolders.has(node.path);
  const hasChildren = Object.keys(node.children).length > 0;
  const hasFiles = node.files.length > 0;
  const isEmpty = !hasChildren && !hasFiles;
  const isSelected = _selectedFolder === node.path;
  const arrowClass = isExpanded ? 'expanded' : (isEmpty ? 'leaf' : '');
  const depthClass = depth > 0 ? 'sub' : 'root';
  const liClass = `shard-tree-${depthClass}${isExpanded ? ' expanded' : ''}`;

  let html = '';
  if (node.name) {
    html += `<li class="${liClass}">
      <div class="shard-tree-row ${depthClass} ${isSelected ? 'selected' : ''}" data-folder="${_esc(node.path)}">
        <span class="shard-tree-arrow ${arrowClass}"></span>
        <span class="shard-tree-name">${_esc(node.name)}</span>
      </div>`;
  }

  // Always render <ul> so CSS grid-template-rows transition works
  if (hasChildren || hasFiles) {
    html += '<ul>';
    const { childNames, files } = _sortTreeEntries(node);
    for (const childName of childNames) {
      html += _renderFolderTreeNode(node.children[childName], depth + 1);
    }
    for (const f of files) {
      html += `<li class="shard-tree-sub">
        <div class="shard-tree-row sub ${f.id === _selectedNoteId ? 'selected' : ''}" data-note-id="${_esc(f.id)}" draggable="true">
          <span class="shard-tree-arrow leaf"></span>
          <span class="shard-tree-name">${_esc(f.title)}</span>
        </div>
      </li>`;
    }
    html += '</ul>';
  }
  if (node.name) html += '</li>';
  return html;
}

function _renderFolderTree() {
  const tree = document.getElementById('shard-folder-tree');
  if (!tree) return;

  console.log('[shard] _renderFolderTree — _folders:', _folders.length, '_notes:', _notes.length);

  // Build tree from folders, then attach notes
  const root = _buildFolderTree(_folders);
  for (const n of _notes) {
    const folder = (n.folder || '').replace(/\\/g, '/');
    let node = root;
    const parts = folder.split('/').filter(Boolean);
    for (const part of parts) {
      if (!node.children[part]) {
        node.children[part] = { name: part, path: (node.path ? node.path + '/' : '') + part, children: {}, files: [] };
      }
      node = node.children[part];
    }
    node.files.push(n);
  }

  // If absolutely nothing to show, show a message
  const hasAny = Object.keys(root.children).length > 0 || root.files.length > 0;
  if (!hasAny) {
    tree.innerHTML = '<div style="padding:8px;text-align:center;opacity:0.5;font-size:11px;">No folders</div>';
    return;
  }

  let html = '<ul>';
  const { childNames } = _sortTreeEntries(root);
  for (const childName of childNames) {
    html += _renderFolderTreeNode(root.children[childName]);
  }
  // Root-level files (notes with no folder)
  const rootFiles = [...root.files].sort((a, b) => a.title.localeCompare(b.title));
  for (const f of rootFiles) {
    html += `<li class="shard-tree-root">
      <div class="shard-tree-row root ${f.id === _selectedNoteId ? 'selected' : ''}" data-note-id="${_esc(f.id)}" draggable="true">
        <span class="shard-tree-arrow leaf"></span>
        <span class="shard-tree-name">${_esc(f.title)}</span>
      </div>
    </li>`;
  }
  html += '</ul>';
  tree.innerHTML = html;

  // Wire interactions — toggle classes directly for smooth animation (no re-render)
  tree.querySelectorAll('.shard-tree-row').forEach(row => {
    row.addEventListener('click', (e) => {
      // Note click
      if (row.dataset.noteId) {
        _navigateToNote(row.dataset.noteId, true, e.ctrlKey || e.metaKey);
        _updateTreeSelection();
        return;
      }
      // Folder click — toggles expansion (whole row is clickable, arrow is visual only)
      const folder = row.dataset.folder;
      if (folder) {
        const li = row.closest('li');
        const arrow = row.querySelector('.shard-tree-arrow');
        const isLeaf = arrow?.classList.contains('leaf');
        if (!isLeaf && li) {
          const nowExpanded = li.classList.toggle('expanded');
          arrow?.classList.toggle('expanded', nowExpanded);
          if (nowExpanded) _expandedFolders.add(folder);
          else _expandedFolders.delete(folder);
        }
        _selectedFolder = folder;
        _updateTreeSelection();
        _renderNoteList();
      }
    });

    // Drag start for note rows
    if (row.dataset.noteId) {
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', row.dataset.noteId);
        e.dataTransfer.effectAllowed = 'copy';
        tree.classList.add('shard-dragging');
      });
      row.addEventListener('dragend', () => {
        tree.classList.remove('shard-dragging');
        tree.classList.remove('shard-root-drag-over');
      });
    }

    // Drop target for folder rows
    if (row.dataset.folder) {
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over');
      });
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drag-over');
        const noteId = e.dataTransfer.getData('text/plain');
        const folder = row.dataset.folder;
        if (!noteId || !folder) return;
        // Optimistic UI: update _notes in memory immediately
        const note = _notes.find(n => n.id === noteId);
        const oldFolder = note ? note.folder : '';
        if (note) note.folder = folder;
        _renderFolderTree();
        try {
          const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(noteId)}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ folder }),
          });
          if (!r.ok) {
            // Revert optimistic update on failure
            if (note) note.folder = oldFolder;
            _renderFolderTree();
            const data = await r.json().catch(() => ({}));
            console.error('[shard] move note failed:', data.detail || r.status);
          }
        } catch (err) {
          // Revert optimistic update on error
          if (note) note.folder = oldFolder;
          _renderFolderTree();
          console.error('[shard] move note error:', err);
        }
      });
    }

    // Right-click context menus
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (row.dataset.noteId) {
        _showFileContextMenu(e, row.dataset.noteId);
      } else if (row.dataset.folder) {
        _showFolderContextMenu(e, row.dataset.folder);
      }
    });
  });

  // Blank area context menu on the tree itself
  tree.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.shard-tree-row')) return;
    e.preventDefault();
    e.stopPropagation();
    _showBlankContextMenu(e);
  });

  // Root drop target: dropping on empty space in the tree moves to root
  if (!_rootDropWired) {
    _rootDropWired = true;
    tree.addEventListener('dragover', (e) => {
      // Only handle if not over a folder row (those have their own handlers)
      if (e.target.closest('.shard-tree-row[data-folder]')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      tree.classList.add('shard-root-drag-over');
    });
    tree.addEventListener('dragleave', (e) => {
      if (e.target.closest('.shard-tree-row[data-folder]')) return;
      tree.classList.remove('shard-root-drag-over');
    });
    tree.addEventListener('drop', async (e) => {
      // Only handle if dropped on empty space (not on a folder row)
      if (e.target.closest('.shard-tree-row[data-folder]')) return;
      e.preventDefault();
      tree.classList.remove('shard-root-drag-over');
      const noteId = e.dataTransfer.getData('text/plain');
      if (!noteId) return;
      // Optimistic UI: move to root
      const note = _notes.find(n => n.id === noteId);
      const oldFolder = note ? note.folder : '';
      if (note) note.folder = '';
      _renderFolderTree();
      try {
        const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(noteId)}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ folder: '' }),
        });
        if (!r.ok) {
          if (note) note.folder = oldFolder;
          _renderFolderTree();
          const data = await r.json().catch(() => ({}));
          console.error('[shard] move to root failed:', data.detail || r.status);
        }
      } catch (err) {
        if (note) note.folder = oldFolder;
        _renderFolderTree();
        console.error('[shard] move to root error:', err);
      }
    });
  }
}

function _updateTreeSelection() {
  const tree = document.getElementById('shard-folder-tree');
  if (!tree) return;
  tree.querySelectorAll('.shard-tree-row').forEach(row => {
    const shouldSelect = row.dataset.folder === _selectedFolder || row.dataset.noteId === _selectedNoteId;
    row.classList.toggle('selected', shouldSelect);
  });
}

function _showAddVaultForm() {
  const form = document.getElementById('shard-add-vault-form');
  if (form) {
    form.classList.remove('hidden');
    // Clear inputs
    const nameInput = document.getElementById('shard-new-vault-name');
    const pathInput = document.getElementById('shard-new-vault-path');
    if (nameInput) nameInput.value = '';
    if (pathInput) pathInput.value = '';
  }
  const hint = document.getElementById('shard-browse-hint');
  if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
}

function _hideAddVaultForm() {
  document.getElementById('shard-add-vault-form')?.classList.add('hidden');
  const status = document.getElementById('shard-add-vault-status');
  if (status) status.textContent = '';
}

async function _saveNewVault() {
  const nameInput = document.getElementById('shard-new-vault-name');
  const pathInput = document.getElementById('shard-new-vault-path');
  const statusEl = document.getElementById('shard-add-vault-status');
  const name = nameInput?.value.trim();
  const path = pathInput?.value.trim();
  if (!path) { if (statusEl) statusEl.textContent = 'Enter a vault path'; return; }

  if (statusEl) statusEl.textContent = 'Connecting...';
  _showLoading('Adding vault...');
  try {
    const r = await fetch(`${API_BASE}/api/shard/connect`, {
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
      if (data.vault_id) await _selectVault(data.vault_id);
    } else {
      if (statusEl) statusEl.textContent = data.detail || 'Connection failed';
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Connection error';
  } finally {
    _hideLoading();
  }
}

// ── Legacy single-vault connect/disconnect (kept for compatibility) ──

async function _connectVault() {
  const pathInput = document.getElementById('shard-vault-path');
  const statusEl = document.getElementById('shard-connect-status');
  const path = pathInput?.value.trim();
  if (!path) { if (statusEl) statusEl.textContent = 'Enter a vault path'; return; }

  if (statusEl) statusEl.textContent = 'Connecting...';
  try {
    const r = await fetch(`${API_BASE}/api/shard/connect`, {
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
    await fetch(`${API_BASE}/api/shard/disconnect`, { method: 'POST', credentials: 'same-origin' });
    _selectedVaultId = null;
    await _loadVaults();
  } catch (e) { /* ignore */ }
}

async function _removeVault(vaultId) {
  const vault = _vaults.find(v => v.id === vaultId);
  if (!vault) return;
  if (!confirm(`Remove vault "${_esc(vault.name)}" from Odysseus?\n\nNotes stay on disk. This only removes the connection.`)) return;
  try {
    const r = await fetch(`${API_BASE}/api/shard/vaults/${encodeURIComponent(vaultId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (r.ok) {
      if (_selectedVaultId === vaultId) _selectedVaultId = null;
      await _loadVaults();
    }
  } catch (e) {
    console.error('[shard] remove vault failed', e);
  }
}

// ── Tabs ───────────────────────────────────────────────────

function _switchTab(tab) {
  _activeTab = tab;
  _renderNoteTabs();
  document.querySelectorAll('[data-shard-content]').forEach(p => {
    const isActive = p.dataset.shardContent === tab;
    p.classList.toggle('hidden', !isActive);
  });
  if (tab === 'permissions') _renderPermissions();
}

function _navigateToNote(noteId, addToHistory = true, openNewTab = false) {
  const note = _notes.find(n => n.id === noteId);
  if (!note) return;
  if (!_openTabs.includes(noteId)) {
    if (openNewTab) {
      _openTabs.push(noteId);
    } else {
      // Replace current tab if not opening new
      if (_selectedNoteId && _openTabs.includes(_selectedNoteId)) {
        const idx = _openTabs.indexOf(_selectedNoteId);
        _openTabs[idx] = noteId;
      } else {
        _openTabs.push(noteId);
      }
    }
  }
  _selectedNoteId = noteId;
  _activeTab = 'note';
  if (addToHistory) {
    if (_historyIndex < _historyStack.length - 1) {
      _historyStack = _historyStack.slice(0, _historyIndex + 1);
    }
    if (_historyStack[_historyIndex] !== noteId) {
      _historyStack.push(noteId);
      _historyIndex++;
    }
  }
  _renderNoteTabs();
  _renderBreadcrumb(note);
  _updateNavButtons();
  document.querySelectorAll('[data-shard-content]').forEach(p => {
    p.classList.toggle('hidden', p.dataset.shardContent !== 'note');
  });
  _renderFolderTree();
  _updateTreeSelection();
  _selectNote(noteId);
}

function _goBack() {
  if (_historyIndex > 0) {
    _historyIndex--;
    _navigateToNote(_historyStack[_historyIndex], false);
  }
}

function _goForward() {
  if (_historyIndex < _historyStack.length - 1) {
    _historyIndex++;
    _navigateToNote(_historyStack[_historyIndex], false);
  }
}

function _updateModeIcon() {
  const icon = document.getElementById('shard-mode-icon');
  if (!icon) return;
  const penSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  const eyeSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const codeSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
  if (_previewMode === 'preview') {
    icon.innerHTML = eyeSvg;
  } else if (_previewMode === 'live') {
    icon.innerHTML = penSvg;
  } else {
    icon.innerHTML = codeSvg;
  }
}

let _modeTooltipEl = null;
function _ensureModeTooltip() {
  if (_modeTooltipEl) return _modeTooltipEl;
  _modeTooltipEl = document.createElement('div');
  _modeTooltipEl.className = 'shard-mode-tooltip';
  document.body.appendChild(_modeTooltipEl);
  return _modeTooltipEl;
}
function _showModeTooltip(icon) {
  const tip = _ensureModeTooltip();
  const current = _previewMode === 'preview' ? 'Reading' : _previewMode === 'live' ? 'Live Preview' : 'Source';
  const target  = _previewMode === 'preview' ? (_editModePref === 'edit' ? 'Source' : 'Live Preview') : 'Reading';
  tip.innerHTML = `<div class="shard-tooltip-line"><strong>Current View:</strong> ${current}</div><div class="shard-tooltip-line">Click for: ${target}</div>`;
  tip.style.display = 'block';
  const rect = icon.getBoundingClientRect();
  const tRect = tip.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tRect.width / 2;
  let top = rect.bottom + 6;
  if (left < 4) left = 4;
  if (left + tRect.width > window.innerWidth - 4) left = window.innerWidth - tRect.width - 4;
  if (top + tRect.height > window.innerHeight - 4) top = rect.top - tRect.height - 6;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
function _hideModeTooltip() {
  if (_modeTooltipEl) _modeTooltipEl.style.display = 'none';
}

function _closeCurrentTab() {
  if (_selectedNoteId) {
    _openTabs = _openTabs.filter(id => id !== _selectedNoteId);
  }
  if (_openTabs.length > 0) {
    const nextId = _openTabs[_openTabs.length - 1];
    _selectedNoteId = nextId;
    const note = _notes.find(n => n.id === nextId);
    if (note) {
      _renderNoteTabs();
      _renderBreadcrumb(note);
      _updateNavButtons();
      _selectNote(nextId);
      return;
    }
  }
  _selectedNoteId = null;
  _historyStack = [];
  _historyIndex = -1;
  document.getElementById('shard-preview').innerHTML = '';
  document.getElementById('shard-preview').style.display = 'none';
  const modeIcon = document.getElementById('shard-mode-icon');
  if (modeIcon) modeIcon.style.display = 'none';
  const noteMenuBtn = document.getElementById('shard-note-menu-btn');
  if (noteMenuBtn) noteMenuBtn.style.display = 'none';
  const rightPane = document.getElementById('shard-right-pane');
  if (rightPane) {
    rightPane.querySelector('#shard-right-placeholder')?.classList.remove('hidden');
    document.getElementById('shard-right-tabs')?.classList.add('hidden');
    document.getElementById('shard-right-panes')?.classList.add('hidden');
  }
  _renderNoteTabs();
  _renderBreadcrumb(null);
  _updateNavButtons();
}

function _renderNoteTabs() {
  const bar = document.getElementById('shard-note-tabs');
  if (!bar) return;
  if (!_openTabs.length) {
    bar.innerHTML = `<button class="shard-tab-new" title="New note">+</button>`;
    return;
  }
  const html = _openTabs.map(noteId => {
    const note = _notes.find(n => n.id === noteId);
    const title = _esc(note ? note.title : noteId);
    const active = noteId === _selectedNoteId ? 'active' : '';
    return `<button class="shard-tab ${active}" data-note-id="${_esc(noteId)}" title="${title}">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;min-width:0;text-align:left;">${title}</span>
      <span class="shard-tab-close" data-note-id="${_esc(noteId)}">&times;</span>
    </button>`;
  }).join('');
  bar.innerHTML = html + `<button class="shard-tab-new" title="New note">+</button>`;
}

async function _showNewNotePrompt() {
  // Auto-generate "new note.md", "new note 1.md", etc.
  let baseName = 'new note';
  let name = `${baseName}.md`;
  let counter = 1;
  while (_notes.some(n => n.id === name || n.rel_path === name || n.title === baseName || n.title === name.replace(/\.md$/, ''))) {
    baseName = `new note ${counter}`;
    name = `${baseName}.md`;
    counter++;
  }
  try {
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(name)}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
      credentials: 'same-origin'
    });
    if (r.ok) {
      await _loadNotes();
      await _loadFolders();
      _renderFolderTree();
      const note = _notes.find(n => n.id === name || n.rel_path === name);
      if (note) _navigateToNote(note.id, true, true);
    } else {
      const data = await r.json().catch(() => ({}));
      console.error('[shard] create note failed:', data.detail || r.status);
    }
  } catch (e) {
    console.error('[shard] create note failed', e);
  }
}

function _renderBreadcrumb(note) {
  const el = document.getElementById('shard-breadcrumb');
  if (!el) return;
  if (!note) {
    el.innerHTML = '';
    return;
  }
  const parts = (note.folder || '').split('/').filter(Boolean);
  const pathParts = parts.map((part, i) => {
    const path = parts.slice(0, i + 1).join('/');
    return `<span class="shard-breadcrumb-part" data-folder="${_esc(path)}">${_esc(part)}</span>`;
  }).join('<span class="shard-breadcrumb-sep">/</span>');
  const title = `<span class="shard-breadcrumb-current">${_esc(note.title)}</span>`;
  const sep = parts.length ? '<span class="shard-breadcrumb-sep">/</span>' : '';
  el.innerHTML = (pathParts ? pathParts + sep : '') + title;
  el.querySelectorAll('.shard-breadcrumb-part').forEach(p => {
    p.addEventListener('click', () => {
      _selectedFolder = p.dataset.folder;
      _renderFolderTree();
    });
  });
}

function _updateNavButtons() {
  const back = document.getElementById('shard-back-btn');
  const forward = document.getElementById('shard-forward-btn');
  if (back) back.disabled = _historyIndex <= 0;
  if (forward) forward.disabled = _historyIndex >= _historyStack.length - 1;
}

// ── Left sidebar tabs ──────────────────────────────────────

let _activeLeftTab = 'files';

function _switchLeftTab(tab) {
  _activeLeftTab = tab;
  document.querySelectorAll('#shard-left-tabs .shard-sidebar-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.shard-sidebar-pane').forEach(pane => {
    pane.classList.toggle('hidden', pane.dataset.pane !== tab);
  });

  const _disabled = (paneId) => {
    const el = document.getElementById('shard-' + paneId + '-pane');
    if (el) el.innerHTML = '<div style="padding:12px;text-align:center;opacity:0.5;font-size:12px;">Plugin disabled.<br>Enable it in Settings > Core Plugins.</div>';
  };

  if (tab === 'tags') {
    if (_pluginManager?.isEnabled('tags')) _renderTagsPane();
    else _disabled('tags');
  }
  if (tab === 'bookmarks') {
    if (_pluginManager?.isEnabled('bookmarks')) _renderBookmarksPane();
    else _disabled('bookmarks');
  }
  if (tab === 'search') {
    if (!_pluginManager?.isEnabled('search')) _disabled('search');
  }
}

// ── Right sidebar tabs ─────────────────────────────────────

let _activeRightTab = 'backlinks';

function _switchRightTab(tab) {
  _activeRightTab = tab;
  document.querySelectorAll('#shard-right-tabs .shard-right-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('#shard-right-panes .shard-right-pane-content').forEach(pane => {
    pane.classList.toggle('hidden', pane.dataset.pane !== tab);
  });
  // Re-render current note into the newly active tab if a note is selected
  if (_selectedNoteId && _noteContentCache?.has(_selectedNoteId)) {
    const note = _noteContentCache.get(_selectedNoteId);
    _renderRightSidebar(note);
  } else if (tab === 'orphans') {
    _renderOrphansPane();
  }
}

let _searchState = {
  caseSensitive: false,
  sortBy: 'name-asc',
  collapse: false,
  context: false,
  explain: true,
  fileStates: new Map(), // noteId -> boolean (true=collapsed, false=expanded); overrides default
  lastQuery: '',
};
let _searchHistoryTimer = null;

function _getSearchRegex(query, caseSensitive) {
  const flags = caseSensitive ? 'g' : 'gi';
  try {
    return new RegExp(_escRegExp(query), flags);
  } catch { return null; }
}
function _escRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _extractMatches(content, regex) {
  if (!content || !regex) return [];
  const lines = content.split('\n');
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (regex.test(line)) {
      matches.push({ line: i + 1, text: line });
      regex.lastIndex = 0; // reset for next line
    }
  }
  return matches;
}

function _highlightText(text, regex) {
  if (!regex) return _esc(text);
  return _esc(text).replace(regex, m => `<mark>${_esc(m)}</mark>`);
}

function _sortNotes(notes, sortBy) {
  const sorted = [...notes];
  const getTime = (note, field) => {
    const val = note[field];
    return val ? new Date(val).getTime() : 0;
  };
  switch (sortBy) {
    case 'name-asc': return sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    case 'name-desc': return sorted.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
    case 'modified-desc': return sorted.sort((a, b) => getTime(b, 'last_modified_src') - getTime(a, 'last_modified_src'));
    case 'modified-asc': return sorted.sort((a, b) => getTime(a, 'last_modified_src') - getTime(b, 'last_modified_src'));
    case 'created-desc': return sorted.sort((a, b) => getTime(b, 'created_at') - getTime(a, 'created_at'));
    case 'created-asc': return sorted.sort((a, b) => getTime(a, 'created_at') - getTime(b, 'created_at'));
    default: return sorted;
  }
}

function _renderSearchPane(query = '') {
  const resultsEl = document.getElementById('shard-search-results');
  const explainEl = document.getElementById('shard-search-explain-bar');
  const clearBtn = document.getElementById('shard-search-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !query.trim());
  if (!resultsEl) return;

  // Clear per-file overrides when search query changes
  if (query !== _searchState.lastQuery) {
    _searchState.fileStates.clear();
    _searchState.lastQuery = query;
  }

  if (!query.trim()) {
    if (explainEl) explainEl.classList.add('hidden');
    _toggleSearchEmpty(true);
    return;
  }
  _toggleSearchEmpty(false);

  // Parse tag: prefix
  let isTagSearch = false;
  let searchQuery = query;
  if (query.toLowerCase().startsWith('tag:')) {
    isTagSearch = true;
    searchQuery = query.slice(4).trim();
  }

  const regex = _getSearchRegex(searchQuery, _searchState.caseSensitive);
  const qLower = searchQuery.toLowerCase();

  let matches = _notes.filter(n => {
    if (isTagSearch) {
      return (n.tags || []).some(t => t.toLowerCase().includes(qLower));
    }
    if (_searchState.caseSensitive) {
      return (n.title || '').includes(searchQuery) || (n.content || '').includes(searchQuery);
    }
    return (n.title || '').toLowerCase().includes(qLower) || (n.content || '').toLowerCase().includes(qLower);
  });

  matches = _sortNotes(matches, _searchState.sortBy);

  // Update explain bar after matches are computed
  if (explainEl) {
    if (_searchState.explain) {
      explainEl.textContent = `${matches.length} results — Matches text: "${query}"`;
      explainEl.classList.remove('hidden');
    } else {
      explainEl.classList.add('hidden');
    }
  }

  if (!matches.length) {
    resultsEl.innerHTML = '<div style="padding:10px;text-align:center;opacity:0.5;font-size:12px;">No results</div>';
    return;
  }
  resultsEl.innerHTML = matches.map(n => {
    const fileMatches = isTagSearch ? [] : _extractMatches(n.content || '', regex);
    const matchCount = fileMatches.length;
    const override = _searchState.fileStates.get(n.id);
    const isCollapsed = override !== undefined ? override : _searchState.collapse;
    const chevron = isCollapsed ? '&#9654;' : '&#9660;';

    // Render matches (always build HTML; visibility controlled by display:none)
    // Cap at 15 per file to prevent lag on broad searches
    const MAX_MATCHES = 15;
    const displayedMatches = fileMatches.slice(0, MAX_MATCHES);
    const hiddenCount = fileMatches.length - MAX_MATCHES;
    let matchesHtml = '';
    if (matchCount > 0) {
      matchesHtml = displayedMatches.map(m => {
        const display = _searchState.context
          ? `<div class="shard-search-match raw">${_highlightText(m.text, regex)}</div>`
          : `<div class="shard-search-match">${_highlightText(m.text, regex)}</div>`;
        return display;
      }).join('');
      if (hiddenCount > 0) {
        matchesHtml += `<div style="padding:4px 8px;font-size:11px;opacity:0.5;">+${hiddenCount} more</div>`;
      }
    } else if (matchCount === 0 && !isTagSearch) {
      // Title-only match — show first few lines as context
      const preview = (n.content || '').split('\n').slice(0, 3).join('\n');
      matchesHtml = _searchState.context
        ? `<div class="shard-search-match raw">${_esc(preview)}</div>`
        : `<div class="shard-search-match">${_esc(preview.slice(0, 160))}</div>`;
    }

    return `<div class="shard-search-file">
      <div class="shard-search-file-header ${isCollapsed ? 'collapsed' : ''}" data-note-id="${_esc(n.id)}">
        <span class="shard-search-chevron">${chevron}</span>
        <span>${_esc(n.title)}</span>
        <span class="shard-search-file-count">${matchCount || (isTagSearch ? (n.tags || []).length : 0)}</span>
      </div>
      <div class="shard-search-matches" ${isCollapsed ? 'style="display:none"' : ''}>${matchesHtml}</div>
    </div>`;
  }).join('');

  // Wire click on headers (toggle collapse + navigate on title click)
  resultsEl.querySelectorAll('.shard-search-file-header').forEach(header => {
    header.addEventListener('click', (e) => {
      const noteId = header.dataset.noteId;
      // Click on chevron toggles collapse; click on title navigates
      const isChevron = e.target.closest('.shard-search-chevron');
      if (isChevron) {
        const matchesDiv = header.nextElementSibling;
        const wasCollapsed = matchesDiv.style.display === 'none';
        const nowCollapsed = !wasCollapsed;
        matchesDiv.style.display = wasCollapsed ? '' : 'none';
        header.classList.toggle('collapsed', nowCollapsed);
        const chevronEl = header.querySelector('.shard-search-chevron');
        chevronEl.innerHTML = wasCollapsed ? '&#9660;' : '&#9654;';
        _searchState.fileStates.set(noteId, nowCollapsed);
      } else {
        _navigateToNote(noteId);
      }
    });
  });

  // Debounced history add — only record after user stops typing for 2s
  clearTimeout(_searchHistoryTimer);
  _searchHistoryTimer = setTimeout(() => _addSearchHistory(query), 2000);

  // Right-click context menus on search results
  resultsEl.querySelectorAll('.shard-search-file-header').forEach(header => {
    header.addEventListener('contextmenu', (e) => {
      _showFileContextMenu(e, header.dataset.noteId);
    });
  });
}

// ── Search history ─────────────────────────────────────────

let _searchHistory = [];
try {
  const raw = localStorage.getItem('shard-search-history');
  if (raw) _searchHistory = JSON.parse(raw);
} catch {}

function _persistSearchHistory() {
  try { localStorage.setItem('shard-search-history', JSON.stringify(_searchHistory.slice(0, 20))); } catch {}
}

function _addSearchHistory(query) {
  const q = query.trim();
  if (!q || q.length < 2) return;
  _searchHistory = _searchHistory.filter(h => h !== q);
  _searchHistory.unshift(q);
  _persistSearchHistory();
}

function _renderSearchHistory() {
  const el = document.getElementById('shard-search-history');
  if (!el) return;
  if (!_searchHistory.length) {
    el.innerHTML = '<div style="padding:4px 6px;opacity:0.4;font-size:12px;">No recent searches</div>';
    return;
  }
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
      <span></span>
      <button class="shard-search-history-clear" title="Clear history" style="background:transparent;border:none;color:var(--fg);opacity:0.4;cursor:pointer;padding:2px;font-size:11px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  ` + _searchHistory.map(q =>
    `<div class="shard-search-history-item" data-query="${_esc(q)}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <span>${_esc(q)}</span>
    </div>`
  ).join('');
  el.querySelector('.shard-search-history-clear')?.addEventListener('click', () => {
    _searchHistory = [];
    _persistSearchHistory();
    _renderSearchHistory();
  });
  el.querySelectorAll('.shard-search-history-item').forEach(item => {
    item.addEventListener('click', () => {
      const input = document.getElementById('shard-search-input');
      if (input) {
        input.value = item.dataset.query;
        _renderSearchPane(item.dataset.query);
      }
    });
  });
}

function _toggleSearchEmpty(show) {
  const emptyEl = document.getElementById('shard-search-empty');
  if (emptyEl) emptyEl.classList.toggle('hidden', !show);
  if (show) _renderSearchHistory();
}

let _bookmarks = new Set();

try {
  const raw = localStorage.getItem('shard-bookmarks');
  if (raw) _bookmarks = new Set(JSON.parse(raw));
} catch {}

function _persistBookmarks() {
  try { localStorage.setItem('shard-bookmarks', JSON.stringify([..._bookmarks])); } catch {}
}

function _toggleBookmark(noteId) {
  if (_bookmarks.has(noteId)) _bookmarks.delete(noteId);
  else _bookmarks.add(noteId);
  _persistBookmarks();
  if (_activeLeftTab === 'bookmarks') _renderBookmarksPane();
}

function _renderBookmarksPane() {
  const el = document.getElementById('shard-bookmarks-list');
  if (!el) return;
  const items = [..._bookmarks].map(id => _notes.find(n => n.id === id)).filter(Boolean);
  if (!items.length) {
    el.innerHTML = '<div style="padding:10px;text-align:center;opacity:0.5;font-size:12px;">No bookmarks yet.<br>Right-click a note and select Bookmark.</div>';
    return;
  }
  el.innerHTML = items.map(n => `<div class="shard-bookmark-item" data-note-id="${_esc(n.id)}">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
    ${_esc(n.title)}
  </div>`).join('');
  el.querySelectorAll('.shard-bookmark-item').forEach(item => {
    item.addEventListener('click', () => _navigateToNote(item.dataset.noteId));
  });
}

function _renderTagsPane() {
  const el = document.getElementById('shard-tags-cloud');
  if (!el) return;
  const counts = {};
  _notes.forEach(n => {
    (n.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  });
  const tags = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!tags.length) {
    el.innerHTML = '<div style="padding:10px;text-align:center;opacity:0.5;font-size:12px;">No tags found.</div>';
    return;
  }
  el.innerHTML = tags.map(([tag, count]) =>
    `<span class="shard-tag-chip" data-tag="${_esc(tag)}">${_esc(tag)}<span class="shard-tag-count">${count}</span></span>`
  ).join('');
  el.querySelectorAll('.shard-tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      _searchQuery = chip.dataset.tag;
      document.getElementById('shard-search-input').value = 'tag:' + chip.dataset.tag;
      _switchLeftTab('search');
      _renderSearchPane('tag:' + chip.dataset.tag);
    });
  });
}

// ── Data ───────────────────────────────────────────────────

function _restoreCachedNotes(vaultId) {
  try {
    const cached = localStorage.getItem(`shard-notes-${vaultId}`);
    if (cached) {
      const { notes, ts } = JSON.parse(cached);
      if (Date.now() - ts < 10 * 60 * 1000) { // 10 min TTL
        _notes = notes;
        _noteCache = buildNoteCache(_notes);
        _renderNoteList();
        _populateVaultDropdown();
        return true;
      }
    }
  } catch {}
  return false;
}

async function _loadNotes() {
  const list = document.getElementById('shard-note-list');
  try {
    const qs = new URLSearchParams();
    if (_selectedVaultId) qs.set('vault_id', _selectedVaultId);
    if (_searchQuery) qs.set('q', _searchQuery);
    qs.set('limit', '9999');
    const r = await fetch(`${API_BASE}/api/shard/notes?${qs.toString()}`);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      if (list) list.innerHTML = `<div style="padding:20px;text-align:center;opacity:0.5;font-size:12px;">Error loading notes: ${d.detail || r.status}</div>`;
      _notes = [];
      return;
    }
    const data = await r.json();
    _notes = data.notes || [];
    _noteCache = buildNoteCache(_notes);
    _renderNoteList();
    _populateVaultDropdown();
    // Cache
    try {
      localStorage.setItem(`shard-notes-${_selectedVaultId}`, JSON.stringify({ notes: _notes, ts: Date.now() }));
    } catch {}
  } catch (e) {
    console.error('Shard load failed', e);
    if (list) list.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;font-size:12px;">Failed to load notes. Click Refresh to resync.</div>';
    _notes = [];
  }
}

// ── List View ────────────────────────────────────────────────

function _renderNoteList() {
  const list = document.getElementById('shard-note-list');
  if (!list) return;

  let filtered = _notes;
  // Folder filter — recursive: shows notes in selected folder and all descendants
  if (_selectedFolder) {
    const sel = _selectedFolder.replace(/\\/g, '/');
    filtered = filtered.filter(n => {
      const f = (n.folder || '').replace(/\\/g, '/');
      return f === sel || f.startsWith(sel + '/');
    });
  }
  // Search filter
  if (_searchQuery) {
    const q = _searchQuery.toLowerCase();
    filtered = filtered.filter(n => (n.title + n.content + (n.tags?.join('') || '')).toLowerCase().includes(q));
  }

  if (!filtered.length) {
    if (_searchQuery || _selectedFolder) {
      list.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;font-size:12px;">No notes match the current filter.</div>';
    } else {
      list.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;font-size:12px;">No notes found in this vault.</div>';
    }
    return;
  }

  list.innerHTML = filtered.map(n => `
    <div class="shard-note-card ${n.id === _selectedNoteId ? 'selected' : ''}" data-id="${n.id}">
      <div class="shard-note-card-title">${_esc(n.title)}</div>
      <div class="shard-note-card-preview">${_esc(n.content?.slice(0, 120) || '')}</div>
      <div class="shard-note-card-meta">
        ${(n.tags || []).map(t => `<span class="shard-tag">${_esc(t)}</span>`).join('')}
        <span class="shard-note-date">${n.last_modified_src?.slice(0, 10) || ''}</span>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.shard-note-card').forEach(card => {
    card.addEventListener('click', (e) => _navigateToNote(card.dataset.id, true, e.ctrlKey || e.metaKey));
  });
}

let _previewMode = 'preview'; // 'preview' | 'live' | 'edit'
let _editModePref = 'live';   // 'live' | 'edit' — the edit mode used when toggling from preview
let _autoRenameNoteId = null; // set when creating new note to auto-focus title

function _serializeFrontmatter(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else if (v && typeof v === 'object') {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${String(v ?? '')}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function _getNoteFullRaw(note) {
  const serialized = _serializeFrontmatter(note.frontmatter || {});
  return note.content ? serialized + '\n' + note.content : serialized;
}

function _splitMarkdownBlocks(text) {
  const blocks = [];
  const lines = text.split('\n');
  let current = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      if (inCodeBlock) {
        current.push(line);
        blocks.push(current.join('\n'));
        current = [];
        inCodeBlock = false;
      } else {
        if (current.length > 0) { blocks.push(current.join('\n')); current = []; }
        current.push(line);
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) { current.push(line); continue; }
    if (trimmed === '' && current.length > 0) { blocks.push(current.join('\n')); current = []; continue; }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks.filter(b => b.trim() !== '');
}

function _findUniqueUntitled(base, existing, ext = '') {
  let name = base + ext;
  let i = 1;
  const check = ext ? n => n.id === name || n.rel_path === name || n.title === base
                    : n => n.id === name || n.rel_path === name;
  while (existing.some(check)) {
    i++;
    name = `${base} ${i}${ext}`;
  }
  return name;
}

async function _saveNoteContent(note, isRetry = false) {
  const serialized = _serializeFrontmatter(note.frontmatter || {});
  const fullContent = note.content ? serialized + '\n' + note.content : serialized;
  try {
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(note.id)}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ content: fullContent }),
    });
    if (r.ok) {
      note.frontmatter_raw = (note.frontmatter && Object.keys(note.frontmatter).length)
        ? Object.entries(note.frontmatter).map(([k, v]) => {
            if (Array.isArray(v)) return `${k}:\n${v.map(i => `  - ${i}`).join('\n')}`;
            if (v && typeof v === 'object') return `${k}: ${JSON.stringify(v)}`;
            return `${k}: ${String(v ?? '')}`;
          }).join('\n')
        : '';
      _noteCache.set(note.title, note);
      _noteContentCache.set(note.id, note);
    } else {
      let errText = '';
      try { const d = await r.json(); errText = d.detail || JSON.stringify(d); } catch {}
      console.error('[shard] save property failed', r.status, errText);
      if (!isRetry) {
        setTimeout(() => _saveNoteContent(note, true), 2000);
      }
    }
  } catch (e) {
    console.error('[shard] save property error', e);
    if (!isRetry) {
      setTimeout(() => _saveNoteContent(note, true), 2000);
    }
  }
}

const _COMMON_PROPERTIES = ['tags', 'date', 'aliases', 'cssclasses', 'status', 'priority', 'URL', 'source'];

function _propTypeIconSvg(type) {
  const icons = {
    text: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="18" y2="18"/></svg>',
    list: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    number: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>',
    checkbox: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M9 12l2 2 4-4"/></svg>',
    date: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    datetime: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    aliases: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/></svg>',
    tags: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
  };
  return icons[type] || icons.text;
}

function _propIconSvg(key, value, propType) {
  const type = propType || _inferPropType(key, value);
  if (type === 'tags' || type === 'list') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`;
  }
  if (type === 'date' || type === 'datetime') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
  }
  if (type === 'checkbox') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M9 12l2 2 4-4"/></svg>`;
  }
  if (type === 'number') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>`;
  }
  if (type === 'aliases') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/></svg>`;
  }
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="18" y2="18"/></svg>`;
}

function _buildTagChip(text, key) {
  const isTag = key.toLowerCase() === 'tags';
  return `<span class="shard-prop-chip${isTag ? ' is-tag' : ''}" data-chip="${_esc(text)}" data-prop-key="${_esc(key)}" spellcheck="false">
    <span class="shard-prop-chip-text">${_esc(text)}</span>
    <span class="shard-prop-chip-x" data-action="remove-chip" title="Remove">&times;</span>
  </span>`;
}

function _inferPropType(key, value) {
  if (Array.isArray(value)) {
    if (key.toLowerCase() === 'tags') return 'tags';
    return 'list';
  }
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (key.toLowerCase() === 'aliases') return 'aliases';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(String(value))) return 'datetime';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return 'date';
  return 'text';
}

function _buildPropertiesHtml(frontmatter, note) {
  const fm = frontmatter || {};
  const entries = Object.entries(fm);
  const rows = entries.map(([k, v]) => {
    const propType = _inferPropType(k, v);
    const icon = _propIconSvg(k, v, propType);
    let valHtml;
    if (Array.isArray(v)) {
      const chips = v.map(item => _buildTagChip(String(item), k)).join('');
      valHtml = `<span class="shard-prop-val" data-prop-key="${_esc(k)}" data-type="array" data-prop-type="${propType}" spellcheck="false">${chips}<span class="shard-prop-chip-input" contenteditable="plaintext-only" spellcheck="false"></span></span>`;
    } else if (v && typeof v === 'object') {
      valHtml = `<span class="shard-prop-val" contenteditable="plaintext-only" spellcheck="false" data-prop-key="${_esc(k)}" data-prop-type="${propType}">${_esc(JSON.stringify(v))}</span>`;
    } else {
      valHtml = `<span class="shard-prop-val" contenteditable="plaintext-only" spellcheck="false" data-prop-key="${_esc(k)}" data-prop-type="${propType}">${_esc(String(v ?? ''))}</span>`;
    }
    return `<div class="shard-prop-row" data-prop-key="${_esc(k)}">
      <span class="shard-prop-icon" data-prop-key="${_esc(k)}" title="Property options">${icon}</span>
      <span class="shard-prop-key" spellcheck="false">${_esc(k)}</span>
      ${valHtml}
    </div>`;
  }).join('');
  const addBtn = note ? `<button class="shard-prop-add-main" data-add-prop spellcheck="false"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add property</button>` : '';
  return `<div class="shard-properties-inline"><h4>Properties</h4><div class="shard-prop-grid">${rows || ''}</div>${addBtn}</div>`;
}

async function _selectNote(id) {
  _selectedNoteId = id;

  const preview = document.getElementById('shard-preview');
  if (!preview) return;

  try {
    let note = _noteContentCache.get(id);
    if (!note) {
      // _loadNotes already returns full content; avoid a second fetch
      const cached = _notes.find(n => n.id === id || n.rel_path === id);
      if (cached) {
        note = { ...cached };
        _noteContentCache.set(id, note);
      }
    }
    if (!note) {
      const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(id)}`);
      if (!r.ok) { preview.style.display = 'none'; return; }
      note = await r.json();
      _noteContentCache.set(id, note);
    }
    preview.style.display = 'block';
    const isAutoRename = _autoRenameNoteId === note.id;
    const titleHtml = isAutoRename
      ? `<span class="shard-title-edit" contenteditable="plaintext-only" spellcheck="false">${_esc(note.title)}</span>`
      : `<h1>${_esc(note.title)}</h1>`;
    // In source mode, show raw YAML instead of property chips
    const showProps = _previewMode !== 'edit';
    preview.innerHTML = `
      <div class="shard-preview-header">
        ${titleHtml}
      </div>
      ${showProps ? _buildPropertiesHtml(note.frontmatter, note) : ''}
      <div class="shard-preview-body"></div>
    `;

    // Wire inline title editing for newly-created notes
    if (isAutoRename) {
      const titleEdit = preview.querySelector('.shard-title-edit');
      if (titleEdit) {
        titleEdit.focus();
        const range = document.createRange();
        range.selectNodeContents(titleEdit);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const finishRename = async () => {
          const newName = titleEdit.textContent.trim();
          _autoRenameNoteId = null;
          if (newName && newName !== note.title) {
            await _doRenameNote(note.id, newName);
          } else {
            const h1 = document.createElement('h1');
            h1.textContent = note.title;
            titleEdit.replaceWith(h1);
          }
        };
        titleEdit.addEventListener('blur', finishRename, { once: true });
        titleEdit.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); titleEdit.blur(); }
          if (e.key === 'Escape') {
            _autoRenameNoteId = null;
            const h1 = document.createElement('h1');
            h1.textContent = note.title;
            titleEdit.replaceWith(h1);
          }
        });
      }
    }

    const bodyEl = preview.querySelector('.shard-preview-body');

    const _saveLivePreview = async () => {
      const blocks = bodyEl.querySelectorAll('.shard-live-block');
      const texts = [];
      blocks.forEach(b => {
        const ta = b.querySelector('.shard-live-block-edit');
        texts.push(ta ? ta.value : (b.dataset.blockRaw || ''));
      });
      note.content = texts.join('\n\n');
      await _saveNoteContent(note);
    };

    const _wireWikilinks = (container) => {
      container.querySelectorAll('a.wikilink').forEach(a => {
        a.addEventListener('click', async (e) => {
          e.preventDefault();
          const targetTitle = a.dataset.note;
          const target = _notes.find(n => n.title === targetTitle);
          if (target) {
            _navigateToNote(target.id, true, e.ctrlKey || e.metaKey);
          } else {
            const created = await _getOrCreateNoteByTitle(targetTitle);
            if (created) _navigateToNote(created.id, true, e.ctrlKey || e.metaKey);
          }
        });
      });
    };

    const _wireSourceWikilinks = (container) => {
      container.querySelectorAll('a.wikilink-source').forEach(a => {
        a.addEventListener('click', async (e) => {
          e.preventDefault();
          const targetTitle = a.dataset.note;
          const target = _notes.find(n => n.title === targetTitle);
          if (target) {
            _navigateToNote(target.id, true, e.ctrlKey || e.metaKey);
          } else {
            const created = await _getOrCreateNoteByTitle(targetTitle);
            if (created) _navigateToNote(created.id, true, e.ctrlKey || e.metaKey);
          }
        });
      });
    };

    const _parseFrontmatter = (text) => {
      const fm = {};
      const lines = text.split('\n');
      let i = 0;
      if (lines[0]?.trim() === '---') i = 1;
      for (; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '---') break;
        const colonIdx = line.indexOf(':');
        if (colonIdx < 0) continue;
        const key = line.slice(0, colonIdx).trim();
        let val = line.slice(colonIdx + 1).trim();
        if (val === '') {
          const listItems = [];
          let j = i + 1;
          while (j < lines.length && lines[j].startsWith('  - ')) {
            listItems.push(lines[j].slice(4).trim());
            j++;
          }
          if (listItems.length) { fm[key] = listItems; i = j - 1; }
          else { fm[key] = ''; }
        } else {
          fm[key] = val;
        }
      }
      return fm;
    };

    const _renderSourceLine = (line) => {
      let h = _esc(line);
      // Heading: ### Text
      const hm = h.match(/^(#{1,6})\s+(.*)$/);
      if (hm) { const lvl = hm[1].length; return `<span class="md-h${lvl}"><span class="md-hash">${hm[1]} </span>${hm[2]}</span>`; }
      // Horizontal rule ---
      if (/^---+$/.test(line.trim())) return `<span class="md-hr">${h}</span>`;
      // Blockquote > Text
      if (/^&gt;\s/.test(h)) { h = h.replace(/^&gt;\s/, '<span class="md-bq-mark">&gt; </span>'); return `<span class="md-bq">${h}</span>`; }
      // List item
      const lm = h.match(/^(\s*)([-*+])\s+(.*)$/) || h.match(/^(\s*)(\d+\.)\s+(.*)$/);
      if (lm) return `${lm[1]}<span class="md-li-marker">${lm[2]} </span>${lm[3]}`;
      // Bold + italic ***text***
      h = h.replace(/\*\*\*([^*]+)\*\*\*/g, '<span class="md-bold md-italic"><span class="md-syntax">***</span>$1<span class="md-syntax">***</span></span>');
      // Bold **text**
      h = h.replace(/\*\*([^*]+)\*\*/g, '<span class="md-bold"><span class="md-syntax">**</span>$1<span class="md-syntax">**</span></span>');
      // Italic *text*
      h = h.replace(/\*([^*]+)\*/g, '<span class="md-italic"><span class="md-syntax">*</span>$1<span class="md-syntax">*</span></span>');
      // Italic _text_
      h = h.replace(/_([^_]+)_/g, '<span class="md-italic"><span class="md-syntax">_</span>$1<span class="md-syntax">_</span></span>');
      // Strikethrough ~~text~~
      h = h.replace(/~~([^~]+)~~/g, '<span class="md-strike"><span class="md-syntax">~~</span>$1<span class="md-syntax">~~</span></span>');
      // Inline code `text`
      h = h.replace(/`([^`]+)`/g, '<span class="md-code"><span class="md-syntax">`</span>$1<span class="md-syntax">`</span></span>');
      // Wikilinks [[text]]
      h = h.replace(/\[\[([^\]]+)\]\]/g, (match, content) => {
        const pipeIdx = content.indexOf('|');
        const target = pipeIdx >= 0 ? content.slice(0, pipeIdx).trim() : content.trim();
        const display = pipeIdx >= 0 ? content.slice(pipeIdx + 1).trim() : target;
        return `<span class="md-wikilink"><span class="md-bracket">[[</span><a class="wikilink-source" href="#" data-note="${_esc(target)}">${_esc(display)}</a><span class="md-bracket">]]</span></span>`;
      });
      // Alternative wikilinks [/[/text]/]
      h = h.replace(/\[\/\[([^\]]+)\]\/\]/g, (match, content) => {
        const pipeIdx = content.indexOf('|');
        const target = pipeIdx >= 0 ? content.slice(0, pipeIdx).trim() : content.trim();
        const display = pipeIdx >= 0 ? content.slice(pipeIdx + 1).trim() : target;
        return `<span class="md-wikilink"><span class="md-bracket">[/[</span><a class="wikilink-source" href="#" data-note="${_esc(target)}">${_esc(display)}</a><span class="md-bracket">]/]</span></span>`;
      });
      // External links [text](url)
      h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="md-link"><span class="md-syntax">[</span><span class="md-link-text">$1</span><span class="md-syntax">](</span><span class="md-link-url">$2</span><span class="md-syntax">)</span></span>');
      return h;
    };

    const _renderCleanLine = (line) => {
      let h = _esc(line);
      // Heading: ### Text
      const hm = h.match(/^(#{1,6})\s+(.*)$/);
      if (hm) { const lvl = hm[1].length; return `<h${lvl}>${hm[2]}</h${lvl}>`; }
      // Horizontal rule ---
      if (/^---+$/.test(line.trim())) return '<hr>';
      // Blockquote > Text
      if (/^&gt;\s/.test(h)) { h = `<blockquote>${h.replace(/^&gt;\s/, '')}</blockquote>`; }
      // List item
      const lm = h.match(/^(\s*)([-*+])\s+(.*)$/) || h.match(/^(\s*)(\d+\.)\s+(.*)$/);
      if (lm) { h = `${lm[1]}<li>${lm[3]}</li>`; }
      // Bold + italic ***text***
      h = h.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
      // Bold **text**
      h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // Italic *text*
      h = h.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      // Italic _text_
      h = h.replace(/_([^_]+)_/g, '<em>$1</em>');
      // Strikethrough ~~text~~
      h = h.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      // Inline code `text`
      h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
      // Wikilinks [[text]]
      h = h.replace(/\[\[([^\]]+)\]\]/g, (match, content) => {
        const pipeIdx = content.indexOf('|');
        const target = pipeIdx >= 0 ? content.slice(0, pipeIdx).trim() : content.trim();
        const display = pipeIdx >= 0 ? content.slice(pipeIdx + 1).trim() : target;
        return `<a class="wikilink" href="#" data-note="${_esc(target)}">${_esc(display)}</a>`;
      });
      // Alternative wikilinks [/[/text]/]
      h = h.replace(/\[\/\[([^\]]+)\]\/\]/g, (match, content) => {
        const pipeIdx = content.indexOf('|');
        const target = pipeIdx >= 0 ? content.slice(0, pipeIdx).trim() : content.trim();
        const display = pipeIdx >= 0 ? content.slice(pipeIdx + 1).trim() : target;
        return `<a class="wikilink" href="#" data-note="${_esc(target)}">${_esc(display)}</a>`;
      });
      // External links [text](url)
      h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
      return h;
    };

    const _renderSourceView = (raw) => {
      if (!raw) return '';
      const lines = raw.split('\n');
      let inCodeBlock = false;
      const codeLines = [];
      const out = [];
      for (const line of lines) {
        if (/^\s*```/.test(line)) {
          if (inCodeBlock) {
            codeLines.push(_esc(line));
            out.push(`<div class="lp-line"><div class="md-code-block">${codeLines.join('<br>')}</div></div>`);
            codeLines.length = 0;
            inCodeBlock = false;
          } else {
            inCodeBlock = true;
            codeLines.push(_esc(line));
          }
        } else if (inCodeBlock) {
          codeLines.push(_esc(line));
        } else {
          out.push(`<div class="lp-line">${_renderSourceLine(line)}</div>`);
        }
      }
      if (inCodeBlock) {
        out.push(`<div class="lp-line"><div class="md-code-block">${codeLines.join('<br>')}</div></div>`);
      }
      return out.join('');
    };

    const _renderLiveView = (raw) => {
      if (!raw) return '';
      const lines = raw.split('\n');
      let inCodeBlock = false;
      const codeLines = [];
      const out = [];
      for (const line of lines) {
        if (/^\s*```/.test(line)) {
          if (inCodeBlock) {
            codeLines.push(_esc(line));
            out.push(`<div class="lp-line" data-raw="${_esc(line)}"><div class="lp-clean"><div class="md-code-block">${codeLines.join('<br>')}</div></div></div>`);
            codeLines.length = 0;
            inCodeBlock = false;
          } else {
            inCodeBlock = true;
            codeLines.push(_esc(line));
          }
        } else if (inCodeBlock) {
          codeLines.push(_esc(line));
        } else {
          const emptyClass = !line.trim() ? ' lp-empty' : '';
          out.push(`<div class="lp-line${emptyClass}" data-raw="${_esc(line)}"><div class="lp-clean">${_renderCleanLine(line)}</div><div class="lp-source">${_renderSourceLine(line)}</div></div>`);
        }
      }
      if (inCodeBlock) {
        out.push(`<div class="lp-line" data-raw=""><div class="lp-clean"><div class="md-code-block">${codeLines.join('<br>')}</div></div></div>`);
      }
      return out.join('');
    };

    const updateBody = () => {
      if (_previewMode === 'edit') {
        // Source mode: styled text div, contentEditable, clickable wikilinks
        const raw = _getNoteFullRaw(note);
        bodyEl.innerHTML = `<div class="shard-body-wrap"><div class="shard-source-view" contenteditable="true" spellcheck="false">${_renderSourceView(raw)}</div></div>`;
        const sourceDiv = bodyEl.querySelector('.shard-source-view');
        _wireSourceWikilinks(sourceDiv);
        sourceDiv.focus();
        const finishEdit = async () => {
          const fullText = sourceDiv.innerText;
          const lines = fullText.split('\n');
          let contentStart = 0;
          let frontmatter = {};
          if (lines[0]?.trim() === '---') {
            const endIdx = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
            if (endIdx > 0) {
              frontmatter = _parseFrontmatter(fullText);
              contentStart = endIdx + 1;
            }
          }
          note.frontmatter = frontmatter;
          note.content = lines.slice(contentStart).join('\n').replace(/^\n+/, '');
          await _saveNoteContent(note);
          _selectNote(note.id);
        };
        sourceDiv.addEventListener('blur', finishEdit, { once: true });
      } else if (_previewMode === 'live') {
        // Live Preview: token-level inline editing — syntax hidden by default,
        // revealed only for the token(s) containing the cursor.
        const content = note.content || '';
        bodyEl.innerHTML = `<div class="shard-body-wrap"><div class="shard-live-view">${_renderLiveView(content)}</div></div>`;
        const liveDiv = bodyEl.querySelector('.shard-live-view');
        _wireWikilinks(liveDiv);

        let activeLine = null;
        let _caretTimer = null;

        const TOKEN_CLASSES = new Set([
          'md-h1','md-h2','md-h3','md-h4','md-h5','md-h6',
          'md-bq','md-bold','md-italic','md-strike','md-code',
          'md-wikilink','md-link','md-hr','md-li-marker'
        ]);

        const _isTokenSpan = (el) => {
          if (!el || !el.classList) return false;
          for (const c of el.classList) {
            if (TOKEN_CLASSES.has(c)) return true;
          }
          return false;
        };

        const _clearActiveTokens = (line) => {
          line.querySelectorAll('.active').forEach(el => el.classList.remove('active'));
        };

        const _activateToken = (el) => {
          if (el && _isTokenSpan(el) && !el.classList.contains('active')) {
            el.classList.add('active');
          }
        };

        const _trackCaret = () => {
          if (!activeLine) return;
          _clearActiveTokens(activeLine);
          const sel = window.getSelection();
          if (!sel.rangeCount) return;
          const range = sel.getRangeAt(0);
          const node = range.startContainer;

          // Find the token span containing the cursor
          let token = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
          while (token && !token.classList?.contains('lp-source')) {
            if (_isTokenSpan(token)) {
              _activateToken(token);
              // If cursor is at a boundary, also check adjacent siblings
              const offset = range.startOffset;
              const isAtStart = offset === 0;
              const textLen = node.textContent?.length || 0;
              const isAtEnd = offset === textLen;
              if (isAtStart && token.previousElementSibling) {
                _activateToken(token.previousElementSibling);
              }
              if (isAtEnd && token.nextElementSibling) {
                _activateToken(token.nextElementSibling);
              }
              return;
            }
            token = token.parentElement;
          }

          // Cursor is in plain text inside lp-source; always activate adjacent tokens
          let sibling = node.nodeType === Node.TEXT_NODE ? node : null;
          if (!sibling) return;
          if (sibling.previousElementSibling) {
            _activateToken(sibling.previousElementSibling);
          }
          if (sibling.nextElementSibling) {
            _activateToken(sibling.nextElementSibling);
          }
        };

        const _deactivateLine = (line) => {
          if (!line) return;
          _clearActiveTokens(line);
          const source = line.querySelector('.lp-source');
          const clean = line.querySelector('.lp-clean');
          if (!source || !clean) return;
          const raw = source.innerText;
          line.setAttribute('data-raw', raw);
          clean.innerHTML = _renderCleanLine(raw);
          _wireWikilinks(clean);
          source.setAttribute('contenteditable', 'false');
          line.classList.remove('active');
        };

        const _activateLine = (line, clickX, clickY) => {
          if (!line) return;
          if (line === activeLine) {
            // Just re-focus and place cursor
            const source = line.querySelector('.lp-source');
            if (source) {
              source.focus();
              if (clickX != null && clickY != null) {
                try {
                  const caretRange = document.caretRangeFromPoint(clickX, clickY);
                  if (caretRange) {
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(caretRange);
                  }
                } catch (_) {}
              }
              _trackCaret();
            }
            return;
          }
          if (activeLine) _deactivateLine(activeLine);
          activeLine = line;
          const source = line.querySelector('.lp-source');
          const clean = line.querySelector('.lp-clean');
          if (!source || !clean) return;
          source.setAttribute('contenteditable', 'true');
          _wireSourceWikilinks(source);
          line.classList.add('active');
          source.focus();
          if (clickX != null && clickY != null) {
            try {
              const caretRange = document.caretRangeFromPoint(clickX, clickY);
              if (caretRange) {
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(caretRange);
              }
            } catch (_) {
              // Fallback for Firefox: caretPositionFromPoint
              try {
                const pos = document.caretPositionFromPoint(clickX, clickY);
                if (pos) {
                  const range = document.createRange();
                  range.setStart(pos.offsetNode, pos.offset);
                  range.collapse(true);
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
              } catch (_) {}
            }
          } else {
            // Place cursor at end by default
            const range = document.createRange();
            range.selectNodeContents(source);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
          _trackCaret();
        };

        liveDiv.addEventListener('click', (e) => {
          // Don't activate line when clicking a link
          if (e.target.closest('a')) return;
          const line = e.target.closest('.lp-line');
          if (!line) return;
          const source = line.querySelector('.lp-source');
          if (!source) return; // code blocks have no source layer
          _activateLine(line, e.clientX, e.clientY);
        });

        // Blur on the source div deactivates the line
        liveDiv.addEventListener('blur', (e) => {
          if (e.target.classList.contains('lp-source')) {
            const line = e.target.closest('.lp-line');
            _deactivateLine(line);
            activeLine = null;
          }
        }, true);

        // Track caret position on keyup, input, and mouseup (within liveDiv only)
        const _onCaretChange = () => {
          clearTimeout(_caretTimer);
          _caretTimer = setTimeout(() => _trackCaret(), 10);
        };
        liveDiv.addEventListener('keyup', _onCaretChange);
        liveDiv.addEventListener('input', _onCaretChange);
        liveDiv.addEventListener('mouseup', _onCaretChange);

        const finishEdit = async () => {
          _hideWikiSuggest();
          liveDiv.removeEventListener('keyup', _onCaretChange);
          liveDiv.removeEventListener('input', _onCaretChange);
          liveDiv.removeEventListener('mouseup', _onCaretChange);
          if (activeLine) {
            _deactivateLine(activeLine);
            activeLine = null;
          }
          // Collect raw text from all lines
          const rawLines = [];
          liveDiv.querySelectorAll('.lp-line').forEach(line => {
            rawLines.push(line.getAttribute('data-raw') || '');
          });
          const newContent = rawLines.join('\n');
          note.content = newContent;
          await _saveNoteContent(note);
          _selectNote(note.id);
        };

        // ── Contenteditable helpers for bracket auto-close & suggestions ──
        const _getCharBeforeCursor = () => {
          const sel = window.getSelection();
          if (!sel.rangeCount) return '';
          const range = sel.getRangeAt(0);
          const node = range.startContainer;
          const offset = range.startOffset;
          if (node.nodeType === Node.TEXT_NODE) {
            if (offset > 0) return node.textContent[offset - 1];
            let prev = node.previousSibling;
            while (prev && prev.textContent === '') prev = prev.previousSibling;
            if (prev) { const t = prev.textContent; return t[t.length - 1] || ''; }
          }
          return '';
        };

        const _getCharAfterCursor = () => {
          const sel = window.getSelection();
          if (!sel.rangeCount) return '';
          const range = sel.getRangeAt(0);
          const node = range.startContainer;
          const offset = range.startOffset;
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (offset < text.length) return text[offset];
            let next = node.nextSibling;
            while (next && next.textContent === '') next = next.nextSibling;
            if (next) { const t = next.textContent; return t[0] || ''; }
          }
          return '';
        };

        const _moveCursorBack = (n) => {
          const sel = window.getSelection();
          if (!sel.rangeCount) return;
          const range = sel.getRangeAt(0);
          let node = range.startContainer;
          let offset = range.startOffset;
          while (n > 0 && node) {
            if (node.nodeType !== Node.TEXT_NODE) break;
            if (offset >= n) { offset -= n; n = 0; break; }
            n -= offset;
            node = node.previousSibling;
            while (node && node.textContent === '') node = node.previousSibling;
            offset = node ? node.textContent.length : 0;
          }
          if (node) {
            const r = document.createRange();
            r.setStart(node, Math.max(0, offset));
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
          }
        };

        const _getCursorCoords = () => {
          const sel = window.getSelection();
          if (!sel.rangeCount) return null;
          const range = sel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return null;
          return { x: rect.left + rect.width / 2, y: rect.bottom + 4 };
        };

        const _getTextBeforeCursor = (source) => {
          const sel = window.getSelection();
          if (!sel.rangeCount) return '';
          const range = sel.getRangeAt(0);
          const preRange = document.createRange();
          preRange.selectNodeContents(source);
          preRange.setEnd(range.startContainer, range.startOffset);
          return preRange.toString();
        };

        // ── Wikilink suggestion dropdown ──
        let _wikiSuggestEl = null;
        let _wikiSuggestIndex = -1;

        const _hideWikiSuggest = () => {
          if (_wikiSuggestEl) { _wikiSuggestEl.remove(); _wikiSuggestEl = null; }
          _wikiSuggestIndex = -1;
        };

        const _showWikiSuggest = (source, query) => {
          _hideWikiSuggest();
          const coords = _getCursorCoords();
          if (!coords) return;
          const matches = _notes
            .map(n => n.title)
            .filter(t => t.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 12);
          if (!matches.length) return;
          const el = document.createElement('div');
          el.className = 'shard-wiki-suggest';
          el.innerHTML = matches.map((t, i) =>
            `<div class="shard-wiki-suggest-item${i === 0 ? ' selected' : ''}" data-title="${_esc(t)}">${_esc(t)}</div>`
          ).join('');
          el.style.position = 'fixed';
          el.style.zIndex = '99999';
          el.style.left = coords.x + 'px';
          el.style.top = coords.y + 'px';
          el.style.minWidth = '180px';
          document.body.appendChild(el);
          _wikiSuggestEl = el;
          _wikiSuggestIndex = 0;
          el.querySelectorAll('.shard-wiki-suggest-item').forEach(item => {
            item.addEventListener('click', () => {
              _insertWikiLink(source, item.dataset.title);
              _hideWikiSuggest();
            });
          });
        };

        const _insertWikiLink = (source, title) => {
          const sel = window.getSelection();
          if (!sel.rangeCount) return;
          const range = sel.getRangeAt(0);
          const textBefore = _getTextBeforeCursor(source);
          // Find the opening [[ or [/[
          let openIdx = textBefore.lastIndexOf('[/[');
          if (openIdx === -1) openIdx = textBefore.lastIndexOf('[[');
          if (openIdx === -1) return;
          const isAlt = textBefore.lastIndexOf('[/[') > textBefore.lastIndexOf('[[');
          const prefixLen = isAlt ? 3 : 2;
          const fullQuery = textBefore.slice(openIdx + prefixLen);
          // Split at | to preserve display alias
          const pipeIdx = fullQuery.indexOf('|');
          const targetPart = pipeIdx >= 0 ? fullQuery.slice(0, pipeIdx) : fullQuery;
          const displayPart = pipeIdx >= 0 ? fullQuery.slice(pipeIdx) : '';
          const deleteLen = targetPart.length;
          // Collapse to end of targetPart
          range.collapse(false);
          // Delete target text only (keep | and display name if present)
          for (let i = 0; i < deleteLen; i++) document.execCommand('delete', false);
          // Insert selected title
          document.execCommand('insertText', false, title);
        };

        const _updateWikiSuggest = (source) => {
          const textBefore = _getTextBeforeCursor(source);
          const lastOpen = Math.max(textBefore.lastIndexOf('[/['), textBefore.lastIndexOf('[['));
          if (lastOpen === -1) { _hideWikiSuggest(); return; }
          const isAlt = textBefore.lastIndexOf('[/[') > textBefore.lastIndexOf('[[');
          const prefixLen = isAlt ? 3 : 2;
          const afterOpen = textBefore.slice(lastOpen + prefixLen);
          const closeIdx = afterOpen.indexOf(isAlt ? ']/]' : ']]');
          if (closeIdx !== -1) { _hideWikiSuggest(); return; }
          // Only search by the target part (before |)
          const pipeIdx = afterOpen.indexOf('|');
          const query = pipeIdx >= 0 ? afterOpen.slice(0, pipeIdx) : afterOpen;
          _showWikiSuggest(source, query);
        };

        // ── Keydown handler: brackets, suggestions, Enter ──
        liveDiv.addEventListener('keydown', (e) => {
          const source = activeLine?.querySelector('.lp-source');
          if (!source) return;

          // Enter: insert literal newline
          if (e.key === 'Enter' && activeLine) {
            e.preventDefault();
            document.execCommand('insertText', false, '\n');
            return;
          }

          // Bracket auto-close
          if (e.key === '[') {
            e.preventDefault();
            const textBefore = _getTextBeforeCursor(source);
            const prev = _getCharBeforeCursor();
            const next = _getCharAfterCursor();
            if (prev === '[') {
              if (next === ']') document.execCommand('delete', false);
              document.execCommand('insertText', false, ']]');
              _moveCursorBack(2);
            } else if (textBefore.endsWith('[/')) {
              document.execCommand('insertText', false, '[]/]');
              _moveCursorBack(4);
            } else {
              document.execCommand('insertText', false, '[]');
              _moveCursorBack(1);
            }
            _updateWikiSuggest(source);
            return;
          }

          // Wikilink suggestion navigation
          if (_wikiSuggestEl) {
            const items = _wikiSuggestEl.querySelectorAll('.shard-wiki-suggest-item');
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              items[_wikiSuggestIndex]?.classList.remove('selected');
              _wikiSuggestIndex = (_wikiSuggestIndex + 1) % items.length;
              items[_wikiSuggestIndex]?.classList.add('selected');
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              items[_wikiSuggestIndex]?.classList.remove('selected');
              _wikiSuggestIndex = (_wikiSuggestIndex - 1 + items.length) % items.length;
              items[_wikiSuggestIndex]?.classList.add('selected');
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              const selected = items[_wikiSuggestIndex];
              if (selected) _insertWikiLink(source, selected.dataset.title);
              _hideWikiSuggest();
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              _hideWikiSuggest();
              return;
            }
          }
        });

        // Show suggestion on input inside [[...]]
        liveDiv.addEventListener('input', (e) => {
          const source = activeLine?.querySelector('.lp-source');
          if (source) _updateWikiSuggest(source);
        });

        // Hide suggest on outside click
        const _hideSuggestOnClick = (e) => {
          if (_wikiSuggestEl && !e.target.closest('.shard-wiki-suggest')) {
            _hideWikiSuggest();
          }
        };
        document.addEventListener('click', _hideSuggestOnClick);

        // Blur on liveDiv itself saves
        liveDiv.addEventListener('blur', () => {
          _hideWikiSuggest();
          document.removeEventListener('click', _hideSuggestOnClick);
        }, { once: true });

        liveDiv.addEventListener('blur', finishEdit, { once: true });
      } else {
        // Reading mode: use live preview HTML without editing interactions
        const content = note.content || '';
        bodyEl.innerHTML = `<div class="shard-body-wrap"><div class="shard-reading-view">${_renderLiveView(content)}</div></div>`;
        const wrap = bodyEl.querySelector('.shard-reading-view');
        _wireWikilinks(wrap);
        wrap.addEventListener('dblclick', () => {
          _previewMode = _editModePref;
          _updateModeIcon();
          _selectNote(note.id);
        });
      }
    };
    updateBody();
    _updateModeIcon();
    const modeIcon = document.getElementById('shard-mode-icon');
    if (modeIcon) {
      modeIcon.style.display = 'flex';
      modeIcon.onclick = () => {
        // Explicitly blur source view to trigger save before switching away
        if (_previewMode === 'edit') {
          const sourceDiv = bodyEl.querySelector('.shard-source-view');
          if (sourceDiv) sourceDiv.blur();
        }
        // Cycle: Reading <-> preferred edit mode
        _previewMode = _previewMode === 'preview' ? _editModePref : 'preview';
        _updateModeIcon();
        _selectNote(note.id);
      };
    }
    const noteMenuBtn = document.getElementById('shard-note-menu-btn');
    if (noteMenuBtn) {
      noteMenuBtn.style.display = 'flex';
      noteMenuBtn.onclick = (e) => _showNoteMenu(e, note);
    }

    // Wire all property editors
    _wirePropertyEditors(preview, note);

    _renderRightSidebar(note);

    // Background: fetch full note with backlinks if we only had the cached stub
    if (!note.backlinks_resolved) {
      fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(id)}`)
        .then(r => r.ok ? r.json() : null)
        .then(full => {
          if (full) {
            _noteContentCache.set(id, full);
            _renderRightSidebar(full);
          }
        })
        .catch(() => {});
    }
  } catch (e) {
    preview.style.display = 'none';
  }
}

function _closeAllPropMenus() {
  document.querySelectorAll('.shard-prop-menu').forEach(m => m.remove());
  document.querySelectorAll('.shard-prop-submenu').forEach(m => m.remove());
  document.querySelectorAll('.shard-prop-add-dropdown').forEach(m => m.remove());
}

function _openPropIconMenu(icon, key, preview, note) {
  _closeAllPropMenus();
  const menu = document.createElement('div');
  menu.className = 'shard-prop-menu';
  menu.style.position = 'fixed';
  menu.style.zIndex = '99999';
  menu.innerHTML = `
    <div class="shard-prop-menu-item" data-action="type">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      Property type
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:0.5"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
    <div class="shard-prop-menu-divider"></div>
    <div class="shard-prop-menu-item" data-action="cut">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
      Cut
    </div>
    <div class="shard-prop-menu-item" data-action="copy">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      Copy
    </div>
    <div class="shard-prop-menu-item" data-action="paste">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
      Paste
    </div>
    <div class="shard-prop-menu-divider"></div>
    <div class="shard-prop-menu-item danger" data-action="remove">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      Remove
    </div>
  `;
  const rect = icon.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';
  document.body.appendChild(menu);
  console.log('[shard] prop menu created at', rect.left, rect.bottom, 'menu:', menu);

  // Type submenu
  const typeItem = menu.querySelector('[data-action="type"]');
  if (typeItem) {
    typeItem.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.shard-prop-submenu').forEach(m => m.remove());
      const sub = document.createElement('div');
      sub.className = 'shard-prop-submenu';
      sub.style.position = 'fixed';
      sub.style.zIndex = '99999';
      const currentType = _inferPropType(key, note.frontmatter?.[key]);
      const types = ['Text', 'List', 'Number', 'Checkbox', 'Date', 'Date & time', 'Aliases', 'Tags'];
      sub.innerHTML = types.map(t => {
        const typeKey = t.toLowerCase().replace(/ & /g, '');
        const icon = _propTypeIconSvg(typeKey);
        const isActive = typeKey === currentType;
        return `<div class="shard-prop-submenu-item${isActive ? ' active' : ''}" data-type="${_esc(typeKey)}">${icon}<span>${_esc(t)}</span></div>`;
      }).join('');
      const tRect = typeItem.getBoundingClientRect();
      sub.style.left = (tRect.right + 4) + 'px';
      sub.style.top = tRect.top + 'px';
      document.body.appendChild(sub);
      sub.querySelectorAll('.shard-prop-submenu-item').forEach(it => {
        it.addEventListener('click', async () => {
          const newType = it.dataset.type;
          const current = note.frontmatter?.[key];
          let converted = current;
          if ((newType === 'list' || newType === 'aliases') && !Array.isArray(current)) converted = current ? [String(current)] : [];
          if (newType === 'number' && typeof current !== 'number') converted = Number(current) || 0;
          if (newType === 'checkbox' && typeof current !== 'boolean') converted = String(current).toLowerCase() === 'true';
          if (newType === 'tags' && !Array.isArray(current)) converted = current ? [String(current)] : [];
          note.frontmatter = note.frontmatter || {};
          note.frontmatter[key] = converted;
          await _saveNoteContent(note);
          _closeAllPropMenus();
          const propsEl = preview.querySelector('.shard-properties-inline');
          if (propsEl) { propsEl.outerHTML = _buildPropertiesHtml(note.frontmatter, note); _wirePropertyEditors(preview, note); }
        });
      });
      const closeSub = (ev) => { if (!sub.contains(ev.target) && !typeItem.contains(ev.target)) { sub.remove(); document.removeEventListener('click', closeSub); } };
      setTimeout(() => document.addEventListener('click', closeSub), 0);
    });
  }

  // Remove
  menu.querySelector('[data-action="remove"]')?.addEventListener('click', async () => {
    if (note.frontmatter) delete note.frontmatter[key];
    await _saveNoteContent(note);
    _closeAllPropMenus();
    const propsEl = preview.querySelector('.shard-properties-inline');
    if (propsEl) { propsEl.outerHTML = _buildPropertiesHtml(note.frontmatter, note); _wirePropertyEditors(preview, note); }
  });

  // Cut / Copy / Paste
  menu.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
    const val = note.frontmatter?.[key];
    const txt = Array.isArray(val) ? val.join(', ') : String(val ?? '');
    navigator.clipboard?.writeText(txt);
    _closeAllPropMenus();
  });
  menu.querySelector('[data-action="cut"]')?.addEventListener('click', async () => {
    const val = note.frontmatter?.[key];
    const txt = Array.isArray(val) ? val.join(', ') : String(val ?? '');
    navigator.clipboard?.writeText(txt);
    if (note.frontmatter) delete note.frontmatter[key];
    await _saveNoteContent(note);
    _closeAllPropMenus();
    const propsEl = preview.querySelector('.shard-properties-inline');
    if (propsEl) { propsEl.outerHTML = _buildPropertiesHtml(note.frontmatter, note); _wirePropertyEditors(preview, note); }
  });
  menu.querySelector('[data-action="paste"]')?.addEventListener('click', async () => {
    try {
      const txt = await navigator.clipboard.readText();
      note.frontmatter = note.frontmatter || {};
      note.frontmatter[key] = txt;
      await _saveNoteContent(note);
      _closeAllPropMenus();
      const propsEl = preview.querySelector('.shard-properties-inline');
      if (propsEl) { propsEl.outerHTML = _buildPropertiesHtml(note.frontmatter, note); _wirePropertyEditors(preview, note); }
    } catch {}
  });

  const closeMenu = (ev) => { if (!menu.contains(ev.target) && !icon.contains(ev.target)) { _closeAllPropMenus(); document.removeEventListener('click', closeMenu); } };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

function _rerenderProps(preview, note) {
  const propsEl = preview.querySelector('.shard-properties-inline');
  if (propsEl) { propsEl.outerHTML = _buildPropertiesHtml(note.frontmatter, note); _wirePropertyEditors(preview, note); }
}

function _getAllVaultTags() {
  const tags = new Set();
  for (const n of _notes) {
    if (Array.isArray(n.tags)) n.tags.forEach(t => tags.add(String(t)));
  }
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

function _wireTagAutocomplete(input, key, note, preview) {
  let dropdown = null;
  let selectedIndex = -1;

  function _closeDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    selectedIndex = -1;
  }

  function _renderDropdown(filter) {
    _closeDropdown();
    const allTags = _getAllVaultTags();
    const existing = new Set((note.frontmatter?.[key] || []).map(String));
    let matches = allTags.filter(t => !existing.has(t));
    if (filter) {
      const f = filter.toLowerCase();
      matches = matches.filter(t => t.toLowerCase().includes(f));
    }
    if (!matches.length) return;

    dropdown = document.createElement('div');
    dropdown.className = 'shard-tag-dropdown';
    dropdown.style.zIndex = '99999';
    const rect = input.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = (rect.bottom + 4) + 'px';

    const filterLower = (filter || '').toLowerCase();
    dropdown.innerHTML = matches.map((t, i) => {
      const label = _highlightMatch(t, filterLower);
      return `<div class="shard-tag-dropdown-item" data-index="${i}" data-tag="${_esc(t)}"><span>${label}</span></div>`;
    }).join('');
    document.body.appendChild(dropdown);

    dropdown.querySelectorAll('.shard-tag-dropdown-item').forEach(item => {
      item.addEventListener('click', async () => {
        const tag = item.dataset.tag;
        if (!tag) return;
        note.frontmatter = note.frontmatter || {};
        note.frontmatter[key] = [...(note.frontmatter[key] || []), tag];
        await _saveNoteContent(note);
        _closeDropdown();
        _rerenderProps(preview, note);
      });
    });
  }

  function _highlightMatch(text, filter) {
    if (!filter) return _esc(text);
    const idx = text.toLowerCase().indexOf(filter);
    if (idx === -1) return _esc(text);
    const before = _esc(text.slice(0, idx));
    const match = _esc(text.slice(idx, idx + filter.length));
    const after = _esc(text.slice(idx + filter.length));
    return `${before}<b style="color:var(--accent,var(--red,#4a9eff))">${match}</b>${after}`;
  }

  input.addEventListener('focus', () => { _renderDropdown(''); });
  input.addEventListener('input', () => { _renderDropdown(input.textContent.trim()); });
  input.addEventListener('keydown', (e) => {
    const items = dropdown?.querySelectorAll('.shard-tag-dropdown-item');
    if (e.key === 'Enter') {
      e.preventDefault();
      if (items && items.length && selectedIndex >= 0 && items[selectedIndex]) {
        items[selectedIndex].click();
      } else {
        const val = input.textContent.trim();
        if (val) {
          note.frontmatter = note.frontmatter || {};
          note.frontmatter[key] = [...(note.frontmatter[key] || []), val];
          _saveNoteContent(note).then(() => {
            _closeDropdown();
            _rerenderProps(preview, note);
          });
        }
      }
      return;
    }
    if (!items || !items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      items.forEach((it, i) => it.classList.toggle('selected', i === selectedIndex));
      items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      items.forEach((it, i) => it.classList.toggle('selected', i === selectedIndex));
      items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Escape') {
      _closeDropdown();
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (dropdown && dropdown.matches(':hover')) return;
      const val = input.textContent.trim();
      if (val) {
        note.frontmatter = note.frontmatter || {};
        note.frontmatter[key] = [...(note.frontmatter[key] || []), val];
        _saveNoteContent(note).then(() => {
          _closeDropdown();
          _rerenderProps(preview, note);
        });
      } else {
        _closeDropdown();
      }
    }, 150);
  });
}

function _wirePropertyEditors(preview, note) {
  // --- Scalar property value edits (blur saves) ---
  preview.querySelectorAll('.shard-prop-val[contenteditable]:not([data-type="array"])').forEach(el => {
    el.addEventListener('blur', async () => {
      const key = el.dataset.propKey;
      const propType = el.dataset.propType || 'text';
      const raw = el.textContent.trim();
      if (!key || raw === String(note.frontmatter?.[key] ?? '')) return;
      let newVal = raw;
      // Type validation
      if (propType === 'number') {
        const num = Number(raw);
        if (Number.isNaN(num)) {
          el.textContent = String(note.frontmatter?.[key] ?? '');
          return;
        }
        newVal = num;
      } else if (propType === 'checkbox') {
        const lower = raw.toLowerCase();
        if (lower !== 'true' && lower !== 'false') {
          el.textContent = String(note.frontmatter?.[key] ?? '');
          return;
        }
        newVal = lower === 'true';
      } else if (propType === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          el.textContent = String(note.frontmatter?.[key] ?? '');
          return;
        }
      } else if (propType === 'datetime') {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
          el.textContent = String(note.frontmatter?.[key] ?? '');
          return;
        }
      }
      note.frontmatter = note.frontmatter || {};
      note.frontmatter[key] = newVal;
      await _saveNoteContent(note);
    });
  });

  // --- Array (tag) property handling ---
  preview.querySelectorAll('.shard-prop-val[data-type="array"]').forEach(container => {
    const key = container.dataset.propKey;
    const arr = note.frontmatter?.[key] || [];

    // Chip X removal
    container.querySelectorAll('.shard-prop-chip-x').forEach(x => {
      x.addEventListener('click', async (e) => {
        e.stopPropagation();
        const chipText = x.closest('.shard-prop-chip')?.dataset?.chip;
        if (!chipText) return;
        note.frontmatter = note.frontmatter || {};
        note.frontmatter[key] = arr.filter(item => String(item) !== chipText);
        await _saveNoteContent(note);
        _rerenderProps(preview, note);
      });
    });

    // Double-click chip text to edit
    container.querySelectorAll('.shard-prop-chip-text').forEach(txt => {
      txt.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const chip = txt.closest('.shard-prop-chip');
        if (!chip) return;
        const oldText = chip.dataset.chip;
        const input = document.createElement('span');
        input.className = 'shard-prop-chip-input';
        input.contentEditable = 'plaintext-only';
        input.spellcheck = false;
        input.textContent = oldText;
        chip.replaceWith(input);
        input.focus();
        const finishEdit = async () => {
          const newText = input.textContent.trim();
          if (newText && newText !== oldText) {
            note.frontmatter = note.frontmatter || {};
            note.frontmatter[key] = arr.map(item => String(item) === oldText ? newText : item);
            await _saveNoteContent(note);
          }
          _rerenderProps(preview, note);
        };
        input.addEventListener('blur', finishEdit);
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
      });
    });

    // Inline input for adding new tags (with autocomplete)
    const inlineInput = container.querySelector('.shard-prop-chip-input');
    if (inlineInput) {
      _wireTagAutocomplete(inlineInput, key, note, preview);
    }
  });

  // --- Property icon menus ---
  preview.querySelectorAll('.shard-prop-icon').forEach(icon => {
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log('[shard] prop icon clicked:', icon.dataset.propKey);
      _openPropIconMenu(icon, icon.dataset.propKey, preview, note);
    });
  });

  // --- Add Property button ---
  const addBtn = preview.querySelector('[data-add-prop]');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log('[shard] Add property clicked');
      _closeAllPropMenus();
      const dropdown = document.createElement('div');
      dropdown.className = 'shard-prop-add-dropdown';
      dropdown.style.position = 'fixed';
      const existingKeys = new Set(Object.keys(note.frontmatter || {}));
      const available = _COMMON_PROPERTIES.filter(p => !existingKeys.has(p));
      const options = available.map(p => `<div class="shard-prop-add-option" data-prop="${_esc(p)}">${_propIconSvg(p, '')}<span>${_esc(p)}</span></div>`).join('');
      dropdown.innerHTML = `${options}<div class="shard-prop-add-option" data-prop="__custom"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>New property</span></div>`;
      const rect = addBtn.getBoundingClientRect();
      dropdown.style.left = rect.left + 'px';
      dropdown.style.top = (rect.bottom + 4) + 'px';
      document.body.appendChild(dropdown);
      dropdown.querySelectorAll('.shard-prop-add-option').forEach(opt => {
        opt.addEventListener('click', async () => {
          const propName = opt.dataset.prop;
          if (propName === '__custom') {
            const name = window.prompt('Property name:');
            if (!name) return;
            if (note.frontmatter?.[name] !== undefined) {
              alert('Property "' + name + '" already exists.');
              return;
            }
            note.frontmatter = note.frontmatter || {};
            note.frontmatter[name] = '';
            await _saveNoteContent(note);
          } else {
            note.frontmatter = note.frontmatter || {};
            if (note.frontmatter[propName] === undefined) {
              note.frontmatter[propName] = '';
              await _saveNoteContent(note);
            }
          }
          _closeAllPropMenus();
          _rerenderProps(preview, note);
        });
      });
      const closeDd = (ev) => { if (!dropdown.contains(ev.target) && !addBtn.contains(ev.target)) { dropdown.remove(); document.removeEventListener('click', closeDd); } };
      setTimeout(() => document.addEventListener('click', closeDd), 0);
    });
  }
}

function _renderRightSidebar(note) {
  const pane = document.getElementById('shard-right-pane');
  if (!pane) return;
  const placeholder = document.getElementById('shard-right-placeholder');
  if (placeholder) placeholder.classList.add('hidden');
  document.getElementById('shard-right-tabs')?.classList.remove('hidden');
  document.getElementById('shard-right-panes')?.classList.remove('hidden');

  // Helper: render disabled state when a plugin is turned off
  const _disabled = (panelId) => {
    const el = document.getElementById('shard-' + panelId + '-panel');
    if (el) el.innerHTML = '<div style="padding:12px;text-align:center;opacity:0.5;font-size:12px;">Plugin disabled.<br>Enable it in Settings > Core Plugins.</div>';
  };

  switch (_activeRightTab) {
    case 'backlinks':
      if (_pluginManager?.isEnabled('backlinks')) _renderBacklinksPane(note);
      else _disabled('backlinks');
      break;
    case 'outgoing':
      if (_pluginManager?.isEnabled('outgoing-links')) _renderOutgoingPane(note);
      else _disabled('outgoing');
      break;
    case 'unlinked':
      if (_pluginManager?.isEnabled('unlinked')) _renderUnlinkedPane(note);
      else _disabled('unlinked');
      break;
    case 'outline':
      if (_pluginManager?.isEnabled('outline')) _renderOutlinePane(note);
      else _disabled('outline');
      break;
    case 'orphans':
      if (_pluginManager?.isEnabled('orphans')) _renderOrphansPane(note);
      else _disabled('orphans');
      break;
  }

  // Update word-count plugin when active note changes
  const wc = _pluginManager?.getInstance('word-count');
  if (wc && typeof wc.update === 'function') wc.update();
}

function _renderBacklinksPane(note) {
  const bl = document.getElementById('shard-backlinks-panel');
  if (!bl) return;
  // Primary: client-side compute backlinks from all notes' outbound_links
  // (more robust than backend backlinks which can get stale/corrupted)
  const targetRel = (note.rel_path || note.id || '').replace(/\\/g, '/');
  const targetTitle = note.title || '';
  const targetNames = [targetRel, targetRel.replace(/\.md$/, ''), targetTitle, targetTitle + '.md'];
  const computed = [];
  for (const n of _notes) {
    const outbound = n.outbound_links || [];
    const matches = outbound.some(link => {
      const l = link.replace(/\\/g, '/');
      return targetNames.includes(l) || targetNames.includes(l.replace(/\.md$/, ''));
    });
    if (matches) {
      const content = n.content || '';
      const lines = content.split('\n');
      const snippets = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const normalized = l.replace(/\\/g, '/');
        if (targetNames.some(tn => normalized.includes('[[' + tn + ']]') || normalized.includes('[[' + tn + '|') || normalized.includes('[/[' + tn + ']/]'))) {
          snippets.push(l.trim());
        } else if (targetNames.some(tn => l.includes(tn))) {
          snippets.push(l.trim());
        }
      }
      computed.push({ rel_path: n.rel_path || n.id, title: n.title, snippets: snippets.length ? snippets : [] });
    }
  }
  let links = computed.length ? computed : (note.backlinks_resolved || []);
  if (!links.length && note.backlinks && note.backlinks.length) {
    links = note.backlinks.map(bp => {
      const bpNote = _notes.find(n => n.id === bp || n.rel_path === bp);
      return { rel_path: bp, title: bpNote ? bpNote.title : bp, snippets: [] };
    });
  }
  const allExpanded = bl.dataset.expanded === 'all';
  const headerHtml = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <h4 style="font-size:11px;opacity:0.6;text-transform:uppercase;letter-spacing:0.05em;margin:0;">Backlinks (${links.length})</h4>
      ${links.length ? `<button class="shard-backlinks-toggle" title="Toggle all" style="background:transparent;border:none;color:var(--fg);opacity:0.5;cursor:pointer;padding:2px 4px;font-size:11px;display:flex;align-items:center;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
      </button>` : ''}
    </div>
  `;
  const listHtml = links.length ? links.map((b, idx) => {
    const snippetCount = (b.snippets || []).length;
    const isExpanded = allExpanded || bl.dataset['item' + idx] === 'open';
    return `<div class="shard-backlink-item" data-idx="${idx}">
      <div class="shard-backlink-header" data-id="${_esc(b.rel_path || b.id)}" style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:3px 0;font-size:12px;">
        <span class="shard-backlink-chevron" style="display:inline-flex;transition:transform 0.15s;transform:rotate(${isExpanded ? '90deg' : '0deg'});">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(b.title)}</span>
        <span style="opacity:0.5;font-size:11px;flex-shrink:0;">${snippetCount}</span>
      </div>
      <div class="shard-backlink-body" style="display:${isExpanded ? 'block' : 'none'};padding:4px 0 8px 18px;font-size:12px;opacity:0.8;line-height:1.5;">
        ${(b.snippets || []).map(s => `<div class="shard-backlink-snippet" style="margin-bottom:6px;padding:6px 8px;background:color-mix(in srgb, var(--fg) 4%, transparent);border-radius:6px;cursor:pointer;">${_esc(s)}</div>`).join('')}
      </div>
    </div>`;
  }).join('') : '<div style="opacity:0.5;font-size:11px;">No backlinks</div>';
  bl.innerHTML = headerHtml + listHtml;
  bl.querySelector('.shard-backlinks-toggle')?.addEventListener('click', function () {
    const willExpand = bl.dataset.expanded !== 'all';
    bl.dataset.expanded = willExpand ? 'all' : '';
    this.classList.toggle('active', willExpand);
    bl.querySelectorAll('.shard-backlink-item').forEach(item => {
      const idx = item.dataset.idx;
      const body = item.querySelector('.shard-backlink-body');
      const chevron = item.querySelector('.shard-backlink-chevron');
      if (body) body.style.display = willExpand ? 'block' : 'none';
      if (chevron) chevron.style.transform = willExpand ? 'rotate(90deg)' : 'rotate(0deg)';
      if (idx !== undefined) bl.dataset['item' + idx] = willExpand ? 'open' : '';
    });
  });
  bl.querySelectorAll('.shard-backlink-header').forEach(hdr => {
    hdr.addEventListener('click', (e) => {
      if (e.target.closest('.shard-backlink-snippet')) return;
      const item = hdr.closest('.shard-backlink-item');
      const body = item?.querySelector('.shard-backlink-body');
      const chevron = hdr.querySelector('.shard-backlink-chevron');
      const idx = item?.dataset.idx;
      if (!body) return;
      const isOpen = body.style.display === 'block';
      body.style.display = isOpen ? 'none' : 'block';
      if (chevron) chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
      if (idx !== undefined) bl.dataset['item' + idx] = isOpen ? '' : 'open';
    });
  });
  bl.querySelectorAll('.shard-backlink-snippet').forEach(snip => {
    snip.addEventListener('click', (e) => {
      const hdr = snip.closest('.shard-backlink-item')?.querySelector('.shard-backlink-header');
      if (hdr) _navigateToNote(hdr.dataset.id, true, e.ctrlKey || e.metaKey);
    });
  });
}

function _renderOutgoingPane(note) {
  const out = document.getElementById('shard-outgoing-panel');
  if (!out) return;
  const links = note.outbound_links || [];
  out.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Outgoing (${links.length})</h4>` +
    (links.length ? links.map(t => {
      const target = _notes.find(n => n.title === t);
      return `<div class="shard-sidebar-link ${target ? '' : 'ghost'}" data-title="${_esc(t)}">${_esc(t)}</div>`;
    }).join('') : '<div style="opacity:0.5;font-size:11px;">No outgoing links</div>');
  out.querySelectorAll('.shard-sidebar-link').forEach(el => {
    el.addEventListener('click', async (e) => {
      const target = _notes.find(n => n.title === el.dataset.title);
      if (target) {
        _navigateToNote(target.id, true, e.ctrlKey || e.metaKey);
      } else {
        const created = await _getOrCreateNoteByTitle(el.dataset.title);
        if (created) _navigateToNote(created.id, true, e.ctrlKey || e.metaKey);
      }
    });
  });
}

function _renderNoteTagsPane(note) {
  const tags = document.getElementById('shard-tags-panel');
  if (!tags) return;
  const t = note.tags || [];
  tags.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Tags</h4>` +
    (t.length ? t.map(tag => `<span class="shard-tag" style="cursor:pointer;">${_esc(tag)}</span>`).join(' ') : '<div style="opacity:0.5;font-size:11px;">No tags</div>');
}

function _renderUnlinkedPane(note) {
  const el = document.getElementById('shard-unlinked-panel');
  if (!el) return;
  // Find note titles mentioned in content but not wrapped in [[...]]
  const content = note.content || '';
  const otherNotes = _notes.filter(n => n.id !== note.id);
  const mentions = [];
  otherNotes.forEach(n => {
    const title = n.title || '';
    if (!title) return;
    // Look for title text that is NOT inside [[...]]
    const regex = new RegExp('(?<!\\[)\\b' + _escRegExp(title) + '\\b(?!\\])', 'gi');
    let match;
    while ((match = regex.exec(content)) !== null) {
      // Check if it's inside wikilink brackets by looking around
      const before = content.slice(Math.max(0, match.index - 20), match.index);
      const after = content.slice(match.index + match[0].length, match.index + match[0].length + 20);
      const insideLink = (before.includes('[[') && after.includes(']]')) || (before.includes('[/[') && after.includes(']/]'));
      if (!insideLink) {
        const start = Math.max(0, match.index - 40);
        const end = Math.min(content.length, match.index + match[0].length + 40);
        const snippet = content.slice(start, end).replace(/\n/g, ' ');
        mentions.push({ note: n, snippet });
      }
    }
  });
  // Deduplicate by note id, keep first mention
  const seen = new Set();
  const unique = mentions.filter(m => {
    if (seen.has(m.note.id)) return false;
    seen.add(m.note.id);
    return true;
  });

  el.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Unlinked mentions (${unique.length})</h4>` +
    (unique.length ? unique.map(m =>
      `<div class="shard-sidebar-link" data-note-id="${_esc(m.note.id)}" style="font-size:12px;padding:3px 0;cursor:pointer;">
        <div style="font-weight:500;">${_esc(m.note.title)}</div>
        <div style="opacity:0.6;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(m.snippet)}</div>
      </div>`
    ).join('') : '<div style="opacity:0.5;font-size:11px;">No unlinked mentions</div>');
  el.querySelectorAll('[data-note-id]').forEach(item => {
    item.addEventListener('click', () => _navigateToNote(item.dataset.noteId));
  });
}

function _renderOutlinePane(note) {
  const el = document.getElementById('shard-outline-panel');
  if (!el) return;
  const content = note.content || '';
  const headings = [];
  const regex = /^(#{1,6})\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    headings.push({ level: match[1].length, text: match[2].trim() });
  }
  el.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Outline</h4>` +
    (headings.length ? headings.map((h, i) =>
      `<div class="shard-outline-item" data-idx="${i}" style="font-size:12px;padding:3px 0 3px ${(h.level - 1) * 12}px;cursor:pointer;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${_esc(h.text)}
      </div>`
    ).join('') : '<div style="opacity:0.5;font-size:11px;">No headings</div>');
  el.querySelectorAll('.shard-outline-item').forEach(item => {
    item.addEventListener('click', () => {
      // Scroll to heading in preview
      const preview = document.getElementById('shard-preview');
      if (!preview) return;
      const hTags = ['H1','H2','H3','H4','H5','H6'];
      const headingEls = preview.querySelectorAll(hTags.join(','));
      const idx = parseInt(item.dataset.idx, 10);
      if (headingEls[idx]) headingEls[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function _renderOrphansPane(note) {
  const el = document.getElementById('shard-orphans-panel');
  if (!el) return;
  // File-specific orphans: wikilinks in this note that point to non-existent notes
  const orphanedLinks = new Set();
  const content = note.content || '';
  // Parse [[Link]], [[Link|alias]], or [/[/Link]/] from content
  const wikiRegex = /\[\[([^\]]+)\]\]|\[\/\[([^\]]+)\]\/\]/g;
  let m;
  while ((m = wikiRegex.exec(content)) !== null) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    const parts = raw.split('|');
    const target = parts[0].trim();
    const display = parts[1]?.trim() || target;
    const exists = _notes.some(n => n.title === target || n.id === target || (n.rel_path || '').replace(/\\/g, '/') === target.replace(/\\/g, '/'));
    if (!exists) orphanedLinks.add(JSON.stringify({ target, display }));
  }
  // Also check note.outbound_links for any that don't resolve
  (note.outbound_links || []).forEach(link => {
    const target = link.replace(/\\/g, '/');
    const exists = _notes.some(n => n.title === target || n.id === target || (n.rel_path || '').replace(/\\/g, '/') === target || (n.rel_path || '').replace(/\\/g, '/').replace(/\.md$/, '') === target);
    if (!exists) {
      const display = target.replace(/\.md$/, '').split('/').pop();
      orphanedLinks.add(JSON.stringify({ target, display }));
    }
  });
  const orphans = Array.from(orphanedLinks).map(s => JSON.parse(s));
  el.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Orphans (${orphans.length})</h4>` +
    (orphans.length ? orphans.map(o =>
      `<div class="shard-sidebar-link" data-orphan-target="${_esc(o.target)}" style="font-size:12px;padding:3px 0;cursor:pointer;">${_esc(o.display)}</div>`
    ).join('') : '<div style="opacity:0.5;font-size:11px;">No orphan links in this file</div>');
  el.querySelectorAll('[data-orphan-target]').forEach(item => {
    item.addEventListener('click', () => {
      // Search for this link in the note body and scroll to it
      const preview = document.getElementById('shard-preview');
      if (preview) {
        const target = item.dataset.orphanTarget;
        const linkEl = preview.querySelector(`a.wikilink[data-note="${CSS.escape(target)}"]`) ||
                        preview.querySelector(`a.wikilink-source[data-note="${CSS.escape(target)}"]`);
        if (linkEl) linkEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });
}

function _injectAsContext(note) {
  window.dispatchEvent(new CustomEvent('odysseus-shard-context', {
    detail: { label: `Shard: ${note.title}`, content: note.content }
  }));
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(`[[${note.title}]]\n\n${note.content.slice(0, 2000)}`);
  }
}

// ── Graph / Timeline ───────────────────────────────────────

function _renderGraph() {
  const container = document.getElementById('shard-graph-canvas');
  if (!container || !window.vis) return;
  import('./shardGraphCanvas.js').then(mod => {
    mod.renderShardGraph(container, _selectedVaultId);
  }).catch(err => {
    container.innerHTML = `<div class="shard-error">Graph error: ${err.message}</div>`;
  });
}

function _renderTimeline() {
  const wrap = document.getElementById('shard-timeline-wrap');
  if (!wrap) return;
  import('./shardTimeline.js').then(mod => {
    mod.renderShardTimeline(wrap, _selectedVaultId);
  }).catch(err => {
    wrap.innerHTML = `<div class="shard-error">Timeline error: ${err.message}</div>`;
  });
}

// ── Permissions ────────────────────────────────────────────

async function _loadPermissions() {
  if (!_selectedVaultId) return;
  try {
    const r = await fetch(`${API_BASE}/api/shard/vaults/${_selectedVaultId}/permissions`, { credentials: 'same-origin' });
    if (!r.ok) return;
    const data = await r.json();
    _permissions = data.permissions || [];
    _renderPermissions();
  } catch (e) {
    console.error('[shard] load permissions failed', e);
  }
}

function _renderPermissions() {
  const table = document.getElementById('shard-permissions-table');
  if (!table) return;
  if (!_permissions.length) {
    table.innerHTML = '<div style="padding:12px;text-align:center;opacity:0.5;font-size:12px;">No permission rules yet</div>';
    return;
  }
  table.innerHTML = `
    <div class="shard-perm-header">
      <span>Type</span><span>Pattern</span><span>Perm</span><span>Prio</span><span></span>
    </div>
    ${_permissions.map(p => `
      <div class="shard-perm-row" data-id="${p.id}">
        <span class="shard-perm-type">${_esc(p.pattern_type)}</span>
        <span class="shard-perm-pattern" title="${_esc(p.path_pattern)}">${_esc(p.path_pattern)}</span>
        <span class="shard-perm-level ${_esc(p.permission)}">${_esc(p.permission)}</span>
        <span class="shard-perm-priority">${p.priority}</span>
        <button class="shard-perm-del" data-id="${p.id}">&times;</button>
      </div>
    `).join('')}
  `;
  table.querySelectorAll('.shard-perm-del').forEach(btn => {
    btn.addEventListener('click', () => _removePermission(btn.dataset.id));
  });
}

async function _updateVaultToggles() {
  if (!_selectedVaultId) return;
  const readCb = document.getElementById('shard-vault-read-all');
  const writeCb = document.getElementById('shard-vault-write-all');
  const read_enabled = readCb?.checked ?? true;
  const write_enabled = writeCb?.checked ?? false;
  try {
    await fetch(`${API_BASE}/api/shard/vaults/${_selectedVaultId}`, {
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
    _populateVaultDropdown();
    _selectVault(_selectedVaultId);
  } catch (e) {
    console.error('[shard] update vault toggles failed', e);
  }
}

async function _refreshVault() {
  if (!_selectedVaultId) return;
  const btn = document.getElementById('shard-refresh-btn');
  if (btn) btn.style.opacity = '0.5';
  try {
    // Direct filesystem read — no backend sync needed
    await _loadNotes();
    await _loadFolders();
  } catch (e) {
    console.error('[shard] refresh failed', e);
  } finally {
    if (btn) btn.style.opacity = '';
  }
}

async function _addPermission() {
  if (!_selectedVaultId) return;
  const typeSel = document.getElementById('shard-new-perm-type');
  const patternInput = document.getElementById('shard-new-perm-pattern');
  const levelSel = document.getElementById('shard-new-perm-level');
  const priorityInput = document.getElementById('shard-new-perm-priority');

  const pattern = patternInput?.value.trim();
  if (!pattern) return;

  try {
    const r = await fetch(`${API_BASE}/api/shard/vaults/${_selectedVaultId}/permissions`, {
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
    console.error('[shard] add permission failed', e);
  }
}

async function _removePermission(permId) {
  if (!_selectedVaultId || !permId) return;
  try {
    await fetch(`${API_BASE}/api/shard/vaults/${_selectedVaultId}/permissions/${permId}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    await _loadPermissions();
  } catch (e) {
    console.error('[shard] remove permission failed', e);
  }
}

// ── Resize panes ───────────────────────────────────────────

function _wireResizeHandles() {
  if (typeof document === 'undefined') return;

  // Restore saved widths
  try {
    const saved = JSON.parse(localStorage.getItem('shard-pane-widths') || '{}');
    if (saved.left) document.documentElement.style.setProperty('--shard-left-w', saved.left + 'px');
    if (saved.right) document.documentElement.style.setProperty('--shard-right-w', saved.right + 'px');
  } catch {}

  const leftHandle = document.getElementById('shard-resize-left');
  const rightHandle = document.getElementById('shard-resize-right');
  const pane3 = document.querySelector('.shard-3pane');
  if (!pane3) return;

  function setup(handle, side) {
    if (!handle) return;
    let startX = 0;
    let startSize = 0;
    let isDragging = false;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      const computed = getComputedStyle(document.documentElement);
      const prop = side === 'left' ? '--shard-left-w' : '--shard-right-w';
      startSize = parseInt(computed.getPropertyValue(prop)) || 200;
      handle.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const delta = side === 'left' ? e.clientX - startX : startX - e.clientX;
      const newSize = Math.max(120, Math.min(400, startSize + delta));
      const prop = side === 'left' ? '--shard-left-w' : '--shard-right-w';
      document.documentElement.style.setProperty(prop, newSize + 'px');
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      handle.classList.remove('dragging');
      const left = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--shard-left-w')) || 200;
      const right = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--shard-right-w')) || 200;
      try { localStorage.setItem('shard-pane-widths', JSON.stringify({ left, right })); } catch {}
    });
  }

  setup(leftHandle, 'left');
  setup(rightHandle, 'right');
}

// ── Helpers ────────────────────────────────────────────────

function _esc(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ── Context menus ────────────────────────────────────────────

let _activeContextMenu = null;
let _activeContextSubmenu = null;

function _hideContextMenu(e) {
  // If an event is passed, only hide if click was outside the menu/submenu
  if (e && e.target) {
    if (_activeContextMenu?.contains(e.target)) return;
    if (_activeContextSubmenu?.contains(e.target)) return;
  }
  if (_activeContextMenu) { _activeContextMenu.remove(); _activeContextMenu = null; }
  if (_activeContextSubmenu) { _activeContextSubmenu.remove(); _activeContextSubmenu = null; }
  document.removeEventListener('click', _hideContextMenu);
  document.removeEventListener('keydown', _contextMenuKeyHandler);
}

function _contextMenuKeyHandler(e) {
  if (e.key === 'Escape') _hideContextMenu();
}

function _showContextMenu(x, y, items) {
  _hideContextMenu();
  console.log('[shard] _showContextMenu', x, y, items.length);
  const menu = document.createElement('div');
  menu.className = 'shard-context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  items.forEach(item => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'shard-context-menu-separator';
      menu.appendChild(sep);
      return;
    }
    const row = document.createElement('div');
    row.className = 'shard-context-menu-item' + (item.disabled ? ' disabled' : '') + (item.danger ? ' danger' : '');
    const check = item.checked ? '<span style="margin-right:4px;opacity:0.8;">&#10003;</span>' : '<span style="margin-right:4px;opacity:0;">&#10003;</span>';
    row.innerHTML = `<span>${check}${_esc(item.label)}</span>${item.shortcut ? `<span style="opacity:0.5;font-size:11px;">${_esc(item.shortcut)}</span>` : ''}`;
    if (!item.disabled) {
      row.addEventListener('click', () => {
        _hideContextMenu();
        item.action();
      });
      if (item.submenu) {
        row.addEventListener('mouseenter', () => {
          if (_activeContextSubmenu) _activeContextSubmenu.remove();
          const rect = row.getBoundingClientRect();
          const sub = document.createElement('div');
          sub.className = 'shard-context-menu-submenu';
          sub.style.left = (rect.right + 2) + 'px';
          sub.style.top = rect.top + 'px';
          item.submenu.forEach(si => {
            if (si.separator) {
              const ssep = document.createElement('div');
              ssep.className = 'shard-context-menu-separator';
              sub.appendChild(ssep);
              return;
            }
            const srow = document.createElement('div');
            srow.className = 'shard-context-menu-item' + (si.disabled ? ' disabled' : '');
            srow.innerHTML = `<span>${_esc(si.label)}</span>`;
            if (!si.disabled) {
              srow.addEventListener('click', () => { _hideContextMenu(); si.action(); });
            }
            sub.appendChild(srow);
          });
          document.body.appendChild(sub);
          _activeContextSubmenu = sub;
        });
      }
    }
    menu.appendChild(row);
  });

  document.body.appendChild(menu);
  _activeContextMenu = menu;

  // Keep inside viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  setTimeout(() => {
    document.addEventListener('click', _hideContextMenu);
    document.addEventListener('keydown', _contextMenuKeyHandler);
  }, 0);
}

function _buildFolderSubmenu(noteId, currentFolder) {
  const folders = [''];
  _notes.forEach(n => {
    const f = (n.folder || '').replace(/\\/g, '/');
    if (f && !folders.includes(f)) folders.push(f);
  });
  folders.sort();
  return folders.map(f => ({
    label: f || '(root)',
    action: async () => {
      const note = _notes.find(n => n.id === noteId);
      const oldFolder = note ? note.folder : '';
      if (note) note.folder = f;
      _renderFolderTree();
      try {
        const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(noteId)}/move`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ folder: f }),
        });
        if (!r.ok) throw new Error();
      } catch {
        if (note) note.folder = oldFolder;
        _renderFolderTree();
      }
    },
  }));
}

function _showNoteMenu(e, note) {
  e.stopPropagation();
  e.preventDefault();
  const rect = e.currentTarget.getBoundingClientRect();
  const isBookmarked = _bookmarks.has(note.id);
  _showContextMenu(rect.left, rect.bottom + 4, [
    { label: 'Reading view', checked: _previewMode === 'preview', action: () => { _previewMode = 'preview'; _updateModeIcon(); _selectNote(note.id); } },
    { label: 'Live Preview', checked: _previewMode === 'live', action: () => { _editModePref = 'live'; _previewMode = 'live'; _updateModeIcon(); _selectNote(note.id); } },
    { label: 'Source mode', checked: _previewMode === 'edit', action: () => { _editModePref = 'edit'; _previewMode = 'edit'; _updateModeIcon(); _selectNote(note.id); } },
    { separator: true },
    { label: 'Rename...', action: () => _promptRenameNote(note.id) },
    { label: 'Move file to…', submenu: _buildFolderSubmenu(note.id, note.folder) },
    { label: 'Make a copy', action: () => _duplicateNote(note.id) },
    { separator: true },
    { label: isBookmarked ? 'Unbookmark' : 'Bookmark', action: () => {
      if (isBookmarked) _bookmarks.delete(note.id); else _bookmarks.add(note.id);
      _persistBookmarks();
      _renderBookmarksPane();
      _renderFolderTree();
    }},
    { label: 'Add file property', action: () => {
      const btn = document.querySelector('.shard-prop-add-main');
      if (btn) btn.click();
    }},
    { separator: true },
    { label: 'Copy Shard URL', action: () => _copyShardUrl(note.id) },
    { label: 'Copy path', action: () => navigator.clipboard?.writeText(note.rel_path || note.id) },
    { separator: true },
    { label: 'Reveal file in navigation', action: () => {
      const tree = document.getElementById('shard-folder-tree');
      const row = tree?.querySelector(`.shard-tree-row[data-note-id="${CSS.escape(note.id)}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.style.background = 'color-mix(in srgb, var(--accent, var(--red, #4a9eff)) 20%, transparent)';
        setTimeout(() => { row.style.background = ''; }, 1500);
      }
    }},
    { separator: true },
    { label: 'Split right', disabled: true, action: () => {} },
    { label: 'Split down', disabled: true, action: () => {} },
    { label: 'Open in new window', disabled: true, action: () => {} },
    { label: 'Open in Hover Editor', disabled: true, action: () => {} },
    { label: 'Export to PDF...', disabled: true, action: () => {} },
    { label: 'Merge entire file with...', disabled: true, action: () => {} },
    { label: 'Open in default app', disabled: true, action: () => {} },
    { label: 'Show in system explorer', disabled: true, action: () => {} },
  ]);
}

function _showFileContextMenu(e, noteId) {
  e.preventDefault();
  e.stopPropagation();
  const note = _notes.find(n => n.id === noteId);
  const isBookmarked = note ? _bookmarks.has(noteId) : false;
  _showContextMenu(e.clientX, e.clientY, [
    { label: 'Open in new tab', action: () => _navigateToNote(noteId, true, true) },
    { label: 'Open to the right', action: () => _navigateToNote(noteId, true, true) },
    { label: 'Open in new window', disabled: true, action: () => {} },
    { separator: true },
    { label: 'Make a copy', action: () => _duplicateNote(noteId) },
    { label: 'Move file to…', submenu: _buildFolderSubmenu(noteId, note?.folder) },
    { label: isBookmarked ? 'Unbookmark' : 'Bookmark', action: () => {
      if (isBookmarked) _bookmarks.delete(noteId); else _bookmarks.add(noteId);
      _persistBookmarks();
      _renderBookmarksPane();
      _renderFolderTree();
    }},
    { label: 'Merge entire file with...', disabled: true, action: () => {} },
    { separator: true },
    { label: 'Copy Shard URL', action: () => _copyShardUrl(noteId) },
    { label: 'Copy formatted Advanced URI', disabled: true, action: () => {} },
    { label: 'Copy path', action: () => {
      const n = _notes.find(n => n.id === noteId);
      if (n) navigator.clipboard?.writeText(n.rel_path || n.id);
    }},
    { separator: true },
    { label: 'Open in default app', disabled: true, action: () => {} },
    { label: 'Show in system explorer', disabled: true, action: () => {} },
    { separator: true },
    { label: 'Change icon', disabled: true, action: () => {} },
    { label: 'Encrypt note', disabled: true, action: () => {} },
    { label: `Hide « ${_esc(note?.title || '')} »`, disabled: true, action: () => {} },
    { separator: true },
    { label: 'Rename...', action: () => _promptRenameNote(noteId) },
    { label: 'Delete', danger: true, action: () => _deleteNote(noteId) },
    { separator: true },
    { label: 'Manage all fields', disabled: true, action: () => {} },
    { label: 'Add field at section...', disabled: true, action: () => {} },
    { label: 'Add field in frontmatter', disabled: true, action: () => {} },
    { label: 'Add missing fields at section...', disabled: true, action: () => {} },
    { label: `Add fileClass to ${_esc(note?.title || '')}`, disabled: true, action: () => {} },
    { label: 'Add command', disabled: true, action: () => {} },
  ]);
}

function _showFolderContextMenu(e, folder) {
  e.preventDefault();
  e.stopPropagation();
  _showContextMenu(e.clientX, e.clientY, [
    { label: 'New note', action: () => _createNoteInFolder(folder) },
    { label: 'New folder', action: () => _promptNewFolder(folder) },
    { separator: true },
    { label: 'Collapse all', action: () => _collapseAllFolders() },
    { label: 'Expand all', action: () => _expandAllFolders() },
    { separator: true },
    { label: 'Rename folder', action: () => _promptRenameFolder(folder) },
    { label: 'Delete folder', disabled: true, action: () => {} },
  ]);
}

function _showBlankContextMenu(e) {
  e.preventDefault();
  e.stopPropagation();
  _showContextMenu(e.clientX, e.clientY, [
    { label: 'New note', action: () => _createNoteInFolder('') },
    { label: 'New folder', action: () => _promptNewFolder('') },
    { separator: true },
    { label: 'Collapse all', action: () => _collapseAllFolders() },
    { label: 'Expand all', action: () => _expandAllFolders() },
  ]);
}

// Placeholder actions for context menu items needing backend support
async function _doRenameNote(noteId, newName) {
  const note = _notes.find(n => n.id === noteId);
  if (!note || !newName || newName === note.title) return;
  let fileName = newName;
  if (!fileName.endsWith('.md')) fileName += '.md';
  try {
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(noteId)}/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ folder: fileName }),
    });
    if (!r.ok) throw new Error();
    await _loadNotes();
    await _loadFolders();
    _renderFolderTree();
    if (_selectedNoteId === noteId) _navigateToNote(fileName, true);
  } catch (e) {
    console.error('[shard] rename failed', e);
  }
}
async function _promptRenameNote(noteId) {
  const note = _notes.find(n => n.id === noteId);
  if (!note) return;
  const newName = await styledPrompt('Rename note:', { defaultValue: note.title, confirmText: 'Rename' });
  if (!newName) return;
  await _doRenameNote(noteId, newName);
}
async function _duplicateNote(noteId) {
  try {
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(noteId)}/duplicate`, {
      method: 'POST', credentials: 'same-origin',
    });
    if (!r.ok) throw new Error();
    const data = await r.json();
    await _loadNotes();
    await _loadFolders();
    _renderFolderTree();
    if (data.note_id) _navigateToNote(data.note_id, true, true);
  } catch (e) {
    console.error('[shard] duplicate failed', e);
  }
}
async function _deleteNote(noteId) {
  const note = _notes.find(n => n.id === noteId);
  if (!note) return;
  const confirmed = await styledConfirm(`Delete "${_esc(note.title)}"?`, { confirmText: 'Delete', cancelText: 'Cancel', danger: true });
  if (!confirmed) return;
  try {
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(noteId)}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
    if (!r.ok) throw new Error();
    await _loadNotes();
    await _loadFolders();
    _renderFolderTree();
    if (_selectedNoteId === noteId) {
      _selectedNoteId = null;
      const preview = document.getElementById('shard-preview');
      if (preview) preview.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;">Select a note to view</div>';
      _renderRightSidebar(null);
    }
    _renderNoteTabs();
  } catch (e) {
    console.error('[shard] delete failed', e);
  }
}
function _copyShardUrl(noteId) {
  const note = _notes.find(n => n.id === noteId);
  if (!note) return;
  const url = `shard://open?vault=${encodeURIComponent(_selectedVaultId || '')}&file=${encodeURIComponent(note.title)}`;
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url);
}
async function _getOrCreateNoteByTitle(title) {
  let note = _notes.find(n => n.title === title);
  if (note) return note;
  const fileName = title.endsWith('.md') ? title : `${title}.md`;
  try {
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(fileName)}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ content: '' }),
    });
    if (r.ok) {
      await _loadNotes();
      await _loadFolders();
      _renderFolderTree();
      note = _notes.find(n => n.title === title);
      return note;
    }
  } catch (e) {
    console.error('[shard] create ghost note failed', e);
  }
  return null;
}

async function _createNoteInFolder(folder) {
  const fileName = _findUniqueUntitled('Untitled', _notes, '.md');
  try {
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(fileName)}/edit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ content: '' }),
    });
    if (!r.ok) throw new Error();
    await _loadNotes();
    await _loadFolders();
    const note = _notes.find(n => n.id === fileName || n.rel_path === fileName);
    if (note && folder) {
      note.folder = folder;
      _renderFolderTree();
      try {
        await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(note.id)}/move`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ folder }),
        });
      } catch {}
    }
    if (note) {
      _autoRenameNoteId = note.id;
      _navigateToNote(note.id, true, true);
    } else {
      _renderFolderTree();
    }
  } catch (e) {
    console.error('[shard] create note failed', e);
  }
}
async function _promptNewFolder(parent) {
  const allFolders = new Set();
  _notes.forEach(n => { if (n.folder) allFolders.add(n.folder); });
  const base = _findUniqueUntitled('Untitled Folder', Array.from(allFolders).map(f => ({ id: f, rel_path: f })));
  const path = parent ? `${parent}/${base}` : base;
  try {
    const r = await fetch(`${API_BASE}/api/shard/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ path }),
    });
    if (!r.ok) throw new Error();
    await _loadFolders();
    _expandedFolders.add(path);
    _renderFolderTree();
    // Trigger inline rename
    setTimeout(() => _startInlineFolderRename(path), 50);
  } catch (e) {
    console.error('[shard] create folder failed', e);
  }
}
function _startInlineFolderRename(folderPath) {
  // Find the folder row in the tree and make its label editable
  const tree = document.getElementById('shard-folder-tree');
  if (!tree) return;
  const row = tree.querySelector(`.shard-tree-row[data-folder="${CSS.escape(folderPath)}"] .shard-tree-label`);
  if (!row) return;
  const original = row.textContent;
  row.contentEditable = 'true';
  row.focus();
  // Select all text
  const range = document.createRange();
  range.selectNodeContents(row);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = async () => {
    row.contentEditable = 'false';
    const newName = row.textContent.trim();
    if (!newName || newName === original) {
      row.textContent = original;
      return;
    }
    // Extract parent path
    const parts = folderPath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');
    try {
      const r = await fetch(`${API_BASE}/api/shard/folders/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ old_path: folderPath, new_path: newPath }),
      });
      if (!r.ok) throw new Error();
      await _loadFolders();
      await _loadNotes();
      _renderFolderTree();
    } catch (e) {
      console.error('[shard] rename folder failed', e);
      row.textContent = original;
    }
  };

  row.addEventListener('blur', finish, { once: true });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); row.blur(); }
    if (e.key === 'Escape') { row.textContent = original; row.contentEditable = 'false'; }
  }, { once: true });
}
function _collapseAllFolders() {
  _expandedFolders.clear();
  _renderFolderTree();
}
function _expandAllFolders() {
  _collectAllFolders();
  _renderFolderTree();
}
function _collectAllFolders() {
  const tree = document.getElementById('shard-folder-tree');
  if (!tree) return;
  tree.querySelectorAll('[data-folder]').forEach(row => {
    const folder = row.dataset.folder;
    if (folder) _expandedFolders.add(folder);
  });
}
async function _promptRenameFolder(folder) {
  const newName = await styledPrompt('Rename folder:', { defaultValue: folder, confirmText: 'Rename' });
  if (!newName || newName === folder) return;
  try {
    const r = await fetch(`${API_BASE}/api/shard/folders/${encodeURIComponent(folder)}/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ name: newName }),
    });
    if (!r.ok) throw new Error();
    await _loadNotes();
    await _loadFolders();
    _renderFolderTree();
  } catch (e) {
    console.error('[shard] rename folder failed', e);
  }
}

function _showVaultSettings() {
  _switchTab('permissions');
}

function _openVaultDialog(vaultId) {
  const vault = _vaults.find(v => v.id === vaultId);
  if (!vault) return;
  const dialog = document.getElementById('shard-vault-dialog');
  const nameInput = document.getElementById('shard-vault-dialog-name');
  const pathInput = document.getElementById('shard-vault-dialog-path');
  const countEl = document.getElementById('shard-vault-dialog-count');
  const titleEl = document.getElementById('shard-vault-dialog-title');
  if (!dialog) return;

  titleEl.textContent = _esc(vault.name);
  nameInput.value = vault.name || '';
  pathInput.value = vault.path || '';
  countEl.textContent = `${vault.note_count || 0} notes`;

  dialog.classList.remove('hidden');

  const closeHandler = () => dialog.classList.add('hidden');
  const removeHandler = async () => {
    const confirmed = await styledConfirm(
      `Remove vault "${_esc(vault.name)}"?\n\nThis will stop syncing but won't delete any files on disk.`,
      { confirmText: 'Remove', cancelText: 'Cancel', danger: true }
    );
    if (confirmed) {
      dialog.classList.add('hidden');
      await _removeVault(vaultId);
    }
  };

  const closeBtn = document.getElementById('shard-vault-dialog-close');
  const cancelBtn = document.getElementById('shard-vault-dialog-cancel');
  const removeBtn = document.getElementById('shard-vault-dialog-remove');

  // Remove old listeners by cloning
  if (closeBtn) {
    const newClose = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newClose, closeBtn);
    newClose.addEventListener('click', closeHandler);
  }
  if (cancelBtn) {
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    newCancel.addEventListener('click', closeHandler);
  }
  if (removeBtn) {
    const newRemove = removeBtn.cloneNode(true);
    removeBtn.parentNode.replaceChild(newRemove, removeBtn);
    newRemove.addEventListener('click', removeHandler);
  }
}

// ── Init wiring ──────────────────────────────────────────────

function _init() {
  // Left sidebar tabs
  document.getElementById('shard-left-tabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.shard-sidebar-tab');
    if (!tab) return;
    _switchLeftTab(tab.dataset.tab);
  });

  // Right sidebar tabs
  document.getElementById('shard-right-tabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.shard-right-tab');
    if (!tab) return;
    _switchRightTab(tab.dataset.tab);
  });

  // Search input + clear + case + sort + settings
  const searchInput = document.getElementById('shard-search-input');
  const clearBtn = document.getElementById('shard-search-clear');
  const caseBtn = document.getElementById('shard-search-case');
  const sortBtn = document.getElementById('shard-search-sort-btn');
  const sortDropdown = document.getElementById('shard-search-sort-dropdown');
  const settingsBtn = document.getElementById('shard-search-settings-btn');
  const settingsPanel = document.getElementById('shard-search-settings');

  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => _renderSearchPane(searchInput.value), 150);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { searchInput.value = ''; _renderSearchPane(''); }
      if (e.key === 'Enter') {
        _addSearchHistory(searchInput.value);
        _renderSearchHistory();
      }
    });
    searchInput.addEventListener('focus', () => {
      if (!searchInput.value.trim()) _toggleSearchEmpty(true);
    });
    searchInput.addEventListener('blur', () => {
      // Delay to allow clicks on empty-state items to register
      setTimeout(() => {
        if (document.activeElement !== searchInput && !searchInput.value.trim()) {
          _toggleSearchEmpty(false);
        }
      }, 200);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      _renderSearchPane('');
    });
  }

  if (caseBtn) {
    caseBtn.addEventListener('click', () => {
      _searchState.caseSensitive = !_searchState.caseSensitive;
      caseBtn.classList.toggle('active', _searchState.caseSensitive);
      if (searchInput) _renderSearchPane(searchInput.value);
    });
  }

  // Sort dropdown
  if (sortBtn && sortDropdown) {
    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sortDropdown.classList.toggle('hidden');
      settingsPanel?.classList.add('hidden');
    });
    sortDropdown.querySelectorAll('.shard-search-sort-item').forEach(item => {
      item.addEventListener('click', () => {
        _searchState.sortBy = item.dataset.sort;
        sortDropdown.querySelectorAll('.shard-search-sort-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        sortDropdown.classList.add('hidden');
        if (searchInput) _renderSearchPane(searchInput.value);
      });
    });
  }

  // Settings panel
  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settingsPanel.classList.toggle('hidden');
      sortDropdown?.classList.add('hidden');
    });
    // Wire toggles inside settings
    const collapseCb = document.getElementById('shard-search-collapse');
    const contextCb = document.getElementById('shard-search-context');
    const explainCb = document.getElementById('shard-search-explain');
    if (collapseCb) {
      collapseCb.checked = _searchState.collapse;
      collapseCb.addEventListener('change', () => {
        _searchState.collapse = collapseCb.checked;
        if (searchInput) _renderSearchPane(searchInput.value);
      });
    }
    if (contextCb) {
      contextCb.checked = _searchState.context;
      contextCb.addEventListener('change', () => {
        _searchState.context = contextCb.checked;
        if (searchInput) _renderSearchPane(searchInput.value);
      });
    }
    if (explainCb) {
      explainCb.checked = _searchState.explain;
      explainCb.addEventListener('change', () => {
        _searchState.explain = explainCb.checked;
        if (searchInput) _renderSearchPane(searchInput.value);
      });
    }
  }

  // Close dropdowns on outside click
  document.addEventListener('click', () => {
    sortDropdown?.classList.add('hidden');
    settingsPanel?.classList.add('hidden');
  });

  // ── Plugin System (Phase 4.1 / 4.2) ────────────────────────
  _shardApp = createAppApi({
    get vaultNotes() { return _notes; },
    get vaultFolders() { return _folders; },
    getActiveFileId: () => _selectedNoteId,
    onOpenLink: (text) => {
      const target = _notes.find(n => n.title === text);
      if (target) _navigateToNote(target.id, true, false);
    },
  });
  _pluginManager = new PluginManager(_shardApp);

  // Register all core plugins (existing features become toggleable)
  const _manifest = (id) => CORE_PLUGINS.find(m => m.id === id);
  _pluginManager.register(_manifest('graph'),          GraphPlugin);
  _pluginManager.register(_manifest('backlinks'),      BacklinksPlugin);
  _pluginManager.register(_manifest('outgoing-links'),  OutgoingLinksPlugin);
  _pluginManager.register(_manifest('unlinked'),       UnlinkedMentionsPlugin);
  _pluginManager.register(_manifest('outline'),        OutlinePlugin);
  _pluginManager.register(_manifest('orphans'),          OrphansPlugin);
  _pluginManager.register(_manifest('bookmarks'),        BookmarksPlugin);
  _pluginManager.register(_manifest('tags'),           TagsPlugin);
  _pluginManager.register(_manifest('search'),          SearchPlugin);
  _pluginManager.register(_manifest('daily-notes'),    DailyNotesPlugin);
  _pluginManager.register(_manifest('templates'),      TemplatesPlugin);
  _pluginManager.register(_manifest('page-preview'),   PagePreviewPlugin);
  _pluginManager.register(_manifest('word-count'),     WordCountPlugin);
  _pluginManager.register(_manifest('random-note'),    RandomNotePlugin);

  // Default: enable everything on first run, then respect persisted settings
  try {
    let settings = JSON.parse(localStorage.getItem('shard-settings') || '{}');
    if (!settings.enabledPlugins) {
      settings.enabledPlugins = CORE_PLUGINS.map(m => m.id);
    }
    _pluginManager.loadFromSettings(settings);
  } catch {}

  // Sync tab visibility with plugin state
  _syncPluginTabs();
}

/** Show/hide tab buttons whose feature is a toggleable plugin */
function _syncPluginTabs() {
  if (!_pluginManager) return;
  // Right sidebar tabs
  document.querySelectorAll('#shard-right-tabs .shard-right-tab').forEach(btn => {
    const tab = btn.dataset.tab;
    const map = {
      backlinks: 'backlinks',
      outgoing: 'outgoing-links',
      unlinked: 'unlinked',
      outline: 'outline',
      orphans: 'orphans',
    };
    const pid = map[tab];
    if (pid) btn.classList.toggle('hidden', !_pluginManager.isEnabled(pid));
  });
  // Left sidebar plugin tabs
  document.querySelectorAll('#shard-left-tabs .shard-sidebar-tab').forEach(btn => {
    const tab = btn.dataset.tab;
    const map = {
      bookmarks: 'bookmarks',
      tags: 'tags',
      search: 'search',
    };
    const pid = map[tab];
    if (pid) btn.classList.toggle('hidden', !_pluginManager.isEnabled(pid));
  });
}

// ── Command Palette / Quick Switcher (Phase 2.5) ───────────

let _quickSwitcherEl = null;
let _quickSwitcherIndex = 0;
let _commandPaletteEl = null;
let _commandPaletteIndex = 0;
let _qsEscHandler = null;
let _cpEscHandler = null;

function _hideQuickSwitcher() {
  if (_qsEscHandler) { document.removeEventListener('keydown', _qsEscHandler, true); _qsEscHandler = null; }
  if (_quickSwitcherEl) { _quickSwitcherEl.remove(); _quickSwitcherEl = null; }
}

function _hideCommandPalette() {
  if (_cpEscHandler) { document.removeEventListener('keydown', _cpEscHandler, true); _cpEscHandler = null; }
  if (_commandPaletteEl) { _commandPaletteEl.remove(); _commandPaletteEl = null; }
}

function _showQuickSwitcher() {
  _hideQuickSwitcher();
  const modal = document.getElementById('shard-modal');
  if (!modal) return;
  const overlay = document.createElement('div');
  overlay.className = 'shard-quick-switcher';
  overlay.innerHTML = `
    <div class="shard-qs-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;">
      <div class="shard-qs-box" style="width:520px;max-width:90vw;background:var(--bg-raised,var(--bg,#1a1a1a));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;overflow:hidden;">
        <input type="text" class="shard-qs-input" placeholder="Quick switcher..." style="width:100%;background:transparent;color:var(--fg);border:none;border-bottom:1px solid var(--border);padding:12px 14px;font-size:15px;outline:none;box-sizing:border-box;" autocomplete="off" spellcheck="false">
        <div class="shard-qs-results" style="max-height:320px;overflow-y:auto;padding:4px 0;"></div>
        <div class="shard-qs-hint" style="padding:6px 14px;font-size:11px;opacity:0.5;border-top:1px solid var(--border);">↑↓ to navigate · Enter to open · Shift+Enter in new tab · Esc to close</div>
      </div>
    </div>
  `;
  modal.appendChild(overlay);
  _quickSwitcherEl = overlay;
  const input = overlay.querySelector('.shard-qs-input');
  const results = overlay.querySelector('.shard-qs-results');

  const renderResults = (query) => {
    const q = query.trim().toLowerCase();
    let items = [];
    if (!q) {
      // Show recent notes (last 10 from history)
      const recentIds = _historyStack.slice(-10).reverse();
      items = recentIds.map(id => _notes.find(n => n.id === id)).filter(Boolean);
    } else {
      // Fuzzy match
      items = _notes.map(n => {
        const title = (n.title || '').toLowerCase();
        const content = (n.content || '').toLowerCase().slice(0, 200);
        let score = 0;
        if (title === q) score = 100;
        else if (title.startsWith(q)) score = 80;
        else if (title.includes(q)) score = 60;
        else if (content.includes(q)) score = 30;
        return { note: n, score };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).map(x => x.note);
    }
    if (!items.length) {
      results.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;font-size:13px;">No results</div>';
      return;
    }
    results.innerHTML = items.slice(0, 20).map((n, i) => `
      <div class="shard-qs-item" data-note-id="${_esc(n.id)}" data-index="${i}" style="padding:7px 14px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;border-radius:4px;margin:0 4px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(n.title || n.id)}</span>
        <span style="opacity:0.4;font-size:11px;">${_esc(n.folder || '')}</span>
      </div>
    `).join('');
    _quickSwitcherIndex = 0;
    _updateQsSelection(results);
  };

  const _updateQsSelection = (container) => {
    container.querySelectorAll('.shard-qs-item').forEach((el, i) => {
      el.style.background = i === _quickSwitcherIndex ? 'color-mix(in srgb, var(--accent, var(--red)) 15%, transparent)' : 'transparent';
    });
    const selected = container.querySelector(`.shard-qs-item[data-index="${_quickSwitcherIndex}"]`);
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => renderResults(input.value));
  input.addEventListener('keydown', (e) => {
    const items = results.querySelectorAll('.shard-qs-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _quickSwitcherIndex = Math.min(_quickSwitcherIndex + 1, items.length - 1);
      _updateQsSelection(results);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _quickSwitcherIndex = Math.max(_quickSwitcherIndex - 1, 0);
      _updateQsSelection(results);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const selected = results.querySelector(`.shard-qs-item[data-index="${_quickSwitcherIndex}"]`);
      if (selected) {
        const newTab = e.shiftKey;
        _navigateToNote(selected.dataset.noteId, true, newTab);
      }
      _hideQuickSwitcher();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      _hideQuickSwitcher();
    }
  });

  results.addEventListener('click', (e) => {
    const item = e.target.closest('.shard-qs-item');
    if (item) {
      _navigateToNote(item.dataset.noteId, true, e.shiftKey);
      _hideQuickSwitcher();
    }
  });

  // Click backdrop to close
  overlay.querySelector('.shard-qs-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) _hideQuickSwitcher();
  });

  input.focus();
  renderResults('');

  // Capture-phase ESC handler to prevent modal close
  _qsEscHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      _hideQuickSwitcher();
    }
  };
  document.addEventListener('keydown', _qsEscHandler, true);
}

function _shardKeyHandler(e) {
  // Only handle when shard panel is open and no input is focused (unless it's inside shard)
  const modal = document.getElementById('shard-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  // Don't steal from inputs outside shard
  const active = document.activeElement;
  const inShard = active && modal.contains(active);
  const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);

  // Ctrl+O — Quick Switcher
  if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
    e.preventDefault();
    _showQuickSwitcher();
    return;
  }

  // Ctrl+Alt+E — Cycle view modes
  if ((e.ctrlKey || e.metaKey) && e.altKey && e.key === 'e') {
    e.preventDefault();
    if (_previewMode === 'preview') _previewMode = _editModePref;
    else _previewMode = 'preview';
    _updateModeIcon();
    if (_selectedNoteId) _selectNote(_selectedNoteId);
    return;
  }

  // Ctrl+Alt+N — New note
  if ((e.ctrlKey || e.metaKey) && e.altKey && e.key === 'n') {
    e.preventDefault();
    _promptNewNote();
    return;
  }

  // Ctrl+Shift+P — Command palette
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    _showCommandPalette();
    return;
  }

  // Escape closes command palette if open
  if (e.key === 'Escape' && _commandPaletteEl) {
    return; // Let the palette's own handler deal with it
  }

  // Escape closes quick switcher if open (handled inside the switcher's own listener)
  if (e.key === 'Escape' && _quickSwitcherEl) {
    return;
  }
}

function _showCommandPalette() {
  _hideCommandPalette();
  const modal = document.getElementById('shard-modal');
  if (!modal) return;
  const overlay = document.createElement('div');
  overlay.className = 'shard-command-palette';
  overlay.innerHTML = `
    <div class="shard-cp-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;">
      <div class="shard-cp-box" style="width:520px;max-width:90vw;background:var(--bg-raised,var(--bg,#1a1a1a));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;overflow:hidden;">
        <input type="text" class="shard-cp-input" placeholder="Type a command..." style="width:100%;background:transparent;color:var(--fg);border:none;border-bottom:1px solid var(--border);padding:12px 14px;font-size:15px;outline:none;box-sizing:border-box;" autocomplete="off" spellcheck="false">
        <div class="shard-cp-results" style="max-height:320px;overflow-y:auto;padding:4px 0;"></div>
        <div class="shard-cp-hint" style="padding:6px 14px;font-size:11px;opacity:0.5;border-top:1px solid var(--border);">↑↓ to navigate · Enter to run · Esc to close</div>
      </div>
    </div>
  `;
  modal.appendChild(overlay);
  _commandPaletteEl = overlay;
  const input = overlay.querySelector('.shard-cp-input');
  const results = overlay.querySelector('.shard-cp-results');

  const BASE_COMMANDS = [
    { id: 'new-note', label: 'Shard: New note', action: () => _promptNewNote() },
    { id: 'toggle-reading', label: 'Shard: Toggle reading view', action: () => { _previewMode = 'preview'; _updateModeIcon(); if (_selectedNoteId) _selectNote(_selectedNoteId); } },
    { id: 'toggle-live', label: 'Shard: Toggle live preview', action: () => { _editModePref = 'live'; _previewMode = 'live'; _updateModeIcon(); if (_selectedNoteId) _selectNote(_selectedNoteId); } },
    { id: 'toggle-source', label: 'Shard: Toggle source view', action: () => { _editModePref = 'edit'; _previewMode = 'edit'; _updateModeIcon(); if (_selectedNoteId) _selectNote(_selectedNoteId); } },
    { id: 'quick-switcher', label: 'Shard: Open quick switcher', action: () => { _hideCommandPalette(); setTimeout(_showQuickSwitcher, 50); } },
    { id: 'fold-all', label: 'Shard: Fold all headings', action: () => { /* TODO */ } },
    { id: 'unfold-all', label: 'Shard: Unfold all headings', action: () => { /* TODO */ } },
    { id: 'graph-view', label: 'Shard: Toggle graph view', action: () => { /* TODO */ } },
    { id: 'daily-note', label: 'Shard: Open daily note', action: () => { /* TODO */ } },
  ];
  // Add plugin commands
  const pluginCmds = _pluginManager ? _pluginManager.getEnabled().flatMap(p =>
    (p._commands || []).map(c => ({ id: c.id, label: c.name || c.id, action: c.callback }))
  ) : [];
  const COMMANDS = [...BASE_COMMANDS, ...pluginCmds];

  const renderCommands = (query) => {
    const q = query.trim().toLowerCase();
    const items = q
      ? COMMANDS.filter(c => c.label.toLowerCase().includes(q))
      : COMMANDS;
    if (!items.length) {
      results.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;font-size:13px;">No commands</div>';
      return;
    }
    results.innerHTML = items.map((c, i) => `
      <div class="shard-cp-item" data-cmd-id="${_esc(c.id)}" data-index="${i}" style="padding:7px 14px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;border-radius:4px;margin:0 4px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(c.label)}</span>
      </div>
    `).join('');
    _commandPaletteIndex = 0;
    _updateCpSelection(results);
  };

  const _updateCpSelection = (container) => {
    container.querySelectorAll('.shard-cp-item').forEach((el, i) => {
      el.style.background = i === _commandPaletteIndex ? 'color-mix(in srgb, var(--accent, var(--red)) 15%, transparent)' : 'transparent';
    });
    const selected = container.querySelector(`.shard-cp-item[data-index="${_commandPaletteIndex}"]`);
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => renderCommands(input.value));
  input.addEventListener('keydown', (e) => {
    const items = results.querySelectorAll('.shard-cp-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _commandPaletteIndex = Math.min(_commandPaletteIndex + 1, items.length - 1);
      _updateCpSelection(results);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _commandPaletteIndex = Math.max(_commandPaletteIndex - 1, 0);
      _updateCpSelection(results);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const selected = results.querySelector(`.shard-cp-item[data-index="${_commandPaletteIndex}"]`);
      if (selected) {
        const cmd = COMMANDS.find(c => c.id === selected.dataset.cmdId);
        if (cmd) cmd.action();
      }
      _hideCommandPalette();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      _hideCommandPalette();
    }
  });

  results.addEventListener('click', (e) => {
    const item = e.target.closest('.shard-cp-item');
    if (item) {
      const cmd = COMMANDS.find(c => c.id === item.dataset.cmdId);
      if (cmd) cmd.action();
      _hideCommandPalette();
    }
  });

  overlay.querySelector('.shard-cp-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) _hideCommandPalette();
  });

  input.focus();
  renderCommands('');

  _cpEscHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      _hideCommandPalette();
    }
  };
  document.addEventListener('keydown', _cpEscHandler, true);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}

const shardModule = { openPanel, closePanel, togglePanel, isOpen, toggleBookmark: _toggleBookmark };
export default shardModule;
window.shardModule = shardModule;
