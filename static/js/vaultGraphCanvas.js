/**
 * Vault Graph Canvas — force-graph wrapper for interactive backlink graph.
 * Replaces vis-network with GPU-accelerated WebGL rendering.
 */

import { createMainGraph, createLocalGraph, setSettingsPanelHover, clearGraphHover } from './pixiGraphRenderer.js';

const API_BASE = window.location.origin;

function _esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let _mainGraphInstance = null;
let _localGraphInstance = null;
let _container = null;
let _localContainer = null;
let _allNodes = [];
let _allEdges = [];
let _allTags = [];
let _graphSettings = null;
let _localSettings = null;
let _localActiveNoteId = null;
let _localAllNodes = [];
let _localAllEdges = [];
let _vaultId = null;

// Position cache: preserved across graph closes so reopening is instant.
let _cachedPositions = new Map();
let _cachedGraphDataHash = '';

// Default graph settings
const DEFAULT_SETTINGS = {
  showOrphans: true,
  searchQuery: '',
  arrows: false,
  nodeSize: 2.8,
  linkThickness: 5.0,
  centreForce: 0.5,
  repelForce: 15,       // UI 0-20, internal mapped to -(val*500)
  linkForce: 0.90,     // UI 0-1, direct d3 strength
  linkDistance: 300,
  curvedLines: false,
  curveAngle: 0.7,
  dynamicLinkDistance: true,
  groups: [],
  hubGravityMode: false,
};

const DEFAULT_LOCAL_SETTINGS = {
  depth: 1,
  incomingLinks: true,
  outgoingLinks: true,
  neighborLinks: false,
  arrows: false,
  nodeSize: 2.8,
  linkThickness: 5.0,
  centreForce: 0.5,
  repelForce: 15,
  linkForce: 0.90,
  linkDistance: 300,
  hubGravityMode: false,
};

function _loadSettings() {
  try {
    const raw = localStorage.getItem('vault-graph-settings');
    if (raw) {
      const saved = JSON.parse(raw);
      // Migrate old negative repel values to new 0-20 scale
      if (typeof saved.repelForce === 'number' && saved.repelForce < 0) {
        saved.repelForce = Math.min(20, Math.max(0, Math.round(Math.abs(saved.repelForce) / 500)));
      }
      // Migrate old link force > 1 to capped 1
      if (typeof saved.linkForce === 'number' && saved.linkForce > 1) {
        saved.linkForce = Math.min(1, Math.max(0, saved.linkForce));
      }
      // Migrate: ensure new booleans exist
      if (typeof saved.hubGravityMode !== 'boolean') saved.hubGravityMode = false;
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function _saveSettings() {
  try {
    localStorage.setItem('vault-graph-settings', JSON.stringify(_graphSettings));
  } catch {}
}

function _loadLocalSettings() {
  try {
    const raw = localStorage.getItem('vault-local-graph-settings');
    if (raw) return { ...DEFAULT_LOCAL_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_LOCAL_SETTINGS };
}

function _saveLocalSettings() {
  try {
    localStorage.setItem('vault-local-graph-settings', JSON.stringify(_localSettings));
  } catch {}
}

function _getFilteredNodes() {
  const s = _graphSettings;
  return _allNodes.filter(n => {
    if (s.showOrphans === false) {
      const nid = String(n.id ?? '');
      const hasEdge = _allEdges.some(e => String(e.from ?? '') === nid || String(e.to ?? '') === nid);
      return hasEdge;
    }
    return true;
  });
}

function _getVisibleNodeIds() {
  const s = _graphSettings;
  return new Set(_allNodes.filter(n => {
    if (s.showOrphans === false) {
      const hasEdge = _allEdges.some(e => e.from === n.id || e.to === n.id);
      if (!hasEdge) return false;
    }
    if (s.searchQuery) {
      const label = String(n.label || n.id || '').toLowerCase();
      if (!label.includes(s.searchQuery.toLowerCase())) return false;
    }
    return true;
  }).map(n => n.id));
}

function _sanitizeGraphData(nodes, edges) {
  const safeNodes = (nodes || [])
    .filter(n => n.id != null && String(n.id).length > 0)
    .map(n => ({ ...n, id: String(n.id) }));
  const nodeIdSet = new Set(safeNodes.map(n => n.id));
  const safeEdges = (edges || []).filter(e => {
    const from = e.from != null ? String(e.from) : '';
    const to = e.to != null ? String(e.to) : '';
    return nodeIdSet.has(from) && nodeIdSet.has(to);
  });
  return { nodes: safeNodes, edges: safeEdges };
}

function _dataHash(nodes, edges) {
  return `${nodes.length}|${edges.length}|${nodes.slice(0, 3).map(n => n.id).join(',')}`;
}

export async function renderVaultGraph(container, vaultId) {
  if (!container) return;
  _container = container;
  _vaultId = vaultId || null;
  _graphSettings = _loadSettings();

  // If we already have a live graph instance, just make sure its canvas is
  // in the container. Re-creating the engine every time the tab is shown
  // causes the blank + zoom-to-fit flash the user sees on reopen.
  const alreadyRendered = _mainGraphInstance && !_mainGraphInstance.graph?.destroyed;
  if (alreadyRendered) {
    const engine = _mainGraphInstance.graph;
    if (engine?.app?.view && !container.contains(engine.app.view)) {
      container.appendChild(engine.app.view);
    }
  } else if (_allNodes.length === 0) {
    container.innerHTML = '<div class="vault-graph-loading">Loading graph...</div>';
  }

  try {
    const qs = new URLSearchParams();
    if (vaultId) qs.set('vault_id', vaultId);
    const r = await fetch(`${API_BASE}/api/vault/graph?${qs.toString()}`);
    if (!r.ok) {
      if (!alreadyRendered && _allNodes.length === 0) {
        container.innerHTML = '<div class="vault-graph-error">Failed to load graph</div>';
      }
      return;
    }
    const data = await r.json();
    console.log('[vaultGraph] graph loaded', {
      nodes: data.nodes?.length,
      edges: data.edges?.length,
    });

    const prevHash = _dataHash(_allNodes, _allEdges);
    _allNodes = data.nodes || [];
    _allEdges = data.edges || [];
    _allTags = data.tags || [];
    const newHash = _dataHash(_allNodes, _allEdges);
    const changed = prevHash !== newHash;

    if (!alreadyRendered) {
      _draw();
    } else if (changed) {
      _redraw();
    }
  } catch (e) {
    console.error('[vaultGraph] Error loading graph', e);
    if (!alreadyRendered && _allNodes.length === 0) {
      container.innerHTML = `<div class="vault-graph-error">${e.message}</div>`;
    }
  }
}

function _getGraphTarget() {
  return _container;
}

function _draw() {
  const target = _getGraphTarget();
  if (!target) return;
  target.innerHTML = '';

  // Pass the FULL node set; orphan/name filtering is applied as a visibility
  // mask by the engine so it animates and never resets the physics layout.
  const { nodes: safeNodes, edges: safeEdges } = _sanitizeGraphData(_allNodes, _allEdges);
  const data = { nodes: safeNodes, edges: safeEdges };

  // If data hasn't changed since last session, inject cached positions so the
  // worker can skip warmup and the graph appears instantly at its old layout.
  const dataHash = _dataHash(safeNodes, safeEdges);
  if (dataHash === _cachedGraphDataHash && _cachedPositions.size > 0) {
    for (const node of data.nodes) {
      const pos = _cachedPositions.get(String(node.id));
      if (pos) { node.x = pos.x; node.y = pos.y; }
    }
  }

  _mainGraphInstance = createMainGraph(target, data, _graphSettings);
  _buildToolbar();
  _buildSettingsPanel();
  // Apply any persisted filter on first render
  if (_graphSettings.showOrphans === false || (_graphSettings.searchQuery || '').trim()) {
    _applyFilter();
  }
}

// Re-send full data to the engine (used on a genuine data reload), then
// re-apply the current group colours and visibility filter.
function _redraw() {
  if (!_mainGraphInstance) return;
  // Sync latest settings into the engine before re-coloring the data.
  // The engine stores its own settings copy, so it won't see _graphSettings changes otherwise.
  _mainGraphInstance.updateSettings(_graphSettings);
  const { nodes: safeNodes, edges: safeEdges } = _sanitizeGraphData(_allNodes, _allEdges);
  _mainGraphInstance.updateData({ nodes: safeNodes, edges: safeEdges });
  _applyGroups();
  _applyFilter();
}

// Toggle node visibility (orphans + name search) without disturbing physics.
function _applyFilter() {
  _mainGraphInstance?.setVisibilityFilter({
    showOrphans: _graphSettings.showOrphans,
    searchQuery: _graphSettings.searchQuery,
  });
}

// Recolour nodes by group membership only.
function _applyGroups() {
  _mainGraphInstance?.setGroups(_graphSettings.groups || []);
}

// ── Animation Playback ───────────────────────────────────

let _isAnimationMode = false;
let _lastAnimTime = 0; // remembered position when user stops

function _enterAnimationMode(instance = _mainGraphInstance) {
  if (!instance) return;
  _isAnimationMode = true;
  instance.onAnimationTick = (time, count) => {
    _lastAnimTime = time;
    _updateAnimationBar(time, count);
  };
  instance.onAnimationEnd = () => {
    _updatePlayButton(false);
  };
  instance.startAnimation();
}

function _exitAnimationMode(instance = _mainGraphInstance) {
  _isAnimationMode = false;
  instance?.stopAnimation();
}

function _fmtAnimDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function _activeAnimPanel() {
  // Find which settings panel contains the currently-running animation controls
  if (_mainGraphInstance?.isAnimating) {
    return document.getElementById('vault-graph-settings-panel');
  }
  if (_localGraphInstance?.isAnimating) {
    return document.getElementById('vault-local-graph-settings-panel');
  }
  return null;
}

function _updateScrubberFill(scrubber) {
  if (!scrubber) return;
  const pct = scrubber.value + '%';
  scrubber.style.setProperty('--progress', pct);
}

function _wireAnimationControls(panel, instance) {
  const animSection = panel.querySelector('[data-section="animation"]');
  if (!animSection) return;

  const stopBtn = animSection.querySelector('button[title="Stop"]');
  const playBtn = animSection.querySelector('button[title="Play / Pause"]');
  const speedSel = animSection.querySelector('select[title="Speed"]');
  const scrubber = animSection.querySelector('input[title="Timeline"]');
  const tooltip = panel.querySelector('.vault-graph-slider-tooltip');

  function _showScrubberTooltip(input, noteCount) {
    if (!tooltip) return;
    const rect = input.getBoundingClientRect();
    tooltip.textContent = `${noteCount} notes`;
    tooltip.classList.add('visible');
    const thumbW = 14;
    const ratio = (input.value - input.min) / (input.max - input.min);
    const left = rect.left + ratio * (rect.width - thumbW) + thumbW / 2 - tooltip.offsetWidth / 2;
    const top = rect.top - tooltip.offsetHeight - 6;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }
  function _hideScrubberTooltip() { tooltip?.classList.remove('visible'); }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      if (!instance) return;
      _exitAnimationMode(instance);
      _updatePlayButton(false, panel);
      if (scrubber) {
        scrubber.value = 0;
        _updateScrubberFill(scrubber);
      }
      _lastAnimTime = 0;
    });
  }
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (!instance) return;
      if (instance.isAnimating && instance.animationTime < instance.maxCreated) {
        if (playBtn.dataset.playing === 'true') {
          instance.pauseAnimation();
          playBtn.dataset.playing = 'false';
          playBtn.textContent = '▶';
        } else {
          instance.resumeAnimation();
          playBtn.dataset.playing = 'true';
          playBtn.textContent = '⏸';
        }
      } else {
        const resumeTime = _lastAnimTime || instance.animationTime;
        _enterAnimationMode(instance);
        if (resumeTime > instance.minCreated && resumeTime < instance.maxCreated) {
          instance.seekAnimation(resumeTime);
        }
        _updatePlayButton(true, panel);
      }
    });
  }
  if (speedSel) {
    speedSel.addEventListener('change', (e) => {
      instance?.setAnimationSpeed(parseFloat(e.target.value));
    });
  }
  if (scrubber) {
    scrubber.addEventListener('input', (e) => {
      if (!instance) return;
      const min = instance.minCreated;
      const max = instance.maxCreated;
      if (max <= min) return;
      const pct = parseInt(e.target.value, 10) / 100;
      const targetTime = min + (max - min) * pct;
      if (!instance.isAnimating) _enterAnimationMode(instance);
      instance.pauseAnimation();
      instance.seekAnimation(targetTime);
      _updatePlayButton(false, panel);
      _updateScrubberFill(scrubber);
      const count = instance.graph?._visibleCount?.() ?? 0;
      _showScrubberTooltip(scrubber, count);
    });
    scrubber.addEventListener('change', _hideScrubberTooltip);
    scrubber.addEventListener('mouseleave', _hideScrubberTooltip);
    _updateScrubberFill(scrubber);
  }
}

function _updatePlayButton(playing, panel) {
  const p = panel || _activeAnimPanel();
  if (!p) return;
  const btn = p.querySelector('button[title="Play / Pause"]');
  if (!btn) return;
  btn.dataset.playing = playing ? 'true' : 'false';
  btn.textContent = playing ? '⏸' : '▶';
}

function _updateAnimationBar(time, count) {
  const panel = _activeAnimPanel();
  if (!panel) return;
  const animSection = panel.querySelector('[data-section="animation"]');
  if (!animSection) return;
  const scrubber = animSection.querySelector('.vault-graph-anim-scrubber');
  const g = _mainGraphInstance?.isAnimating ? _mainGraphInstance : (_localGraphInstance?.isAnimating ? _localGraphInstance : null);
  if (scrubber && g) {
    const min = g.minCreated;
    const max = g.maxCreated;
    if (max > min) {
      const pct = ((time - min) / (max - min)) * 100;
      scrubber.value = Math.max(0, Math.min(100, pct));
      _updateScrubberFill(scrubber);
    }
  }
}

export function destroyGraph() {
  _isAnimationMode = false;
  if (_mainGraphInstance) {
    // Snapshot positions before destroying so the next open can skip warmup.
    const engine = _mainGraphInstance.graph;
    if (engine?.posMap) {
      _cachedPositions.clear();
      for (const [id, pos] of engine.posMap) {
        _cachedPositions.set(id, { x: pos.x, y: pos.y });
      }
      _cachedGraphDataHash = _dataHash(_allNodes, _allEdges);
    }
    _mainGraphInstance.destroy();
    _mainGraphInstance = null;
  }
  _allNodes = [];
  _allEdges = [];
}

// ── Toolbar ────────────────────────────────────────────────

function _buildToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'vault-graph-toolbar';

  const fitBtn = document.createElement('button');
  fitBtn.className = 'vault-graph-toolbtn';
  fitBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  fitBtn.title = 'Fit to view';
  fitBtn.addEventListener('click', () => _mainGraphInstance?.zoomToFit());
  toolbar.appendChild(fitBtn);

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'vault-graph-toolbtn';
  settingsBtn.id = 'vault-graph-settings-btn';
  settingsBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  settingsBtn.title = 'Graph settings';
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('vault-graph-settings-panel');
    if (panel) panel.classList.toggle('hidden');
  });
  toolbar.appendChild(settingsBtn);

  const target = _getGraphTarget();
  if (target) target.appendChild(toolbar);
}

// ── Settings Panel ─────────────────────────────────────────

function _hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `#${f(0).toString(16).padStart(2,'0')}${f(8).toString(16).padStart(2,'0')}${f(4).toString(16).padStart(2,'0')}`;
}

function _nextGroupHue(groups) {
  if (!groups || !groups.length) return 210;
  const last = groups[groups.length - 1];
  const hue = parseInt(last.color?.slice(1), 16) ? 210 : 210;
  // Simple hue rotation: 210 -> 30 -> 120 -> 300 -> 180 -> 60 -> 270 -> 150 -> 330 -> 90 -> 240 -> 0
  const presets = [210, 30, 120, 300, 180, 60, 270, 150, 330, 90, 240, 0];
  const idx = groups.length % presets.length;
  return presets[idx];
}

function _buildGroupRow(g, idx) {
  return `<div class="vault-graph-group-row" data-group-idx="${idx}">
    <span class="vault-graph-group-color" style="background:${g.color}" title="Click to change color"></span>
    <span class="vault-graph-group-query" contenteditable="plaintext-only" spellcheck="false">${g.query || ''}</span>
    <button class="vault-graph-group-del" title="Remove">&#x2715;</button>
  </div>`;
}

function _buildSettingsPanel() {
  const existing = document.getElementById('vault-graph-settings-panel');
  if (existing) existing.remove();

  const s = _graphSettings;

  const panel = document.createElement('div');
  panel.id = 'vault-graph-settings-panel';
  panel.className = 'vault-graph-settings-panel hidden';
  panel.innerHTML = `
    <div class="vault-graph-settings-header">
      <span>Graph Settings</span>
      <button class="vault-graph-settings-close" title="Close">&#x2715;</button>
    </div>
    <div class="vault-graph-settings-body">
      <div class="vault-graph-settings-search">
        <input type="text" id="sg-filter-search" placeholder="Filter by name..." />
      </div>

      <div class="vault-graph-settings-section" data-section="groups">
        <div class="vault-graph-section-title"><span class="vault-graph-section-chevron expanded">></span>Groups</div>
        <div class="vault-graph-section-content">
          <div class="vault-graph-groups-list">
            ${(s.groups || []).map((g, i) => _buildGroupRow(g, i)).join('')}
          </div>
          <button class="vault-graph-new-group-btn" id="sg-new-group">New group</button>
        </div>
      </div>

      <div class="vault-graph-settings-section" data-section="display">
        <div class="vault-graph-section-title"><span class="vault-graph-section-chevron expanded">></span>Display</div>
        <div class="vault-graph-section-content">
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Show orphans</span>
            <label class="admin-switch"><input type="checkbox" id="sg-filter-orphans" ${s.showOrphans ? 'checked' : ''}><span class="admin-slider"></span></label>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Arrows</span>
            <label class="admin-switch"><input type="checkbox" id="sg-display-arrows" ${s.arrows ? 'checked' : ''}><span class="admin-slider"></span></label>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Node size</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-display-nodeSize" min="0.3" max="6" step="0.1" value="${s.nodeSize}">
            </div>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Link thickness</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-display-linkThickness" min="1" max="10" step="0.5" value="${s.linkThickness}">
            </div>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Curved lines</span>
            <label class="admin-switch"><input type="checkbox" id="sg-display-curved" ${s.curvedLines ? 'checked' : ''}><span class="admin-slider"></span></label>
          </div>
        </div>
      </div>

      <div class="vault-graph-settings-section" data-section="forces">
        <div class="vault-graph-section-title"><span class="vault-graph-section-chevron expanded">></span>Forces</div>
        <div class="vault-graph-section-content">
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Hub gravity mode</span>
            <label class="admin-switch"><input type="checkbox" id="sg-hub-gravity" ${s.hubGravityMode ? 'checked' : ''}><span class="admin-slider"></span></label>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Centre force</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-force-centre" min="0.5" max="10" step="0.1" value="${s.centreForce}" title="${s.centreForce}">
            </div>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Repel force</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-force-repel" min="0" max="20" step="1" value="${s.repelForce}">
            </div>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Link force</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-force-link" min="0" max="1" step="0.01" value="${s.linkForce}">
            </div>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Link distance</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-force-distance" min="50" max="500" step="10" value="${s.linkDistance}">
            </div>
          </div>
        </div>
      </div>

      <div class="vault-graph-settings-section" data-section="animation">
        <div class="vault-graph-section-title"><span class="vault-graph-section-chevron expanded">></span>Animation</div>
        <div class="vault-graph-section-content">
          <div class="vault-graph-anim-top">
            <input type="range" class="vault-graph-anim-scrubber" id="sg-anim-scrubber" min="0" max="100" value="0" title="Timeline">
          </div>
          <div class="vault-graph-anim-controls">
            <button class="vault-graph-anim-btn" id="sg-anim-play" title="Play / Pause">▶</button>
            <button class="vault-graph-anim-btn" id="sg-anim-stop" title="Stop">⏹</button>
            <select class="vault-graph-anim-speed" id="sg-anim-speed" title="Speed">
              <option value="0.25">0.25×</option>
              <option value="0.5">0.5×</option>
              <option value="1" selected>1×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2.0×</option>
            </select>
          </div>
        </div>
      </div>
    </div>
    <div class="vault-graph-settings-resize"></div>
    <div class="vault-graph-slider-tooltip" id="sg-slider-tooltip"></div>
  `;

  const target = _getGraphTarget();
  if (target) target.appendChild(panel);

  // ── Draggable header ──
  const header = panel.querySelector('.vault-graph-settings-header');
  let dragStartX = 0, dragStartY = 0, dragStartLeft = 0, dragStartTop = 0, isDragging = false;
  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartLeft = panel.offsetLeft;
    dragStartTop = panel.offsetTop;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    header.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panel.style.left = (dragStartLeft + e.clientX - dragStartX) + 'px';
    panel.style.top = (dragStartTop + e.clientY - dragStartY) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (isDragging) { isDragging = false; header.style.cursor = 'grab'; }
  });

  // ── Resizable corner ──
  const resizeHandle = panel.querySelector('.vault-graph-settings-resize');
  let isResizing = false, startW = 0, startH = 0, startX = 0, startY = 0;
  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startW = panel.offsetWidth;
    startH = panel.offsetHeight;
    startX = e.clientX;
    startY = e.clientY;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    panel.style.width = Math.max(200, startW + e.clientX - startX) + 'px';
    panel.style.height = Math.max(150, startH + e.clientY - startY) + 'px';
  });
  document.addEventListener('mouseup', () => { isResizing = false; });

  // ── Hover guard ──
  panel.addEventListener('mouseenter', () => { setSettingsPanelHover(true); clearGraphHover(); });
  panel.addEventListener('mouseleave', () => setSettingsPanelHover(false));

  panel.querySelector('.vault-graph-settings-close').addEventListener('click', () => {
    panel.classList.add('hidden');
    setSettingsPanelHover(false);
  });

  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  if (!window._vaultGraphSettingsClickAway) {
    window._vaultGraphSettingsClickAway = (e) => {
      const p = document.getElementById('vault-graph-settings-panel');
      if (!p || p.classList.contains('hidden')) return;
      if (!p.contains(e.target) && !e.target.closest('#vault-graph-settings-btn')) {
        p.classList.add('hidden');
        setSettingsPanelHover(false);
      }
    };
    document.addEventListener('click', window._vaultGraphSettingsClickAway);
  }

  // ── Collapsible sections ──
  panel.querySelectorAll('.vault-graph-settings-section').forEach(section => {
    const title = section.querySelector('.vault-graph-section-title');
    const chevron = title?.querySelector('.vault-graph-section-chevron');
    const content = section.querySelector('.vault-graph-section-content');
    if (!title || !content) return;
    title.style.cursor = 'pointer';
    title.addEventListener('click', () => {
      const isCollapsed = content.style.display === 'none';
      content.style.display = isCollapsed ? '' : 'none';
      if (chevron) {
        if (isCollapsed) chevron.classList.add('expanded');
        else chevron.classList.remove('expanded');
      }
    });
  });

  // ── Floating slider tooltip ──
  const tooltip = panel.querySelector('#sg-slider-tooltip');
  function _showSliderTooltip(input, val) {
    const rect = input.getBoundingClientRect();
    tooltip.textContent = val;
    tooltip.classList.add('visible');
    const thumbW = 14;
    const ratio = (input.value - input.min) / (input.max - input.min);
    const left = rect.left + ratio * (rect.width - thumbW) + thumbW / 2 - tooltip.offsetWidth / 2;
    const top = rect.top - tooltip.offsetHeight - 6;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }
  function _hideSliderTooltip() { tooltip.classList.remove('visible'); }
  panel.querySelectorAll('input[type="range"]:not(.vault-graph-anim-scrubber)').forEach(input => {
    input.addEventListener('mouseenter', (e) => _showSliderTooltip(e.target, e.target.value));
    input.addEventListener('input', (e) => _showSliderTooltip(e.target, e.target.value));
    input.addEventListener('change', _hideSliderTooltip);
    input.addEventListener('mouseleave', _hideSliderTooltip);
  });

  // ── Groups ──
  const groupsList = panel.querySelector('.vault-graph-groups-list');
  function _refreshGroups() {
    if (!groupsList) return;
    groupsList.innerHTML = (_graphSettings.groups || []).map((g, i) => _buildGroupRow(g, i)).join('');
    _wireGroupRows();
  }
  function _wireGroupRows() {
    panel.querySelectorAll('.vault-graph-group-row').forEach(row => {
      const idx = parseInt(row.dataset.groupIdx, 10);
      const colorBtn = row.querySelector('.vault-graph-group-color');
      const queryEl = row.querySelector('.vault-graph-group-query');
      const delBtn = row.querySelector('.vault-graph-group-del');

      if (colorBtn) {
        colorBtn.addEventListener('click', () => {
          const picker = document.createElement('input');
          picker.type = 'color';
          picker.value = _graphSettings.groups[idx]?.color || '#00aaff';
          picker.style.position = 'fixed';
          picker.style.left = '-9999px';
          document.body.appendChild(picker);
          picker.addEventListener('input', (e) => {
            _graphSettings.groups[idx].color = e.target.value;
            colorBtn.style.background = e.target.value;
            _saveSettings();
            _applyGroups();
          });
          picker.addEventListener('change', () => { picker.remove(); });
          picker.click();
        });
      }

      if (queryEl) {
        let dropdown = null;
        let selectedIndex = -1;
        function _closeGroupDropdown() {
          if (dropdown) { dropdown.remove(); dropdown = null; }
          selectedIndex = -1;
        }
        function _renderGroupDropdown(filter) {
          _closeGroupDropdown();
          const f = filter.toLowerCase();
          const noteMatches = _allNodes.filter(n => (n.label || n.id || '').toLowerCase().includes(f)).slice(0, 8);
          const tagMatches = (_allTags || []).filter(t => t.toLowerCase().includes(f)).slice(0, 6);

          dropdown = document.createElement('div');
          dropdown.className = 'vault-graph-group-dropdown';
          dropdown.style.zIndex = '99999';
          const rect = queryEl.getBoundingClientRect();
          dropdown.style.left = rect.left + 'px';
          dropdown.style.top = (rect.bottom + 4) + 'px';
          dropdown.style.minWidth = rect.width + 'px';

          let html = '';
          // Search-syntax shortcuts (clickable)
          html += `<div class="vault-graph-group-section"><div class="vault-graph-group-title">Search options</div>`;
          html += `<div class="vault-graph-group-item" data-prefix="path:"><code>path:</code> match path of the file</div>`;
          html += `<div class="vault-graph-group-item" data-prefix="file:"><code>file:</code> match file name</div>`;
          html += `<div class="vault-graph-group-item" data-prefix="tag:"><code>tag:</code> search for tags</div>`;
          html += `<div class="vault-graph-group-item" data-prefix="line:"><code>line:</code> search keywords on same line</div>`;
          html += `<div class="vault-graph-group-item" data-prefix="section:"><code>section:</code> search keywords under same heading</div>`;
          html += `<div class="vault-graph-group-item" data-prefix="["><code>[property]</code> match property</div>`;
          html += `</div>`;
          dropdown.innerHTML = html;
          document.body.appendChild(dropdown);

          dropdown.querySelectorAll('.vault-graph-group-item').forEach(item => {
            item.addEventListener('click', (e) => {
              e.stopPropagation();
              const prefix = item.dataset.prefix;
              if (prefix) {
                queryEl.textContent = prefix;
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(queryEl);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
              }
              _graphSettings.groups[idx].query = queryEl.textContent.trim();
              _saveSettings();
              _applyGroups();
              _closeGroupDropdown();
              queryEl.focus();
            });
          });
        }
        queryEl.addEventListener('focus', () => { _renderGroupDropdown(queryEl.textContent.trim()); });
        queryEl.addEventListener('input', () => { _renderGroupDropdown(queryEl.textContent.trim()); });
        queryEl.addEventListener('keydown', (e) => {
          const items = dropdown?.querySelectorAll('.vault-graph-group-item');
          if (e.key === 'Enter') {
            e.preventDefault();
            if (items && selectedIndex >= 0 && items[selectedIndex]) {
              items[selectedIndex].click();
            } else {
              queryEl.blur();
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
            _closeGroupDropdown();
          }
        });
        queryEl.addEventListener('blur', () => {
          setTimeout(() => {
            if (dropdown && dropdown.matches(':hover')) return;
            _closeGroupDropdown();
            const val = queryEl.textContent.trim();
            _graphSettings.groups[idx].query = val;
            _saveSettings();
            _applyGroups();
          }, 150);
        });
      }

      if (delBtn) {
        delBtn.addEventListener('click', () => {
          _graphSettings.groups.splice(idx, 1);
          _saveSettings();
          _refreshGroups();
          _applyGroups();
        });
      }
    });
  }
  _wireGroupRows();

  panel.querySelector('#sg-new-group')?.addEventListener('click', () => {
    _graphSettings.groups = _graphSettings.groups || [];
    const hue = _nextGroupHue(_graphSettings.groups);
    _graphSettings.groups.push({ query: '', color: _hslToHex(hue, 70, 60) });
    _saveSettings();
    _refreshGroups();
    _applyGroups();
  });

  panel.querySelector('#sg-filter-search').addEventListener('input', (e) => {
    _graphSettings.searchQuery = e.target.value;
    _saveSettings();
    _applyFilter();
  });

  panel.querySelector('#sg-filter-orphans').addEventListener('change', (e) => {
    _graphSettings.showOrphans = e.target.checked;
    _saveSettings();
    _applyFilter();
  });


  panel.querySelector('#sg-display-arrows').addEventListener('change', (e) => {
    _graphSettings.arrows = e.target.checked;
    _saveSettings();
    _mainGraphInstance?.updateArrows(e.target.checked);
  });

  panel.querySelector('#sg-display-nodeSize').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    _graphSettings.nodeSize = val;
    _saveSettings();
    _mainGraphInstance?.updateNodeSize(val);
  });

  panel.querySelector('#sg-display-linkThickness').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    _graphSettings.linkThickness = val;
    _saveSettings();
    _mainGraphInstance?.updateLinkThickness(val);
  });

  const forceUpdate = () => _mainGraphInstance?.updateSettings({
    centreForce: Math.max(0.5, _graphSettings.centreForce || 0.5),
    repelForce: _graphSettings.repelForce,
    linkForce: _graphSettings.linkForce,
    linkDistance: _graphSettings.linkDistance,
    hubGravityMode: _graphSettings.hubGravityMode,
  });

  panel.querySelector('#sg-display-curved').addEventListener('change', (e) => {
    _graphSettings.curvedLines = e.target.checked;
    _saveSettings();
    _mainGraphInstance?.updateCurvedLines(e.target.checked);
  });

  panel.querySelector('#sg-force-centre').addEventListener('input', (e) => {
    _graphSettings.centreForce = Math.max(0.5, parseFloat(e.target.value) || 0.5);
    _saveSettings();
  });
  panel.querySelector('#sg-force-repel').addEventListener('input', (e) => {
    _graphSettings.repelForce = parseInt(e.target.value, 10);
    _saveSettings();
  });
  panel.querySelector('#sg-force-link').addEventListener('input', (e) => {
    _graphSettings.linkForce = parseFloat(e.target.value);
    _saveSettings();
  });
  panel.querySelector('#sg-force-distance').addEventListener('input', (e) => {
    _graphSettings.linkDistance = parseInt(e.target.value, 10);
    _saveSettings();
  });

  panel.querySelector('#sg-force-centre').addEventListener('change', forceUpdate);
  panel.querySelector('#sg-force-repel').addEventListener('change', forceUpdate);
  panel.querySelector('#sg-force-link').addEventListener('change', forceUpdate);
  panel.querySelector('#sg-force-distance').addEventListener('change', forceUpdate);

  panel.querySelector('#sg-hub-gravity').addEventListener('change', (e) => {
    _graphSettings.hubGravityMode = e.target.checked;
    _saveSettings();
    _mainGraphInstance?.updateSettings(_graphSettings);
  });

  // ── In-panel Animation controls ──
  _wireAnimationControls(panel, _mainGraphInstance);
}

// ── Local Graph ────────────────────────────────────────────

export async function renderLocalGraph(container, vaultId, noteId) {
  if (!container || !noteId) return;
  _localContainer = container;
  _localActiveNoteId = noteId;
  _localSettings = _loadLocalSettings();

  container.innerHTML = '<div class="vault-graph-loading">Loading local graph...</div>';

  try {
    const qs = new URLSearchParams();
    if (vaultId) qs.set('vault_id', vaultId);
    const r = await fetch(`${API_BASE}/api/vault/graph?${qs.toString()}`);
    if (!r.ok) { container.innerHTML = '<div class="vault-graph-error">Failed to load graph</div>'; return; }
    const data = await r.json();
    _localAllNodes = data.nodes || [];
    _localAllEdges = data.edges || [];
    _drawLocal();
  } catch (e) {
    container.innerHTML = `<div class="vault-graph-error">${e.message}</div>`;
  }
}

function _getLocalFilteredNodes() {
  const s = _localSettings;
  const depth = s.depth;
  const centerId = _localActiveNoteId;
  if (!centerId) return [];

  const adj = new Map();
  for (const e of _localAllEdges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    if (!adj.has(e.to)) adj.set(e.to, new Set());
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
  }

  const visited = new Set([centerId]);
  let frontier = new Set([centerId]);
  for (let d = 0; d < depth; d++) {
    const next = new Set();
    for (const n of frontier) {
      const neighbors = adj.get(n);
      if (!neighbors) continue;
      for (const nb of neighbors) {
        if (!visited.has(nb)) {
          visited.add(nb);
          next.add(nb);
        }
      }
    }
    frontier = next;
  }

  let result = _localAllNodes.filter(n => {
    if (!visited.has(n.id)) return false;
    return true;
  });

  const hasCenter = result.some(n => n.id === centerId);
  if (!hasCenter) {
    const centerNode = _localAllNodes.find(n => n.id === centerId);
    if (centerNode) {
      result.unshift(centerNode);
    } else {
      result.unshift({
        id: centerId,
        label: centerId.split('/').pop()?.replace(/\.md$/, '') || centerId,
        value: 1,
        color: {
          background: '#4dabf7',
          border: '#339af0',
        },
      });
    }
  }
  return result;
}

function _getLocalVisibleEdges(visibleIds) {
  const s = _localSettings;
  const visibleSet = new Set(visibleIds);
  const centerId = _localActiveNoteId;

  return _localAllEdges.filter(e => {
    if (!visibleSet.has(e.from) || !visibleSet.has(e.to)) return false;

    const isFromCenter = e.from === centerId;
    const isToCenter = e.to === centerId;
    const isNeighbor = !isFromCenter && !isToCenter;

    if (isFromCenter && !s.outgoingLinks) return false;
    if (isToCenter && !s.incomingLinks) return false;
    if (isNeighbor && !s.neighborLinks) return false;

    return true;
  });
}

function _drawLocal() {
  if (!_localContainer) return;
  _localContainer.innerHTML = '';

  const filteredNodes = _getLocalFilteredNodes();
  const visibleIds = new Set(filteredNodes.map(n => n.id));
  const visibleEdges = _getLocalVisibleEdges(visibleIds);

  if (filteredNodes.length === 0) {
    _localContainer.innerHTML = '<div class="vault-graph-loading">Select a note to see its local graph.</div>';
    return;
  }

  const data = {
    nodes: filteredNodes,
    edges: visibleEdges,
  };

  _localGraphInstance = createLocalGraph(_localContainer, data, _localActiveNoteId, _localSettings);
  _buildLocalToolbar();
  _buildLocalSettingsPanel();
}

function _redrawLocal() {
  if (!_localGraphInstance) return;
  const filteredNodes = _getLocalFilteredNodes();
  const visibleIds = new Set(filteredNodes.map(n => n.id));
  const visibleEdges = _getLocalVisibleEdges(visibleIds);
  
  _localGraphInstance.updateData({
    nodes: filteredNodes,
    edges: visibleEdges,
  });
}

export function destroyLocalGraph() {
  _isAnimationMode = false;
  if (_localGraphInstance) {
    _localGraphInstance.destroy();
    _localGraphInstance = null;
  }
  _localAllNodes = [];
  _localAllEdges = [];
  _localActiveNoteId = null;
}

// ── Local Toolbar ─────────────────────────────────────────

function _buildLocalToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'vault-graph-toolbar';

  const fitBtn = document.createElement('button');
  fitBtn.className = 'vault-graph-toolbtn';
  fitBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  fitBtn.title = 'Fit to view';
  fitBtn.addEventListener('click', () => _localGraphInstance?.zoomToFit());
  toolbar.appendChild(fitBtn);

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'vault-graph-toolbtn';
  settingsBtn.id = 'vault-local-graph-settings-btn';
  settingsBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  settingsBtn.title = 'Local graph settings';
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('vault-local-graph-settings-panel');
    if (panel) panel.classList.toggle('hidden');
  });
  toolbar.appendChild(settingsBtn);

  _localContainer.appendChild(toolbar);
}

// ── Local Settings Panel ───────────────────────────────────

function _buildLocalSettingsPanel() {
  const existing = document.getElementById('vault-local-graph-settings-panel');
  if (existing) existing.remove();

  const s = _localSettings;

  const panel = document.createElement('div');
  panel.id = 'vault-local-graph-settings-panel';
  panel.className = 'vault-graph-settings-panel hidden';
  panel.innerHTML = `
    <div class="vault-graph-settings-header">
      <span>Local Graph Settings</span>
      <button class="vault-graph-settings-close" title="Close">&#x2715;</button>
    </div>
    <div class="vault-graph-settings-body">
      <div class="vault-graph-settings-section">
        <div class="vault-graph-section-title"><span class="vault-graph-section-chevron expanded">></span>Depth</div>
        <div class="vault-graph-section-content">
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Depth</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-local-depth" min="1" max="5" step="1" value="${s.depth}">
            </div>
          </div>
        </div>
      </div>

      <div class="vault-graph-settings-section">
        <div class="vault-graph-section-title"><span class="vault-graph-section-chevron expanded">></span>Filters</div>
        <div class="vault-graph-section-content">
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Incoming links</span>
            <label class="admin-switch"><input type="checkbox" id="sg-local-incoming" ${s.incomingLinks ? 'checked' : ''}><span class="admin-slider"></span></label>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Outgoing links</span>
            <label class="admin-switch"><input type="checkbox" id="sg-local-outgoing" ${s.outgoingLinks ? 'checked' : ''}><span class="admin-slider"></span></label>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Neighbor links</span>
            <label class="admin-switch"><input type="checkbox" id="sg-local-neighbor" ${s.neighborLinks ? 'checked' : ''}><span class="admin-slider"></span></label>
          </div>
        </div>
      </div>

      <div class="vault-graph-settings-section">
        <div class="vault-graph-section-title"><span class="vault-graph-section-chevron expanded">></span>Display</div>
        <div class="vault-graph-section-content">
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Arrows</span>
            <label class="admin-switch"><input type="checkbox" id="sg-local-arrows" ${s.arrows ? 'checked' : ''}><span class="admin-slider"></span></label>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Node size</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-local-nodeSize" min="0.3" max="6" step="0.1" value="${s.nodeSize}">
            </div>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Link thickness</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-local-linkThickness" min="1" max="10" step="0.5" value="${s.linkThickness}">
            </div>
          </div>
        </div>
      </div>

      <div class="vault-graph-settings-section">
        <div class="vault-graph-section-title"><span class="vault-graph-section-chevron expanded">></span>Forces</div>
        <div class="vault-graph-section-content">
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Hub gravity mode</span>
            <label class="admin-switch"><input type="checkbox" id="sg-local-hub-gravity" ${s.hubGravityMode ? 'checked' : ''}><span class="admin-slider"></span></label>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Centre force</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-local-centre" min="0.5" max="10" step="0.1" value="${s.centreForce}" title="${s.centreForce}">
            </div>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Repel force</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-local-repel" min="0" max="20" step="1" value="${s.repelForce}">
            </div>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Link force</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-local-link" min="0" max="1" step="0.01" value="${s.linkForce}">
            </div>
          </div>
          <div class="vault-graph-row">
            <span class="vault-graph-row-label">Link distance</span>
            <div class="vault-graph-slider-wrap">
              <input type="range" id="sg-local-distance" min="50" max="500" step="10" value="${s.linkDistance}">
            </div>
          </div>
        </div>
      </div>

      <div class="vault-graph-settings-section" data-section="animation">
        <div class="vault-graph-section-title"><span class="vault-graph-section-chevron expanded">></span>Animation</div>
        <div class="vault-graph-section-content">
          <div class="vault-graph-anim-top">
            <input type="range" class="vault-graph-anim-scrubber" id="sg-local-anim-scrubber" min="0" max="100" value="0" title="Timeline">
          </div>
          <div class="vault-graph-anim-controls">
            <button class="vault-graph-anim-btn" id="sg-local-anim-play" title="Play / Pause">▶</button>
            <button class="vault-graph-anim-btn" id="sg-local-anim-stop" title="Stop">⏹</button>
            <select class="vault-graph-anim-speed" id="sg-local-anim-speed" title="Speed">
              <option value="0.25">0.25×</option>
              <option value="0.5">0.5×</option>
              <option value="1" selected>1×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2.0×</option>
            </select>
          </div>
        </div>
      </div>
    </div>
    <div class="vault-graph-settings-resize"></div>
    <div class="vault-graph-slider-tooltip" id="sg-local-slider-tooltip"></div>
  `;

  _localContainer.appendChild(panel);

  // Draggable header
  const header = panel.querySelector('.vault-graph-settings-header');
  let dragStartX = 0, dragStartY = 0, dragStartLeft = 0, dragStartTop = 0, isDragging = false;
  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartLeft = panel.offsetLeft;
    dragStartTop = panel.offsetTop;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    header.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panel.style.left = (dragStartLeft + e.clientX - dragStartX) + 'px';
    panel.style.top = (dragStartTop + e.clientY - dragStartY) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (isDragging) { isDragging = false; header.style.cursor = 'grab'; }
  });

  // Hover guard
  panel.addEventListener('mouseenter', () => { setSettingsPanelHover(true); clearGraphHover(); });
  panel.addEventListener('mouseleave', () => setSettingsPanelHover(false));

  // Resizable corner
  const resizeHandle = panel.querySelector('.vault-graph-settings-resize');
  let isResizing = false, startW = 0, startH = 0, startX = 0, startY = 0;
  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startW = panel.offsetWidth;
    startH = panel.offsetHeight;
    startX = e.clientX;
    startY = e.clientY;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    panel.style.width = Math.max(200, startW + e.clientX - startX) + 'px';
    panel.style.height = Math.max(150, startH + e.clientY - startY) + 'px';
  });
  document.addEventListener('mouseup', () => { isResizing = false; });

  panel.querySelector('.vault-graph-settings-close').addEventListener('click', () => {
    panel.classList.add('hidden');
  });

  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  if (!window._vaultLocalGraphSettingsClickAway) {
    window._vaultLocalGraphSettingsClickAway = (e) => {
      const p = document.getElementById('vault-local-graph-settings-panel');
      if (!p || p.classList.contains('hidden')) return;
      if (!p.contains(e.target) && !e.target.closest('#vault-local-graph-settings-btn')) {
        p.classList.add('hidden');
      }
    };
    document.addEventListener('click', window._vaultLocalGraphSettingsClickAway);
  }

  // Floating slider tooltip
  const tooltip = panel.querySelector('#sg-local-slider-tooltip');
  function _showSliderTooltip(input, val) {
    const rect = input.getBoundingClientRect();
    tooltip.textContent = val;
    tooltip.classList.add('visible');
    const thumbW = 14;
    const ratio = (input.value - input.min) / (input.max - input.min);
    const left = rect.left + ratio * (rect.width - thumbW) + thumbW / 2 - tooltip.offsetWidth / 2;
    const top = rect.top - tooltip.offsetHeight - 6;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }
  function _hideSliderTooltip() { tooltip.classList.remove('visible'); }
  panel.querySelectorAll('input[type="range"]:not(.vault-graph-anim-scrubber)').forEach(input => {
    input.addEventListener('mouseenter', (e) => _showSliderTooltip(e.target, e.target.value));
    input.addEventListener('input', (e) => _showSliderTooltip(e.target, e.target.value));
    input.addEventListener('change', _hideSliderTooltip);
    input.addEventListener('mouseleave', _hideSliderTooltip);
  });

  panel.querySelector('#sg-local-depth').addEventListener('input', (e) => {
    _localSettings.depth = parseInt(e.target.value, 10);
    _saveLocalSettings();
    _redrawLocal();
  });

  panel.querySelector('#sg-local-incoming').addEventListener('change', (e) => {
    _localSettings.incomingLinks = e.target.checked;
    _saveLocalSettings();
    _redrawLocal();
  });
  panel.querySelector('#sg-local-outgoing').addEventListener('change', (e) => {
    _localSettings.outgoingLinks = e.target.checked;
    _saveLocalSettings();
    _redrawLocal();
  });
  panel.querySelector('#sg-local-neighbor').addEventListener('change', (e) => {
    _localSettings.neighborLinks = e.target.checked;
    _saveLocalSettings();
    _redrawLocal();
  });

  panel.querySelector('#sg-local-arrows').addEventListener('change', (e) => {
    _localSettings.arrows = e.target.checked;
    _saveLocalSettings();
    _localGraphInstance?.updateArrows(e.target.checked);
  });

  panel.querySelector('#sg-local-nodeSize').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    _localSettings.nodeSize = val;
    _saveLocalSettings();
    _localGraphInstance?.updateNodeSize(val);
  });

  panel.querySelector('#sg-local-linkThickness').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    _localSettings.linkThickness = val;
    _saveLocalSettings();
    _localGraphInstance?.updateLinkThickness(val);
  });

  const forceUpdate = () => _localGraphInstance?.updateSettings({
    centreForce: Math.max(0.5, _localSettings.centreForce || 0.5),
    repelForce: _localSettings.repelForce,
    linkForce: _localSettings.linkForce,
    linkDistance: _localSettings.linkDistance,
    hubGravityMode: _localSettings.hubGravityMode,
  });
  panel.querySelector('#sg-local-centre').addEventListener('input', (e) => {
    _localSettings.centreForce = Math.max(0.5, parseFloat(e.target.value) || 0.5);
    _saveLocalSettings();
  });
  panel.querySelector('#sg-local-repel').addEventListener('input', (e) => {
    _localSettings.repelForce = parseInt(e.target.value, 10);
    _saveLocalSettings();
  });
  panel.querySelector('#sg-local-link').addEventListener('input', (e) => {
    _localSettings.linkForce = parseFloat(e.target.value);
    _saveLocalSettings();
  });
  panel.querySelector('#sg-local-distance').addEventListener('input', (e) => {
    _localSettings.linkDistance = parseInt(e.target.value, 10);
    _saveLocalSettings();
  });

  panel.querySelector('#sg-local-centre').addEventListener('change', forceUpdate);
  panel.querySelector('#sg-local-repel').addEventListener('change', forceUpdate);
  panel.querySelector('#sg-local-link').addEventListener('change', forceUpdate);
  panel.querySelector('#sg-local-distance').addEventListener('change', forceUpdate);

  panel.querySelector('#sg-local-hub-gravity').addEventListener('change', (e) => {
    _localSettings.hubGravityMode = e.target.checked;
    _saveLocalSettings();
    _localGraphInstance?.updateSettings(_localSettings);
  });

  // ── In-panel Animation controls ──
  _wireAnimationControls(panel, _localGraphInstance);
}

