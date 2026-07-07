/**
 * The Vault — floating modal panel for vault sync, graph, and timeline.
 */

import { makeWindowDraggable } from './windowDrag.js';
import { makeWindowResizable } from './windowResize.js';
import { vaultMdToHtml, buildNoteCache } from './vaultMarkdown.js';
import {
  parseInlineDatabases,
  renderDatabaseTable,
  showPropertyVisibilityDialog,
  showPropertySelectMenu,
  fetchInlineDatabases,
  editInlineDatabaseCell,
  addInlineDatabaseColumn,
  removeInlineDatabaseColumn,
  addInlineDatabaseRow,
  removeInlineDatabaseRow,
  updateInlineDatabaseSchema,
  deleteInlineDatabase,
  promoteInlineDatabase,
  promoteInlineDatabaseByMarker,
} from './vaultInlineDatabase.js';
import { createVaultSlashMenu } from './vaultSlashMenu.js';
import { styledConfirm, styledPrompt, showToast, showError } from './ui.js';
import { IS_MAC } from './platform.js';
import {
  PluginManager, createAppApi, CORE_PLUGINS,
  GraphPlugin, BacklinksPlugin, OutgoingLinksPlugin,
  UnlinkedMentionsPlugin, OutlinePlugin, OrphansPlugin,
  BookmarksPlugin, TagsPlugin, SearchPlugin,
  DailyNotesPlugin, TemplatesPlugin, PagePreviewPlugin,
  WordCountPlugin, RandomNotePlugin,
  CanvasPlugin, CommandPalettePlugin, FileRecoveryPlugin,
  NoteComposerPlugin, QuickSwitcherPlugin, UniqueNoteCreatorPlugin,
} from './vaultPluginApi.js';
import {
  fetchObsidianRegistry, loadCommunityPlugin, disableCommunityPlugin,
  uninstallPlugin, getInstalledPlugins, setPluginManager,
  loadAllEnabledPlugins, renderPluginBrowser, isPluginInstalled,
} from './pluginLoader.js';

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
let _lastClosedTab = null;
let _filePollInterval = null;
let _lastVaultMtime = 0;
let _vaults = [];
let _selectedVaultId = null;
let _permissions = [];
let _pluginManager = null;
let _vaultApp = null;
let _removedTabs = new Map(); // tabName -> detached element
let _recentDragNoteId = null; // suppress click after drag-and-drop
let _recentDragTimer = null;
let _isDraggingTree = false; // guard _renderFolderTree during drag
let _propsCollapsed = false; // global collapse state for properties section
let _dirtyNoteIds = new Set(); // notes with unsaved changes
let _saveTimers = new Map(); // noteId -> setTimeout handle
let _saveFailures = new Set(); // noteIds that failed the last save attempt

function _showLoading(text = 'Loading vault...') {
  const overlay = document.getElementById('vault-loading-overlay');
  const txt = overlay?.querySelector('.vault-loading-text');
  if (overlay) overlay.classList.remove('hidden');
  if (txt) txt.textContent = text;
}
function _hideLoading() {
  document.getElementById('vault-loading-overlay')?.classList.add('hidden');
}

function _startFilePolling() {
  if (_filePollInterval) clearInterval(_filePollInterval);
  _filePollInterval = setInterval(async () => {
    if (!_open || !_selectedVaultId) return;
    try {
      const r = await fetch(`${API_BASE}/api/vault/last-modified?vault_id=${encodeURIComponent(_selectedVaultId)}`, { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      const mtime = data.mtime || 0;
      if (_lastVaultMtime && mtime !== _lastVaultMtime) {
        await _refreshFileExplorer();
      }
      _lastVaultMtime = mtime;
    } catch {}
  }, 2000);
}

function _stopFilePolling() {
  if (_filePollInterval) { clearInterval(_filePollInterval); _filePollInterval = null; }
}

export async function openPanel() {
  await _loadVaultHtml();
  const modal = document.getElementById('vault-modal');
  if (!modal) return;
  if (_open) { _bringToFront(); return; }

  // Load vaults first so we can decide whether to show the vault panel
  // or the standalone "add vault" dialog.
  const hasVaults = _vaults && _vaults.length > 0;
  if (!hasVaults) {
    let hasCache = false;
    try {
      const cached = localStorage.getItem('vault-vaults');
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
    _loadVaults().catch(() => {});
  }

  // No vaults at all — show the standalone add-vault dialog and skip the
  // vault modal entirely so the user never sees an empty vault screen.
  if (!_vaults || !_vaults.length) {
    document.getElementById('tool-vault-btn')?.classList.add('active');
    _showAddVaultForm();
    return;
  }

  // Vaults exist — open the full vault modal normally.
  _open = true;

  // Restore saved position / fullscreen state BEFORE showing modal so it
  // opens directly in the right place and never jumps from the default
  // centred position after loading.
  const content = modal.querySelector('.modal-content');
  if (content) {
    try {
      const saved = JSON.parse(localStorage.getItem('vault-pos'));
      if (saved && saved.fullscreen) {
        _enterVaultFullscreen(content);
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
  _applyMonospaceFont();
  _bringToFront();
  _wireDrag();
  _startFilePolling();
  document.getElementById('tool-vault-btn')?.classList.add('active');
  document.addEventListener('keydown', _vaultKeyHandler);
}

export function closePanel() {
  const modal = document.getElementById('vault-modal');
  if (!modal || !_open) return;
  // Don't close if quick switcher or command palette is open — close those first
  if (_quickSwitcherEl) { _hideQuickSwitcher(); return; }
  if (_commandPaletteEl) { _hideCommandPalette(); return; }
  _open = false;
  _rootDropWired = false;
  _stopFilePolling();
  modal.classList.add('hidden');
  document.getElementById('tool-vault-btn')?.classList.remove('active');
  document.removeEventListener('keydown', _vaultKeyHandler);
  _hideQuickSwitcher();
  _hideCommandPalette();
}

export function togglePanel() {
  if (_open) closePanel(); else openPanel();
}

// Re-clamp the vault modal so it stays fully on-screen when the browser/Electron
// window is resized. Floating (dragged/resized) windows have fixed pixel
// positions that can drift off-screen after a viewport shrink.
function _reclampVaultModal() {
  const modal = document.getElementById('vault-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (modal.classList.contains('vault-fullscreen')) return;
  if (modal.classList.contains('modal-right-docked') || modal.classList.contains('modal-left-docked')) return;
  const content = modal.querySelector('.modal-content');
  if (!content || content.style.position !== 'fixed') return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minW = 320;
  const minH = 200;
  const r = content.getBoundingClientRect();

  let left = parseFloat(content.style.left) || r.left;
  let top = parseFloat(content.style.top) || r.top;
  let width = content.style.width ? parseFloat(content.style.width) : r.width;
  let height = content.style.height ? parseFloat(content.style.height) : r.height;

  width = Math.max(minW, Math.min(width, vw));
  height = Math.max(minH, Math.min(height, vh));
  left = Math.max(0, Math.min(left, vw - width));
  top = Math.max(0, Math.min(top, vh - height));

  content.style.left = left + 'px';
  content.style.top = top + 'px';
  if (content.style.width) content.style.width = width + 'px';
  if (content.style.height) content.style.height = height + 'px';
}

window.addEventListener('resize', () => {
  requestAnimationFrame(_reclampVaultModal);
  requestAnimationFrame(() => {
    const bc = document.getElementById('vault-breadcrumb');
    if (bc) _fitBreadcrumb(bc);
  });
});

// Wire close button (deferred to _init since vault.html loads dynamically).
// Use capture phase so the handler fires before windowDrag's synthetic-click
// swallow listener.
function _wireCloseButton() {
  document.getElementById('close-vault-modal')?.addEventListener('click', () => closePanel(), true);
}

// Keep _open in sync when the modal is hidden via backdrop click (ui.js
// adds .hidden directly without calling our closePanel).
function _wireBackdropClick() {
  document.getElementById('vault-modal')?.addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget && _open) {
      console.log('[vault] backdrop click detected, syncing _open');
      closePanel();
    }
  });
}

export function isOpen() { return _open; }

function _bringToFront() {
  const modal = document.getElementById('vault-modal');
  if (!modal) return;
  const z = 260;
  modal.style.zIndex = z;
}

function _enterVaultFullscreen(content) {
  const modal = document.getElementById('vault-modal');
  if (!modal || !content) return;
  if (modal.classList.contains('vault-fullscreen')) return;
  modal.classList.add('vault-fullscreen');
  content.style.position = 'fixed';
  content.style.left = '0';
  content.style.top = '0';
  const isElectron = document.body.classList.contains('electron');
  content.style.width = '100vw';
  content.style.maxWidth = '100vw';
  content.style.height = isElectron ? 'calc(100dvh - 32px)' : '100vh';
  content.style.maxHeight = isElectron ? 'calc(100dvh - 32px)' : '100vh';
  content.style.borderRadius = '0';
  content.style.margin = '0';
  content.style.transform = 'none';
  try { localStorage.setItem('vault-pos', JSON.stringify({ fullscreen: true })); } catch {}
}

function _exitVaultFullscreen(content, cx, cy) {
  const modal = document.getElementById('vault-modal');
  if (!modal || !content) return;
  if (!modal.classList.contains('vault-fullscreen')) return;
  modal.classList.remove('vault-fullscreen');
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
  const modal = document.getElementById('vault-modal');
  const content = modal?.querySelector('.modal-content');
  const header = modal?.querySelector('.modal-header');
  if (!modal || !content || !header) return;
  _dragWired = true;

  try {
    makeWindowDraggable(modal, {
      content,
      header,
      fsClass: 'vault-fullscreen',
      enableDock: true,
      enableLeftDock: true,
      onEnterFullscreen: () => _enterVaultFullscreen(content),
      onExitFullscreen: (cx, cy) => _exitVaultFullscreen(content, cx, cy),
      onDragEnd: () => {
        try {
          localStorage.setItem('vault-pos', JSON.stringify({ left: content.style.left, top: content.style.top }));
        } catch {}
      },
    });
  } catch (e) {
    console.warn('[vault] makeWindowDraggable failed:', e);
  }

  // Note tab bar — event delegation for tab switching, closing, and new tab
  document.getElementById('vault-note-tabs')?.addEventListener('click', (e) => {
    const newBtn = e.target.closest('.vault-tab-new');
    if (newBtn) {
      _showNewNotePrompt();
      return;
    }
    const closeBtn = e.target.closest('.vault-tab-close');
    const tabBtn = e.target.closest('.vault-tab');
    if (!tabBtn) return;
    const noteId = tabBtn.dataset.noteId;
    if (closeBtn && noteId) {
      e.stopPropagation();
      _openTabs = _openTabs.filter(id => id !== noteId);
      if (_selectedNoteId === noteId) {
        if (_openTabs.length > 0) {
          const nextId = _openTabs[_openTabs.length - 1];
          if (nextId === '__graph__') _openGraphView();
          else _navigateToNote(nextId, false);
        } else {
          _closeCurrentTab();
        }
      } else {
        _renderNoteTabs();
      }
      return;
    }
    if (noteId && noteId !== _selectedNoteId) {
      if (noteId === '__graph__') {
        _openGraphView();
      } else {
        _navigateToNote(noteId, false);
      }
    }
  });

  // Graph node click → open the corresponding note
  if (!window._vaultGraphSelectNoteBound) {
    window._vaultGraphSelectNoteBound = true;
    window.addEventListener('odysseus-vault-select-note', (e) => {
      const id = e.detail?.id;
      if (id) _navigateToNote(id, true);
    });
  }

  // Tab bar drag-and-drop
  const tabBar = document.getElementById('vault-note-tabs');
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
      const droppedOnTab = e.target.closest('.vault-tab');
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
  document.getElementById('vault-back-btn')?.addEventListener('click', _goBack);
  document.getElementById('vault-forward-btn')?.addEventListener('click', _goForward);

  // Search — debounced backend fetch that updates the tree
  const searchInput = document.getElementById('vault-search');
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

  _wireVaultDropdown();

  // Permissions button
  document.getElementById('vault-vault-perm-btn')?.addEventListener('click', () => {
    _switchTab('permissions');
  });

  // Permission management
  document.getElementById('vault-vault-read-all')?.addEventListener('change', _updateVaultToggles);
  document.getElementById('vault-vault-write-all')?.addEventListener('change', _updateVaultToggles);
  document.getElementById('vault-add-perm-btn')?.addEventListener('click', _addPermission);

  // Refresh button
  document.getElementById('vault-refresh-btn')?.addEventListener('click', _refreshVault);

  // Connect / Disconnect (legacy - keep for compatibility)
  document.getElementById('vault-connect-btn')?.addEventListener('click', _connectVault);
  document.getElementById('vault-disconnect-btn')?.addEventListener('click', _disconnectVault);

  // Resize panes
  _wireResizeHandles();

  // View mode buttons are wired per-note in _selectNote
}

// Wire Add Vault form listeners — deferred to _init since vault.html loads
// dynamically. The form is a standalone overlay that must work even when the
// vault modal itself is never opened.
function _wireAddVaultForm() {
  document.getElementById('vault-save-vault-btn')?.addEventListener('click', _saveNewVault);
  document.getElementById('vault-cancel-vault-btn')?.addEventListener('click', _hideAddVaultForm);

  const browseBtn = document.getElementById('vault-browse-vault-btn');
  const fileInput = document.getElementById('vault-vault-file-input');
  const isElectron = !!(window.electron || window.electronAPI);

  if (browseBtn && !isElectron) {
    // Browsers cannot reveal absolute folder paths for security.
    browseBtn.disabled = true;
    browseBtn.title = 'Folder picker is only available in the desktop app. Please type the full path manually.';
    browseBtn.classList.add('vault-browse-disabled');
  }

  if (browseBtn && fileInput) {
    browseBtn.addEventListener('click', async () => {
      // Electron: use IPC to get real folder path from main process
      if (window.electronAPI?.selectDirectory) {
        try {
          const result = await window.electronAPI.selectDirectory();
          if (result && !result.canceled && result.filePaths?.length) {
            const pathInput = document.getElementById('vault-new-vault-path');
            const nameInput = document.getElementById('vault-new-vault-name');
            if (pathInput) pathInput.value = result.filePaths[0];
            if (nameInput && !nameInput.value.trim()) {
              const folderName = result.filePaths[0].replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
              if (folderName) nameInput.value = folderName;
            }
          }
        } catch (err) {
          console.warn('[vault] electron directory picker failed:', err);
        }
        return;
      }
      // Browser fallback — should not fire because the button is disabled,
      // but kept here in case the button is enabled programmatically.
      fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
      const files = e.target.files;
      if (!files || !files.length) {
        return;
      }
      const pathInput = document.getElementById('vault-new-vault-path');
      const nameInput = document.getElementById('vault-new-vault-name');
      const relPath = files[0].webkitRelativePath || '';
      const folderName = relPath.split('/')[0] || '';
      const filePath = files[0].path || '';
      let displayPath = '';
      if (filePath && relPath) {
        // Electron exposes the real file path
        const relParts = relPath.split('/');
        const sep = filePath.includes('\\') ? '\\' : '/';
        const pathParts = filePath.split(sep);
        const rootParts = pathParts.slice(0, pathParts.length - relParts.length);
        displayPath = rootParts.join(sep);
      } else if (filePath) {
        displayPath = filePath;
      } else {
        // Standard browser: cannot reveal absolute path for security.
        // Show the folder name so the user knows what was selected.
        displayPath = folderName;
      }
      if (pathInput && displayPath) pathInput.value = displayPath;
      // Auto-fill vault name from folder name if name field is empty
      if (nameInput && !nameInput.value.trim() && folderName) {
        nameInput.value = folderName;
      }
      e.target.value = '';
    });
  }
}

// ── Vault Management ───────────────────────────────────────

async function _loadVaults() {
  try {
    // Restore from cache first
    try {
      const cached = localStorage.getItem('vault-vaults');
      if (cached) {
        const { vaults, ts } = JSON.parse(cached);
        if (Date.now() - ts < 10 * 60 * 1000) {
          _vaults = vaults;
          _populateVaultDropdown();
          if (_vaults.length > 0 && !_selectedVaultId) {
            let lastVault = null;
            try { lastVault = localStorage.getItem('vault-last-vault'); } catch {}
            const target = _vaults.find(v => v.id === lastVault) ? lastVault : _vaults[0].id;
            _selectVault(target);
          }
        }
      }
    } catch {}
    const r = await fetch(`${API_BASE}/api/vault/status`, { credentials: 'same-origin' });
    const s = r.ok ? await r.json() : {};
    _vaults = s.vaults || [];
    try { localStorage.setItem('vault-vaults', JSON.stringify({ vaults: _vaults, ts: Date.now() })); } catch {}
    _populateVaultDropdown();
    if (_vaults.length > 0 && !_selectedVaultId) {
      let lastVault = null;
      try { lastVault = localStorage.getItem('vault-last-vault'); } catch {}
      const target = _vaults.find(v => v.id === lastVault) ? lastVault : _vaults[0].id;
      _selectVault(target);
    }
  } catch (e) {
    console.error('[vault] load vaults failed', e);
    // Keep cached vaults if fetch fails
    if (!_vaults.length) _vaults = [];
  }
}

function _populateVaultDropdown() {
  const menu = document.getElementById('vault-vault-dropdown-menu');
  const label = document.getElementById('vault-vault-dropdown-label');
  if (!menu) return;

  const vault = _vaults.find(v => v.id === _selectedVaultId);
  const noteCount = _notes.length;
  if (label) label.textContent = vault ? `${_esc(vault.name)} (${noteCount})` : 'Select vault...';

  let html = '';
  if (!_vaults.length) {
    html = '<div class="vault-vault-dropdown-item" style="opacity:0.5;cursor:default;"><span class="vault-name">No vaults</span></div>';
  } else {
    html = _vaults.map(v => `
      <div class="vault-vault-dropdown-item ${_selectedVaultId === v.id ? 'selected' : ''}" data-id="${v.id}">
        <span class="vault-name">${_esc(v.name)} <span style="opacity:0.5;font-size:11px;">(${v.note_count || 0})</span></span>
        <button class="vault-menu-btn" data-id="${v.id}" title="Vault options" aria-label="Vault options">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
        </button>
      </div>
    `).join('');
  }

  html += `
    <div class="vault-vault-dropdown-item vault-vault-dropdown-add" id="vault-add-vault-item">
      <span class="vault-name">+ Add new vault</span>
    </div>
  `;
  menu.innerHTML = html;

  document.getElementById('vault-add-vault-item')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _closeVaultDropdown();
    _showAddVaultForm();
  });

  // Wire vault selection
  menu.querySelectorAll('.vault-vault-dropdown-item:not(.vault-vault-dropdown-add)').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.vault-menu-btn')) return;
      _closeVaultDropdown();
      _selectVault(item.dataset.id);
      try { localStorage.setItem('vault-last-vault', item.dataset.id); } catch {}
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
  const wrap = document.getElementById('vault-vault-dropdown-wrap');
  const trigger = document.getElementById('vault-vault-dropdown-trigger');
  if (!trigger || !wrap) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('vault-vault-dropdown-menu');
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
  const menu = document.getElementById('vault-vault-dropdown-menu');
  const wrap = document.getElementById('vault-vault-dropdown-wrap');
  if (menu) menu.classList.add('hidden');
  if (wrap) wrap.classList.remove('open');
}

async function _selectVault(vaultId) {
  _selectedVaultId = vaultId;
  _lastVaultMtime = 0;
  _selectedFolder = null;
  _searchQuery = '';
  _historyStack = [];
  _historyIndex = -1;
  _selectedNoteId = null;
  _noteContentCache.clear();
  _renderNoteTabs();
  _renderBreadcrumb(null);
  _updateNavButtons();
  const preview = document.getElementById('vault-preview');
  if (preview) { preview.innerHTML = ''; preview.style.display = 'none'; }
  const rightPane = document.getElementById('vault-right-pane');
  if (rightPane) {
    rightPane.querySelectorAll('.vault-panel-group').forEach(panelEl => {
      panelEl.querySelector('.vault-panel-placeholder, .vault-right-placeholder')?.classList.remove('hidden');
      panelEl.querySelector('.vault-right-tabs')?.classList.add('hidden');
      panelEl.querySelector('.vault-right-panes')?.classList.add('hidden');
    });
  }
  const searchInput = document.getElementById('vault-search');
  if (searchInput) searchInput.value = '';
  const vault = _vaults.find(v => v.id === vaultId);
  const mainPanel = document.getElementById('vault-main-panel');
  const folderTree = document.getElementById('vault-folder-tree');

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

  // Restore vault UI if it was hidden during the "no vaults" empty state
  const leftPane = document.querySelector('.vault-left-pane');
  const ribbon = document.getElementById('vault-ribbon-bar');
  if (mainPanel) mainPanel.classList.remove('hidden');
  if (leftPane) leftPane.classList.remove('hidden');
  if (ribbon) ribbon.classList.remove('hidden');
  if (folderTree) folderTree.classList.remove('hidden');

  // Update permission toggles
  const readCb = document.getElementById('vault-vault-read-all');
  const writeCb = document.getElementById('vault-vault-write-all');
  if (readCb) readCb.checked = vault.read_enabled;
  if (writeCb) writeCb.checked = vault.write_enabled;

  // Restore from cache immediately if available, then fetch fresh data in background
  const hadCachedNotes = _restoreCachedNotes(vaultId);
  const hadCachedFolders = _restoreCachedFolders(vaultId);
  if (!hadCachedNotes || !hadCachedFolders) {
    _showLoading('Loading notes...');
    try {
      await _loadNotes();
      await _loadFolders();
      _loadPermissions();
    } finally {
      _hideLoading();
    }
  } else {
    // Cache hit: refresh silently in background without blocking UI
    _loadNotes().then(() => _loadFolders()).then(() => _loadPermissions()).catch(() => {});
  }

  // Open startup file based on setting
  _openStartupFile();
}

function _openStartupFile() {
  const mode = _vaultSettings?.filesAndLinks?.defaultFileToOpen || 'last-opened';
  if (mode === 'none') return;
  if (mode === 'new-note') {
    _showNewNotePrompt();
    return;
  }
  if (mode === 'daily-note') {
    _openDailyNote();
    return;
  }
  if (mode === 'specific-file') {
    const specificFile = _vaultSettings?.filesAndLinks?.defaultSpecificFile;
    if (specificFile && _notes.some(n => n.id === specificFile)) {
      _navigateToNote(specificFile, false);
    }
    return;
  }
  // last-opened
  if (_selectedVaultId) {
    try {
      const lastNote = localStorage.getItem(`vault-last-note-${_selectedVaultId}`);
      if (lastNote && _notes.some(n => n.id === lastNote)) {
        _navigateToNote(lastNote, false);
      }
    } catch {}
  }

  // Fallback: if no note was selected, open the first note in the root folder
  if (!_selectedNoteId && _notes.length > 0) {
    const rootNotes = _notes.filter(n => !n.folder);
    const firstNote = rootNotes.length > 0 ? rootNotes[0] : _notes[0];
    if (firstNote) _navigateToNote(firstNote.id, false);
  }
}

function _openDailyNote() {
  const dateFormat = _vaultSettings?.plugins?.['daily-notes']?.dateFormat || 'YYYY-MM-DD';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  let fileName = dateFormat
    .replace('YYYY', String(yyyy))
    .replace('MM', mm)
    .replace('DD', dd)
    .replace('mm', pad(now.getMinutes()))
    .replace('HH', pad(now.getHours()))
    .replace('ss', pad(now.getSeconds()));
  fileName += '.md';
  const folder = _vaultSettings?.plugins?.['daily-notes']?.newFileLocation || '';
  const noteId = folder ? `${folder}/${fileName}` : fileName;
  const existing = _notes.find(n => n.id === noteId);
  if (existing) {
    _navigateToNote(noteId, false);
    return;
  }
  // Create daily note if it doesn't exist
  const templatePath = _vaultSettings?.plugins?.['daily-notes']?.templateFileLocation || '';
  let content = '';
  if (templatePath) {
    const template = _notes.find(n => n.id === templatePath || n.rel_path === templatePath);
    if (template) content = template.content || '';
  }
  _createNoteWithContent(noteId, content);
}

async function _createNoteWithContent(noteId, content) {
  _noteContentCache.delete(noteId);
  _dirtyNoteIds.delete(noteId);
  _cancelSaveTimer(noteId);
  _saveFailures.delete(noteId);
  const folder = noteId.includes('/') ? noteId.slice(0, noteId.lastIndexOf('/')) : '';
  const name = noteId.includes('/') ? noteId.slice(noteId.lastIndexOf('/') + 1) : noteId;
  // Optimistic UI
  const optimisticNote = {
    id: noteId,
    rel_path: noteId,
    title: name.replace(/\.md$/, ''),
    folder: folder,
    content: content,
    outbound_links: _extractOutboundLinks(content),
    tags: _extractTags(content),
    modified: Date.now(),
    created: Date.now(),
    properties: {},
    _optimistic: true,
  };
  _notes.push(optimisticNote);
  _renderFolderTree();
  _renderNoteList();
  _navigateToNote(noteId, false);
  try {
    const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(noteId)}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) throw new Error();
    delete optimisticNote._optimistic;
  } catch (e) {
    console.error('[vault] create note failed', e);
    const idx = _notes.findIndex(n => n.id === noteId);
    if (idx !== -1) _notes.splice(idx, 1);
    _renderFolderTree();
    _renderNoteList();
    if (_selectedNoteId === noteId) _closeCurrentTab();
    showToast('Failed to create note');
  }
}

// ── Templates ────────────────────────────────────────────────

function _getTemplates() {
  const folder = _vaultSettings?.plugins?.templates?.templateFolderLocation || '';
  if (!folder) return _notes.filter(n => n.folder?.toLowerCase() === 'templates');
  return _notes.filter(n => n.folder === folder || n.folder?.startsWith(folder + '/'));
}

function _processTemplate(content, title) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateFmt = _vaultSettings?.plugins?.templates?.dateFormat || 'DD-MM-YYYY';
  const timeFmt = _vaultSettings?.plugins?.templates?.timeFormat || 'HH:mm';

  const formatDate = (d, fmt) => {
    return fmt
      .replace('YYYY', d.getFullYear())
      .replace('MM', pad(d.getMonth() + 1))
      .replace('DD', pad(d.getDate()))
      .replace('HH', pad(d.getHours()))
      .replace('mm', pad(d.getMinutes()))
      .replace('ss', pad(d.getSeconds()));
  };

  return content
    .replace(/\{\{date:([^}]+)\}\}/g, (_, fmt) => formatDate(now, fmt))
    .replace(/\{\{date\}\}/g, formatDate(now, dateFmt))
    .replace(/\{\{time\}\}/g, formatDate(now, timeFmt))
    .replace(/\{\{title\}\}/g, title || '');
}

function _showTemplatePicker(folder, onSelect) {
  const templates = _getTemplates();
  if (!templates.length) {
    showToast('No templates found. Set a template folder in Settings > Templates.');
    return;
  }

  const modal = document.getElementById('vault-modal');
  if (!modal) return;

  const overlay = document.createElement('div');
  overlay.className = 'vault-template-picker';
  overlay.innerHTML = `
    <div class="vault-qs-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;">
      <div class="vault-qs-box" style="width:520px;max-width:90vw;background:var(--bg-raised,var(--bg,#1a1a1a));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;overflow:hidden;">
        <input type="text" class="vault-qs-input" placeholder="Pick a template..." style="width:100%;background:transparent;color:var(--fg);border:none;border-bottom:1px solid var(--border);padding:12px 14px;font-size:15px;outline:none;box-sizing:border-box;" autocomplete="off" spellcheck="false">
        <div class="vault-qs-results" style="max-height:320px;overflow-y:auto;padding:4px 0;"></div>
        <div class="vault-qs-hint" style="padding:6px 14px;font-size:11px;opacity:0.5;border-top:1px solid var(--border);">↑↓ to navigate · Enter to select · Esc to close</div>
      </div>
    </div>
  `;
  modal.appendChild(overlay);

  const input = overlay.querySelector('.vault-qs-input');
  const results = overlay.querySelector('.vault-qs-results');
  let selectedIndex = 0;

  const render = (q) => {
    const qLower = q.trim().toLowerCase();
    let items = templates;
    if (qLower) {
      items = templates.map(n => {
        const title = (n.title || '').toLowerCase();
        let score = 0;
        if (title === qLower) score = 100;
        else if (title.startsWith(qLower)) score = 80;
        else if (title.includes(qLower)) score = 60;
        return { note: n, score };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).map(x => x.note);
    }
    if (!items.length) {
      results.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;font-size:13px;">No templates</div>';
      return;
    }
    results.innerHTML = items.slice(0, 20).map((n, i) => `
      <div class="vault-qs-item" data-note-id="${_esc(n.id)}" data-index="${i}" style="padding:7px 14px;font-size:13px;cursor:pointer;pointer-events:auto;display:flex;align-items:center;gap:8px;border-radius:4px;margin:0 4px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(n.title || n.id)}</span>
        <span style="opacity:0.4;font-size:11px;">${_esc(n.folder || '')}</span>
      </div>
    `).join('');
    selectedIndex = 0;
    _updateSelection(results);
  };

  const _updateSelection = (container) => {
    const allItems = container.querySelectorAll('.vault-qs-item');
    if (selectedIndex < 0) selectedIndex = 0;
    if (selectedIndex >= allItems.length) selectedIndex = allItems.length - 1;
    allItems.forEach((el, i) => {
      el.style.background = i === selectedIndex ? 'color-mix(in srgb, var(--accent, var(--red)) 15%, transparent)' : 'transparent';
    });
    const selected = container.querySelector(`.vault-qs-item[data-index="${selectedIndex}"]`);
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  };

  const close = () => { overlay.remove(); };

  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (e) => {
    const items = results.querySelectorAll('.vault-qs-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, items.length - 1); _updateSelection(results); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, 0); _updateSelection(results); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const selected = results.querySelector(`.vault-qs-item[data-index="${selectedIndex}"]`);
      if (selected) { const note = _notes.find(n => n.id === selected.dataset.noteId); if (note) onSelect(note, folder); }
      close();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });

  results.addEventListener('click', (e) => {
    const item = e.target.closest('.vault-qs-item');
    if (item) { const note = _notes.find(n => n.id === item.dataset.noteId); if (note) onSelect(note, folder); close(); }
  });

  overlay.querySelector('.vault-qs-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  input.focus();
  render('');
}

function _insertTemplate() {
  const currentNote = _notes.find(n => n.id === _selectedNoteId);
  const title = currentNote?.title || '';
  _showTemplatePicker('', (templateNote) => {
    const raw = templateNote.content || '';
    const processed = _processTemplate(raw, title);
    _insertBlock(processed);
    showToast(`Inserted template: ${templateNote.title}`);
  });
}

async function _createNoteFromTemplate(folder) {
  _showTemplatePicker(folder, async (templateNote, targetFolder) => {
    const fileName = _findUniqueUntitled(templateNote.title.replace(/\.md$/, '') || 'Untitled', _notes, '.md');
    const title = fileName.replace(/\.md$/, '');
    const raw = templateNote.content || '';
    const content = _processTemplate(raw, title);

    const optimisticNote = {
      id: fileName,
      rel_path: fileName,
      folder: targetFolder || '',
      title: title,
      content: content,
      frontmatter: {},
      tags: _extractTags(content),
      outbound_links: _extractOutboundLinks(content),
      backlinks: [],
      last_modified_src: new Date().toISOString(),
      sync_status: 'synced',
      _optimistic: true,
    };
    _notes.push(optimisticNote);
    _notes.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    _renderFolderTree();
    _navigateToNote(fileName, true, true);

    try {
      const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(fileName)}/edit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ content }),
      });
      if (!r.ok) throw new Error();
      if (targetFolder) {
        try {
          const moveR = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(fileName)}/move`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
            body: JSON.stringify({ folder: targetFolder }),
          });
          if (moveR.ok) {
            const data = await moveR.json().catch(() => ({}));
            if (data.new_path) {
              _syncNoteIdAfterMove(fileName, data.new_path);
              optimisticNote.id = data.new_path;
              optimisticNote.rel_path = data.new_path;
              optimisticNote.folder = targetFolder;
            }
          }
        } catch {}
      }
      delete optimisticNote._optimistic;
      _autoRenameNoteId = optimisticNote.id;
      showToast(`Created note from template: ${title}`);
    } catch (e) {
      console.error('[vault] create note from template failed', e);
      const idx = _notes.findIndex(n => n.id === fileName || n.rel_path === fileName);
      if (idx !== -1) _notes.splice(idx, 1);
      _renderFolderTree();
      showToast('Failed to create note from template');
    }
  });
}

function _insertCurrentDate() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = _vaultSettings?.plugins?.templates?.dateFormat || 'DD-MM-YYYY';
  const text = fmt
    .replace('YYYY', now.getFullYear())
    .replace('MM', pad(now.getMonth() + 1))
    .replace('DD', pad(now.getDate()));
  _insertBlock(text);
}

function _insertCurrentTime() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = _vaultSettings?.plugins?.templates?.timeFormat || 'HH:mm';
  const text = fmt
    .replace('HH', pad(now.getHours()))
    .replace('mm', pad(now.getMinutes()));
  _insertBlock(text);
}

// ── Folder Tree ──────────────────────────────────────────────

let _folders = [];

function _restoreCachedFolders(vaultId) {
  try {
    const cached = localStorage.getItem(`vault-folders-${vaultId}`);
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
    const r = await fetch(`${API_BASE}/api/vault/folders?vault_id=${encodeURIComponent(_selectedVaultId)}`, { credentials: 'same-origin' });
    if (!r.ok) return;
    const data = await r.json();
    const backendFolders = data.folders || [];
    // Preserve optimistic folders not yet confirmed by backend
    const optimisticExtras = _folders.filter(f => typeof f === 'object' && f._optimistic);
    const optimisticStrings = _folders.filter(f => typeof f === 'string' && !backendFolders.includes(f));
    _folders = [...backendFolders, ...optimisticStrings];
    _renderFolderTree();
    try {
      localStorage.setItem(`vault-folders-${_selectedVaultId}`, JSON.stringify({ folders: _folders, ts: Date.now() }));
    } catch {}
  } catch (e) {
    console.error('[vault] load folders failed', e);
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
  const liClass = `vault-tree-${depthClass}${isExpanded ? ' expanded' : ''}`;

  let html = '';
  if (node.name) {
    const folderSvg = _getFolderIconSvg(node.path, 'folder', 13);
    html += `<li class="${liClass}">
      <div class="vault-tree-row ${depthClass} ${isSelected ? 'selected' : ''}" data-folder="${_esc(node.path)}" draggable="true">
        <span class="vault-tree-arrow ${arrowClass}"></span>
        <span class="vault-tree-folder-icon">${folderSvg}</span>
        <span class="vault-tree-name">${_esc(node.name)}</span>
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
      const iconSvg = _getNoteIconSvg(f.id, 'file', 13);
      const dirtyCls = _dirtyNoteIds.has(f.id) ? ' vault-note-dirty' : '';
      html += `<li class="vault-tree-sub">
        <div class="vault-tree-row sub ${f.id === _selectedNoteId ? 'selected' : ''}${dirtyCls}" data-note-id="${_esc(f.id)}" draggable="true">
          <span class="vault-tree-arrow leaf"></span>
          <span class="vault-tree-file-icon">${iconSvg}</span>
          <span class="vault-tree-name">${_esc(f.title)}</span>
        </div>
      </li>`;
    }
    html += '</ul>';
  }
  if (node.name) html += '</li>';
  return html;
}

function _renderFolderTree() {
  const tree = document.getElementById('vault-folder-tree');
  if (!tree) return;
  if (_isDraggingTree) return; // defer until dragend so dragged element survives

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

  let html = '<ul style="padding-top:4px;">';
  const { childNames } = _sortTreeEntries(root);
  for (const childName of childNames) {
    html += _renderFolderTreeNode(root.children[childName]);
  }
  // Root-level files (notes with no folder)
  const rootFiles = [...root.files].sort((a, b) => a.title.localeCompare(b.title));
  for (const f of rootFiles) {
    const iconSvg = _getNoteIconSvg(f.id, 'file', 13);
    const dirtyCls = _dirtyNoteIds.has(f.id) ? ' vault-note-dirty' : '';
    html += `<li class="vault-tree-root">
      <div class="vault-tree-row root ${f.id === _selectedNoteId ? 'selected' : ''}${dirtyCls}" data-note-id="${_esc(f.id)}" draggable="true">
        <span class="vault-tree-arrow leaf"></span>
        <span class="vault-tree-file-icon">${iconSvg}</span>
        <span class="vault-tree-name">${_esc(f.title)}</span>
      </div>
    </li>`;
  }
  html += '</ul>';
  tree.innerHTML = html;

  // Wire interactions — toggle classes directly for smooth animation (no re-render)
  tree.querySelectorAll('.vault-tree-row').forEach(row => {
    row.addEventListener('click', (e) => {
      // Note click — skip if this row was just dragged (click fires after dragend)
      if (row.dataset.noteId) {
        if (_recentDragNoteId === row.dataset.noteId) {
          _recentDragNoteId = null;
          clearTimeout(_recentDragTimer);
          return;
        }
        _navigateToNote(row.dataset.noteId, true, e.ctrlKey || e.metaKey);
        _updateTreeSelection();
        return;
      }
      // Folder click — toggles expansion (whole row is clickable, arrow is visual only)
      const folder = row.dataset.folder;
      if (folder) {
        const li = row.closest('li');
        const arrow = row.querySelector('.vault-tree-arrow');
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

    // Drag start for note / folder rows
    if (row.dataset.noteId || row.dataset.folder) {
      row.addEventListener('dragstart', (e) => {
        _isDraggingTree = true;
        clearTimeout(_recentDragTimer);
        if (row.dataset.noteId) {
          _recentDragNoteId = row.dataset.noteId;
          e.dataTransfer.setData('text/plain', row.dataset.noteId);
        } else if (row.dataset.folder) {
          e.dataTransfer.setData('text/x-vault-folder', row.dataset.folder);
        }
        e.dataTransfer.effectAllowed = 'copy';
        tree.classList.add('vault-dragging');
      });
      row.addEventListener('dragend', () => {
        _isDraggingTree = false;
        tree.classList.remove('vault-dragging');
        tree.classList.remove('vault-root-drag-over');
        _recentDragTimer = setTimeout(() => { _recentDragNoteId = null; }, 200);
        // Re-render after drag completes so the dragged element survives until dragend
        requestAnimationFrame(() => _renderFolderTree());
      });
    }

    // Drop target for folder rows
    if (row.dataset.folder) {
      row.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-vault-tab')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over');
      });
      row.addEventListener('dragenter', (e) => {
        if (e.dataTransfer.types.includes('application/x-vault-tab')) return;
      });
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drag-over');
        const targetFolder = row.dataset.folder;
        if (!targetFolder) return;

        const noteId = e.dataTransfer.getData('text/plain');
        const sourceFolder = e.dataTransfer.getData('text/x-vault-folder');

        if (noteId) {
          // Drop note onto folder
          const note = _notes.find(n => n.id === noteId);
          const oldFolder = note ? note.folder : '';
          if (note) note.folder = targetFolder;
          try {
            const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(noteId)}/move`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ folder: targetFolder }),
            });
            if (!r.ok) {
              if (note) note.folder = oldFolder;
              const data = await r.json().catch(() => ({}));
              console.error('[vault] move note failed:', data.detail || r.status);
            } else {
              const data = await r.json().catch(() => ({}));
              if (data.new_path && note) {
                const newId = data.new_path;
                _syncNoteIdAfterMove(noteId, newId);
                note.id = newId;
                note.rel_path = newId;
              }
            }
          } catch (err) {
            if (note) note.folder = oldFolder;
            console.error('[vault] move note error:', err);
          }
          _renderFolderTree();
        } else if (sourceFolder && sourceFolder !== targetFolder && !targetFolder.startsWith(sourceFolder + '/')) {
          // Drop folder into another folder (avoid dropping a folder into itself or its descendant)
          const newPath = targetFolder ? `${targetFolder}/${sourceFolder.split('/').pop()}` : sourceFolder.split('/').pop();
          // Optimistic: update _folders and note.folder paths
          const oldPrefix = sourceFolder;
          const newPrefix = newPath;
          _folders = _folders.map(f => {
            if (f === oldPrefix) return newPrefix;
            if (f.startsWith(oldPrefix + '/')) return newPrefix + f.slice(oldPrefix.length);
            return f;
          });
          _notes.forEach(n => {
            if (!n.folder) return;
            const f = n.folder.replace(/\\/g, '/');
            if (f === oldPrefix) n.folder = newPrefix;
            else if (f.startsWith(oldPrefix + '/')) n.folder = newPrefix + f.slice(oldPrefix.length);
          });
          try {
            const r = await fetch(`${API_BASE}/api/vault/folders/rename`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ old_path: sourceFolder, new_path: newPath }),
            });
            if (!r.ok) throw new Error();
            await _loadFolders();
            await _loadNotes();
          } catch (err) {
            console.error('[vault] move folder failed:', err);
            await _loadFolders();
            await _loadNotes();
          }
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
    if (e.target.closest('.vault-tree-row')) return;
    e.preventDefault();
    e.stopPropagation();
    _showBlankContextMenu(e);
  });

  // Root drop target: dropping on empty space in the tree moves to root
  if (!_rootDropWired) {
    _rootDropWired = true;
    tree.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-vault-tab')) return;
      // Only handle if not over a folder row (those have their own handlers)
      if (e.target.closest('.vault-tree-row[data-folder]')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      tree.classList.add('vault-root-drag-over');
    });
    tree.addEventListener('dragleave', (e) => {
      if (e.dataTransfer.types.includes('application/x-vault-tab')) {
        tree.classList.remove('vault-root-drag-over');
        return;
      }
      if (e.target.closest('.vault-tree-row[data-folder]')) return;
      tree.classList.remove('vault-root-drag-over');
    });
    tree.addEventListener('drop', async (e) => {
      // Only handle if dropped on empty space (not on a folder row)
      if (e.target.closest('.vault-tree-row[data-folder]')) return;
      e.preventDefault();
      tree.classList.remove('vault-root-drag-over');
      const noteId = e.dataTransfer.getData('text/plain');
      const sourceFolder = e.dataTransfer.getData('text/x-vault-folder');

      if (noteId) {
        // Drop note onto root
        const note = _notes.find(n => n.id === noteId);
        const oldFolder = note ? note.folder : '';
        if (note) note.folder = '';
        try {
          const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(noteId)}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ folder: '' }),
          });
          if (!r.ok) {
            if (note) note.folder = oldFolder;
            const data = await r.json().catch(() => ({}));
            console.error('[vault] move to root failed:', data.detail || r.status);
          } else {
            const data = await r.json().catch(() => ({}));
            if (data.new_path && note) {
              const newId = data.new_path;
              _syncNoteIdAfterMove(noteId, newId);
              note.id = newId;
              note.rel_path = newId;
            }
          }
        } catch (err) {
          if (note) note.folder = oldFolder;
          console.error('[vault] move to root error:', err);
        }
        _renderFolderTree();
      } else if (sourceFolder) {
        // Drop folder onto root
        const newPath = sourceFolder.split('/').pop();
        const oldPrefix = sourceFolder;
        const newPrefix = newPath;
        _folders = _folders.map(f => {
          if (f === oldPrefix) return newPrefix;
          if (f.startsWith(oldPrefix + '/')) return newPrefix + f.slice(oldPrefix.length);
          return f;
        });
        _notes.forEach(n => {
          if (!n.folder) return;
          const f = n.folder.replace(/\\/g, '/');
          if (f === oldPrefix) n.folder = newPrefix;
          else if (f.startsWith(oldPrefix + '/')) n.folder = newPrefix + f.slice(oldPrefix.length);
        });
        try {
          const r = await fetch(`${API_BASE}/api/vault/folders/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ old_path: sourceFolder, new_path: newPath }),
          });
          if (!r.ok) throw new Error();
          await _loadFolders();
          await _loadNotes();
        } catch (err) {
          console.error('[vault] move folder to root failed:', err);
          await _loadFolders();
          await _loadNotes();
        }
      }
    });
  }
}

function _updateTreeSelection() {
  const tree = document.getElementById('vault-folder-tree');
  if (!tree) return;
  tree.querySelectorAll('.vault-tree-row').forEach(row => {
    const shouldSelect = row.dataset.folder === _selectedFolder || row.dataset.noteId === _selectedNoteId;
    row.classList.toggle('selected', shouldSelect);
  });
}

function _showAddVaultForm() {
  const form = document.getElementById('vault-add-vault-form');
  if (form) {
    form.classList.remove('hidden');
    // Clear inputs
    const nameInput = document.getElementById('vault-new-vault-name');
    const pathInput = document.getElementById('vault-new-vault-path');
    if (nameInput) nameInput.value = '';
    if (pathInput) pathInput.value = '';
  }
  const hint = document.getElementById('vault-browse-hint');
  if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
}

function _hideAddVaultForm() {
  document.getElementById('vault-add-vault-form')?.classList.add('hidden');
  const status = document.getElementById('vault-add-vault-status');
  if (status) status.textContent = '';
  // If the user cancelled and there are still no vaults, clean up the vault
  // button active state and close the panel (no-op if modal never opened).
  if (!_vaults || !_vaults.length) {
    document.getElementById('tool-vault-btn')?.classList.remove('active');
    closePanel();
  }
}

async function _saveNewVault() {
  const nameInput = document.getElementById('vault-new-vault-name');
  const pathInput = document.getElementById('vault-new-vault-path');
  const statusEl = document.getElementById('vault-add-vault-status');
  const name = nameInput?.value.trim();
  const path = pathInput?.value.trim();
  if (!path) { if (statusEl) statusEl.textContent = 'Enter a vault path'; return; }

  if (statusEl) statusEl.textContent = 'Connecting...';
  _showLoading('Adding vault...');
  try {
    const r = await fetch(`${API_BASE}/api/vault/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ vault_path: path, name: name || undefined, read_enabled: true, write_enabled: false }),
    });
    const data = await r.json();
    if (r.ok) {
      if (nameInput) nameInput.value = '';
      if (pathInput) pathInput.value = '';
      await _loadVaults();
      if (data.vault_id) await _selectVault(data.vault_id);
      _hideAddVaultForm();
      // If the vault modal was never opened (user had no vaults initially),
      // open it now so the vault UI is visible.
      if (!_open) await openPanel();
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
  const pathInput = document.getElementById('vault-vault-path');
  const statusEl = document.getElementById('vault-connect-status');
  const path = pathInput?.value.trim();
  if (!path) { if (statusEl) statusEl.textContent = 'Enter a vault path'; return; }

  if (statusEl) statusEl.textContent = 'Connecting...';
  try {
    const r = await fetch(`${API_BASE}/api/vault/connect`, {
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
    await fetch(`${API_BASE}/api/vault/disconnect`, { method: 'POST', credentials: 'same-origin' });
    _selectedVaultId = null;
    await _loadVaults();
  } catch (e) { /* ignore */ }
}

async function _removeVault(vaultId) {
  const vault = _vaults.find(v => v.id === vaultId);
  if (!vault) return;
  if (!confirm(`Remove vault "${_esc(vault.name)}" from Odysseus?\n\nNotes stay on disk. This only removes the connection.`)) return;
  try {
    const r = await fetch(`${API_BASE}/api/vault/vaults/${encodeURIComponent(vaultId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (r.ok) {
      if (_selectedVaultId === vaultId) _selectedVaultId = null;
      await _loadVaults();
    }
  } catch (e) {
    console.error('[vault] remove vault failed', e);
  }
}

// ── Tabs ───────────────────────────────────────────────────

function _switchTab(tab) {
  _activeTab = tab;
  _renderNoteTabs();
  document.querySelectorAll('[data-vault-content]').forEach(p => {
    const isActive = p.dataset.vaultContent === tab;
    p.classList.toggle('hidden', !isActive);
  });
  if (tab === 'permissions') _renderPermissions();
}

function _navigateToNote(noteId, addToHistory = true, openNewTab = false) {
  const note = _notes.find(n => n.id === noteId);
  // Don't return early if note isn't in cache — _selectNote will fetch fresh
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
  _activeTab = 'note';
  if (addToHistory) {
    if (_historyIndex < _historyStack.length - 1) {
      _historyStack = _historyStack.slice(0, _historyIndex + 1);
    }
    // Ensure the current note is recorded before navigating to the new one,
    // otherwise the history only contains the destination and back is disabled.
    const currentId = _selectedNoteId;
    if (currentId && _historyStack[_historyIndex] !== currentId) {
      _historyStack.push(currentId);
      _historyIndex++;
    }
    if (_historyStack[_historyIndex] !== noteId) {
      _historyStack.push(noteId);
      _historyIndex++;
    }
  }
  _selectedNoteId = noteId;
  _renderNoteTabs();
  _renderBreadcrumb(note || null);
  _updateNavButtons();
  document.querySelectorAll('[data-vault-content]').forEach(p => {
    p.classList.toggle('hidden', p.dataset.vaultContent !== 'note');
  });
  _renderFolderTree();
  _updateTreeSelection();
  _selectNote(noteId);
  // Persist last opened note for this vault
  if (_selectedVaultId) {
    try { localStorage.setItem(`vault-last-note-${_selectedVaultId}`, noteId); } catch {}
  }
}

function _openGraphView() {
  const graphTabId = '__graph__';
  if (!_openTabs.includes(graphTabId)) {
    _openTabs.push(graphTabId);
  }
  _selectedNoteId = graphTabId;
  _activeTab = 'graph';
  _renderNoteTabs();
  _renderBreadcrumb(null);
  _updateNavButtons();
  document.querySelectorAll('[data-vault-content]').forEach(p => {
    p.classList.toggle('hidden', p.dataset.vaultContent !== 'graph');
  });
  const container = document.getElementById('vault-main-graph-canvas');
  if (container) {
    import('./vaultGraphCanvas.js').then(mod => {
      mod.renderVaultGraph(container, _selectedVaultId);
    });
  }
}

function _goBack() {
  while (_historyIndex > 0) {
    _historyIndex--;
    const noteId = _historyStack[_historyIndex];
    if (_notes.some(n => n.id === noteId)) {
      _navigateToNote(noteId, false);
      return;
    }
    // Note was deleted; prune it from the stack
    _historyStack.splice(_historyIndex, 1);
  }
  _updateNavButtons();
}

function _goForward() {
  while (_historyIndex < _historyStack.length - 1) {
    _historyIndex++;
    const noteId = _historyStack[_historyIndex];
    if (_notes.some(n => n.id === noteId)) {
      _navigateToNote(noteId, false);
      return;
    }
    // Note was deleted; prune it from the stack
    _historyStack.splice(_historyIndex, 1);
    _historyIndex--;
  }
  _updateNavButtons();
}

function _updateModeButtons() {
  const readBtn = document.getElementById('vault-mode-read');
  const editBtn = document.getElementById('vault-mode-edit');
  if (!readBtn || !editBtn) return;
  const secondMode = _sourceModeEnabled ? 'edit' : 'live';
  editBtn.dataset.viewMode = secondMode;
  editBtn.title = _sourceModeEnabled ? 'Source mode' : 'Live preview';
  const penSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  const codeSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
  editBtn.innerHTML = _sourceModeEnabled ? codeSvg : penSvg;
  readBtn.classList.toggle('active', _previewMode === 'preview');
  editBtn.classList.toggle('active', _previewMode === secondMode);
}

let _modeTooltipEl = null;
function _ensureModeTooltip() {
  if (_modeTooltipEl) return _modeTooltipEl;
  _modeTooltipEl = document.createElement('div');
  _modeTooltipEl.className = 'vault-mode-tooltip';
  document.body.appendChild(_modeTooltipEl);
  return _modeTooltipEl;
}
function _showModeTooltip(icon) {
  const tip = _ensureModeTooltip();
  const current = _previewMode === 'preview' ? 'Reading' : _previewMode === 'live' ? 'Live Preview' : 'Source';
  const target  = _previewMode === 'preview' ? (_editModePref === 'edit' ? 'Source' : 'Live Preview') : 'Reading';
  tip.innerHTML = `<div class="vault-tooltip-line"><strong>Current View:</strong> ${current}</div><div class="vault-tooltip-line">Click for: ${target}</div>`;
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
    _lastClosedTab = _selectedNoteId;
    _openTabs = _openTabs.filter(id => id !== _selectedNoteId);
  }
  if (_openTabs.length > 0) {
    const nextId = _openTabs[_openTabs.length - 1];
    if (nextId === '__graph__') {
      _openGraphView();
      return;
    }
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
  document.getElementById('vault-preview').innerHTML = '';
  document.getElementById('vault-preview').style.display = 'none';
  _updateRightPanelVisibility();
  _renderNoteTabs();
  _renderBreadcrumb(null);
  _updateNavButtons();
}

function _updateRightPanelVisibility() {
  const pane = document.getElementById('vault-right-pane');
  if (!pane) return;
  const stack = document.getElementById('vault-right-stack');
  if (!stack) return;
  const pane3 = document.querySelector('.vault-3pane');

  // Check if any panel group is visible
  const visiblePanels = stack.querySelectorAll('.vault-panel-group:not(.hidden)');
  if (visiblePanels.length === 0) {
    pane.classList.add('hidden');
    if (pane3) pane3.classList.add('vault-right-hidden');
    return;
  }

  pane.classList.remove('hidden');
  if (pane3) pane3.classList.remove('vault-right-hidden');

  // Update placeholders for each visible panel
  for (const panelEl of visiblePanels) {
    const panelId = panelEl.dataset.panelId;
    const placeholder = panelEl.querySelector('.vault-panel-placeholder, .vault-right-placeholder');
    const tabsContainer = panelEl.querySelector('.vault-right-tabs');
    const panesContainer = panelEl.querySelector('.vault-right-panes');
    if (!_selectedNoteId) {
      if (placeholder) placeholder.classList.remove('hidden');
      if (tabsContainer) tabsContainer.classList.add('hidden');
      if (panesContainer) panesContainer.classList.add('hidden');
    } else {
      if (placeholder) placeholder.classList.add('hidden');
      if (tabsContainer) tabsContainer.classList.remove('hidden');
      if (panesContainer) panesContainer.classList.remove('hidden');
    }
  }
}

function _buildDatabaseCallbacks(ph, noteId, db, note) {
  const refresh = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(noteId)}`);
      if (r.ok) {
        const fresh = await r.json();
        fresh.content = _stripFrontmatterFromContent(fresh.content);
        if (note) {
          note.content = fresh.content;
          note.frontmatter = fresh.frontmatter;
          note.frontmatter_raw = fresh.frontmatter_raw;
        }
        _noteContentCache.set(noteId, fresh);
      }
    } catch (e) {
      console.warn('[vault] refresh fetch failed', e);
    }
    // Re-fetch databases BEFORE rendering so schema is not lost.
    try {
      const dbs = await fetchInlineDatabases(noteId);
      if (note) note._databases = dbs;
      const cached = _noteContentCache.get(noteId);
      if (cached) cached._databases = dbs;
    } catch (e) {
      console.warn('[vault] refresh databases fetch failed', e);
    }
  };
  const _ensureSchema = async () => {
    if (db.schema) return true;
    if (!note) {
      showToast('Note reference lost. Please reopen the note.');
      return false;
    }
    const saved = await _saveNoteContent(note);
    if (!saved) {
      showToast('Failed to save note. Try again.');
      return false;
    }
    try {
      const dbs = await fetchInlineDatabases(noteId);
      note._databases = dbs;
      const found = dbs.find((d) => d.marker === db.marker);
      if (found && found.schema) {
        db.schema = found.schema;
      }
    } catch (e) {
      console.warn('[vault] fetch databases failed', e);
    }
    if (!db.schema && db.marker) {
      try {
        const promoted = await promoteInlineDatabaseByMarker(noteId, db.marker);
        if (promoted && promoted.schema) {
          db.schema = promoted.schema;
          note._databases = note._databases || [];
          const idx = note._databases.findIndex((d) => d.marker === db.marker);
          if (idx >= 0) note._databases[idx] = promoted;
          else note._databases.push(promoted);
        }
      } catch (e) {
        console.error('[vault] promotion failed', e);
        showToast('Failed to create database. Check console.');
      }
    }
    if (!db.schema) {
      showToast('Database could not be created. Try saving the note first.');
    }
    return !!db.schema;
  };
  return {
    onCellEdit: async (row, col, value) => {
      if (!(await _ensureSchema())) return;
      // True optimistic: update local state immediately, re-render, then fire-and-forget API call
      if (db.schema && db.schema.rows && db.schema.rows[row]) {
        db.schema.rows[row][col] = value;
        renderDatabaseTable(ph, db, _buildDatabaseCallbacks(ph, noteId, db, note));
      }
      editInlineDatabaseCell(db.schema.id, row, col, value)
        .then(() => refresh())
        .catch((e) => console.warn('[vault] cell edit failed', e));
    },
    onAddColumn: async (name) => {
      if (!(await _ensureSchema())) return;
      const result = await addInlineDatabaseColumn(db.schema.id, name);
      if (result && result.schema) {
        db.schema = result.schema;
        renderDatabaseTable(ph, db, _buildDatabaseCallbacks(ph, noteId, db, note));
      }
      refresh().catch(() => {});
    },
    onRemoveColumn: async (colIdx) => {
      if (!(await _ensureSchema())) return;
      const result = await removeInlineDatabaseColumn(db.schema.id, colIdx);
      if (result && result.schema) {
        db.schema = result.schema;
        renderDatabaseTable(ph, db, _buildDatabaseCallbacks(ph, noteId, db, note));
      }
      refresh().catch(() => {});
    },
    onAddRow: async () => {
      if (!(await _ensureSchema())) return;
      const result = await addInlineDatabaseRow(db.schema.id, []);
      if (result && result.schema) {
        db.schema = result.schema;
        renderDatabaseTable(ph, db, _buildDatabaseCallbacks(ph, noteId, db, note));
      }
      refresh().catch(() => {});
    },
    onRemoveRow: async (rowIdx) => {
      if (!(await _ensureSchema())) return;
      await removeInlineDatabaseRow(db.schema.id, rowIdx);
      // remove_row doesn't return schema; fetch fresh and re-render
      try {
        const dbs = await fetchInlineDatabases(noteId);
        if (note) note._databases = dbs;
        const cached = _noteContentCache.get(noteId);
        if (cached) cached._databases = dbs;
        const found = dbs.find((d) => d.marker === db.marker);
        if (found && found.schema) {
          db.schema = found.schema;
          renderDatabaseTable(ph, db, _buildDatabaseCallbacks(ph, noteId, db, note));
        }
      } catch (e) {
        console.warn('[vault] refresh after remove row failed', e);
      }
      refresh().catch(() => {});
    },
    onFilter: async (column, value) => {
      if (!(await _ensureSchema())) return;
      const filters = [...(db.schema.filters || [])];
      const existing = filters.findIndex((f) => f.column === column);
      if (existing >= 0) filters.splice(existing, 1);
      filters.push({ column, op: 'contains', value });
      await updateInlineDatabaseSchema(db.schema.id, { filters });
      db.schema.filters = filters;
      renderDatabaseTable(ph, db, _buildDatabaseCallbacks(ph, noteId, db, note));
    },
    onSort: async (column, direction) => {
      if (!(await _ensureSchema())) return;
      const sort = [...(db.schema.sort || [])];
      const existing = sort.findIndex((s) => s.column === column);
      if (existing >= 0) sort.splice(existing, 1);
      sort.push({ column, direction: direction === 'desc' ? 'desc' : 'asc' });
      await updateInlineDatabaseSchema(db.schema.id, { sort });
      db.schema.sort = sort;
      renderDatabaseTable(ph, db, _buildDatabaseCallbacks(ph, noteId, db, note));
    },
    onDeleteDatabase: async () => {
      if (note && note.content) {
        const lines = note.content.split('\n');
        const markerIdx = lines.findIndex((l) => l.includes(`<!-- database: ${db.marker} -->`));
        if (markerIdx !== -1) {
          let endIdx = markerIdx + 1;
          while (endIdx < lines.length && lines[endIdx].includes('|')) endIdx++;
          lines.splice(markerIdx, endIdx - markerIdx);
          note.content = lines.join('\n');
          _markNoteDirty(note.id);
          await _saveNoteContent(note);
        }
      }
      if (db.schema) {
        try { await deleteInlineDatabase(db.schema.id); } catch (e) { console.warn('[vault] delete schema failed', e); }
      }
      await refresh();
      await _selectNote(noteId);
    },
    onShowColumnMenu: (colIdx, columns, anchorEl) => {
      showPropertyVisibilityDialog(columns, anchorEl, (updated) => {
        db.schema = db.schema || {};
        db.schema.columns = updated;
        renderDatabaseTable(ph, db, _buildDatabaseCallbacks(ph, noteId, db, note));
        if (db.schema.id) {
          updateInlineDatabaseSchema(db.schema.id, { columns: updated }).catch((e) => console.warn('[vault] update columns failed', e));
        }
      });
    },
    onShowFilterMenu: (columns, anchorEl) => {
      showPropertySelectMenu(columns, anchorEl, async (colName) => {
        const value = await styledPrompt('Value to contain', { title: 'Filter', placeholder: 'Value' });
        if (value === null) return;
        const cbs = _buildDatabaseCallbacks(ph, noteId, db, note);
        if (cbs.onFilter) cbs.onFilter(colName, value.trim());
      }, { title: 'Filter by…' });
    },
    onColumnResize: (colIdx, width) => {
      db.schema = db.schema || {};
      const updated = (db.schema.columns || []).map((c, i) =>
        i === colIdx ? { ...c, width } : { ...c }
      );
      db.schema.columns = updated;
      if (db.schema.id) {
        updateInlineDatabaseSchema(db.schema.id, { columns: updated }).catch((e) =>
          console.warn('[vault] column width update failed', e)
        );
      }
    },
    onShowSortMenu: (columns, anchorEl) => {
      showPropertySelectMenu(columns, anchorEl, async (colName) => {
        const cbs = _buildDatabaseCallbacks(ph, noteId, db, note);
        if (cbs.onSort) cbs.onSort(colName, 'asc');
      }, { title: 'Sort by…' });
    },
  };
}

function _renderInlineDatabases(container, noteId, databases, rawContent = '') {
  if (!container) return;
  const dbs = databases || [];
  const placeholders = Array.from(container.querySelectorAll('.vault-inline-db-placeholder'));
  const dbByMarker = new Map(dbs.map((d) => [d.marker, d]));
  // Track which placeholders got a server-rendered database
  const renderedMarkers = new Set();
  const _findNote = (id) => _notes.find((n) => n.id === id || n.rel_path === id);
  for (const ph of placeholders) {
    const marker = ph.dataset.marker;
    const db = dbByMarker.get(marker);
    if (!db) continue;
    renderedMarkers.add(marker);
    const note = _findNote(noteId);
    const callbacks = _buildDatabaseCallbacks(ph, noteId, db, note);
    renderDatabaseTable(ph, db, callbacks);
    _wireWikilinks(ph);
  }
  // Fallback: for placeholders without a DB record, render from markdown data
  // and attach callbacks that will lazily create the DB schema on first mutation.
  const raw = rawContent || '';
  if (!raw) return;
  const freshDbs = parseInlineDatabases(raw);
  const freshByMarker = new Map(freshDbs.map((d) => [d.marker, d]));
  for (const ph of placeholders) {
    const marker = ph.dataset.marker;
    if (renderedMarkers.has(marker)) continue;
    const fresh = freshByMarker.get(marker);
    if (!fresh) continue;
    const note = _findNote(noteId);
    const db = { ...fresh, schema: null };
    const callbacks = _buildDatabaseCallbacks(ph, noteId, db, note);
    renderDatabaseTable(ph, db, callbacks);
    _wireWikilinks(ph);
  }
}


function _renderNoteTabs() {
  const bar = document.getElementById('vault-note-tabs');
  if (!bar) return;
  if (!_openTabs.length) {
    bar.innerHTML = `<button class="vault-tab-new" title="New note">+</button>`;
    return;
  }
  const html = _openTabs.map(noteId => {
    if (noteId === '__graph__') {
      const active = noteId === _selectedNoteId ? 'active' : '';
      const icon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
      return `<button class="vault-tab ${active}" data-note-id="__graph__" title="Graph view">
        <span style="display:inline-flex;align-items:center;flex-shrink:0;margin-right:4px;">${icon}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;min-width:0;text-align:left;">Graph view</span>
        <span class="vault-tab-close" data-note-id="__graph__">&times;</span>
      </button>`;
    }
    const note = _notes.find(n => n.id === noteId);
    const title = _esc(note ? note.title : noteId);
    const active = noteId === _selectedNoteId ? 'active' : '';
    const icon = note ? _getNoteIconSvg(note.id, 'file', 11) : '';
    const dirty = _dirtyNoteIds.has(noteId) ? ' <span class="vault-dirty-dot">●</span>' : '';
    return `<button class="vault-tab ${active}" data-note-id="${_esc(noteId)}" title="${title}">
      <span style="display:inline-flex;align-items:center;flex-shrink:0;margin-right:4px;">${icon}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;min-width:0;text-align:left;">${title}${dirty}</span>
      <span class="vault-tab-close" data-note-id="${_esc(noteId)}">&times;</span>
    </button>`;
  }).join('');
  bar.innerHTML = html + `<button class="vault-tab-new" title="New note">+</button>`;
}

async function _showNewNotePrompt() {
  // Auto-generate "Untitled.md", "Untitled 1.md", etc.
  let baseName = 'Untitled';
  let name = `${baseName}.md`;
  let counter = 1;
  while (_notes.some(n => n.id === name || n.rel_path === name || n.title === baseName || n.title === name.replace(/\.md$/, ''))) {
    baseName = `Untitled ${counter}`;
    name = `${baseName}.md`;
    counter++;
  }
  // Determine target folder based on newNoteLocation setting
  let targetFolder = '';
  const loc = _vaultSettings.filesAndLinks.newNoteLocation;
  if (loc === 'same-folder') {
    const currentNote = _notes.find(n => n.id === _selectedNoteId);
    targetFolder = currentNote ? (currentNote.folder || '') : '';
  } else if (loc === 'folder') {
    targetFolder = _vaultSettings.filesAndLinks.newNoteFolder || '';
  }

  // Optimistic UI: create note immediately
  const optimisticNote = {
    id: name,
    rel_path: name,
    folder: targetFolder,
    title: baseName,
    content: '',
    frontmatter: {},
    tags: [],
    outbound_links: [],
    backlinks: [],
    last_modified_src: new Date().toISOString(),
    sync_status: 'synced',
    _optimistic: true,
  };
  _notes.push(optimisticNote);
  _notes.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  _renderFolderTree();
  _autoRenameNoteId = optimisticNote.id;
  _navigateToNote(optimisticNote.id, true, true);

  // Backend call
  try {
    const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(name)}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
      credentials: 'same-origin'
    });
    if (!r.ok) throw new Error();

    if (targetFolder) {
      try {
        const moveR = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(name)}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ folder: targetFolder }),
        });
        if (moveR.ok) {
          const data = await moveR.json().catch(() => ({}));
          if (data.new_path) {
            _syncNoteIdAfterMove(name, data.new_path);
            optimisticNote.id = data.new_path;
            optimisticNote.rel_path = data.new_path;
            optimisticNote.folder = targetFolder;
          }
        }
        await _loadNotes();
        await _loadFolders();
        _renderFolderTree();
      } catch (moveErr) {
        console.error('[vault] move new note failed:', moveErr);
      }
    }
    delete optimisticNote._optimistic;
    _autoRenameNoteId = optimisticNote.id;
  } catch (e) {
    console.error('[vault] create note failed', e);
    const idx = _notes.findIndex(n => n.id === name || n.rel_path === name);
    if (idx !== -1) _notes.splice(idx, 1);
    _renderFolderTree();
    _renderNoteTabs();
    if (_selectedNoteId === name) _closeCurrentTab();
    showToast('Failed to create note');
  }
}

function _renderBreadcrumb(note) {
  const el = document.getElementById('vault-breadcrumb');
  if (!el) return;
  if (!note) {
    el.innerHTML = '<span style="opacity:0.5;">No file selected</span>';
    return;
  }
  const parts = (note.folder || '').split('/').filter(Boolean);
  const pathParts = parts.map((part, i) => {
    const path = parts.slice(0, i + 1).join('/');
    return `<span class="vault-breadcrumb-part" data-folder="${_esc(path)}">${_esc(part)}</span>`;
  }).join('<span class="vault-breadcrumb-sep">/</span>');
  const title = `<span class="vault-breadcrumb-current">${_esc(note.title)}</span>`;
  const sep = parts.length ? '<span class="vault-breadcrumb-sep">/</span>' : '';
  el.innerHTML = (pathParts ? pathParts + sep : '') + title;
  el.querySelectorAll('.vault-breadcrumb-part').forEach(p => {
    p.addEventListener('click', () => {
      _selectedFolder = p.dataset.folder;
      _renderFolderTree();
    });
  });
  _fitBreadcrumb(el);
}

function _fitBreadcrumb(el) {
  if (!el) return;
  const parts = Array.from(el.querySelectorAll('.vault-breadcrumb-part'));
  const current = el.querySelector('.vault-breadcrumb-current');
  // Reset any previous constraints
  parts.forEach(p => { p.style.maxWidth = ''; });
  if (current) current.style.maxWidth = '';

  const containerWidth = el.clientWidth;
  if (el.scrollWidth <= containerWidth) return;

  const MIN_PART = 20;
  const MIN_CURRENT = 60;

  // Shrink leftmost parts first
  for (let i = 0; i < parts.length; i++) {
    if (el.scrollWidth <= containerWidth) break;
    const part = parts[i];
    const natural = part.scrollWidth;
    const target = Math.max(MIN_PART, natural - 50);
    part.style.maxWidth = target + 'px';
  }

  // If still overflowing, also constrain current title
  if (el.scrollWidth > containerWidth && current) {
    const overflow = el.scrollWidth - containerWidth;
    const natural = current.scrollWidth;
    current.style.maxWidth = Math.max(MIN_CURRENT, natural - overflow) + 'px';
  }
}

function _updateNavButtons() {
  const back = document.getElementById('vault-back-btn');
  const forward = document.getElementById('vault-forward-btn');
  const viewModes = document.getElementById('vault-view-modes');
  const noteMenuBtn = document.getElementById('vault-note-menu-btn');
  const hasNote = !!_selectedNoteId;

  if (back) {
    back.style.display = hasNote ? '' : 'none';
    back.disabled = _historyIndex <= 0;
  }
  if (forward) {
    forward.style.display = hasNote ? '' : 'none';
    forward.disabled = _historyIndex >= _historyStack.length - 1;
  }
  if (viewModes) viewModes.style.display = hasNote ? '' : 'none';
  if (noteMenuBtn) noteMenuBtn.style.display = hasNote ? '' : 'none';
}

// ── Panel system ───────────────────────────────────────────

let _activeLeftTab = 'files';

function _getPanelConfig(panelId) {
  return (_vaultSettings.panels || []).find(p => p.id === panelId);
}

function _getPanelForTab(tabName) {
  return (_vaultSettings.panels || []).find(p => Array.isArray(p.tabs) && p.tabs.includes(tabName));
}

function _getPanelIdForTab(tabName) {
  const panel = _getPanelForTab(tabName);
  return panel ? panel.id : null;
}

function _getPanelTabsContainer(panelId) {
  if (panelId === 'left-1') {
    return document.getElementById('vault-left-tabs');
  }
  const panelEl = document.querySelector(`.vault-panel-group[data-panel-id="${_esc(panelId)}"]`);
  if (!panelEl) return null;
  return panelEl.querySelector('.vault-right-tabs, .vault-sidebar-tabs, .vault-panel-tabs');
}

function _getPanelPanesContainer(panelId) {
  const panelEl = document.querySelector(`.vault-panel-group[data-panel-id="${_esc(panelId)}"]`);
  if (!panelEl) return null;
  return panelEl.querySelector('.vault-right-panes, .vault-sidebar-panes, .vault-panel-panes');
}

function _getPanelPlaceholder(panelId) {
  const panelEl = document.querySelector(`.vault-panel-group[data-panel-id="${_esc(panelId)}"]`);
  if (!panelEl) return null;
  return panelEl.querySelector('.vault-panel-placeholder, .vault-right-placeholder');
}

function _getActiveTabForPanel(panelId) {
  const panel = _getPanelConfig(panelId);
  return panel ? panel.activeTab : null;
}

function _setActiveTabForPanel(panelId, tab) {
  const panel = _getPanelConfig(panelId);
  if (panel) panel.activeTab = tab;
}

function _switchTabInPanel(tab, panelId) {
  const tabsContainer = _getPanelTabsContainer(panelId);
  const panesContainer = _getPanelPanesContainer(panelId);
  if (!tabsContainer || !panesContainer) return;

  _setActiveTabForPanel(panelId, tab);

  tabsContainer.querySelectorAll('[data-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  panesContainer.querySelectorAll('[data-pane]').forEach(pane => {
    pane.classList.toggle('hidden', pane.dataset.pane !== tab);
  });
}

function _updatePanelVisibility(panelId) {
  const panelEl = document.querySelector(`.vault-panel-group[data-panel-id="${_esc(panelId)}"]`);
  if (!panelEl) return;
  const panel = _getPanelConfig(panelId);
  if (!panel || !Array.isArray(panel.tabs)) { panelEl.classList.add('hidden'); _syncResizeHandles(); return; }

  const hasVisibleTab = panel.tabs.some(tab => {
    const tabBtn = panelEl.querySelector(`[data-tab="${_esc(tab)}"]`);
    return tabBtn && !tabBtn.classList.contains('hidden');
  });

  if (!hasVisibleTab) {
    panelEl.classList.add('hidden');
  } else {
    panelEl.classList.remove('hidden');
  }

  // Sync resize handle visibility adjacent to this panel
  _syncResizeHandles();
}

function _syncResizeHandles() {
  const stack = document.getElementById('vault-right-stack');
  if (!stack) return;

  // Vertical handles in the main stack
  stack.querySelectorAll('.vault-panel-resize-v').forEach(handle => {
    const prev = handle.previousElementSibling;
    const next = handle.nextElementSibling;
    const prevVisible = prev && prev.classList.contains('vault-panel-group') && !prev.classList.contains('hidden');
    const nextVisible = next && next.classList.contains('vault-panel-group') && !next.classList.contains('hidden');
    handle.classList.toggle('hidden', !(prevVisible && nextVisible));
  });

  // Horizontal handles inside rows
  document.querySelectorAll('.vault-panel-row').forEach(row => {
    row.querySelectorAll('.vault-panel-resize-h').forEach(handle => {
      const prev = handle.previousElementSibling;
      const next = handle.nextElementSibling;
      const prevVisible = prev && prev.classList.contains('vault-panel-group') && !prev.classList.contains('hidden');
      const nextVisible = next && next.classList.contains('vault-panel-group') && !next.classList.contains('hidden');
      handle.classList.toggle('hidden', !(prevVisible && nextVisible));
    });
  });
}

function _renderPanel(panelId, note) {
  const panel = _getPanelConfig(panelId);
  if (!panel) return;
  const panelEl = document.querySelector(`.vault-panel-group[data-panel-id="${_esc(panelId)}"]`);
  if (!panelEl) return;

  _updatePanelVisibility(panelId);
  if (panelEl.classList.contains('hidden')) return;

  const activeTab = _getActiveTabForPanel(panelId);
  if (!activeTab) return;

  const tabsContainer = _getPanelTabsContainer(panelId);
  const panesContainer = _getPanelPanesContainer(panelId);
  const placeholder = _getPanelPlaceholder(panelId);

  // Ensure active tab is visible
  const activeBtn = tabsContainer?.querySelector(`[data-tab="${_esc(activeTab)}"]:not(.hidden)`);
  if (!activeBtn) {
    const firstVisible = tabsContainer?.querySelector('[data-tab]:not(.hidden)');
    if (firstVisible) {
      _switchTabInPanel(firstVisible.dataset.tab, panelId);
    } else {
      // No visible tabs
      if (placeholder) placeholder.classList.remove('hidden');
      if (tabsContainer) tabsContainer.classList.add('hidden');
      if (panesContainer) panesContainer.classList.add('hidden');
      return;
    }
  }

  if (placeholder) placeholder.classList.add('hidden');
  if (tabsContainer) tabsContainer.classList.remove('hidden');
  if (panesContainer) panesContainer.classList.remove('hidden');

  const tabToRender = _getActiveTabForPanel(panelId);
  if (!tabToRender) return;

  // For right-side panels, render the active tab content
  if (panel.side === 'right' && note) {
    _renderRightPaneContent(tabToRender, note, panesContainer);
  }
  // For left-side panels
  if (panel.side === 'left') {
    if (tabToRender === 'tags' && _pluginManager?.isEnabled('tags')) _renderTagsPane();
    if (tabToRender === 'bookmarks' && _pluginManager?.isEnabled('bookmarks')) _renderBookmarksPane();
  }
}

function _renderRightPaneContent(tab, note, panesContainer) {
  switch (tab) {
    case 'backlinks':
      if (_pluginManager?.isEnabled('backlinks')) _renderBacklinksPane(note);
      break;
    case 'outgoing':
      if (_pluginManager?.isEnabled('outgoing-links')) _renderOutgoingPane(note);
      break;
    case 'unlinked':
      if (_pluginManager?.isEnabled('unlinked')) _renderUnlinkedPane(note);
      break;
    case 'outline':
      if (_pluginManager?.isEnabled('outline')) _renderOutlinePane(note);
      break;
    case 'orphans':
      if (_pluginManager?.isEnabled('orphans')) _renderOrphansPane(note);
      break;
    case 'local-graph':
      _renderLocalGraph(note);
      break;
  }
}

function _renderAllPanels(note) {
  for (const panel of (_vaultSettings.panels || [])) {
    if (panel.side === 'right') {
      _renderPanel(panel.id, note);
    } else if (panel.side === 'left') {
      _renderPanel(panel.id, null);
    }
  }
}

// ── Panel management ──────────────────────────────────────

function _createPanel(side, tabs, activeTab, options) {
  console.log('[createPanel] side:', side, 'tabs:', tabs);
  const panels = _vaultSettings.panels || [];
  const maxNum = panels.filter(p => p.side === side).length;
  const id = `${side}-${maxNum + 1}`;
  const newPanel = { id, side, tabs: tabs || [], activeTab: activeTab || (tabs ? tabs[0] : null) };
  panels.push(newPanel);
  _vaultSettings.panels = panels;
  _saveVaultSettings();

  if (side === 'right') {
    _buildRightPanelDOM(newPanel, options);
  } else {
    _buildLeftPanelDOM(newPanel);
  }
  console.log('[createPanel] created:', id);
  return newPanel;
}

function _buildRightPanelDOM(panel, options) {
  const stack = document.getElementById('vault-right-stack');
  if (!stack) return;

  const group = document.createElement('div');
  group.className = 'vault-panel-group';
  group.dataset.panelId = panel.id;

  const placeholder = document.createElement('div');
  placeholder.className = 'vault-panel-placeholder';
  placeholder.dataset.panelId = panel.id;
  placeholder.textContent = 'Select a note to see panel content.';
  group.appendChild(placeholder);

  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'vault-right-tabs';
  tabsContainer.dataset.panelId = panel.id;
  group.appendChild(tabsContainer);

  const panesContainer = document.createElement('div');
  panesContainer.className = 'vault-right-panes';
  panesContainer.dataset.panelId = panel.id;
  group.appendChild(panesContainer);

  // Wire events
  tabsContainer.addEventListener('click', (e) => {
    const tab = e.target.closest('.vault-right-tab');
    if (!tab) return;
    _switchRightTab(tab.dataset.tab, panel.id);
  });
  tabsContainer.addEventListener('contextmenu', (e) => {
    _showTabContextMenu(e, panel.id);
  });

  // Determine placement based on edge option
  const edge = options?.edge;
  const targetPanelId = options?.targetPanelId;
  if (edge && targetPanelId) {
    const targetGroup = stack.querySelector(`.vault-panel-group[data-panel-id="${_esc(targetPanelId)}"]`);
    if (targetGroup) {
      if (edge === 'top' || edge === 'bottom') {
        // Vertical placement
        const isBefore = edge === 'top';
        const sibling = isBefore ? targetGroup.previousElementSibling : targetGroup.nextElementSibling;
        const needsHandle = !(sibling && sibling.classList.contains('vault-panel-resize-v'));
        if (needsHandle) {
          const handle = document.createElement('div');
          handle.className = 'vault-panel-resize-v';
          if (isBefore) {
            stack.insertBefore(handle, targetGroup);
            stack.insertBefore(group, handle);
          } else {
            stack.insertBefore(handle, targetGroup.nextSibling);
            stack.insertBefore(group, handle.nextSibling);
          }
        } else {
          if (isBefore) stack.insertBefore(group, targetGroup);
          else stack.insertBefore(group, targetGroup.nextSibling);
        }
        return;
      } else if (edge === 'left' || edge === 'right') {
        // Horizontal placement - put panels in a row
        const isBefore = edge === 'left';
        const parentRow = targetGroup.closest('.vault-panel-row');
        if (parentRow) {
          // Already in a row - insert beside target
          const hHandle = document.createElement('div');
          hHandle.className = 'vault-panel-resize-h';
          if (isBefore) {
            parentRow.insertBefore(hHandle, targetGroup);
            parentRow.insertBefore(group, hHandle);
          } else {
            parentRow.insertBefore(hHandle, targetGroup.nextSibling);
            parentRow.insertBefore(group, hHandle.nextSibling);
          }
        } else {
          // Create a new row containing target and new panel
          const row = document.createElement('div');
          row.className = 'vault-panel-row';
          const hHandle = document.createElement('div');
          hHandle.className = 'vault-panel-resize-h';
          // Move target into row, then add handle and new panel
          targetGroup.parentNode.insertBefore(row, targetGroup);
          row.appendChild(targetGroup);
          row.appendChild(hHandle);
          row.appendChild(group);
          if (!isBefore) {
            // Swap order so new panel is on the right
            row.insertBefore(group, targetGroup);
            row.insertBefore(hHandle, targetGroup);
          }
        }
        return;
      }
    }
  }

  // Default: append to bottom of stack with vertical resize handle
  const existingPanels = stack.querySelectorAll('.vault-panel-group');
  if (existingPanels.length > 0) {
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'vault-panel-resize-v';
    stack.appendChild(resizeHandle);
  }
  stack.appendChild(group);
}

function _buildLeftPanelDOM(panel) {
  // For now, left side only supports one panel
  // This can be extended later
}

function _moveTabToPanel(tabName, fromPanelId, toPanelId) {
  console.log('[moveTabToPanel] tab:', tabName, 'from:', fromPanelId, 'to:', toPanelId);
  const fromPanel = _getPanelConfig(fromPanelId);
  const toPanel = _getPanelConfig(toPanelId);
  if (!fromPanel || !toPanel) { console.log('[moveTabToPanel] missing panel config'); return; }

  // Update settings
  if (Array.isArray(fromPanel.tabs)) {
    fromPanel.tabs = fromPanel.tabs.filter(t => t !== tabName);
  } else {
    fromPanel.tabs = [];
  }
  if (Array.isArray(toPanel.tabs)) {
    if (!toPanel.tabs.includes(tabName)) toPanel.tabs.push(tabName);
  } else {
    toPanel.tabs = [tabName];
  }

  // If the moved tab was the active tab of the source panel, switch to another tab
  if (fromPanel.activeTab === tabName) {
    fromPanel.activeTab = (Array.isArray(fromPanel.tabs) && fromPanel.tabs[0]) || null;
  }
  // Ensure destination has an active tab
  if (!toPanel.activeTab) {
    toPanel.activeTab = tabName;
  }

  _saveVaultSettings();

  // Physically move DOM elements
  const fromTabsContainer = _getPanelTabsContainer(fromPanelId);
  const toTabsContainer = _getPanelTabsContainer(toPanelId);
  const fromPanesContainer = _getPanelPanesContainer(fromPanelId);
  const toPanesContainer = _getPanelPanesContainer(toPanelId);

  if (fromTabsContainer && toTabsContainer) {
    const tabBtn = fromTabsContainer.querySelector(`[data-tab="${_esc(tabName)}"]`);
    if (tabBtn) {
      tabBtn.classList.remove('hidden');
      toTabsContainer.appendChild(tabBtn);
    }
  }
  if (fromPanesContainer && toPanesContainer) {
    const pane = fromPanesContainer.querySelector(`[data-pane="${_esc(tabName)}"]`);
    if (pane) toPanesContainer.appendChild(pane);
  }

  // Update visibility for both panels without heavy _syncPluginTabs
  _updatePanelVisibility(fromPanelId);
  _updatePanelVisibility(toPanelId);

  // Switch active tabs
  if (fromPanel.activeTab) {
    if (fromPanel.side === 'right') _switchRightTab(fromPanel.activeTab, fromPanelId);
    else _switchLeftTab(fromPanel.activeTab);
  }
  if (toPanel.activeTab) {
    if (toPanel.side === 'right') _switchRightTab(toPanel.activeTab, toPanelId);
    else _switchLeftTab(toPanel.activeTab);
  }

  // Update overall right panel visibility
  _updateRightPanelVisibility();

  // If on right side and note selected, re-render pane content
  if (toPanel.side === 'right' && _selectedNoteId) {
    const note = _notes.find(n => n.id === _selectedNoteId);
    if (note) _renderRightSidebar(note);
  }
}

function _moveTabToNewPanel(tabName, fromPanelId, edge, targetPanelId) {
  console.log('[moveTabToNewPanel] tab:', tabName, 'from:', fromPanelId, 'edge:', edge, 'target:', targetPanelId);
  const fromPanel = _getPanelConfig(fromPanelId);
  if (!fromPanel) { console.log('[moveTabToNewPanel] missing source panel'); return; }
  const refPanelId = targetPanelId || fromPanelId;
  const newPanel = _createPanel(fromPanel.side, [tabName], tabName, { edge, targetPanelId: refPanelId });
  console.log('[moveTabToNewPanel] created panel:', newPanel.id);
  _moveTabToPanel(tabName, fromPanelId, newPanel.id);
}

function _rebuildPanelsFromSettings() {
  const stack = document.getElementById('vault-right-stack');
  if (!stack) return;
  const panels = (_vaultSettings.panels || []).filter(p => p.side === 'right');
  if (panels.length <= 1) return; // Default HTML already handles single panel

  const defaultGroup = stack.querySelector('.vault-panel-group');
  const defaultTabs = defaultGroup?.querySelector('.vault-right-tabs');
  const defaultPanes = defaultGroup?.querySelector('.vault-right-panes');
  if (!defaultTabs || !defaultPanes) return;

  // Build missing panel DOMs first (stacked vertically)
  for (let i = 1; i < panels.length; i++) {
    const panel = panels[i];
    if (!Array.isArray(panel.tabs)) continue;
    let group = stack.querySelector(`.vault-panel-group[data-panel-id="${_esc(panel.id)}"]`);
    if (!group) {
      _buildRightPanelDOM(panel);
      group = stack.querySelector(`.vault-panel-group[data-panel-id="${_esc(panel.id)}"]`);
    }
    if (!group) continue;
    const tabsContainer = group.querySelector('.vault-right-tabs');
    const panesContainer = group.querySelector('.vault-right-panes');
    // Move this panel's tabs and panes from the default group
    for (const tabName of panel.tabs) {
      const tabBtn = defaultTabs.querySelector(`[data-tab="${_esc(tabName)}"]`);
      if (tabBtn && tabsContainer) {
        tabBtn.classList.remove('hidden');
        tabsContainer.appendChild(tabBtn);
      }
      const pane = defaultPanes.querySelector(`[data-pane="${_esc(tabName)}"]`);
      if (pane && panesContainer) panesContainer.appendChild(pane);
    }
  }

  // Ensure first panel's remaining tabs are unhidden
  const first = panels[0];
  if (first && Array.isArray(first.tabs)) {
    const firstGroup = stack.querySelector(`.vault-panel-group[data-panel-id="${_esc(first.id)}"]`);
    if (firstGroup) {
      const tc = firstGroup.querySelector('.vault-right-tabs');
      if (tc) {
        for (const tabName of first.tabs) {
          const btn = tc.querySelector(`[data-tab="${_esc(tabName)}"]`);
          if (btn) btn.classList.remove('hidden');
        }
      }
    }
  }
}

function _destroyPanel(panelId) {
  const panels = _vaultSettings.panels || [];
  const idx = panels.findIndex(p => p.id === panelId);
  if (idx === -1) return;
  const panel = panels[idx];

  // Move all tabs back to the first panel on the same side
  const firstPanel = panels.find(p => p.side === panel.side && p.id !== panelId);
  if (firstPanel && Array.isArray(panel.tabs)) {
    if (!Array.isArray(firstPanel.tabs)) firstPanel.tabs = [];
    for (const tab of panel.tabs) {
      if (!firstPanel.tabs.includes(tab)) firstPanel.tabs.push(tab);
    }
  }

  panels.splice(idx, 1);
  _vaultSettings.panels = panels;
  _saveVaultSettings();

  // Remove DOM
  const panelEl = document.querySelector(`.vault-panel-group[data-panel-id="${_esc(panelId)}"]`);
  if (panelEl) {
    // Also remove preceding resize handle if present
    const prev = panelEl.previousElementSibling;
    if (prev && prev.classList.contains('vault-panel-resize-v')) prev.remove();
    panelEl.remove();
  }

  _syncPluginTabs();
}

// ── Left sidebar tabs ──────────────────────────────────────

function _switchLeftTab(tab) {
  _activeLeftTab = tab;
  const panel = _getPanelConfig('left-1');
  if (panel) _setActiveTabForPanel('left-1', tab);
  document.querySelectorAll('#vault-left-tabs .vault-sidebar-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.vault-sidebar-pane').forEach(pane => {
    pane.classList.toggle('hidden', pane.dataset.pane !== tab);
  });

  if (tab === 'tags') {
    if (_pluginManager?.isEnabled('tags')) _renderTagsPane();
  }
  if (tab === 'bookmarks') {
    if (_pluginManager?.isEnabled('bookmarks')) _renderBookmarksPane();
  }
}

// ── Ribbon ────────────────────────────────────────────────

// Registry of all ribbon items (core + plugins)
const _ribbonRegistry = new Map();
let _ribbonDraggedId = null;

function _registerRibbonItem(id, title, iconSvg, action, pluginId = null) {
  _ribbonRegistry.set(id, { id, title, iconSvg, action, pluginId });
}

function _renderRibbon() {
  const ribbon = document.getElementById('vault-ribbon-bar');
  const pane3 = document.querySelector('.vault-3pane');
  if (!ribbon) return;

  const showRibbon = _vaultSettings?.appearance?.showRibbon !== false;
  const hiddenItems = new Set(_vaultSettings?.appearance?.ribbonHiddenItems || []);

  // Show/hide ribbon container and adjust grid layout
  ribbon.style.display = showRibbon ? '' : 'none';
  if (pane3) {
    if (showRibbon) pane3.classList.remove('vault-ribbon-hidden');
    else pane3.classList.add('vault-ribbon-hidden');
  }
  if (!showRibbon) return;

  // Register core items if not already registered
  if (_ribbonRegistry.size === 0) {
    _registerRibbonItem('new-note', 'New note',
      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
      () => _showNewNotePrompt());
    _registerRibbonItem('quick-switcher', 'Quick switcher',
      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
      () => _showQuickSwitcher());
    _registerRibbonItem('graph-view', 'Open graph view',
      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`,
      () => _openGraphView());
  }

  // Sort by ribbonOrder if present, otherwise use registry insertion order
  const order = _vaultSettings?.appearance?.ribbonOrder || [];
  const items = Array.from(_ribbonRegistry.values());
  items.sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });

  // Rebuild ribbon
  ribbon.innerHTML = '';
  let lastPluginId = null;
  for (const item of items) {
    if (hiddenItems.has(item.id)) continue;
    // Add separator between items from different plugins
    if (lastPluginId !== null && lastPluginId !== item.pluginId) {
      const s = document.createElement('div');
      s.className = 'vault-ribbon-sep';
      ribbon.appendChild(s);
    }
    lastPluginId = item.pluginId;
    const b = document.createElement('div');
    b.className = 'vault-ribbon-btn';
    b.title = item.title;
    b.draggable = true;
    b.dataset.ribbonId = item.id;
    b.role = 'button';
    b.tabIndex = 0;
    b.innerHTML = item.iconSvg;
    b.addEventListener('click', item.action);
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.action(); }
    });

    // Drag-and-drop reordering
    b.addEventListener('dragstart', (e) => {
      _ribbonDraggedId = item.id;
      b.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id);
    });
    b.addEventListener('dragend', () => {
      b.classList.remove('dragging');
      _ribbonDraggedId = null;
      b.style.borderTop = '';
      b.style.borderBottom = '';
    });
    b.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!_ribbonDraggedId || _ribbonDraggedId === item.id) return;
      const rect = b.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      b.style.borderTop = '';
      b.style.borderBottom = '';
      if (e.clientY < midY) b.style.borderTop = '2px solid var(--accent, var(--red, #4a9eff))';
      else b.style.borderBottom = '2px solid var(--accent, var(--red, #4a9eff))';
    });
    b.addEventListener('dragleave', () => {
      b.style.borderTop = '';
      b.style.borderBottom = '';
    });
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.style.borderTop = '';
      b.style.borderBottom = '';
      if (!_ribbonDraggedId || _ribbonDraggedId === item.id) return;

      // Move the dragged button directly in the DOM for instant feedback
      const draggedBtn = ribbon.querySelector(`[data-ribbon-id="${_ribbonDraggedId}"]`);
      if (!draggedBtn) return;
      draggedBtn.classList.remove('dragging');

      const rect = b.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        ribbon.insertBefore(draggedBtn, b);
      } else {
        ribbon.insertBefore(draggedBtn, b.nextElementSibling);
      }

      // Persist order
      const allIds = Array.from(ribbon.querySelectorAll('.vault-ribbon-btn')).map(el => el.dataset.ribbonId);
      _vaultSettings.appearance.ribbonOrder = allIds;
      _saveVaultSettings();
    });

    ribbon.appendChild(b);
  }
}

/** Right-click context menu for ribbon */
let _ribbonMenu = null;
function _showRibbonMenu(x, y) {
  if (_ribbonMenu) { _ribbonMenu.remove(); _ribbonMenu = null; }
  const hiddenItems = new Set(_vaultSettings?.appearance?.ribbonHiddenItems || []);

  const menu = document.createElement('div');
  menu.className = 'vault-ribbon-menu';
  const items = Array.from(_ribbonRegistry.values());
  if (items.length === 0) return;

  let html = '';
  for (const item of items) {
    const isHidden = hiddenItems.has(item.id);
    const checkClass = isHidden ? '' : 'is-checked';
    html += `
      <div class="vault-ribbon-menu-item vault-note-menu-check ${checkClass}" data-ribbon-action="toggle-item" data-ribbon-id="${item.id}">
        <span class="vault-ribbon-menu-icon">${item.iconSvg.replace(/width="18" height="18"/g, 'width="14" height="14"')}</span>
        <span>${_esc(item.title)}</span>
        <span class="vault-note-menu-checkmark"></span>
      </div>`;
  }
  html += `<div class="vault-ribbon-menu-divider"></div>`;
  html += `
    <div class="vault-ribbon-menu-item" data-ribbon-action="hide-ribbon">
      <span class="vault-ribbon-menu-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg></span>
      <span>Hide ribbon</span>
    </div>`;
  menu.innerHTML = html;
  document.body.appendChild(menu);

  // Position
  const rect = menu.getBoundingClientRect();
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  let left = x;
  let top = y;
  if (left + rect.width > winW) left = winW - rect.width - 4;
  if (top + rect.height > winH) top = winH - rect.height - 4;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.style.position = 'fixed';
  menu.style.zIndex = '9999';

  // Wire toggle item rows
  menu.querySelectorAll('[data-ribbon-action="toggle-item"]').forEach(row => {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = row.dataset.ribbonId;
      const set = new Set(_vaultSettings.appearance.ribbonHiddenItems || []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      _vaultSettings.appearance.ribbonHiddenItems = Array.from(set);
      _saveVaultSettings();
      _renderRibbon();
      // Refresh menu to swap checkmark
      _ribbonMenu?.remove();
      _ribbonMenu = null;
      _showRibbonMenu(parseInt(menu.style.left), parseInt(menu.style.top));
    });
  });
  // Wire "Hide ribbon" click
  menu.querySelector('div[data-ribbon-action="hide-ribbon"]')?.addEventListener('click', () => {
    _vaultSettings.appearance.showRibbon = false;
    _saveVaultSettings();
    _renderRibbon();
    _ribbonMenu?.remove();
    _ribbonMenu = null;
  });

  _ribbonMenu = menu;
  console.log('[vault] ribbon menu stored in _ribbonMenu');
}

// Close ribbon menu on outside click (delayed to avoid closing on the same click that opened it)
let _ribbonMenuClickAway = null;
function _ribbonMenuClose(e) {
  if (_ribbonMenu && !_ribbonMenu.contains(e.target)) {
    console.log('[vault] ribbon menu closing via outside click');
    _ribbonMenu.remove();
    _ribbonMenu = null;
    document.removeEventListener('click', _ribbonMenuClose);
    _ribbonMenuClickAway = null;
  }
}
document.addEventListener('contextmenu', (e) => {
  const ribbon = e.target.closest('#vault-ribbon-bar');
  if (ribbon) {
    e.preventDefault();
    e.stopPropagation();
    console.log('[vault] ribbon contextmenu triggered');
    _showRibbonMenu(e.clientX, e.clientY);
    // Delay click-away so the same right-click doesn't immediately close it
    if (_ribbonMenuClickAway) clearTimeout(_ribbonMenuClickAway);
    _ribbonMenuClickAway = setTimeout(() => {
      document.addEventListener('click', _ribbonMenuClose);
    }, 50);
  } else if (_ribbonMenu) {
    _ribbonMenu.remove();
    _ribbonMenu = null;
    if (_ribbonMenuClickAway) clearTimeout(_ribbonMenuClickAway);
    document.removeEventListener('click', _ribbonMenuClose);
  }
}, true);

/** Right-click context menu for sidebar tabs */
let _tabContextMenu = null;
function _showTabContextMenu(e, panelId) {
  e.preventDefault();
  e.stopPropagation();
  if (_tabContextMenu) { _tabContextMenu.remove(); _tabContextMenu = null; }

  const panel = _getPanelConfig(panelId);
  const isRight = panel?.side === 'right';
  const tabDefs = isRight
    ? [
        { tab: 'backlinks', pid: 'backlinks', label: 'Backlinks' },
        { tab: 'outgoing', pid: 'outgoing-links', label: 'Outgoing links' },
        { tab: 'unlinked', pid: 'unlinked', label: 'Unlinked mentions' },
        { tab: 'outline', pid: 'outline', label: 'Outline' },
        { tab: 'orphans', pid: 'orphans', label: 'Orphans' },
        { tab: 'local-graph', pid: null, label: 'Local graph' },
      ]
    : [
        { tab: 'bookmarks', pid: 'bookmarks', label: 'Bookmarks' },
        { tab: 'tags', pid: 'tags', label: 'Tags' },
        { tab: 'search', pid: 'search', label: 'Search' },
        { tab: 'graph', pid: 'graph', label: 'Graph view' },
      ];

  const menu = document.createElement('div');
  menu.className = 'vault-ribbon-menu';
  let html = '';
  const hiddenRight = new Set(_vaultSettings.appearance?.hiddenRightTabs || []);
  for (const def of tabDefs) {
    let enabled;
    if (def.pid === null) {
      enabled = !hiddenRight.has(def.tab);
    } else {
      enabled = _pluginManager?.isEnabled(def.pid) ?? true;
    }
    const checkClass = enabled ? 'is-checked' : '';
    html += `
      <div class="vault-ribbon-menu-item vault-note-menu-check ${checkClass}" data-tab-pid="${_esc(def.pid ?? '')}" data-tab-name="${_esc(def.tab)}">
        <span>${_esc(def.label)}</span>
        <span class="vault-note-menu-checkmark"></span>
      </div>`;
  }
  // Add "Move to new panel" if user right-clicked on a specific tab
  const clickedTab = e.target.closest('.vault-right-tab, .vault-sidebar-tab');
  const clickedTabName = clickedTab?.dataset.tab;
  if (clickedTabName) {
    html += `<div class="vault-ribbon-menu-divider"></div>`;
    html += `
      <div class="vault-ribbon-menu-item" data-action="move-to-new-panel" data-tab-name="${_esc(clickedTabName)}">
        <span>Move "${_esc(clickedTab.querySelector('span')?.textContent || clickedTabName)}" to new panel</span>
      </div>`;
  }

  menu.innerHTML = html;
  document.body.appendChild(menu);

  // Position
  const rect = menu.getBoundingClientRect();
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  let left = e.clientX;
  let top = e.clientY;
  if (left + rect.width > winW) left = winW - rect.width - 4;
  if (top + rect.height > winH) top = winH - rect.height - 4;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.style.position = 'fixed';
  menu.style.zIndex = '9999';

  // Wire toggles
  menu.querySelectorAll('[data-tab-pid]').forEach(row => {
    row.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const pid = row.dataset.tabPid;
      const tabName = row.dataset.tabName;

      // Non-plugin tab (e.g., local-graph)
      if (!pid) {
        const hiddenSet = new Set(_vaultSettings.appearance?.hiddenRightTabs || []);
        if (hiddenSet.has(tabName)) hiddenSet.delete(tabName);
        else hiddenSet.add(tabName);
        _vaultSettings.appearance.hiddenRightTabs = Array.from(hiddenSet);
        _saveVaultSettings();
        _syncPluginTabs();
        if (isRight && _selectedNoteId) {
          const note = _notes.find(n => n.id === _selectedNoteId);
          if (note) _renderRightSidebar(note);
        }
        // Refresh menu
        _tabContextMenu?.remove();
        _tabContextMenu = null;
        _showTabContextMenu(e, panelId);
        return;
      }

      if (!_pluginManager) return;
      const enabled = _pluginManager.isEnabled(pid);
      try {
        if (enabled) {
          await _pluginManager.disable(pid);
        } else {
          await _pluginManager.enable(pid);
        }
      } catch (err) {
        console.error('[vault] failed to toggle plugin', pid, err);
        return;
      }
      _vaultSettings.enabledPlugins = CORE_PLUGINS
        .filter(p => _pluginManager.isEnabled(p.id))
        .map(p => p.id);
      _saveVaultSettings();
      _syncPluginTabs();
      // Re-render pane content so panel doesn't appear empty/closed
      if (isRight && _selectedNoteId) {
        const note = _notes.find(n => n.id === _selectedNoteId);
        if (note) _renderRightSidebar(note);
      } else if (!isRight) {
        _switchLeftTab(_activeLeftTab);
      }
      // Refresh menu
      _tabContextMenu?.remove();
      _tabContextMenu = null;
      _showTabContextMenu(e, panelId);
    });
  });

  // Wire "Move to new panel"
  menu.querySelector('[data-action="move-to-new-panel"]')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const tabName = menu.querySelector('[data-action="move-to-new-panel"]')?.dataset.tabName;
    if (tabName && panelId) {
      _moveTabToNewPanel(tabName, panelId);
    }
    _tabContextMenu?.remove();
    _tabContextMenu = null;
  });

  _tabContextMenu = menu;
  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closeMenu(ev) {
      if (_tabContextMenu && !_tabContextMenu.contains(ev.target)) {
        _tabContextMenu.remove();
        _tabContextMenu = null;
        document.removeEventListener('click', closeMenu);
      }
    });
  }, 50);
}

/** Ribbon configuration dialog */
function _openRibbonConfigDialog() {
  // Remove existing dialog if any
  const existing = document.getElementById('vault-ribbon-config-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'vault-ribbon-config-overlay';
  overlay.className = 'vault-ribbon-config-overlay';
  overlay.innerHTML = `
    <div class="vault-ribbon-config-dialog">
      <div class="vault-ribbon-config-header">
        <h3>Ribbon menu</h3>
        <button type="button" class="close-btn" id="vault-ribbon-config-close">&#x2715;</button>
      </div>
      <div class="vault-ribbon-config-body">
        <div class="vault-ribbon-config-desc">Choose what items you want to be active in the ribbon. Drag and drop to change the order.</div>
        <div id="vault-ribbon-config-active-list"></div>
        <div class="vault-ribbon-config-section-title">Other ribbon items</div>
        <div id="vault-ribbon-config-available-list"></div>
      </div>
      <div class="vault-ribbon-config-footer">
        <button type="button" id="vault-ribbon-config-done">Done</button>
      </div>
    </div>
  `;
  const modal = document.getElementById('vault-modal');
  (modal || document.body).appendChild(overlay);
  overlay.style.pointerEvents = 'auto';

  const close = () => { overlay.remove(); };
  overlay.querySelector('#vault-ribbon-config-close').addEventListener('click', close);
  overlay.querySelector('#vault-ribbon-config-done').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  _renderRibbonConfigLists();
}

function _renderRibbonConfigLists() {
  const activeContainer = document.getElementById('vault-ribbon-config-active-list');
  const availableContainer = document.getElementById('vault-ribbon-config-available-list');
  if (!activeContainer || !availableContainer) return;

  const hiddenItems = new Set(_vaultSettings?.appearance?.ribbonHiddenItems || []);
  const allItems = Array.from(_ribbonRegistry.values());
  const activeItems = allItems.filter(i => !hiddenItems.has(i.id));
  const availableItems = allItems.filter(i => hiddenItems.has(i.id));

  // Active list
  if (activeItems.length === 0) {
    activeContainer.innerHTML = '<div style="padding:8px;text-align:center;opacity:0.5;font-size:12px;">No active ribbon items.</div>';
  } else {
    activeContainer.innerHTML = `<div class="vault-ribbon-config-section-title">Active</div>`;
    const list = document.createElement('div');
    list.className = 'vault-ribbon-config-list';
    activeItems.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'vault-ribbon-config-item';
      row.draggable = true;
      row.dataset.ribbonId = item.id;
      row.innerHTML = `
        <span class="item-drag"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/></svg></span>
        <span class="item-icon">${item.iconSvg.replace(/width="18" height="18"/g, 'width="16" height="16"')}</span>
        <span class="item-title">${_esc(item.title)}</span>
        <button type="button" class="item-action remove" data-ribbon-action="remove" data-ribbon-id="${item.id}" title="Remove from ribbon">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      `;
      list.appendChild(row);
    });
    activeContainer.appendChild(list);

    // Wire remove buttons
    list.querySelectorAll('button[data-ribbon-action="remove"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.ribbonId;
        const set = new Set(_vaultSettings.appearance.ribbonHiddenItems || []);
        set.add(id);
        _vaultSettings.appearance.ribbonHiddenItems = Array.from(set);
        _saveVaultSettings();
        _renderRibbon();
        _renderRibbonConfigLists();
      });
    });

    // Drag-and-drop reordering for active items
    let draggedId = null;
    list.querySelectorAll('.vault-ribbon-config-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        draggedId = item.dataset.ribbonId;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        draggedId = null;
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!draggedId || draggedId === item.dataset.ribbonId) return;
        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) item.style.borderTop = '2px solid var(--red)';
        else item.style.borderBottom = '2px solid var(--red)';
      });
      item.addEventListener('dragleave', () => {
        item.style.borderTop = '';
        item.style.borderBottom = '';
      });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.style.borderTop = '';
        item.style.borderBottom = '';
        if (!draggedId || draggedId === item.dataset.ribbonId) return;
        const allIds = Array.from(list.querySelectorAll('.vault-ribbon-config-item')).map(el => el.dataset.ribbonId);
        const fromIdx = allIds.indexOf(draggedId);
        const toIdx = allIds.indexOf(item.dataset.ribbonId);
        if (fromIdx === -1 || toIdx === -1) return;
        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const targetIdx = e.clientY < midY ? toIdx : toIdx + 1;
        allIds.splice(fromIdx, 1);
        const insertIdx = allIds.indexOf(item.dataset.ribbonId);
        const finalIdx = e.clientY < midY ? insertIdx : insertIdx + 1;
        allIds.splice(finalIdx, 0, draggedId);
        // Save order and hidden items
        _vaultSettings.appearance.ribbonOrder = allIds;
        const newHidden = new Set();
        const activeSet = new Set(allIds);
        _ribbonRegistry.forEach((_, id) => {
          if (!activeSet.has(id)) newHidden.add(id);
        });
        _vaultSettings.appearance.ribbonHiddenItems = Array.from(newHidden);
        _saveVaultSettings();
        _renderRibbon();
        _renderRibbonConfigLists();
      });
    });
  }

  // Available list
  if (availableItems.length === 0) {
    availableContainer.innerHTML = '<div style="padding:8px;text-align:center;opacity:0.5;font-size:12px;">All ribbon items are active.</div>';
  } else {
    const list = document.createElement('div');
    list.className = 'vault-ribbon-config-list';
    availableItems.forEach(item => {
      const row = document.createElement('div');
      row.className = 'vault-ribbon-config-item';
      row.dataset.ribbonId = item.id;
      row.innerHTML = `
        <span class="item-icon">${item.iconSvg.replace(/width="18" height="18"/g, 'width="16" height="16"')}</span>
        <span class="item-title">${_esc(item.title)}</span>
        <button type="button" class="item-action add" data-ribbon-action="add" data-ribbon-id="${item.id}" title="Add to ribbon">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      `;
      list.appendChild(row);
    });
    availableContainer.appendChild(list);

    // Wire add buttons
    list.querySelectorAll('button[data-ribbon-action="add"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.ribbonId;
        const set = new Set(_vaultSettings.appearance.ribbonHiddenItems || []);
        set.delete(id);
        _vaultSettings.appearance.ribbonHiddenItems = Array.from(set);
        _saveVaultSettings();
        _renderRibbon();
        _renderRibbonConfigLists();
      });
    });
  }
}

// ── Right sidebar tabs ─────────────────────────────────────

let _activeRightTab = 'backlinks';

function _switchRightTab(tab, panelId) {
  // If panelId not provided, find the panel containing this tab
  if (!panelId) {
    const panel = _getPanelForTab(tab);
    panelId = panel ? panel.id : 'right-1';
  }
  _activeRightTab = tab;
  _switchTabInPanel(tab, panelId);

  // Re-render current note into the newly active tab if a note is selected
  if (_selectedNoteId && _noteContentCache?.has(_selectedNoteId)) {
    const note = _noteContentCache.get(_selectedNoteId);
    _renderPanel(panelId, note);
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
  semantic: false,
  fileStates: new Map(), // noteId -> boolean (true=collapsed, false=expanded); overrides default
  lastQuery: '',
};
let _searchHistoryTimer = null;

// -- Settings ------------------------------------------------

let _vaultSettings = {
  enabledPlugins: CORE_PLUGINS.map(m => m.id),
  editor: {
    defaultView: 'live',
    readableLineLength: true,
    strictLineBreaks: false,
    foldHeading: true,
    foldIndent: true,
    showLineNumbers: false,
    autoPairBrackets: true,
    autoPairMarkdown: true,
    smartLists: true,
    indentWithTabs: false,
    vimBindings: false,
    alwaysFocusNewTabs: true,
    showEditingModeInStatusBar: true,
    propertiesInDocument: 'visible',
    indentationGuides: true,
    rtl: false,
    spellcheck: false,
    indentVisualWidth: 4,
    convertPastedHtml: true,
    autoSave: 'afterDelay',
    autoSaveDelay: 1000,
  },
  filesAndLinks: {
    newNoteLocation: 'vault-root',
    newNoteFolder: '',
    newAttachmentLocation: 'vault-root',
    newAttachmentFolder: '',
    useWikilinks: true,
    linkFormat: 'shortest',
    autoUpdateLinks: true,
    confirmAutoUpdateLinks: true,
    confirmDelete: true,
    defaultFileToOpen: 'last-opened',
    defaultSpecificFile: '',
    detectAllFileExtensions: false,
  },
  appearance: {
    fontSize: 16,
    quickFontSizeAdjust: true,
    showInlineTitle: true,
    monospaceFont: false,
    showRibbon: true,
    ribbonHiddenItems: [],
    ribbonOrder: [],
    showTabTitleBar: true,
    showBacklinksAtBottom: false,
  },
  panels: [
    { id: 'left-1', side: 'left', tabs: ['files', 'search', 'bookmarks', 'tags', 'graph'], activeTab: 'files' },
    { id: 'right-1', side: 'right', tabs: ['backlinks', 'outgoing', 'unlinked', 'outline', 'orphans', 'local-graph'], activeTab: 'backlinks' }
  ],
  plugins: {
    backlinks: { showBacklinksAtBottom: false },
    canvas: { newFileLocation: 'vault-root', mouseWheelBehaviour: 'pan', ctrlDragBehaviour: 'show-menu', showCardNames: 'always', snapToGrid: true, snapToObjects: true, zoomThreshold: 50 },
    'command-palette': { pinnedCommands: [] },
    'daily-notes': { dateFormat: 'YYYY-MM-DD', newFileLocation: '', templateFileLocation: '' },
    'file-recovery': { snapshotInterval: 5, historyLength: 7 },
    'note-composer': { textAfterExtraction: 'link', templateFileLocation: '', confirmFileMerge: true },
    'quick-switcher': { showExistingOnly: false, showAttachments: true },
    templates: { templateFolderLocation: '', dateFormat: 'DD-MM-YYYY', timeFormat: 'HH:mm' },
    'unique-note-creator': { newFileLocation: '', templateFileLocation: '', uniquePrefixFormat: 'YYYYMMDDHHmm' },
  },
  hotkeys: {
    'quick-switcher': 'ctrl+o',
    'cycle-view-mode': 'ctrl+alt+e',
    'new-note': 'ctrl+alt+n',
    'command-palette': 'ctrl+shift+p',
    'toggle-bold': 'ctrl+b',
    'toggle-italics': 'ctrl+i',
    'toggle-strikethrough': '',
    'toggle-code': '',
    'toggle-comment': 'ctrl+/',
    'toggle-highlight': '',
    'toggle-underline': '',
    'toggle-blockquote': '',
    'toggle-bullet-list': '',
    'toggle-numbered-list': '',
    'toggle-heading': '',
    'set-heading-1': 'ctrl+1',
    'set-heading-2': 'ctrl+2',
    'set-heading-3': 'ctrl+3',
    'set-heading-4': 'ctrl+4',
    'set-heading-5': 'ctrl+5',
    'set-heading-6': 'ctrl+6',
    'remove-heading': '',
    'indent-list': 'ctrl+]',
    'unindent-list-item': 'ctrl+[',
    'toggle-checklist-status': 'ctrl+l',
    'fold-all': '',
    'unfold-all': '',
    'navigate-back': 'alt+left',
    'navigate-forward': 'alt+right',
    'close-current-tab': 'ctrl+w',
    'new-tab': 'ctrl+t',
    'toggle-reading': 'ctrl+e',
    'toggle-live': '',
    'toggle-source': '',
    'graph-view': '',
    'open-local-graph': '',
    'daily-note': '',
    'files-create-folder': '',
    'delete-current-file': '',
    'rename-file': 'ctrl+r',
    'save-current-file': 'ctrl+s',
    'open-settings': 'ctrl+,',
    'close-all-other-tabs': '',
    'go-next-tab': 'ctrl+shift+]',
    'go-previous-tab': 'ctrl+shift+[',
    'go-tab-1': 'alt+1',
    'go-tab-2': 'alt+2',
    'go-tab-3': 'alt+3',
    'go-tab-4': 'alt+4',
    'go-tab-5': 'alt+5',
    'go-tab-6': 'alt+6',
    'go-tab-7': 'alt+7',
    'go-tab-8': 'alt+8',
    'zoom-in': 'ctrl+=',
    'zoom-out': 'ctrl+-',
    'reset-zoom': 'ctrl+0',
    'undo-close-tab': 'ctrl+shift+t',
    'move-line-up': 'alt+up',
    'move-line-down': 'alt+down',
    'clear-formatting': '',
    'insert-horizontal-rule': '',
    'insert-code-block': '',
    'add-internal-link': '',
    'add-embed': '',
    'insert-callout': '',
    'insert-footnote': '',
    'insert-math-block': '',
    'follow-link-under-cursor': '',
    'toggle-left-sidebar': '',
    'toggle-right-sidebar': '',
  },
};

function _loadVaultSettings() {
  try {
    const raw = localStorage.getItem('vault-settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      _vaultSettings = { ..._vaultSettings, ...parsed };
      ['editor', 'filesAndLinks', 'appearance', 'hotkeys', 'plugins'].forEach(key => {
        if (parsed[key]) _vaultSettings[key] = { ..._vaultSettings[key], ...parsed[key] };
      });
    }
  } catch (e) { console.warn('[vault] load settings failed', e); }
}

function _saveVaultSettings() {
  try { localStorage.setItem('vault-settings', JSON.stringify(_vaultSettings)); } catch {}
}

const VAULT_COMMANDS = [
  {id:'quick-switcher',label:'Open quick switcher',impl:true},
  {id:'cycle-view-mode',label:'Cycle view mode',impl:true},
  {id:'new-note',label:'New note',impl:true},
  {id:'promote-table-to-database',label:'Promote first table to inline database',impl:true},
  {id:'command-palette',label:'Open command palette',impl:true},
  {id:'toggle-reading',label:'Toggle reading view',impl:true},
  {id:'toggle-live',label:'Toggle live preview',impl:true},
  {id:'toggle-source',label:'Toggle source view',impl:true},
  {id:'fold-all',label:'Fold all headings and lists',impl:true},
  {id:'unfold-all',label:'Unfold all headings and lists',impl:true},
  {id:'graph-view',label:'Graph view: Open graph view',impl:true},
  {id:'open-local-graph',label:'Graph view: Open local graph',impl:true},
  {id:'daily-note',label:"Daily notes: Open today's daily note",impl:true},
  {id:'navigate-back',label:'Navigate back',impl:true},
  {id:'navigate-forward',label:'Navigate forward',impl:true},
  {id:'close-current-tab',label:'Close current tab',impl:true},
  {id:'new-tab',label:'New tab',impl:true},
  {id:'add-alias',label:'Add alias',impl:false},
  {id:'add-cursor-above',label:'Add cursor above',impl:false},
  {id:'add-cursor-below',label:'Add cursor below',impl:false},
  {id:'add-embed',label:'Add embed',impl:true},
  {id:'add-file-property',label:'Add file property',impl:false},
  {id:'add-internal-link',label:'Add internal link',impl:true},
  {id:'add-tag',label:'Add tag',impl:false},
  {id:'backlinks-open',label:'Backlinks: Open backlinks for the current note',impl:false},
  {id:'backlinks-show',label:'Backlinks: Show backlinks',impl:false},
  {id:'backlinks-toggle',label:'Backlinks: Toggle backlinks in document',impl:false},
  {id:'bases-add-item',label:'Bases: Add item',impl:false},
  {id:'bases-add-view',label:'Bases: Add view',impl:false},
  {id:'bases-change-view',label:'Bases: Change view',impl:false},
  {id:'bases-copy-table',label:'Bases: Copy table to clipboard',impl:false},
  {id:'bases-create-base',label:'Bases: Create new base',impl:false},
  {id:'bases-insert-base',label:'Bases: Insert new base',impl:false},
  {id:'bookmarks-bookmark-all-tabs',label:'Bookmarks: Bookmark all tabs...',impl:false},
  {id:'bookmarks-bookmark-block',label:'Bookmarks: Bookmark block under cursor...',impl:false},
  {id:'bookmarks-bookmark-search',label:'Bookmarks: Bookmark current search...',impl:false},
  {id:'bookmarks-bookmark-heading',label:'Bookmarks: Bookmark heading under cursor...',impl:false},
  {id:'bookmarks-bookmark',label:'Bookmarks: Bookmark...',impl:false},
  {id:'bookmarks-remove',label:'Bookmarks: Remove bookmark for the current file',impl:false},
  {id:'bookmarks-show',label:'Bookmarks: Show bookmarks',impl:false},
  {id:'canvas-convert',label:'Canvas: Convert to file...',impl:false},
  {id:'canvas-create',label:'Canvas: Create new canvas',impl:false},
  {id:'canvas-export',label:'Canvas: Export as image',impl:false},
  {id:'canvas-jump-group',label:'Canvas: Jump to group',impl:false},
  {id:'change-vault',label:'Change vault...',impl:false},
  {id:'clear-file-properties',label:'Clear file properties',impl:false},
  {id:'clear-formatting',label:'Clear formatting',impl:true},
  {id:'close-all-other-tabs',label:'Close all other tabs',impl:true},
  {id:'close-others-in-tab-group',label:'Close others in tab group',impl:false},
  {id:'close-this-tab-group',label:'Close this tab group',impl:false},
  {id:'close-window',label:'Close window',impl:false},
  {id:'command-palette-open',label:'Command palette: Open command palette',impl:false},
  {id:'copy-file-path-root',label:'Copy current file path from system root',impl:false},
  {id:'copy-file-path-vault',label:'Copy current file path from vault folder',impl:false},
  {id:'copy-obsidian-url',label:'Copy Obsidian URL for current file',impl:false},
  {id:'create-new-note',label:'Create new note',impl:false},
  {id:'create-new-note-current-tab',label:'Create new note in current tab',impl:false},
  {id:'create-note-to-right',label:'Create note to the right',impl:false},
  {id:'cycle-bullet-checkbox',label:'Cycle bullet/checkbox',impl:false},
  {id:'daily-notes-next',label:'Daily notes: Open next daily note',impl:false},
  {id:'daily-notes-previous',label:'Daily notes: Open previous daily note',impl:false},
  {id:'delete-current-file',label:'Delete current file',impl:true},
  {id:'delete-paragraph',label:'Delete paragraph',impl:false},
  {id:'download-attachments',label:'Download attachments for current file',impl:false},
  {id:'export-pdf',label:'Export to PDF...',impl:false},
  {id:'file-recovery-history',label:'File recovery: Open local history',impl:false},
  {id:'files-create-folder',label:'Files: Create new folder',impl:true},
  {id:'files-reveal-file',label:'Files: Reveal current file in navigation',impl:false},
  {id:'files-show-explorer',label:'Files: Show file explorer',impl:false},
  {id:'focus-last-note',label:'Focus on last note',impl:false},
  {id:'focus-tab-group-above',label:'Focus on tab group above',impl:false},
  {id:'focus-tab-group-below',label:'Focus on tab group below',impl:false},
  {id:'focus-tab-group-left',label:'Focus on tab group to the left',impl:false},
  {id:'focus-tab-group-right',label:'Focus on tab group to the right',impl:false},
  {id:'fold-less',label:'Fold less',impl:false},
  {id:'fold-more',label:'Fold more',impl:false},
  {id:'follow-link-under-cursor',label:'Follow link under cursor',impl:true},
  {id:'go-last-tab',label:'Go to last tab',impl:false},
  {id:'go-next-tab',label:'Go to next tab',impl:true},
  {id:'go-previous-tab',label:'Go to previous tab',impl:true},
  {id:'go-tab-1',label:'Go to tab #1',impl:true},
  {id:'go-tab-2',label:'Go to tab #2',impl:true},
  {id:'go-tab-3',label:'Go to tab #3',impl:true},
  {id:'go-tab-4',label:'Go to tab #4',impl:true},
  {id:'go-tab-5',label:'Go to tab #5',impl:true},
  {id:'go-tab-6',label:'Go to tab #6',impl:true},
  {id:'go-tab-7',label:'Go to tab #7',impl:true},
  {id:'go-tab-8',label:'Go to tab #8',impl:true},
  {id:'graph-local',label:'Graph view: Open local graph',impl:false},
  {id:'graph-time-lapse',label:'Graph view: Start graph time-lapse animation',impl:false},
  {id:'indent-list',label:'Indent list item',impl:true},
  {id:'insert-attachment',label:'Insert attachment',impl:false},
  {id:'insert-callout',label:'Insert callout',impl:true},
  {id:'insert-code-block',label:'Insert code block',impl:true},
  {id:'insert-footnote',label:'Insert footnote',impl:true},
  {id:'insert-horizontal-rule',label:'Insert horizontal rule',impl:true},
  {id:'insert-markdown-link',label:'Insert Markdown link',impl:false},
  {id:'insert-math-block',label:'Insert maths block',impl:true},
  {id:'insert-table',label:'Insert table',impl:false},
  {id:'make-copy',label:'Make a copy of the current file',impl:false},
  {id:'manage-vaults',label:'Manage vaults',impl:false},
  {id:'move-file-folder',label:'Move current file to another folder',impl:false},
  {id:'move-tab-new-window',label:'Move current tab to new window',impl:false},
  {id:'move-line-down',label:'Move line down',impl:true},
  {id:'move-line-up',label:'Move line up',impl:true},
  {id:'new-window',label:'New window',impl:false},
  {id:'note-composer-extract-selection',label:'Note composer: Extract current selection...',impl:false},
  {id:'note-composer-extract-heading',label:'Note composer: Extract this heading...',impl:false},
  {id:'open-settings',label:'Open settings',impl:true},
  {id:'open-vault',label:'Open vault',impl:false},
  {id:'outgoing-links-open',label:'Outgoing links: Open outgoing links',impl:false},
  {id:'outgoing-links-show',label:'Outgoing links: Show outgoing links',impl:false},
  {id:'outline-open',label:'Outline: Open outline',impl:false},
  {id:'page-preview-toggle',label:'Page preview: Toggle page preview',impl:false},
  {id:'random-note',label:'Random note: Open random note',impl:false},
  {id:'reload-app',label:'Reload app without saving',impl:false},
  {id:'rename-file',label:'Rename file',impl:true},
  {id:'search-all-files',label:'Search: Search in all files',impl:false},
  {id:'split-down',label:'Split down',impl:false},
  {id:'split-left',label:'Split left',impl:false},
  {id:'split-right',label:'Split right',impl:false},
  {id:'split-up',label:'Split up',impl:false},
  {id:'tags-open',label:'Tags: Open tag pane',impl:false},
  {id:'templates-insert',label:'Templates: Insert template',impl:true},
  {id:'toggle-bold',label:'Toggle bold',impl:true},
  {id:'toggle-checklist-status',label:'Toggle checklist status',impl:true},
  {id:'toggle-code',label:'Toggle code',impl:true},
  {id:'toggle-comment',label:'Toggle comment',impl:true},
  {id:'toggle-highlight',label:'Toggle highlight',impl:true},
  {id:'toggle-italics',label:'Toggle italics',impl:true},
  {id:'toggle-left-sidebar',label:'Toggle left sidebar',impl:true},
  {id:'toggle-right-sidebar',label:'Toggle right sidebar',impl:true},
  {id:'toggle-strikethrough',label:'Toggle strikethrough',impl:true},
  {id:'toggle-underline',label:'Toggle underline',impl:true},
  {id:'unlinked-mentions-open',label:'Unlinked mentions: Open unlinked mentions',impl:false},
  {id:'word-count-show',label:'Word count: Show word count',impl:false},
  {id:'note-composer-merge',label:'Note composer: Merge current file with another file...',impl:false},
  {id:'open-current-tab-new-window',label:'Open current tab in new window',impl:false},
  {id:'open-help',label:'Open help',impl:false},
  {id:'open-in-default-app',label:'Open in default app',impl:false},
  {id:'open-link-new-tab',label:'Open link under cursor in new tab',impl:false},
  {id:'open-link-new-window',label:'Open link under cursor in new window',impl:false},
  {id:'open-link-to-right',label:'Open link under cursor to the right',impl:false},
  {id:'open-sandbox-vault',label:'Open sandbox vault',impl:false},
  {id:'outline-open-current',label:'Outline: Open outline of the current file',impl:false},
  {id:'outline-show',label:'Outline: Show outline',impl:false},
  {id:'quick-switcher-open',label:'Quick switcher: Open quick switcher',impl:false},
  {id:'random-note-open',label:'Random note: Open random note',impl:false},
  {id:'remove-heading',label:'Remove heading',impl:true},
  {id:'rename-heading',label:'Rename this heading...',impl:false},
  {id:'reset-zoom',label:'Reset zoom',impl:true},
  {id:'save-current-file',label:'Save current file',impl:true},
  {id:'search-replace-current-file',label:'Search & replace in current file',impl:false},
  {id:'search-current-file',label:'Search current file...',impl:false},
  {id:'set-heading-1',label:'Set as heading 1',impl:true},
  {id:'set-heading-2',label:'Set as heading 2',impl:true},
  {id:'set-heading-3',label:'Set as heading 3',impl:true},
  {id:'set-heading-4',label:'Set as heading 4',impl:true},
  {id:'set-heading-5',label:'Set as heading 5',impl:true},
  {id:'set-heading-6',label:'Set as heading 6',impl:true},
  {id:'show-context-menu',label:'Show context menu under cursor',impl:false},
  {id:'show-debug-info',label:'Show debug info',impl:false},
  {id:'show-system-explorer',label:'Show in system explorer',impl:false},
  {id:'show-release-notes',label:'Show release notes',impl:false},
  {id:'show-trash',label:'Show trash',impl:false},
  {id:'table-add-column-after',label:'Table: Add column after',impl:false},
  {id:'table-add-column-before',label:'Table: Add column before',impl:false},
  {id:'table-add-row-after',label:'Table: Add row after',impl:false},
  {id:'table-add-row-before',label:'Table: Add row before',impl:false},
  {id:'table-align-centre',label:'Table: Align centre',impl:false},
  {id:'table-align-left',label:'Table: Align left',impl:false},
  {id:'table-align-right',label:'Table: Align right',impl:false},
  {id:'table-delete-column',label:'Table: Delete column',impl:false},
  {id:'table-delete-row',label:'Table: Delete row',impl:false},
  {id:'table-duplicate-column',label:'Table: Duplicate column',impl:false},
  {id:'table-duplicate-row',label:'Table: Duplicate row',impl:false},
  {id:'table-move-column-left',label:'Table: Move column left',impl:false},
  {id:'table-move-row-down',label:'Table: Move row down',impl:false},
  {id:'table-move-row-up',label:'Table: Move row up',impl:false},
  {id:'tags-view-show-tags',label:'Tags view: Show tags',impl:false},
  {id:'templates-insert-current-date',label:'Templates: Insert current date',impl:true},
  {id:'templates-insert-current-time',label:'Templates: Insert current time',impl:true},
  {id:'toggle-blockquote',label:'Toggle blockquote',impl:true},
  {id:'toggle-bullet-list',label:'Toggle bullet list',impl:true},
  {id:'toggle-fold-current-line',label:'Toggle fold on the current line',impl:false},
  {id:'toggle-fold-properties',label:'Toggle fold properties in current file',impl:false},
  {id:'toggle-heading',label:'Toggle heading',impl:true},
  {id:'toggle-inline-maths',label:'Toggle inline maths',impl:false},
  {id:'toggle-live-preview-source-mode',label:'Toggle Live Preview/Source mode',impl:false},
  {id:'toggle-numbered-list',label:'Toggle numbered list',impl:true},
  {id:'toggle-pin',label:'Toggle pin',impl:false},
  {id:'toggle-reading-view-short',label:'Toggle reading view',impl:false},
  {id:'undo-close-tab',label:'Undo close tab',impl:true},
  {id:'unindent-list-item',label:'Unindent list item',impl:true},
  {id:'unique-note-creator-add-link',label:'Unique note creator: Add unique internal link',impl:false},
  {id:'unique-note-creator-create-note',label:'Unique note creator: Create new unique note',impl:false},
  {id:'zoom-in',label:'Zoom in',impl:true},
  {id:'zoom-out',label:'Zoom out',impl:true},
];

function _getAllCommands() {
  const pluginCmds = _pluginManager ? Array.from(_pluginManager._instances.values()).flatMap(p =>
    (p._commands || []).map(c => ({ id: c.id, label: c.name || c.id, callback: c.callback, impl: true }))
  ) : [];
  return [...VAULT_COMMANDS, ...pluginCmds];
}

function _formatCombo(combo) {
  if (!combo) return '';
  return combo.split('+').map(p => {
    if (p === 'ctrl') return IS_MAC ? 'Cmd' : 'Ctrl';
    if (p === 'alt') return IS_MAC ? 'Opt' : 'Alt';
    if (p === 'shift') return 'Shift';
    if (p === 'meta') return 'Cmd';
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join(' + ');
}

function _matchesVaultCombo(e, combo) {
  if (!combo) return false;
  const parts = combo.split('+');
  const needCtrl = parts.includes('ctrl');
  const needAlt = parts.includes('alt');
  const needShift = parts.includes('shift');
  const needMeta = parts.includes('meta');
  const key = parts.filter(p => !['ctrl', 'alt', 'shift', 'meta'].includes(p))[0] || '';
  // On Mac, meta (Cmd) counts as ctrl for vault shortcuts; on Win/Linux, Ctrl counts as ctrl
  const hasCtrl = IS_MAC ? (e.metaKey || e.ctrlKey) : e.ctrlKey;
  if (needCtrl !== hasCtrl) return false;
  if (needAlt !== e.altKey) return false;
  if (needShift !== e.shiftKey) return false;
  if (needMeta && !e.metaKey) return false;
  return e.key.toLowerCase() === key;
}

function _normalizeCapturedCombo(e) {
  // Always store as 'ctrl' when the user presses Cmd (Mac) or Ctrl (Win/Linux)
  const modifiers = [];
  if (IS_MAC ? e.metaKey : e.ctrlKey) modifiers.push('ctrl');
  if (e.altKey) modifiers.push('alt');
  if (e.shiftKey) modifiers.push('shift');
  if (!IS_MAC && e.metaKey) modifiers.push('meta');
  const key = e.key.toLowerCase();
  if (key === 'control' || key === 'alt' || key === 'shift' || key === 'meta') return null;
  modifiers.push(key);
  return modifiers.join('+');
}

function _getActiveVaultEditor() {
  const modal = document.getElementById('vault-modal');
  if (!modal || modal.classList.contains('hidden')) return null;
  const activeLp = modal.querySelector('.lp-line.active .lp-source[contenteditable="true"]');
  if (activeLp) return { el: activeLp, mode: 'live' };
  const sourceDiv = modal.querySelector('.vault-source-view[contenteditable="true"]');
  if (sourceDiv) return { el: sourceDiv, mode: 'source' };
  return null;
}

function _getCurrentLineRange(editor) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const container = editor.el;
  const range = sel.getRangeAt(0).cloneRange();
  if (editor.mode === 'live') {
    const r = document.createRange();
    r.selectNodeContents(container);
    return r;
  }
  let node = range.startContainer;
  while (node && node !== container) {
    if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('lp-line')) {
      const r = document.createRange();
      r.selectNodeContents(node);
      return r;
    }
    node = node.parentNode;
  }
  const r = document.createRange();
  r.selectNodeContents(container);
  return r;
}

function _toggleInlineWrap(prefix, suffix) {
  suffix = suffix || prefix;
  const editor = _getActiveVaultEditor();
  if (!editor) return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const selected = sel.toString();
  if (selected.startsWith(prefix) && selected.endsWith(suffix)) {
    document.execCommand('insertText', false, selected.slice(prefix.length, -suffix.length));
  } else if (selected) {
    document.execCommand('insertText', false, prefix + selected + suffix);
  } else {
    document.execCommand('insertText', false, prefix + suffix);
    const newSel = window.getSelection();
    if (newSel.rangeCount) {
      const range = newSel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        const pos = Math.max(0, range.startOffset - suffix.length);
        const newRange = document.createRange();
        newRange.setStart(node, pos);
        newRange.collapse(true);
        newSel.removeAllRanges();
        newSel.addRange(newRange);
      }
    }
  }
  editor.el.focus();
}

function _toggleLinePrefix(prefix) {
  const editor = _getActiveVaultEditor();
  if (!editor) return;
  const lineRange = _getCurrentLineRange(editor);
  if (!lineRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(lineRange);
  const oldText = sel.toString();
  const newText = oldText.startsWith(prefix) ? oldText.slice(prefix.length) : prefix + oldText;
  document.execCommand('insertText', false, newText);
  editor.el.focus();
}

function _toggleHeading(level) {
  const editor = _getActiveVaultEditor();
  if (!editor) return;
  const lineRange = _getCurrentLineRange(editor);
  if (!lineRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(lineRange);
  const oldText = sel.toString();
  const headingRe = /^(#{1,6})\s/;
  const match = oldText.match(headingRe);
  let newText;
  if (match) {
    const currentLevel = match[1].length;
    if (level != null) {
      if (currentLevel === level) {
        newText = oldText.replace(headingRe, '');
      } else {
        newText = '#'.repeat(level) + ' ' + oldText.replace(headingRe, '');
      }
    } else {
      const nextLevel = currentLevel >= 6 ? 0 : currentLevel + 1;
      if (nextLevel === 0) {
        newText = oldText.replace(headingRe, '');
      } else {
        newText = '#'.repeat(nextLevel) + ' ' + oldText.replace(headingRe, '');
      }
    }
  } else {
    if (level != null) {
      newText = '#'.repeat(level) + ' ' + oldText;
    } else {
      newText = '# ' + oldText;
    }
  }
  document.execCommand('insertText', false, newText);
  editor.el.focus();
}

function _removeHeadingPrefix() {
  const editor = _getActiveVaultEditor();
  if (!editor) return;
  const lineRange = _getCurrentLineRange(editor);
  if (!lineRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(lineRange);
  const oldText = sel.toString();
  document.execCommand('insertText', false, oldText.replace(/^(#{1,6})\s/, ''));
  editor.el.focus();
}

function _toggleIndent(delta) {
  const editor = _getActiveVaultEditor();
  if (!editor) return;
  const lineRange = _getCurrentLineRange(editor);
  if (!lineRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(lineRange);
  const oldText = sel.toString();
  let newText;
  if (delta > 0) {
    newText = '  ' + oldText;
  } else {
    newText = oldText.replace(/^(\t|  )/, '');
  }
  document.execCommand('insertText', false, newText);
  editor.el.focus();
}

function _toggleCheckboxStatus() {
  const editor = _getActiveVaultEditor();
  if (!editor) return;
  const lineRange = _getCurrentLineRange(editor);
  if (!lineRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(lineRange);
  const oldText = sel.toString();
  let newText;
  if (/^- \[x\]\s/i.test(oldText)) {
    newText = oldText.replace(/^- \[x\]\s/i, '- [ ] ');
  } else if (/^- \[ \]\s/.test(oldText)) {
    newText = oldText.replace(/^- \[ \]\s/, '- ');
  } else if (/^-\s/.test(oldText)) {
    newText = oldText.replace(/^-\s/, '- [ ] ');
  } else {
    newText = '- [ ] ' + oldText;
  }
  document.execCommand('insertText', false, newText);
  editor.el.focus();
}

function _clearFormatting() {
  const editor = _getActiveVaultEditor();
  if (!editor) return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const selected = sel.toString();
  if (!selected) return;
  const cleaned = selected
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/==(.*?)==/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/%%(.*?)%%/g, '$1')
    .replace(/<u>(.*?)<\/u>/g, '$1');
  document.execCommand('insertText', false, cleaned);
  editor.el.focus();
}

function _moveLine(delta) {
  const editor = _getActiveVaultEditor();
  if (!editor || editor.mode !== 'source') return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const fullText = editor.el.innerText;
  const lines = fullText.split('\n');
  const range = sel.getRangeAt(0);
  let pos = 0;
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    const pre = document.createRange();
    pre.selectNodeContents(editor.el);
    pre.setEnd(node, range.startOffset);
    pos = pre.toString().length;
  }
  let lineIdx = 0;
  let cum = 0;
  for (let i = 0; i < lines.length; i++) {
    if (pos >= cum && pos <= cum + lines[i].length) { lineIdx = i; break; }
    cum += lines[i].length + 1;
  }
  const swapIdx = lineIdx + delta;
  if (swapIdx < 0 || swapIdx >= lines.length) return;
  [lines[lineIdx], lines[swapIdx]] = [lines[swapIdx], lines[lineIdx]];
  editor.el.innerText = lines.join('\n');
  // Restore caret roughly
  const newPos = lines.slice(0, swapIdx).join('\n').length + (swapIdx > 0 ? 1 : 0) + Math.min(pos - cum, lines[swapIdx].length);
  _setCursorOffset(editor.el, newPos);
  editor.el.focus();
  const note = _notes.find(n => n.id === _selectedNoteId);
  if (note) _flushSourceEdit(editor.el, note);
}

function _setCursorOffset(container, offset) {
  const sel = window.getSelection();
  const range = document.createRange();
  let currentOffset = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let lastNode = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent.length;
      lastNode = node;
      if (currentOffset + len >= offset) {
        range.setStart(node, Math.max(0, offset - currentOffset));
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      currentOffset += len;
    } else if (node.tagName === 'BR') {
      if (currentOffset + 1 >= offset) {
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      currentOffset += 1;
    } else if (node.tagName === 'DIV' && node !== container) {
      // Treat block-level line breaks like <br> for raw offset calculations.
      if (currentOffset + 1 >= offset) {
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      currentOffset += 1;
    }
  }
  if (lastNode) {
    range.setStart(lastNode, lastNode.textContent.length);
  } else {
    const lastChild = container.lastChild;
    if (lastChild) range.setStartAfter(lastChild);
    else range.setStart(container, 0);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function _zoom(delta) {
  let fs = _vaultSettings.appearance.fontSize || 16;
  fs = Math.max(10, Math.min(32, fs + delta));
  _vaultSettings.appearance.fontSize = fs;
  _saveVaultSettings();
  document.documentElement.style.setProperty('--vault-font-size', fs + 'px');
}

function _insertBlock(text) {
  const editor = _getActiveVaultEditor();
  if (!editor) return;
  document.execCommand('insertText', false, text);
  editor.el.focus();
}

function _followLinkUnderCursor() {
  const editor = _getActiveVaultEditor();
  if (!editor) return;
  const sel = window.getSelection();
  const text = sel.toString() || _getCurrentLineRange(editor)?.toString() || '';
  const match = text.match(/\[\[(.*?)\]\]|\[(.*?)\]\((.*?)\)/);
  if (!match) return;
  const link = match[1] || match[3];
  if (!link) return;
  const target = _notes.find(n => n.title === link || n.id === link);
  if (target) _navigateToNote(target.id);
}

function _goToTab(index) {
  if (index < 0 || index >= _openTabs.length) return;
  _navigateToNote(_openTabs[index]);
}

function _runCommandById(cmdId) {
  switch (cmdId) {
    case 'quick-switcher': _showQuickSwitcher(); return true;
    case 'cycle-view-mode': {
      if (_previewMode === 'preview') _previewMode = _editModePref;
      else _previewMode = 'preview';
      _updateModeButtons();
      if (_selectedNoteId) _selectNote(_selectedNoteId);
      return true;
    }
    case 'new-note': _showNewNotePrompt(); return true;
    case 'promote-table-to-database': {
      (async () => {
        if (!_selectedNoteId) { showToast('No note open'); return; }
        const note = _noteContentCache.get(_selectedNoteId);
        const content = note ? _getNoteFullRaw(note) : '';
        const firstTableLine = content.split('\n').findIndex((l) => l.trim().startsWith('|'));
        if (firstTableLine < 0) { showToast('No markdown table found in this note'); return; }
        try {
          await promoteInlineDatabase(_selectedNoteId, firstTableLine);
          _noteContentCache.delete(_selectedNoteId);
          await _selectNote(_selectedNoteId);
          showToast('Table promoted to database');
        } catch (e) {
          showError('Failed to promote table', e.message || String(e));
        }
      })();
      return true;
    }
    case 'command-palette': _showCommandPalette(); return true;
    case 'toggle-reading': {
      _previewMode = 'preview'; _updateModeButtons();
      if (_selectedNoteId) _selectNote(_selectedNoteId);
      return true;
    }
    case 'toggle-live': {
      _editModePref = 'live'; _previewMode = 'live'; _updateModeButtons();
      if (_selectedNoteId) _selectNote(_selectedNoteId);
      return true;
    }
    case 'toggle-source': {
      _editModePref = 'edit'; _previewMode = 'edit'; _updateModeButtons();
      if (_selectedNoteId) _selectNote(_selectedNoteId);
      return true;
    }
    case 'fold-all':
      document.querySelectorAll('#vault-preview details').forEach(d => d.open = false);
      return true;
    case 'unfold-all':
      document.querySelectorAll('#vault-preview details').forEach(d => d.open = true);
      return true;
    case 'graph-view': {
      _openGraphView();
      return true;
    }
    case 'open-local-graph': {
      const localGraphTab = document.querySelector('.vault-right-tabs [data-tab="local-graph"]');
      if (localGraphTab) localGraphTab.click();
      return true;
    }
    case 'daily-note': {
      const dailyPlugin = _pluginManager?.getInstance('daily-notes');
      if (dailyPlugin?._commands?.[0]) dailyPlugin._commands[0].callback();
      return true;
    }
    case 'templates-insert': _insertTemplate(); return true;
    case 'templates-insert-current-date': _insertCurrentDate(); return true;
    case 'templates-insert-current-time': _insertCurrentTime(); return true;
    case 'navigate-back': _goBack(); return true;
    case 'navigate-forward': _goForward(); return true;
    case 'close-current-tab': _closeCurrentTab(); return true;
    case 'new-tab': _showNewNotePrompt(); return true;
    case 'files-create-folder': _promptNewFolder(); return true;
    case 'toggle-bold': _toggleInlineWrap('**'); return true;
    case 'toggle-italics': _toggleInlineWrap('*'); return true;
    case 'toggle-strikethrough': _toggleInlineWrap('~~'); return true;
    case 'toggle-highlight': _toggleInlineWrap('=='); return true;
    case 'toggle-code': _toggleInlineWrap('`'); return true;
    case 'toggle-comment': _toggleInlineWrap('%%'); return true;
    case 'toggle-underline': _toggleInlineWrap('<u>', '</u>'); return true;
    case 'toggle-blockquote': _toggleLinePrefix('> '); return true;
    case 'toggle-bullet-list': _toggleLinePrefix('- '); return true;
    case 'toggle-numbered-list': _toggleLinePrefix('1. '); return true;
    case 'toggle-heading': _toggleHeading(null); return true;
    case 'set-heading-1': _toggleHeading(1); return true;
    case 'set-heading-2': _toggleHeading(2); return true;
    case 'set-heading-3': _toggleHeading(3); return true;
    case 'set-heading-4': _toggleHeading(4); return true;
    case 'set-heading-5': _toggleHeading(5); return true;
    case 'set-heading-6': _toggleHeading(6); return true;
    case 'remove-heading': _removeHeadingPrefix(); return true;
    case 'indent-list': _toggleIndent(1); return true;
    case 'unindent-list-item': _toggleIndent(-1); return true;
    case 'toggle-checklist-status': _toggleCheckboxStatus(); return true;
    // Newly wired commands
    case 'clear-formatting': _clearFormatting(); return true;
    case 'close-all-other-tabs': {
      if (_selectedNoteId) {
        _openTabs = _openTabs.filter(id => id === _selectedNoteId);
        _renderNoteTabs();
      }
      return true;
    }
    case 'delete-current-file': {
      if (_selectedNoteId) _deleteNote(_selectedNoteId);
      return true;
    }
    case 'follow-link-under-cursor': _followLinkUnderCursor(); return true;
    case 'go-next-tab': {
      const idx = _openTabs.indexOf(_selectedNoteId);
      if (idx !== -1 && idx < _openTabs.length - 1) _goToTab(idx + 1);
      return true;
    }
    case 'go-previous-tab': {
      const idx = _openTabs.indexOf(_selectedNoteId);
      if (idx > 0) _goToTab(idx - 1);
      return true;
    }
    case 'go-tab-1': _goToTab(0); return true;
    case 'go-tab-2': _goToTab(1); return true;
    case 'go-tab-3': _goToTab(2); return true;
    case 'go-tab-4': _goToTab(3); return true;
    case 'go-tab-5': _goToTab(4); return true;
    case 'go-tab-6': _goToTab(5); return true;
    case 'go-tab-7': _goToTab(6); return true;
    case 'go-tab-8': _goToTab(7); return true;
    case 'insert-callout': _insertBlock('> [!note]\n> '); return true;
    case 'insert-code-block': _insertBlock('```\n\n```'); return true;
    case 'insert-footnote': _insertBlock('[^1]: '); return true;
    case 'insert-horizontal-rule': _insertBlock('---\n'); return true;
    case 'insert-math-block': _insertBlock('$$\n\n$$'); return true;
    case 'move-line-down': _moveLine(1); return true;
    case 'move-line-up': _moveLine(-1); return true;
    case 'open-settings': _openVaultSettings(); return true;
    case 'rename-file': {
      if (_selectedNoteId) _promptRenameNote(_selectedNoteId);
      return true;
    }
    case 'reset-zoom': { _zoom(16 - (_vaultSettings.appearance.fontSize || 16)); return true; }
    case 'save-current-file': {
      const note = _notes.find(n => n.id === _selectedNoteId);
      const sourceDiv = document.querySelector('.vault-source-view[contenteditable="true"]');
      if (sourceDiv && note) _flushSourceEdit(sourceDiv, note);
      return true;
    }
    case 'undo-close-tab': {
      if (_lastClosedTab) {
        _navigateToNote(_lastClosedTab, false, true);
      }
      return true;
    }
    case 'zoom-in': _zoom(1); return true;
    case 'zoom-out': _zoom(-1); return true;
    case 'add-internal-link': _toggleInlineWrap('[[', ']]'); return true;
    case 'add-embed': _toggleInlineWrap('![[', ']]'); return true;
    case 'toggle-left-sidebar': {
      const leftPane = document.querySelector('.vault-left-pane');
      const pane3L = document.querySelector('.vault-3pane');
      if (leftPane) {
        leftPane.classList.toggle('hidden');
        if (pane3L) pane3L.classList.toggle('vault-left-hidden', leftPane.classList.contains('hidden'));
      }
      return true;
    }
    case 'toggle-right-sidebar': {
      const rightPane = document.querySelector('.vault-right-pane');
      const pane3R = document.querySelector('.vault-3pane');
      if (rightPane) {
        rightPane.classList.toggle('hidden');
        if (pane3R) pane3R.classList.toggle('vault-right-hidden', rightPane.classList.contains('hidden'));
      }
      return true;
    }
    default: {
      const pluginCmd = _getAllCommands().find(c => c.id === cmdId);
      if (pluginCmd && pluginCmd.callback) { pluginCmd.callback(); return true; }
      if (_pluginManager) {
        for (const p of _pluginManager._instances.values()) {
          const c = (p._commands || []).find(x => x.id === cmdId);
          if (c) { c.callback(); return true; }
        }
      }
    }
  }
  return false;
}

function _renderHotkeySettings() {
  const container = document.querySelector('[data-settings-pane="hotkeys"]');
  if (!container) return;
  let commands = _getAllCommands();
  const hotkeys = _vaultSettings.hotkeys || {};

  // Determine sort mode from data attribute
  const sortMode = container.dataset.sort || 'az';
  if (sortMode === 'az') {
    commands.sort((a, b) => a.label.localeCompare(b.label));
  } else if (sortMode === 'za') {
    commands.sort((a, b) => b.label.localeCompare(a.label));
  } else if (sortMode === 'bound') {
    commands.sort((a, b) => {
      const aBound = hotkeys[a.id] ? 1 : 0;
      const bBound = hotkeys[b.id] ? 1 : 0;
      if (aBound !== bBound) return bBound - aBound;
      return a.label.localeCompare(b.label);
    });
  }

  const sortLabels = { az: 'A–Z', za: 'Z–A', bound: 'Bound first' };

  container.innerHTML = `
    <div class="vault-settings-group">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <h6 class="vault-settings-group-title" style="margin:0;">Keyboard shortcuts</h6>
        <span style="font-size:11px;opacity:0.5;">${commands.length} commands</span>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <input type="text" id="vault-hotkeys-filter" placeholder="Search Hotkeys" style="flex:1;padding:6px 10px;font-size:13px;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;color:var(--fg);box-sizing:border-box;" autocomplete="off" spellcheck="false">
        <div style="position:relative;">
          <button type="button" id="vault-hotkeys-sort" title="Sort commands" style="padding:6px 10px;font-size:12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;color:var(--fg);cursor:pointer;white-space:nowrap;">&#x2195;</button>
          <div id="vault-hotkeys-sort-dropdown" style="display:none;position:absolute;right:0;top:calc(100% + 4px);background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:9999;min-width:140px;overflow:hidden;">
            <button type="button" data-sort="az" style="display:block;width:100%;text-align:left;padding:6px 10px;font-size:12px;background:transparent;border:none;color:var(--fg);cursor:pointer;${sortMode === 'az' ? 'background:color-mix(in srgb,var(--accent,var(--red,#4a9eff)) 10%,transparent);' : ''}">A–Z</button>
            <button type="button" data-sort="za" style="display:block;width:100%;text-align:left;padding:6px 10px;font-size:12px;background:transparent;border:none;color:var(--fg);cursor:pointer;${sortMode === 'za' ? 'background:color-mix(in srgb,var(--accent,var(--red,#4a9eff)) 10%,transparent);' : ''}">Z–A</button>
            <button type="button" data-sort="bound" style="display:block;width:100%;text-align:left;padding:6px 10px;font-size:12px;background:transparent;border:none;color:var(--fg);cursor:pointer;${sortMode === 'bound' ? 'background:color-mix(in srgb,var(--accent,var(--red,#4a9eff)) 10%,transparent);' : ''}">Bound first</button>
          </div>
        </div>
      </div>
      <div id="vault-hotkeys-list" style="display:flex;flex-direction:column;gap:4px;max-height:400px;overflow-y:auto;">
        ${commands.map(cmd => {
          const combo = hotkeys[cmd.id] || '';
          const display = _formatCombo(combo) || '—';
          const disabled = cmd.impl === false;
          return `<div class="vault-settings-row vault-hotkey-row ${disabled ? 'vault-hotkey-disabled' : ''}" style="gap:12px;${disabled ? 'opacity:0.4;' : 'cursor:pointer;'}" data-cmd-id="${_esc(cmd.id)}" data-impl="${cmd.impl !== false}">
            <div class="vault-settings-info" style="flex:1;${disabled ? 'font-style:italic;' : ''}">
              <span>${_esc(cmd.label)}</span>
              ${disabled ? '<span style="font-size:10px;opacity:0.6;margin-left:6px;">(not yet hooked up)</span>' : ''}
            </div>
            <kbd class="vault-hotkey-kbd" style="font-family:monospace;font-size:12px;padding:2px 8px;border-radius:4px;background:var(--bg-raised);border:1px solid var(--border);min-width:80px;text-align:center;cursor:pointer;user-select:none;${disabled ? 'pointer-events:none;' : ''}">${_esc(display)}</kbd>
            <button type="button" class="vault-hotkey-clear" style="background:none;border:none;color:var(--fg);opacity:0.5;cursor:pointer;font-size:12px;padding:2px 6px;${disabled ? 'pointer-events:none;' : ''}" title="Clear shortcut">&#x2715;</button>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;

  // Sort dropdown
  const sortBtn = document.getElementById('vault-hotkeys-sort');
  const sortDropdown = document.getElementById('vault-hotkeys-sort-dropdown');
  if (sortBtn && sortDropdown) {
    const _closeSortDropdown = (e) => {
      if (!sortDropdown.contains(e.target) && !sortBtn.contains(e.target)) {
        sortDropdown.style.display = 'none';
        document.removeEventListener('click', _closeSortDropdown);
      }
    };
    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = sortDropdown.style.display !== 'none';
      if (isOpen) {
        sortDropdown.style.display = 'none';
        document.removeEventListener('click', _closeSortDropdown);
      } else {
        sortDropdown.style.display = 'block';
        // Delay adding listener so current click doesn't immediately close it
        setTimeout(() => document.addEventListener('click', _closeSortDropdown), 0);
      }
    });
    sortDropdown.querySelectorAll('button[data-sort]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        container.dataset.sort = btn.dataset.sort;
        _renderHotkeySettings();
      });
    });
  }

  // Filter logic
  const filterInput = document.getElementById('vault-hotkeys-filter');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const q = filterInput.value.trim().toLowerCase();
      container.querySelectorAll('.vault-hotkey-row').forEach(row => {
        const label = row.querySelector('.vault-settings-info span')?.textContent.toLowerCase() || '';
        row.style.display = label.includes(q) ? '' : 'none';
      });
    });
  }

  let _capturingCmd = null;
  let _captureHandler = null;
  let _clickOutsideHandler = null;

  const stopCapture = () => {
    if (_captureHandler) {
      document.removeEventListener('keydown', _captureHandler, true);
      _captureHandler = null;
    }
    if (_clickOutsideHandler) {
      document.removeEventListener('click', _clickOutsideHandler, true);
      _clickOutsideHandler = null;
    }
    _capturingCmd = null;
    container.querySelectorAll('.vault-hotkey-kbd').forEach(k => {
      k.style.borderColor = 'var(--border)';
      k.style.background = 'var(--bg-raised)';
    });
  };

  container.querySelectorAll('.vault-settings-row[data-cmd-id]').forEach(row => {
    if (row.dataset.impl === 'false') return; // Skip binding for unimplemented commands
    const cmdId = row.dataset.cmdId;
    const kbd = row.querySelector('.vault-hotkey-kbd');
    const clearBtn = row.querySelector('.vault-hotkey-clear');

    kbd.addEventListener('click', () => {
      if (_capturingCmd === cmdId) { stopCapture(); return; }
      stopCapture();
      _capturingCmd = cmdId;
      kbd.textContent = 'Press keys...';
      kbd.style.borderColor = 'var(--accent, var(--red))';
      kbd.style.background = 'color-mix(in srgb, var(--accent, var(--red)) 10%, var(--bg-raised))';

      _clickOutsideHandler = (ev) => {
        if (!ev.target.closest('[data-settings-pane="hotkeys"]')) {
          stopCapture();
          _renderHotkeySettings();
        }
      };
      document.addEventListener('click', _clickOutsideHandler, true);

      _captureHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (e.key === 'Escape') {
          stopCapture();
          _renderHotkeySettings();
          return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          delete _vaultSettings.hotkeys[cmdId];
          _saveVaultSettings();
          stopCapture();
          _renderHotkeySettings();
          return;
        }

        const combo = _normalizeCapturedCombo(e);
        if (!combo) return; // Lone modifier or invalid

        // Check for conflicts
        const conflict = Object.entries(_vaultSettings.hotkeys || {}).find(([id, c]) => id !== cmdId && c === combo);
        if (conflict) {
          showToast(`Conflict: ${_getAllCommands().find(c => c.id === conflict[0])?.label || conflict[0]} already uses ${_formatCombo(combo)}`);
          return;
        }

        _vaultSettings.hotkeys[cmdId] = combo;
        _saveVaultSettings();
        stopCapture();
        _renderHotkeySettings();
      };
      document.addEventListener('keydown', _captureHandler, true);
    });

    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      delete _vaultSettings.hotkeys[cmdId];
      _saveVaultSettings();
      _renderHotkeySettings();
    });
  });
}

function _applyMonospaceFont() {
  const modal = document.getElementById('vault-modal');
  if (!modal) return;
  const on = _vaultSettings.appearance.monospaceFont === true;
  const before = modal.classList.contains('vault-monospace-font');
  if (on) {
    modal.classList.add('vault-monospace-font');
  } else {
    modal.classList.remove('vault-monospace-font');
  }
  const after = modal.classList.contains('vault-monospace-font');

  // Belt-and-suspenders: also set inline font-family on key vault content
  // elements so the change is visible even if CSS specificity has edge cases.
  const monoFont = "'Fira Code', 'Consolas', monospace";
  const targets = [
    modal.querySelector('#vault-preview'),
    modal.querySelector('#vault-folder-tree'),
    ...modal.querySelectorAll('.vault-source-view, .vault-live-view, .vault-reading-view'),
  ].filter(Boolean);
  for (const el of targets) {
    if (on) {
      el.style.setProperty('font-family', monoFont, 'important');
    } else {
      el.style.removeProperty('font-family');
    }
  }

}

function _applyReadableLineLength() {
  const preview = document.getElementById('vault-preview');
  if (!preview) return;
  if (_vaultSettings.editor.readableLineLength) {
    preview.classList.add('vault-readable-line');
  } else {
    preview.classList.remove('vault-readable-line');
  }
}

function _switchSettingsPane(section) {
  document.querySelectorAll('.vault-settings-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.settingsSection === section);
  });
  document.querySelectorAll('.vault-settings-section').forEach(el => {
    el.classList.toggle('hidden', el.dataset.settingsPane !== section);
  });
}

let _selectedPluginSettings = 'backlinks';

function _switchPluginSettingsPane(pluginId) {
  _selectedPluginSettings = pluginId;
  const contentEl = document.querySelector('.vault-plugin-settings-content');
  // If no pane exists for this plugin, inject a fallback
  let pane = document.querySelector(`.vault-plugin-settings-pane[data-plugin-pane="${_esc(pluginId)}"]`);
  if (!pane && contentEl) {
    const plugin = CORE_PLUGINS.find(p => p.id === pluginId);
    const title = plugin ? plugin.name : pluginId;
    pane = document.createElement('div');
    pane.className = 'vault-plugin-settings-pane';
    pane.dataset.pluginPane = pluginId;
    pane.innerHTML = `<h3 class="vault-plugin-title">${_esc(title)}</h3><p style="opacity:0.6;font-size:13px;margin-top:8px;">This plugin has no settings.</p>`;
    contentEl.appendChild(pane);
  }
  document.querySelectorAll('.vault-plugin-settings-pane').forEach(el => {
    el.classList.toggle('hidden', el.dataset.pluginPane !== pluginId);
  });
  document.querySelectorAll('.vault-plugin-settings-sidebar-item').forEach(el => {
    el.classList.toggle('active', el.dataset.pluginId === pluginId);
  });
}

function _renderPluginSettings(query = '') {
  const container = document.getElementById('vault-settings-plugins-list');
  const countEl = document.getElementById('vault-plugins-count');
  if (!container || !_pluginManager) return;
  const enabled = new Set(_vaultSettings.enabledPlugins || []);
  const q = query.toLowerCase().trim();
  const filtered = CORE_PLUGINS.filter(p =>
    !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
  );
  if (countEl) countEl.textContent = `${filtered.length} / ${CORE_PLUGINS.length}`;
  container.innerHTML = filtered.map(p => {
    const isOn = enabled.has(p.id);
    const isActive = _selectedPluginSettings === p.id;
    return `<button type="button" class="vault-plugin-settings-sidebar-item ${isActive ? 'active' : ''}" data-plugin-id="${_esc(p.id)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;border:none;background:none;color:var(--fg);cursor:pointer;width:100%;text-align:left;font-size:13px;">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(p.name)}</span>
      <label class="admin-switch" style="flex-shrink:0;">
        <input type="checkbox" class="vault-plugin-toggle" data-plugin-id="${_esc(p.id)}" ${isOn ? 'checked' : ''}>
        <span class="admin-slider" style="background:${isOn ? 'var(--red)' : 'color-mix(in srgb, var(--fg) 50%, transparent)'};"></span>
      </label>
    </button>`;
  }).join('');
  container.querySelectorAll('.vault-plugin-settings-sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      const pid = item.dataset.pluginId;
      _switchPluginSettingsPane(pid);
    });
  });
  container.querySelectorAll('.admin-switch').forEach(label => {
    label.addEventListener('click', (e) => { e.stopPropagation(); });
  });
  container.querySelectorAll('.vault-plugin-toggle').forEach(toggle => {
    toggle.addEventListener('change', async () => {
      const pid = toggle.dataset.pluginId;
      const on = toggle.checked;
      try {
        if (on) {
          await _pluginManager.enable(pid);
          showToast(`${_esc(pid)} enabled`);
        } else {
          await _pluginManager.disable(pid);
          showToast(`${_esc(pid)} disabled`);
        }
      } catch (err) {
        console.error(`[vault] plugin toggle ${pid} failed:`, err);
        showToast(`Failed to toggle ${pid}`);
        toggle.checked = !on;
        return;
      }
      _vaultSettings.enabledPlugins = CORE_PLUGINS
        .filter(p => _pluginManager.isEnabled(p.id))
        .map(p => p.id);
      _saveVaultSettings();
      _syncPluginTabs();
      const leftMap = { bookmarks: 'bookmarks', tags: 'tags', search: 'search' };
      const rightMap = { backlinks: 'backlinks', 'outgoing-links': 'outgoing', unlinked: 'unlinked', outline: 'outline', orphans: 'orphans' };
      if (!on && leftMap[pid] && _activeLeftTab === leftMap[pid]) {
        const fallback = Array.from(document.querySelectorAll('.vault-sidebar-tabs .vault-sidebar-tab:not(.hidden)')).map(b => b.dataset.tab)[0];
        if (fallback) _switchLeftTab(fallback);
      }
      if (!on && rightMap[pid] && _activeRightTab === rightMap[pid]) {
        const fallback = Array.from(document.querySelectorAll('.vault-right-tabs .vault-right-tab:not(.hidden)')).map(b => b.dataset.tab)[0];
        if (fallback) {
          const panel = _getPanelForTab(fallback);
          _switchRightTab(fallback, panel?.id);
        }
      }
      _switchLeftTab(_activeLeftTab);
      if (_activeRightTab) {
        const panel = _getPanelForTab(_activeRightTab);
        _switchRightTab(_activeRightTab, panel?.id);
      }
      if (_selectedNoteId) _selectNote(_selectedNoteId);
      // Re-render sidebar to update toggle visual state
      _renderPluginSettings(document.getElementById('vault-plugin-search')?.value || '');
    });
  });
}

function _renderCommunityPluginsPane() {
  const container = document.getElementById('vault-community-plugins-container');
  if (!container) return;
  container.innerHTML = '';

  // Section: Installed community plugins
  const installed = getInstalledPlugins();
  const installedIds = Object.keys(installed);

  if (installedIds.length > 0) {
    const instHeader = document.createElement('h6');
    instHeader.className = 'vault-settings-group-title';
    instHeader.textContent = 'Installed plugins';
    container.appendChild(instHeader);

    installedIds.forEach(id => {
      const entry = installed[id];
      const row = document.createElement('div');
      row.className = 'vault-settings-row';
      row.style.gap = '12px';

      const info = document.createElement('div');
      info.style.flex = '1';
      const name = entry.manifest?.name || id;
      const version = entry.manifest?.version ? `v${entry.manifest.version}` : '';
      info.innerHTML = `<span>${_esc(name)} <span style="opacity:0.5;font-size:11px;">${_esc(version)}</span></span>`;

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '6px';

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'admin-btn-sm';
      toggleBtn.type = 'button';
      const isEnabled = entry.enabled;
      toggleBtn.textContent = isEnabled ? 'Disable' : 'Enable';
      toggleBtn.addEventListener('click', async () => {
        try {
          if (isEnabled) {
            await disableCommunityPlugin(id);
          } else {
            await loadCommunityPlugin(id);
          }
          _renderCommunityPluginsPane();
        } catch (err) {
          showToast(`Plugin error: ${err.message}`);
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'admin-btn-sm admin-btn-delete';
      removeBtn.type = 'button';
      removeBtn.textContent = 'Uninstall';
      removeBtn.addEventListener('click', () => {
        uninstallPlugin(id);
        _renderCommunityPluginsPane();
        showToast(`${_esc(name)} uninstalled`);
      });

      actions.appendChild(toggleBtn);
      actions.appendChild(removeBtn);
      row.appendChild(info);
      row.appendChild(actions);
      container.appendChild(row);
    });
  }

  // Section: Browse / Install
  const browseHeader = document.createElement('h6');
  browseHeader.className = 'vault-settings-group-title';
  browseHeader.style.marginTop = '16px';
  browseHeader.textContent = 'Browse Obsidian community plugins';
  container.appendChild(browseHeader);

  const browseContainer = document.createElement('div');
  browseContainer.id = 'vault-community-plugins-browser';
  container.appendChild(browseContainer);

  renderPluginBrowser(browseContainer, () => {
    _renderCommunityPluginsPane();
  });
}

function _openVaultSettings() {
  _loadVaultSettings();
  const dialog = document.getElementById('vault-settings-dialog');
  if (!dialog) return;
  dialog.classList.remove('hidden');
  const set = _vaultSettings;
  const getEl = id => document.getElementById(id);
  if (getEl('vault-set-default-view')) getEl('vault-set-default-view').value = set.editor.defaultView;
  if (getEl('vault-set-readable-line')) getEl('vault-set-readable-line').checked = set.editor.readableLineLength;
  if (getEl('vault-set-strict-breaks')) getEl('vault-set-strict-breaks').checked = set.editor.strictLineBreaks;
  if (getEl('vault-set-fold-heading')) getEl('vault-set-fold-heading').checked = set.editor.foldHeading;
  if (getEl('vault-set-fold-indent')) getEl('vault-set-fold-indent').checked = set.editor.foldIndent;
  if (getEl('vault-set-line-numbers')) getEl('vault-set-line-numbers').checked = set.editor.showLineNumbers;
  if (getEl('vault-set-auto-brackets')) getEl('vault-set-auto-brackets').checked = set.editor.autoPairBrackets;
  if (getEl('vault-set-auto-md')) getEl('vault-set-auto-md').checked = set.editor.autoPairMarkdown;
  if (getEl('vault-set-smart-lists')) getEl('vault-set-smart-lists').checked = set.editor.smartLists;
  if (getEl('vault-set-indent-tabs')) getEl('vault-set-indent-tabs').checked = set.editor.indentWithTabs;
  if (getEl('vault-set-vim')) getEl('vault-set-vim').checked = set.editor.vimBindings;
  if (getEl('vault-set-inline-title')) getEl('vault-set-inline-title').checked = set.appearance.showInlineTitle;
  if (getEl('vault-set-monospace-font')) getEl('vault-set-monospace-font').checked = set.appearance.monospaceFont;
  if (getEl('vault-set-show-ribbon')) getEl('vault-set-show-ribbon').checked = set.appearance.showRibbon !== false;
  if (getEl('vault-set-wikilinks')) getEl('vault-set-wikilinks').checked = set.filesAndLinks.useWikilinks;
  if (getEl('vault-set-link-format')) getEl('vault-set-link-format').value = set.filesAndLinks.linkFormat;
  if (getEl('vault-set-confirm-delete')) getEl('vault-set-confirm-delete').checked = set.filesAndLinks.confirmDelete;
  if (getEl('vault-set-auto-links')) getEl('vault-set-auto-links').checked = set.filesAndLinks.autoUpdateLinks;
  if (getEl('vault-set-confirm-auto-links')) getEl('vault-set-confirm-auto-links').checked = set.filesAndLinks.confirmAutoUpdateLinks !== false;
  if (getEl('vault-set-new-note-loc')) getEl('vault-set-new-note-loc').value = set.filesAndLinks.newNoteLocation;
  if (getEl('vault-set-new-note-folder')) getEl('vault-set-new-note-folder').value = set.filesAndLinks.newNoteFolder;
  if (getEl('vault-set-new-attach-loc')) getEl('vault-set-new-attach-loc').value = set.filesAndLinks.newAttachmentLocation;
  if (getEl('vault-set-new-attach-folder')) getEl('vault-set-new-attach-folder').value = set.filesAndLinks.newAttachmentFolder;
  if (getEl('vault-set-always-focus')) getEl('vault-set-always-focus').checked = set.editor.alwaysFocusNewTabs;
  if (getEl('vault-set-show-edit-mode')) getEl('vault-set-show-edit-mode').checked = set.editor.showEditingModeInStatusBar;
  if (getEl('vault-set-properties')) getEl('vault-set-properties').value = set.editor.propertiesInDocument;
  if (getEl('vault-set-indent-guides')) getEl('vault-set-indent-guides').checked = set.editor.indentationGuides;
  if (getEl('vault-set-rtl')) getEl('vault-set-rtl').checked = set.editor.rtl;
  if (getEl('vault-set-spellcheck')) getEl('vault-set-spellcheck').checked = set.editor.spellcheck;
  if (getEl('vault-set-indent-width')) getEl('vault-set-indent-width').value = set.editor.indentVisualWidth;
  if (getEl('vault-set-convert-html')) getEl('vault-set-convert-html').checked = set.editor.convertPastedHtml;
  if (getEl('vault-set-auto-save')) getEl('vault-set-auto-save').value = set.editor.autoSave;
  if (getEl('vault-set-auto-save-delay')) getEl('vault-set-auto-save-delay').value = set.editor.autoSaveDelay;
  if (getEl('vault-set-default-file-open')) getEl('vault-set-default-file-open').value = set.filesAndLinks.defaultFileToOpen;
  const specificFileRow = document.getElementById('vault-specific-file-row');
  const specificFileInput = document.getElementById('vault-set-specific-file');
  if (specificFileRow && specificFileInput) {
    specificFileRow.classList.toggle('hidden', set.filesAndLinks.defaultFileToOpen !== 'specific-file');
    const selectedNote = _notes.find(n => n.id === set.filesAndLinks.defaultSpecificFile);
    specificFileInput.value = selectedNote ? (selectedNote.title || selectedNote.id) : '';
    specificFileInput.dataset.noteId = set.filesAndLinks.defaultSpecificFile || '';
  }
  if (getEl('vault-set-detect-ext')) getEl('vault-set-detect-ext').checked = set.filesAndLinks.detectAllFileExtensions;
  if (getEl('vault-set-tab-title-bar')) getEl('vault-set-tab-title-bar').checked = set.appearance.showTabTitleBar;
  if (getEl('vault-set-backlinks-bottom')) getEl('vault-set-backlinks-bottom').checked = set.appearance.showBacklinksAtBottom;
  // Plugin settings
  const ps = set.plugins || {};
  if (getEl('vault-plugin-set-backlinks-bottom')) getEl('vault-plugin-set-backlinks-bottom').checked = ps.backlinks?.showBacklinksAtBottom ?? false;
  if (getEl('vault-plugin-set-dn-date-format')) getEl('vault-plugin-set-dn-date-format').value = ps['daily-notes']?.dateFormat ?? 'YYYY-MM-DD';
  if (getEl('vault-plugin-set-dn-location')) getEl('vault-plugin-set-dn-location').value = ps['daily-notes']?.newFileLocation ?? '';
  if (getEl('vault-plugin-set-dn-template')) getEl('vault-plugin-set-dn-template').value = ps['daily-notes']?.templateFileLocation ?? '';
  if (getEl('vault-plugin-set-qs-existing')) getEl('vault-plugin-set-qs-existing').checked = ps['quick-switcher']?.showExistingOnly ?? false;
  if (getEl('vault-plugin-set-qs-attachments')) getEl('vault-plugin-set-qs-attachments').checked = ps['quick-switcher']?.showAttachments ?? true;
  if (getEl('vault-plugin-set-tmpl-folder')) getEl('vault-plugin-set-tmpl-folder').value = ps.templates?.templateFolderLocation ?? '';
  if (getEl('vault-plugin-set-tmpl-date')) getEl('vault-plugin-set-tmpl-date').value = ps.templates?.dateFormat ?? 'DD-MM-YYYY';
  if (getEl('vault-plugin-set-tmpl-time')) getEl('vault-plugin-set-tmpl-time').value = ps.templates?.timeFormat ?? 'HH:mm';
  _renderPluginSettings();
  _switchPluginSettingsPane(_selectedPluginSettings);
  _renderHotkeySettings();
  _renderCommunityPluginsPane();
  _applyMonospaceFont();
  _applyReadableLineLength();
  _switchSettingsPane('editor');
}

function _closeVaultSettings() {
  document.getElementById('vault-settings-dialog')?.classList.add('hidden');
}

function _wireVaultSettings() {
  document.getElementById('vault-settings-cog')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _openVaultSettings();
  });
  document.getElementById('vault-settings-close')?.addEventListener('click', _closeVaultSettings);
  document.querySelectorAll('.vault-settings-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      if (!item.disabled) _switchSettingsPane(item.dataset.settingsSection);
    });
  });
  const bindToggle = (id, path) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      const keys = path.split('.');
      let target = _vaultSettings;
      for (let i = 0; i < keys.length - 1; i++) target = target[keys[i]];
      target[keys[keys.length - 1]] = el.checked;
      _saveVaultSettings();
      if (path === 'appearance.fontSize') {
        document.documentElement.style.setProperty('--vault-font-size', el.value + 'px');
      }
      if (path === 'appearance.monospaceFont') {
        _applyMonospaceFont();
      }
      if (path === 'editor.readableLineLength') {
        _applyReadableLineLength();
      }
      if (path === 'editor.strictLineBreaks' || path === 'editor.foldHeading' || path === 'editor.foldIndent') {
        if (_selectedNoteId) _selectNote(_selectedNoteId);
      }
    });
  };
  const bindSelect = (id, path) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      const keys = path.split('.');
      let target = _vaultSettings;
      for (let i = 0; i < keys.length - 1; i++) target = target[keys[i]];
      target[keys[keys.length - 1]] = el.value;
      _saveVaultSettings();
      if (path === 'editor.defaultView') {
        _previewMode = el.value === 'live' ? 'live' : el.value === 'source' ? 'edit' : 'preview';
        _editModePref = el.value === 'source' ? 'edit' : 'live';
        _sourceModeEnabled = el.value === 'source';
      }
      if (path === 'editor.autoSave' && el.value !== 'afterDelay') {
        for (const timer of _saveTimers.values()) clearTimeout(timer);
        _saveTimers.clear();
      }
    });
  };
  const bindRange = (id, path, valId) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const keys = path.split('.');
      let target = _vaultSettings;
      for (let i = 0; i < keys.length - 1; i++) target = target[keys[i]];
      target[keys[keys.length - 1]] = parseInt(el.value, 10);
      _saveVaultSettings();
      const valEl = document.getElementById(valId);
      if (valEl) valEl.textContent = el.value;
      if (path === 'appearance.fontSize') {
        document.documentElement.style.setProperty('--vault-font-size', el.value + 'px');
      }
    });
  };
  bindToggle('vault-set-readable-line', 'editor.readableLineLength');
  bindToggle('vault-set-strict-breaks', 'editor.strictLineBreaks');
  bindToggle('vault-set-fold-heading', 'editor.foldHeading');
  bindToggle('vault-set-fold-indent', 'editor.foldIndent');
  bindToggle('vault-set-always-focus', 'editor.alwaysFocusNewTabs');
  bindToggle('vault-set-show-edit-mode', 'editor.showEditingModeInStatusBar');
  bindSelect('vault-set-properties', 'editor.propertiesInDocument');
  bindToggle('vault-set-indent-guides', 'editor.indentationGuides');
  bindToggle('vault-set-rtl', 'editor.rtl');
  bindToggle('vault-set-spellcheck', 'editor.spellcheck');
  bindToggle('vault-set-convert-html', 'editor.convertPastedHtml');
  bindSelect('vault-set-auto-save', 'editor.autoSave');
  bindRange('vault-set-auto-save-delay', 'editor.autoSaveDelay', null);
  bindToggle('vault-set-detect-ext', 'filesAndLinks.detectAllFileExtensions');
  bindToggle('vault-set-tab-title-bar', 'appearance.showTabTitleBar');
  bindToggle('vault-set-backlinks-bottom', 'appearance.showBacklinksAtBottom');
  const indentWidthInput = document.getElementById('vault-set-indent-width');
  if (indentWidthInput) {
    indentWidthInput.addEventListener('change', () => {
      _vaultSettings.editor.indentVisualWidth = parseInt(indentWidthInput.value, 10) || 4;
      _saveVaultSettings();
    });
  }
  const defaultFileOpenSelect = document.getElementById('vault-set-default-file-open');
  if (defaultFileOpenSelect) {
    defaultFileOpenSelect.addEventListener('change', () => {
      _vaultSettings.filesAndLinks.defaultFileToOpen = defaultFileOpenSelect.value;
      const row = document.getElementById('vault-specific-file-row');
      if (row) row.classList.toggle('hidden', defaultFileOpenSelect.value !== 'specific-file');
      _saveVaultSettings();
    });
  }
  const specificFileInput = document.getElementById('vault-set-specific-file');
  const specificFileSuggestions = document.getElementById('vault-specific-file-suggestions');
  if (specificFileInput && specificFileSuggestions) {
    const _showSuggestions = (query) => {
      const q = query.toLowerCase().trim();
      const notes = [..._notes].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      const matches = q ? notes.filter(n => (n.title || n.id).toLowerCase().includes(q)) : notes;
      if (!matches.length) {
        specificFileSuggestions.classList.add('hidden');
        return;
      }
      specificFileSuggestions.innerHTML = matches.map(n =>
        `<div class="vault-note-menu-item" data-note-id="${_esc(n.id)}"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(n.title || n.id)}</span></div>`
      ).join('');
      specificFileSuggestions.classList.remove('hidden');
      specificFileSuggestions.querySelectorAll('.vault-note-menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const noteId = item.dataset.noteId;
          const note = _notes.find(n => n.id === noteId);
          specificFileInput.value = note ? (note.title || note.id) : noteId;
          specificFileInput.dataset.noteId = noteId;
          _vaultSettings.filesAndLinks.defaultSpecificFile = noteId;
          _saveVaultSettings();
          specificFileSuggestions.classList.add('hidden');
        });
      });
    };
    specificFileInput.addEventListener('input', () => {
      _showSuggestions(specificFileInput.value);
    });
    specificFileInput.addEventListener('focus', () => {
      _showSuggestions(specificFileInput.value);
    });
    specificFileInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        specificFileSuggestions.classList.add('hidden');
      }
    });
    // Close suggestions on outside click
    document.addEventListener('click', (e) => {
      if (!specificFileInput.contains(e.target) && !specificFileSuggestions.contains(e.target)) {
        specificFileSuggestions.classList.add('hidden');
      }
    });
  }
  const lineNumToggle = document.getElementById('vault-set-line-numbers');
  if (lineNumToggle) {
    lineNumToggle.addEventListener('change', () => {
      _vaultSettings.editor.showLineNumbers = lineNumToggle.checked;
      _saveVaultSettings();
      if (_selectedNoteId) _selectNote(_selectedNoteId);
    });
  }
  bindToggle('vault-set-auto-brackets', 'editor.autoPairBrackets');
  bindToggle('vault-set-auto-md', 'editor.autoPairMarkdown');
  bindToggle('vault-set-smart-lists', 'editor.smartLists');
  bindToggle('vault-set-indent-tabs', 'editor.indentWithTabs');
  bindToggle('vault-set-vim', 'editor.vimBindings');
  const pluginSearchInput = document.getElementById('vault-plugin-search');
  if (pluginSearchInput) {
    pluginSearchInput.addEventListener('input', () => {
      _renderPluginSettings(pluginSearchInput.value);
    });
  }
  // Plugin settings wiring
  const wirePluginToggle = (id, pluginId, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (!_vaultSettings.plugins[pluginId]) _vaultSettings.plugins[pluginId] = {};
      _vaultSettings.plugins[pluginId][key] = el.checked;
      _saveVaultSettings();
    });
  };
  const wirePluginInput = (id, pluginId, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (!_vaultSettings.plugins[pluginId]) _vaultSettings.plugins[pluginId] = {};
      _vaultSettings.plugins[pluginId][key] = el.value;
      _saveVaultSettings();
    });
  };
  wirePluginToggle('vault-plugin-set-backlinks-bottom', 'backlinks', 'showBacklinksAtBottom');
  wirePluginInput('vault-plugin-set-dn-date-format', 'daily-notes', 'dateFormat');
  wirePluginInput('vault-plugin-set-dn-location', 'daily-notes', 'newFileLocation');
  wirePluginInput('vault-plugin-set-dn-template', 'daily-notes', 'templateFileLocation');
  wirePluginToggle('vault-plugin-set-qs-existing', 'quick-switcher', 'showExistingOnly');
  wirePluginToggle('vault-plugin-set-qs-attachments', 'quick-switcher', 'showAttachments');
  wirePluginInput('vault-plugin-set-tmpl-folder', 'templates', 'templateFolderLocation');
  wirePluginInput('vault-plugin-set-tmpl-date', 'templates', 'dateFormat');
  wirePluginInput('vault-plugin-set-tmpl-time', 'templates', 'timeFormat');
  const inlineTitleToggle = document.getElementById('vault-set-inline-title');
  if (inlineTitleToggle) {
    inlineTitleToggle.addEventListener('change', () => {
      _vaultSettings.appearance.showInlineTitle = inlineTitleToggle.checked;
      _saveVaultSettings();
      if (_selectedNoteId) _selectNote(_selectedNoteId);
    });
  }
  bindToggle('vault-set-monospace-font', 'appearance.monospaceFont');
  bindToggle('vault-set-show-ribbon', 'appearance.showRibbon');
  const showRibbonToggle = document.getElementById('vault-set-show-ribbon');
  if (showRibbonToggle) {
    showRibbonToggle.addEventListener('change', () => _renderRibbon());
  }
  document.getElementById('vault-set-ribbon-config-btn')?.addEventListener('click', () => {
    _openRibbonConfigDialog();
  });
  bindToggle('vault-set-wikilinks', 'filesAndLinks.useWikilinks');
  bindToggle('vault-set-confirm-delete', 'filesAndLinks.confirmDelete');
  bindToggle('vault-set-auto-links', 'filesAndLinks.autoUpdateLinks');
  bindToggle('vault-set-confirm-auto-links', 'filesAndLinks.confirmAutoUpdateLinks');
  bindSelect('vault-set-default-view', 'editor.defaultView');
  bindSelect('vault-set-link-format', 'filesAndLinks.linkFormat');
  bindSelect('vault-set-new-note-loc', 'filesAndLinks.newNoteLocation');
  bindSelect('vault-set-new-attach-loc', 'filesAndLinks.newAttachmentLocation');
  const newNoteFolderInput = document.getElementById('vault-set-new-note-folder');
  if (newNoteFolderInput) {
    newNoteFolderInput.addEventListener('change', () => {
      _vaultSettings.filesAndLinks.newNoteFolder = newNoteFolderInput.value;
      _saveVaultSettings();
    });
  }
  const newAttachFolderInput = document.getElementById('vault-set-new-attach-folder');
  if (newAttachFolderInput) {
    newAttachFolderInput.addEventListener('change', () => {
      _vaultSettings.filesAndLinks.newAttachmentFolder = newAttachFolderInput.value;
      _saveVaultSettings();
    });
  }
  // Settings dialog drag
  const settingsHeader = document.getElementById('vault-settings-header');
  const settingsCard = document.querySelector('.vault-settings-dialog-card');
  if (settingsHeader && settingsCard) {
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let cardStartX = 0, cardStartY = 0;
    settingsHeader.addEventListener('mousedown', (e) => {
      if (e.target.closest('#vault-settings-close')) return;
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = settingsCard.getBoundingClientRect();
      cardStartX = rect.left;
      cardStartY = rect.top;
      settingsHeader.style.cursor = 'grabbing';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      settingsCard.style.transform = 'none';
      settingsCard.style.left = (cardStartX + dx) + 'px';
      settingsCard.style.top = (cardStartY + dy) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        settingsHeader.style.cursor = 'grab';
      }
    });
  }

  // Settings dialog resize — uses same edge/corner mechanic as other Odysseus windows
  if (settingsCard) {
    const settingsHeader = settingsCard.querySelector('.vault-settings-header');
    makeWindowResizable(settingsCard, {
      minWidth: 400,
      minHeight: 300,
      storageKey: 'winsize-vault-settings',
      cursorTargets: settingsHeader ? [settingsCard, settingsHeader] : [settingsCard]
    });
  }
}


// ── CSS Snippets (Phase E) ─────────────────────────────────

let _cssSnippets = [];
try {
  const raw = localStorage.getItem('vault-css-snippets');
  if (raw) _cssSnippets = JSON.parse(raw);
} catch {}

function _persistCssSnippets() {
  try { localStorage.setItem('vault-css-snippets', JSON.stringify(_cssSnippets)); } catch {}
}

function _injectCssSnippets() {
  // Remove existing injected snippets
  document.querySelectorAll('style.vault-css-snippet').forEach(el => el.remove());
  const enabled = _cssSnippets.filter(s => s.enabled);
  for (const s of enabled) {
    const style = document.createElement('style');
    style.className = 'vault-css-snippet';
    style.dataset.snippetId = s.id;
    style.textContent = s.content;
    document.head.appendChild(style);
  }
}

let _snippetEditingId = null;

function _renderSnippetsList() {
  const list = document.getElementById('vault-snippets-list');
  const editor = document.getElementById('vault-snippet-editor');
  if (!list) return;
  if (_cssSnippets.length === 0) {
    list.innerHTML = '<div style="padding:8px;text-align:center;opacity:0.5;font-size:12px;">No snippets yet. Click "+ New snippet" to create one.</div>';
  } else {
    list.innerHTML = _cssSnippets.map(s => `
      <div class="vault-settings-row" style="gap:10px;">
        <label class="admin-switch" style="flex-shrink:0;">
          <input type="checkbox" class="vault-snippet-toggle" data-snippet-id="${_esc(s.id)}" ${s.enabled ? 'checked' : ''}>
          <span class="admin-slider"></span>
        </label>
        <div class="vault-settings-info" style="flex:1;cursor:pointer;" data-snippet-edit="${_esc(s.id)}">
          <span>${_esc(s.name || 'Untitled')}</span>
          <span class="vault-settings-desc">${s.content.length} chars</span>
        </div>
        <button type="button" class="vault-snippet-edit-btn admin-btn-sm" data-snippet-id="${_esc(s.id)}">Edit</button>
      </div>
    `).join('');
    // Wire toggles
    list.querySelectorAll('.vault-snippet-toggle').forEach(toggle => {
      toggle.addEventListener('change', () => {
        const id = toggle.dataset.snippetId;
        const s = _cssSnippets.find(x => x.id === id);
        if (s) { s.enabled = toggle.checked; _persistCssSnippets(); _injectCssSnippets(); }
      });
    });
    // Wire edit buttons
    list.querySelectorAll('.vault-snippet-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => _openSnippetEditor(btn.dataset.snippetId));
    });
    list.querySelectorAll('[data-snippet-edit]').forEach(row => {
      row.addEventListener('click', () => _openSnippetEditor(row.dataset.snippetEdit));
    });
  }
  if (editor) editor.classList.add('hidden');
  if (list.parentElement) list.parentElement.classList.remove('hidden');
}

function _openSnippetEditor(id) {
  const list = document.getElementById('vault-snippets-list');
  const editor = document.getElementById('vault-snippet-editor');
  const nameInput = document.getElementById('vault-snippet-name');
  const contentInput = document.getElementById('vault-snippet-content');
  if (!editor || !nameInput || !contentInput) return;
  _snippetEditingId = id || null;
  if (id) {
    const s = _cssSnippets.find(x => x.id === id);
    nameInput.value = s ? s.name : '';
    contentInput.value = s ? s.content : '';
  } else {
    nameInput.value = '';
    contentInput.value = '';
  }
  if (list) list.parentElement.classList.add('hidden');
  editor.classList.remove('hidden');
  nameInput.focus();
}

function _closeSnippetEditor() {
  _renderSnippetsList();
}

function _saveSnippet() {
  const nameInput = document.getElementById('vault-snippet-name');
  const contentInput = document.getElementById('vault-snippet-content');
  if (!nameInput || !contentInput) return;
  const name = nameInput.value.trim() || 'Untitled';
  const content = contentInput.value;
  if (_snippetEditingId) {
    const s = _cssSnippets.find(x => x.id === _snippetEditingId);
    if (s) { s.name = name; s.content = content; }
  } else {
    _cssSnippets.push({ id: 'snippet_' + Date.now(), name, content, enabled: true });
  }
  _persistCssSnippets();
  _injectCssSnippets();
  _closeSnippetEditor();
}

function _deleteSnippet() {
  if (!_snippetEditingId) return;
  if (!confirm('Delete this snippet?')) return;
  _cssSnippets = _cssSnippets.filter(s => s.id !== _snippetEditingId);
  _persistCssSnippets();
  _injectCssSnippets();
  _closeSnippetEditor();
}

function _wireSnippetSettings() {
  // CSS snippets are managed in their dedicated Snippets settings pane
  document.getElementById('vault-snippet-add')?.addEventListener('click', () => _openSnippetEditor(null));
  document.getElementById('vault-snippet-back')?.addEventListener('click', _closeSnippetEditor);
  document.getElementById('vault-snippet-save')?.addEventListener('click', _saveSnippet);
  document.getElementById('vault-snippet-delete')?.addEventListener('click', _deleteSnippet);
}

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

async function _renderSearchPane(query = '') {
  const resultsEl = document.getElementById('vault-search-results');
  const explainEl = document.getElementById('vault-search-explain-bar');
  const clearBtn = document.getElementById('vault-search-clear');
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

  // ── Semantic search branch ────────────────────────────────
  if (_searchState.semantic && !query.toLowerCase().startsWith('tag:')) {
    resultsEl.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;font-size:12px;">Searching by meaning...</div>';
    try {
      const resp = await fetch(`${API_BASE}/api/vault/semantic-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ query: query.trim(), top_k: 20 }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const matches = data.results || [];

      if (explainEl) {
        if (_searchState.explain) {
          explainEl.textContent = `${matches.length} semantic results — "${query}"`;
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
        const score = n.score != null ? Math.round(n.score * 100) : 0;
        const preview = (n.content || '').split('\n').slice(0, 3).join('\n');
        const override = _searchState.fileStates.get(n.id);
        const isCollapsed = override !== undefined ? override : _searchState.collapse;
        const chevron = isCollapsed ? '>' : '>';
        const matchesHtml = _searchState.context
          ? `<div class="vault-search-match raw">${_esc(preview)}</div>`
          : `<div class="vault-search-match">${_esc(preview.slice(0, 160))}</div>`;

        return `<div class="vault-search-file">
          <div class="vault-search-file-header ${isCollapsed ? 'collapsed' : ''}" data-note-id="${_esc(n.id)}">
            <span class="vault-search-chevron">${chevron}</span>
            <span>${_esc(n.title)}</span>
            <span class="vault-search-file-count" title="Relevance score">${score}%</span>
          </div>
          <div class="vault-search-matches" ${isCollapsed ? 'style="display:none"' : ''}>${matchesHtml}</div>
        </div>`;
      }).join('');

      _wireSearchResultClicks(resultsEl, query);
      return;
    } catch (err) {
      resultsEl.innerHTML = `<div style="padding:10px;text-align:center;opacity:0.5;font-size:12px;">Semantic search failed: ${_esc(err.message)}</div>`;
      return;
    }
  }

  // ── Keyword search branch (existing logic) ─────────────────
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
    const chevron = isCollapsed ? '>' : '>';

    // Render matches (always build HTML; visibility controlled by display:none)
    // Cap at 15 per file to prevent lag on broad searches
    const MAX_MATCHES = 15;
    const displayedMatches = fileMatches.slice(0, MAX_MATCHES);
    const hiddenCount = fileMatches.length - MAX_MATCHES;
    let matchesHtml = '';
    if (matchCount > 0) {
      matchesHtml = displayedMatches.map(m => {
        const display = _searchState.context
          ? `<div class="vault-search-match raw">${_highlightText(m.text, regex)}</div>`
          : `<div class="vault-search-match">${_highlightText(m.text, regex)}</div>`;
        return display;
      }).join('');
      if (hiddenCount > 0) {
        matchesHtml += `<div style="padding:4px 8px;font-size:11px;opacity:0.5;">+${hiddenCount} more</div>`;
      }
    } else if (matchCount === 0 && !isTagSearch) {
      // Title-only match — show first few lines as context
      const preview = (n.content || '').split('\n').slice(0, 3).join('\n');
      matchesHtml = _searchState.context
        ? `<div class="vault-search-match raw">${_esc(preview)}</div>`
        : `<div class="vault-search-match">${_esc(preview.slice(0, 160))}</div>`;
    }

    return `<div class="vault-search-file">
      <div class="vault-search-file-header ${isCollapsed ? 'collapsed' : ''}" data-note-id="${_esc(n.id)}">
        <span class="vault-search-chevron">${chevron}</span>
        <span>${_esc(n.title)}</span>
        <span class="vault-search-file-count">${matchCount || (isTagSearch ? (n.tags || []).length : 0)}</span>
      </div>
      <div class="vault-search-matches" ${isCollapsed ? 'style="display:none"' : ''}>${matchesHtml}</div>
    </div>`;
  }).join('');

  _wireSearchResultClicks(resultsEl, query);
}

function _wireSearchResultClicks(resultsEl, query) {
  // Wire click on headers (toggle collapse + navigate on title click)
  resultsEl.querySelectorAll('.vault-search-file-header').forEach(header => {
    header.addEventListener('click', (e) => {
      const noteId = header.dataset.noteId;
      // Click on chevron toggles collapse; click on title navigates
      const isChevron = e.target.closest('.vault-search-chevron');
      if (isChevron) {
        const matchesDiv = header.nextElementSibling;
        const wasCollapsed = matchesDiv.style.display === 'none';
        const nowCollapsed = !wasCollapsed;
        matchesDiv.style.display = wasCollapsed ? '' : 'none';
        header.classList.toggle('collapsed', nowCollapsed);
        const chevronEl = header.querySelector('.vault-search-chevron');
        chevronEl.innerHTML = wasCollapsed ? '>' : '>';
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
  resultsEl.querySelectorAll('.vault-search-file-header').forEach(header => {
    header.addEventListener('contextmenu', (e) => {
      _showFileContextMenu(e, header.dataset.noteId);
    });
  });
}

// ── Search history ─────────────────────────────────────────

let _searchHistory = [];
try {
  const raw = localStorage.getItem('vault-search-history');
  if (raw) _searchHistory = JSON.parse(raw);
} catch {}

function _persistSearchHistory() {
  try { localStorage.setItem('vault-search-history', JSON.stringify(_searchHistory.slice(0, 20))); } catch {}
}

function _addSearchHistory(query) {
  const q = query.trim();
  if (!q || q.length < 2) return;
  _searchHistory = _searchHistory.filter(h => h !== q);
  _searchHistory.unshift(q);
  _persistSearchHistory();
}

function _renderSearchHistory() {
  const el = document.getElementById('vault-search-history');
  if (!el) return;
  if (!_searchHistory.length) {
    el.innerHTML = '<div style="padding:4px 6px;opacity:0.4;font-size:12px;">No recent searches</div>';
    return;
  }
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
      <span></span>
      <button class="vault-search-history-clear" title="Clear history" style="background:transparent;border:none;color:var(--fg);opacity:0.4;cursor:pointer;padding:2px;font-size:11px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  ` + _searchHistory.map(q =>
    `<div class="vault-search-history-item" data-query="${_esc(q)}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <span>${_esc(q)}</span>
    </div>`
  ).join('');
  el.querySelector('.vault-search-history-clear')?.addEventListener('click', () => {
    _searchHistory = [];
    _persistSearchHistory();
    _renderSearchHistory();
  });
  el.querySelectorAll('.vault-search-history-item').forEach(item => {
    item.addEventListener('click', () => {
      const input = document.getElementById('vault-search-input');
      if (input) {
        input.value = item.dataset.query;
        _renderSearchPane(item.dataset.query);
      }
    });
  });
}

function _toggleSearchEmpty(show) {
  const emptyEl = document.getElementById('vault-search-empty');
  if (emptyEl) emptyEl.classList.toggle('hidden', !show);
  if (show) _renderSearchHistory();
}

let _bookmarks = new Set();

try {
  const raw = localStorage.getItem('vault-bookmarks');
  if (raw) _bookmarks = new Set(JSON.parse(raw));
} catch {}

function _persistBookmarks() {
  try { localStorage.setItem('vault-bookmarks', JSON.stringify([..._bookmarks])); } catch {}
}

function _toggleBookmark(noteId) {
  if (_bookmarks.has(noteId)) _bookmarks.delete(noteId);
  else _bookmarks.add(noteId);
  _persistBookmarks();
  if (_activeLeftTab === 'bookmarks') _renderBookmarksPane();
}

// ── Note / folder icon pack ──
const _NOTE_ICON_PACK = {
  file:   '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  star:   '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  heart:  '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  bolt:   '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  book:   '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  check:  '<polyline points="20 6 9 17 4 12"/>',
  clock:  '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  code:   '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  edit:   '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  flag:   '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  image:  '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  link:   '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  lock:   '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  map:    '<polygon points="1 6 1 22 8 18 16 22 21 18 21 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
  music:  '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  paper:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
  pen:    '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1-1 3-3 1 1-3 3z"/><path d="M3 3h6l2 4H7z"/>',
  pin:    '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  tag:    '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1"/>',
  trash:  '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  zap:    '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
};

let _noteIcons = {};
try {
  const raw = localStorage.getItem('vault-note-icons');
  if (raw) _noteIcons = JSON.parse(raw);
} catch {}

function _persistNoteIcons() {
  try { localStorage.setItem('vault-note-icons', JSON.stringify(_noteIcons)); } catch {}
}

function _setNoteIcon(noteId, iconKey) {
  if (!iconKey) delete _noteIcons[noteId];
  else _noteIcons[noteId] = iconKey;
  _persistNoteIcons();
  _renderFolderTree();
}

function _getNoteIconSvg(noteId, fallbackKey = 'file', size = 13) {
  const key = _noteIcons[noteId] || fallbackKey;
  const paths = _NOTE_ICON_PACK[key] || _NOTE_ICON_PACK.file;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;flex-shrink:0;opacity:0.7;">${paths}</svg>`;
}

let _folderIcons = {};
try {
  const raw = localStorage.getItem('vault-folder-icons');
  if (raw) _folderIcons = JSON.parse(raw);
} catch {}

function _persistFolderIcons() {
  try { localStorage.setItem('vault-folder-icons', JSON.stringify(_folderIcons)); } catch {}
}

function _setFolderIcon(folderPath, iconKey) {
  if (!iconKey) delete _folderIcons[folderPath];
  else _folderIcons[folderPath] = iconKey;
  _persistFolderIcons();
  _renderFolderTree();
}

function _getFolderIconSvg(folderPath, fallbackKey = 'folder', size = 13) {
  const key = _folderIcons[folderPath] || fallbackKey;
  const paths = _NOTE_ICON_PACK[key] || _NOTE_ICON_PACK.folder;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;flex-shrink:0;opacity:0.7;">${paths}</svg>`;
}

function _renderBookmarksPane() {
  const el = document.getElementById('vault-bookmarks-list');
  if (!el) return;
  const items = [..._bookmarks].map(id => _notes.find(n => n.id === id)).filter(Boolean);
  if (!items.length) {
    el.innerHTML = '<div style="padding:10px;text-align:center;opacity:0.5;font-size:12px;">No bookmarks yet.<br>Right-click a note and select Bookmark.</div>';
    return;
  }
  el.innerHTML = items.map(n => {
    const icon = _getNoteIconSvg(n.id, 'file', 12);
    return `<div class="vault-bookmark-item" data-note-id="${_esc(n.id)}">
      <span style="display:inline-flex;align-items:center;flex-shrink:0;">${icon}</span>
      ${_esc(n.title)}
    </div>`;
  }).join('');
  el.querySelectorAll('.vault-bookmark-item').forEach(item => {
    item.addEventListener('click', () => _navigateToNote(item.dataset.noteId));
  });
}

function _renderTagsPane() {
  const el = document.getElementById('vault-tags-cloud');
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
    `<span class="vault-tag-chip" data-tag="${_esc(tag)}">${_esc(tag)}<span class="vault-tag-count">${count}</span></span>`
  ).join('');
  el.querySelectorAll('.vault-tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      _searchQuery = chip.dataset.tag;
      document.getElementById('vault-search-input').value = 'tag:' + chip.dataset.tag;
      _switchLeftTab('search');
      _renderSearchPane('tag:' + chip.dataset.tag);
    });
  });
}

// ── Data ───────────────────────────────────────────────────

function _restoreCachedNotes(vaultId) {
  try {
    const cached = localStorage.getItem(`vault-notes-${vaultId}`);
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
  const list = document.getElementById('vault-note-list');
  try {
    const qs = new URLSearchParams();
    if (_selectedVaultId) qs.set('vault_id', _selectedVaultId);
    if (_searchQuery) qs.set('q', _searchQuery);
    qs.set('limit', '9999');
    const r = await fetch(`${API_BASE}/api/vault/notes?${qs.toString()}`);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      if (list) list.innerHTML = `<div style="padding:20px;text-align:center;opacity:0.5;font-size:12px;">Error loading notes: ${d.detail || r.status}</div>`;
      _notes = [];
      return;
    }
    const data = await r.json();
    const backendNotes = data.notes || [];
    // Preserve optimistic notes not yet confirmed by backend
    const optimisticExtras = _notes.filter(n => n._optimistic && !backendNotes.some(b => b.id === n.id || b.rel_path === n.rel_path));
    _notes = [...backendNotes, ...optimisticExtras];
    _noteCache = buildNoteCache(_notes);
    _renderNoteList();
    _populateVaultDropdown();
    // Cache
    try {
      localStorage.setItem(`vault-notes-${_selectedVaultId}`, JSON.stringify({ notes: _notes, ts: Date.now() }));
    } catch {}
  } catch (e) {
    console.error('Vault load failed', e);
    if (list) list.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;font-size:12px;">Failed to load notes. Click Refresh to resync.</div>';
    _notes = [];
  }
}

// ── List View ────────────────────────────────────────────────

function _renderNoteList() {
  const list = document.getElementById('vault-note-list');
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

  list.innerHTML = filtered.map(n => {
    const dirtyCls = _dirtyNoteIds.has(n.id) ? ' vault-note-dirty' : '';
    return `
    <div class="vault-note-card ${n.id === _selectedNoteId ? 'selected' : ''}" data-id="${n.id}">
      <div class="vault-note-card-title${dirtyCls}">${_esc(n.title)}</div>
      <div class="vault-note-card-preview">${_esc(n.content?.slice(0, 120) || '')}</div>
      <div class="vault-note-card-meta">
        ${(n.tags || []).map(t => `<span class="vault-tag">${_esc(t)}</span>`).join('')}
        <span class="vault-note-date">${n.last_modified_src?.slice(0, 10) || ''}</span>
      </div>
    </div>
  `;
  }).join('');

  list.querySelectorAll('.vault-note-card').forEach(card => {
    card.addEventListener('click', (e) => _navigateToNote(card.dataset.id, true, e.ctrlKey || e.metaKey));
  });
}

let _previewMode = 'preview'; // 'preview' | 'live' | 'edit'
let _editModePref = 'live';   // 'live' | 'edit' — the edit mode used when toggling from preview
let _sourceModeEnabled = false; // when true, main toggle is Read/Source instead of Read/Live
let _autoRenameNoteId = null; // set when creating new note to auto-focus title

function _isCorruptCharObject(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const keys = Object.keys(obj);
  if (!keys.length) return false;
  return keys.every(k => /^\d+$/.test(k));
}

function _countWordsExcludingDatabases(content) {
  if (!content) return 0;
  const dbs = parseInlineDatabases(content);
  const dbLineSet = new Set();
  for (const db of dbs) {
    for (let i = db.markerLine; i < db.tableEnd; i++) dbLineSet.add(i);
  }
  const lines = content.split('\n');
  const filtered = lines.filter((_, idx) => !dbLineSet.has(idx));
  return filtered.join('\n').split(/\s+/).filter(Boolean).length;
}

function _serializeFrontmatter(fm) {
  // If frontmatter is a string or String object, it was corrupted; fall back to empty
  if (typeof fm === 'string' || fm instanceof String || _isCorruptCharObject(fm)) {
    fm = {};
  }
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

function _stripFrontmatterFromContent(content) {
  if (!content) return content;
  const lines = content.split('\n');
  let startIdx = 0;
  while (startIdx < lines.length && lines[startIdx].trim() === '') startIdx++;
  if (lines[startIdx]?.trim() === '---') {
    const endIdx = lines.findIndex((l, idx) => idx > startIdx && l.trim() === '---');
    if (endIdx > startIdx) {
      return lines.slice(endIdx + 1).join('\n').replace(/^\n+/, '');
    }
  }
  return content;
}

function _flushSourceEdit(sourceDiv, note, markDirty = true) {
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
  if (markDirty) _markNoteDirty(note.id);
}

const _getRawFromSource = (source) => {
  let raw = '';
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) {
      raw += node.textContent;
    } else if (node.tagName === 'BR') {
      raw += '\n';
    } else if (node.tagName === 'DIV' && node !== source) {
      raw += '\n';
    }
  }
  return raw;
};

function _flushActiveEditor(note, markDirty = true) {
  const preview = document.getElementById('vault-preview');
  if (!preview) return;
  const sourceDiv = preview.querySelector('.vault-source-view');
  if (sourceDiv) {
    _flushSourceEdit(sourceDiv, note, markDirty);
    return;
  }
  const liveDiv = preview.querySelector('.vault-live-view');
  if (liveDiv) {
    const rawLines = [];
    liveDiv.querySelectorAll('.lp-line, .vault-inline-db-placeholder, .vault-inline-database').forEach(el => {
      if (el.classList.contains('lp-line')) {
        const sourceEl = el.querySelector('.lp-source');
        rawLines.push(sourceEl ? _getRawFromSource(sourceEl) : (el.getAttribute('data-raw') || ''));
      } else {
        rawLines.push(el.getAttribute('data-raw') || '');
      }
    });
    note.content = rawLines.join('\n');
    if (markDirty) _markNoteDirty(note.id);
  }
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

function _updateDirtyIndicators() {
  // Tabs
  _renderNoteTabs();
  // Header title
  const headerTitle = document.querySelector('.vault-preview-header h1');
  if (headerTitle) {
    const isDirty = !!(_selectedNoteId && _dirtyNoteIds.has(_selectedNoteId));
    headerTitle.classList.toggle('vault-note-dirty', isDirty);
  }
  // Folder tree rows
  document.querySelectorAll('.vault-tree-row[data-note-id]').forEach(el => {
    const isDirty = !!(el.dataset.noteId && _dirtyNoteIds.has(el.dataset.noteId));
    el.classList.toggle('vault-note-dirty', isDirty);
  });
  // Note list cards
  document.querySelectorAll('.vault-note-card-title').forEach(el => {
    const card = el.closest('.vault-note-card');
    const noteId = card?.dataset.id;
    const isDirty = !!(noteId && _dirtyNoteIds.has(noteId));
    el.classList.toggle('vault-note-dirty', isDirty);
  });
}

function _cancelSaveTimer(noteId) {
  const timer = _saveTimers.get(noteId);
  if (timer) {
    clearTimeout(timer);
    _saveTimers.delete(noteId);
  }
}

function _markNoteDirty(noteId) {
  if (!noteId) return;
  const wasDirty = _dirtyNoteIds.has(noteId);
  _dirtyNoteIds.add(noteId);
  _saveFailures.delete(noteId);
  if (!wasDirty) _updateDirtyIndicators();
  _scheduleSave(noteId);
}

function _markNoteClean(noteId) {
  if (!noteId) return;
  const wasDirty = _dirtyNoteIds.has(noteId);
  _dirtyNoteIds.delete(noteId);
  _saveFailures.delete(noteId);
  _cancelSaveTimer(noteId);
  if (wasDirty) _updateDirtyIndicators();
}

function _scheduleSave(noteId) {
  _cancelSaveTimer(noteId);
  const mode = _vaultSettings.editor.autoSave;
  if (mode === 'off' || mode === 'onFocusChange' || mode === 'onWindowChange') return;
  const delay = Math.max(100, parseInt(_vaultSettings.editor.autoSaveDelay, 10) || 1000);
  const timer = setTimeout(() => {
    _saveTimers.delete(noteId);
    const note = _notes.find(n => n.id === noteId || n.rel_path === noteId);
    if (!note) return;
    if (_selectedNoteId === note.id || _selectedNoteId === note.rel_path) {
      _flushActiveEditor(note, false);
    }
    _saveNoteContent(note);
  }, delay);
  _saveTimers.set(noteId, timer);
}

async function _saveAllDirty(force = false) {
  const promises = [];
  for (const noteId of _dirtyNoteIds) {
    if (!force && _saveFailures.has(noteId)) continue;
    const note = _notes.find(n => n.id === noteId || n.rel_path === noteId);
    if (!note) continue;
    if (_selectedNoteId === note.id || _selectedNoteId === note.rel_path) {
      _flushActiveEditor(note, false);
    }
    promises.push(_saveNoteContent(note));
  }
  await Promise.all(promises);
}

async function _saveNoteContent(note) {
  if (_selectedNoteId === note.id || _selectedNoteId === note.rel_path) {
    _flushActiveEditor(note, false);
  }
  const serialized = _serializeFrontmatter(note.frontmatter || {});
  const fullContent = note.content ? serialized + '\n' + note.content : serialized;
  const wasFailed = _saveFailures.has(note.id);
  try {
    const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(note.id)}/edit`, {
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
      _markNoteClean(note.id);
      return true;
    } else {
      let errText = '';
      try { const d = await r.json(); errText = d.detail || JSON.stringify(d); } catch {}
      _saveFailures.add(note.id);
      if (!wasFailed) {
        setTimeout(() => {
          if (_dirtyNoteIds.has(note.id) && _saveFailures.has(note.id)) {
            _saveNoteContent(note);
          }
        }, 2000);
      } else {
        showToast('Failed to save note. Changes remain unsaved.');
      }
      return false;
    }
  } catch (e) {
    _saveFailures.add(note.id);
    if (!wasFailed) {
      setTimeout(() => {
        if (_dirtyNoteIds.has(note.id) && _saveFailures.has(note.id)) {
          _saveNoteContent(note);
        }
      }, 2000);
    } else {
      showToast('Failed to save note. Changes remain unsaved.');
    }
    return false;
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
  if (type === 'tags') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`;
  }
  if (type === 'list') {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
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

function _gatherPropertyTypes() {
  const typeMap = new Map();
  _notes.forEach(n => {
    const fm = n.frontmatter;
    if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return;
    Object.entries(fm).forEach(([k, v]) => {
      const t = _inferPropType(k, v);
      const existing = typeMap.get(k);
      if (!existing) {
        typeMap.set(k, { type: t, count: 1 });
      } else if (existing.type !== t) {
        // If types conflict, prefer 'text' as fallback
        existing.type = 'text';
        existing.count += 1;
      } else {
        existing.count += 1;
      }
    });
  });
  // Sort by most common first, then alphabetically
  return Array.from(typeMap.entries())
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([name, info]) => ({ name, type: info.type }));
}

function _buildTagChip(text, key) {
  const isTag = key.toLowerCase() === 'tags';
  return `<span class="vault-prop-chip${isTag ? ' is-tag' : ''}" data-chip="${_esc(text)}" data-prop-key="${_esc(key)}" spellcheck="false">
    <span class="vault-prop-chip-text">${_esc(text)}</span>
    <span class="vault-prop-chip-x" data-action="remove-chip" title="Remove">&times;</span>
  </span>`;
}

function _inferPropType(key, value) {
  if (key.toLowerCase() === 'tags') return 'tags';
  if (key.toLowerCase() === 'aliases') return 'aliases';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(String(value))) return 'datetime';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return 'date';
  if (/^https?:\/\//.test(String(value))) return 'url';
  return 'text';
}

function _parseFrontmatter(text) {
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
}

function _buildPropertiesHtml(frontmatter, note) {
  let fm = (frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)) ? frontmatter : {};
  // Detect and recover from frontmatter that was saved as a split string
  if (_isCorruptCharObject(fm)) fm = {};
  const entries = Object.entries(fm);
  const rows = entries.map(([k, v]) => {
    const propType = _inferPropType(k, v);
    const icon = _propIconSvg(k, v, propType);
    let valHtml;
    if (Array.isArray(v)) {
      const chips = v.map(item => _buildTagChip(String(item), k)).join('');
      valHtml = `<span class="vault-prop-val" data-prop-key="${_esc(k)}" data-type="array" data-prop-type="${propType}" spellcheck="false">${chips}<span class="vault-prop-chip-input" contenteditable="plaintext-only" spellcheck="false"></span></span>`;
    } else if (v && typeof v === 'object') {
      valHtml = `<span class="vault-prop-val" contenteditable="plaintext-only" spellcheck="false" data-prop-key="${_esc(k)}" data-prop-type="${propType}">${_esc(JSON.stringify(v))}</span>`;
    } else if (propType === 'url') {
      const url = String(v ?? '');
      valHtml = `<a class="vault-prop-val vault-prop-url" href="${_esc(url)}" target="_blank" rel="noopener noreferrer" data-prop-key="${_esc(k)}" data-prop-type="${propType}">${_esc(url)}</a>`;
    } else {
      valHtml = `<span class="vault-prop-val" contenteditable="plaintext-only" spellcheck="false" data-prop-key="${_esc(k)}" data-prop-type="${propType}">${_esc(String(v ?? ''))}</span>`;
    }
    return `<div class="vault-prop-row" data-prop-key="${_esc(k)}">
      <span class="vault-prop-icon" data-prop-key="${_esc(k)}" title="Property options">${icon}</span>
      <span class="vault-prop-key" spellcheck="false">${_esc(k)}</span>
      ${valHtml}
    </div>`;
  }).join('');
  const addBtn = note ? `<button class="vault-prop-add-main" data-add-prop spellcheck="false"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add property</button>` : '';
  const collapsedClass = _propsCollapsed ? 'collapsed' : '';
  return `<div class="vault-properties-inline ${collapsedClass}" data-properties-container><h4 class="vault-prop-header">Properties<span class="vault-prop-chevron"></span></h4><div class="vault-prop-grid">${rows || ''}</div>${addBtn}</div>`;
}

function _wireWikilinks(container) {
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
}

function _wireSourceWikilinks(container) {
  container.querySelectorAll('a.wikilink-source').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const targetTitle = a.dataset.note;
      const target = _notes.find(n => n.title && n.title.toLowerCase() === targetTitle.toLowerCase());
      if (target) {
        _navigateToNote(target.id, true, e.ctrlKey || e.metaKey);
      } else {
        const created = await _getOrCreateNoteByTitle(targetTitle);
        if (created) _navigateToNote(created.id, true, e.ctrlKey || e.metaKey);
      }
    });
  });
}

async function _selectNote(id) {
  // Flush any pending edits from the currently selected note before switching
  if (_selectedNoteId && _selectedNoteId !== id) {
    const current = _notes.find(n => n.id === _selectedNoteId || n.rel_path === _selectedNoteId);
    if (current) _flushActiveEditor(current, false);
  }
  _selectedNoteId = id;

  const preview = document.getElementById('vault-preview');
  if (!preview) return;

  try {
    // 1. Render from cache immediately for fast navigation
    let note = _noteContentCache.get(id);
    if (!note) {
      const cached = _notes.find(n => n.id === id || n.rel_path === id);
      if (cached) {
        note = { ...cached };
        note.content = _stripFrontmatterFromContent(note.content);
        _noteContentCache.set(id, note);
      }
    }
    // If nothing in cache, must fetch before rendering
    if (!note) {
      const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(id)}`);
      if (_selectedNoteId !== id) {
        return;
      }
      if (!r.ok) { preview.style.display = 'none'; return; }
      note = await r.json();
      if (_selectedNoteId !== id) {
        return;
      }
      note.content = _stripFrontmatterFromContent(note.content);
      _noteContentCache.set(id, note);
    }
    if (!note) { preview.style.display = 'none'; return; }

    // Load inline databases for this note in the background so note content
    // renders immediately even when switching rapidly.
    let _inlineDbPromise = null;
    if (!note._databases) {
      _inlineDbPromise = fetchInlineDatabases(id)
        .then(dbs => {
          note._databases = dbs;
          // If still the selected note, re-render inline databases with schema
          if (_selectedNoteId === id) {
            const bodyEl = preview.querySelector('.vault-preview-body');
            if (bodyEl) {
              const liveDiv = bodyEl.querySelector('.vault-live-view');
              const wrap = bodyEl.querySelector('.vault-reading-view');
              const container = liveDiv || wrap;
              if (container) {
                _renderInlineDatabases(container, id, dbs, note.content);
              }
            }
          }
          return dbs;
        })
        .catch(e => {
          console.warn('[vault] failed to load inline databases', e);
          note._databases = [];
          return [];
        });
    }

    // Server returns frontmatter as a raw YAML string; parse it into an object
    if (note && (typeof note.frontmatter === 'string' || note.frontmatter instanceof String)) {
      note.frontmatter = _parseFrontmatter(String(note.frontmatter));
    }
    // Recover from previously corrupted numeric-key objects
    if (note && _isCorruptCharObject(note.frontmatter)) {
      note.frontmatter = {};
    }
    preview.style.display = 'block';
    const isAutoRename = _autoRenameNoteId === note.id;
    const showTitle = _vaultSettings.appearance.showInlineTitle;
    const scTitle = _vaultSettings.editor.spellcheck ? 'true' : 'false';
    const titleDirty = _dirtyNoteIds.has(note.id) ? ' vault-note-dirty' : '';
    const headerHtml = showTitle
      ? `<div class="vault-preview-header">${isAutoRename
          ? `<span class="vault-title-edit${titleDirty}" contenteditable="plaintext-only" spellcheck="${scTitle}">${_esc(note.title)}</span>`
          : `<h1 class="${titleDirty.trim()}">${_esc(note.title)}</h1>`}</div>`
      : '';
    // In source mode, show raw YAML instead of property chips
    const showProps = _previewMode !== 'edit';
    preview.innerHTML = `
      ${headerHtml}
      ${showProps ? _buildPropertiesHtml(note.frontmatter, note) : ''}
      <div class="vault-preview-body"></div>
    `;

    // Wire inline title editing for all notes (click h1 to edit)
    const _wireTitleEdit = (el) => {
      const finishRename = async () => {
        const newName = el.textContent.trim();
        _autoRenameNoteId = null;
        if (newName && newName !== note.title) {
          await _doRenameNote(note.id, newName);
        } else {
          const h1 = document.createElement('h1');
          h1.textContent = note.title;
          el.replaceWith(h1);
          _wireTitleEdit(h1);
        }
      };
      el.addEventListener('blur', finishRename, { once: true });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        if (e.key === 'Escape') {
          _autoRenameNoteId = null;
          const h1 = document.createElement('h1');
          h1.textContent = note.title;
          el.replaceWith(h1);
          _wireTitleEdit(h1);
        }
      });
    };
    if (isAutoRename) {
      const titleEdit = preview.querySelector('.vault-title-edit');
      if (titleEdit) {
        titleEdit.focus();
        const range = document.createRange();
        range.selectNodeContents(titleEdit);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        _wireTitleEdit(titleEdit);
      }
    } else {
      const h1 = preview.querySelector('.vault-preview-header h1');
      if (h1) {
        h1.style.cursor = 'pointer';
        h1.title = 'Click to rename';
        h1.addEventListener('click', () => {
          const span = document.createElement('span');
          span.className = 'vault-title-edit';
          span.contentEditable = 'plaintext-only';
          span.spellcheck = _vaultSettings.editor.spellcheck;
          span.textContent = note.title;
          h1.replaceWith(span);
          span.focus();
          const range = document.createRange();
          range.selectNodeContents(span);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          _wireTitleEdit(span);
        });
      }
    }

    // Wire properties section collapse toggle
    preview.querySelectorAll('.vault-prop-header').forEach(header => {
      header.addEventListener('click', () => {
        _propsCollapsed = !_propsCollapsed;
        preview.querySelectorAll('.vault-properties-inline').forEach(el => {
          el.classList.toggle('collapsed', _propsCollapsed);
        });
      });
    });

    const bodyEl = preview.querySelector('.vault-preview-body');

    const _saveLivePreview = async () => {
      const blocks = bodyEl.querySelectorAll('.vault-live-block');
      const texts = [];
      blocks.forEach(b => {
        const ta = b.querySelector('.vault-live-block-edit');
        texts.push(ta ? ta.value : (b.dataset.blockRaw || ''));
      });
      note.content = texts.join('\n\n');
      await _saveNoteContent(note);
    };

    const _wireReadingViewFolds = (wrap) => {
      if (!wrap) return;
      const lines = wrap.querySelectorAll('.lp-line');
      // foldHeading
      if (_vaultSettings.editor.foldHeading) {
        lines.forEach(line => {
          const heading = line.querySelector('.md-h1, .md-h2, .md-h3, .md-h4, .md-h5, .md-h6');
          if (!heading) return;
          const hClass = Array.from(heading.classList).find(c => c.startsWith('md-h'));
          if (!hClass) return;
          const level = parseInt(hClass.replace('md-h', ''), 10);
          // Add fold toggle
          const toggle = document.createElement('span');
          toggle.className = 'vault-fold-toggle';
          toggle.textContent = '>';
          toggle.style.cssText = 'cursor:pointer;margin-right:6px;opacity:0.6;font-size:0.8em;user-select:none;';
          heading.insertBefore(toggle, heading.firstChild);
          toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isCollapsed = toggle.classList.toggle('collapsed');
            toggle.textContent = isCollapsed ? '>' : '>';
            // Hide/show subsequent lines until next heading of same or higher level (smaller h#)
            let next = line.nextElementSibling;
            while (next) {
              const nextHeading = next.querySelector('.md-h1, .md-h2, .md-h3, .md-h4, .md-h5, .md-h6');
              if (nextHeading) {
                const nhClass = Array.from(nextHeading.classList).find(c => c.startsWith('md-h'));
                const nhLevel = nhClass ? parseInt(nhClass.replace('md-h', ''), 10) : 7;
                if (nhLevel <= level) break;
              }
              next.style.display = isCollapsed ? 'none' : '';
              next = next.nextElementSibling;
            }
          });
        });
      }
      // foldIndent
      if (_vaultSettings.editor.foldIndent) {
        lines.forEach(line => {
          const liMarker = line.querySelector('.md-li-marker');
          if (!liMarker) return;
          // Determine indent level from the raw text
          const raw = line.getAttribute('data-raw') || '';
          const indentMatch = raw.match(/^(\s*)/);
          const indent = indentMatch ? indentMatch[1].length : 0;
          // Add fold toggle
          const toggle = document.createElement('span');
          toggle.className = 'vault-fold-toggle';
          toggle.textContent = '>';
          toggle.style.cssText = 'cursor:pointer;margin-right:4px;opacity:0.6;font-size:0.8em;user-select:none;';
          const source = line.querySelector('.lp-source');
          if (source) source.insertBefore(toggle, source.firstChild);
          toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isCollapsed = toggle.classList.toggle('collapsed');
            toggle.textContent = isCollapsed ? '>' : '>';
            let next = line.nextElementSibling;
            while (next) {
              const nextRaw = next.getAttribute('data-raw') || '';
              const nextIndentMatch = nextRaw.match(/^(\s*)/);
              const nextIndent = nextIndentMatch ? nextIndentMatch[1].length : 0;
              // Stop when we hit a line with equal or less indent (or empty line then equal indent)
              if (!nextRaw.trim()) {
                next = next.nextElementSibling;
                continue;
              }
              if (nextIndent <= indent) break;
              next.style.display = isCollapsed ? 'none' : '';
              next = next.nextElementSibling;
            }
          });
        });
      }
    };

    const _processInlineMarkers = (text) => {
      // Process paired inline markers with a stack so both closed and unclosed
      // syntax work. Longer markers are matched first. Unclosed markers format
      // the rest of the line; closed markers only format the enclosed region.
      const markerTypes = [
        { marker: '***', css: 'md-bold md-italic', syntax: '***' },
        { marker: '**', css: 'md-bold', syntax: '**' },
        { marker: '*', css: 'md-italic', syntax: '*' },
        { marker: '_', css: 'md-italic', syntax: '_' },
        { marker: '~~', css: 'md-strike', syntax: '~~' },
        { marker: '==', css: 'md-highlight', syntax: '==' },
        { marker: '`', css: 'md-code', syntax: '`' },
        { marker: '%%', css: 'md-comment', syntax: '%%' },
      ];
      const markerPattern = markerTypes.map(m => _escRegExp(m.marker)).join('|');
      const regex = new RegExp(`(${markerPattern})`, 'g');

      const tokens = [];
      let lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          tokens.push({ type: 'text', text: text.slice(lastIndex, match.index) });
        }
        const marker = match[1];
        const type = markerTypes.find(m => m.marker === marker);
        tokens.push({ type: 'marker', markerType: type });
        lastIndex = regex.lastIndex;
      }
      if (lastIndex < text.length) {
        tokens.push({ type: 'text', text: text.slice(lastIndex) });
      }

      const stack = [];
      const segments = [];
      let currentText = '';
      const flushText = () => {
        if (currentText) {
          segments.push({ type: 'text', text: currentText, markers: stack.map(t => t.markerType) });
          currentText = '';
        }
      };

      for (const token of tokens) {
        if (token.type === 'text') {
          currentText += token.text;
        } else {
          const mt = token.markerType;
          if (stack.length > 0 && stack[stack.length - 1].markerType === mt) {
            flushText();
            segments.push({ type: 'syntax', text: mt.syntax, markers: stack.map(t => t.markerType) });
            stack.pop();
          } else {
            flushText();
            stack.push(token);
            segments.push({ type: 'syntax', text: mt.syntax, markers: stack.map(t => t.markerType) });
          }
        }
      }
      flushText();

      let html = '';
      let openStack = [];
      for (const seg of segments) {
        const target = seg.markers;
        let commonPrefix = 0;
        while (commonPrefix < openStack.length && commonPrefix < target.length && openStack[commonPrefix] === target[commonPrefix]) {
          commonPrefix++;
        }
        while (openStack.length > commonPrefix) {
          html += '</span>';
          openStack.pop();
        }
        for (let i = commonPrefix; i < target.length; i++) {
          html += `<span class="${target[i].css}">`;
          openStack.push(target[i]);
        }
        if (seg.type === 'syntax') {
          html += `<span class="md-syntax">${seg.text}</span>`;
        } else {
          html += seg.text;
        }
      }
      while (openStack.length) {
        html += '</span>';
        openStack.pop();
      }
      return html;
    };

    const _renderInline = (text) => {
      let h = text;
      // Escaped chars \char
      h = h.replace(/\\([*_{}[\]()#+-.!|`~^=$])/g, '<span class="md-escaped"><span class="md-syntax">\\</span>$1</span>');
      // Inline markers: bold, italic, strike, highlight, code, comment
      h = _processInlineMarkers(h);
      // Wikilinks [[text]] (only fully closed links; unclosed [[ is plain text)
      h = h.replace(/\[\[([^\]]+)\]\]/g, (match, content) => {
        const pipeIdx = content.indexOf('|');
        const target = pipeIdx >= 0 ? content.slice(0, pipeIdx).trim() : content.trim();
        const display = pipeIdx >= 0 ? content.slice(pipeIdx + 1).trim() : target;
        return `<span class="md-wikilink"><span class="md-bracket">[[</span><a class="wikilink-source" href="#" data-note="${_esc(target)}">${_esc(display)}</a><span class="md-bracket">]]</span></span>`;
      });
      // Alternative wikilinks [/[/text]/] (only fully closed links)
      h = h.replace(/\[\/\[([^\]]+)\]\/\]/g, (match, content) => {
        const pipeIdx = content.indexOf('|');
        const target = pipeIdx >= 0 ? content.slice(0, pipeIdx).trim() : content.trim();
        const display = pipeIdx >= 0 ? content.slice(pipeIdx + 1).trim() : target;
        return `<span class="md-wikilink"><span class="md-bracket">[/[</span><a class="wikilink-source" href="#" data-note="${_esc(target)}">${_esc(display)}</a><span class="md-bracket">]/]</span></span>`;
      });
      // Images ![alt](url)
      h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<span class="md-image"><span class="md-syntax">!</span><span class="md-syntax">[</span><span class="md-image-alt">$1</span><span class="md-syntax">](</span><span class="md-image-url">$2</span><span class="md-syntax">)</span></span>');
      // Footnotes [^ref]
      h = h.replace(/\[\^([^\]]+)\]/g, '<span class="md-footnote"><span class="md-syntax">[^</span>$1<span class="md-syntax">]</span></span>');
      // Math inline $text$
      h = h.replace(/\$([^$\s][^$]*[^$\s])\$/g, '<span class="md-math"><span class="md-syntax">$</span>$1<span class="md-syntax">$</span></span>');
      // External links [text](url)
      h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
        const safeUrl = /^https?:\/\//i.test(url) ? _esc(url) : '#';
        const target = safeUrl !== '#' ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<span class="md-link"><span class="md-syntax">[</span><a class="md-link-text" href="${safeUrl}"${target}><span class="md-link-text-inner">${text}</span></a><span class="md-syntax">](</span><span class="md-link-url">${_esc(url)}</span><span class="md-syntax">)</span></span>`;
      });
      // Both closed and unclosed inline markers are handled by _processInlineMarkers.
      // Live preview Enter inserts \n; normalize to <br> so the break survives innerHTML.
      h = h.replace(/\n/g, '<br>');
      return h;
    };

    const _renderSourceLine = (line) => {
      let h = _esc(line);
      // Extract leading whitespace so indented blockquotes/lists work
      const leadingMatch = h.match(/^([\s\t]*)/);
      const leading = leadingMatch ? leadingMatch[1] : '';
      const trimmed = h.slice(leading.length);
      // Heading: ### Text (no leading ws)
      const hm = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (hm && !leading) {
        const lvl = hm[1].length;
        return `<span class="md-h${lvl}"><span class="md-hash">${hm[1]} </span>${_renderInline(hm[2])}</span>`;
      }
      // Horizontal rule ---
      if (/^---+$/.test(line.trim()) && !leading) return `<span class="md-hr">${h}</span>`;
      // Blockquote > Text (supports leading whitespace for indented blockquotes)
      const bqMatch = trimmed.match(/^&gt;\s?(.*)$/);
      if (bqMatch) {
        const bqContent = bqMatch[1];
        const calloutMatch = bqContent.match(/^\[!([A-Za-z]+)\]\s*(.*)$/);
        if (calloutMatch) {
          const type = calloutMatch[1].toLowerCase();
          const title = calloutMatch[2] || type.charAt(0).toUpperCase() + type.slice(1);
          const icons = { info: 'ℹ️', warning: '⚠️', danger: '⛔', tip: '💡', note: '📝', quote: '❝', example: '📋' };
          const icon = icons[type] || icons.note;
          return `${leading}<span class="md-callout md-callout-${type}"><span class="md-callout-icon">${icon}</span> <span class="md-callout-title">${_renderInline(title)}</span></span>`;
        }
        return `${leading}<span class="md-bq"><span class="md-bq-mark">&gt; </span>${_renderInline(bqContent)}</span>`;
      }
      // Indented code block (2+ tabs or 4+ spaces, but not a nested list item)
      const codeIndentMatch = line.match(/^(\t{2,}| {4,})(?![-*+]\s|\d+\.\s)(.*)$/);
      if (codeIndentMatch) {
        return `<span class="md-code-block">${codeIndentMatch[1]}${_esc(codeIndentMatch[2])}</span>`;
      }
      // List item
      const lm = h.match(/^(\s*)([-*+])\s+(.*)$/) || h.match(/^(\s*)(\d+\.)\s+(.*)$/);
      if (lm) {
        const content = lm[3];
        // Heading inside list item: - ### Text
        const headingMatch = content.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
          const lvl = headingMatch[1].length;
          return `${lm[1]}<span class="md-li-marker">${lm[2]} </span><span class="md-h${lvl}"><span class="md-hash">${headingMatch[1]} </span>${_renderInline(headingMatch[2])}</span>`;
        }
        const taskMatch = content.match(/^\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
          return `${lm[1]}<span class="md-li-marker">${lm[2]} </span><span class="md-task"><span class="md-task-check">[${taskMatch[1]}] </span>${_renderInline(taskMatch[2])}</span>`;
        }
        return `${lm[1]}<span class="md-li-marker">${lm[2]} </span>${_renderInline(content)}`;
      }
      // Default: inline formatting
      return _renderInline(h);
    };

    const _renderSourceView = (raw) => {
      if (!raw) return '<div class="lp-line" data-raw=""><div class="lp-source"><br></div></div>';
      const lines = raw.split('\n');
      // A leading --- ... --- block is frontmatter, not a horizontal rule; render it plain.
      let frontmatterEnd = -1;
      if (lines[0]?.trim() === '---') {
        frontmatterEnd = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
      }
      let inCodeBlock = false;
      const codeLines = [];
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i <= frontmatterEnd) {
          out.push(`<div class="lp-line vault-frontmatter-line" data-raw="${_esc(line)}"><div class="lp-source">${_esc(line)}</div></div>`);
          continue;
        }
        if (/^\s*```/.test(line)) {
          if (inCodeBlock) {
            codeLines.push(_esc(line));
            out.push(`<div class="lp-line" data-raw=""><div class="md-code-block">${codeLines.join('<br>')}</div></div>`);
            codeLines.length = 0;
            inCodeBlock = false;
          } else {
            inCodeBlock = true;
            codeLines.push(_esc(line));
          }
        } else if (inCodeBlock) {
          codeLines.push(_esc(line));
        } else {
          out.push(`<div class="lp-line" data-raw="${_esc(line)}"><div class="lp-source">${_renderSourceLine(line)}</div></div>`);
        }
      }
      if (inCodeBlock) {
        out.push(`<div class="lp-line" data-raw=""><div class="md-code-block">${codeLines.join('<br>')}</div></div>`);
      }
      return out.join('');
    };

    const _renderLiveView = (raw, databases = []) => {
      if (!raw) return '<div class="lp-line lp-empty" data-raw=""><div class="lp-source"><br></div></div>';
      // Safety net: if frontmatter somehow leaked into the content, strip it
      // before rendering so --- delimiters never show in the live view.
      let content = raw;
      const firstLines = raw.split('\n');
      let fmStart = 0;
      while (fmStart < firstLines.length && firstLines[fmStart].trim() === '') fmStart++;
      if (firstLines[fmStart]?.trim() === '---') {
        const endIdx = firstLines.findIndex((l, idx) => idx > fmStart && l.trim() === '---');
        if (endIdx > fmStart) {
          content = firstLines.slice(endIdx + 1).join('\n').replace(/^\n+/, '');
        }
      }
      const lines = content.split('\n');
      // Re-parse raw content for fresh line numbers — cached databases may have
      // stale line indices after edits, causing table syntax to leak through.
      const freshDbs = parseInlineDatabases(content);
      const dbLineSet = new Set();
      const dbByStart = new Map();
      for (const db of freshDbs) {
        for (let i = db.markerLine; i < db.tableEnd; i++) dbLineSet.add(i);
        dbByStart.set(db.markerLine, db);
      }
      let inCodeBlock = false;
      const codeLines = [];
      const out = [];
      const isReading = _previewMode === 'preview';
      const strictBreaks = _vaultSettings.editor.strictLineBreaks;
      const paragraphLines = [];

      const flushParagraph = () => {
        if (paragraphLines.length === 0) return;
        const mergedRaw = paragraphLines.join('\n');
        const mergedHtml = paragraphLines.map(l => _renderSourceLine(l)).join('<br>');
        out.push(`<div class="lp-line" data-raw="${_esc(mergedRaw)}"><div class="lp-source">${mergedHtml}</div></div>`);
        paragraphLines.length = 0;
      };

      const isBlockLine = (line) => {
        const t = line.trim();
        return /^#{1,6}\s/.test(t) ||
               /^&gt;\s/.test(_esc(t)) ||
               /^(\s*)([-*+]|\d+\.)\s/.test(t) ||
               /^---+$/.test(t);
      };

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        // Skip lines that belong to an inline database table; emit a placeholder at the marker
        if (dbLineSet.has(idx)) {
          flushParagraph();
          const db = dbByStart.get(idx);
          if (db) {
            const rawDbLines = lines.slice(db.markerLine, db.tableEnd).join('\n');
            out.push(`<div class="vault-inline-db-placeholder" data-marker="${_esc(db.marker)}" data-raw="${_esc(rawDbLines)}"></div>`);
          }
          continue;
        }
        if (/^\s*```/.test(line)) {
          flushParagraph();
          if (inCodeBlock) {
            codeLines.push(_esc(line));
            out.push(`<div class="lp-line" data-raw="${_esc(line)}"><div class="md-code-block">${codeLines.join('<br>')}</div></div>`);
            codeLines.length = 0;
            inCodeBlock = false;
          } else {
            inCodeBlock = true;
            codeLines.push(_esc(line));
          }
        } else if (inCodeBlock) {
          codeLines.push(_esc(line));
        } else if (isReading && !strictBreaks && !line.trim()) {
          // Empty line in reading view with strictLineBreaks=false
          flushParagraph();
          out.push(`<div class="lp-line lp-empty" data-raw=""><div class="lp-source"><br></div></div>`);
        } else if (isReading && !strictBreaks && isBlockLine(line)) {
          // Block element in reading view with strictLineBreaks=false
          flushParagraph();
          out.push(`<div class="lp-line" data-raw="${_esc(line)}"><div class="lp-source">${_renderSourceLine(line)}</div></div>`);
        } else if (isReading && !strictBreaks) {
          // Regular paragraph line
          paragraphLines.push(line);
        } else {
          // Default: line-by-line (live preview or strict line breaks)
          const emptyClass = !line.trim() ? ' lp-empty' : '';
          out.push(`<div class="lp-line${emptyClass}" data-raw="${_esc(line)}"><div class="lp-source">${_renderSourceLine(line)}</div></div>`);
        }
      }
      flushParagraph();
      if (inCodeBlock) {
        out.push(`<div class="lp-line" data-raw=""><div class="md-code-block">${codeLines.join('<br>')}</div></div>`);
      }
      return out.join('');
    };

const _getRawOffsetUpTo = (root, endNode, endOffset) => {
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) {
      if (node === endNode) return offset + Math.min(endOffset, node.textContent.length);
      offset += node.textContent.length;
    } else if (node.tagName === 'BR' || (node.tagName === 'DIV' && node !== root)) {
      if (node === endNode) return offset + (endOffset > 0 ? 1 : 0);
      offset += 1;
    }
  }
  return offset;
};

const _normalizeRange = (range) => {
  let node = range.startContainer;
  let offset = range.startOffset;
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (offset < node.childNodes.length) {
      const child = node.childNodes[offset];
      if (child.nodeType === Node.TEXT_NODE) return { node: child, offset: 0 };
      if (child.tagName === 'BR') return { node: child, offset: 0 };
    }
    if (offset > 0) {
      const prev = node.childNodes[offset - 1];
      if (prev && prev.nodeType === Node.TEXT_NODE) return { node: prev, offset: prev.textContent.length };
      if (prev && prev.tagName === 'BR') return { node: prev, offset: 1 };
    }
  }
  return { node, offset };
};

    const updateBody = () => {
      if (_previewMode === 'edit') {
        // Source mode: styled text div, contentEditable, clickable wikilinks
        const raw = _getNoteFullRaw(note);
        const lineNumClass = _vaultSettings.editor.showLineNumbers ? 'vault-show-line-numbers' : '';
        const sc = _vaultSettings.editor.spellcheck ? 'true' : 'false';
        const dir = _vaultSettings.editor.rtl ? 'rtl' : 'ltr';
        bodyEl.innerHTML = `<div class="vault-body-wrap" dir="${dir}"><div class="vault-source-view ${lineNumClass}" contenteditable="true" spellcheck="${sc}">${_renderSourceView(raw)}</div></div>`;
        const sourceDiv = bodyEl.querySelector('.vault-source-view');
        _wireSourceWikilinks(sourceDiv);
        _attachVaultSlashMenu(sourceDiv);
        sourceDiv.focus();
        sourceDiv.addEventListener('click', (e) => {
          if (e.target !== sourceDiv) return;
          // Clicked in the blank space below the rendered content; move caret to end
          const lastLine = sourceDiv.querySelector('.lp-line:last-child');
          if (!lastLine) return;
          const walker = document.createTreeWalker(lastLine, NodeFilter.SHOW_TEXT);
          let lastNode = null;
          while (walker.nextNode()) lastNode = walker.currentNode;
          if (!lastNode) return;
          const range = document.createRange();
          range.setStart(lastNode, lastNode.textContent.length);
          range.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        });
        sourceDiv.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            document.execCommand('insertText', false, '\n');
            return;
          }
          // Tab: indent current paragraph (consecutive non-empty non-block lines)
          if (e.key === 'Tab') {
            e.preventDefault();
            const indent = _vaultSettings.editor.indentWithTabs ? '\t' : '  ';
            const sel = window.getSelection();
            if (!sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            let activeNode = range.startContainer;
            while (activeNode && activeNode !== sourceDiv) {
              if (activeNode.nodeType === Node.ELEMENT_NODE && activeNode.classList.contains('lp-line')) break;
              activeNode = activeNode.parentNode;
            }
            if (!activeNode || !activeNode.classList.contains('lp-line')) return;

            // Determine paragraph boundaries: empty lines or block-level lines separate paragraphs
            const _isBlockOrEmpty = (lineEl) => {
              const raw = lineEl.getAttribute('data-raw') || '';
              const t = raw.trim();
              if (!t) return true;
              return /^#{1,6}\s/.test(t) ||
                     /^&gt;\s/.test(_esc(t)) ||
                     /^(\s*)([-*+]|\d+\.)\s/.test(t) ||
                     /^---+$/.test(t) ||
                     /^\s*```/.test(t);
            };

            // Collect all lines in this paragraph
            const paragraphLines = [activeNode];
            let prev = activeNode.previousElementSibling;
            while (prev && prev.classList.contains('lp-line') && !_isBlockOrEmpty(prev)) {
              paragraphLines.unshift(prev);
              prev = prev.previousElementSibling;
            }
            let next = activeNode.nextElementSibling;
            while (next && next.classList.contains('lp-line') && !_isBlockOrEmpty(next)) {
              paragraphLines.push(next);
              next = next.nextElementSibling;
            }
            // Save undo state once before re-rendering
            if (!sourceDiv.__undoStack) sourceDiv.__undoStack = [];
            if (sourceDiv.__undoStack.length === 0 || sourceDiv.__undoStack[sourceDiv.__undoStack.length - 1] !== sourceDiv.innerText) {
              sourceDiv.__undoStack.push(sourceDiv.innerText);
              sourceDiv.__redoStack = [];
            }

            // Indent every line in the paragraph
            for (const lineEl of paragraphLines) {
              const sourceEl = lineEl.querySelector('.lp-source');
              if (!sourceEl) continue;
              const raw = _getRawFromSource(sourceEl);
              const newRaw = indent + raw;
              sourceEl.innerHTML = _renderSourceLine(newRaw);
              _wireSourceWikilinks(sourceEl);
              lineEl.setAttribute('data-raw', newRaw);
            }

            // Restore cursor in the active line at previous offset + indent length
            const activeSource = activeNode.querySelector('.lp-source');
            if (activeSource) {
              let prevOffset = 0;
              const sel2 = window.getSelection();
              if (sel2.rangeCount) {
                const range2 = sel2.getRangeAt(0);
                const norm2 = _normalizeRange(range2);
                prevOffset = _getRawOffsetUpTo(activeSource, norm2.node, norm2.offset);
              }
              const targetOffset = prevOffset + indent.length;
              const walker = document.createTreeWalker(activeSource, NodeFilter.SHOW_TEXT);
              let curr = 0; let lastNode = null;
              while (walker.nextNode()) {
                const n = walker.currentNode;
                lastNode = n;
                if (curr + n.textContent.length >= targetOffset) {
                  const r = document.createRange();
                  r.setStart(n, Math.max(0, targetOffset - curr));
                  r.collapse(true);
                  sel.removeAllRanges(); sel.addRange(r);
                  return;
                }
                curr += n.textContent.length;
              }
              if (lastNode) {
                const r = document.createRange();
                r.setStart(lastNode, lastNode.textContent.length);
                r.collapse(true);
                sel.removeAllRanges(); sel.addRange(r);
              }
            }
            return;
          }

          // Backspace: if inside leading whitespace, remove whole indent unit
          if (e.key === 'Backspace') {
            const sel = window.getSelection();
            if (!sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            let activeNode = range.startContainer;
            while (activeNode && activeNode !== sourceDiv) {
              if (activeNode.nodeType === Node.ELEMENT_NODE && activeNode.classList.contains('lp-line')) break;
              activeNode = activeNode.parentNode;
            }
            if (!activeNode || !activeNode.classList.contains('lp-line')) return;
            const sourceEl = activeNode.querySelector('.lp-source');
            if (!sourceEl) return;
            const norm = _normalizeRange(range);
            const offset = _getRawOffsetUpTo(sourceEl, norm.node, norm.offset);
            const raw = _getRawFromSource(sourceEl);
            const indent = _vaultSettings.editor.indentWithTabs ? '\t' : '  ';
            const indentLen = indent.length;
            const leadingMatch = raw.match(/^(\s*)/);
            const leadingLen = leadingMatch ? leadingMatch[1].length : 0;
            if (offset > 0 && offset <= leadingLen) {
              e.preventDefault();
              let stripped;
              let removedLen = 0;
              if (raw.startsWith('\t')) {
                stripped = raw.substring(1);
                removedLen = 1;
              } else {
                const spaceMatch = raw.match(new RegExp('^ {1,' + indentLen + '}'));
                if (spaceMatch) {
                  stripped = raw.substring(spaceMatch[0].length);
                  removedLen = spaceMatch[0].length;
                } else {
                  stripped = raw.replace(/^ /, '');
                  removedLen = 1;
                }
              }
              sourceEl.innerHTML = _renderSourceLine(stripped);
              _wireSourceWikilinks(sourceEl);
              activeNode.setAttribute('data-raw', stripped);
              // Restore cursor
              let curr = 0; let lastNode = null;
              const targetOffset = Math.max(0, offset - removedLen);
              const walker = document.createTreeWalker(sourceEl, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const n = walker.currentNode;
                lastNode = n;
                if (curr + n.textContent.length >= targetOffset) {
                  const r = document.createRange();
                  r.setStart(n, Math.max(0, targetOffset - curr));
                  r.collapse(true);
                  sel.removeAllRanges(); sel.addRange(r);
                  return;
                }
                curr += n.textContent.length;
              }
              if (lastNode) {
                const r = document.createRange();
                r.setStart(lastNode, lastNode.textContent.length);
                r.collapse(true);
                sel.removeAllRanges(); sel.addRange(r);
              }
              return;
            }
          }

          // Undo / Redo
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            const stack = sourceDiv.__undoStack || [];
            const redoStack = sourceDiv.__redoStack || [];
            if (e.shiftKey) {
              // Redo
              if (redoStack.length > 0) {
                const text = redoStack.pop();
                stack.push(sourceDiv.innerText);
                sourceDiv.innerText = text;
                sourceDiv.innerHTML = _renderSourceView(text);
                _wireSourceWikilinks(sourceDiv);
                sourceDiv.__undoStack = stack;
                sourceDiv.__redoStack = redoStack;
              }
            } else {
              // Undo
              if (stack.length > 1) {
                const current = stack.pop();
                redoStack.push(current);
                const previous = stack[stack.length - 1];
                sourceDiv.innerText = previous;
                sourceDiv.innerHTML = _renderSourceView(previous);
                _wireSourceWikilinks(sourceDiv);
                sourceDiv.__undoStack = stack;
                sourceDiv.__redoStack = redoStack;
              }
            }
            return;
          }
        });
        let _sourceRenderTimer = null;
        sourceDiv.addEventListener('input', () => {
          _markNoteDirty(note.id);
          clearTimeout(_sourceRenderTimer);
          _sourceRenderTimer = setTimeout(() => {
            // Save undo state before re-render
            const currentText = sourceDiv.innerText;
            if (!sourceDiv.__undoStack) sourceDiv.__undoStack = [];
            if (sourceDiv.__undoStack.length === 0 || sourceDiv.__undoStack[sourceDiv.__undoStack.length - 1] !== currentText) {
              sourceDiv.__undoStack.push(currentText);
              if (sourceDiv.__undoStack.length > 50) sourceDiv.__undoStack.shift();
              sourceDiv.__redoStack = [];
            }
            const sel = window.getSelection();
            let offset = 0;
            if (sel.rangeCount) {
              const range = sel.getRangeAt(0);
              const norm = _normalizeRange(range);
              offset = _getRawOffsetUpTo(sourceDiv, norm.node, norm.offset);
            }
            const raw = sourceDiv.innerText;
            sourceDiv.innerHTML = _renderSourceView(raw);
            _wireSourceWikilinks(sourceDiv);
            // Restore cursor (handles <br> and past-end offsets)
            let curr = 0;
            let lastNode = null;
            const walker = document.createTreeWalker(sourceDiv, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (node.nodeType === Node.TEXT_NODE) {
                const len = node.textContent.length;
                lastNode = node;
                if (curr + len >= offset) {
                  const r = document.createRange();
                  r.setStart(node, Math.max(0, offset - curr));
                  r.collapse(true);
                  sel.removeAllRanges();
                  sel.addRange(r);
                  return;
                }
                curr += len;
              } else if (node.tagName === 'BR') {
                if (curr + 1 >= offset) {
                  const r = document.createRange();
                  r.setStartAfter(node);
                  r.collapse(true);
                  sel.removeAllRanges();
                  sel.addRange(r);
                  return;
                }
                curr += 1;
              }
            }
            if (lastNode) {
              const r = document.createRange();
              r.setStart(lastNode, lastNode.textContent.length);
              r.collapse(true);
              sel.removeAllRanges();
              sel.addRange(r);
            }
          }, 100);
        });
        sourceDiv.addEventListener('blur', async (e) => {
          // If focus moved to the slash command menu, don't flush yet; the
          // command will insert text and then re-focus the editor.
          if (e.relatedTarget?.closest('[data-slash-menu]')) {
            return;
          }
          clearTimeout(_sourceRenderTimer);
          _flushSourceEdit(sourceDiv, note);
          if (_vaultSettings.editor.autoSave === 'onFocusChange') {
            await _saveAllDirty();
          }
          // Don't re-render here; _selectNote on mode switch handles that.
          // Re-rendering on every blur would steal focus back from external clicks.
        });
      } else if (_previewMode === 'live') {
        // Live Preview: token-level inline editing — syntax hidden by default,
        // revealed only for the token(s) containing the cursor.
        const content = note.content || '';
        const dir = _vaultSettings.editor.rtl ? 'rtl' : 'ltr';
        bodyEl.innerHTML = `<div class="vault-body-wrap" dir="${dir}"><div class="vault-live-view">${_renderLiveView(content, note._databases || [])}</div></div>`;
        const liveDiv = bodyEl.querySelector('.vault-live-view');
        _wireSourceWikilinks(liveDiv);
        _attachVaultSlashMenu(liveDiv);
        try { _renderInlineDatabases(liveDiv, note.id, note._databases || [], note.content); } catch (e) { console.error('[vault] inline DB render failed', e); }

        let activeLine = null;
        let _caretTimer = null;

        const TOKEN_CLASSES = new Set([
          'md-h1','md-h2','md-h3','md-h4','md-h5','md-h6',
          'md-bq','md-bold','md-italic','md-strike','md-code',
          'md-wikilink','md-link','md-hr','md-li-marker',
          'md-highlight','md-footnote','md-comment','md-math',
          'md-image','md-task','md-escaped'
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

          // 1. Walk up from cursor to find the nearest token-span ancestor
          let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
          while (el && !el.classList?.contains('lp-source')) {
            if (_isTokenSpan(el)) {
              _activateToken(el);
              return;
            }
            el = el.parentElement;
          }

          // 2. Boundary fallback: caret at exact text-node edge between tokens
          if (node.nodeType === Node.TEXT_NODE) {
            const offset = range.startOffset;
            const textLen = node.textContent.length;

            if (offset === 0) {
              let prev = node.previousElementSibling;
              let curr = node;
              while (!prev && curr.parentElement && !curr.parentElement.classList?.contains('lp-source')) {
                prev = curr.parentElement.previousElementSibling;
                curr = curr.parentElement;
              }
              if (prev && _isTokenSpan(prev)) _activateToken(prev);
            }
            if (offset === textLen) {
              let next = node.nextElementSibling;
              let curr = node;
              while (!next && curr.parentElement && !curr.parentElement.classList?.contains('lp-source')) {
                next = curr.parentElement.nextElementSibling;
                curr = curr.parentElement;
              }
              if (next && _isTokenSpan(next)) _activateToken(next);
            }
          }
        };


        const _deactivateLine = (line) => {
          if (!line) return;
          _clearActiveTokens(line);
          const source = line.querySelector('.lp-source');
          if (!source) return;
          const raw = _getRawFromSource(source);
          line.setAttribute('data-raw', raw);
          source.innerHTML = _renderSourceLine(raw);
          _wireSourceWikilinks(source);
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
          if (!source) return;
          source.setAttribute('contenteditable', 'true');
          source.setAttribute('spellcheck', _vaultSettings.editor.spellcheck ? 'true' : 'false');
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
          // Don't activate line when clicking a wikilink or inside an inline database
          if (e.target.closest('a.wikilink-source')) return;
          if (e.target.closest('.vault-inline-database')) return;
          // External links: in live preview, activate the line for editing
          // instead of navigating away. In reading view they open normally.
          const extLink = e.target.closest('a.md-link-text');
          if (extLink) { e.preventDefault(); }
          const line = e.target.closest('.lp-line');
          if (!line) {
            // Clicking in blank space below the content: focus the last line
            const lastLine = liveDiv.querySelector('.lp-line:last-child');
            if (lastLine) {
              const source = lastLine.querySelector('.lp-source');
              if (source) _activateLine(lastLine);
            }
            return;
          }
          const source = line.querySelector('.lp-source');
          if (!source) return; // code blocks have no source layer
          _activateLine(line, e.clientX, e.clientY);
        });

        // Track caret position on keyup, input, and mouseup (within liveDiv only)
        const _onCaretChange = () => {
          clearTimeout(_caretTimer);
          _caretTimer = setTimeout(() => _trackCaret(), 10);
        };
        liveDiv.addEventListener('keyup', _onCaretChange);
        liveDiv.addEventListener('input', _onCaretChange);
        liveDiv.addEventListener('mouseup', _onCaretChange);

        // Debounced re-render of the active source line so syntax highlighting
        // catches up while typing (e.g., [[...]] wikilinks).
        let _renderLineTimer = null;
        const _setCursorOffset = (source, offset) => {
          const sel = window.getSelection();
          const range = document.createRange();
          let currentOffset = 0;
          const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
          let lastNode = null;
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (node.nodeType === Node.TEXT_NODE) {
              const len = node.textContent.length;
              lastNode = node;
              if (currentOffset + len >= offset) {
                range.setStart(node, Math.max(0, offset - currentOffset));
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
                return;
              }
              currentOffset += len;
            } else if (node.tagName === 'BR') {
              if (currentOffset + 1 >= offset) {
                range.setStartAfter(node);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
                return;
              }
              currentOffset += 1;
            }
          }
          // Offset past all content: place at end of last node or after last child
          if (lastNode) {
            range.setStart(lastNode, lastNode.textContent.length);
          } else {
            const lastChild = source.lastChild;
            if (lastChild) range.setStartAfter(lastChild);
            else range.setStart(source, 0);
          }
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          // Ensure the source stays focused; replacing innerHTML can blur it.
          source.focus();
        };
        const _debouncedRenderLine = () => {
          clearTimeout(_renderLineTimer);
          _renderLineTimer = setTimeout(() => {
            if (!activeLine) return;
            const source = activeLine.querySelector('.lp-source');
            if (!source) return;
            // Save undo state before re-render
            const currentRaw = _getRawFromSource(source);
            if (!activeLine.__undoStack) activeLine.__undoStack = [];
            if (activeLine.__undoStack.length === 0 || activeLine.__undoStack[activeLine.__undoStack.length - 1] !== currentRaw) {
              activeLine.__undoStack.push(currentRaw);
              if (activeLine.__undoStack.length > 50) activeLine.__undoStack.shift();
              activeLine.__redoStack = [];
            }
            activeLine.setAttribute('data-raw', currentRaw);
            // Multi-line block inserts (e.g. slash-command database/table) span
            // multiple lines in a single lp-line. Detect them and do a full
            // body re-render so _renderLiveView can emit proper placeholders.
            const isBlockInsert = currentRaw.includes('\n') && (
              currentRaw.includes('<!-- database:') ||
              currentRaw.includes('| --- |') ||
              currentRaw.includes('```') ||
              currentRaw.includes('> [!')
            );
            if (isBlockInsert) {
              const rawLines = [];
              liveDiv.querySelectorAll('.lp-line, .vault-inline-db-placeholder, .vault-inline-database').forEach(el => {
                if (el.classList.contains('lp-line')) {
                  const sourceEl = el.querySelector('.lp-source');
                  rawLines.push(sourceEl ? _getRawFromSource(sourceEl) : (el.getAttribute('data-raw') || ''));
                } else {
                  rawLines.push(el.getAttribute('data-raw') || '');
                }
              });
              const newContent = rawLines.join('\n');
              if (newContent !== note.content) {
                note.content = newContent;
                _markNoteDirty(note.id);
              }
              updateBody();
              return;
            }
            // Don't re-render the line while the slash command menu is open:
            // re-rendering would replace the text node that stores the slash.
            const slashMenuOpen = !!document.querySelector('[data-slash-menu]');
            if (!slashMenuOpen) {
              // Save cursor offset (counts <br> as \n so Enter stays on new line)
              let offset = 0;
              const sel = window.getSelection();
              if (sel.rangeCount) {
                const range = sel.getRangeAt(0);
                const norm = _normalizeRange(range);
                offset = _getRawOffsetUpTo(source, norm.node, norm.offset);
              }
              source.innerHTML = _renderSourceLine(currentRaw);
              _wireSourceWikilinks(source);
              _setCursorOffset(source, offset);
              _trackCaret();
              _updateWikiSuggest(source);
            }
            // Keep the in-memory note content in sync with the DOM so the
            // auto-save scheduler never writes stale data.
            const rawLines = [];
            liveDiv.querySelectorAll('.lp-line, .vault-inline-db-placeholder, .vault-inline-database').forEach(el => {
              rawLines.push(el.getAttribute('data-raw') || '');
            });
            const newContent = rawLines.join('\n');
            if (newContent !== note.content) {
              note.content = newContent;
              _markNoteDirty(note.id);
            }
          }, 50);
        };
        liveDiv.addEventListener('input', _debouncedRenderLine);

        const finishEdit = () => {
          _hideWikiSuggest();
          document.removeEventListener('click', _hideSuggestOnClick);
          liveDiv.removeEventListener('keyup', _onCaretChange);
          liveDiv.removeEventListener('input', _onCaretChange);
          liveDiv.removeEventListener('mouseup', _onCaretChange);
          liveDiv.removeEventListener('input', _debouncedRenderLine);
          if (activeLine) {
            _deactivateLine(activeLine);
            activeLine = null;
          }
          // Collect raw text from all lines
          const rawLines = [];
          const allLines = liveDiv.querySelectorAll('.lp-line');
          allLines.forEach(line => {
            const raw = line.getAttribute('data-raw') || '';
            rawLines.push(raw);
          });
          const newContent = rawLines.join('\n');
          note.content = newContent;
          _markNoteDirty(note.id);
          // Do NOT call _selectNote here. If the user has already switched to
          // another note, re-selecting this note would overwrite the current UI.
          // The saved content will be rendered the next time this note is selected.
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
          let rect = range.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) {
            const rects = range.getClientRects();
            if (rects.length > 0) {
              rect = rects[0];
            } else {
              // Fallback: insert a temporary zero-width space to measure
              const marker = document.createElement('span');
              marker.textContent = '\u200b';
              marker.style.position = 'absolute';
              marker.style.opacity = '0';
              try {
                range.insertNode(marker);
                rect = marker.getBoundingClientRect();
                marker.remove();
                sel.removeAllRanges();
                sel.addRange(range);
              } catch (_) { return null; }
            }
          }
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

        const _highlightSuggest = (text, query) => {
          const q = query.toLowerCase();
          const t = text.toLowerCase();
          let idx = t.indexOf(q);
          if (idx === -1) return _esc(text);
          const before = text.slice(0, idx);
          const match = text.slice(idx, idx + query.length);
          const after = text.slice(idx + query.length);
          return `${_esc(before)}<mark style="background:transparent;color:var(--accent,var(--red,#4a9eff));font-weight:600;">${_esc(match)}</mark>${_esc(after)}`;
        };

        const _showWikiSuggest = (source, query) => {
          _hideWikiSuggest();
          const coords = _getCursorCoords();
          if (!coords) return;
          const q = query.toLowerCase();
          const titles = [...new Set(_notes.map(n => n.title))];
          const startsWith = titles.filter(t => t.toLowerCase().startsWith(q));
          const wordBoundary = titles.filter(t => {
            const lower = t.toLowerCase();
            return !startsWith.includes(t) && new RegExp('\\b' + _escRegExp(q)).test(lower);
          });
          const substring = titles.filter(t => {
            const lower = t.toLowerCase();
            return !startsWith.includes(t) && !wordBoundary.includes(t) && lower.includes(q);
          });
          const matches = [...startsWith, ...wordBoundary, ...substring].slice(0, 12);
          if (!matches.length) return;
          const el = document.createElement('div');
          el.className = 'vault-wiki-suggest';
          el.innerHTML = matches.map((t, i) =>
            `<div class="vault-wiki-suggest-item${i === 0 ? ' selected' : ''}" data-title="${_esc(t)}">${_highlightSuggest(t, query)}</div>`
          ).join('');
          el.style.position = 'fixed';
          el.style.zIndex = '99999';
          let left = coords.x;
          let top = coords.y;
          const estWidth = 200;
          const estHeight = 220;
          if (left + estWidth > window.innerWidth) left = Math.max(4, window.innerWidth - estWidth - 8);
          // Prefer placing below cursor; if no room, flip above cursor line
          if (top + estHeight > window.innerHeight) {
            const above = coords.y - estHeight - 8;
            top = above > 4 ? above : Math.max(4, window.innerHeight - estHeight - 8);
          }
          el.style.left = left + 'px';
          el.style.top = top + 'px';
          el.style.minWidth = '180px';
          document.body.appendChild(el);
          _wikiSuggestEl = el;
          _wikiSuggestIndex = 0;
          el.querySelectorAll('.vault-wiki-suggest-item').forEach(item => {
            item.addEventListener('click', () => {
              _insertWikiLink(source, item.dataset.title);
              _hideWikiSuggest();
            });
          });
        };

        const _insertWikiLink = (source, title) => {
          const textBefore = _getTextBeforeCursor(source);
          let openIdx = textBefore.lastIndexOf('[/[');
          let isAlt = true;
          if (openIdx === -1) { openIdx = textBefore.lastIndexOf('[['); isAlt = false; }
          if (openIdx === -1) return;

          const useWiki = _vaultSettings.filesAndLinks.useWikilinks;
          const format = _vaultSettings.filesAndLinks.linkFormat;
          const closeBrackets = isAlt ? ']/]' : ']]';

          const fullText = _getRawFromSource(source);
          const textAfterCursor = fullText.slice(textBefore.length);
          const alreadyClosed = textAfterCursor.startsWith(closeBrackets);

          // Compute link path based on format
          const targetNote = _notes.find(n => n.title && n.title.toLowerCase() === title.toLowerCase());
          const currentNote = _notes.find(n => n.id === _selectedNoteId);
          const targetFolder = targetNote ? (targetNote.folder || '') : '';
          const currentFolder = currentNote ? (currentNote.folder || '') : '';

          let linkPath = title;
          if (format !== 'shortest' && targetNote) {
            if (format === 'absolute') {
              linkPath = targetFolder ? `${targetFolder}/${title}` : title;
            } else if (format === 'relative') {
              if (currentFolder === targetFolder) {
                linkPath = title;
              } else if (targetFolder.startsWith(currentFolder + '/')) {
                linkPath = targetFolder.slice(currentFolder.length + 1) + '/' + title;
              } else {
                linkPath = targetFolder ? `${targetFolder}/${title}` : title;
              }
            }
          }

          const beforeLink = fullText.slice(0, openIdx);
          const afterLink = alreadyClosed ? fullText.slice(textBefore.length + closeBrackets.length)
                                            : fullText.slice(textBefore.length);

          let newRaw, cursorPos;
          if (useWiki) {
            if (linkPath === title) {
              newRaw = beforeLink + '[[' + title + ']]' + afterLink;
              cursorPos = beforeLink.length + 2 + title.length + 2;
            } else {
              newRaw = beforeLink + '[[' + linkPath + '|' + title + ']]' + afterLink;
              cursorPos = beforeLink.length + 2 + linkPath.length + 1 + title.length + 2;
            }
          } else {
            let mdPath = linkPath;
            if (targetNote) {
              mdPath = targetFolder ? `${targetFolder}/${title}.md` : `${title}.md`;
            }
            newRaw = beforeLink + '[' + title + '](' + mdPath + ')' + afterLink;
            cursorPos = beforeLink.length + 1 + title.length + 2 + mdPath.length + 1;
          }

          if (activeLine) activeLine.setAttribute('data-raw', newRaw);
          source.innerHTML = _renderSourceLine(newRaw);
          _wireSourceWikilinks(source);
          _setCursorOffset(source, cursorPos);
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

          // Enter: insert literal newline (smart list continuation when enabled)
          if (e.key === 'Enter' && activeLine) {
            e.preventDefault();
            const lineText = activeLine.dataset.raw || '';
            let insert = '\n';
            if (_vaultSettings.editor.smartLists) {
              const listMatch = lineText.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
              if (listMatch) {
                const [, indent, marker, content] = listMatch;
                if (content.trim() === '') {
                  // Empty list item: remove marker on current line by replacing whole line
                  const source = activeLine.querySelector('.lp-source');
                  if (source) {
                    source.textContent = indent;
                    // Move cursor to end of indent
                    const sel = window.getSelection();
                    const r = document.createRange();
                    r.setStart(source.firstChild || source, indent.length);
                    r.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(r);
                  }
                  insert = '\n';
                } else {
                  let nextMarker = marker;
                  if (/^\d+\./.test(marker)) {
                    const num = parseInt(marker, 10);
                    nextMarker = `${num + 1}.`;
                  }
                  insert = `\n${indent}${nextMarker} `;
                }
              }
            }
            document.execCommand('insertText', false, insert);
            return;
          }

          // Tab: indent entire paragraph (all consecutive non-empty non-block lp-line siblings)
          if (e.key === 'Tab' && activeLine) {
            e.preventDefault();
            const indent = _vaultSettings.editor.indentWithTabs ? '\t' : '  ';
            const liveDiv = activeLine.closest('.vault-live-view');

            const _isBlockOrEmpty = (lineEl) => {
              const raw = lineEl.getAttribute('data-raw') || '';
              const t = raw.trim();
              if (!t) return true;
              return /^#{1,6}\s/.test(t) ||
                     /^&gt;\s/.test(_esc(t)) ||
                     /^(\s*)([-*+]|\d+\.)\s/.test(t) ||
                     /^---+$/.test(t) ||
                     /^\s*```/.test(t);
            };

            // Collect all lines in this paragraph
            const paragraphLines = [activeLine];
            let prev = activeLine.previousElementSibling;
            while (prev && prev.classList.contains('lp-line') && !_isBlockOrEmpty(prev)) {
              paragraphLines.unshift(prev);
              prev = prev.previousElementSibling;
            }
            let next = activeLine.nextElementSibling;
            while (next && next.classList.contains('lp-line') && !_isBlockOrEmpty(next)) {
              paragraphLines.push(next);
              next = next.nextElementSibling;
            }

            // Save cursor offset before indent so we can restore it after
            const sel = window.getSelection();
            let prevOffset = 0;
            const activeSource = activeLine.querySelector('.lp-source');
            if (activeSource && sel.rangeCount) {
              const range = sel.getRangeAt(0);
              const norm = _normalizeRange(range);
              prevOffset = _getRawOffsetUpTo(activeSource, norm.node, norm.offset);
            }

            // Indent every line in the paragraph
            for (const lineEl of paragraphLines) {
              const source = lineEl.querySelector('.lp-source');
              if (!source) continue;
              const raw = _getRawFromSource(source);
              const newRaw = indent + raw;
              // Save undo state before re-render
              if (!lineEl.__undoStack) lineEl.__undoStack = [];
              if (lineEl.__undoStack.length === 0 || lineEl.__undoStack[lineEl.__undoStack.length - 1] !== raw) {
                lineEl.__undoStack.push(raw);
                lineEl.__redoStack = [];
              }
              source.innerHTML = _renderSourceLine(newRaw);
              lineEl.setAttribute('data-raw', newRaw);
              _wireSourceWikilinks(source);
            }

            // Restore cursor in the active line
            if (activeSource) {
              _setCursorOffset(activeSource, prevOffset + indent.length);
              _trackCaret();
            }
            return;
          }

          // Backspace: if inside leading whitespace, remove whole indent unit
          if (e.key === 'Backspace' && activeLine) {
            const source = activeLine.querySelector('.lp-source');
            if (!source) return;
            const sel = window.getSelection();
            if (!sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            const norm = _normalizeRange(range);
            const offset = _getRawOffsetUpTo(source, norm.node, norm.offset);
            const raw = _getRawFromSource(source);
            const indent = _vaultSettings.editor.indentWithTabs ? '\t' : '  ';
            const indentLen = indent.length;
            // Leading whitespace length
            const leadingMatch = raw.match(/^(\s*)/);
            const leadingLen = leadingMatch ? leadingMatch[1].length : 0;
            if (offset > 0 && offset <= leadingLen) {
              e.preventDefault();
              let stripped;
              let removedLen = 0;
              if (raw.startsWith('\t')) {
                stripped = raw.substring(1);
                removedLen = 1;
              } else {
                const spaceMatch = raw.match(new RegExp('^ {1,' + indentLen + '}'));
                if (spaceMatch) {
                  stripped = raw.substring(spaceMatch[0].length);
                  removedLen = spaceMatch[0].length;
                } else {
                  stripped = raw.replace(/^ /, '');
                  removedLen = 1;
                }
              }
              source.innerHTML = _renderSourceLine(stripped);
              activeLine.setAttribute('data-raw', stripped);
              _wireSourceWikilinks(source);
              _setCursorOffset(source, Math.max(0, offset - removedLen));
              _trackCaret();
              return;
            }
          }

          // Undo / Redo
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            const source = activeLine?.querySelector('.lp-source');
            if (!source) return;
            const stack = activeLine.__undoStack || [];
            const redoStack = activeLine.__redoStack || [];
            if (e.shiftKey) {
              // Redo
              if (redoStack.length > 0) {
                const raw = redoStack.pop();
                const currentRaw = _getRawFromSource(source);
                if (currentRaw !== raw) {
                  stack.push(currentRaw);
                  source.innerHTML = _renderSourceLine(raw);
                  activeLine.setAttribute('data-raw', raw);
                  _wireSourceWikilinks(source);
                  _setCursorOffset(source, raw.length);
                }
              }
            } else {
              // Undo
              if (stack.length > 1) {
                const current = stack.pop();
                const previous = stack[stack.length - 1];
                if (current !== previous) {
                  redoStack.push(current);
                  source.innerHTML = _renderSourceLine(previous);
                  activeLine.setAttribute('data-raw', previous);
                  _wireSourceWikilinks(source);
                  _setCursorOffset(source, previous.length);
                }
              }
            }
            activeLine.__undoStack = stack;
            activeLine.__redoStack = redoStack;
            return;
          }

          // Bracket auto-close
          if (e.key === '[' && _vaultSettings.editor.autoPairBrackets) {
            e.preventDefault();
            const sel = window.getSelection();
            if (!sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            const prev = _getCharBeforeCursor();
            const next = _getCharAfterCursor();
            if (_vaultSettings.editor.autoPairMarkdown && _vaultSettings.filesAndLinks.useWikilinks && prev === '[') {
              // Turn existing [] or [/ into [[...]]
              const r = range.cloneRange();
              if (next === ']' && r.endContainer.nodeType === Node.TEXT_NODE && r.endOffset < r.endContainer.textContent.length) {
                r.setEnd(r.endContainer, r.endOffset + 1);
                r.deleteContents();
              }
              const insert = document.createTextNode('[]]');
              r.insertNode(insert);
              const nr = document.createRange();
              nr.setStart(insert, 1);
              nr.collapse(true);
              sel.removeAllRanges();
              sel.addRange(nr);
            } else if (_vaultSettings.editor.autoPairMarkdown && _vaultSettings.filesAndLinks.useWikilinks && _getTextBeforeCursor(source).endsWith('[/')) {
              const insert = document.createTextNode('[]/]');
              range.insertNode(insert);
              const nr = document.createRange();
              nr.setStart(insert, 1);
              nr.collapse(true);
              sel.removeAllRanges();
              sel.addRange(nr);
            } else {
              const insert = document.createTextNode('[]');
              range.insertNode(insert);
              const nr = document.createRange();
              nr.setStart(insert, 1);
              nr.collapse(true);
              sel.removeAllRanges();
              sel.addRange(nr);
            }
            if (_vaultSettings.editor.autoPairMarkdown) _updateWikiSuggest(source);
            return;
          }

          // Close-bracket: if we are inside [[...]], just insert ] and close suggest
          if (e.key === ']') {
            const textBefore = _getTextBeforeCursor(source);
            const lastOpen = Math.max(textBefore.lastIndexOf('[/['), textBefore.lastIndexOf('[['));
            if (lastOpen !== -1) {
              const isAlt = textBefore.lastIndexOf('[/[') > textBefore.lastIndexOf('[[');
              const prefixLen = isAlt ? 3 : 2;
              const afterOpen = textBefore.slice(lastOpen + prefixLen);
              const closeIdx = afterOpen.indexOf(isAlt ? ']/]' : ']]');
              if (closeIdx === -1) {
                // Inside an open wikilink: let the browser insert ], then close dropdown
                setTimeout(() => _hideWikiSuggest(), 0);
                return; // let default ] happen
              }
            }
          }

          // Wikilink suggestion navigation
          if (_wikiSuggestEl) {
            const items = _wikiSuggestEl.querySelectorAll('.vault-wiki-suggest-item');
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
              // Only insert selected item if user explicitly clicked it or used Tab
              _hideWikiSuggest();
              return;
            }
            if (e.key === 'Tab') {
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
          if (_wikiSuggestEl && !e.target.closest('.vault-wiki-suggest')) {
            _hideWikiSuggest();
          }
        };
        document.addEventListener('click', _hideSuggestOnClick);

        liveDiv.addEventListener('blur', async (e) => {
          if (e.target.classList.contains('lp-source')) {
            // If focus is moving into the slash command menu, keep the line
            // active so the command can replace the slash/query.
            if (e.relatedTarget?.closest('[data-slash-menu]')) {
              return;
            }
            const line = e.target.closest('.lp-line');
            _deactivateLine(line);
            activeLine = null;
            // Save only when focus truly leaves the editor (not switching lines)
            if (!liveDiv.contains(e.relatedTarget)) {
              finishEdit();
              if (_vaultSettings.editor.autoSave === 'onFocusChange') {
                await _saveAllDirty();
              }
            }
          }
        }, true);
        // After a full rebuild (e.g. database delete), restore focus so the
        // user can keep typing without an extra click.
        setTimeout(() => {
          if (document.activeElement && document.activeElement.closest('.vault-live-view')) return;
          const firstLine = liveDiv.querySelector('.lp-line');
          if (firstLine) _activateLine(firstLine);
        }, 0);
      } else {
        // Reading mode: use live preview HTML without editing interactions
        const content = note.content || '';
        const dir = _vaultSettings.editor.rtl ? 'rtl' : 'ltr';
        bodyEl.innerHTML = `<div class="vault-body-wrap" dir="${dir}"><div class="vault-reading-view">${_renderLiveView(content, note._databases || [])}</div></div>`;
        const wrap = bodyEl.querySelector('.vault-reading-view');
        _wireSourceWikilinks(wrap);
        _wireReadingViewFolds(wrap);
        try { _renderInlineDatabases(wrap, note.id, note._databases || [], note.content); } catch (e) { console.error('[vault] inline DB render failed', e); }
      }
      // Right-click context menu in the note editor body
      bodyEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.vault-context-menu') || e.target.closest('.vault-context-menu-submenu')) return;
        _showNoteEditorContextMenu(e);
      });
    };
    updateBody();
    if (_inlineDbPromise) {
      _inlineDbPromise.then(() => {
        if (_selectedNoteId !== id) return;
        if (!bodyEl || !document.contains(bodyEl)) return;
        updateBody();
      });
    }
    let wcEl = document.getElementById('vault-word-count');
    if (!wcEl) { wcEl = document.createElement('div'); wcEl.id = 'vault-word-count'; wcEl.className = 'vault-word-count'; }
    const panelWrap = preview?.parentElement;
    if (panelWrap && wcEl.parentElement !== panelWrap) panelWrap.appendChild(wcEl);
    const wordCount = _countWordsExcludingDatabases(note.content || '');
    wcEl.textContent = `${wordCount} words`;
    _updateModeButtons();
    const backBtn = document.getElementById('vault-back-btn');
    const forwardBtn = document.getElementById('vault-forward-btn');
    if (backBtn) backBtn.style.display = '';
    if (forwardBtn) forwardBtn.style.display = '';
    const viewModes = document.getElementById('vault-view-modes');
    if (viewModes) {
      viewModes.style.display = 'flex';
      viewModes.querySelectorAll('.vault-mode-btn').forEach(btn => {
        btn.onclick = async () => {
          const mode = btn.dataset.viewMode;
          if (_previewMode === 'edit' && mode !== 'edit') {
            const sourceDiv = bodyEl.querySelector('.vault-source-view');
            if (sourceDiv) await _flushSourceEdit(sourceDiv, note);
          }
          if (mode === 'live' || mode === 'edit') {
            _editModePref = mode;
          }
          _previewMode = mode;
          _updateModeButtons();
          _selectNote(note.id);
        };
      });
    }

    // Wire note menu dropdown
    const menuBtn = document.getElementById('vault-note-menu-btn');
    const menuDropdown = document.getElementById('vault-note-menu-dropdown');
    if (menuBtn && menuDropdown) {
      menuBtn.style.display = 'flex';
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        const isHidden = menuDropdown.classList.contains('hidden');
        document.querySelectorAll('.vault-note-menu-dropdown').forEach(d => d.classList.add('hidden'));
        if (isHidden) {
          menuDropdown.classList.remove('hidden');
          const sourceItem = menuDropdown.querySelector('[data-action="source"]');
          if (sourceItem) sourceItem.classList.toggle('is-checked', _sourceModeEnabled);
        }
      };
      menuDropdown.querySelectorAll('.vault-note-menu-item:not(.vault-note-menu-disabled)').forEach(item => {
        item.onclick = (e) => {
          e.stopPropagation();
          const action = item.dataset.action;
          if (action === 'preview') {
            _previewMode = 'preview';
            _updateModeButtons();
            _selectNote(note.id);
          } else if (action === 'live') {
            _editModePref = 'live';
            _previewMode = 'live';
            _updateModeButtons();
            _selectNote(note.id);
          } else if (action === 'source') {
            _sourceModeEnabled = !_sourceModeEnabled;
            _editModePref = _sourceModeEnabled ? 'edit' : 'live';
            _previewMode = _sourceModeEnabled ? 'edit' : 'live';
            _updateModeButtons();
            _selectNote(note.id);
          } else if (action === 'rename') {
            _promptRenameNote(note.id);
          } else if (action === 'delete') {
            _deleteNote(note.id);
          }
          menuDropdown.classList.add('hidden');
        };
      });
      // Close menu on outside click
      document.addEventListener('click', () => menuDropdown.classList.add('hidden'));
    }

    // Wire all property editors
    _wirePropertyEditors(preview, note);

    _renderRightSidebar(note);

    // Background: fetch fresh content to detect external edits & resolve backlinks
    const _originalContent = note.content;
    // Skip if this note ID was renamed and no longer exists client-side
    const stillExists = _notes.some(n => n.id === id || n.rel_path === id);
    if (!stillExists) return;
    // Optimistic notes have not been persisted yet; fetching now would 404
    if (note._optimistic) return;
    fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(id)}`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(full => {
        if (!full) return;
        full.content = _stripFrontmatterFromContent(full.content);
        _noteContentCache.set(id, full);
        if (_selectedNoteId !== full.id && _selectedNoteId !== full.rel_path) return;
        _renderRightSidebar(full);
        // Only silently refresh if user hasn't locally edited since we started the fetch,
        // and we're not in edit mode (to avoid stealing focus).
        const hasActiveLiveEditor = preview.querySelector('.lp-source[contenteditable="true"]');
        const userEditedSinceFetch = note.content !== _originalContent;
        if (!hasActiveLiveEditor && !userEditedSinceFetch && _previewMode !== 'edit' && full.content !== note.content) {
          if (bodyEl && !document.contains(bodyEl)) {
            return;
          }
          note.content = _stripFrontmatterFromContent(full.content);
          note.title = full.title;
          if (typeof full.frontmatter === 'string' || full.frontmatter instanceof String) {
            note.frontmatter = _parseFrontmatter(String(full.frontmatter));
          } else if (_isCorruptCharObject(full.frontmatter)) {
            note.frontmatter = {};
          } else {
            note.frontmatter = full.frontmatter;
          }
          updateBody();
          _applyMonospaceFont();
          // Refresh header title if it changed
          const h1 = preview.querySelector('.vault-preview-header h1');
          if (h1 && h1.textContent !== note.title) h1.textContent = note.title;
          const titleEdit = preview.querySelector('.vault-title-edit');
          if (titleEdit && titleEdit.textContent !== note.title) titleEdit.textContent = note.title;
          // Refresh word count
          const wcEl = document.getElementById('vault-word-count');
          if (wcEl) wcEl.textContent = `${_countWordsExcludingDatabases(note.content || '')} words`;
        }
      })
      .catch(() => {});

    // Re-apply monospace font to newly created editor/view elements
    _applyMonospaceFont();
  } catch (e) {
    console.error('[vault] _selectNote failed', e);
    // Don't hide the preview — keep whatever rendered so the error is visible in console.
  }
}

function _closeAllPropMenus() {
  document.querySelectorAll('.vault-prop-menu').forEach(m => m.remove());
  document.querySelectorAll('.vault-prop-submenu').forEach(m => m.remove());
  document.querySelectorAll('.vault-prop-add-dropdown').forEach(m => m.remove());
}

function _openPropIconMenu(icon, key, preview, note) {
  _closeAllPropMenus();
  const menu = document.createElement('div');
  menu.className = 'vault-prop-menu';
  menu.style.position = 'fixed';
  menu.style.zIndex = '99999';
  menu.innerHTML = `
    <div class="vault-prop-menu-item" data-action="type">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      Property type
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:0.5"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
    <div class="vault-prop-menu-divider"></div>
    <div class="vault-prop-menu-item" data-action="cut">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
      Cut
    </div>
    <div class="vault-prop-menu-item" data-action="copy">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      Copy
    </div>
    <div class="vault-prop-menu-item" data-action="paste">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
      Paste
    </div>
    <div class="vault-prop-menu-divider"></div>
    <div class="vault-prop-menu-item danger" data-action="remove">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      Remove
    </div>
  `;
  const rect = icon.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';
  document.body.appendChild(menu);
  console.log('[vault] prop menu created at', rect.left, rect.bottom, 'menu:', menu);

  // Type submenu
  const typeItem = menu.querySelector('[data-action="type"]');
  if (typeItem) {
    typeItem.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.vault-prop-submenu').forEach(m => m.remove());
      const sub = document.createElement('div');
      sub.className = 'vault-prop-submenu';
      sub.style.position = 'fixed';
      sub.style.zIndex = '99999';
      const currentType = _inferPropType(key, note.frontmatter?.[key]);
      const types = ['Text', 'List', 'Number', 'Checkbox', 'Date', 'Date & time', 'Aliases', 'Tags'];
      sub.innerHTML = types.map(t => {
        const typeKey = t.toLowerCase().replace(/ & /g, '');
        const icon = _propTypeIconSvg(typeKey);
        const isActive = typeKey === currentType;
        return `<div class="vault-prop-submenu-item${isActive ? ' active' : ''}" data-type="${_esc(typeKey)}">${icon}<span>${_esc(t)}</span></div>`;
      }).join('');
      const tRect = typeItem.getBoundingClientRect();
      let subLeft = tRect.right + 4;
      const subWidth = 170; // approximate submenu width
      if (subLeft + subWidth > window.innerWidth) {
        subLeft = Math.max(4, tRect.left - subWidth - 4);
      }
      sub.style.left = subLeft + 'px';
      sub.style.top = tRect.top + 'px';
      document.body.appendChild(sub);
      sub.querySelectorAll('.vault-prop-submenu-item').forEach(it => {
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
          const propsEl = preview.querySelector('.vault-properties-inline');
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
    const propsEl = preview.querySelector('.vault-properties-inline');
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
    const propsEl = preview.querySelector('.vault-properties-inline');
    if (propsEl) { propsEl.outerHTML = _buildPropertiesHtml(note.frontmatter, note); _wirePropertyEditors(preview, note); }
  });
  menu.querySelector('[data-action="paste"]')?.addEventListener('click', async () => {
    try {
      const txt = await navigator.clipboard.readText();
      note.frontmatter = note.frontmatter || {};
      note.frontmatter[key] = txt;
      await _saveNoteContent(note);
      _closeAllPropMenus();
      const propsEl = preview.querySelector('.vault-properties-inline');
      if (propsEl) { propsEl.outerHTML = _buildPropertiesHtml(note.frontmatter, note); _wirePropertyEditors(preview, note); }
    } catch {}
  });

  const closeMenu = (ev) => { if (!menu.contains(ev.target) && !icon.contains(ev.target)) { _closeAllPropMenus(); document.removeEventListener('click', closeMenu); } };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

function _rerenderProps(preview, note) {
  const propsEl = preview.querySelector('.vault-properties-inline');
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
    dropdown.className = 'vault-tag-dropdown';
    dropdown.style.zIndex = '99999';
    const rect = input.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = (rect.bottom + 4) + 'px';

    const filterLower = (filter || '').toLowerCase();
    dropdown.innerHTML = matches.map((t, i) => {
      const label = _highlightMatch(t, filterLower);
      return `<div class="vault-tag-dropdown-item" data-index="${i}" data-tag="${_esc(t)}"><span>${label}</span></div>`;
    }).join('');
    document.body.appendChild(dropdown);

    dropdown.querySelectorAll('.vault-tag-dropdown-item').forEach(item => {
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
    const items = dropdown?.querySelectorAll('.vault-tag-dropdown-item');
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
  preview.querySelectorAll('.vault-prop-val[contenteditable]:not([data-type="array"])').forEach(el => {
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
  preview.querySelectorAll('.vault-prop-val[data-type="array"]').forEach(container => {
    const key = container.dataset.propKey;
    const arr = note.frontmatter?.[key] || [];

    // Chip X removal
    container.querySelectorAll('.vault-prop-chip-x').forEach(x => {
      x.addEventListener('click', async (e) => {
        e.stopPropagation();
        const chipText = x.closest('.vault-prop-chip')?.dataset?.chip;
        if (!chipText) return;
        note.frontmatter = note.frontmatter || {};
        note.frontmatter[key] = arr.filter(item => String(item) !== chipText);
        await _saveNoteContent(note);
        _rerenderProps(preview, note);
      });
    });

    // Double-click chip text to edit
    container.querySelectorAll('.vault-prop-chip-text').forEach(txt => {
      txt.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const chip = txt.closest('.vault-prop-chip');
        if (!chip) return;
        const oldText = chip.dataset.chip;
        const input = document.createElement('span');
        input.className = 'vault-prop-chip-input';
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

    // Click anywhere in the value box to focus the inline input
    container.addEventListener('click', (e) => {
      if (e.target.closest('.vault-prop-chip')) return; // ignore chip clicks
      const inlineInput = container.querySelector('.vault-prop-chip-input');
      if (inlineInput) { inlineInput.focus(); }
    });

    // Inline input for adding new chips — only show tag autocomplete for the tags property
    const inlineInput = container.querySelector('.vault-prop-chip-input');
    if (inlineInput && key.toLowerCase() === 'tags') {
      _wireTagAutocomplete(inlineInput, key, note, preview);
    }
  });

  // --- Property icon menus ---
  preview.querySelectorAll('.vault-prop-icon').forEach(icon => {
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log('[vault] prop icon clicked:', icon.dataset.propKey);
      _openPropIconMenu(icon, icon.dataset.propKey, preview, note);
    });
  });

  // --- Add Property button ---
  const addBtn = preview.querySelector('[data-add-prop]');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log('[vault] Add property clicked');
      _closeAllPropMenus();
      const dropdown = document.createElement('div');
      dropdown.className = 'vault-prop-add-dropdown';
      dropdown.style.position = 'fixed';
      const existingKeys = new Set(Object.keys(note.frontmatter || {}));
      const knownProps = _gatherPropertyTypes();
      const commonAvailable = _COMMON_PROPERTIES.filter(p => !existingKeys.has(p));
      // Merge known props with common props, deduplicated, excluding existing
      const seen = new Set(existingKeys);
      const allOptions = [];
      knownProps.forEach(p => {
        if (!seen.has(p.name)) {
          seen.add(p.name);
          allOptions.push(p);
        }
      });
      commonAvailable.forEach(name => {
        if (!seen.has(name)) {
          seen.add(name);
          const inferred = _inferPropType(name, '');
          allOptions.push({ name, type: inferred });
        }
      });
      const options = allOptions.map(p => {
        const icon = _propIconSvg(p.name, '', p.type);
        const label = p.type.charAt(0).toUpperCase() + p.type.slice(1);
        return `<div class="vault-prop-add-option" data-prop="${_esc(p.name)}" data-type="${_esc(p.type)}">${icon}<span class="vault-prop-add-name">${_esc(p.name)}</span><span class="vault-prop-add-type">${label}</span></div>`;
      }).join('');
      dropdown.innerHTML = `${options}<div class="vault-prop-add-option" data-prop="__custom"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span class="vault-prop-add-name">New property</span></div>`;
      const rect = addBtn.getBoundingClientRect();
      dropdown.style.left = rect.left + 'px';
      dropdown.style.top = (rect.bottom + 4) + 'px';
      document.body.appendChild(dropdown);
      dropdown.querySelectorAll('.vault-prop-add-option').forEach(opt => {
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
              const propType = opt.dataset.type || _inferPropType(propName, '');
              if (propType === 'tags' || propType === 'list') note.frontmatter[propName] = [];
              else if (propType === 'checkbox') note.frontmatter[propName] = false;
              else if (propType === 'number') note.frontmatter[propName] = 0;
              else if (propType === 'date') note.frontmatter[propName] = new Date().toISOString().slice(0, 10);
              else if (propType === 'datetime') note.frontmatter[propName] = new Date().toISOString().slice(0, 16);
              else note.frontmatter[propName] = '';
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
  _renderAllPanels(note);
  // Update word-count plugin when active note changes
  const wc = _pluginManager?.getInstance('word-count');
  if (wc && typeof wc.update === 'function') wc.update();
}

function _renderBacklinksPane(note) {
  const bl = document.getElementById('vault-backlinks-panel');
  if (!bl || !note) return;
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
      ${links.length ? `<button class="vault-backlinks-toggle" title="Toggle all" style="background:transparent;border:none;color:var(--fg);opacity:0.5;cursor:pointer;padding:2px 4px;font-size:11px;display:flex;align-items:center;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
      </button>` : ''}
    </div>
  `;
  const listHtml = links.length ? links.map((b, idx) => {
    const snippetCount = (b.snippets || []).length;
    const isExpanded = allExpanded || bl.dataset['item' + idx] === 'open';
    return `<div class="vault-backlink-item" data-idx="${idx}">
      <div class="vault-backlink-header" data-id="${_esc(b.rel_path || b.id)}" style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:3px 0;font-size:12px;">
        <span class="vault-backlink-chevron" style="display:inline-flex;transition:transform 0.15s;transform:rotate(${isExpanded ? '90deg' : '0deg'});">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(b.title)}</span>
        <span style="opacity:0.5;font-size:11px;flex-shrink:0;">${snippetCount}</span>
      </div>
      <div class="vault-backlink-body" style="display:${isExpanded ? 'block' : 'none'};padding:4px 0 8px 18px;font-size:12px;opacity:0.8;line-height:1.5;">
        ${(b.snippets || []).map(s => `<div class="vault-backlink-snippet" style="margin-bottom:6px;padding:6px 8px;background:color-mix(in srgb, var(--fg) 4%, transparent);border-radius:6px;cursor:pointer;">${_highlightBacklinkSnippet(s, targetNames)}</div>`).join('')}
      </div>
    </div>`;
  }).join('') : `<div class="vault-backlink-item">
    <div class="vault-backlink-header" style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;opacity:0.5;">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">No backlinks</span>
    </div>
  </div>`;
  bl.innerHTML = headerHtml + listHtml;
  bl.querySelector('.vault-backlinks-toggle')?.addEventListener('click', function () {
    const willExpand = bl.dataset.expanded !== 'all';
    bl.dataset.expanded = willExpand ? 'all' : '';
    this.classList.toggle('active', willExpand);
    bl.querySelectorAll('.vault-backlink-item').forEach(item => {
      const idx = item.dataset.idx;
      const body = item.querySelector('.vault-backlink-body');
      const chevron = item.querySelector('.vault-backlink-chevron');
      if (body) body.style.display = willExpand ? 'block' : 'none';
      if (chevron) chevron.style.transform = willExpand ? 'rotate(90deg)' : 'rotate(0deg)';
      if (idx !== undefined) bl.dataset['item' + idx] = willExpand ? 'open' : '';
    });
  });
  bl.querySelectorAll('.vault-backlink-header').forEach(hdr => {
    hdr.addEventListener('click', (e) => {
      if (e.target.closest('.vault-backlink-snippet')) return;
      const item = hdr.closest('.vault-backlink-item');
      const body = item?.querySelector('.vault-backlink-body');
      const chevron = hdr.querySelector('.vault-backlink-chevron');
      const idx = item?.dataset.idx;
      if (!body) return;
      const isOpen = body.style.display === 'block';
      body.style.display = isOpen ? 'none' : 'block';
      if (chevron) chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
      if (idx !== undefined) bl.dataset['item' + idx] = isOpen ? '' : 'open';
    });
  });
  bl.querySelectorAll('.vault-backlink-snippet').forEach(snip => {
    snip.addEventListener('click', (e) => {
      const hdr = snip.closest('.vault-backlink-item')?.querySelector('.vault-backlink-header');
      if (hdr) _navigateToNote(hdr.dataset.id, true, e.ctrlKey || e.metaKey);
    });
  });
}

function _renderOutgoingPane(note) {
  const out = document.getElementById('vault-outgoing-panel');
  if (!out || !note) return;
  const links = note.outbound_links || [];
  out.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Outgoing (${links.length})</h4>` +
    (links.length ? links.map(t => {
      const target = _notes.find(n => n.title === t);
      return `<div class="vault-sidebar-link ${target ? '' : 'ghost'}" data-title="${_esc(t)}">${_esc(t)}</div>`;
    }).join('') : '<div style="opacity:0.5;font-size:11px;">No outgoing links</div>');
  out.querySelectorAll('.vault-sidebar-link').forEach(el => {
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
  const tags = document.getElementById('vault-tags-panel');
  if (!tags) return;
  const t = note.tags || [];
  tags.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Tags</h4>` +
    (t.length ? t.map(tag => `<span class="vault-tag" style="cursor:pointer;">${_esc(tag)}</span>`).join(' ') : '<div style="opacity:0.5;font-size:11px;">No tags</div>');
}

function _renderUnlinkedPane(note) {
  const el = document.getElementById('vault-unlinked-panel');
  if (!el || !note) return;
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
      `<div class="vault-sidebar-link" data-note-id="${_esc(m.note.id)}" style="font-size:12px;padding:3px 0;cursor:pointer;">
        <div style="font-weight:500;">${_esc(m.note.title)}</div>
        <div style="opacity:0.6;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(m.snippet)}</div>
      </div>`
    ).join('') : '<div style="opacity:0.5;font-size:11px;">No unlinked mentions</div>');
  el.querySelectorAll('[data-note-id]').forEach(item => {
    item.addEventListener('click', () => _navigateToNote(item.dataset.noteId));
  });
}

function _renderOutlinePane(note) {
  const el = document.getElementById('vault-outline-panel');
  if (!el || !note) return;
  const content = note.content || '';
  const headings = [];
  const regex = /^(#{1,6})\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    headings.push({ level: match[1].length, text: match[2].trim() });
  }
  el.innerHTML = `<h4 style="font-size:11px;opacity:0.6;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Outline</h4>` +
    (headings.length ? headings.map((h, i) =>
      `<div class="vault-outline-item" data-idx="${i}" style="font-size:12px;padding:3px 0 3px ${(h.level - 1) * 12}px;cursor:pointer;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${_esc(h.text)}
      </div>`
    ).join('') : '<div style="opacity:0.5;font-size:11px;">No headings</div>');
  el.querySelectorAll('.vault-outline-item').forEach(item => {
    item.addEventListener('click', () => {
      // Scroll to heading in preview
      const preview = document.getElementById('vault-preview');
      if (!preview) return;
      const hTags = ['H1','H2','H3','H4','H5','H6'];
      const headingEls = preview.querySelectorAll(hTags.join(','));
      const idx = parseInt(item.dataset.idx, 10);
      if (headingEls[idx]) headingEls[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function _renderOrphansPane(note) {
  const el = document.getElementById('vault-orphans-panel');
  if (!el || !note) return;
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
      `<div class="vault-sidebar-link" data-orphan-target="${_esc(o.target)}" style="font-size:12px;padding:3px 0;cursor:pointer;">${_esc(o.display)}</div>`
    ).join('') : '<div style="opacity:0.5;font-size:11px;">No orphan links in this file</div>');
  el.querySelectorAll('[data-orphan-target]').forEach(item => {
    item.addEventListener('click', () => {
      // Search for this link in the note body and scroll to it
      const preview = document.getElementById('vault-preview');
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
  window.dispatchEvent(new CustomEvent('odysseus-vault-context', {
    detail: { label: `Vault: ${note.title}`, content: note.content }
  }));
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(`[[${note.title}]]\n\n${note.content.slice(0, 2000)}`);
  }
}

// ── Graph / Timeline ───────────────────────────────────────

function _renderGraph() {
  const container = document.getElementById('vault-graph-canvas');
  if (!container || !window.vis) return;
  import('./vaultGraphCanvas.js').then(mod => {
    mod.renderVaultGraph(container, _selectedVaultId);
  }).catch(err => {
    container.innerHTML = `<div class="vault-error">Graph error: ${err.message}</div>`;
  });
}

function _renderLocalGraph(note) {
  const container = document.getElementById('vault-local-graph-canvas');
  if (!container || !window.vis) return;
  if (!note) {
    container.innerHTML = '<div class="vault-graph-loading">Select a note to see its local graph.</div>';
    return;
  }
  import('./vaultGraphCanvas.js').then(mod => {
    mod.renderLocalGraph(container, _selectedVaultId, note.rel_path || note.id);
  }).catch(err => {
    container.innerHTML = `<div class="vault-error">Local graph error: ${err.message}</div>`;
  });
}

function _renderTimeline() {
  const wrap = document.getElementById('vault-timeline-wrap');
  if (!wrap) return;
  import('./vaultTimeline.js').then(mod => {
    mod.renderVaultTimeline(wrap, _selectedVaultId);
  }).catch(err => {
    wrap.innerHTML = `<div class="vault-error">Timeline error: ${err.message}</div>`;
  });
}

// ── Permissions ────────────────────────────────────────────

async function _loadPermissions() {
  if (!_selectedVaultId) return;
  try {
    const r = await fetch(`${API_BASE}/api/vault/vaults/${_selectedVaultId}/permissions`, { credentials: 'same-origin' });
    if (!r.ok) return;
    const data = await r.json();
    _permissions = data.permissions || [];
    _renderPermissions();
  } catch (e) {
    console.error('[vault] load permissions failed', e);
  }
}

function _renderPermissions() {
  const table = document.getElementById('vault-permissions-table');
  if (!table) return;
  if (!_permissions.length) {
    table.innerHTML = '<div style="padding:12px;text-align:center;opacity:0.5;font-size:12px;">No permission rules yet</div>';
    return;
  }
  table.innerHTML = `
    <div class="vault-perm-header">
      <span>Type</span><span>Pattern</span><span>Perm</span><span>Prio</span><span></span>
    </div>
    ${_permissions.map(p => `
      <div class="vault-perm-row" data-id="${p.id}">
        <span class="vault-perm-type">${_esc(p.pattern_type)}</span>
        <span class="vault-perm-pattern" title="${_esc(p.path_pattern)}">${_esc(p.path_pattern)}</span>
        <span class="vault-perm-level ${_esc(p.permission)}">${_esc(p.permission)}</span>
        <span class="vault-perm-priority">${p.priority}</span>
        <button class="vault-perm-del" data-id="${p.id}">&times;</button>
      </div>
    `).join('')}
  `;
  table.querySelectorAll('.vault-perm-del').forEach(btn => {
    btn.addEventListener('click', () => _removePermission(btn.dataset.id));
  });
}

async function _updateVaultToggles() {
  if (!_selectedVaultId) return;
  const readCb = document.getElementById('vault-vault-read-all');
  const writeCb = document.getElementById('vault-vault-write-all');
  const read_enabled = readCb?.checked ?? true;
  const write_enabled = writeCb?.checked ?? false;
  try {
    await fetch(`${API_BASE}/api/vault/vaults/${_selectedVaultId}`, {
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
    console.error('[vault] update vault toggles failed', e);
  }
}

async function _refreshVault() {
  if (!_selectedVaultId) return;
  const btn = document.getElementById('vault-refresh-btn');
  if (btn) btn.style.opacity = '0.5';
  try {
    // Direct filesystem read — no backend sync needed
    await _loadNotes();
    await _loadFolders();
  } catch (e) {
    console.error('[vault] refresh failed', e);
  } finally {
    if (btn) btn.style.opacity = '';
  }
}

async function _addPermission() {
  if (!_selectedVaultId) return;
  const typeSel = document.getElementById('vault-new-perm-type');
  const patternInput = document.getElementById('vault-new-perm-pattern');
  const levelSel = document.getElementById('vault-new-perm-level');
  const priorityInput = document.getElementById('vault-new-perm-priority');

  const pattern = patternInput?.value.trim();
  if (!pattern) return;

  try {
    const r = await fetch(`${API_BASE}/api/vault/vaults/${_selectedVaultId}/permissions`, {
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
    console.error('[vault] add permission failed', e);
  }
}

async function _removePermission(permId) {
  if (!_selectedVaultId || !permId) return;
  try {
    await fetch(`${API_BASE}/api/vault/vaults/${_selectedVaultId}/permissions/${permId}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    await _loadPermissions();
  } catch (e) {
    console.error('[vault] remove permission failed', e);
  }
}

// ── Resize panes ───────────────────────────────────────────

function _wireResizeHandles() {
  if (typeof document === 'undefined') return;

  // Restore saved widths
  try {
    const saved = JSON.parse(localStorage.getItem('vault-pane-widths') || '{}');
    if (saved.left) document.documentElement.style.setProperty('--vault-left-w', saved.left + 'px');
    if (saved.right) document.documentElement.style.setProperty('--vault-right-w', saved.right + 'px');
  } catch {}

  const leftHandle = document.getElementById('vault-resize-left');
  const rightHandle = document.getElementById('vault-resize-right');
  const pane3 = document.querySelector('.vault-3pane');
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
      const prop = side === 'left' ? '--vault-left-w' : '--vault-right-w';
      startSize = parseInt(computed.getPropertyValue(prop)) || 200;
      handle.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const delta = side === 'left' ? e.clientX - startX : startX - e.clientX;
      const newSize = Math.max(120, Math.min(400, startSize + delta));
      const prop = side === 'left' ? '--vault-left-w' : '--vault-right-w';
      document.documentElement.style.setProperty(prop, newSize + 'px');
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      handle.classList.remove('dragging');
      const left = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--vault-left-w')) || 200;
      const right = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--vault-right-w')) || 200;
      try { localStorage.setItem('vault-pane-widths', JSON.stringify({ left, right })); } catch {}
    });
  }

  setup(leftHandle, 'left');
  setup(rightHandle, 'right');

  // Plugin settings sidebar resize
  const pluginResize = document.getElementById('vault-plugin-resize');
  const pluginSidebar = document.getElementById('vault-plugin-settings-sidebar');
  if (pluginResize && pluginSidebar) {
    let pStartX = 0;
    let pStartSize = 0;
    let pDragging = false;
    pluginResize.addEventListener('mousedown', (e) => {
      pDragging = true;
      pStartX = e.clientX;
      pStartSize = pluginSidebar.offsetWidth;
      pluginResize.classList.add('dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!pDragging) return;
      const delta = e.clientX - pStartX;
      const newSize = Math.max(180, Math.min(400, pStartSize + delta));
      document.documentElement.style.setProperty('--vault-plugin-sidebar-w', newSize + 'px');
    });
    document.addEventListener('mouseup', () => {
      if (!pDragging) return;
      pDragging = false;
      pluginResize.classList.remove('dragging');
    });
  }
}

// ── Helpers ────────────────────────────────────────────────

/** Highlight wikilinks / markdown links to targetNames inside a backlink snippet. */
function _highlightBacklinkSnippet(text, targetNames) {
  if (!text) return '';
  const namesRe = targetNames.map(tn => _escRegExp(tn)).join('|');
  const pattern = new RegExp(
    '\\[\\[(' + namesRe + ')(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]|' +
    '\\[([^\\]]*)\\]\\((' + namesRe + ')(\\.md)?\\)',
    'g'
  );
  let html = '';
  let lastIndex = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    html += _esc(text.slice(lastIndex, m.index));
    lastIndex = pattern.lastIndex;
    if (m[1] !== undefined) {
      // Wikilink: highlight the whole link
      const targetName = _esc(m[1]);
      const heading = _esc(m[2] || '');
      const pipe = _esc(m[3] || '');
      html += `<span style="color:var(--accent, var(--red, #4a9eff));font-weight:500;">[[${targetName}${heading}${pipe}]]</span>`;
    } else {
      // Markdown link: highlight the display text
      const display = m[4];
      const targetName = m[5];
      const ext = m[6] || '';
      html += `[<span style="color:var(--accent, var(--red, #4a9eff));font-weight:500;">${_esc(display)}</span>](${_esc(targetName + ext)})`;
    }
  }
  html += _esc(text.slice(lastIndex));
  return html;
}

function _esc(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function _extractOutboundLinks(content) {
  const links = new Set();
  if (!content) return [];
  // Wikilinks [[target|display]] or [[target]] or [[/[/target|display]/]]
  const wikiRe = /\[\[([^\]]+)\]\]|\[\/\[([^\]]+)\]\/\]/g;
  let m;
  while ((m = wikiRe.exec(content)) !== null) {
    const raw = m[1] || m[2];
    const pipeIdx = raw.indexOf('|');
    const target = pipeIdx >= 0 ? raw.slice(0, pipeIdx).trim() : raw.trim();
    const hashIdx = target.indexOf('#');
    const cleanTarget = hashIdx >= 0 ? target.slice(0, hashIdx).trim() : target;
    if (cleanTarget) links.add(cleanTarget);
  }
  // Markdown links [display](target)
  const mdRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  while ((m = mdRe.exec(content)) !== null) {
    const target = m[2].trim();
    // Skip external URLs
    if (/^(https?:|file:|ftp:|mailto:|data:)/i.test(target)) continue;
    const hashIdx = target.indexOf('#');
    const cleanTarget = hashIdx >= 0 ? target.slice(0, hashIdx).trim() : target;
    if (cleanTarget) links.add(cleanTarget);
  }
  return Array.from(links);
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
  console.log('[vault] _showContextMenu', x, y, items.length);
  const menu = document.createElement('div');
  menu.className = 'vault-context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  items.forEach(item => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'vault-context-menu-separator';
      menu.appendChild(sep);
      return;
    }
    const row = document.createElement('div');
    row.className = 'vault-context-menu-item' + (item.disabled ? ' disabled' : '') + (item.danger ? ' danger' : '');
    const check = item.checked ? '<span style="margin-right:4px;opacity:0.8;">&#10003;</span>' : '<span style="margin-right:4px;opacity:0;">&#10003;</span>';
    const iconHtml = item.icon ? `<span style="margin-right:8px;opacity:0.8;display:inline-flex;align-items:center;vertical-align:middle;">${item.icon}</span>` : '';
    const arrowHtml = item.submenu ? '<span style="opacity:0.5;font-size:11px;">></span>' : '';
    row.innerHTML = `<span>${check}${iconHtml}${_esc(item.label)}</span>${item.shortcut ? `<span style="opacity:0.5;font-size:11px;">${_esc(item.shortcut)}</span>` : ''}${arrowHtml}`;
    if (!item.disabled) {
      row.addEventListener('click', () => {
        _hideContextMenu();
        item.action();
      });
      if (item.submenu) {
        let submenuTimeout = null;
        row.addEventListener('mouseenter', () => {
          clearTimeout(submenuTimeout);
          if (_activeContextSubmenu) _activeContextSubmenu.remove();
          const rect = row.getBoundingClientRect();
          const sub = document.createElement('div');
          sub.className = 'vault-context-menu-submenu';
          sub.style.left = (rect.right + 2) + 'px';
          sub.style.top = rect.top + 'px';
          item.submenu.forEach(si => {
            if (si.separator) {
              const ssep = document.createElement('div');
              ssep.className = 'vault-context-menu-separator';
              sub.appendChild(ssep);
              return;
            }
            const srow = document.createElement('div');
            srow.className = 'vault-context-menu-item' + (si.disabled ? ' disabled' : '');
            const sicon = si.icon ? `<span style="margin-right:8px;opacity:0.8;display:inline-flex;align-items:center;vertical-align:middle;">${si.icon}</span>` : '';
            srow.innerHTML = `<span>${sicon}${_esc(si.label)}</span>`;
            if (!si.disabled) {
              srow.addEventListener('click', () => { _hideContextMenu(); si.action(); });
            }
            sub.appendChild(srow);
          });
          // Close submenu when mouse leaves it (with small delay to allow crossing gap)
          sub.addEventListener('mouseleave', () => {
            submenuTimeout = setTimeout(() => { sub.remove(); _activeContextSubmenu = null; }, 150);
          });
          row.addEventListener('mouseleave', () => {
            submenuTimeout = setTimeout(() => {
              if (!sub.matches(':hover')) { sub.remove(); _activeContextSubmenu = null; }
            }, 200);
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

function _showFolderPickerDialog(noteId, currentFolder) {
  const modal = document.getElementById('vault-modal');
  if (!modal) return;

  // Build folder list
  const folders = [''];
  _folders.forEach(f => {
    const clean = (f || '').replace(/\\/g, '/');
    if (clean && !folders.includes(clean)) folders.push(clean);
  });
  folders.sort();

  // Remove any existing picker
  const existing = modal.querySelector('.vault-folder-picker');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'vault-folder-picker';
  overlay.innerHTML = `
    <div class="vault-folder-picker-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;">
      <div class="vault-folder-picker-box" style="width:520px;max-width:90vw;background:var(--bg-raised,var(--bg,#1a1a1a));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;overflow:hidden;">
        <input type="text" class="vault-folder-picker-input" placeholder="Type a folder..." style="width:100%;background:transparent;color:var(--fg);border:none;border-bottom:1px solid var(--border);padding:12px 14px;font-size:15px;outline:none;box-sizing:border-box;" autocomplete="off" spellcheck="false">
        <div class="vault-folder-picker-results" style="max-height:320px;overflow-y:auto;padding:4px 0;"></div>
        <div class="vault-folder-picker-hint" style="padding:6px 14px;font-size:11px;opacity:0.5;border-top:1px solid var(--border);">↑↓ to navigate · Enter to select · shift + Enter to create · esc to dismiss</div>
      </div>
    </div>
  `;
  modal.appendChild(overlay);

  const input = overlay.querySelector('.vault-folder-picker-input');
  const results = overlay.querySelector('.vault-folder-picker-results');
  let selectedIndex = 0;

  const _moveNoteToFolder = async (targetFolder) => {
    const note = _notes.find(n => n.id === noteId);
    const oldFolder = note ? note.folder : '';
    if (note) note.folder = targetFolder;
    _renderFolderTree();
    try {
      const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(noteId)}/move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ folder: targetFolder }),
      });
      if (!r.ok) throw new Error();
      const data = await r.json().catch(() => ({}));
      if (data.new_path && note) {
        const newId = data.new_path;
        _syncNoteIdAfterMove(noteId, newId);
        note.id = newId;
        note.rel_path = newId;
      }
      showToast('File moved');
    } catch {
      if (note) note.folder = oldFolder;
      _renderFolderTree();
      showToast('Move failed');
    }
  };

  const _createFolder = async (folderName) => {
    if (!folderName) return;
    try {
      const r = await fetch(`${API_BASE}/api/vault/vaults/${encodeURIComponent(_selectedVaultId)}/folders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ path: folderName }),
      });
      if (!r.ok) throw new Error();
      await _loadFolders();
      await _moveNoteToFolder(folderName);
    } catch (err) {
      console.error('[vault] create folder failed:', err);
      showToast('Failed to create folder');
    }
  };

  const renderResults = (query) => {
    const q = query.trim().toLowerCase();
    let items = folders;
    if (q) {
      items = folders.filter(f => (f || '(root)').toLowerCase().includes(q));
    }
    if (!items.length) {
      results.innerHTML = `<div style="padding:20px;text-align:center;opacity:0.5;font-size:13px;">No matching folders. Press Shift+Enter to create "${_esc(query)}"</div>`;
      return;
    }
    results.innerHTML = items.map((f, i) => `
      <div class="vault-folder-picker-item" data-folder="${_esc(f)}" data-index="${i}" style="padding:7px 14px;font-size:13px;cursor:pointer;pointer-events:auto;display:flex;align-items:center;gap:8px;border-radius:4px;margin:0 4px;">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(f || '/')}</span>
        ${f === currentFolder ? '<span style="opacity:0.4;font-size:11px;">current</span>' : ''}
      </div>
    `).join('');
    selectedIndex = 0;
    _updateSelection();
  };

  const _updateSelection = () => {
    const allItems = results.querySelectorAll('.vault-folder-picker-item');
    if (selectedIndex < 0) selectedIndex = 0;
    if (selectedIndex >= allItems.length) selectedIndex = allItems.length - 1;
    allItems.forEach((el, i) => {
      el.style.background = i === selectedIndex ? 'color-mix(in srgb, var(--accent, var(--red)) 15%, transparent)' : 'transparent';
    });
    const selected = results.querySelector(`.vault-folder-picker-item[data-index="${selectedIndex}"]`);
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => renderResults(input.value));
  input.addEventListener('keydown', (e) => {
    const items = results.querySelectorAll('.vault-folder-picker-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      _updateSelection();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      _updateSelection();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        // Create new folder with the typed name
        _createFolder(input.value.trim());
      } else {
        const selected = results.querySelector(`.vault-folder-picker-item[data-index="${selectedIndex}"]`);
        if (selected) {
          _moveNoteToFolder(selected.dataset.folder);
        }
      }
      overlay.remove();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      overlay.remove();
    }
  });

  results.addEventListener('click', (e) => {
    const item = e.target.closest('.vault-folder-picker-item');
    if (item) {
      _moveNoteToFolder(item.dataset.folder);
      overlay.remove();
    }
  });

  overlay.querySelector('.vault-folder-picker-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) overlay.remove();
  });

  renderResults('');
  input.focus();
}

function _getNoteAbsolutePath(note) {
  if (!note) return null;
  const vault = _vaults.find(v => v.id === _selectedVaultId);
  const vaultPath = vault?.path || '';
  if (!vaultPath) return null;
  const rel = note.rel_path || note.id || '';
  return vaultPath.replace(/\\/g, '/') + '/' + rel.replace(/\\/g, '/');
}

function _openNoteInDefaultApp(noteId) {
  const note = _notes.find(n => n.id === noteId);
  const absPath = _getNoteAbsolutePath(note);
  if (!absPath) { showToast('Vault path not available'); return; }
  if (window.electronAPI?.openPath) {
    window.electronAPI.openPath(absPath).then(r => {
      if (r?.error) showToast('Could not open: ' + r.error);
    }).catch(err => {
      console.error('[vault] shell-open-path failed:', err);
      showToast('Electron shell not available. If you recently updated main.js, restart Electron.');
    });
  } else {
    showToast('Desktop shell not available in browser');
  }
}

function _showNoteInExplorer(noteId) {
  const note = _notes.find(n => n.id === noteId);
  const absPath = _getNoteAbsolutePath(note);
  if (!absPath) { showToast('Vault path not available'); return; }
  if (window.electronAPI?.showItemInFolder) {
    window.electronAPI.showItemInFolder(absPath).catch(err => {
      console.error('[vault] shell-show-item failed:', err);
      showToast('Electron shell not available. If you recently updated main.js, restart Electron.');
    });
  } else {
    showToast('Desktop shell not available in browser');
  }
}

function _showFolderInExplorer(folder) {
  const vault = _vaults.find(v => v.id === _selectedVaultId);
  const vaultPath = vault?.path || '';
  if (!vaultPath) { showToast('Vault path not available'); return; }
  const folderPath = vaultPath.replace(/\\/g, '/') + '/' + (folder || '').replace(/\\/g, '/');
  if (window.electronAPI?.showItemInFolder) {
    window.electronAPI.showItemInFolder(folderPath).catch(err => {
      console.error('[vault] shell-show-item failed:', err);
      showToast('Electron shell not available. If you recently updated main.js, restart Electron.');
    });
  } else {
    showToast('Desktop shell not available in browser');
  }
}

function _showIconPicker(targetId, x, y, type = 'note') {
  const existing = document.querySelector('.vault-icon-picker');
  if (existing) existing.remove();
  const picker = document.createElement('div');
  picker.className = 'vault-icon-picker';
  picker.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:6000;background:var(--panel,var(--bg,#1a1a1a));border:1px solid var(--border);border-radius:6px;padding:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);display:flex;flex-wrap:wrap;gap:6px;max-width:220px;`;
  const keys = Object.keys(_NOTE_ICON_PACK).filter(k => k !== 'folder');
  const currentKey = type === 'folder' ? _folderIcons[targetId] : _noteIcons[targetId];
  const setIcon = type === 'folder' ? _setFolderIcon : _setNoteIcon;
  keys.forEach(key => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = key;
    btn.style.cssText = 'width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:4px;background:none;color:var(--fg);cursor:pointer;';
    btn.innerHTML = type === 'folder'
      ? _getFolderIconSvg('__picker__', key, 16)
      : _getNoteIconSvg('__picker__', key, 16);
    if (currentKey === key) btn.style.borderColor = 'var(--accent,var(--red,#4a9eff))';
    btn.addEventListener('click', () => {
      setIcon(targetId, key);
      picker.remove();
    });
    picker.appendChild(btn);
  });
  // Add "clear" option
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.title = 'Remove icon';
  clearBtn.style.cssText = 'width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:4px;background:none;color:var(--fg);cursor:pointer;font-size:11px;';
  clearBtn.textContent = '×';
  clearBtn.addEventListener('click', () => { setIcon(targetId, null); picker.remove(); });
  picker.appendChild(clearBtn);
  document.body.appendChild(picker);
  // Dismiss on click outside
  setTimeout(() => {
    document.addEventListener('click', function dismiss(e) {
      if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', dismiss); }
    });
  }, 0);
}

function _showNoteMenu(e, note) {
  e.stopPropagation();
  e.preventDefault();
  const rect = e.currentTarget.getBoundingClientRect();
  const isBookmarked = _bookmarks.has(note.id);
  _showContextMenu(rect.left, rect.bottom + 4, [
    { label: _sourceModeEnabled ? 'Switch to Live Preview' : 'Switch to Source Mode', action: () => {
      _sourceModeEnabled = !_sourceModeEnabled;
      _editModePref = _sourceModeEnabled ? 'edit' : 'live';
      _previewMode = _sourceModeEnabled ? 'edit' : 'live';
      _updateModeButtons();
      _selectNote(note.id);
    }},
    { separator: true },
    { label: 'Rename...', action: () => _promptRenameNote(note.id) },
    { label: 'Move file to…', action: () => _showFolderPickerDialog(note.id, note.folder) },
    { label: 'Make a copy', action: () => _duplicateNote(note.id) },
    { separator: true },
    { label: isBookmarked ? 'Unbookmark' : 'Bookmark', action: () => {
      if (isBookmarked) _bookmarks.delete(note.id); else _bookmarks.add(note.id);
      _persistBookmarks();
      _renderBookmarksPane();
      _renderFolderTree();
    }},
    { label: 'Add file property', action: () => {
      const btn = document.querySelector('.vault-prop-add-main');
      if (btn) btn.click();
    }},
    { separator: true },
    { label: 'Copy Vault URL', action: () => _copyVaultUrl(note.id) },
    { label: 'Copy path', action: () => navigator.clipboard?.writeText(note.rel_path || note.id) },
    { separator: true },
    { label: 'Reveal file in navigation', action: () => {
      const tree = document.getElementById('vault-folder-tree');
      const row = tree?.querySelector(`.vault-tree-row[data-note-id="${CSS.escape(note.id)}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.style.background = 'color-mix(in srgb, var(--accent, var(--red, #4a9eff)) 20%, transparent)';
        setTimeout(() => { row.style.background = ''; }, 1500);
      }
    }},
    { separator: true },
    { label: 'Split right', disabled: true, action: () => {} },
    { label: 'Split down', disabled: true, action: () => {} },
    { label: 'Open in Hover Editor', disabled: true, action: () => {} },
    { label: 'Export to PDF...', disabled: true, action: () => {} },
    { label: 'Merge entire file with...', disabled: true, action: () => {} },
    { label: 'Open in default app', action: () => _openNoteInDefaultApp(note.id) },
    { label: 'Show in system explorer', action: () => _showNoteInExplorer(note.id) },
    { separator: true },
    { label: 'Change icon', action: () => _showIconPicker(note.id, rect.left, rect.bottom + 4, 'note') },
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
    { separator: true },
    { label: 'Make a copy', action: () => _duplicateNote(noteId) },
    { label: 'Move file to…', action: () => _showFolderPickerDialog(noteId, note?.folder) },
    { label: isBookmarked ? 'Unbookmark' : 'Bookmark', action: () => {
      if (isBookmarked) _bookmarks.delete(noteId); else _bookmarks.add(noteId);
      _persistBookmarks();
      _renderBookmarksPane();
      _renderFolderTree();
    }},
    { label: 'Merge entire file with...', disabled: true, action: () => {} },
    { separator: true },
    { label: 'Copy Vault URL', action: () => _copyVaultUrl(noteId) },
    { label: 'Copy formatted Advanced URI', action: () => {
      const n = _notes.find(n => n.id === noteId);
      if (!n) return;
      const vault = _selectedVaultId || 'main';
      const uri = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(n.rel_path || n.id)}`;
      navigator.clipboard?.writeText(uri);
    }},
    { label: 'Copy path', action: () => {
      const n = _notes.find(n => n.id === noteId);
      if (n) navigator.clipboard?.writeText(n.rel_path || n.id);
    }},
    { separator: true },
    { label: 'Open in default app', action: () => _openNoteInDefaultApp(noteId) },
    { label: 'Show in system explorer', action: () => _showNoteInExplorer(noteId) },
    { separator: true },
    { label: 'Change icon', action: () => _showIconPicker(noteId, e.clientX, e.clientY, 'note') },
    { separator: true },
    { label: 'Rename...', action: () => _promptRenameNote(noteId) },
    { label: 'Delete', danger: true, action: () => _deleteNote(noteId) },
    { separator: true },
    { label: 'Manage all fields', action: () => {
      const btn = document.querySelector('.vault-prop-add-main');
      if (btn) btn.click();
      _navigateToNote(noteId, true);
    }},
    { label: 'Add field at section...', disabled: true, action: () => {} },
    { label: 'Add field in frontmatter', action: () => {
      const btn = document.querySelector('.vault-prop-add-main');
      if (btn) btn.click();
      _navigateToNote(noteId, true);
    }},
    { label: 'Add missing fields at section...', disabled: true, action: () => {} },
    { label: `Add fileClass to ${_esc(note?.title || '')}`, disabled: true, action: () => {} },
    { label: 'Add command', disabled: true, action: () => {} },
  ]);
}

async function _deleteFolder(folder) {
  if (!folder) return;
  const folderName = folder.split('/').pop() || folder;
  const confirmed = await styledConfirm(`Delete folder "${_esc(folderName)}" and all its contents?`, { confirmText: 'Delete', cancelText: 'Cancel', danger: true });
  if (!confirmed) return;

  // Optimistic: remove folder and all notes under it
  const removedNotes = _notes.filter(n => (n.folder || '') === folder || (n.folder || '').startsWith(folder + '/'));
  const removedNoteIds = new Set(removedNotes.map(n => n.id));
  const removedFolders = _folders.filter(f => f === folder || f.startsWith(folder + '/'));
  const prevSelected = _selectedNoteId;

  _notes = _notes.filter(n => !removedNoteIds.has(n.id));
  _folders = _folders.filter(f => f !== folder && !f.startsWith(folder + '/'));
  _openTabs = _openTabs.filter(id => !removedNoteIds.has(id));
  if (removedNoteIds.has(_selectedNoteId)) {
    _selectedNoteId = _openTabs.length ? _openTabs[_openTabs.length - 1] : null;
  }
  _renderFolderTree();
  _renderNoteTabs();
  _renderNoteList();
  if (_selectedNoteId) {
    _selectNote(_selectedNoteId);
  } else {
    const preview = document.getElementById('vault-preview');
    if (preview) preview.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;">Select a note to view</div>';
  }

  try {
    const r = await fetch(`${API_BASE}/api/vault/folders/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ folder_path: folder }),
    });
    if (!r.ok) throw new Error();
  } catch (e) {
    console.error('[vault] delete folder failed, rolling back', e);
    // Restore
    _notes.push(...removedNotes);
    _notes.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    _folders.push(...removedFolders);
    _folders.sort();
    _selectedNoteId = prevSelected;
    _renderFolderTree();
    _renderNoteTabs();
    _renderNoteList();
    if (_selectedNoteId) _selectNote(_selectedNoteId);
    showToast('Failed to delete folder');
  }
}

function _countFolderWords(folder) {
  const sel = (folder || '').replace(/\\/g, '/');
  const notesInFolder = sel
    ? _notes.filter(n => {
        const f = (n.folder || '').replace(/\\/g, '/');
        return f === sel || f.startsWith(sel + '/');
      })
    : _notes.filter(n => !n.folder);
  let total = 0;
  let counted = 0;
  for (const n of notesInFolder) {
    const text = n.content || n.body || '';
    if (text) {
      const matches = text.match(/\S+/g);
      total += matches ? matches.length : 0;
      counted++;
    }
  }
  if (counted === 0 && notesInFolder.length > 0) {
    showToast('Note content not loaded for word count');
  } else {
    showToast(`${total} words across ${counted} note(s) in ${_esc(sel || 'root')}`);
  }
}

function _searchInFolder(folder) {
  const searchInput = document.getElementById('vault-search-input');
  if (searchInput) {
    searchInput.value = `path:${folder || ''} `;
    searchInput.focus();
    searchInput.dispatchEvent(new Event('input'));
  }
}

function _bookmarkFolder(folder) {
  const notesInFolder = folder
    ? _notes.filter(n => n.folder === folder || (n.folder || '').startsWith(folder + '/'))
    : _notes.filter(n => !n.folder);
  for (const n of notesInFolder) {
    _bookmarks.add(n.id);
  }
  _persistBookmarks();
  _renderBookmarksPane();
  _renderFolderTree();
  showToast(`Bookmarked ${notesInFolder.length} note(s) in ${_esc(folder || 'root')}`);
}

function _showFolderContextMenu(e, folder) {
  e.preventDefault();
  e.stopPropagation();
  const folderNotes = folder
    ? _notes.filter(n => n.folder === folder || (n.folder || '').startsWith(folder + '/'))
    : _notes.filter(n => !n.folder);
  const allBookmarked = folderNotes.length > 0 && folderNotes.every(n => _bookmarks.has(n.id));
  _showContextMenu(e.clientX, e.clientY, [
    { label: 'New note', action: () => _createNoteInFolder(folder) },
    { label: 'New folder', action: () => _promptNewFolder(folder) },
    { label: 'New canvas', disabled: true, action: () => {} },
    { label: 'New base', disabled: true, action: () => {} },
    { separator: true },
    { label: 'Make a copy', disabled: true, action: () => {} },
    { label: 'Move folder to...', disabled: true, action: () => {} },
    { label: 'Search in folder', action: () => _searchInFolder(folder) },
    { label: allBookmarked ? 'Remove bookmark' : 'Bookmark...', action: () => _bookmarkFolder(folder) },
    { label: 'Count Words', action: () => _countFolderWords(folder) },
    { separator: true },
    { label: 'Copy path', action: () => navigator.clipboard?.writeText(folder || '/') },
    { label: 'Show in system explorer', action: () => _showFolderInExplorer(folder) },
    { separator: true },
    { label: 'Change icon', action: () => _showIconPicker(folder, e.clientX, e.clientY, 'folder') },
    { separator: true },
    { label: 'Create new note from template', action: () => _createNoteFromTemplate(folder) },
    { separator: true },
    { label: 'Rename folder', action: () => _promptRenameFolder(folder) },
    { label: 'Delete', danger: true, action: () => _deleteFolder(folder) },
    { separator: true },
    { label: 'Collapse all', action: () => _collapseAllFolders() },
    { label: 'Expand all', action: () => _expandAllFolders() },
    { separator: true },
    { label: 'Add command', disabled: true, action: () => {} },
  ]);
}

function _showBlankContextMenu(e) {
  e.preventDefault();
  e.stopPropagation();
  _showContextMenu(e.clientX, e.clientY, [
    { label: 'New note', action: () => _createNoteInFolder('') },
    { label: 'New note from template', action: () => _createNoteFromTemplate('') },
    { label: 'New folder', action: () => _promptNewFolder('') },
    { separator: true },
    { label: 'Collapse all', action: () => _collapseAllFolders() },
    { label: 'Expand all', action: () => _expandAllFolders() },
  ]);
}

function _noteEditorWrap(prefix, suffix) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const selected = sel.toString();
  if (selected.startsWith(prefix) && selected.endsWith(suffix)) {
    document.execCommand('insertText', false, selected.slice(prefix.length, -suffix.length));
  } else if (selected) {
    document.execCommand('insertText', false, prefix + selected + suffix);
  } else {
    document.execCommand('insertText', false, prefix + suffix);
    const newSel = window.getSelection();
    if (newSel.rangeCount) {
      const range = newSel.getRangeAt(0);
      const container = range.startContainer;
      const offset = range.startOffset;
      if (container.nodeType === Node.TEXT_NODE && offset >= suffix.length) {
        const r = document.createRange();
        r.setStart(container, offset - suffix.length);
        r.collapse(true);
        newSel.removeAllRanges();
        newSel.addRange(r);
      }
    }
  }
}

function _noteEditorInsert(text) {
  document.execCommand('insertText', false, text);
}

function _noteEditorLineOp(modifyFn) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  let node = sel.getRangeAt(0).startContainer;
  let lineEl = null;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList.contains('lp-line')) { lineEl = node; break; }
      if (node.classList.contains('vault-source-view')) { lineEl = null; break; }
    }
    node = node.parentNode;
  }
  if (!lineEl) return;
  const sourceEl = lineEl.querySelector('.lp-source');
  if (!sourceEl) return;
  const raw = _getRawFromSource(sourceEl);
  const newRaw = modifyFn(raw);
  sourceEl.innerHTML = _renderSourceLine(newRaw);
  lineEl.setAttribute('data-raw', newRaw);
  _wireSourceWikilinks(sourceEl);
}

function _showNoteEditorContextMenu(e) {
  e.preventDefault();
  e.stopPropagation();

  const _svg = (path) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  const linkSvg = _svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>');
  const externalSvg = _svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>');
  const boldSvg = _svg('<path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/>');
  const italicSvg = _svg('<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>');
  const strikeSvg = _svg('<line x1="4" y1="12" x2="20" y2="12"/><path d="M6 12a6 6 0 0 1 12 0"/>');
  const highlightSvg = _svg('<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>');
  const codeSvg = _svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>');
  const mathsSvg = _svg('<path d="M4 4h16v16H4z"/><path d="M8 8l8 8"/><path d="M16 8l-8 8"/>');
  const commentSvg = _svg('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>');
  const clearSvg = _svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>');
  const listSvg = _svg('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>');
  const numListSvg = _svg('<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 17H4c0-1 1-2 2-2s1 .5 1 1-.5 1-1 1"/>');
  const taskSvg = _svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>');
  const hSvg = _svg('<path d="M4 12h16"/><path d="M12 4v16"/>');
  const bodySvg = _svg('<line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="14" x2="3" y2="14"/>');
  const quoteSvg = _svg('<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 1 1 2v1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 1 1 2v1z"/>');
  const footnoteSvg = _svg('<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>');
  const tableSvg = _svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="12" y1="3" x2="12" y2="21"/>');
  const calloutSvg = _svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>');
  const hrSvg = _svg('<line x1="4" y1="12" x2="20" y2="12"/>');
  const blockSvg = _svg('<rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/>');
  const cutSvg = _svg('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>');
  const copySvg = _svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
  const pasteSvg = _svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>');
  const plainSvg = _svg('<line x1="14" y1="2" x2="14" y2="22"/><line x1="4" y1="12" x2="20" y2="12"/>');
  const selectAllSvg = _svg('<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>');

  _showContextMenu(e.clientX, e.clientY, [
    { label: 'Add link', icon: linkSvg, action: () => {
      _noteEditorInsert('[[]]');
      const sel = window.getSelection();
      if (sel.rangeCount) {
        const r = sel.getRangeAt(0);
        if (r.startContainer.nodeType === Node.TEXT_NODE && r.startOffset >= 2) {
          const nr = document.createRange();
          nr.setStart(r.startContainer, r.startOffset - 2);
          nr.collapse(true);
          sel.removeAllRanges(); sel.addRange(nr);
        }
      }
    }},
    { label: 'Add external link', icon: externalSvg, action: () => {
      _noteEditorInsert('[]()');
      const sel = window.getSelection();
      if (sel.rangeCount) {
        const r = sel.getRangeAt(0);
        if (r.startContainer.nodeType === Node.TEXT_NODE && r.startOffset >= 3) {
          const nr = document.createRange();
          nr.setStart(r.startContainer, r.startOffset - 3);
          nr.collapse(true);
          sel.removeAllRanges(); sel.addRange(nr);
        }
      }
    }},
    { separator: true },
    { label: 'Format', icon: _svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'), submenu: [
      { label: 'Bold', icon: boldSvg, action: () => _noteEditorWrap('**', '**') },
      { label: 'Italic', icon: italicSvg, action: () => _noteEditorWrap('*', '*') },
      { label: 'Strikethrough', icon: strikeSvg, action: () => _noteEditorWrap('~~', '~~') },
      { label: 'Highlight', icon: highlightSvg, action: () => _noteEditorWrap('==', '==') },
      { separator: true },
      { label: 'Code', icon: codeSvg, action: () => _noteEditorWrap('`', '`') },
      { label: 'Maths', icon: mathsSvg, action: () => _noteEditorWrap('$', '$') },
      { label: 'Comment', icon: commentSvg, action: () => _noteEditorWrap('%%', '%%') },
      { separator: true },
      { label: 'Clear formatting', icon: clearSvg, action: () => {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        const selected = sel.toString();
        if (!selected) return;
        const cleaned = selected
          .replace(/\*\*(.*?)\*\*/g, '$1')
          .replace(/\*(.*?)\*/g, '$1')
          .replace(/~~(.*?)~~/g, '$1')
          .replace(/==(.*?)==/g, '$1')
          .replace(/`(.*?)`/g, '$1')
          .replace(/\$\$(.*?)\$\$/g, '$1')
          .replace(/\$(.*?)\$/g, '$1')
          .replace(/%%(.*?)%%/g, '$1');
        document.execCommand('insertText', false, cleaned);
      }},
    ]},
    { label: 'Paragraph', icon: _svg('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>'), submenu: [
      { label: 'Bullet list', icon: listSvg, action: () => _noteEditorLineOp(raw => '- ' + raw.replace(/^(#{1,6}\s+|\d+\.\s+|[-*+]\s+(\[.\]\s+)?|>\s*)/, '')) },
      { label: 'Numbered list', icon: numListSvg, action: () => _noteEditorLineOp(raw => '1. ' + raw.replace(/^(#{1,6}\s+|\d+\.\s+|[-*+]\s+(\[.\]\s+)?|>\s*)/, '')) },
      { label: 'Task list', icon: taskSvg, action: () => _noteEditorLineOp(raw => '- [ ] ' + raw.replace(/^(#{1,6}\s+|\d+\.\s+|[-*+]\s+(\[.\]\s+)?|>\s*)/, '')) },
      { separator: true },
      { label: 'H1 Heading 1', icon: hSvg, action: () => _noteEditorLineOp(raw => '# ' + raw.replace(/^(#{1,6}\s+|\d+\.\s+|[-*+]\s+(\[.\]\s+)?|>\s*)/, '')) },
      { label: 'H2 Heading 2', icon: hSvg, action: () => _noteEditorLineOp(raw => '## ' + raw.replace(/^(#{1,6}\s+|\d+\.\s+|[-*+]\s+(\[.\]\s+)?|>\s*)/, '')) },
      { label: 'H3 Heading 3', icon: hSvg, action: () => _noteEditorLineOp(raw => '### ' + raw.replace(/^(#{1,6}\s+|\d+\.\s+|[-*+]\s+(\[.\]\s+)?|>\s*)/, '')) },
      { label: 'H4 Heading 4', icon: hSvg, action: () => _noteEditorLineOp(raw => '#### ' + raw.replace(/^(#{1,6}\s+|\d+\.\s+|[-*+]\s+(\[.\]\s+)?|>\s*)/, '')) },
      { label: 'H5 Heading 5', icon: hSvg, action: () => _noteEditorLineOp(raw => '##### ' + raw.replace(/^(#{1,6}\s+|\d+\.\s+|[-*+]\s+(\[.\]\s+)?|>\s*)/, '')) },
      { label: 'H6 Heading 6', icon: hSvg, action: () => _noteEditorLineOp(raw => '###### ' + raw.replace(/^(#{1,6}\s+|\d+\.\s+|[-*+]\s+(\[.\]\s+)?|>\s*)/, '')) },
      { label: 'Body', icon: bodySvg, action: () => _noteEditorLineOp(raw => raw.replace(/^(#{1,6}\s+|\d+\.\s+|[-*+]\s+(\[.\]\s+)?|>\s*)/, '')) },
      { label: 'Quote', icon: quoteSvg, action: () => _noteEditorLineOp(raw => '> ' + raw.replace(/^(#{1,6}\s+|\d+\.\s+|[-*+]\s+(\[.\]\s+)?|>\s*)/, '')) },
    ]},
    { label: 'Insert', icon: _svg('<path d="M12 5v14M5 12h14"/>'), submenu: [
      { label: 'Footnote', icon: footnoteSvg, action: () => _noteEditorInsert('[^1]') },
      { label: 'Table', icon: tableSvg, action: () => _noteEditorInsert('| Header | Header |\n| --- | --- |\n| Cell | Cell |') },
      { label: 'Callout', icon: calloutSvg, action: () => _noteEditorInsert('> [!info]\n> ') },
      { label: 'Horizontal rule', icon: hrSvg, action: () => _noteEditorInsert('---') },
      { separator: true },
      { label: 'Code block', icon: blockSvg, action: () => _noteEditorInsert('```\n\n```') },
      { label: 'Maths block', icon: blockSvg, action: () => _noteEditorInsert('$$\n\n$$') },
      { label: 'New base', icon: _svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>'), disabled: true, action: () => {} },
    ]},
    { separator: true },
    { label: 'Cut', icon: cutSvg, action: () => document.execCommand('cut') },
    { label: 'Copy', icon: copySvg, action: () => document.execCommand('copy') },
    { label: 'Paste', icon: pasteSvg, action: () => document.execCommand('paste') },
    { label: 'Paste as plain text', icon: plainSvg, action: () => document.execCommand('paste') },
    { label: 'Select all', icon: selectAllSvg, action: () => document.execCommand('selectAll') },
  ]);
}

// Placeholder actions for context menu items needing backend support
function _syncNoteIdAfterMove(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  if (_selectedNoteId === oldId) _selectedNoteId = newId;
  const tabIdx = _openTabs.indexOf(oldId);
  if (tabIdx !== -1) _openTabs[tabIdx] = newId;
  if (_historyStack.includes(oldId)) {
    _historyStack = _historyStack.map(id => id === oldId ? newId : id);
  }
  _noteContentCache.delete(oldId);
}

async function _doRenameNote(noteId, newName) {
  const note = _notes.find(n => n.id === noteId);
  if (!note || !newName || newName === note.title) return;
  const oldTitle = note.title;
  let fileName = newName;
  if (!fileName.endsWith('.md')) fileName += '.md';
  const folder = note.folder || '';
  const newPath = folder ? `${folder}/${fileName}` : fileName;

  // Save old values for rollback
  const oldId = note.id;
  const oldRelPath = note.rel_path;

  // --- Phase 1: Compute link updates in-memory (no saves, no UI changes yet) ---
  const linkUpdates = [];
  if (_vaultSettings.filesAndLinks.autoUpdateLinks) {
    const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const oldEsc = escapeReg(oldTitle);
    const newEsc = newName;
    const wikiAny = new RegExp('\\[\\[' + oldEsc + '(#[^|\\]]*)?(\\|[^\\]]*)?\\]\\]', 'g');
    const mdLink = new RegExp('\\[([^\\]]*)\\]\\(' + oldEsc + '(\\.md)?\\)', 'g');
    for (const otherNote of _notes) {
      if (otherNote.id === noteId) continue;
      let content = otherNote.content || '';
      const originalContent = content;
      const originalOutbound = otherNote.outbound_links;
      content = content.replace(wikiAny, (match, heading, pipePart) => `[[${newEsc}${heading || ''}${pipePart || ''}]]`);
      content = content.replace(mdLink, (match, display, ext) => `[${display}](${newEsc}${ext || ''})`);
      if (content !== originalContent) {
        linkUpdates.push({ note: otherNote, originalContent, originalOutbound, newContent: content });
      }
    }
  }

  // --- Phase 1.5: Prompt user if confirmAutoUpdateLinks is enabled ---
  if (linkUpdates.length && _vaultSettings.filesAndLinks.confirmAutoUpdateLinks !== false) {
    const confirmed = await styledConfirm(
      `Update ${linkUpdates.length} linking note(s) to use "${newName}"?`,
      { confirmText: 'Update', cancelText: 'Skip' }
    );
    if (!confirmed) {
      linkUpdates.length = 0; // Clear updates so they won't be applied
    }
  }

  // --- Phase 2: Apply ALL optimistic updates at once (title + link content) ---
  note.id = newPath;
  note.rel_path = newPath;
  note.title = newName;
  for (const update of linkUpdates) {
    update.note.content = update.newContent;
    update.note.outbound_links = _extractOutboundLinks(update.newContent);
  }
  _syncNoteIdAfterMove(oldId, newPath);
  _renderFolderTree();
  _renderNoteList();
  _updateModeButtons();
  _updateNavButtons();
  if (_selectedNoteId === newPath) _selectNote(newPath);
  // Immediately refresh backlinks pane for the renamed note so it reflects the updated outbound_links
  if (_selectedNoteId === note.id) {
    const selectedNote = _notes.find(n => n.id === _selectedNoteId);
    if (selectedNote) _renderBacklinksPane(selectedNote);
  }

  // --- Phase 3: Server rename request ---
  try {
    const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(noteId)}/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ new_path: newPath }),
    });
    if (!r.ok) throw new Error();
    const data = await r.json().catch(() => ({}));
    const serverNewId = data.new_path || newPath;
    if (serverNewId !== newPath) {
      note.id = serverNewId;
      note.rel_path = serverNewId;
      _syncNoteIdAfterMove(newPath, serverNewId);
    }

    // --- Phase 4: Background saves for updated linking notes ---
    const saves = linkUpdates.map(u => _saveNoteContent(u.note));
    if (saves.length) {
      Promise.all(saves).then(() => {
        showToast(`Updated ${linkUpdates.length} linking note(s)`);
      }).catch(err => {
        console.error('[vault] auto-update background save failed:', err);
        showToast('Some link updates failed to save');
      });
    }
    console.log('[vault] auto-update links:', { oldTitle, newName, updatedCount: linkUpdates.length });
  } catch (e) {
    console.error('[vault] rename failed, rolling back', e);
    // Rollback title change
    note.id = oldId;
    note.rel_path = oldRelPath;
    note.title = oldTitle;
    _syncNoteIdAfterMove(newPath, oldId);
    // Rollback content changes in other notes
    for (const update of linkUpdates) {
      update.note.content = update.originalContent;
      update.note.outbound_links = update.originalOutbound;
    }
    _renderFolderTree();
    _renderNoteList();
    _updateModeButtons();
    _updateNavButtons();
    if (_selectedNoteId === oldId) _selectNote(oldId);
    if (_selectedNoteId === oldId) {
      const selectedNote = _notes.find(n => n.id === _selectedNoteId);
      if (selectedNote) _renderBacklinksPane(selectedNote);
    }
    showToast('Failed to rename note');
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
  const source = _notes.find(n => n.id === noteId);
  if (!source) return;
  const dupName = _findUniqueUntitled(source.title, _notes, '.md');
  const dupPath = source.folder ? `${source.folder}/${dupName}` : dupName;
  const optimisticNote = {
    id: dupPath,
    rel_path: dupPath,
    folder: source.folder || '',
    title: dupName.replace(/\.md$/, ''),
    content: source.content || '',
    frontmatter: source.frontmatter || {},
    tags: source.tags || [],
    outbound_links: source.outbound_links || [],
    backlinks: [],
    last_modified_src: new Date().toISOString(),
    sync_status: 'synced',
  };
  _notes.push(optimisticNote);
  _notes.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  _renderFolderTree();
  _navigateToNote(dupPath, true, true);

  try {
    const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(noteId)}/duplicate`, {
      method: 'POST', credentials: 'same-origin',
    });
    if (!r.ok) throw new Error();
    const data = await r.json();
    if (data.note_id) {
      _syncNoteIdAfterMove(dupPath, data.note_id);
      optimisticNote.id = data.note_id;
      optimisticNote.rel_path = data.note_id;
      _renderFolderTree();
      _navigateToNote(data.note_id, true, true);
    }
  } catch (e) {
    console.error('[vault] duplicate failed', e);
    const idx = _notes.findIndex(n => n.id === dupPath);
    if (idx !== -1) _notes.splice(idx, 1);
    _renderFolderTree();
    showToast('Failed to duplicate note');
  }
}
async function _deleteNote(noteId) {
  const note = _notes.find(n => n.id === noteId);
  if (!note) return;
  if (_vaultSettings.filesAndLinks.confirmDelete) {
    const confirmed = await styledConfirm(`Delete "${_esc(note.title)}"?`, { confirmText: 'Delete', cancelText: 'Cancel', danger: true });
    if (!confirmed) return;
  }

  // Optimistic: remove immediately
  const noteIdx = _notes.indexOf(note);
  _notes.splice(noteIdx, 1);
  _noteContentCache.delete(noteId);
  _dirtyNoteIds.delete(noteId);
  _cancelSaveTimer(noteId);
  _saveFailures.delete(noteId);
  const hadTab = _openTabs.includes(noteId);
  _openTabs = _openTabs.filter(id => id !== noteId);
  const prevSelected = _selectedNoteId;
  if (_selectedNoteId === noteId) {
    _selectedNoteId = _openTabs.length ? _openTabs[_openTabs.length - 1] : null;
    const preview = document.getElementById('vault-preview');
    if (preview) {
      if (_selectedNoteId) {
        const nextNote = _notes.find(n => n.id === _selectedNoteId);
        if (nextNote) _selectNote(_selectedNoteId);
      } else {
        preview.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;">Select a note to view</div>';
      }
    }
    _renderRightSidebar(_selectedNoteId ? _notes.find(n => n.id === _selectedNoteId) : null);
  }
  _renderFolderTree();
  _renderNoteTabs();
  _renderNoteList();

  try {
    const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(noteId)}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
    if (!r.ok) throw new Error();
  } catch (e) {
    // Rollback
    console.error('[vault] delete failed, rolling back', e);
    _notes.splice(noteIdx, 0, note);
    if (hadTab && !_openTabs.includes(noteId)) _openTabs.push(noteId);
    _selectedNoteId = prevSelected;
    _renderFolderTree();
    _renderNoteTabs();
    _renderNoteList();
    if (_selectedNoteId === noteId) _selectNote(noteId);
    showToast('Failed to delete note');
  }
}
function _copyVaultUrl(noteId) {
  const note = _notes.find(n => n.id === noteId);
  if (!note) return;
  const url = `vault://open?vault=${encodeURIComponent(_selectedVaultId || '')}&file=${encodeURIComponent(note.title)}`;
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url);
}
async function _getOrCreateNoteByTitle(title) {
  const titleLower = title.toLowerCase();
  let note = _notes.find(n => n.title && n.title.toLowerCase() === titleLower);
  if (note) return note;
  const fileName = title.endsWith('.md') ? title : `${title}.md`;

  // Optimistic
  const optimisticNote = {
    id: fileName,
    rel_path: fileName,
    folder: '',
    title: title,
    content: '',
    frontmatter: {},
    tags: [],
    outbound_links: [],
    backlinks: [],
    last_modified_src: new Date().toISOString(),
    sync_status: 'synced',
  };
  _notes.push(optimisticNote);
  _notes.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  _renderFolderTree();

  try {
    const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(fileName)}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ content: '' }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      const newId = data.new_path || (data.result && data.result.path) || fileName;
      if (newId !== fileName) {
        _syncNoteIdAfterMove(fileName, newId);
        optimisticNote.id = newId;
        optimisticNote.rel_path = newId;
      }
      return optimisticNote;
    }
  } catch (e) {
    console.error('[vault] create ghost note failed', e);
  }
  // Rollback on failure
  const idx = _notes.findIndex(n => n.id === fileName || n.rel_path === fileName);
  if (idx !== -1) _notes.splice(idx, 1);
  _renderFolderTree();
  return null;
}

async function _refreshFileExplorer() {
  if (!_selectedVaultId) return;
  await _loadNotes().catch(() => {});
  await _loadFolders().catch(() => {});
  _renderFolderTree();
  _renderNoteList();
  if (_selectedNoteId) {
    _renderRightSidebar(_notes.find(n => n.id === _selectedNoteId) || null);
  }
}

async function _createNoteInFolder(folder) {
  const fileName = _findUniqueUntitled('Untitled', _notes, '.md');
  _noteContentCache.delete(fileName);
  _dirtyNoteIds.delete(fileName);
  _cancelSaveTimer(fileName);
  _saveFailures.delete(fileName);
  const title = fileName.replace(/\.md$/, '');
  const optimisticNote = {
    id: fileName,
    rel_path: fileName,
    folder: folder || '',
    title: title,
    content: '',
    frontmatter: {},
    tags: [],
    outbound_links: [],
    backlinks: [],
    last_modified_src: new Date().toISOString(),
    sync_status: 'synced',
    _optimistic: true,
  };
  _notes.push(optimisticNote);
  _notes.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  _renderFolderTree();
  _navigateToNote(fileName, true, true);

  try {
    const r = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(fileName)}/edit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ content: '' }),
    });
    if (!r.ok) throw new Error();

    if (folder) {
      try {
        const moveR = await fetch(`${API_BASE}/api/vault/notes/${encodeURIComponent(fileName)}/move`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ folder }),
        });
        if (moveR.ok) {
          const data = await moveR.json().catch(() => ({}));
          if (data.new_path) {
            _syncNoteIdAfterMove(fileName, data.new_path);
            optimisticNote.id = data.new_path;
            optimisticNote.rel_path = data.new_path;
            optimisticNote.folder = folder;
          }
        }
      } catch {}
    }
    delete optimisticNote._optimistic;
    _autoRenameNoteId = optimisticNote.id;
  } catch (e) {
    console.error('[vault] create note failed', e);
    const idx = _notes.findIndex(n => n.id === fileName || n.rel_path === fileName);
    if (idx !== -1) _notes.splice(idx, 1);
    _renderFolderTree();
    showToast('Failed to create note');
  }
}
async function _promptNewFolder(parent) {
  const allFolders = new Set();
  _notes.forEach(n => { if (n.folder) allFolders.add(n.folder); });
  _folders.forEach(f => allFolders.add(f));
  const base = _findUniqueUntitled('Untitled Folder', Array.from(allFolders).map(f => ({ id: f, rel_path: f })));
  const path = parent ? `${parent}/${base}` : base;

  // Optimistic
  _folders.push(path);
  _folders.sort();
  const _optimisticFolderPath = path;
  _expandedFolders.add(path);
  _renderFolderTree();
  setTimeout(() => _startInlineFolderRename(path), 50);

  try {
    const r = await fetch(`${API_BASE}/api/vault/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ path }),
    });
    if (!r.ok) throw new Error();
    const idx2 = _folders.indexOf(_optimisticFolderPath);
    if (idx2 !== -1) delete _folders[idx2]._optimistic;
  } catch (e) {
    console.error('[vault] create folder failed', e);
    const idx = _folders.indexOf(path);
    if (idx !== -1) _folders.splice(idx, 1);
    _renderFolderTree();
    showToast('Failed to create folder');
  }
}
function _startInlineFolderRename(folderPath) {
  // Find the folder row in the tree and make its label editable
  const tree = document.getElementById('vault-folder-tree');
  if (!tree) return;
  const row = tree.querySelector(`.vault-tree-row[data-folder="${CSS.escape(folderPath)}"] .vault-tree-name`);
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
      const r = await fetch(`${API_BASE}/api/vault/folders/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ old_path: folderPath, new_path: newPath }),
      });
      if (!r.ok) throw new Error();
      await _loadFolders();
      await _loadNotes();
      _renderFolderTree();
    } catch (e) {
      console.error('[vault] rename folder failed', e);
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
  const tree = document.getElementById('vault-folder-tree');
  if (!tree) return;
  tree.querySelectorAll('[data-folder]').forEach(row => {
    const folder = row.dataset.folder;
    if (folder) _expandedFolders.add(folder);
  });
}
async function _promptRenameFolder(folder) {
  const newName = await styledPrompt('Rename folder:', { defaultValue: folder.split('/').pop(), confirmText: 'Rename' });
  if (!newName || newName === folder.split('/').pop()) return;
  try {
    const parent = folder.includes('/') ? folder.split('/').slice(0, -1).join('/') : '';
    const newPath = parent ? `${parent}/${newName}` : newName;
    const r = await fetch(`${API_BASE}/api/vault/folders/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ old_path: folder, new_path: newPath }),
    });
    if (!r.ok) throw new Error();
    await _loadNotes();
    await _loadFolders();
    _renderFolderTree();
  } catch (e) {
    console.error('[vault] rename folder failed', e);
  }
}

function _showVaultSettings() {
  _switchTab('permissions');
}

function _openVaultDialog(vaultId) {
  const vault = _vaults.find(v => v.id === vaultId);
  if (!vault) return;
  const dialog = document.getElementById('vault-vault-dialog');
  const nameInput = document.getElementById('vault-vault-dialog-name');
  const pathInput = document.getElementById('vault-vault-dialog-path');
  const countEl = document.getElementById('vault-vault-dialog-count');
  const titleEl = document.getElementById('vault-vault-dialog-title');
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

  const closeBtn = document.getElementById('vault-vault-dialog-close');
  const cancelBtn = document.getElementById('vault-vault-dialog-cancel');
  const removeBtn = document.getElementById('vault-vault-dialog-remove');

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

// ── Sidebar tab drag-and-drop ───────────────────────────────

function _wireSidebarTabDnD(containerId, settingsKey) {
  const container = document.getElementById(containerId);
  if (!container) return;
  let draggedTab = null;
  let lastHoverTarget = null;
  const isRight = containerId === 'vault-right-tabs';
  const tabSelector = isRight ? '.vault-right-tab' : '.vault-sidebar-tab';

  function _clearDropIndicators() {
    container.querySelectorAll(tabSelector).forEach(t => {
      t.style.borderLeft = '';
      t.style.borderRight = '';
    });
    lastHoverTarget = null;
  }

  container.addEventListener('dragstart', (e) => {
    draggedTab = e.target.closest(tabSelector);
    if (!draggedTab) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedTab.dataset.tab);
    draggedTab.classList.add('dragging');
  });

  container.addEventListener('dragend', (e) => {
    if (draggedTab) draggedTab.classList.remove('dragging');
    draggedTab = null;
    _clearDropIndicators();
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggedTab) return;
    const target = e.target.closest(tabSelector);
    if (!target || target === draggedTab) {
      if (lastHoverTarget) _clearDropIndicators();
      return;
    }
    if (target === lastHoverTarget) return;
    _clearDropIndicators();
    lastHoverTarget = target;
    const rect = target.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    if (e.clientX < midX) target.style.borderLeft = '2px solid var(--accent, var(--red, #4a9eff))';
    else target.style.borderRight = '2px solid var(--accent, var(--red, #4a9eff))';
  });

  container.addEventListener('dragleave', (e) => {
    if (!container.contains(e.relatedTarget)) {
      _clearDropIndicators();
    }
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    _clearDropIndicators();
    if (!draggedTab) return;
    draggedTab.classList.remove('dragging');

    const target = e.target.closest(tabSelector);
    if (target && target !== draggedTab) {
      const rect = target.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (e.clientX < midX) {
        container.insertBefore(draggedTab, target);
      } else {
        container.insertBefore(draggedTab, target.nextElementSibling);
      }
    } else if (!target) {
      // Dropped on container empty space — append to end
      container.appendChild(draggedTab);
    }

    const newOrder = Array.from(container.children).map(t => t.dataset.tab);
    if (!_vaultSettings.appearance) _vaultSettings.appearance = {};
    _vaultSettings.appearance[settingsKey] = newOrder;
    _saveVaultSettings();
  });
}

function _applySidebarOrder(containerId, settingsKey) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const order = _vaultSettings?.appearance?.[settingsKey];
  if (!order || !order.length) return;
  const tabs = Array.from(container.children);
  const tabMap = new Map(tabs.map(t => [t.dataset.tab, t]));
  for (const tabId of order) {
    const tab = tabMap.get(tabId);
    if (tab) container.appendChild(tab);
  }
}

// ── Panel-aware tab drag-and-drop ──────────────────────────

function _wirePanelDnD() {
  let _panelDraggedTab = null;
  let _panelDragSource = null;
  let _activeEdge = null;        // { panelId, edge }
  let _lastTabTarget = null;     // { tab, side } for reorder indicators
  let _lastEdgeKey = null;       // "panelId:edge" string to avoid flicker

  function _clearTabIndicators(container) {
    if (!container) container = document;
    container.querySelectorAll('.vault-right-tab, .vault-sidebar-tab').forEach(t => {
      t.classList.remove('drop-target-left', 'drop-target-right');
    });
  }

  function _clearEdgeIndicators() {
    document.querySelectorAll('.vault-panel-edge-zone').forEach(z => z.classList.remove('active'));
    _activeEdge = null;
    _lastEdgeKey = null;
  }

  function _clearAllIndicators() {
    _clearTabIndicators();
    _clearEdgeIndicators();
    _lastTabTarget = null;
  }

  function _ensureEdgeZones(panelGroup) {
    if (panelGroup.querySelector('.vault-panel-edge-zone')) return;
    for (const edge of ['top', 'bottom', 'left', 'right']) {
      const zone = document.createElement('div');
      zone.className = 'vault-panel-edge-zone';
      zone.dataset.edge = edge;
      zone.dataset.panelId = panelGroup.dataset.panelId;
      panelGroup.appendChild(zone);
    }
  }

  function _getClosestEdge(rect, x, y) {
    const thresholdY = Math.max(80, rect.height * 0.15);
    const thresholdX = Math.max(80, rect.width * 0.15);
    const distTop = y - rect.top;
    const distBottom = rect.bottom - y;
    const distLeft = x - rect.left;
    const distRight = rect.right - x;
    const distances = [
      { edge: 'top', dist: distTop, thresh: thresholdY },
      { edge: 'bottom', dist: distBottom, thresh: thresholdY },
      { edge: 'left', dist: distLeft, thresh: thresholdX },
      { edge: 'right', dist: distRight, thresh: thresholdX },
    ];
    const closest = distances.reduce((a, b) => a.dist < b.dist ? a : b);
    if (closest.dist >= 0 && closest.dist <= closest.thresh) return closest.edge;
    return null;
  }

  document.addEventListener('dragstart', (e) => {
    const tab = e.target.closest('.vault-right-tab, .vault-sidebar-tab');
    if (!tab) return;
    const panelGroup = tab.closest('.vault-panel-group');
    if (!panelGroup) return;
    _panelDraggedTab = tab;
    _panelDragSource = panelGroup.dataset.panelId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab.dataset.tab);
    e.dataTransfer.setData('application/x-vault-tab', tab.dataset.tab);
    tab.classList.add('dragging');
    console.log('[DND] dragstart tab:', tab.dataset.tab, 'sourcePanel:', _panelDragSource);
    document.querySelectorAll('.vault-panel-group').forEach(_ensureEdgeZones);
  });

  document.addEventListener('dragend', (e) => {
    if (_panelDraggedTab) _panelDraggedTab.classList.remove('dragging');
    _panelDraggedTab = null;
    _panelDragSource = null;
    document.querySelectorAll('.vault-panel-resize-v, .vault-panel-resize-h').forEach(h => {
      h.style.borderColor = '';
      h.style.opacity = '';
    });
    _clearAllIndicators();
  });

  document.addEventListener('dragover', (e) => {
    if (!_panelDraggedTab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const tabContainer = e.target.closest('.vault-right-tabs, .vault-sidebar-tabs');
    const panelGroup = e.target.closest('.vault-panel-group');
    const leftPane = e.target.closest('.vault-left-pane');
    const resizeHandle = e.target.closest('.vault-panel-resize-v, .vault-panel-resize-h');

    // ── 1. Hovering over a resize handle = create panel between ──
    if (resizeHandle) {
      _clearTabIndicators();
      _lastTabTarget = null;
      const isV = resizeHandle.classList.contains('vault-panel-resize-v');
      const siblings = Array.from(resizeHandle.parentNode.children);
      const idx = siblings.indexOf(resizeHandle);
      const before = siblings[idx - 1];
      const after = siblings[idx + 1];
      if (!before || !after) { _clearEdgeIndicators(); return; }
      const edgeKey = `between:${before.dataset.panelId || 'row'}`;
      if (edgeKey !== _lastEdgeKey) {
        _clearEdgeIndicators();
        _activeEdge = { panelId: before.dataset.panelId || before.closest('.vault-panel-group')?.dataset.panelId, edge: isV ? 'bottom' : 'right', between: true, before: before.dataset.panelId, after: after.dataset.panelId };
        _lastEdgeKey = edgeKey;
        // Show a thin line on the resize handle itself
        resizeHandle.style.borderColor = 'var(--accent, var(--red, #4a9eff))';
        resizeHandle.style.opacity = '1';
      }
      return;
    }
    // Clear any resize handle highlight when not hovering on one
    document.querySelectorAll('.vault-panel-resize-v, .vault-panel-resize-h').forEach(h => {
      h.style.borderColor = '';
      h.style.opacity = '';
    });

    if (tabContainer) {
      const target = e.target.closest('.vault-right-tab, .vault-sidebar-tab');
      if (target && target !== _panelDraggedTab) {
        // ── Tab reorder zone ──
        _clearEdgeIndicators();
        const rect = target.getBoundingClientRect();
        const side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
        if (!_lastTabTarget || _lastTabTarget.tab !== target || _lastTabTarget.side !== side) {
          _clearTabIndicators(tabContainer);
          target.classList.add(side === 'left' ? 'drop-target-left' : 'drop-target-right');
          _lastTabTarget = { tab: target, side };
        }
      } else if (!target) {
        // ── Empty space in tab container = drop on panel bottom edge ──
        if (_lastTabTarget) { _clearTabIndicators(tabContainer); _lastTabTarget = null; }
        const pg = tabContainer.closest('.vault-panel-group');
        if (pg) {
          const edgeKey = `${pg.dataset.panelId}:bottom`;
          if (edgeKey !== _lastEdgeKey) {
            _clearEdgeIndicators();
            const zone = pg.querySelector('.vault-panel-edge-zone[data-edge="bottom"]');
            if (zone) {
              zone.classList.add('active');
              _activeEdge = { panelId: pg.dataset.panelId, edge: 'bottom' };
              _lastEdgeKey = edgeKey;
            }
          }
        }
      }
    } else if (panelGroup) {
      // ── Panel edge zone ──
      if (_lastTabTarget) { _clearTabIndicators(); _lastTabTarget = null; }
      // Suppress edge indicators on source panel if it only has 1 tab (the dragged one)
      const sourcePanelEl = document.querySelector(`.vault-panel-group[data-panel-id="${_esc(_panelDragSource)}"]`);
      const sourceTabCount = sourcePanelEl ? sourcePanelEl.querySelectorAll('.vault-right-tab, .vault-sidebar-tab').length : 0;
      const isSourcePanel = panelGroup.dataset.panelId === _panelDragSource;
      if (isSourcePanel && sourceTabCount <= 1) {
        _clearEdgeIndicators();
        return;
      }
      const rect = panelGroup.getBoundingClientRect();
      const edge = _getClosestEdge(rect, e.clientX, e.clientY);
      const edgeKey = edge ? `${panelGroup.dataset.panelId}:${edge}` : null;
      if (edgeKey !== _lastEdgeKey) {
        _clearEdgeIndicators();
        if (edge) {
          const zone = panelGroup.querySelector(`.vault-panel-edge-zone[data-edge="${_esc(edge)}"]`);
          if (zone) {
            zone.classList.add('active');
            _activeEdge = { panelId: panelGroup.dataset.panelId, edge };
            _lastEdgeKey = edgeKey;
          }
        }
      }
    } else if (leftPane) {
      if (_lastTabTarget) { _clearTabIndicators(); _lastTabTarget = null; }
      const rect = leftPane.getBoundingClientRect();
      const edge = _getClosestEdge(rect, e.clientX, e.clientY);
      const edgeKey = edge ? `left-1:${edge}` : null;
      if (edgeKey !== _lastEdgeKey) {
        _clearEdgeIndicators();
        if (edge) {
          let indicator = leftPane.querySelector('.vault-panel-edge-zone.active');
          if (!indicator) {
            indicator = document.createElement('div');
            indicator.className = 'vault-panel-edge-zone active';
            indicator.style.cssText = 'position:absolute;z-index:50;pointer-events:none;background:var(--accent, var(--red, #4a9eff));';
            indicator.dataset.edge = edge;
            leftPane.style.position = 'relative';
            leftPane.appendChild(indicator);
          }
          if (edge === 'top' || edge === 'bottom') {
            indicator.style.left = '0'; indicator.style.right = '0'; indicator.style.height = '1px';
            indicator.style.top = edge === 'top' ? '0' : 'auto';
            indicator.style.bottom = edge === 'bottom' ? '0' : 'auto';
            indicator.style.width = '';
          } else {
            indicator.style.top = '0'; indicator.style.bottom = '0'; indicator.style.width = '1px';
            indicator.style.left = edge === 'left' ? '0' : 'auto';
            indicator.style.right = edge === 'right' ? '0' : 'auto';
            indicator.style.height = '';
          }
          _activeEdge = { panelId: 'left-1', edge, isLeftPane: true };
          _lastEdgeKey = edgeKey;
        }
      }
    } else {
      _clearAllIndicators();
    }
  });

  document.addEventListener('drop', (e) => {
    if (!_panelDraggedTab) return;
    e.preventDefault();
    const tabName = _panelDraggedTab.dataset.tab;
    const sourcePanel = _panelDragSource;
    console.log('[DND] drop tab:', tabName, 'sourcePanel:', sourcePanel, 'target:', e.target.className);

    const tabContainer = e.target.closest('.vault-right-tabs, .vault-sidebar-tabs');
    const panelGroup = e.target.closest('.vault-panel-group');
    const leftPane = e.target.closest('.vault-left-pane');
    const resizeHandle = e.target.closest('.vault-panel-resize-v, .vault-panel-resize-h');

    if (resizeHandle && _activeEdge?.between) {
      // Dropped on a resize handle = create panel between two panels
      console.log('[DND] dropping between panels:', _activeEdge.before, 'and', _activeEdge.after);
      _moveTabToNewPanel(tabName, sourcePanel, _activeEdge.edge, _activeEdge.before);
    } else if (tabContainer) {
      const targetPanel = tabContainer.closest('.vault-panel-group')?.dataset.panelId;
      const target = e.target.closest('.vault-right-tab, .vault-sidebar-tab');
      console.log('[DND] tabContainer found, targetPanel:', targetPanel, 'target:', target?.dataset?.tab);

      if (targetPanel && targetPanel !== sourcePanel) {
        console.log('[DND] moving to different panel');
        _moveTabToPanel(tabName, sourcePanel, targetPanel);
      } else if (targetPanel === sourcePanel && target && target !== _panelDraggedTab) {
        console.log('[DND] reordering in same panel');
        const rect = target.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        if (e.clientX < midX) {
          tabContainer.insertBefore(_panelDraggedTab, target);
        } else {
          tabContainer.insertBefore(_panelDraggedTab, target.nextElementSibling);
        }
        const panel = _getPanelConfig(sourcePanel);
        if (panel) {
          const side = panel.side;
          const settingsKey = side === 'right' ? 'rightSidebarOrder' : 'leftSidebarOrder';
          const newOrder = Array.from(tabContainer.children).map(t => t.dataset.tab);
          if (!_vaultSettings.appearance) _vaultSettings.appearance = {};
          _vaultSettings.appearance[settingsKey] = newOrder;
          _saveVaultSettings();
        }
      }
    } else if ((panelGroup || leftPane) && _activeEdge) {
      const targetPanelId = _activeEdge.panelId;
      console.log('[DND] dropping on edge:', _activeEdge.edge, 'of panel:', targetPanelId);
      _moveTabToNewPanel(tabName, sourcePanel, _activeEdge.edge);
    } else {
      console.log('[DND] dropped in unrecognized area');
    }

    // Cleanup
    document.querySelectorAll('.vault-panel-resize-v, .vault-panel-resize-h').forEach(h => {
      h.style.borderColor = '';
      h.style.opacity = '';
    });
    document.querySelectorAll('.vault-left-pane .vault-panel-edge-zone').forEach(el => el.remove());
    _clearAllIndicators();
    _panelDraggedTab = null;
    _panelDragSource = null;
  });
}

function _wirePanelResizers() {
  let _resizingHandle = null;
  let _resizingStart = 0;
  let _panelA = null;
  let _panelB = null;
  let _aStartSize = 0;
  let _bStartSize = 0;
  let _isHorizontal = false; // true for .vault-panel-resize-h (col-resize)

  document.addEventListener('mousedown', (e) => {
    const vHandle = e.target.closest('.vault-panel-resize-v');
    const hHandle = e.target.closest('.vault-panel-resize-h');
    if (!vHandle && !hHandle) return;
    e.preventDefault();
    _resizingHandle = vHandle || hHandle;
    _isHorizontal = !!hHandle;

    if (vHandle) {
      // Vertical: find panels above and below in stack
      _resizingStart = e.clientY;
      const stack = vHandle.closest('.vault-panel-stack');
      if (!stack) return;
      const children = Array.from(stack.children);
      const idx = children.indexOf(vHandle);
      _panelA = children[idx - 1];
      _panelB = children[idx + 1];
      if (!_panelA || !_panelB) return;
      if (!_panelA.classList.contains('vault-panel-group') || _panelA.classList.contains('hidden')) return;
      if (!_panelB.classList.contains('vault-panel-group') || _panelB.classList.contains('hidden')) return;
      const aRect = _panelA.getBoundingClientRect();
      const bRect = _panelB.getBoundingClientRect();
      _aStartSize = aRect.height;
      _bStartSize = bRect.height;
      document.body.style.cursor = 'row-resize';
    } else {
      // Horizontal: find panels left and right in row
      _resizingStart = e.clientX;
      const row = hHandle.closest('.vault-panel-row');
      if (!row) return;
      const children = Array.from(row.children);
      const idx = children.indexOf(hHandle);
      _panelA = children[idx - 1];
      _panelB = children[idx + 1];
      if (!_panelA || !_panelB) return;
      if (!_panelA.classList.contains('vault-panel-group') || _panelA.classList.contains('hidden')) return;
      if (!_panelB.classList.contains('vault-panel-group') || _panelB.classList.contains('hidden')) return;
      const aRect = _panelA.getBoundingClientRect();
      const bRect = _panelB.getBoundingClientRect();
      _aStartSize = aRect.width;
      _bStartSize = bRect.width;
      document.body.style.cursor = 'col-resize';
    }
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!_resizingHandle || !_panelA || !_panelB) return;
    if (_isHorizontal) {
      const delta = e.clientX - _resizingStart;
      const total = _aStartSize + _bStartSize;
      const aW = Math.max(100, Math.min(total - 100, _aStartSize + delta));
      const bW = total - aW;
      _panelA.style.flexGrow = String((aW / total) * 100);
      _panelB.style.flexGrow = String((bW / total) * 100);
    } else {
      const delta = e.clientY - _resizingStart;
      const total = _aStartSize + _bStartSize;
      const aH = Math.max(60, Math.min(total - 60, _aStartSize + delta));
      const bH = total - aH;
      _panelA.style.flexGrow = String((aH / total) * 100);
      _panelB.style.flexGrow = String((bH / total) * 100);
    }
  });

  document.addEventListener('mouseup', () => {
    if (_resizingHandle) {
      _resizingHandle = null;
      _panelA = null;
      _panelB = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      _isHorizontal = false;
    }
  });
}

// ── Init wiring ──────────────────────────────────────────────

function _init() {
  // Wire deferred DOM listeners that were previously at module level
  _wireCloseButton();
  _wireBackdropClick();
  _wireAddVaultForm();

  // Left sidebar tabs - delegated to panel groups
  document.querySelectorAll('.vault-sidebar-tabs').forEach(container => {
    container.addEventListener('click', (e) => {
      const tab = e.target.closest('.vault-sidebar-tab');
      if (!tab) return;
      const panelGroup = tab.closest('.vault-panel-group');
      const panelId = panelGroup?.dataset.panelId;
      if (panelId) _switchLeftTab(tab.dataset.tab);
      else _switchLeftTab(tab.dataset.tab);
    });
    container.addEventListener('contextmenu', (e) => {
      _showTabContextMenu(e, container.dataset.panelId || 'left-1');
    });
  });

  // Right sidebar tabs - delegated to panel groups
  document.querySelectorAll('.vault-right-tabs').forEach(container => {
    container.addEventListener('click', (e) => {
      const tab = e.target.closest('.vault-right-tab');
      if (!tab) return;
      const panelGroup = tab.closest('.vault-panel-group');
      const panelId = panelGroup?.dataset.panelId;
      _switchRightTab(tab.dataset.tab, panelId);
    });
    container.addEventListener('contextmenu', (e) => {
      _showTabContextMenu(e, container.dataset.panelId || 'right-1');
    });
  });

  // Sidebar tab drag-and-drop
  _wireSidebarTabDnD('vault-left-tabs', 'leftSidebarOrder');
  // Right tabs DND is handled by _wirePanelDnD (inter-panel + intra-panel)
  _applySidebarOrder('vault-left-tabs', 'leftSidebarOrder');
  _applySidebarOrder('vault-right-tabs', 'rightSidebarOrder');

  // Panel-aware inter-panel drag-and-drop
  _wirePanelDnD();

  // Panel resizers
  _wirePanelResizers();

  // Search input + clear + case + semantic + sort + settings
  const searchInput = document.getElementById('vault-search-input');
  const clearBtn = document.getElementById('vault-search-clear');
  const caseBtn = document.getElementById('vault-search-case');
  const semanticBtn = document.getElementById('vault-search-semantic');
  const sortBtn = document.getElementById('vault-search-sort-btn');
  const sortDropdown = document.getElementById('vault-search-sort-dropdown');
  const settingsBtn = document.getElementById('vault-search-settings-btn');
  const settingsPanel = document.getElementById('vault-search-settings');

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

  if (semanticBtn) {
    semanticBtn.classList.toggle('active', _searchState.semantic);
    semanticBtn.addEventListener('click', () => {
      _searchState.semantic = !_searchState.semantic;
      semanticBtn.classList.toggle('active', _searchState.semantic);
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
    sortDropdown.querySelectorAll('.vault-search-sort-item').forEach(item => {
      item.addEventListener('click', () => {
        _searchState.sortBy = item.dataset.sort;
        sortDropdown.querySelectorAll('.vault-search-sort-item').forEach(i => i.classList.remove('active'));
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
    const collapseCb = document.getElementById('vault-search-collapse');
    const contextCb = document.getElementById('vault-search-context');
    const explainCb = document.getElementById('vault-search-explain');
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

  // Settings dialog wiring
  _wireVaultSettings();
  _wireSnippetSettings();
  _injectCssSnippets();
  _loadVaultSettings();
  _rebuildPanelsFromSettings();
  const dv = _vaultSettings.editor.defaultView;
  _previewMode = dv === 'live' ? 'live' : dv === 'source' ? 'edit' : 'preview';
  _editModePref = dv === 'source' ? 'edit' : 'live';
  _sourceModeEnabled = dv === 'source';
  _applyMonospaceFont();
  _applyReadableLineLength();
  _renderRibbon();

  // ── Plugin System (Phase 4.1 / 4.2) ────────────────────────
  _vaultApp = createAppApi({
    get vaultNotes() { return _notes; },
    get vaultFolders() { return _folders; },
    getActiveFileId: () => _selectedNoteId,
    onOpenLink: (text) => {
      const target = _notes.find(n => n.title === text);
      if (target) _navigateToNote(target.id, true, false);
    },
    _insertTemplate: () => _insertTemplate(),
    _createNoteFromTemplate: (folder) => _createNoteFromTemplate(folder),
  });
  _pluginManager = new PluginManager(_vaultApp);

  // Register all core plugins (existing features become toggleable)
  const _manifest = (id) => CORE_PLUGINS.find(m => m.id === id);
  _pluginManager.register(_manifest('graph'),          GraphPlugin);
  _pluginManager.register(_manifest('backlinks'),      BacklinksPlugin);
  _pluginManager.register(_manifest('canvas'),         CanvasPlugin);
  _pluginManager.register(_manifest('command-palette'), CommandPalettePlugin);
  _pluginManager.register(_manifest('daily-notes'),    DailyNotesPlugin);
  _pluginManager.register(_manifest('file-recovery'),  FileRecoveryPlugin);
  _pluginManager.register(_manifest('note-composer'),  NoteComposerPlugin);
  _pluginManager.register(_manifest('outgoing-links'),  OutgoingLinksPlugin);
  _pluginManager.register(_manifest('quick-switcher'), QuickSwitcherPlugin);
  _pluginManager.register(_manifest('templates'),      TemplatesPlugin);
  _pluginManager.register(_manifest('unique-note-creator'), UniqueNoteCreatorPlugin);
  _pluginManager.register(_manifest('unlinked'),       UnlinkedMentionsPlugin);
  _pluginManager.register(_manifest('outline'),        OutlinePlugin);
  _pluginManager.register(_manifest('orphans'),          OrphansPlugin);
  _pluginManager.register(_manifest('bookmarks'),        BookmarksPlugin);
  _pluginManager.register(_manifest('tags'),           TagsPlugin);
  _pluginManager.register(_manifest('search'),          SearchPlugin);
  _pluginManager.register(_manifest('page-preview'),   PagePreviewPlugin);
  _pluginManager.register(_manifest('word-count'),     WordCountPlugin);
  _pluginManager.register(_manifest('random-note'),    RandomNotePlugin);

  // Default: enable everything on first run, then respect persisted settings
  try {
    let settings = JSON.parse(localStorage.getItem('vault-settings') || '{}');
    if (!settings.enabledPlugins) {
      settings.enabledPlugins = CORE_PLUGINS.map(m => m.id);
    }
    _pluginManager.loadFromSettings(settings).then(() => {
      _syncPluginTabs();
    }).catch(() => {
      _syncPluginTabs();
    });
  } catch {
    _syncPluginTabs();
  }

  // ── Community Plugin System (Phase 5) ──────────────────────
  // Make toast available globally so plugin loader can show notifications
  window._showVaultToast = (msg, opts) => {
    const type = opts?.type;
    if (type === 'error') showError(msg);
    else showToast(msg, opts?.duration || 4000);
  };
  window.showError = showError; // fallback

  // Set up the community plugin manager
  setPluginManager(_pluginManager);
  loadAllEnabledPlugins(_pluginManager).catch(err => {
    console.warn('[vault] Community plugin startup error:', err);
  });

  // Pre-fetch the registry in background so browsing is snappy
  fetchObsidianRegistry().catch(() => {});

  // ── Eager cache restore so openPanel() never blocks on "Loading vaults..." ──
  _restoreVaultsAndWarmCache();

}

function _restoreVaultsAndWarmCache() {
  try {
    const cached = localStorage.getItem('vault-vaults');
    if (cached) {
      const { vaults } = JSON.parse(cached);
      if (vaults && vaults.length) {
        _vaults = vaults;
        _populateVaultDropdown();
        let lastVault = null;
        try { lastVault = localStorage.getItem('vault-last-vault'); } catch {}
        const target = _vaults.find(v => v.id === lastVault) ? lastVault : _vaults[0].id;
        if (target) {
          // Fire off vault selection in background so notes/folders are
          // restored from cache too — by the time the user opens the panel
          // everything is already in memory.
          _selectVault(target);
        }
      }
    }
  } catch {}
}

/** Show / hide tab buttons based on plugin state and panel membership */
function _syncPluginTabs() {
  if (!_pluginManager) return;

  const hiddenRight = new Set(_vaultSettings.appearance?.hiddenRightTabs || []);
  const rightOrder = ['backlinks', 'outgoing', 'unlinked', 'outline', 'orphans', 'local-graph'];
  const leftOrder = ['files', 'bookmarks', 'tags', 'graph', 'search'];
  const pluginMap = {
    backlinks: 'backlinks',
    outgoing: 'outgoing-links',
    unlinked: 'unlinked',
    outline: 'outline',
    orphans: 'orphans',
    bookmarks: 'bookmarks',
    tags: 'tags',
    search: 'search',
    graph: 'graph',
  };

  // Sync each panel independently
  for (const panel of (_vaultSettings.panels || [])) {
    if (!Array.isArray(panel.tabs)) continue;
    const tabsContainer = _getPanelTabsContainer(panel.id);
    if (!tabsContainer) continue;
    const order = panel.side === 'right' ? rightOrder : leftOrder;

    // Hide tabs that don't belong or should be hidden;
    // show tabs that belong and should be visible
    tabsContainer.querySelectorAll(':scope > [data-tab]').forEach(btn => {
      const tab = btn.dataset.tab;
      const belongs = panel.tabs.includes(tab);
      if (!belongs) {
        btn.classList.add('hidden');
        return;
      }
      const pid = pluginMap[tab];
      const shouldShow = pid ? _pluginManager.isEnabled(pid) : !hiddenRight.has(tab);
      btn.classList.toggle('hidden', !shouldShow);
    });

    _updatePanelVisibility(panel.id);

    // If active tab is now hidden, switch to first visible
    const activeTab = _getActiveTabForPanel(panel.id);
    if (activeTab) {
      const activeBtn = tabsContainer.querySelector(`[data-tab="${_esc(activeTab)}"]:not(.hidden)`);
      if (!activeBtn) {
        const firstVisible = tabsContainer.querySelector('[data-tab]:not(.hidden)');
        if (firstVisible) {
          if (panel.side === 'right') _switchRightTab(firstVisible.dataset.tab, panel.id);
          else _switchLeftTab(firstVisible.dataset.tab);
        }
      }
    }
  }

  _updateRightPanelVisibility();
}

// ── Command Palette / Quick Switcher (Phase 2.5) ───────────

let _quickSwitcherEl = null;
let _quickSwitcherIndex = 0;
let _commandPaletteEl = null;
let _commandPaletteIndex = 0;
let _qsEscHandler = null;
let _cpEscHandler = null;
let _vaultSlashMenu = null;

function _hideQuickSwitcher() {
  if (_qsEscHandler) { document.removeEventListener('keydown', _qsEscHandler, true); _qsEscHandler = null; }
  if (_quickSwitcherEl) { _quickSwitcherEl.remove(); _quickSwitcherEl = null; }
}

function _hideCommandPalette() {
  if (_cpEscHandler) { document.removeEventListener('keydown', _cpEscHandler, true); _cpEscHandler = null; }
  if (_commandPaletteEl) { _commandPaletteEl.remove(); _commandPaletteEl = null; }
}

function _attachVaultSlashMenu(editor) {
  if (!_vaultSlashMenu) _vaultSlashMenu = createVaultSlashMenu();
  _vaultSlashMenu.attach(editor);
}

function _showQuickSwitcher() {
  _hideQuickSwitcher();
  const modal = document.getElementById('vault-modal');
  if (!modal) return;
  const overlay = document.createElement('div');
  overlay.className = 'vault-quick-switcher';
  overlay.innerHTML = `
    <div class="vault-qs-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;">
      <div class="vault-qs-box" style="width:520px;max-width:90vw;background:var(--bg-raised,var(--bg,#1a1a1a));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;overflow:hidden;">
        <input type="text" class="vault-qs-input" placeholder="Quick switcher..." style="width:100%;background:transparent;color:var(--fg);border:none;border-bottom:1px solid var(--border);padding:12px 14px;font-size:15px;outline:none;box-sizing:border-box;" autocomplete="off" spellcheck="false">
        <div class="vault-qs-results" style="max-height:320px;overflow-y:auto;padding:4px 0;"></div>
        <div class="vault-qs-hint" style="padding:6px 14px;font-size:11px;opacity:0.5;border-top:1px solid var(--border);">↑↓ to navigate · Enter to open · Shift+Enter in new tab · Esc to close</div>
      </div>
    </div>
  `;
  modal.appendChild(overlay);
  _quickSwitcherEl = overlay;
  const input = overlay.querySelector('.vault-qs-input');
  const results = overlay.querySelector('.vault-qs-results');

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
      <div class="vault-qs-item" data-note-id="${_esc(n.id)}" data-index="${i}" style="padding:7px 14px;font-size:13px;cursor:pointer;pointer-events:auto;display:flex;align-items:center;gap:8px;border-radius:4px;margin:0 4px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(n.title || n.id)}</span>
        <span style="opacity:0.4;font-size:11px;">${_esc(n.folder || '')}</span>
      </div>
    `).join('');
    _quickSwitcherIndex = 0;
    _updateQsSelection(results);
  };

  const _updateQsSelection = (container) => {
    const allItems = container.querySelectorAll('.vault-qs-item');
    if (_quickSwitcherIndex < 0) _quickSwitcherIndex = 0;
    if (_quickSwitcherIndex >= allItems.length) _quickSwitcherIndex = allItems.length - 1;
    allItems.forEach((el, i) => {
      el.style.background = i === _quickSwitcherIndex ? 'color-mix(in srgb, var(--accent, var(--red)) 15%, transparent)' : 'transparent';
    });
    const selected = container.querySelector(`.vault-qs-item[data-index="${_quickSwitcherIndex}"]`);
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => renderResults(input.value));
  input.addEventListener('keydown', (e) => {
    const items = results.querySelectorAll('.vault-qs-item');
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
      const selected = results.querySelector(`.vault-qs-item[data-index="${_quickSwitcherIndex}"]`);
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
    const item = e.target.closest('.vault-qs-item');
    if (item) {
      _navigateToNote(item.dataset.noteId, true, e.shiftKey);
      _hideQuickSwitcher();
    }
  });

  // Click backdrop to close
  overlay.querySelector('.vault-qs-backdrop').addEventListener('click', (e) => {
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

function _vaultKeyHandler(e) {
  const modal = document.getElementById('vault-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (e.key === 'Escape' && _commandPaletteEl) return;
  if (e.key === 'Escape' && _quickSwitcherEl) return;
  // Manual save: force-save all dirty notes regardless of auto-save mode.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    _saveAllDirty(true);
    return;
  }
  const hotkeys = _vaultSettings.hotkeys || {};
  for (const [cmdId, combo] of Object.entries(hotkeys)) {
    if (!combo || !_matchesVaultCombo(e, combo)) continue;
    e.preventDefault();
    _runCommandById(cmdId);
    return;
  }
}

function _showCommandPalette() {
  _hideCommandPalette();
  const modal = document.getElementById('vault-modal');
  if (!modal) return;
  const overlay = document.createElement('div');
  overlay.className = 'vault-command-palette';
  overlay.innerHTML = `
    <div class="vault-cp-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;">
      <div class="vault-cp-box" style="width:520px;max-width:90vw;background:var(--bg-raised,var(--bg,#1a1a1a));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;overflow:hidden;">
        <input type="text" class="vault-cp-input" placeholder="Type a command..." style="width:100%;background:transparent;color:var(--fg);border:none;border-bottom:1px solid var(--border);padding:12px 14px;font-size:15px;outline:none;box-sizing:border-box;" autocomplete="off" spellcheck="false">
        <div class="vault-cp-results" style="max-height:320px;overflow-y:auto;padding:4px 0;"></div>
        <div class="vault-cp-hint" style="padding:6px 14px;font-size:11px;opacity:0.5;border-top:1px solid var(--border);">↑↓ to navigate · Enter to run · Esc to close</div>
      </div>
    </div>
  `;
  modal.appendChild(overlay);
  _commandPaletteEl = overlay;
  const input = overlay.querySelector('.vault-cp-input');
  const results = overlay.querySelector('.vault-cp-results');

  const BASE_COMMANDS = VAULT_COMMANDS.filter(c => c.impl !== false).map(c => ({
    id: c.id,
    label: c.label,
    action: () => _runCommandById(c.id),
  }));
  // Add plugin commands
  const pluginCmds = _pluginManager ? Array.from(_pluginManager._instances.values()).flatMap(p =>
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
      <div class="vault-cp-item" data-cmd-id="${_esc(c.id)}" data-index="${i}" style="padding:7px 14px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;border-radius:4px;margin:0 4px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(c.label)}</span>
      </div>
    `).join('');
    _commandPaletteIndex = 0;
    _updateCpSelection(results);
  };

  const _updateCpSelection = (container) => {
    container.querySelectorAll('.vault-cp-item').forEach((el, i) => {
      el.style.background = i === _commandPaletteIndex ? 'color-mix(in srgb, var(--accent, var(--red)) 15%, transparent)' : 'transparent';
    });
    const selected = container.querySelector(`.vault-cp-item[data-index="${_commandPaletteIndex}"]`);
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => renderCommands(input.value));
  input.addEventListener('keydown', (e) => {
    const items = results.querySelectorAll('.vault-cp-item');
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
      const selected = results.querySelector(`.vault-cp-item[data-index="${_commandPaletteIndex}"]`);
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
    const item = e.target.closest('.vault-cp-item');
    if (item) {
      const cmd = COMMANDS.find(c => c.id === item.dataset.cmdId);
      if (cmd) cmd.action();
      _hideCommandPalette();
    }
  });

  overlay.querySelector('.vault-cp-backdrop').addEventListener('click', (e) => {
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

let _vaultHtmlLoaded = null;

function _loadVaultHtml() {
  if (_vaultHtmlLoaded) return _vaultHtmlLoaded;
  _vaultHtmlLoaded = (async () => {
    const host = document.getElementById('vault-host');
    if (!host || host.children.length > 0) return;
    try {
      const resp = await fetch('/static/vault.html');
      if (!resp.ok) { console.error('[vault] Failed to load vault.html:', resp.status); return; }
      const html = await resp.text();
      host.innerHTML = html;
    } catch (err) {
      console.error('[vault] Failed to load vault.html:', err);
    }
  })();
  return _vaultHtmlLoaded;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => _loadVaultHtml().then(_init));
} else {
  _loadVaultHtml().then(_init);
}

// Save dirty notes when the window loses focus (VSCode "onWindowChange" mode).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && _vaultSettings?.editor?.autoSave === 'onWindowChange') {
    _saveAllDirty();
  }
});

// Last-resort flush on page unload.
window.addEventListener('beforeunload', () => {
  if (_dirtyNoteIds.size) {
    _saveAllDirty(true);
  }
});

const vaultModule = { openPanel, closePanel, togglePanel, isOpen, toggleBookmark: _toggleBookmark };
export default vaultModule;
window.vaultModule = vaultModule;
