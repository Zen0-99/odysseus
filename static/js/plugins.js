/**
 * Plugins panel — discover, install, and manage Odysseus plugins.
 */

import { makeWindowDraggable } from './windowDrag.js';

const _FAV_KEY = 'odysseus_plugin_favourites';
const _AUTO_RELOAD_KEY = 'odysseus_plugin_auto_reload';
const _RECENT_KEY = 'odysseus_plugin_recent_searches';

const _pluginState = {
  discovered: [],
  installed: [],
  selectedIds: new Set(),
  currentDetail: null,
  _sortMode: 'name',
  _currentTab: 'discover',
};

function el(id) { return document.getElementById(id); }

function _showToast(msg) {
  const t = el('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function _showReloadPrompt(message, onConfirm) {
  const autoReload = localStorage.getItem(_AUTO_RELOAD_KEY) === 'true';
  if (autoReload) {
    onConfirm(true);
    return;
  }

  let overlay = document.getElementById('plugin-reload-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'plugin-reload-overlay';
    overlay.className = 'modal';
    overlay.innerHTML =
      '<div class="modal-content styled-confirm-box" role="dialog" aria-modal="true" style="width:min(400px,92vw);">' +
        '<div class="modal-header"><h4 style="margin:0;font-size:1rem;font-weight:600;color:var(--red);">Reload Required</h4></div>' +
        '<div class="modal-body"><p id="plugin-reload-msg" style="margin:0 0 12px;font-size:14px;opacity:0.85;"></p>' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;opacity:0.75;">' +
            '<input type="checkbox" id="plugin-reload-dont-ask" style="accent-color:var(--accent,var(--red));width:14px;height:14px;cursor:pointer;" />' +
            'Don\'t ask again — reload automatically next time' +
          '</label></div>' +
        '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">' +
          '<button id="plugin-reload-cancel" class="confirm-btn confirm-btn-secondary">Cancel</button>' +
          '<button id="plugin-reload-ok" class="confirm-btn confirm-btn-primary">Reload</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  const msgEl = document.getElementById('plugin-reload-msg');
  const okBtn = document.getElementById('plugin-reload-ok');
  const cancelBtn = document.getElementById('plugin-reload-cancel');
  const dontAskBox = document.getElementById('plugin-reload-dont-ask');

  msgEl.textContent = message;
  if (dontAskBox) dontAskBox.checked = false;

  const _prevFocus = document.activeElement;
  overlay.classList.remove('hidden');
  overlay.style.display = '';

  function cleanup(result) {
    overlay.classList.add('hidden');
    overlay.style.display = 'none';
    okBtn.removeEventListener('click', onOk);
    cancelBtn.removeEventListener('click', onCancel);
    overlay.removeEventListener('click', onBackdrop);
    document.removeEventListener('keydown', onKey);
    try { _prevFocus && _prevFocus.focus && _prevFocus.focus(); } catch {}
    onConfirm(result);
  }
  function onOk() {
    if (dontAskBox && dontAskBox.checked) {
      localStorage.setItem(_AUTO_RELOAD_KEY, 'true');
    }
    cleanup(true);
  }
  function onCancel() { cleanup(false); }
  function onBackdrop(e) { if (e.target === overlay) cleanup(false); }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      cleanup(false);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const f = [cancelBtn, okBtn, dontAskBox].filter(Boolean);
      const i = f.indexOf(document.activeElement);
      const n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i >= f.length - 1 ? 0 : i + 1);
      f[n] && f[n].focus();
    }
  }

  okBtn.addEventListener('click', onOk);
  cancelBtn.addEventListener('click', onCancel);
  overlay.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKey);
  okBtn.focus();
}

function _capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------- Favourites ---------- */
function _getFavs() {
  try { return JSON.parse(localStorage.getItem(_FAV_KEY)) || []; } catch (_) { return []; }
}
function _setFavs(arr) { localStorage.setItem(_FAV_KEY, JSON.stringify(arr)); }
function _isFav(id) { return _getFavs().includes(id); }
function _toggleFav(id) {
  const favs = _getFavs();
  const idx = favs.indexOf(id);
  if (idx >= 0) favs.splice(idx, 1); else favs.push(id);
  _setFavs(favs);
}

/* ---------- Icons ---------- */
const _ICON_STAR = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
const _ICON_STAR_FILL = `<svg width="24" height="24" viewBox="0 0 24 24" fill="var(--accent,var(--red))"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

/* ---------- Tabs ---------- */
function _switchTab(tab) {
  _pluginState._currentTab = tab;
  el('plugin-panel-discover').style.display = tab === 'discover' ? 'block' : 'none';
  el('plugin-panel-installed').style.display = tab === 'installed' ? 'block' : 'none';
  el('plugin-panel-favourites').style.display = tab === 'favourites' ? 'block' : 'none';
  document.querySelectorAll('#plugin-tabs .admin-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.pluginTab === tab);
  });
  if (tab === 'installed') _renderInstalled();
  else if (tab === 'favourites') _renderFavourites();
  else _renderDiscover();
  _closeDetail();
}

function _tagPill(tag) {
  const label = _capitalize(String(tag));
  return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;background:color-mix(in srgb, var(--accent, var(--red)) 15%, transparent);border:1px solid var(--accent, var(--red));font-size:10px;color:var(--accent, var(--red));font-weight:500;">${label}</span>`;
}

function _escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _mdToHtml(text) {
  if (!text) return '';
  // Strip any existing HTML for safety
  let s = String(text).replace(/<[^>]*>/g, '');
  const lines = s.split('\n');
  const out = [];
  let inUl = false;
  let inOl = false;

  function _inline(t) {
    return t
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');
  }

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.match(/^#{1,6}\s/)) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
      const level = line.match(/^#+/)[0].length;
      const content = _escHtml(line.replace(/^#+\s*/, ''));
      if (level === 1) out.push(`<h4 style="font-size:14px;margin:8px 0 4px;">${content}</h4>`);
      else if (level === 2) out.push(`<h5 style="font-size:13px;margin:6px 0 3px;">${content}</h5>`);
      else if (level === 3) out.push(`<h6 style="font-size:12px;margin:4px 0 2px;">${content}</h6>`);
      else out.push(`<p><strong>${content}</strong></p>`);
      continue;
    }
    const numMatch = line.match(/^(\d+)\.\s+(.*)/);
    if (numMatch) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol style="margin:4px 0;padding-left:18px;font-size:12px;">'); inOl = true; }
      out.push(`<li>${_inline(_escHtml(numMatch[2]))}</li>`);
      continue;
    }
    const bulletMatch = line.match(/^[-*]\s+(.*)/);
    if (bulletMatch) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul style="margin:4px 0;padding-left:18px;font-size:12px;">'); inUl = true; }
      out.push(`<li>${_inline(_escHtml(bulletMatch[1]))}</li>`);
      continue;
    }
    if (line.trim() === '') {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
      continue;
    }
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
    out.push(`<p style="margin:0 0 4px;">${_inline(_escHtml(line))}</p>`);
  }
  if (inUl) out.push('</ul>');
  if (inOl) out.push('</ol>');
  return out.join('\n');
}

/* ── Search dropdown helpers ── */
function _saveRecentSearch(query) {
  if (!query) return;
  const arr = JSON.parse(localStorage.getItem(_RECENT_KEY) || '[]');
  const cleaned = arr.filter(q => q !== query);
  cleaned.unshift(query);
  localStorage.setItem(_RECENT_KEY, JSON.stringify(cleaned.slice(0, 10)));
}

function _getRecentSearches() {
  return JSON.parse(localStorage.getItem(_RECENT_KEY) || '[]').slice(0, 3);
}

function _renderSearchDropdown() {
  const dropdown = el('plugin-search-dropdown');
  const recentContainer = el('plugin-search-recent');
  if (!dropdown || !recentContainer) return;
  const recents = _getRecentSearches();
  if (recents.length) {
    recentContainer.innerHTML = `<div style="font-size:10px;opacity:0.5;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;">Recent</div>` +
      recents.map(q => `<div class="plugin-search-item" data-query="${_escHtml(q)}" style="padding:4px 6px;border-radius:4px;cursor:pointer;font-size:12px;opacity:0.85;">${_escHtml(q)}</div>`).join('');
  } else {
    recentContainer.innerHTML = '';
  }
  dropdown.classList.remove('hidden');
}

function _hideSearchDropdown() {
  const dropdown = el('plugin-search-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
}

function _applyFilter(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    _renderDiscover();
    _renderInstalled();
    _renderFavourites();
    return;
  }
  const tagMatch = q.match(/^tag:\s*(.+)/);
  const nameMatch = q.match(/^name:\s*(.+)/);
  const descMatch = q.match(/^desc:\s*(.+)/);
  const filterFn = (p) => {
    if (tagMatch) {
      const t = tagMatch[1].toLowerCase();
      return (p._tags || []).some(tag => tag.toLowerCase().includes(t));
    }
    if (nameMatch) {
      const n = nameMatch[1].toLowerCase();
      return (p.name || '').toLowerCase().includes(n);
    }
    if (descMatch) {
      const d = descMatch[1].toLowerCase();
      return (p.description || '').toLowerCase().includes(d);
    }
    const plain = q;
    return (p.name || '').toLowerCase().includes(plain) || (p.description || '').toLowerCase().includes(plain);
  };
  // Re-render with filtered data without mutating original state
  if (_pluginState._currentTab === 'discover') {
    const filtered = _pluginState.discovered.filter(filterFn);
    _renderDiscover(filtered);
  } else if (_pluginState._currentTab === 'installed') {
    const filtered = _pluginState.installed.filter(filterFn);
    _renderInstalled(filtered);
  } else if (_pluginState._currentTab === 'favourites') {
    const all = [..._pluginState.discovered, ..._pluginState.installed];
    const favMap = new Map();
    for (const p of all) if (_getFavs().includes(p.id) && !favMap.has(p.id)) favMap.set(p.id, p);
    const filtered = Array.from(favMap.values()).filter(filterFn);
    _renderFavourites(filtered);
  }
}

/* ---------- Inline checkbox ---------- */
function _checkSvg(checked) {
  return checked
    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
    : '';
}

function _renderCardCheckbox(id, checked) {
  const active = checked ? 'background:var(--accent,var(--red));border-color:var(--accent,var(--red));color:#fff;' : 'background:transparent;border-color:var(--border);color:var(--fg);';
  return `<span class="plugin-card-check" data-check-id="${id}" style="width:18px;height:18px;border-radius:3px;border:1.5px solid;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:all .15s;vertical-align:middle;margin-left:4px;${active}">${_checkSvg(checked)}</span>`;
}

function _isInstalled(id) {
  return _pluginState.installed.some(i => i.id === id);
}

/* ---------- Discover ---------- */
function _renderDiscover(items) {
  const grid = el('plugin-discover-grid');
  const empty = el('plugin-discover-empty');
  const data = items || _pluginState.discovered;
  if (!data.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  const showChecks = data.length > 1;
  const installedIds = new Set(_pluginState.installed.map(i => i.id));

  grid.innerHTML = data.map(p => {
    const checked = _pluginState.selectedIds.has(p.id);
    const installed = installedIds.has(p.id) ? `<span style="font-size:10px;opacity:0.5;">installed</span>` : '';
    const version = p.version ? `<span style="font-size:10px;opacity:0.5;">v${p.version}</span>` : '';
    const checkHtml = showChecks ? _renderCardCheckbox(p.id, checked) : '';
    return `<div class="plugin-card" data-plugin-id="${p.id}" style="padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--panel);cursor:pointer;transition:background .15s;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <strong style="font-size:13px;">${p.name}</strong>
        ${version}
        ${installed}
      </div>
      <p style="margin:0 0 8px;font-size:11px;opacity:0.7;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${p.description}</p>
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">${(p._tags && p._tags.length ? p._tags : ['Other']).map(_tagPill).join('')}${checkHtml}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.plugin-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.plugin-card-check')) return;
      const id = card.dataset.pluginId;
      _openDetail(id);
    });
    card.addEventListener('mouseenter', () => { card.style.background = 'var(--input-bg)'; });
    card.addEventListener('mouseleave', () => { card.style.background = 'var(--panel)'; });
  });
  function _onCheckClick(e) {
    e.stopPropagation();
    const chk = e.currentTarget;
    const id = chk.dataset.checkId;
    const now = !_pluginState.selectedIds.has(id);
    if (now) _pluginState.selectedIds.add(id);
    else _pluginState.selectedIds.delete(id);
    chk.outerHTML = _renderCardCheckbox(id, now);
    const newChk = grid.querySelector(`.plugin-card-check[data-check-id="${id}"]`);
    if (newChk) newChk.addEventListener('click', _onCheckClick);
    _updateSelectedCount();
  }
  grid.querySelectorAll('.plugin-card-check').forEach(chk => {
    chk.addEventListener('click', _onCheckClick);
  });
}

function _updateSelectedCount() {
  const count = _pluginState.selectedIds.size;
  const label = el('plugin-selected-count');
  if (label) label.textContent = count > 0 ? `${count} selected` : '';
}

/* ---------- Installed ---------- */
function _renderInstalled(items) {
  const list = el('plugin-installed-list');
  const empty = el('plugin-installed-empty');
  let data = items ? [...items] : [..._pluginState.installed];
  if (!items && _pluginState._sortMode === 'name') {
    data.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (!items && _pluginState._sortMode === 'date') {
    data.sort((a, b) => (b.installed_at || '').localeCompare(a.installed_at || ''));
  }

  if (!data.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = data.map(p => {
    const updateBadge = p._updateAvailable ? `<span style="font-size:10px;color:var(--accent,var(--red));margin-left:4px;">update</span>` : '';
    const hashBadge = p._hash_ok === false
      ? `<span title="Integrity check failed" style="font-size:10px;color:var(--red);margin-left:4px;">tampered</span>`
      : (p._hash_ok === true ? `<span title="Integrity verified" style="font-size:10px;color:var(--color-save-green,#4caf50);margin-left:4px;">verified</span>` : '');
    return `<div class="plugin-card" data-plugin-id="${p.id}" style="padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--panel);cursor:pointer;transition:background .15s;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <strong style="font-size:13px;">${p.name}</strong>
        <span style="font-size:10px;opacity:0.5;">v${p.version || '?'}</span>
        ${updateBadge}
        ${hashBadge}
      </div>
      <p style="margin:0 0 8px;font-size:11px;opacity:0.7;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${p.description}</p>
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">${(p._tags && p._tags.length ? p._tags : ['Other']).map(_tagPill).join('')}</div>
    </div>`;
  }).join('');

  list.querySelectorAll('.plugin-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.pluginId;
      _openDetail(id);
    });
    card.addEventListener('mouseenter', () => { card.style.background = 'var(--input-bg)'; });
    card.addEventListener('mouseleave', () => { card.style.background = 'var(--panel)'; });
  });
}

/* ---------- Favourites ---------- */
function _renderFavourites(items) {
  const list = el('plugin-favourites-list');
  const empty = el('plugin-favourites-empty');
  let data;
  if (items) {
    data = items;
  } else {
    const favIds = _getFavs();
    const all = [..._pluginState.discovered, ..._pluginState.installed];
    const favMap = new Map();
    for (const p of all) if (favIds.includes(p.id) && !favMap.has(p.id)) favMap.set(p.id, p);
    data = Array.from(favMap.values());
  }

  if (!data.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = data.map(p => {
    const installed = _isInstalled(p.id) ? `<span style="font-size:10px;opacity:0.5;">installed</span>` : '';
    return `<div class="plugin-card" data-plugin-id="${p.id}" style="padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--panel);cursor:pointer;transition:background .15s;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <strong style="font-size:13px;">${p.name}</strong>
        <span style="font-size:10px;opacity:0.5;">v${p.version || '?'}</span>
        ${installed}
      </div>
      <p style="margin:0 0 8px;font-size:11px;opacity:0.7;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${p.description}</p>
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">${(p._tags && p._tags.length ? p._tags : ['Other']).map(_tagPill).join('')}</div>
    </div>`;
  }).join('');

  list.querySelectorAll('.plugin-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.pluginId;
      _openDetail(id);
    });
    card.addEventListener('mouseenter', () => { card.style.background = 'var(--input-bg)'; });
    card.addEventListener('mouseleave', () => { card.style.background = 'var(--panel)'; });
  });
}

/* ---------- Detail panel ---------- */
function _renderSettingsInput(pluginId, key, cfg) {
  const label = cfg.label || key;
  const type = cfg.type || 'string';
  const stored = (() => {
    try {
      const raw = localStorage.getItem(`plugin:${pluginId}:settings:${key}`);
      return raw === null ? (cfg.default ?? '') : JSON.parse(raw);
    } catch (_) { return cfg.default ?? ''; }
  })();
  const baseStyle = 'padding:4px 8px;border-radius:4px;border:1px solid var(--border);background:var(--input-bg,var(--panel));color:var(--fg);font-size:12px;';
  let inputHtml = '';
  if (type === 'boolean') {
    const checked = stored ? 'checked' : '';
    inputHtml = `<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;"><input type="checkbox" data-setting-key="${key}" ${checked} style="cursor:pointer;"><span>${label}</span></label>`;
  } else if (type === 'select') {
    const opts = (cfg.options || []).map(o => `<option value="${o}" ${stored === o ? 'selected' : ''}>${o}</option>`).join('');
    inputHtml = `<label style="font-size:11px;opacity:0.7;">${label}</label><select data-setting-key="${key}" style="${baseStyle}">${opts}</select>`;
  } else if (type === 'textarea') {
    inputHtml = `<label style="font-size:11px;opacity:0.7;">${label}</label><textarea data-setting-key="${key}" rows="3" style="${baseStyle}resize:vertical;">${_escHtml(String(stored))}</textarea>`;
  } else if (type === 'number') {
    inputHtml = `<label style="font-size:11px;opacity:0.7;">${label}</label><input type="number" data-setting-key="${key}" value="${_escHtml(String(stored))}" style="${baseStyle}">`;
  } else {
    const inputType = cfg.secret ? 'password' : 'text';
    inputHtml = `<label style="font-size:11px;opacity:0.7;">${label}</label><input type="${inputType}" data-setting-key="${key}" value="${_escHtml(String(stored))}" style="${baseStyle}">`;
  }
  return `<div style="display:flex;flex-direction:column;gap:2px;">${inputHtml}</div>`;
}

function _renderSettingsForm(pluginId, schema) {
  const form = el('plugin-detail-settings-form');
  if (!form) return;
  const entries = Object.entries(schema || {});
  if (!entries.length) {
    form.innerHTML = '';
    return;
  }
  form.innerHTML = entries.map(([key, cfg]) => _renderSettingsInput(pluginId, key, cfg)).join('');
  // Wire auto-save on change
  form.querySelectorAll('input, select, textarea').forEach(input => {
    input.addEventListener('change', () => {
      const key = input.dataset.settingKey;
      let value;
      if (input.type === 'checkbox') value = input.checked;
      else if (input.type === 'number') value = Number(input.value);
      else value = input.value;
      localStorage.setItem(`plugin:${pluginId}:settings:${key}`, JSON.stringify(value));
    });
  });
}

function _openDetail(id) {
  const all = [..._pluginState.discovered, ..._pluginState.installed];
  const p = all.find(x => x.id === id);
  if (!p) return;
  _pluginState.currentDetail = p;
  el('plugin-detail-empty').style.display = 'none';
  const content = el('plugin-detail-content');
  content.style.display = 'flex';
  el('plugin-detail-title').textContent = p.name;
  el('plugin-detail-version').textContent = p.version ? `v${p.version}` : '';
  const descEl = el('plugin-detail-desc');
  if (descEl) descEl.innerHTML = _mdToHtml(p.description);
  const tagsEl = el('plugin-detail-tags');
  if (tagsEl) {
    const tags = p._tags && p._tags.length ? p._tags : ['Other'];
    tagsEl.innerHTML = tags.map(_tagPill).join('');
  }

  // Settings
  const hasSettings = p.settings && Object.keys(p.settings).length > 0;
  const settingsBtn = el('plugin-settings-btn');
  const settingsWrap = el('plugin-detail-settings-wrap');
  if (settingsBtn) settingsBtn.style.display = hasSettings && _isInstalled(p.id) ? 'block' : 'none';
  if (settingsWrap) settingsWrap.style.display = 'none';
  if (hasSettings && _isInstalled(p.id)) {
    _renderSettingsForm(p.id, p.settings);
  }

  const isInstalled = _isInstalled(p.id);
  el('plugin-install-btn').style.display = isInstalled ? 'none' : 'block';
  el('plugin-uninstall-btn').style.display = isInstalled ? 'block' : 'none';

  const updateEl = el('plugin-detail-update');
  updateEl.style.display = p._updateAvailable ? 'inline' : 'none';

  const hashEl = el('plugin-detail-hash');
  if (hashEl) {
    if (p._hash_ok === false) {
      hashEl.textContent = 'Integrity check failed';
      hashEl.style.color = 'var(--red)';
      hashEl.style.display = 'inline';
    } else if (p._hash_ok === true) {
      hashEl.textContent = 'Integrity verified';
      hashEl.style.color = 'var(--color-save-green,#4caf50)';
      hashEl.style.display = 'inline';
    } else {
      hashEl.style.display = 'none';
    }
  }

  const favBtn = el('plugin-detail-fav-btn');
  if (favBtn) favBtn.innerHTML = _isFav(p.id) ? _ICON_STAR_FILL : _ICON_STAR;
}

function _closeDetail() {
  _pluginState.currentDetail = null;
  el('plugin-detail-empty').style.display = 'block';
  el('plugin-detail-content').style.display = 'none';
}

/* ---------- Actions ---------- */
async function _discover() {
  const raw = el('plugin-repo-url').value.trim();
  if (!raw) return _showToast('Enter a repo URL or filter');
  const isFilter = /^(tag|name|version):\s*/i.test(raw) || (_pluginState._currentTab !== 'discover');
  const looksLikeUrl = /^https?:\/\//.test(raw) || /github\.com|gitlab\.com/.test(raw);
  if (isFilter || (!looksLikeUrl && _pluginState._currentTab !== 'discover')) {
    _applyFilter(raw);
    return;
  }
  // It's a URL — save to recents and discover
  _saveRecentSearch(raw);
  el('plugin-discover-loading').style.display = 'block';
  el('plugin-discover-empty').style.display = 'none';
  el('plugin-discover-grid').innerHTML = '';
  try {
    const r = await fetch('/api/plugins/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: raw }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || 'Discovery failed');
    _pluginState.discovered = data.plugins || [];
    _pluginState.selectedIds.clear();
    _renderDiscover();
    _updateSelectedCount();
    if (!_pluginState.discovered.length) _showToast('No plugins found in that repo');
  } catch (e) {
    _showToast(String(e.message || e));
    el('plugin-discover-empty').style.display = 'block';
  } finally {
    el('plugin-discover-loading').style.display = 'none';
  }
}

async function _install(ids) {
  const url = el('plugin-repo-url').value.trim();
  if (!url || !ids.length) return;
  const installBtn = el('plugin-install-btn');
  const originalText = installBtn ? installBtn.textContent : 'Install';
  const originalClass = installBtn ? installBtn.className : '';
  if (installBtn) {
    installBtn.textContent = 'Installing...';
    installBtn.classList.remove('admin-btn-add');
    installBtn.classList.add('admin-btn-delete');
    installBtn.disabled = true;
  }
  try {
    const r = await fetch('/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, ids }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || 'Install failed');
    if (data.failed && data.failed.length) {
      _showToast('Some plugins failed: ' + data.failed.join(', '));
    } else {
      _showToast('Plugins installed');
    }
    _pluginState.selectedIds.clear();
    _updateSelectedCount();
    _showReloadPrompt('Plugins installed. Reload page to activate?', (yes) => { if (yes) window.location.reload(); });
    _refreshInstalled().then(() => {
      _renderInstalled();
      _renderDiscover();
      if (_pluginState.currentDetail) _openDetail(_pluginState.currentDetail.id);
    });
  } catch (e) {
    _showToast(String(e.message || e));
  } finally {
    if (installBtn) {
      installBtn.textContent = originalText;
      installBtn.className = originalClass;
      installBtn.disabled = false;
    }
  }
}

function _removePluginScripts(pluginId) {
  // Remove sandboxed iframe for this plugin (and any legacy script tags)
  document.querySelectorAll(`iframe[data-plugin-id="${pluginId}"]`).forEach(f => f.remove());
  document.querySelectorAll(`script[data-plugin-id="${pluginId}"]`).forEach(s => s.remove());
  // Remove plugin panels and styles
  if (typeof _unregisterPluginPanels === 'function') _unregisterPluginPanels(pluginId);
  if (typeof _removePluginStyles === 'function') _removePluginStyles(pluginId);
}

async function _uninstall(id) {
  const uninstallBtn = el('plugin-uninstall-btn');
  const originalText = uninstallBtn ? uninstallBtn.textContent : 'Uninstall';
  const originalClass = uninstallBtn ? uninstallBtn.className : '';
  if (uninstallBtn) {
    uninstallBtn.textContent = 'Uninstalling...';
    uninstallBtn.classList.remove('admin-btn-delete');
    uninstallBtn.classList.add('admin-btn-add');
    uninstallBtn.disabled = true;
  }
  try {
    const r = await fetch(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error('Uninstall failed');
    _showToast('Plugin uninstalled');
    _removePluginScripts(id);
    _showReloadPrompt('Plugin uninstalled. Reload page to fully deactivate?', (yes) => { if (yes) window.location.reload(); });
    _refreshInstalled().then(() => {
      _renderInstalled();
      _renderDiscover();
      _renderFavourites();
      _closeDetail();
    });
  } catch (e) {
    _showToast(String(e.message || e));
  } finally {
    if (uninstallBtn) {
      uninstallBtn.textContent = originalText;
      uninstallBtn.className = originalClass;
      uninstallBtn.disabled = false;
    }
  }
}

async function _refreshInstalled() {
  try {
    const r = await fetch('/api/plugins');
    const data = await r.json();
    _pluginState.installed = data.installed || [];
  } catch (_) {
    _pluginState.installed = [];
  }
}

async function _checkUpdates() {
  try {
    const r = await fetch('/api/plugins/updates', { method: 'POST' });
    const data = await r.json();
    const updates = data.updates || {};
    _pluginState.installed.forEach(p => {
      p._updateAvailable = !!updates[p.id];
    });
    _renderInstalled();
    const count = Object.keys(updates).length;
    if (count > 0) _showToast(`${count} update${count > 1 ? 's' : ''} available`);
    else _showToast('All plugins up to date');
  } catch (e) {
    _showToast('Update check failed');
  }
}

/* ---------- Public API ---------- */
let _pluginsDragWired = false;

export function open() {
  if (!window._isAdmin) return;
  const modal = el('plugins-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const content = modal.querySelector('.modal-content');
  const header = modal.querySelector('.modal-header');
  if (content && header && !_pluginsDragWired) {
    _pluginsDragWired = true;
    makeWindowDraggable(modal, { content, header });
  }
  _refreshInstalled().then(() => {
    _renderInstalled();
    _renderDiscover();
    _renderFavourites();
  });
}

export function close() {
  const modal = el('plugins-modal');
  if (!modal) return;
  const content = modal.querySelector('.modal-content');
  if (content && !content.classList.contains('modal-closing')) {
    content.classList.add('modal-closing');
    content.addEventListener('animationend', () => {
      modal.classList.add('hidden');
      content.classList.remove('modal-closing');
    }, { once: true });
    setTimeout(() => { if (!modal.classList.contains('hidden')) { modal.classList.add('hidden'); content.classList.remove('modal-closing'); } }, 250);
  } else {
    modal.classList.add('hidden');
  }
  _closeDetail();
}

/* ---------- Icon button accent helper ---------- */
function _accentOnClick(btn) {
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.style.color = 'var(--accent,var(--red))';
    btn.style.borderColor = 'var(--accent,var(--red))';
    setTimeout(() => {
      btn.style.color = '';
      btn.style.borderColor = '';
    }, 300);
  });
}

/* ---------- Wiring ---------- */
function _wirePluginsUi() {
  const discoverBtn = el('plugin-discover-btn');
  if (discoverBtn) {
    discoverBtn.addEventListener('click', _discover);
    _accentOnClick(discoverBtn);
  }

  const closeBtn = el('close-plugins-modal');
  if (closeBtn) closeBtn.addEventListener('click', close);

  const installBtn = el('plugin-install-btn');
  if (installBtn) {
    installBtn.addEventListener('click', () => {
      if (_pluginState.selectedIds.size > 0) {
        _install(Array.from(_pluginState.selectedIds));
      } else if (_pluginState.currentDetail) {
        _install([_pluginState.currentDetail.id]);
      }
    });
  }

  const uninstallBtn = el('plugin-uninstall-btn');
  if (uninstallBtn) {
    uninstallBtn.addEventListener('click', () => {
      if (_pluginState.currentDetail) {
        _uninstall(_pluginState.currentDetail.id);
      }
    });
  }

  const favBtn = el('plugin-detail-fav-btn');
  if (favBtn) {
    favBtn.addEventListener('click', () => {
      if (!_pluginState.currentDetail) return;
      _toggleFav(_pluginState.currentDetail.id);
      favBtn.innerHTML = _isFav(_pluginState.currentDetail.id) ? _ICON_STAR_FILL : _ICON_STAR;
      if (_pluginState._currentTab === 'favourites') _renderFavourites();
    });
  }

  document.querySelectorAll('[data-plugin-tab]').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.pluginTab));
  });

  const railBtn = el('rail-plugins');
  if (railBtn) railBtn.addEventListener('click', open);
  const sideBtn = el('tool-plugins-btn');
  if (sideBtn) sideBtn.addEventListener('click', open);

  /* Sort dropdown */
  const sortBtn = el('plugin-sort-btn');
  if (sortBtn) {
    _accentOnClick(sortBtn);
    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      let menu = document.getElementById('plugin-sort-menu');
      if (menu) { menu.remove(); return; }
      menu = document.createElement('div');
      menu.id = 'plugin-sort-menu';
      menu.style.cssText = 'position:fixed;z-index:99999;background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:4px;min-width:120px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
      const rect = sortBtn.getBoundingClientRect();
      menu.style.left = rect.left + 'px';
      menu.style.top = (rect.bottom + 4) + 'px';
      const items = [
        { label: 'Name', value: 'name' },
        { label: 'Date installed', value: 'date' },
      ];
      menu.innerHTML = items.map(item =>
        `<div class="plugin-sort-item" data-sort="${item.value}" style="padding:6px 10px;cursor:pointer;border-radius:4px;font-size:12px;${item.value === _pluginState._sortMode ? 'background:var(--accent,var(--red));color:#fff;' : ''}">${item.label}</div>`
      ).join('');
      document.body.appendChild(menu);
      menu.querySelectorAll('.plugin-sort-item').forEach(item => {
        item.addEventListener('click', () => {
          _pluginState._sortMode = item.dataset.sort;
          menu.remove();
          if (_pluginState._currentTab === 'installed') _renderInstalled();
          else if (_pluginState._currentTab === 'favourites') _renderFavourites();
        });
      });
      const closeMenu = () => { if (document.getElementById('plugin-sort-menu')) document.getElementById('plugin-sort-menu').remove(); };
      setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 10);
    });
  }

  const refreshBtn = el('plugin-refresh-btn');
  if (refreshBtn) {
    _accentOnClick(refreshBtn);
    refreshBtn.addEventListener('click', _checkUpdates);
  }

  const settingsBtn = el('plugin-settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      const wrap = el('plugin-detail-settings-wrap');
      if (wrap) wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
    });
  }

  /* Search dropdown */
  const searchInput = el('plugin-repo-url');
  if (searchInput) {
    searchInput.addEventListener('focus', () => {
      _renderSearchDropdown();
    });
    searchInput.addEventListener('blur', () => {
      setTimeout(_hideSearchDropdown, 150);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        _hideSearchDropdown();
        _discover();
      }
    });
    searchInput.addEventListener('input', () => {
      const val = searchInput.value.trim();
      if (!val) {
        _renderDiscover();
        _renderInstalled();
        _renderFavourites();
        return;
      }
      const looksLikeUrl = /^https?:\/\//.test(val) || /github\.com|gitlab\.com/.test(val);
      if (looksLikeUrl && _pluginState._currentTab === 'discover') return; // wait for Enter on URL
      _applyFilter(val);
    });
    const dropdown = el('plugin-search-dropdown');
    if (dropdown) {
      dropdown.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.plugin-search-item');
        if (item) {
          const query = item.dataset.query;
          if (query) {
            searchInput.value = query;
            _hideSearchDropdown();
            _discover();
          }
          return;
        }
        const syntax = e.target.closest('.plugin-filter-syntax');
        if (syntax) {
          const prefix = syntax.dataset.prefix;
          if (prefix) {
            searchInput.value = prefix;
            searchInput.focus();
            _hideSearchDropdown();
          }
        }
      });
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _wirePluginsUi, { once: true });
} else {
  _wirePluginsUi();
}
