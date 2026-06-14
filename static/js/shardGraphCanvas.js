/**
 * Shard Graph Canvas — force-graph wrapper for interactive backlink graph.
 * Replaces vis-network with GPU-accelerated WebGL rendering.
 */

import { createMainGraph, createLocalGraph } from './forceGraphRenderer.js';

const API_BASE = window.location.origin;

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

// Default graph settings
const DEFAULT_SETTINGS = {
  showOrphans: true,
  searchQuery: '',
  arrows: false,
  nodeSize: 1.0,
  linkThickness: 1.0,
  centreForce: 0.3,
  repelForce: -4000,
  linkForce: 0.04,
  linkDistance: 120,
};

const DEFAULT_LOCAL_SETTINGS = {
  depth: 1,
  incomingLinks: true,
  outgoingLinks: true,
  neighborLinks: false,
  arrows: false,
  nodeSize: 1.0,
  linkThickness: 1.0,
  centreForce: 0.3,
  repelForce: -4000,
  linkForce: 0.04,
  linkDistance: 120,
};

function _loadSettings() {
  try {
    const raw = localStorage.getItem('shard-graph-settings');
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function _saveSettings() {
  try {
    localStorage.setItem('shard-graph-settings', JSON.stringify(_graphSettings));
  } catch {}
}

function _loadLocalSettings() {
  try {
    const raw = localStorage.getItem('shard-local-graph-settings');
    if (raw) return { ...DEFAULT_LOCAL_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_LOCAL_SETTINGS };
}

function _saveLocalSettings() {
  try {
    localStorage.setItem('shard-local-graph-settings', JSON.stringify(_localSettings));
  } catch {}
}

function _getFilteredNodes() {
  const s = _graphSettings;
  return _allNodes.filter(n => {
    if (s.showOrphans === false) {
      const hasEdge = _allEdges.some(e => e.from === n.id || e.to === n.id);
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
      const label = (n.label || n.id || '').toLowerCase();
      if (!label.includes(s.searchQuery.toLowerCase())) return false;
    }
    return true;
  }).map(n => n.id));
}

export async function renderShardGraph(container, vaultId) {
  if (!container) return;
  _container = container;
  _graphSettings = _loadSettings();

  container.innerHTML = '<div class="shard-graph-loading">Loading graph...</div>';

  try {
    const qs = new URLSearchParams();
    if (vaultId) qs.set('vault_id', vaultId);
    const r = await fetch(`${API_BASE}/api/shard/graph?${qs.toString()}`);
    if (!r.ok) { container.innerHTML = '<div class="shard-graph-error">Failed to load graph</div>'; return; }
    const data = await r.json();
    _allNodes = data.nodes || [];
    _allEdges = data.edges || [];
    _allTags = data.tags || [];
    _draw();
  } catch (e) {
    container.innerHTML = `<div class="shard-graph-error">${e.message}</div>`;
  }
}

function _draw() {
  if (!_container) return;
  _container.innerHTML = '';

  const filteredNodes = _getFilteredNodes();
  const visibleIds = _getVisibleNodeIds();
  const visibleEdges = _allEdges.filter(e => visibleIds.has(e.from) && visibleIds.has(e.to));

  const data = {
    nodes: filteredNodes,
    edges: visibleEdges,
  };

  _mainGraphInstance = createMainGraph(_container, data, _graphSettings);
  _buildToolbar();
  _buildSettingsPanel();
}

function _redraw() {
  if (!_mainGraphInstance) return;
  const visibleIds = _getVisibleNodeIds();
  const visibleEdges = _allEdges.filter(e => visibleIds.has(e.from) && visibleIds.has(e.to));
  const filteredNodes = _allNodes.filter(n => visibleIds.has(n.id));
  
  _mainGraphInstance.updateData({
    nodes: filteredNodes,
    edges: visibleEdges,
  });
}

export function destroyGraph() {
  if (_mainGraphInstance) {
    _mainGraphInstance.destroy();
    _mainGraphInstance = null;
  }
  _allNodes = [];
  _allEdges = [];
}

// ── Toolbar ────────────────────────────────────────────────

function _buildToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'shard-graph-toolbar';

  const fitBtn = document.createElement('button');
  fitBtn.className = 'shard-graph-toolbtn';
  fitBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  fitBtn.title = 'Fit to view';
  fitBtn.addEventListener('click', () => _mainGraphInstance?.zoomToFit());
  toolbar.appendChild(fitBtn);

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'shard-graph-toolbtn';
  settingsBtn.id = 'shard-graph-settings-btn';
  settingsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  settingsBtn.title = 'Graph settings';
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('shard-graph-settings-panel');
    if (panel) panel.classList.toggle('hidden');
  });
  toolbar.appendChild(settingsBtn);

  _container.appendChild(toolbar);
}

// ── Settings Panel ─────────────────────────────────────────

function _buildSettingsPanel() {
  const existing = document.getElementById('shard-graph-settings-panel');
  if (existing) existing.remove();

  const s = _graphSettings;

  const panel = document.createElement('div');
  panel.id = 'shard-graph-settings-panel';
  panel.className = 'shard-graph-settings-panel hidden';
  panel.innerHTML = `
    <div class="shard-graph-settings-header">
      <span>Graph Settings</span>
      <button class="shard-graph-settings-close" title="Close">&#x2715;</button>
    </div>
    <div class="shard-graph-settings-body">
      <div class="shard-graph-settings-search">
        <input type="text" id="sg-filter-search" placeholder="Filter by name..." />
      </div>

      <div class="shard-graph-settings-section">
        <div class="shard-graph-section-title">Filters</div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Show orphans</span>
          <label class="admin-switch"><input type="checkbox" id="sg-filter-orphans" ${s.showOrphans ? 'checked' : ''}><span class="admin-slider"></span></label>
        </div>
      </div>

      <div class="shard-graph-settings-section">
        <div class="shard-graph-section-title">Display</div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Arrows</span>
          <label class="admin-switch"><input type="checkbox" id="sg-display-arrows" ${s.arrows ? 'checked' : ''}><span class="admin-slider"></span></label>
        </div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Node size</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-display-nodeSize" min="0.3" max="3" step="0.1" value="${s.nodeSize}">
            <span class="shard-graph-slider-val" id="sg-display-nodeSize-val">${s.nodeSize}</span>
          </div>
        </div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Link thickness</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-display-linkThickness" min="0.3" max="5" step="0.1" value="${s.linkThickness}">
            <span class="shard-graph-slider-val" id="sg-display-linkThickness-val">${s.linkThickness}</span>
          </div>
        </div>
      </div>

      <div class="shard-graph-settings-section">
        <div class="shard-graph-section-title">Forces</div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Centre force</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-force-centre" min="0" max="1" step="0.05" value="${s.centreForce}">
            <span class="shard-graph-slider-val" id="sg-force-centre-val">${s.centreForce}</span>
          </div>
        </div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Repel force</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-force-repel" min="-10000" max="-500" step="500" value="${s.repelForce}">
            <span class="shard-graph-slider-val" id="sg-force-repel-val">${s.repelForce}</span>
          </div>
        </div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Link force</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-force-link" min="0.001" max="0.1" step="0.001" value="${s.linkForce}">
            <span class="shard-graph-slider-val" id="sg-force-link-val">${s.linkForce}</span>
          </div>
        </div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Link distance</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-force-distance" min="50" max="500" step="10" value="${s.linkDistance}">
            <span class="shard-graph-slider-val" id="sg-force-distance-val">${s.linkDistance}</span>
          </div>
        </div>
        <button class="shard-graph-animate-btn" id="sg-force-animate">Animate</button>
      </div>
    </div>
  `;

  _container.appendChild(panel);

  panel.querySelector('.shard-graph-settings-close').addEventListener('click', () => {
    panel.classList.add('hidden');
  });

  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  if (!window._shardGraphSettingsClickAway) {
    window._shardGraphSettingsClickAway = (e) => {
      const p = document.getElementById('shard-graph-settings-panel');
      if (!p || p.classList.contains('hidden')) return;
      if (!p.contains(e.target) && !e.target.closest('#shard-graph-settings-btn')) {
        p.classList.add('hidden');
      }
    };
    document.addEventListener('click', window._shardGraphSettingsClickAway);
  }

  panel.querySelector('#sg-filter-search').addEventListener('input', (e) => {
    _graphSettings.searchQuery = e.target.value;
    _saveSettings();
    _redraw();
  });

  panel.querySelector('#sg-filter-orphans').addEventListener('change', (e) => {
    _graphSettings.showOrphans = e.target.checked;
    _saveSettings();
    _redraw();
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
    panel.querySelector('#sg-display-nodeSize-val').textContent = val;
  });

  panel.querySelector('#sg-display-linkThickness').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    _graphSettings.linkThickness = val;
    _saveSettings();
    _mainGraphInstance?.updateLinkThickness(val);
    panel.querySelector('#sg-display-linkThickness-val').textContent = val;
  });

  const updateVal = (id, key, parser) => (e) => {
    const val = parser(e.target.value);
    _graphSettings[key] = val;
    _saveSettings();
    panel.querySelector('#' + id + '-val').textContent = val;
  };
  panel.querySelector('#sg-force-centre').addEventListener('input', updateVal('sg-force-centre', 'centreForce', parseFloat));
  panel.querySelector('#sg-force-repel').addEventListener('input', updateVal('sg-force-repel', 'repelForce', parseInt));
  panel.querySelector('#sg-force-link').addEventListener('input', updateVal('sg-force-link', 'linkForce', parseFloat));
  panel.querySelector('#sg-force-distance').addEventListener('input', updateVal('sg-force-distance', 'linkDistance', parseInt));

  panel.querySelector('#sg-force-centre').addEventListener('change', () => _mainGraphInstance?.updateSettings(_graphSettings));
  panel.querySelector('#sg-force-repel').addEventListener('change', () => _mainGraphInstance?.updateSettings(_graphSettings));
  panel.querySelector('#sg-force-link').addEventListener('change', () => _mainGraphInstance?.updateSettings(_graphSettings));
  panel.querySelector('#sg-force-distance').addEventListener('change', () => _mainGraphInstance?.updateSettings(_graphSettings));

  panel.querySelector('#sg-force-animate').addEventListener('click', () => {
    _mainGraphInstance?.updateSettings(_graphSettings);
  });
}

// ── Local Graph ────────────────────────────────────────────

export async function renderLocalGraph(container, vaultId, noteId) {
  if (!container || !noteId) return;
  _localContainer = container;
  _localActiveNoteId = noteId;
  _localSettings = _loadLocalSettings();

  container.innerHTML = '<div class="shard-graph-loading">Loading local graph...</div>';

  try {
    const qs = new URLSearchParams();
    if (vaultId) qs.set('vault_id', vaultId);
    const r = await fetch(`${API_BASE}/api/shard/graph?${qs.toString()}`);
    if (!r.ok) { container.innerHTML = '<div class="shard-graph-error">Failed to load graph</div>'; return; }
    const data = await r.json();
    _localAllNodes = data.nodes || [];
    _localAllEdges = data.edges || [];
    _drawLocal();
  } catch (e) {
    container.innerHTML = `<div class="shard-graph-error">${e.message}</div>`;
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
    _localContainer.innerHTML = '<div class="shard-graph-loading">Select a note to see its local graph.</div>';
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
  toolbar.className = 'shard-graph-toolbar';

  const fitBtn = document.createElement('button');
  fitBtn.className = 'shard-graph-toolbtn';
  fitBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  fitBtn.title = 'Fit to view';
  fitBtn.addEventListener('click', () => _localGraphInstance?.zoomToFit());
  toolbar.appendChild(fitBtn);

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'shard-graph-toolbtn';
  settingsBtn.id = 'shard-local-graph-settings-btn';
  settingsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  settingsBtn.title = 'Local graph settings';
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('shard-local-graph-settings-panel');
    if (panel) panel.classList.toggle('hidden');
  });
  toolbar.appendChild(settingsBtn);

  _localContainer.appendChild(toolbar);
}

// ── Local Settings Panel ───────────────────────────────────

function _buildLocalSettingsPanel() {
  const existing = document.getElementById('shard-local-graph-settings-panel');
  if (existing) existing.remove();

  const s = _localSettings;

  const panel = document.createElement('div');
  panel.id = 'shard-local-graph-settings-panel';
  panel.className = 'shard-graph-settings-panel hidden';
  panel.innerHTML = `
    <div class="shard-graph-settings-header">
      <span>Local Graph Settings</span>
      <button class="shard-graph-settings-close" title="Close">&#x2715;</button>
    </div>
    <div class="shard-graph-settings-body">
      <div class="shard-graph-settings-section">
        <div class="shard-graph-section-title">Depth</div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Depth</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-local-depth" min="1" max="5" step="1" value="${s.depth}">
            <span class="shard-graph-slider-val" id="sg-local-depth-val">${s.depth}</span>
          </div>
        </div>
      </div>

      <div class="shard-graph-settings-section">
        <div class="shard-graph-section-title">Filters</div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Incoming links</span>
          <label class="admin-switch"><input type="checkbox" id="sg-local-incoming" ${s.incomingLinks ? 'checked' : ''}><span class="admin-slider"></span></label>
        </div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Outgoing links</span>
          <label class="admin-switch"><input type="checkbox" id="sg-local-outgoing" ${s.outgoingLinks ? 'checked' : ''}><span class="admin-slider"></span></label>
        </div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Neighbor links</span>
          <label class="admin-switch"><input type="checkbox" id="sg-local-neighbor" ${s.neighborLinks ? 'checked' : ''}><span class="admin-slider"></span></label>
        </div>
      </div>

      <div class="shard-graph-settings-section">
        <div class="shard-graph-section-title">Display</div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Arrows</span>
          <label class="admin-switch"><input type="checkbox" id="sg-local-arrows" ${s.arrows ? 'checked' : ''}><span class="admin-slider"></span></label>
        </div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Node size</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-local-nodeSize" min="0.3" max="3" step="0.1" value="${s.nodeSize}">
            <span class="shard-graph-slider-val" id="sg-local-nodeSize-val">${s.nodeSize}</span>
          </div>
        </div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Link thickness</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-local-linkThickness" min="0.3" max="5" step="0.1" value="${s.linkThickness}">
            <span class="shard-graph-slider-val" id="sg-local-linkThickness-val">${s.linkThickness}</span>
          </div>
        </div>
      </div>

      <div class="shard-graph-settings-section">
        <div class="shard-graph-section-title">Forces</div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Centre force</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-local-centre" min="0" max="1" step="0.05" value="${s.centreForce}">
            <span class="shard-graph-slider-val" id="sg-local-centre-val">${s.centreForce}</span>
          </div>
        </div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Repel force</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-local-repel" min="-10000" max="-500" step="500" value="${s.repelForce}">
            <span class="shard-graph-slider-val" id="sg-local-repel-val">${s.repelForce}</span>
          </div>
        </div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Link force</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-local-link" min="0.001" max="0.1" step="0.001" value="${s.linkForce}">
            <span class="shard-graph-slider-val" id="sg-local-link-val">${s.linkForce}</span>
          </div>
        </div>
        <div class="shard-graph-row">
          <span class="shard-graph-row-label">Link distance</span>
          <div class="shard-graph-slider-wrap">
            <input type="range" id="sg-local-distance" min="50" max="500" step="10" value="${s.linkDistance}">
            <span class="shard-graph-slider-val" id="sg-local-distance-val">${s.linkDistance}</span>
          </div>
        </div>
        <button class="shard-graph-animate-btn" id="sg-local-animate">Animate</button>
      </div>
    </div>
  `;

  _localContainer.appendChild(panel);

  panel.querySelector('.shard-graph-settings-close').addEventListener('click', () => {
    panel.classList.add('hidden');
  });

  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  if (!window._shardLocalGraphSettingsClickAway) {
    window._shardLocalGraphSettingsClickAway = (e) => {
      const p = document.getElementById('shard-local-graph-settings-panel');
      if (!p || p.classList.contains('hidden')) return;
      if (!p.contains(e.target) && !e.target.closest('#shard-local-graph-settings-btn')) {
        p.classList.add('hidden');
      }
    };
    document.addEventListener('click', window._shardLocalGraphSettingsClickAway);
  }

  panel.querySelector('#sg-local-depth').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    _localSettings.depth = val;
    _saveLocalSettings();
    panel.querySelector('#sg-local-depth-val').textContent = val;
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
    panel.querySelector('#sg-local-nodeSize-val').textContent = val;
  });

  panel.querySelector('#sg-local-linkThickness').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    _localSettings.linkThickness = val;
    _saveLocalSettings();
    _localGraphInstance?.updateLinkThickness(val);
    panel.querySelector('#sg-local-linkThickness-val').textContent = val;
  });

  const updateVal = (id, key, parser) => (e) => {
    const val = parser(e.target.value);
    _localSettings[key] = val;
    _saveLocalSettings();
    panel.querySelector('#' + id + '-val').textContent = val;
  };
  panel.querySelector('#sg-local-centre').addEventListener('input', updateVal('sg-local-centre', 'centreForce', parseFloat));
  panel.querySelector('#sg-local-repel').addEventListener('input', updateVal('sg-local-repel', 'repelForce', parseInt));
  panel.querySelector('#sg-local-link').addEventListener('input', updateVal('sg-local-link', 'linkForce', parseFloat));
  panel.querySelector('#sg-local-distance').addEventListener('input', updateVal('sg-local-distance', 'linkDistance', parseInt));

  panel.querySelector('#sg-local-centre').addEventListener('change', () => _localGraphInstance?.updateSettings(_localSettings));
  panel.querySelector('#sg-local-repel').addEventListener('change', () => _localGraphInstance?.updateSettings(_localSettings));
  panel.querySelector('#sg-local-link').addEventListener('change', () => _localGraphInstance?.updateSettings(_localSettings));
  panel.querySelector('#sg-local-distance').addEventListener('change', () => _localGraphInstance?.updateSettings(_localSettings));

  panel.querySelector('#sg-local-animate').addEventListener('click', () => {
    _localGraphInstance?.updateSettings(_localSettings);
  });
}
