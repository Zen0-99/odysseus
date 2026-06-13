/**
 * Shard Vault — floating modal panel for vault sync, graph, and timeline.
 */

import { makeWindowDraggable } from './windowDrag.js';
import { makeWindowResizable } from './windowResize.js';
import { shardMdToHtml, buildNoteCache } from './shardMarkdown.js';
import { styledConfirm, styledPrompt, showToast } from './ui.js';
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
let _lastClosedTab = null;
let _filePollInterval = null;
let _lastVaultMtime = 0;
let _vaults = [];
let _selectedVaultId = null;
let _permissions = [];
let _pluginManager = null;
let _shardApp = null;
let _removedTabs = new Map(); // tabName -> detached element
let _recentDragNoteId = null; // suppress click after drag-and-drop
let _recentDragTimer = null;
let _isDraggingTree = false; // guard _renderFolderTree during drag
let _propsCollapsed = false; // global collapse state for properties section

function _showLoading(text = 'Loading vault...') {
  const overlay = document.getElementById('shard-loading-overlay');
  const txt = overlay?.querySelector('.shard-loading-text');
  if (overlay) overlay.classList.remove('hidden');
  if (txt) txt.textContent = text;
}
function _hideLoading() {
  document.getElementById('shard-loading-overlay')?.classList.add('hidden');
}

function _startFilePolling() {
  if (_filePollInterval) clearInterval(_filePollInterval);
  _filePollInterval = setInterval(async () => {
    if (!_open || !_selectedVaultId) return;
    try {
      const r = await fetch(`${API_BASE}/api/shard/last-modified?vault_id=${encodeURIComponent(_selectedVaultId)}`, { credentials: 'same-origin' });
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
  _applyMonospaceFont();
  _bringToFront();
  _wireDrag();
  _startFilePolling();
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
  _stopFilePolling();
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

// Re-clamp the shard modal so it stays fully on-screen when the browser/Electron
// window is resized. Floating (dragged/resized) windows have fixed pixel
// positions that can drift off-screen after a viewport shrink.
function _reclampShardModal() {
  const modal = document.getElementById('shard-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (modal.classList.contains('shard-fullscreen')) return;
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
  requestAnimationFrame(_reclampShardModal);
  requestAnimationFrame(() => {
    const bc = document.getElementById('shard-breadcrumb');
    if (bc) _fitBreadcrumb(bc);
  });
});

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
  const isElectron = document.body.classList.contains('electron');
  content.style.width = '100vw';
  content.style.maxWidth = '100vw';
  content.style.height = isElectron ? 'calc(100dvh - 32px)' : '100vh';
  content.style.maxHeight = isElectron ? 'calc(100dvh - 32px)' : '100vh';
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

  // Browse button — prefer Electron IPC directory picker, then file input, then FS Access API
  const browseBtn = document.getElementById('shard-browse-vault-btn');
  const fileInput = document.getElementById('shard-vault-file-input');
  if (browseBtn && fileInput) {
    browseBtn.addEventListener('click', async () => {
      // Electron: use IPC to get real folder path from main process
      if (window.electronAPI?.selectDirectory) {
        try {
          const result = await window.electronAPI.selectDirectory();
          if (result && !result.canceled && result.filePaths?.length) {
            const pathInput = document.getElementById('shard-new-vault-path');
            if (pathInput) pathInput.value = result.filePaths[0];
          }
        } catch (err) {
          console.warn('[shard] electron directory picker failed:', err);
        }
        return;
      }
      // Browser fallback 1: File System Access API (virtual handle, no full path)
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
      // Browser fallback 2: legacy file input (webkitdirectory)
      fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
      const files = e.target.files;
      if (!files || !files.length) return;
      const pathInput = document.getElementById('shard-new-vault-path');
      const relPath = files[0].webkitRelativePath || '';
      const folderName = relPath.split('/')[0] || '';
      const filePath = files[0].path || '';
      let displayPath = '';
      if (filePath && relPath) {
        const relParts = relPath.split('/');
        const sep = filePath.includes('\\') ? '\\' : '/';
        const pathParts = filePath.split(sep);
        const rootParts = pathParts.slice(0, pathParts.length - relParts.length);
        displayPath = rootParts.join(sep);
      } else if (filePath) {
        displayPath = filePath;
      } else {
        displayPath = folderName;
      }
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

  // View mode buttons are wired per-note in _selectNote
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
  const mode = _shardSettings?.filesAndLinks?.defaultFileToOpen || 'last-opened';
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
    const specificFile = _shardSettings?.filesAndLinks?.defaultSpecificFile;
    if (specificFile && _notes.some(n => n.id === specificFile)) {
      _navigateToNote(specificFile, false);
    }
    return;
  }
  // last-opened
  if (_selectedVaultId) {
    try {
      const lastNote = localStorage.getItem(`shard-last-note-${_selectedVaultId}`);
      if (lastNote && _notes.some(n => n.id === lastNote)) {
        _navigateToNote(lastNote, false);
      }
    } catch {}
  }
}

function _openDailyNote() {
  const dateFormat = _shardSettings?.plugins?.['daily-notes']?.dateFormat || 'YYYY-MM-DD';
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
  const folder = _shardSettings?.plugins?.['daily-notes']?.newFileLocation || '';
  const noteId = folder ? `${folder}/${fileName}` : fileName;
  const existing = _notes.find(n => n.id === noteId);
  if (existing) {
    _navigateToNote(noteId, false);
    return;
  }
  // Create daily note if it doesn't exist
  const templatePath = _shardSettings?.plugins?.['daily-notes']?.templateFileLocation || '';
  let content = '';
  if (templatePath) {
    const template = _notes.find(n => n.id === templatePath || n.rel_path === templatePath);
    if (template) content = template.content || '';
  }
  _createNoteWithContent(noteId, content);
}

async function _createNoteWithContent(noteId, content) {
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
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(noteId)}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) throw new Error();
    delete optimisticNote._optimistic;
  } catch (e) {
    console.error('[shard] create note failed', e);
    const idx = _notes.findIndex(n => n.id === noteId);
    if (idx !== -1) _notes.splice(idx, 1);
    _renderFolderTree();
    _renderNoteList();
    if (_selectedNoteId === noteId) _closeCurrentTab();
    showToast('Failed to create note');
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
    const backendFolders = data.folders || [];
    // Preserve optimistic folders not yet confirmed by backend
    const optimisticExtras = _folders.filter(f => typeof f === 'object' && f._optimistic);
    const optimisticStrings = _folders.filter(f => typeof f === 'string' && !backendFolders.includes(f));
    _folders = [...backendFolders, ...optimisticStrings];
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
    const folderSvg = _getFolderIconSvg(node.path, 'folder', 13);
    html += `<li class="${liClass}">
      <div class="shard-tree-row ${depthClass} ${isSelected ? 'selected' : ''}" data-folder="${_esc(node.path)}" draggable="true">
        <span class="shard-tree-arrow ${arrowClass}"></span>
        <span class="shard-tree-folder-icon">${folderSvg}</span>
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
      const iconSvg = _getNoteIconSvg(f.id, 'file', 13);
      html += `<li class="shard-tree-sub">
        <div class="shard-tree-row sub ${f.id === _selectedNoteId ? 'selected' : ''}" data-note-id="${_esc(f.id)}" draggable="true">
          <span class="shard-tree-arrow leaf"></span>
          <span class="shard-tree-file-icon">${iconSvg}</span>
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
  if (_isDraggingTree) return; // defer until dragend so dragged element survives

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

  // Refresh toolbar
  let html = `
    <div class="shard-tree-toolbar" style="display:flex;align-items:center;gap:6px;padding:4px 6px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg);z-index:5;">
      <button id="shard-refresh-tree" title="Refresh explorer" style="background:transparent;border:none;color:var(--fg);cursor:pointer;padding:2px 4px;border-radius:4px;display:flex;align-items:center;opacity:0.7;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-.44-9.41L23 10"></path></svg>
      </button>
      <span style="font-size:11px;opacity:0.5;flex:1;">Files</span>
    </div>
    <ul style="padding-top:4px;">
  `;
  const { childNames } = _sortTreeEntries(root);
  for (const childName of childNames) {
    html += _renderFolderTreeNode(root.children[childName]);
  }
  // Root-level files (notes with no folder)
  const rootFiles = [...root.files].sort((a, b) => a.title.localeCompare(b.title));
  for (const f of rootFiles) {
    const iconSvg = _getNoteIconSvg(f.id, 'file', 13);
    html += `<li class="shard-tree-root">
      <div class="shard-tree-row root ${f.id === _selectedNoteId ? 'selected' : ''}" data-note-id="${_esc(f.id)}" draggable="true">
        <span class="shard-tree-arrow leaf"></span>
        <span class="shard-tree-file-icon">${iconSvg}</span>
        <span class="shard-tree-name">${_esc(f.title)}</span>
      </div>
    </li>`;
  }
  html += '</ul>';
  tree.innerHTML = html;

  // Wire refresh button
  const refreshBtn = tree.querySelector('#shard-refresh-tree');
  if (refreshBtn) {
    refreshBtn.addEventListener('mouseenter', () => { refreshBtn.style.opacity = '1'; });
    refreshBtn.addEventListener('mouseleave', () => { refreshBtn.style.opacity = '0.7'; });
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.style.opacity = '0.3';
      await _refreshFileExplorer();
      refreshBtn.style.opacity = '';
    });
  }

  // Wire interactions — toggle classes directly for smooth animation (no re-render)
  tree.querySelectorAll('.shard-tree-row').forEach(row => {
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

    // Drag start for note / folder rows
    if (row.dataset.noteId || row.dataset.folder) {
      row.addEventListener('dragstart', (e) => {
        _isDraggingTree = true;
        clearTimeout(_recentDragTimer);
        if (row.dataset.noteId) {
          _recentDragNoteId = row.dataset.noteId;
          e.dataTransfer.setData('text/plain', row.dataset.noteId);
        } else if (row.dataset.folder) {
          e.dataTransfer.setData('text/x-shard-folder', row.dataset.folder);
        }
        e.dataTransfer.effectAllowed = 'copy';
        tree.classList.add('shard-dragging');
      });
      row.addEventListener('dragend', () => {
        _isDraggingTree = false;
        tree.classList.remove('shard-dragging');
        tree.classList.remove('shard-root-drag-over');
        _recentDragTimer = setTimeout(() => { _recentDragNoteId = null; }, 200);
        // Re-render after drag completes so the dragged element survives until dragend
        requestAnimationFrame(() => _renderFolderTree());
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
        const targetFolder = row.dataset.folder;
        if (!targetFolder) return;

        const noteId = e.dataTransfer.getData('text/plain');
        const sourceFolder = e.dataTransfer.getData('text/x-shard-folder');

        if (noteId) {
          // Drop note onto folder
          const note = _notes.find(n => n.id === noteId);
          const oldFolder = note ? note.folder : '';
          if (note) note.folder = targetFolder;
          try {
            const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(noteId)}/move`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ folder: targetFolder }),
            });
            if (!r.ok) {
              if (note) note.folder = oldFolder;
              const data = await r.json().catch(() => ({}));
              console.error('[shard] move note failed:', data.detail || r.status);
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
            console.error('[shard] move note error:', err);
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
            const r = await fetch(`${API_BASE}/api/shard/folders/rename`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ old_path: sourceFolder, new_path: newPath }),
            });
            if (!r.ok) throw new Error();
            await _loadFolders();
            await _loadNotes();
          } catch (err) {
            console.error('[shard] move folder failed:', err);
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
      const sourceFolder = e.dataTransfer.getData('text/x-shard-folder');

      if (noteId) {
        // Drop note onto root
        const note = _notes.find(n => n.id === noteId);
        const oldFolder = note ? note.folder : '';
        if (note) note.folder = '';
        try {
          const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(noteId)}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ folder: '' }),
          });
          if (!r.ok) {
            if (note) note.folder = oldFolder;
            const data = await r.json().catch(() => ({}));
            console.error('[shard] move to root failed:', data.detail || r.status);
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
          console.error('[shard] move to root error:', err);
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
          const r = await fetch(`${API_BASE}/api/shard/folders/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ old_path: sourceFolder, new_path: newPath }),
          });
          if (!r.ok) throw new Error();
          await _loadFolders();
          await _loadNotes();
        } catch (err) {
          console.error('[shard] move folder to root failed:', err);
          await _loadFolders();
          await _loadNotes();
        }
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
  _renderBreadcrumb(note || null);
  _updateNavButtons();
  document.querySelectorAll('[data-shard-content]').forEach(p => {
    p.classList.toggle('hidden', p.dataset.shardContent !== 'note');
  });
  _renderFolderTree();
  _updateTreeSelection();
  _selectNote(noteId);
  // Persist last opened note for this vault
  if (_selectedVaultId) {
    try { localStorage.setItem(`shard-last-note-${_selectedVaultId}`, noteId); } catch {}
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
  document.querySelectorAll('[data-shard-content]').forEach(p => {
    p.classList.toggle('hidden', p.dataset.shardContent !== 'graph');
  });
  const container = document.getElementById('shard-main-graph-canvas');
  if (container && window.vis) {
    import('./shardGraphCanvas.js').then(mod => {
      mod.renderShardGraph(container, _selectedVaultId);
    });
  }
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

function _updateModeButtons() {
  const readBtn = document.getElementById('shard-mode-read');
  const editBtn = document.getElementById('shard-mode-edit');
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
  document.getElementById('shard-preview').innerHTML = '';
  document.getElementById('shard-preview').style.display = 'none';
  const viewModes = document.getElementById('shard-view-modes');
  if (viewModes) viewModes.style.display = 'none';
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
    if (noteId === '__graph__') {
      const active = noteId === _selectedNoteId ? 'active' : '';
      const icon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
      return `<button class="shard-tab ${active}" data-note-id="__graph__" title="Graph view">
        <span style="display:inline-flex;align-items:center;flex-shrink:0;margin-right:4px;">${icon}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;min-width:0;text-align:left;">Graph view</span>
        <span class="shard-tab-close" data-note-id="__graph__">&times;</span>
      </button>`;
    }
    const note = _notes.find(n => n.id === noteId);
    const title = _esc(note ? note.title : noteId);
    const active = noteId === _selectedNoteId ? 'active' : '';
    const icon = note ? _getNoteIconSvg(note.id, 'file', 11) : '';
    return `<button class="shard-tab ${active}" data-note-id="${_esc(noteId)}" title="${title}">
      <span style="display:inline-flex;align-items:center;flex-shrink:0;margin-right:4px;">${icon}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;min-width:0;text-align:left;">${title}</span>
      <span class="shard-tab-close" data-note-id="${_esc(noteId)}">&times;</span>
    </button>`;
  }).join('');
  bar.innerHTML = html + `<button class="shard-tab-new" title="New note">+</button>`;
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
  const loc = _shardSettings.filesAndLinks.newNoteLocation;
  if (loc === 'same-folder') {
    const currentNote = _notes.find(n => n.id === _selectedNoteId);
    targetFolder = currentNote ? (currentNote.folder || '') : '';
  } else if (loc === 'folder') {
    targetFolder = _shardSettings.filesAndLinks.newNoteFolder || '';
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
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(name)}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
      credentials: 'same-origin'
    });
    if (!r.ok) throw new Error();

    if (targetFolder) {
      try {
        const moveR = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(name)}/move`, {
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
        console.error('[shard] move new note failed:', moveErr);
      }
    }
    delete optimisticNote._optimistic;
    _autoRenameNoteId = optimisticNote.id;
  } catch (e) {
    console.error('[shard] create note failed', e);
    const idx = _notes.findIndex(n => n.id === name || n.rel_path === name);
    if (idx !== -1) _notes.splice(idx, 1);
    _renderFolderTree();
    _renderNoteTabs();
    if (_selectedNoteId === name) _closeCurrentTab();
    showToast('Failed to create note');
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
  _fitBreadcrumb(el);
}

function _fitBreadcrumb(el) {
  if (!el) return;
  const parts = Array.from(el.querySelectorAll('.shard-breadcrumb-part'));
  const current = el.querySelector('.shard-breadcrumb-current');
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
  const ribbon = document.getElementById('shard-ribbon-bar');
  const pane3 = document.querySelector('.shard-3pane');
  if (!ribbon) return;

  const showRibbon = _shardSettings?.appearance?.showRibbon !== false;
  const hiddenItems = new Set(_shardSettings?.appearance?.ribbonHiddenItems || []);

  // Show/hide ribbon container and adjust grid layout
  ribbon.style.display = showRibbon ? '' : 'none';
  if (pane3) {
    if (showRibbon) pane3.classList.remove('shard-ribbon-hidden');
    else pane3.classList.add('shard-ribbon-hidden');
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
  const order = _shardSettings?.appearance?.ribbonOrder || [];
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
      s.className = 'shard-ribbon-sep';
      ribbon.appendChild(s);
    }
    lastPluginId = item.pluginId;
    const b = document.createElement('div');
    b.className = 'shard-ribbon-btn';
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
      const allIds = Array.from(ribbon.querySelectorAll('.shard-ribbon-btn')).map(el => el.dataset.ribbonId);
      _shardSettings.appearance.ribbonOrder = allIds;
      _saveShardSettings();
    });

    ribbon.appendChild(b);
  }
}

/** Right-click context menu for ribbon */
let _ribbonMenu = null;
function _showRibbonMenu(x, y) {
  console.log('[shard] _showRibbonMenu called', x, y);
  if (_ribbonMenu) { _ribbonMenu.remove(); _ribbonMenu = null; }
  const hiddenItems = new Set(_shardSettings?.appearance?.ribbonHiddenItems || []);
  const showRibbon = _shardSettings?.appearance?.showRibbon !== false;

  const menu = document.createElement('div');
  menu.className = 'shard-ribbon-menu';
  const items = Array.from(_ribbonRegistry.values());
  console.log('[shard] ribbon items count:', items.length);
  if (items.length === 0) { console.log('[shard] no ribbon items, returning'); return; }

  let html = '';
  for (const item of items) {
    const isHidden = hiddenItems.has(item.id);
    const actionClass = isHidden ? 'add' : 'remove';
    const actionIcon = isHidden
      ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
      : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    html += `
      <div class="shard-ribbon-menu-item" data-ribbon-id="${item.id}">
        <span class="shard-ribbon-menu-icon">${item.iconSvg.replace(/width="18" height="18"/g, 'width="14" height="14"')}</span>
        <span>${_esc(item.title)}</span>
        <button type="button" class="shard-ribbon-menu-action ${actionClass}" data-ribbon-action="toggle-item" data-ribbon-id="${item.id}" title="${isHidden ? 'Show' : 'Hide'} item">
          ${actionIcon}
        </button>
      </div>`;
  }
  html += `<div class="shard-ribbon-menu-divider"></div>`;
  html += `
    <div class="shard-ribbon-menu-item" data-ribbon-action="hide-ribbon">
      <span class="shard-ribbon-menu-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg></span>
      <span>Hide ribbon</span>
    </div>`;
  menu.innerHTML = html;
  document.body.appendChild(menu);
  console.log('[shard] ribbon menu appended to body');

  // Position
  const rect = menu.getBoundingClientRect();
  console.log('[shard] ribbon menu rect:', rect);
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
  console.log('[shard] ribbon menu positioned at', left, top);

  // Wire hide/show item buttons
  menu.querySelectorAll('button[data-ribbon-action="toggle-item"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.ribbonId;
      const set = new Set(_shardSettings.appearance.ribbonHiddenItems || []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      _shardSettings.appearance.ribbonHiddenItems = Array.from(set);
      _saveShardSettings();
      _renderRibbon();
      // Refresh menu to swap icon
      _ribbonMenu?.remove();
      _ribbonMenu = null;
      _showRibbonMenu(parseInt(menu.style.left), parseInt(menu.style.top));
    });
  });
  // Wire "Hide ribbon" click
  menu.querySelector('div[data-ribbon-action="hide-ribbon"]')?.addEventListener('click', () => {
    _shardSettings.appearance.showRibbon = false;
    _saveShardSettings();
    _renderRibbon();
    _ribbonMenu?.remove();
    _ribbonMenu = null;
  });

  _ribbonMenu = menu;
  console.log('[shard] ribbon menu stored in _ribbonMenu');
}

// Close ribbon menu on outside click (delayed to avoid closing on the same click that opened it)
let _ribbonMenuClickAway = null;
function _ribbonMenuClose(e) {
  if (_ribbonMenu && !_ribbonMenu.contains(e.target)) {
    console.log('[shard] ribbon menu closing via outside click');
    _ribbonMenu.remove();
    _ribbonMenu = null;
    document.removeEventListener('click', _ribbonMenuClose);
    _ribbonMenuClickAway = null;
  }
}
document.addEventListener('contextmenu', (e) => {
  const ribbon = e.target.closest('#shard-ribbon-bar');
  if (ribbon) {
    e.preventDefault();
    e.stopPropagation();
    console.log('[shard] ribbon contextmenu triggered');
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

/** Ribbon configuration dialog */
function _openRibbonConfigDialog() {
  // Remove existing dialog if any
  const existing = document.getElementById('shard-ribbon-config-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'shard-ribbon-config-overlay';
  overlay.className = 'shard-ribbon-config-overlay';
  overlay.innerHTML = `
    <div class="shard-ribbon-config-dialog">
      <div class="shard-ribbon-config-header">
        <h3>Ribbon menu</h3>
        <button type="button" class="close-btn" id="shard-ribbon-config-close">&#x2715;</button>
      </div>
      <div class="shard-ribbon-config-body">
        <div class="shard-ribbon-config-desc">Choose what items you want to be active in the ribbon. Drag and drop to change the order.</div>
        <div id="shard-ribbon-config-active-list"></div>
        <div class="shard-ribbon-config-section-title">Other ribbon items</div>
        <div id="shard-ribbon-config-available-list"></div>
      </div>
      <div class="shard-ribbon-config-footer">
        <button type="button" id="shard-ribbon-config-done">Done</button>
      </div>
    </div>
  `;
  const modal = document.getElementById('shard-modal');
  (modal || document.body).appendChild(overlay);
  overlay.style.pointerEvents = 'auto';

  const close = () => { overlay.remove(); };
  overlay.querySelector('#shard-ribbon-config-close').addEventListener('click', close);
  overlay.querySelector('#shard-ribbon-config-done').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  _renderRibbonConfigLists();
}

function _renderRibbonConfigLists() {
  const activeContainer = document.getElementById('shard-ribbon-config-active-list');
  const availableContainer = document.getElementById('shard-ribbon-config-available-list');
  if (!activeContainer || !availableContainer) return;

  const hiddenItems = new Set(_shardSettings?.appearance?.ribbonHiddenItems || []);
  const allItems = Array.from(_ribbonRegistry.values());
  const activeItems = allItems.filter(i => !hiddenItems.has(i.id));
  const availableItems = allItems.filter(i => hiddenItems.has(i.id));

  // Active list
  if (activeItems.length === 0) {
    activeContainer.innerHTML = '<div style="padding:8px;text-align:center;opacity:0.5;font-size:12px;">No active ribbon items.</div>';
  } else {
    activeContainer.innerHTML = `<div class="shard-ribbon-config-section-title">Active</div>`;
    const list = document.createElement('div');
    list.className = 'shard-ribbon-config-list';
    activeItems.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'shard-ribbon-config-item';
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
        const set = new Set(_shardSettings.appearance.ribbonHiddenItems || []);
        set.add(id);
        _shardSettings.appearance.ribbonHiddenItems = Array.from(set);
        _saveShardSettings();
        _renderRibbon();
        _renderRibbonConfigLists();
      });
    });

    // Drag-and-drop reordering for active items
    let draggedId = null;
    list.querySelectorAll('.shard-ribbon-config-item').forEach(item => {
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
        const allIds = Array.from(list.querySelectorAll('.shard-ribbon-config-item')).map(el => el.dataset.ribbonId);
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
        _shardSettings.appearance.ribbonOrder = allIds;
        const newHidden = new Set();
        const activeSet = new Set(allIds);
        _ribbonRegistry.forEach((_, id) => {
          if (!activeSet.has(id)) newHidden.add(id);
        });
        _shardSettings.appearance.ribbonHiddenItems = Array.from(newHidden);
        _saveShardSettings();
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
    list.className = 'shard-ribbon-config-list';
    availableItems.forEach(item => {
      const row = document.createElement('div');
      row.className = 'shard-ribbon-config-item';
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
        const set = new Set(_shardSettings.appearance.ribbonHiddenItems || []);
        set.delete(id);
        _shardSettings.appearance.ribbonHiddenItems = Array.from(set);
        _saveShardSettings();
        _renderRibbon();
        _renderRibbonConfigLists();
      });
    });
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

// -- Settings ------------------------------------------------

let _shardSettings = {
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

function _loadShardSettings() {
  try {
    const raw = localStorage.getItem('shard-settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      _shardSettings = { ..._shardSettings, ...parsed };
      ['editor', 'filesAndLinks', 'appearance', 'hotkeys', 'plugins'].forEach(key => {
        if (parsed[key]) _shardSettings[key] = { ..._shardSettings[key], ...parsed[key] };
      });
    }
  } catch (e) { console.warn('[shard] load settings failed', e); }
}

function _saveShardSettings() {
  try { localStorage.setItem('shard-settings', JSON.stringify(_shardSettings)); } catch {}
}

const SHARD_COMMANDS = [
  {id:'quick-switcher',label:'Open quick switcher',impl:true},
  {id:'cycle-view-mode',label:'Cycle view mode',impl:true},
  {id:'new-note',label:'New note',impl:true},
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
  {id:'templates-insert',label:'Templates: Insert template',impl:false},
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
  {id:'templates-insert-current-date',label:'Templates: Insert current date',impl:false},
  {id:'templates-insert-current-time',label:'Templates: Insert current time',impl:false},
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
  return [...SHARD_COMMANDS, ...pluginCmds];
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

function _matchesShardCombo(e, combo) {
  if (!combo) return false;
  const parts = combo.split('+');
  const needCtrl = parts.includes('ctrl');
  const needAlt = parts.includes('alt');
  const needShift = parts.includes('shift');
  const needMeta = parts.includes('meta');
  const key = parts.filter(p => !['ctrl', 'alt', 'shift', 'meta'].includes(p))[0] || '';
  // On Mac, meta (Cmd) counts as ctrl for shard shortcuts; on Win/Linux, Ctrl counts as ctrl
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

function _getActiveShardEditor() {
  const modal = document.getElementById('shard-modal');
  if (!modal || modal.classList.contains('hidden')) return null;
  const activeLp = modal.querySelector('.lp-line.active .lp-source[contenteditable="true"]');
  if (activeLp) return { el: activeLp, mode: 'live' };
  const sourceDiv = modal.querySelector('.shard-source-view[contenteditable="true"]');
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
  const editor = _getActiveShardEditor();
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
  const editor = _getActiveShardEditor();
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
  const editor = _getActiveShardEditor();
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
  const editor = _getActiveShardEditor();
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
  const editor = _getActiveShardEditor();
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
  const editor = _getActiveShardEditor();
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
  const editor = _getActiveShardEditor();
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
  const editor = _getActiveShardEditor();
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
  range.setStart(container.firstChild || container, 0);
  range.setEnd(container.firstChild || container, 0);
  sel.removeAllRanges();
  sel.addRange(range);
}

function _zoom(delta) {
  let fs = _shardSettings.appearance.fontSize || 16;
  fs = Math.max(10, Math.min(32, fs + delta));
  _shardSettings.appearance.fontSize = fs;
  _saveShardSettings();
  document.documentElement.style.setProperty('--shard-font-size', fs + 'px');
}

function _insertBlock(text) {
  const editor = _getActiveShardEditor();
  if (!editor) return;
  document.execCommand('insertText', false, text);
  editor.el.focus();
}

function _followLinkUnderCursor() {
  const editor = _getActiveShardEditor();
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
      document.querySelectorAll('#shard-preview details').forEach(d => d.open = false);
      return true;
    case 'unfold-all':
      document.querySelectorAll('#shard-preview details').forEach(d => d.open = true);
      return true;
    case 'graph-view': {
      _openGraphView();
      return true;
    }
    case 'open-local-graph': {
      const localGraphTab = document.querySelector('#shard-right-tabs [data-tab="local-graph"]');
      if (localGraphTab) localGraphTab.click();
      return true;
    }
    case 'daily-note': {
      const dailyPlugin = _pluginManager?.getInstance('daily-notes');
      if (dailyPlugin?._commands?.[0]) dailyPlugin._commands[0].callback();
      return true;
    }
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
    case 'open-settings': _openShardSettings(); return true;
    case 'rename-file': {
      if (_selectedNoteId) _promptRenameNote(_selectedNoteId);
      return true;
    }
    case 'reset-zoom': { _zoom(16 - (_shardSettings.appearance.fontSize || 16)); return true; }
    case 'save-current-file': {
      const note = _notes.find(n => n.id === _selectedNoteId);
      const sourceDiv = document.querySelector('.shard-source-view[contenteditable="true"]');
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
      const leftPane = document.querySelector('.shard-left-pane');
      if (leftPane) leftPane.classList.toggle('hidden');
      return true;
    }
    case 'toggle-right-sidebar': {
      const rightPane = document.querySelector('.shard-right-pane');
      if (rightPane) rightPane.classList.toggle('hidden');
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
  const hotkeys = _shardSettings.hotkeys || {};

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
    <div class="shard-settings-group">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <h6 class="shard-settings-group-title" style="margin:0;">Keyboard shortcuts</h6>
        <span style="font-size:11px;opacity:0.5;">${commands.length} commands</span>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <input type="text" id="shard-hotkeys-filter" placeholder="Search Hotkeys" style="flex:1;padding:6px 10px;font-size:13px;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;color:var(--fg);box-sizing:border-box;" autocomplete="off" spellcheck="false">
        <div style="position:relative;">
          <button type="button" id="shard-hotkeys-sort" title="Sort commands" style="padding:6px 10px;font-size:12px;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;color:var(--fg);cursor:pointer;white-space:nowrap;">&#x2195;</button>
          <div id="shard-hotkeys-sort-dropdown" style="display:none;position:absolute;right:0;top:calc(100% + 4px);background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:9999;min-width:140px;overflow:hidden;">
            <button type="button" data-sort="az" style="display:block;width:100%;text-align:left;padding:6px 10px;font-size:12px;background:transparent;border:none;color:var(--fg);cursor:pointer;${sortMode === 'az' ? 'background:color-mix(in srgb,var(--accent,var(--red,#4a9eff)) 10%,transparent);' : ''}">A–Z</button>
            <button type="button" data-sort="za" style="display:block;width:100%;text-align:left;padding:6px 10px;font-size:12px;background:transparent;border:none;color:var(--fg);cursor:pointer;${sortMode === 'za' ? 'background:color-mix(in srgb,var(--accent,var(--red,#4a9eff)) 10%,transparent);' : ''}">Z–A</button>
            <button type="button" data-sort="bound" style="display:block;width:100%;text-align:left;padding:6px 10px;font-size:12px;background:transparent;border:none;color:var(--fg);cursor:pointer;${sortMode === 'bound' ? 'background:color-mix(in srgb,var(--accent,var(--red,#4a9eff)) 10%,transparent);' : ''}">Bound first</button>
          </div>
        </div>
      </div>
      <div id="shard-hotkeys-list" style="display:flex;flex-direction:column;gap:4px;max-height:400px;overflow-y:auto;">
        ${commands.map(cmd => {
          const combo = hotkeys[cmd.id] || '';
          const display = _formatCombo(combo) || '—';
          const disabled = cmd.impl === false;
          return `<div class="shard-settings-row shard-hotkey-row ${disabled ? 'shard-hotkey-disabled' : ''}" style="gap:12px;${disabled ? 'opacity:0.4;' : 'cursor:pointer;'}" data-cmd-id="${_esc(cmd.id)}" data-impl="${cmd.impl !== false}">
            <div class="shard-settings-info" style="flex:1;${disabled ? 'font-style:italic;' : ''}">
              <span>${_esc(cmd.label)}</span>
              ${disabled ? '<span style="font-size:10px;opacity:0.6;margin-left:6px;">(not yet hooked up)</span>' : ''}
            </div>
            <kbd class="shard-hotkey-kbd" style="font-family:monospace;font-size:12px;padding:2px 8px;border-radius:4px;background:var(--bg-raised);border:1px solid var(--border);min-width:80px;text-align:center;cursor:pointer;user-select:none;${disabled ? 'pointer-events:none;' : ''}">${_esc(display)}</kbd>
            <button type="button" class="shard-hotkey-clear" style="background:none;border:none;color:var(--fg);opacity:0.5;cursor:pointer;font-size:12px;padding:2px 6px;${disabled ? 'pointer-events:none;' : ''}" title="Clear shortcut">&#x2715;</button>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;

  // Sort dropdown
  const sortBtn = document.getElementById('shard-hotkeys-sort');
  const sortDropdown = document.getElementById('shard-hotkeys-sort-dropdown');
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
  const filterInput = document.getElementById('shard-hotkeys-filter');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const q = filterInput.value.trim().toLowerCase();
      container.querySelectorAll('.shard-hotkey-row').forEach(row => {
        const label = row.querySelector('.shard-settings-info span')?.textContent.toLowerCase() || '';
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
    container.querySelectorAll('.shard-hotkey-kbd').forEach(k => {
      k.style.borderColor = 'var(--border)';
      k.style.background = 'var(--bg-raised)';
    });
  };

  container.querySelectorAll('.shard-settings-row[data-cmd-id]').forEach(row => {
    if (row.dataset.impl === 'false') return; // Skip binding for unimplemented commands
    const cmdId = row.dataset.cmdId;
    const kbd = row.querySelector('.shard-hotkey-kbd');
    const clearBtn = row.querySelector('.shard-hotkey-clear');

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
          delete _shardSettings.hotkeys[cmdId];
          _saveShardSettings();
          stopCapture();
          _renderHotkeySettings();
          return;
        }

        const combo = _normalizeCapturedCombo(e);
        if (!combo) return; // Lone modifier or invalid

        // Check for conflicts
        const conflict = Object.entries(_shardSettings.hotkeys || {}).find(([id, c]) => id !== cmdId && c === combo);
        if (conflict) {
          showToast(`Conflict: ${_getAllCommands().find(c => c.id === conflict[0])?.label || conflict[0]} already uses ${_formatCombo(combo)}`);
          return;
        }

        _shardSettings.hotkeys[cmdId] = combo;
        _saveShardSettings();
        stopCapture();
        _renderHotkeySettings();
      };
      document.addEventListener('keydown', _captureHandler, true);
    });

    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      delete _shardSettings.hotkeys[cmdId];
      _saveShardSettings();
      _renderHotkeySettings();
    });
  });
}

function _applyMonospaceFont() {
  const modal = document.getElementById('shard-modal');
  if (!modal) return;
  const on = _shardSettings.appearance.monospaceFont === true;
  const before = modal.classList.contains('shard-monospace-font');
  if (on) {
    modal.classList.add('shard-monospace-font');
  } else {
    modal.classList.remove('shard-monospace-font');
  }
  const after = modal.classList.contains('shard-monospace-font');

  // Belt-and-suspenders: also set inline font-family on key vault content
  // elements so the change is visible even if CSS specificity has edge cases.
  const monoFont = "'Fira Code', 'Consolas', monospace";
  const targets = [
    modal.querySelector('#shard-preview'),
    modal.querySelector('#shard-folder-tree'),
    ...modal.querySelectorAll('.shard-source-view, .shard-live-view, .shard-reading-view'),
  ].filter(Boolean);
  for (const el of targets) {
    if (on) {
      el.style.setProperty('font-family', monoFont, 'important');
    } else {
      el.style.removeProperty('font-family');
    }
  }

  // Diagnostic: report computed font-family of representative vault content
  // elements so we can verify the CSS actually takes effect.
  const probe = (sel) => {
    const el = modal.querySelector(sel);
    if (!el) return `${sel}: <missing>`;
    const ff = getComputedStyle(el).fontFamily;
    return `${sel}: ${ff.slice(0, 60)}`;
  };
  console.log('[shard] _applyMonospaceFont', {
    settingOn: on,
    classBefore: before,
    classAfter: after,
    settingsObj: _shardSettings.appearance,
  });
  console.log('[shard] computed font-family:', [
    probe('#shard-preview'),
    probe('.shard-source-view'),
    probe('.shard-live-view'),
    probe('.shard-reading-view'),
    probe('.shard-folder-tree'),
    probe('.shard-tab'),
  ].join(' | '));
}

function _applyReadableLineLength() {
  const preview = document.getElementById('shard-preview');
  if (!preview) return;
  if (_shardSettings.editor.readableLineLength) {
    preview.classList.add('shard-readable-line');
  } else {
    preview.classList.remove('shard-readable-line');
  }
}

function _switchSettingsPane(section) {
  document.querySelectorAll('.shard-settings-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.settingsSection === section);
  });
  document.querySelectorAll('.shard-settings-section').forEach(el => {
    el.classList.toggle('hidden', el.dataset.settingsPane !== section);
  });
}

let _selectedPluginSettings = 'backlinks';

function _switchPluginSettingsPane(pluginId) {
  _selectedPluginSettings = pluginId;
  const contentEl = document.querySelector('.shard-plugin-settings-content');
  // If no pane exists for this plugin, inject a fallback
  let pane = document.querySelector(`.shard-plugin-settings-pane[data-plugin-pane="${_esc(pluginId)}"]`);
  if (!pane && contentEl) {
    const plugin = CORE_PLUGINS.find(p => p.id === pluginId);
    const title = plugin ? plugin.name : pluginId;
    pane = document.createElement('div');
    pane.className = 'shard-plugin-settings-pane';
    pane.dataset.pluginPane = pluginId;
    pane.innerHTML = `<h3 class="shard-plugin-title">${_esc(title)}</h3><p style="opacity:0.6;font-size:13px;margin-top:8px;">This plugin has no settings.</p>`;
    contentEl.appendChild(pane);
  }
  document.querySelectorAll('.shard-plugin-settings-pane').forEach(el => {
    el.classList.toggle('hidden', el.dataset.pluginPane !== pluginId);
  });
  document.querySelectorAll('.shard-plugin-settings-sidebar-item').forEach(el => {
    el.classList.toggle('active', el.dataset.pluginId === pluginId);
  });
}

function _renderPluginSettings(query = '') {
  const container = document.getElementById('shard-settings-plugins-list');
  const countEl = document.getElementById('shard-plugins-count');
  if (!container || !_pluginManager) return;
  const enabled = new Set(_shardSettings.enabledPlugins || []);
  const q = query.toLowerCase().trim();
  const filtered = CORE_PLUGINS.filter(p =>
    !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
  );
  if (countEl) countEl.textContent = `${filtered.length} / ${CORE_PLUGINS.length}`;
  container.innerHTML = filtered.map(p => {
    const isOn = enabled.has(p.id);
    const isActive = _selectedPluginSettings === p.id;
    return `<button type="button" class="shard-plugin-settings-sidebar-item ${isActive ? 'active' : ''}" data-plugin-id="${_esc(p.id)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;border:none;background:none;color:var(--fg);cursor:pointer;width:100%;text-align:left;font-size:13px;">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(p.name)}</span>
      <label class="admin-switch" style="flex-shrink:0;">
        <input type="checkbox" class="shard-plugin-toggle" data-plugin-id="${_esc(p.id)}" ${isOn ? 'checked' : ''}>
        <span class="admin-slider" style="background:${isOn ? 'var(--red)' : 'color-mix(in srgb, var(--fg) 50%, transparent)'};"></span>
      </label>
    </button>`;
  }).join('');
  container.querySelectorAll('.shard-plugin-settings-sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      const pid = item.dataset.pluginId;
      _switchPluginSettingsPane(pid);
    });
  });
  container.querySelectorAll('.admin-switch').forEach(label => {
    label.addEventListener('click', (e) => { e.stopPropagation(); });
  });
  container.querySelectorAll('.shard-plugin-toggle').forEach(toggle => {
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
        console.error(`[shard] plugin toggle ${pid} failed:`, err);
        showToast(`Failed to toggle ${pid}`);
        toggle.checked = !on;
        return;
      }
      _shardSettings.enabledPlugins = CORE_PLUGINS
        .filter(p => _pluginManager.isEnabled(p.id))
        .map(p => p.id);
      _saveShardSettings();
      _syncPluginTabs();
      const leftMap = { bookmarks: 'bookmarks', tags: 'tags', search: 'search' };
      const rightMap = { backlinks: 'backlinks', 'outgoing-links': 'outgoing', unlinked: 'unlinked', outline: 'outline', orphans: 'orphans' };
      if (!on && leftMap[pid] && _activeLeftTab === leftMap[pid]) {
        const fallback = Array.from(document.querySelectorAll('#shard-left-tabs .shard-sidebar-tab:not(.hidden)')).map(b => b.dataset.tab)[0];
        if (fallback) _switchLeftTab(fallback);
      }
      if (!on && rightMap[pid] && _activeRightTab === rightMap[pid]) {
        const fallback = Array.from(document.querySelectorAll('#shard-right-tabs .shard-right-tab:not(.hidden)')).map(b => b.dataset.tab)[0];
        if (fallback) _switchRightTab(fallback);
      }
      _switchLeftTab(_activeLeftTab);
      _switchRightTab(_activeRightTab);
      if (_selectedNoteId) _selectNote(_selectedNoteId);
      // Re-render sidebar to update toggle visual state
      _renderPluginSettings(document.getElementById('shard-plugin-search')?.value || '');
    });
  });
}

function _enhanceShardSelects() {
  const dialog = document.getElementById('shard-settings-dialog');
  if (!dialog) return;
  dialog.querySelectorAll('.shard-settings-select').forEach(select => {
    const existing = select.closest('.shard-custom-select');
    if (existing) {
      // Just sync the trigger text for already-enhanced selects
      const trigger = existing.querySelector('.shard-custom-select-trigger');
      if (trigger) {
        const selected = select.options[select.selectedIndex];
        trigger.textContent = selected ? selected.text : '';
      }
      existing.querySelectorAll('.shard-custom-select-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.value === select.value);
      });
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'shard-custom-select';
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'shard-custom-select-trigger';
    wrapper.appendChild(trigger);

    const dropdown = document.createElement('div');
    dropdown.className = 'shard-custom-select-dropdown';
    wrapper.appendChild(dropdown);

    const _sync = () => {
      const selected = select.options[select.selectedIndex];
      trigger.textContent = selected ? selected.text : '';
      dropdown.querySelectorAll('.shard-custom-select-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.value === select.value);
      });
    };

    const _build = () => {
      dropdown.innerHTML = '';
      Array.from(select.options).forEach(opt => {
        const div = document.createElement('div');
        div.className = 'shard-custom-select-option';
        div.textContent = opt.text;
        div.dataset.value = opt.value;
        div.tabIndex = 0;
        div.addEventListener('click', () => {
          select.value = opt.value;
          _sync();
          select.dispatchEvent(new Event('change', { bubbles: true }));
          wrapper.classList.remove('open');
        });
        div.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            div.click();
          }
        });
        dropdown.appendChild(div);
      });
      _sync();
    };

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = wrapper.classList.contains('open');
      dialog.querySelectorAll('.shard-custom-select.open').forEach(w => w.classList.remove('open'));
      if (!wasOpen) wrapper.classList.add('open');
    });

    _build();
    // Rebuild when options change (e.g. specific-file select)
    const observer = new MutationObserver(_build);
    observer.observe(select, { childList: true });
  });

  // Close on outside click (attach once)
  if (!dialog.dataset.shardSelectsWired) {
    dialog.dataset.shardSelectsWired = '1';
    const closeAll = () => dialog.querySelectorAll('.shard-custom-select.open').forEach(w => w.classList.remove('open'));
    document.addEventListener('click', closeAll);
    dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
  }
}

function _openShardSettings() {
  _loadShardSettings();
  const dialog = document.getElementById('shard-settings-dialog');
  if (!dialog) return;
  dialog.classList.remove('hidden');
  const set = _shardSettings;
  const getEl = id => document.getElementById(id);
  if (getEl('shard-set-default-view')) getEl('shard-set-default-view').value = set.editor.defaultView;
  if (getEl('shard-set-readable-line')) getEl('shard-set-readable-line').checked = set.editor.readableLineLength;
  if (getEl('shard-set-strict-breaks')) getEl('shard-set-strict-breaks').checked = set.editor.strictLineBreaks;
  if (getEl('shard-set-fold-heading')) getEl('shard-set-fold-heading').checked = set.editor.foldHeading;
  if (getEl('shard-set-fold-indent')) getEl('shard-set-fold-indent').checked = set.editor.foldIndent;
  if (getEl('shard-set-line-numbers')) getEl('shard-set-line-numbers').checked = set.editor.showLineNumbers;
  if (getEl('shard-set-auto-brackets')) getEl('shard-set-auto-brackets').checked = set.editor.autoPairBrackets;
  if (getEl('shard-set-auto-md')) getEl('shard-set-auto-md').checked = set.editor.autoPairMarkdown;
  if (getEl('shard-set-smart-lists')) getEl('shard-set-smart-lists').checked = set.editor.smartLists;
  if (getEl('shard-set-indent-tabs')) getEl('shard-set-indent-tabs').checked = set.editor.indentWithTabs;
  if (getEl('shard-set-vim')) getEl('shard-set-vim').checked = set.editor.vimBindings;
  if (getEl('shard-set-inline-title')) getEl('shard-set-inline-title').checked = set.appearance.showInlineTitle;
  if (getEl('shard-set-monospace-font')) getEl('shard-set-monospace-font').checked = set.appearance.monospaceFont;
  if (getEl('shard-set-show-ribbon')) getEl('shard-set-show-ribbon').checked = set.appearance.showRibbon !== false;
  if (getEl('shard-set-wikilinks')) getEl('shard-set-wikilinks').checked = set.filesAndLinks.useWikilinks;
  if (getEl('shard-set-link-format')) getEl('shard-set-link-format').value = set.filesAndLinks.linkFormat;
  if (getEl('shard-set-confirm-delete')) getEl('shard-set-confirm-delete').checked = set.filesAndLinks.confirmDelete;
  if (getEl('shard-set-auto-links')) getEl('shard-set-auto-links').checked = set.filesAndLinks.autoUpdateLinks;
  if (getEl('shard-set-confirm-auto-links')) getEl('shard-set-confirm-auto-links').checked = set.filesAndLinks.confirmAutoUpdateLinks !== false;
  if (getEl('shard-set-new-note-loc')) getEl('shard-set-new-note-loc').value = set.filesAndLinks.newNoteLocation;
  if (getEl('shard-set-new-note-folder')) getEl('shard-set-new-note-folder').value = set.filesAndLinks.newNoteFolder;
  if (getEl('shard-set-new-attach-loc')) getEl('shard-set-new-attach-loc').value = set.filesAndLinks.newAttachmentLocation;
  if (getEl('shard-set-new-attach-folder')) getEl('shard-set-new-attach-folder').value = set.filesAndLinks.newAttachmentFolder;
  if (getEl('shard-set-always-focus')) getEl('shard-set-always-focus').checked = set.editor.alwaysFocusNewTabs;
  if (getEl('shard-set-show-edit-mode')) getEl('shard-set-show-edit-mode').checked = set.editor.showEditingModeInStatusBar;
  if (getEl('shard-set-properties')) getEl('shard-set-properties').value = set.editor.propertiesInDocument;
  if (getEl('shard-set-indent-guides')) getEl('shard-set-indent-guides').checked = set.editor.indentationGuides;
  if (getEl('shard-set-rtl')) getEl('shard-set-rtl').checked = set.editor.rtl;
  if (getEl('shard-set-spellcheck')) getEl('shard-set-spellcheck').checked = set.editor.spellcheck;
  if (getEl('shard-set-indent-width')) getEl('shard-set-indent-width').value = set.editor.indentVisualWidth;
  if (getEl('shard-set-convert-html')) getEl('shard-set-convert-html').checked = set.editor.convertPastedHtml;
  if (getEl('shard-set-default-file-open')) getEl('shard-set-default-file-open').value = set.filesAndLinks.defaultFileToOpen;
  const specificFileRow = document.getElementById('shard-specific-file-row');
  const specificFileSelect = document.getElementById('shard-set-specific-file');
  if (specificFileRow && specificFileSelect) {
    specificFileRow.classList.toggle('hidden', set.filesAndLinks.defaultFileToOpen !== 'specific-file');
    const notes = [..._notes].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    specificFileSelect.innerHTML = notes.map(n => `<option value="${_esc(n.id)}">${_esc(n.title || n.id)}</option>`).join('');
    if (set.filesAndLinks.defaultSpecificFile) {
      specificFileSelect.value = set.filesAndLinks.defaultSpecificFile;
    }
  }
  if (getEl('shard-set-detect-ext')) getEl('shard-set-detect-ext').checked = set.filesAndLinks.detectAllFileExtensions;
  if (getEl('shard-set-tab-title-bar')) getEl('shard-set-tab-title-bar').checked = set.appearance.showTabTitleBar;
  if (getEl('shard-set-backlinks-bottom')) getEl('shard-set-backlinks-bottom').checked = set.appearance.showBacklinksAtBottom;
  // Plugin settings
  const ps = set.plugins || {};
  if (getEl('shard-plugin-set-backlinks-bottom')) getEl('shard-plugin-set-backlinks-bottom').checked = ps.backlinks?.showBacklinksAtBottom ?? false;
  if (getEl('shard-plugin-set-dn-date-format')) getEl('shard-plugin-set-dn-date-format').value = ps['daily-notes']?.dateFormat ?? 'YYYY-MM-DD';
  if (getEl('shard-plugin-set-dn-location')) getEl('shard-plugin-set-dn-location').value = ps['daily-notes']?.newFileLocation ?? '';
  if (getEl('shard-plugin-set-dn-template')) getEl('shard-plugin-set-dn-template').value = ps['daily-notes']?.templateFileLocation ?? '';
  if (getEl('shard-plugin-set-qs-existing')) getEl('shard-plugin-set-qs-existing').checked = ps['quick-switcher']?.showExistingOnly ?? false;
  if (getEl('shard-plugin-set-qs-attachments')) getEl('shard-plugin-set-qs-attachments').checked = ps['quick-switcher']?.showAttachments ?? true;
  if (getEl('shard-plugin-set-tmpl-folder')) getEl('shard-plugin-set-tmpl-folder').value = ps.templates?.templateFolderLocation ?? '';
  if (getEl('shard-plugin-set-tmpl-date')) getEl('shard-plugin-set-tmpl-date').value = ps.templates?.dateFormat ?? 'DD-MM-YYYY';
  if (getEl('shard-plugin-set-tmpl-time')) getEl('shard-plugin-set-tmpl-time').value = ps.templates?.timeFormat ?? 'HH:mm';
  _renderPluginSettings();
  _switchPluginSettingsPane(_selectedPluginSettings);
  _renderHotkeySettings();
  _applyMonospaceFont();
  _applyReadableLineLength();
  _switchSettingsPane('editor');
  _enhanceShardSelects();
}

function _closeShardSettings() {
  document.getElementById('shard-settings-dialog')?.classList.add('hidden');
}

function _wireShardSettings() {
  document.getElementById('shard-settings-cog')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _openShardSettings();
  });
  document.getElementById('shard-settings-close')?.addEventListener('click', _closeShardSettings);
  document.querySelectorAll('.shard-settings-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      if (!item.disabled) _switchSettingsPane(item.dataset.settingsSection);
    });
  });
  const bindToggle = (id, path) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      const keys = path.split('.');
      let target = _shardSettings;
      for (let i = 0; i < keys.length - 1; i++) target = target[keys[i]];
      target[keys[keys.length - 1]] = el.checked;
      _saveShardSettings();
      if (path === 'appearance.fontSize') {
        document.documentElement.style.setProperty('--shard-font-size', el.value + 'px');
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
      let target = _shardSettings;
      for (let i = 0; i < keys.length - 1; i++) target = target[keys[i]];
      target[keys[keys.length - 1]] = el.value;
      _saveShardSettings();
      if (path === 'editor.defaultView') {
        _previewMode = el.value === 'live' ? 'live' : el.value === 'source' ? 'edit' : 'preview';
        _editModePref = el.value === 'source' ? 'edit' : 'live';
        _sourceModeEnabled = el.value === 'source';
      }
    });
  };
  const bindRange = (id, path, valId) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const keys = path.split('.');
      let target = _shardSettings;
      for (let i = 0; i < keys.length - 1; i++) target = target[keys[i]];
      target[keys[keys.length - 1]] = parseInt(el.value, 10);
      _saveShardSettings();
      const valEl = document.getElementById(valId);
      if (valEl) valEl.textContent = el.value;
      if (path === 'appearance.fontSize') {
        document.documentElement.style.setProperty('--shard-font-size', el.value + 'px');
      }
    });
  };
  bindToggle('shard-set-readable-line', 'editor.readableLineLength');
  bindToggle('shard-set-strict-breaks', 'editor.strictLineBreaks');
  bindToggle('shard-set-fold-heading', 'editor.foldHeading');
  bindToggle('shard-set-fold-indent', 'editor.foldIndent');
  bindToggle('shard-set-always-focus', 'editor.alwaysFocusNewTabs');
  bindToggle('shard-set-show-edit-mode', 'editor.showEditingModeInStatusBar');
  bindSelect('shard-set-properties', 'editor.propertiesInDocument');
  bindToggle('shard-set-indent-guides', 'editor.indentationGuides');
  bindToggle('shard-set-rtl', 'editor.rtl');
  bindToggle('shard-set-spellcheck', 'editor.spellcheck');
  bindToggle('shard-set-convert-html', 'editor.convertPastedHtml');
  bindToggle('shard-set-detect-ext', 'filesAndLinks.detectAllFileExtensions');
  bindToggle('shard-set-tab-title-bar', 'appearance.showTabTitleBar');
  bindToggle('shard-set-backlinks-bottom', 'appearance.showBacklinksAtBottom');
  const indentWidthInput = document.getElementById('shard-set-indent-width');
  if (indentWidthInput) {
    indentWidthInput.addEventListener('change', () => {
      _shardSettings.editor.indentVisualWidth = parseInt(indentWidthInput.value, 10) || 4;
      _saveShardSettings();
    });
  }
  const defaultFileOpenSelect = document.getElementById('shard-set-default-file-open');
  if (defaultFileOpenSelect) {
    defaultFileOpenSelect.addEventListener('change', () => {
      _shardSettings.filesAndLinks.defaultFileToOpen = defaultFileOpenSelect.value;
      const row = document.getElementById('shard-specific-file-row');
      if (row) row.classList.toggle('hidden', defaultFileOpenSelect.value !== 'specific-file');
      _saveShardSettings();
    });
  }
  const specificFileSelect = document.getElementById('shard-set-specific-file');
  if (specificFileSelect) {
    specificFileSelect.addEventListener('change', () => {
      _shardSettings.filesAndLinks.defaultSpecificFile = specificFileSelect.value;
      _saveShardSettings();
    });
  }
  const lineNumToggle = document.getElementById('shard-set-line-numbers');
  if (lineNumToggle) {
    lineNumToggle.addEventListener('change', () => {
      _shardSettings.editor.showLineNumbers = lineNumToggle.checked;
      _saveShardSettings();
      if (_selectedNoteId) _selectNote(_selectedNoteId);
    });
  }
  bindToggle('shard-set-auto-brackets', 'editor.autoPairBrackets');
  bindToggle('shard-set-auto-md', 'editor.autoPairMarkdown');
  bindToggle('shard-set-smart-lists', 'editor.smartLists');
  bindToggle('shard-set-indent-tabs', 'editor.indentWithTabs');
  bindToggle('shard-set-vim', 'editor.vimBindings');
  const pluginSearchInput = document.getElementById('shard-plugin-search');
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
      if (!_shardSettings.plugins[pluginId]) _shardSettings.plugins[pluginId] = {};
      _shardSettings.plugins[pluginId][key] = el.checked;
      _saveShardSettings();
    });
  };
  const wirePluginInput = (id, pluginId, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (!_shardSettings.plugins[pluginId]) _shardSettings.plugins[pluginId] = {};
      _shardSettings.plugins[pluginId][key] = el.value;
      _saveShardSettings();
    });
  };
  wirePluginToggle('shard-plugin-set-backlinks-bottom', 'backlinks', 'showBacklinksAtBottom');
  wirePluginInput('shard-plugin-set-dn-date-format', 'daily-notes', 'dateFormat');
  wirePluginInput('shard-plugin-set-dn-location', 'daily-notes', 'newFileLocation');
  wirePluginInput('shard-plugin-set-dn-template', 'daily-notes', 'templateFileLocation');
  wirePluginToggle('shard-plugin-set-qs-existing', 'quick-switcher', 'showExistingOnly');
  wirePluginToggle('shard-plugin-set-qs-attachments', 'quick-switcher', 'showAttachments');
  wirePluginInput('shard-plugin-set-tmpl-folder', 'templates', 'templateFolderLocation');
  wirePluginInput('shard-plugin-set-tmpl-date', 'templates', 'dateFormat');
  wirePluginInput('shard-plugin-set-tmpl-time', 'templates', 'timeFormat');
  const inlineTitleToggle = document.getElementById('shard-set-inline-title');
  if (inlineTitleToggle) {
    inlineTitleToggle.addEventListener('change', () => {
      _shardSettings.appearance.showInlineTitle = inlineTitleToggle.checked;
      _saveShardSettings();
      if (_selectedNoteId) _selectNote(_selectedNoteId);
    });
  }
  bindToggle('shard-set-monospace-font', 'appearance.monospaceFont');
  bindToggle('shard-set-show-ribbon', 'appearance.showRibbon');
  const showRibbonToggle = document.getElementById('shard-set-show-ribbon');
  if (showRibbonToggle) {
    showRibbonToggle.addEventListener('change', () => _renderRibbon());
  }
  document.getElementById('shard-set-ribbon-config-btn')?.addEventListener('click', () => {
    _openRibbonConfigDialog();
  });
  bindToggle('shard-set-wikilinks', 'filesAndLinks.useWikilinks');
  bindToggle('shard-set-confirm-delete', 'filesAndLinks.confirmDelete');
  bindToggle('shard-set-auto-links', 'filesAndLinks.autoUpdateLinks');
  bindToggle('shard-set-confirm-auto-links', 'filesAndLinks.confirmAutoUpdateLinks');
  bindSelect('shard-set-default-view', 'editor.defaultView');
  bindSelect('shard-set-link-format', 'filesAndLinks.linkFormat');
  bindSelect('shard-set-new-note-loc', 'filesAndLinks.newNoteLocation');
  bindSelect('shard-set-new-attach-loc', 'filesAndLinks.newAttachmentLocation');
  const newNoteFolderInput = document.getElementById('shard-set-new-note-folder');
  if (newNoteFolderInput) {
    newNoteFolderInput.addEventListener('change', () => {
      _shardSettings.filesAndLinks.newNoteFolder = newNoteFolderInput.value;
      _saveShardSettings();
    });
  }
  const newAttachFolderInput = document.getElementById('shard-set-new-attach-folder');
  if (newAttachFolderInput) {
    newAttachFolderInput.addEventListener('change', () => {
      _shardSettings.filesAndLinks.newAttachmentFolder = newAttachFolderInput.value;
      _saveShardSettings();
    });
  }
  // Settings dialog drag
  const settingsHeader = document.getElementById('shard-settings-header');
  const settingsCard = document.querySelector('.shard-settings-dialog-card');
  if (settingsHeader && settingsCard) {
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let cardStartX = 0, cardStartY = 0;
    settingsHeader.addEventListener('mousedown', (e) => {
      if (e.target.closest('#shard-settings-close')) return;
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
    const settingsHeader = settingsCard.querySelector('.shard-settings-header');
    makeWindowResizable(settingsCard, {
      minWidth: 400,
      minHeight: 300,
      storageKey: 'winsize-shard-settings',
      cursorTargets: settingsHeader ? [settingsCard, settingsHeader] : [settingsCard]
    });
  }
}


// ── CSS Snippets (Phase E) ─────────────────────────────────

let _cssSnippets = [];
try {
  const raw = localStorage.getItem('shard-css-snippets');
  if (raw) _cssSnippets = JSON.parse(raw);
} catch {}

function _persistCssSnippets() {
  try { localStorage.setItem('shard-css-snippets', JSON.stringify(_cssSnippets)); } catch {}
}

function _injectCssSnippets() {
  // Remove existing injected snippets
  document.querySelectorAll('style.shard-css-snippet').forEach(el => el.remove());
  const enabled = _cssSnippets.filter(s => s.enabled);
  for (const s of enabled) {
    const style = document.createElement('style');
    style.className = 'shard-css-snippet';
    style.dataset.snippetId = s.id;
    style.textContent = s.content;
    document.head.appendChild(style);
  }
}

let _snippetEditingId = null;

function _renderSnippetsList() {
  const list = document.getElementById('shard-snippets-list');
  const editor = document.getElementById('shard-snippet-editor');
  if (!list) return;
  if (_cssSnippets.length === 0) {
    list.innerHTML = '<div style="padding:8px;text-align:center;opacity:0.5;font-size:12px;">No snippets yet. Click "+ New snippet" to create one.</div>';
  } else {
    list.innerHTML = _cssSnippets.map(s => `
      <div class="shard-settings-row" style="gap:10px;">
        <label class="admin-switch" style="flex-shrink:0;">
          <input type="checkbox" class="shard-snippet-toggle" data-snippet-id="${_esc(s.id)}" ${s.enabled ? 'checked' : ''}>
          <span class="admin-slider"></span>
        </label>
        <div class="shard-settings-info" style="flex:1;cursor:pointer;" data-snippet-edit="${_esc(s.id)}">
          <span>${_esc(s.name || 'Untitled')}</span>
          <span class="shard-settings-desc">${s.content.length} chars</span>
        </div>
        <button type="button" class="shard-snippet-edit-btn admin-btn-sm" data-snippet-id="${_esc(s.id)}">Edit</button>
      </div>
    `).join('');
    // Wire toggles
    list.querySelectorAll('.shard-snippet-toggle').forEach(toggle => {
      toggle.addEventListener('change', () => {
        const id = toggle.dataset.snippetId;
        const s = _cssSnippets.find(x => x.id === id);
        if (s) { s.enabled = toggle.checked; _persistCssSnippets(); _injectCssSnippets(); }
      });
    });
    // Wire edit buttons
    list.querySelectorAll('.shard-snippet-edit-btn').forEach(btn => {
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
  const list = document.getElementById('shard-snippets-list');
  const editor = document.getElementById('shard-snippet-editor');
  const nameInput = document.getElementById('shard-snippet-name');
  const contentInput = document.getElementById('shard-snippet-content');
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
  const nameInput = document.getElementById('shard-snippet-name');
  const contentInput = document.getElementById('shard-snippet-content');
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
  document.getElementById('shard-snippet-add')?.addEventListener('click', () => _openSnippetEditor(null));
  document.getElementById('shard-snippet-back')?.addEventListener('click', _closeSnippetEditor);
  document.getElementById('shard-snippet-save')?.addEventListener('click', _saveSnippet);
  document.getElementById('shard-snippet-delete')?.addEventListener('click', _deleteSnippet);
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
  const raw = localStorage.getItem('shard-note-icons');
  if (raw) _noteIcons = JSON.parse(raw);
} catch {}

function _persistNoteIcons() {
  try { localStorage.setItem('shard-note-icons', JSON.stringify(_noteIcons)); } catch {}
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
  const raw = localStorage.getItem('shard-folder-icons');
  if (raw) _folderIcons = JSON.parse(raw);
} catch {}

function _persistFolderIcons() {
  try { localStorage.setItem('shard-folder-icons', JSON.stringify(_folderIcons)); } catch {}
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
  const el = document.getElementById('shard-bookmarks-list');
  if (!el) return;
  const items = [..._bookmarks].map(id => _notes.find(n => n.id === id)).filter(Boolean);
  if (!items.length) {
    el.innerHTML = '<div style="padding:10px;text-align:center;opacity:0.5;font-size:12px;">No bookmarks yet.<br>Right-click a note and select Bookmark.</div>';
    return;
  }
  el.innerHTML = items.map(n => {
    const icon = _getNoteIconSvg(n.id, 'file', 12);
    return `<div class="shard-bookmark-item" data-note-id="${_esc(n.id)}">
      <span style="display:inline-flex;align-items:center;flex-shrink:0;">${icon}</span>
      ${_esc(n.title)}
    </div>`;
  }).join('');
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
    const backendNotes = data.notes || [];
    // Preserve optimistic notes not yet confirmed by backend
    const optimisticExtras = _notes.filter(n => n._optimistic && !backendNotes.some(b => b.id === n.id || b.rel_path === n.rel_path));
    _notes = [...backendNotes, ...optimisticExtras];
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
let _sourceModeEnabled = false; // when true, main toggle is Read/Source instead of Read/Live
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

async function _flushSourceEdit(sourceDiv, note) {
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
  return `<span class="shard-prop-chip${isTag ? ' is-tag' : ''}" data-chip="${_esc(text)}" data-prop-key="${_esc(key)}" spellcheck="false">
    <span class="shard-prop-chip-text">${_esc(text)}</span>
    <span class="shard-prop-chip-x" data-action="remove-chip" title="Remove">&times;</span>
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
  const fm = (frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)) ? frontmatter : {};
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
    } else if (propType === 'url') {
      const url = String(v ?? '');
      valHtml = `<a class="shard-prop-val shard-prop-url" href="${_esc(url)}" target="_blank" rel="noopener noreferrer" data-prop-key="${_esc(k)}" data-prop-type="${propType}">${_esc(url)}</a>`;
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
  const collapsedClass = _propsCollapsed ? 'collapsed' : '';
  return `<div class="shard-properties-inline ${collapsedClass}" data-properties-container><h4 class="shard-prop-header">Properties<span class="shard-prop-chevron"></span></h4><div class="shard-prop-grid">${rows || ''}</div>${addBtn}</div>`;
}

async function _selectNote(id) {
  _selectedNoteId = id;

  const preview = document.getElementById('shard-preview');
  if (!preview) return;

  try {
    // 1. Render from cache immediately for fast navigation
    let note = _noteContentCache.get(id);
    if (!note) {
      const cached = _notes.find(n => n.id === id || n.rel_path === id);
      if (cached) {
        note = { ...cached };
        _noteContentCache.set(id, note);
      }
    }
    // If nothing in cache, must fetch before rendering
    if (!note) {
      const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(id)}`);
      if (!r.ok) { preview.style.display = 'none'; return; }
      note = await r.json();
      _noteContentCache.set(id, note);
    }
    if (!note) { preview.style.display = 'none'; return; }
    // Server returns frontmatter as a raw YAML string; parse it into an object
    if (note && typeof note.frontmatter === 'string') {
      note.frontmatter = _parseFrontmatter(note.frontmatter);
    }
    preview.style.display = 'block';
    const isAutoRename = _autoRenameNoteId === note.id;
    const showTitle = _shardSettings.appearance.showInlineTitle;
    const scTitle = _shardSettings.editor.spellcheck ? 'true' : 'false';
    const headerHtml = showTitle
      ? `<div class="shard-preview-header">${isAutoRename
          ? `<span class="shard-title-edit" contenteditable="plaintext-only" spellcheck="${scTitle}">${_esc(note.title)}</span>`
          : `<h1>${_esc(note.title)}</h1>`}</div>`
      : '';
    // In source mode, show raw YAML instead of property chips
    const showProps = _previewMode !== 'edit';
    preview.innerHTML = `
      ${headerHtml}
      ${showProps ? _buildPropertiesHtml(note.frontmatter, note) : ''}
      <div class="shard-preview-body"></div>
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
      const titleEdit = preview.querySelector('.shard-title-edit');
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
      const h1 = preview.querySelector('.shard-preview-header h1');
      if (h1) {
        h1.style.cursor = 'pointer';
        h1.title = 'Click to rename';
        h1.addEventListener('click', () => {
          const span = document.createElement('span');
          span.className = 'shard-title-edit';
          span.contentEditable = 'plaintext-only';
          span.spellcheck = _shardSettings.editor.spellcheck;
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
    preview.querySelectorAll('.shard-prop-header').forEach(header => {
      header.addEventListener('click', () => {
        _propsCollapsed = !_propsCollapsed;
        preview.querySelectorAll('.shard-properties-inline').forEach(el => {
          el.classList.toggle('collapsed', _propsCollapsed);
        });
      });
    });

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

    const _wireReadingViewFolds = (wrap) => {
      if (!wrap) return;
      const lines = wrap.querySelectorAll('.lp-line');
      // foldHeading
      if (_shardSettings.editor.foldHeading) {
        lines.forEach(line => {
          const heading = line.querySelector('.md-h1, .md-h2, .md-h3, .md-h4, .md-h5, .md-h6');
          if (!heading) return;
          const hClass = Array.from(heading.classList).find(c => c.startsWith('md-h'));
          if (!hClass) return;
          const level = parseInt(hClass.replace('md-h', ''), 10);
          // Add fold toggle
          const toggle = document.createElement('span');
          toggle.className = 'shard-fold-toggle';
          toggle.textContent = '▼';
          toggle.style.cssText = 'cursor:pointer;margin-right:6px;opacity:0.6;font-size:0.8em;user-select:none;';
          heading.insertBefore(toggle, heading.firstChild);
          toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isCollapsed = toggle.classList.toggle('collapsed');
            toggle.textContent = isCollapsed ? '▶' : '▼';
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
      if (_shardSettings.editor.foldIndent) {
        lines.forEach(line => {
          const liMarker = line.querySelector('.md-li-marker');
          if (!liMarker) return;
          // Determine indent level from the raw text
          const raw = line.getAttribute('data-raw') || '';
          const indentMatch = raw.match(/^(\s*)/);
          const indent = indentMatch ? indentMatch[1].length : 0;
          // Add fold toggle
          const toggle = document.createElement('span');
          toggle.className = 'shard-fold-toggle';
          toggle.textContent = '▼';
          toggle.style.cssText = 'cursor:pointer;margin-right:4px;opacity:0.6;font-size:0.8em;user-select:none;';
          const source = line.querySelector('.lp-source');
          if (source) source.insertBefore(toggle, source.firstChild);
          toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isCollapsed = toggle.classList.toggle('collapsed');
            toggle.textContent = isCollapsed ? '▶' : '▼';
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

    const _renderSourceLine = (line) => {
      let h = _esc(line);
      // Escaped chars \char
      h = h.replace(/\\([*_{}[\]()#+-.!|`~^=$])/g, '<span class="md-escaped"><span class="md-syntax">\\</span>$1</span>');
      // Heading: ### Text
      const hm = h.match(/^(#{1,6})\s+(.*)$/);
      if (hm) { const lvl = hm[1].length; return `<span class="md-h${lvl}"><span class="md-hash">${hm[1]} </span>${hm[2]}</span>`; }
      // Horizontal rule ---
      if (/^---+$/.test(line.trim())) return `<span class="md-hr">${h}</span>`;
      // Blockquote > Text
      if (/^&gt;\s/.test(h)) { h = h.replace(/^&gt;\s/, '<span class="md-bq-mark">&gt; </span>'); return `<span class="md-bq">${h}</span>`; }
      // List item
      const lm = h.match(/^(\s*)([-*+])\s+(.*)$/) || h.match(/^(\s*)(\d+\.)\s+(.*)$/);
      if (lm) {
        const content = lm[3];
        const taskMatch = content.match(/^\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
          return `${lm[1]}<span class="md-li-marker">${lm[2]} </span><span class="md-task"><span class="md-task-check">[${taskMatch[1]}] </span>${taskMatch[2]}</span>`;
        }
        return `${lm[1]}<span class="md-li-marker">${lm[2]} </span>${content}`;
      }
      // Bold + italic ***text***
      h = h.replace(/\*\*\*([^*]+)\*\*\*/g, '<span class="md-bold md-italic"><span class="md-syntax">***</span>$1<span class="md-syntax">***</span></span>');
      // Bold **text**
      h = h.replace(/\*\*([^*]+)\*\*/g, '<span class="md-bold"><span class="md-syntax">**</span>$1<span class="md-syntax">**</span></span>');
      // Italic *text* (avoid matching * inside bold HTML tags)
      h = h.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<span class="md-italic"><span class="md-syntax">*</span>$1<span class="md-syntax">*</span></span>');
      // Italic _text_
      h = h.replace(/(?<!_)_([^_]+)_(?!_)/g, '<span class="md-italic"><span class="md-syntax">_</span>$1<span class="md-syntax">_</span></span>');
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
      // Incomplete wikilinks [[text (still being typed)
      h = h.replace(/\[\[([^\]]*)$/g, (match, content) => {
        return `<span class="md-wikilink"><span class="md-bracket">[[</span><span class="wikilink-source">${_esc(content)}</span></span>`;
      });
      // Alternative wikilinks [/[/text]/]
      h = h.replace(/\[\/\[([^\]]+)\]\/\]/g, (match, content) => {
        const pipeIdx = content.indexOf('|');
        const target = pipeIdx >= 0 ? content.slice(0, pipeIdx).trim() : content.trim();
        const display = pipeIdx >= 0 ? content.slice(pipeIdx + 1).trim() : target;
        return `<span class="md-wikilink"><span class="md-bracket">[/[</span><a class="wikilink-source" href="#" data-note="${_esc(target)}">${_esc(display)}</a><span class="md-bracket">]/]</span></span>`;
      });
      // Incomplete alt wikilinks [/[/text
      h = h.replace(/\[\/\[([^\]]*)$/g, (match, content) => {
        return `<span class="md-wikilink"><span class="md-bracket">[/[</span><span class="wikilink-source">${_esc(content)}</span></span>`;
      });
      // Highlight ==text==
      h = h.replace(/==([^=]+)==/g, '<span class="md-highlight"><span class="md-syntax">==</span>$1<span class="md-syntax">==</span></span>');
      // Images ![alt](url)
      h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<span class="md-image"><span class="md-syntax">!</span><span class="md-syntax">[</span><span class="md-image-alt">$1</span><span class="md-syntax">](</span><span class="md-image-url">$2</span><span class="md-syntax">)</span></span>');
      // Footnotes [^ref]
      h = h.replace(/\[\^([^\]]+)\]/g, '<span class="md-footnote"><span class="md-syntax">[^</span>$1<span class="md-syntax">]</span></span>');
      // Comments %%text%%
      h = h.replace(/%%([^%]+)%%/g, '<span class="md-comment"><span class="md-syntax">%%</span>$1<span class="md-syntax">%%</span></span>');
      // Math inline $text$
      h = h.replace(/\$([^$\s][^$]*[^$\s])\$/g, '<span class="md-math"><span class="md-syntax">$</span>$1<span class="md-syntax">$</span></span>');
      // External links [text](url)
      h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="md-link"><span class="md-syntax">[</span><span class="md-link-text">$1</span><span class="md-syntax">](</span><span class="md-link-url">$2</span><span class="md-syntax">)</span></span>');
      // Live preview Enter inserts \n; normalize to <br> so the break survives innerHTML
      h = h.replace(/\n/g, '<br>');
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
      const isReading = _previewMode === 'preview';
      const strictBreaks = _shardSettings.editor.strictLineBreaks;
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

      for (const line of lines) {
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

    const updateBody = () => {
      if (_previewMode === 'edit') {
        // Source mode: styled text div, contentEditable, clickable wikilinks
        const raw = _getNoteFullRaw(note);
        const lineNumClass = _shardSettings.editor.showLineNumbers ? 'shard-show-line-numbers' : '';
        const sc = _shardSettings.editor.spellcheck ? 'true' : 'false';
        const dir = _shardSettings.editor.rtl ? 'rtl' : 'ltr';
        bodyEl.innerHTML = `<div class="shard-body-wrap" dir="${dir}"><div class="shard-source-view ${lineNumClass}" contenteditable="true" spellcheck="${sc}">${_renderSourceView(raw)}</div></div>`;
        const sourceDiv = bodyEl.querySelector('.shard-source-view');
        _wireSourceWikilinks(sourceDiv);
        sourceDiv.focus();
        sourceDiv.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            document.execCommand('insertText', false, '\n');
          }
        });
        let _sourceRenderTimer = null;
        sourceDiv.addEventListener('input', () => {
          clearTimeout(_sourceRenderTimer);
          _sourceRenderTimer = setTimeout(() => {
            const sel = window.getSelection();
            let offset = 0;
            if (sel.rangeCount) {
              const range = sel.getRangeAt(0);
              offset = _getRawOffsetUpTo(sourceDiv, range.startContainer, range.startOffset);
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
        sourceDiv.addEventListener('blur', async () => {
          clearTimeout(_sourceRenderTimer);
          await _flushSourceEdit(sourceDiv, note);
          _selectNote(note.id);
        }, { once: true });
      } else if (_previewMode === 'live') {
        // Live Preview: token-level inline editing — syntax hidden by default,
        // revealed only for the token(s) containing the cursor.
        const content = note.content || '';
        const dir = _shardSettings.editor.rtl ? 'rtl' : 'ltr';
        bodyEl.innerHTML = `<div class="shard-body-wrap" dir="${dir}"><div class="shard-live-view">${_renderLiveView(content)}</div></div>`;
        const liveDiv = bodyEl.querySelector('.shard-live-view');
        _wireSourceWikilinks(liveDiv);

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
          source.setAttribute('spellcheck', _shardSettings.editor.spellcheck ? 'true' : 'false');
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
        };
        const _debouncedRenderLine = () => {
          clearTimeout(_renderLineTimer);
          _renderLineTimer = setTimeout(() => {
            if (!activeLine) return;
            const source = activeLine.querySelector('.lp-source');
            if (!source) return;
            // Save cursor offset (counts <br> as \n so Enter stays on new line)
            let offset = 0;
            const sel = window.getSelection();
            if (sel.rangeCount) {
              const range = sel.getRangeAt(0);
              offset = _getRawOffsetUpTo(source, range.startContainer, range.startOffset);
            }
            const raw = _getRawFromSource(source);
            activeLine.setAttribute('data-raw', raw);
            source.innerHTML = _renderSourceLine(raw);
            _wireSourceWikilinks(source);
            _setCursorOffset(source, offset);
            _trackCaret();
            _updateWikiSuggest(source);
          }, 50);
        };
        liveDiv.addEventListener('input', _debouncedRenderLine);

        const finishEdit = async () => {
          _hideWikiSuggest();
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
          el.className = 'shard-wiki-suggest';
          el.innerHTML = matches.map((t, i) =>
            `<div class="shard-wiki-suggest-item${i === 0 ? ' selected' : ''}" data-title="${_esc(t)}">${_highlightSuggest(t, query)}</div>`
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
          el.querySelectorAll('.shard-wiki-suggest-item').forEach(item => {
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

          const useWiki = _shardSettings.filesAndLinks.useWikilinks;
          const format = _shardSettings.filesAndLinks.linkFormat;
          const closeBrackets = isAlt ? ']/]' : ']]';

          const fullText = _getRawFromSource(source);
          const textAfterCursor = fullText.slice(textBefore.length);
          const alreadyClosed = textAfterCursor.startsWith(closeBrackets);

          // Compute link path based on format
          const targetNote = _notes.find(n => n.title === title);
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
            if (_shardSettings.editor.smartLists) {
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

          // Tab: indent with tabs or spaces
          if (e.key === 'Tab' && activeLine) {
            e.preventDefault();
            const indent = _shardSettings.editor.indentWithTabs ? '\t' : '  ';
            document.execCommand('insertText', false, indent);
            return;
          }

          // Bracket auto-close
          if (e.key === '[' && _shardSettings.editor.autoPairBrackets) {
            e.preventDefault();
            const sel = window.getSelection();
            if (!sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            const prev = _getCharBeforeCursor();
            const next = _getCharAfterCursor();
            if (_shardSettings.editor.autoPairMarkdown && _shardSettings.filesAndLinks.useWikilinks && prev === '[') {
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
            } else if (_shardSettings.editor.autoPairMarkdown && _shardSettings.filesAndLinks.useWikilinks && _getTextBeforeCursor(source).endsWith('[/')) {
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
            if (_shardSettings.editor.autoPairMarkdown) _updateWikiSuggest(source);
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
        const dir = _shardSettings.editor.rtl ? 'rtl' : 'ltr';
        bodyEl.innerHTML = `<div class="shard-body-wrap" dir="${dir}"><div class="shard-reading-view">${_renderLiveView(content)}</div></div>`;
        const wrap = bodyEl.querySelector('.shard-reading-view');
        _wireSourceWikilinks(wrap);
        _wireReadingViewFolds(wrap);
        wrap.addEventListener('dblclick', () => {
          _previewMode = _editModePref;
          _updateModeButtons();
          _selectNote(note.id);
        });
      }
    };
    updateBody();
    let wcEl = document.getElementById('shard-word-count');
    if (!wcEl) { wcEl = document.createElement('div'); wcEl.id = 'shard-word-count'; wcEl.className = 'shard-word-count'; }
    const panelWrap = preview?.parentElement;
    if (panelWrap && wcEl.parentElement !== panelWrap) panelWrap.appendChild(wcEl);
    const wordCount = (note.content || '').split(/\s+/).filter(Boolean).length;
    wcEl.textContent = `${wordCount} words`;
    _updateModeButtons();
    const viewModes = document.getElementById('shard-view-modes');
    if (viewModes) {
      viewModes.style.display = 'flex';
      viewModes.querySelectorAll('.shard-mode-btn').forEach(btn => {
        btn.onclick = async () => {
          const mode = btn.dataset.viewMode;
          if (_previewMode === 'edit' && mode !== 'edit') {
            const sourceDiv = bodyEl.querySelector('.shard-source-view');
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
    const menuBtn = document.getElementById('shard-note-menu-btn');
    const menuDropdown = document.getElementById('shard-note-menu-dropdown');
    if (menuBtn && menuDropdown) {
      menuBtn.style.display = 'flex';
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        const isHidden = menuDropdown.classList.contains('hidden');
        document.querySelectorAll('.shard-note-menu-dropdown').forEach(d => d.classList.add('hidden'));
        if (isHidden) {
          menuDropdown.classList.remove('hidden');
          const sourceItem = menuDropdown.querySelector('[data-action="source"]');
          if (sourceItem) sourceItem.classList.toggle('is-checked', _sourceModeEnabled);
        }
      };
      menuDropdown.querySelectorAll('.shard-note-menu-item:not(.shard-note-menu-disabled)').forEach(item => {
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
    const noteMenuBtn = document.getElementById('shard-note-menu-btn');
    if (noteMenuBtn) {
      noteMenuBtn.style.display = 'flex';
      noteMenuBtn.onclick = (e) => _showNoteMenu(e, note);
    }

    // Wire all property editors
    _wirePropertyEditors(preview, note);

    _renderRightSidebar(note);

    // Background: fetch fresh content to detect external edits & resolve backlinks
    const _originalContent = note.content;
    // Skip if this note ID was renamed and no longer exists client-side
    const stillExists = _notes.some(n => n.id === id || n.rel_path === id);
    if (!stillExists) return;
    fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(id)}`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(full => {
        if (!full) return;
        _noteContentCache.set(id, full);
        if (_selectedNoteId !== full.id && _selectedNoteId !== full.rel_path) return;
        _renderRightSidebar(full);
        // Only silently refresh if user hasn't locally edited since we started the fetch,
        // and we're not in edit mode (to avoid stealing focus).
        const hasActiveLiveEditor = preview.querySelector('.lp-source[contenteditable="true"]');
        const userEditedSinceFetch = note.content !== _originalContent;
        if (!hasActiveLiveEditor && !userEditedSinceFetch && _previewMode !== 'edit' && full.content !== note.content) {
          note.content = full.content;
          note.title = full.title;
          if (typeof full.frontmatter === 'string') {
            note.frontmatter = _parseFrontmatter(full.frontmatter);
          } else {
            note.frontmatter = full.frontmatter;
          }
          updateBody();
          _applyMonospaceFont();
          // Refresh header title if it changed
          const h1 = preview.querySelector('.shard-preview-header h1');
          if (h1 && h1.textContent !== note.title) h1.textContent = note.title;
          const titleEdit = preview.querySelector('.shard-title-edit');
          if (titleEdit && titleEdit.textContent !== note.title) titleEdit.textContent = note.title;
          // Refresh word count
          const wcEl = document.getElementById('shard-word-count');
          if (wcEl) wcEl.textContent = `${(note.content || '').split(/\s+/).filter(Boolean).length} words`;
        }
      })
      .catch(() => {});

    // Re-apply monospace font to newly created editor/view elements
    _applyMonospaceFont();
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
      let subLeft = tRect.right + 4;
      const subWidth = 170; // approximate submenu width
      if (subLeft + subWidth > window.innerWidth) {
        subLeft = Math.max(4, tRect.left - subWidth - 4);
      }
      sub.style.left = subLeft + 'px';
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

    // Click anywhere in the value box to focus the inline input
    container.addEventListener('click', (e) => {
      if (e.target.closest('.shard-prop-chip')) return; // ignore chip clicks
      const inlineInput = container.querySelector('.shard-prop-chip-input');
      if (inlineInput) { inlineInput.focus(); }
    });

    // Inline input for adding new chips — only show tag autocomplete for the tags property
    const inlineInput = container.querySelector('.shard-prop-chip-input');
    if (inlineInput && key.toLowerCase() === 'tags') {
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
        return `<div class="shard-prop-add-option" data-prop="${_esc(p.name)}" data-type="${_esc(p.type)}">${icon}<span class="shard-prop-add-name">${_esc(p.name)}</span><span class="shard-prop-add-type">${label}</span></div>`;
      }).join('');
      dropdown.innerHTML = `${options}<div class="shard-prop-add-option" data-prop="__custom"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span class="shard-prop-add-name">New property</span></div>`;
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
  const pane = document.getElementById('shard-right-pane');
  if (!pane) return;
  const placeholder = document.getElementById('shard-right-placeholder');
  if (placeholder) placeholder.classList.add('hidden');
  document.getElementById('shard-right-tabs')?.classList.remove('hidden');
  document.getElementById('shard-right-panes')?.classList.remove('hidden');

  switch (_activeRightTab) {
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

  // Update word-count plugin when active note changes
  const wc = _pluginManager?.getInstance('word-count');
  if (wc && typeof wc.update === 'function') wc.update();
}

function _renderBacklinksPane(note) {
  const bl = document.getElementById('shard-backlinks-panel');
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
        ${(b.snippets || []).map(s => `<div class="shard-backlink-snippet" style="margin-bottom:6px;padding:6px 8px;background:color-mix(in srgb, var(--fg) 4%, transparent);border-radius:6px;cursor:pointer;">${_highlightBacklinkSnippet(s, targetNames)}</div>`).join('')}
      </div>
    </div>`;
  }).join('') : `<div class="shard-backlink-item">
    <div class="shard-backlink-header" style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;opacity:0.5;">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">No backlinks</span>
    </div>
  </div>`;
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
  if (!out || !note) return;
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

function _renderLocalGraph(note) {
  const container = document.getElementById('shard-local-graph-canvas');
  if (!container || !window.vis) return;
  if (!note) {
    container.innerHTML = '<div class="shard-graph-loading">Select a note to see its local graph.</div>';
    return;
  }
  import('./shardGraphCanvas.js').then(mod => {
    mod.renderLocalGraph(container, _selectedVaultId, note.rel_path || note.id);
  }).catch(err => {
    container.innerHTML = `<div class="shard-error">Local graph error: ${err.message}</div>`;
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

  // Plugin settings sidebar resize
  const pluginResize = document.getElementById('shard-plugin-resize');
  const pluginSidebar = document.getElementById('shard-plugin-settings-sidebar');
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
      document.documentElement.style.setProperty('--shard-plugin-sidebar-w', newSize + 'px');
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
        let submenuTimeout = null;
        row.addEventListener('mouseenter', () => {
          clearTimeout(submenuTimeout);
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
        const data = await r.json().catch(() => ({}));
        if (data.new_path && note) {
          const newId = data.new_path;
          _syncNoteIdAfterMove(noteId, newId);
          note.id = newId;
          note.rel_path = newId;
        }
      } catch {
        if (note) note.folder = oldFolder;
        _renderFolderTree();
      }
    },
  }));
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
      console.error('[shard] shell-open-path failed:', err);
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
      console.error('[shard] shell-show-item failed:', err);
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
      console.error('[shard] shell-show-item failed:', err);
      showToast('Electron shell not available. If you recently updated main.js, restart Electron.');
    });
  } else {
    showToast('Desktop shell not available in browser');
  }
}

function _showIconPicker(targetId, x, y, type = 'note') {
  const existing = document.querySelector('.shard-icon-picker');
  if (existing) existing.remove();
  const picker = document.createElement('div');
  picker.className = 'shard-icon-picker';
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
      const btn = document.querySelector('.shard-prop-add-main');
      if (btn) btn.click();
      _navigateToNote(noteId, true);
    }},
    { label: 'Add field at section...', disabled: true, action: () => {} },
    { label: 'Add field in frontmatter', action: () => {
      const btn = document.querySelector('.shard-prop-add-main');
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
    const preview = document.getElementById('shard-preview');
    if (preview) preview.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;">Select a note to view</div>';
  }

  try {
    const r = await fetch(`${API_BASE}/api/shard/folders/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ folder_path: folder }),
    });
    if (!r.ok) throw new Error();
  } catch (e) {
    console.error('[shard] delete folder failed, rolling back', e);
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
  const searchInput = document.getElementById('shard-search-input');
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
    { label: 'Create new note from template', disabled: true, action: () => {} },
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
    { label: 'New folder', action: () => _promptNewFolder('') },
    { separator: true },
    { label: 'Collapse all', action: () => _collapseAllFolders() },
    { label: 'Expand all', action: () => _expandAllFolders() },
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
  if (_shardSettings.filesAndLinks.autoUpdateLinks) {
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
  if (linkUpdates.length && _shardSettings.filesAndLinks.confirmAutoUpdateLinks !== false) {
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
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(noteId)}/rename`, {
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
        console.error('[shard] auto-update background save failed:', err);
        showToast('Some link updates failed to save');
      });
    }
    console.log('[shard] auto-update links:', { oldTitle, newName, updatedCount: linkUpdates.length });
  } catch (e) {
    console.error('[shard] rename failed, rolling back', e);
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
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(noteId)}/duplicate`, {
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
    console.error('[shard] duplicate failed', e);
    const idx = _notes.findIndex(n => n.id === dupPath);
    if (idx !== -1) _notes.splice(idx, 1);
    _renderFolderTree();
    showToast('Failed to duplicate note');
  }
}
async function _deleteNote(noteId) {
  const note = _notes.find(n => n.id === noteId);
  if (!note) return;
  if (_shardSettings.filesAndLinks.confirmDelete) {
    const confirmed = await styledConfirm(`Delete "${_esc(note.title)}"?`, { confirmText: 'Delete', cancelText: 'Cancel', danger: true });
    if (!confirmed) return;
  }

  // Optimistic: remove immediately
  const noteIdx = _notes.indexOf(note);
  _notes.splice(noteIdx, 1);
  const hadTab = _openTabs.includes(noteId);
  _openTabs = _openTabs.filter(id => id !== noteId);
  const prevSelected = _selectedNoteId;
  if (_selectedNoteId === noteId) {
    _selectedNoteId = _openTabs.length ? _openTabs[_openTabs.length - 1] : null;
    const preview = document.getElementById('shard-preview');
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
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(noteId)}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
    if (!r.ok) throw new Error();
  } catch (e) {
    // Rollback
    console.error('[shard] delete failed, rolling back', e);
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
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(fileName)}/edit`, {
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
    console.error('[shard] create ghost note failed', e);
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
    const r = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(fileName)}/edit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ content: '' }),
    });
    if (!r.ok) throw new Error();

    if (folder) {
      try {
        const moveR = await fetch(`${API_BASE}/api/shard/notes/${encodeURIComponent(fileName)}/move`, {
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
    console.error('[shard] create note failed', e);
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
    const r = await fetch(`${API_BASE}/api/shard/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ path }),
    });
    if (!r.ok) throw new Error();
    const idx2 = _folders.indexOf(_optimisticFolderPath);
    if (idx2 !== -1) delete _folders[idx2]._optimistic;
  } catch (e) {
    console.error('[shard] create folder failed', e);
    const idx = _folders.indexOf(path);
    if (idx !== -1) _folders.splice(idx, 1);
    _renderFolderTree();
    showToast('Failed to create folder');
  }
}
function _startInlineFolderRename(folderPath) {
  // Find the folder row in the tree and make its label editable
  const tree = document.getElementById('shard-folder-tree');
  if (!tree) return;
  const row = tree.querySelector(`.shard-tree-row[data-folder="${CSS.escape(folderPath)}"] .shard-tree-name`);
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
  const newName = await styledPrompt('Rename folder:', { defaultValue: folder.split('/').pop(), confirmText: 'Rename' });
  if (!newName || newName === folder.split('/').pop()) return;
  try {
    const parent = folder.includes('/') ? folder.split('/').slice(0, -1).join('/') : '';
    const newPath = parent ? `${parent}/${newName}` : newName;
    const r = await fetch(`${API_BASE}/api/shard/folders/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ old_path: folder, new_path: newPath }),
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

// ── Sidebar tab drag-and-drop ───────────────────────────────

function _wireSidebarTabDnD(containerId, settingsKey) {
  const container = document.getElementById(containerId);
  if (!container) return;
  let draggedTab = null;
  let lastHoverTarget = null;
  const isRight = containerId === 'shard-right-tabs';
  const tabSelector = isRight ? '.shard-right-tab' : '.shard-sidebar-tab';

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
    if (!_shardSettings.appearance) _shardSettings.appearance = {};
    _shardSettings.appearance[settingsKey] = newOrder;
    _saveShardSettings();
  });
}

function _applySidebarOrder(containerId, settingsKey) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const order = _shardSettings?.appearance?.[settingsKey];
  if (!order || !order.length) return;
  const tabs = Array.from(container.children);
  const tabMap = new Map(tabs.map(t => [t.dataset.tab, t]));
  for (const tabId of order) {
    const tab = tabMap.get(tabId);
    if (tab) container.appendChild(tab);
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

  // Sidebar tab drag-and-drop
  _wireSidebarTabDnD('shard-left-tabs', 'leftSidebarOrder');
  _wireSidebarTabDnD('shard-right-tabs', 'rightSidebarOrder');
  _applySidebarOrder('shard-left-tabs', 'leftSidebarOrder');
  _applySidebarOrder('shard-right-tabs', 'rightSidebarOrder');

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

  // Settings dialog wiring
  _wireShardSettings();
  _wireSnippetSettings();
  _injectCssSnippets();
  _loadShardSettings();
  const dv = _shardSettings.editor.defaultView;
  _previewMode = dv === 'live' ? 'live' : dv === 'source' ? 'edit' : 'preview';
  _editModePref = dv === 'source' ? 'edit' : 'live';
  _sourceModeEnabled = dv === 'source';
  _applyMonospaceFont();
  _applyReadableLineLength();
  _renderRibbon();

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
    let settings = JSON.parse(localStorage.getItem('shard-settings') || '{}');
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

  // ── Eager cache restore so openPanel() never blocks on "Loading vaults..." ──
  _restoreVaultsAndWarmCache();
}

function _restoreVaultsAndWarmCache() {
  try {
    const cached = localStorage.getItem('shard-vaults');
    if (cached) {
      const { vaults } = JSON.parse(cached);
      if (vaults && vaults.length) {
        _vaults = vaults;
        _populateVaultDropdown();
        let lastVault = null;
        try { lastVault = localStorage.getItem('shard-last-vault'); } catch {}
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

/** Remove / restore tab buttons whose feature is a toggleable plugin */
function _syncPluginTabs() {
  if (!_pluginManager) return;

  const _sync = (containerSelector, map) => {
    const container = document.querySelector(containerSelector);
    if (!container) return;
    container.querySelectorAll(':scope > [data-tab]').forEach(btn => {
      const tab = btn.dataset.tab;
      const pid = map[tab];
      if (!pid) return;
      const enabled = _pluginManager.isEnabled(pid);
      if (!enabled && btn.parentNode) {
        _removedTabs.set(tab, btn);
        btn.remove();
      }
    });
    // Restore any tabs that are now enabled
    for (const [tab, pid] of Object.entries(map)) {
      if (!_pluginManager.isEnabled(pid)) continue;
      const detached = _removedTabs.get(tab);
      if (!detached) continue;
      // Find insertion point: keep original order by looking at remaining tabs
      const tabsInDom = Array.from(container.querySelectorAll(':scope > [data-tab]'));
      const allTabNames = ['files', 'bookmarks', 'tags', 'graph', 'search'];
      const rightTabNames = ['backlinks', 'outgoing', 'unlinked', 'outline', 'orphans', 'local-graph'];
      const order = containerSelector.includes('right') ? rightTabNames : allTabNames;
      const idx = order.indexOf(tab);
      let inserted = false;
      for (let i = idx + 1; i < order.length; i++) {
        const after = tabsInDom.find(b => b.dataset.tab === order[i]);
        if (after) {
          container.insertBefore(detached, after);
          inserted = true;
          break;
        }
      }
      if (!inserted) container.appendChild(detached);
      _removedTabs.delete(tab);
    }
  };

  _sync('#shard-right-tabs', {
    backlinks: 'backlinks',
    outgoing: 'outgoing-links',
    unlinked: 'unlinked',
    outline: 'outline',
    orphans: 'orphans',
  });

  _sync('#shard-left-tabs', {
    bookmarks: 'bookmarks',
    tags: 'tags',
    search: 'search',
    graph: 'graph',
  });

  // If active tab was removed, switch to a safe fallback
  if (!document.querySelector(`#shard-left-tabs [data-tab="${_activeLeftTab}"]`)) {
    _switchLeftTab('files');
  }
  if (!document.querySelector(`#shard-right-tabs [data-tab="${_activeRightTab}"]`)) {
    const firstRight = document.querySelector('#shard-right-tabs [data-tab]');
    if (firstRight) _switchRightTab(firstRight.dataset.tab);
  }
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
      <div class="shard-qs-item" data-note-id="${_esc(n.id)}" data-index="${i}" style="padding:7px 14px;font-size:13px;cursor:pointer;pointer-events:auto;display:flex;align-items:center;gap:8px;border-radius:4px;margin:0 4px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(n.title || n.id)}</span>
        <span style="opacity:0.4;font-size:11px;">${_esc(n.folder || '')}</span>
      </div>
    `).join('');
    _quickSwitcherIndex = 0;
    _updateQsSelection(results);
  };

  const _updateQsSelection = (container) => {
    const allItems = container.querySelectorAll('.shard-qs-item');
    if (_quickSwitcherIndex < 0) _quickSwitcherIndex = 0;
    if (_quickSwitcherIndex >= allItems.length) _quickSwitcherIndex = allItems.length - 1;
    allItems.forEach((el, i) => {
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
  const modal = document.getElementById('shard-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (e.key === 'Escape' && _commandPaletteEl) return;
  if (e.key === 'Escape' && _quickSwitcherEl) return;
  const hotkeys = _shardSettings.hotkeys || {};
  for (const [cmdId, combo] of Object.entries(hotkeys)) {
    if (!combo || !_matchesShardCombo(e, combo)) continue;
    e.preventDefault();
    _runCommandById(cmdId);
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

  const BASE_COMMANDS = SHARD_COMMANDS.filter(c => c.impl !== false).map(c => ({
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
