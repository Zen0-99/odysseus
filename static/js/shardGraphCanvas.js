/**
 * Shard Graph Canvas — vis-network wrapper for interactive backlink graph.
 */

const API_BASE = window.location.origin;

let _network = null;
let _container = null;
let _visNodes = null;
let _visEdges = null;
let _allNodes = [];
let _allEdges = [];
let _allTags = [];
let _graphSettings = null;
let _graphTooltip = null;
let _graphIsDragging = false;
let _graphAdjMap = null;      // Map<nodeId, Set<neighborId>>
let _graphVisibleIds = null;  // Set of currently visible node IDs
let _graphLastHoverId = null; // Last hovered node id for dedup
let _graphHoverDebounceTimer = null;
let _graphBlurDebounceTimer = null;

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

/** Stop physics entirely so the graph comes to a complete halt. */
function _stopPhysics(network) {
  if (!network) return;
  network.setOptions({ physics: { enabled: false } });
}

/** Fix all nodes in place so they cannot drift. */
function _freezeGraph(network, nodesDataset, allNodes) {
  _stopPhysics(network);
  if (nodesDataset && allNodes && allNodes.length) {
    nodesDataset.update(allNodes.map(n => ({ id: n.id, fixed: true })));
  }
}

/** Unfix all nodes so physics can move them. */
function _unfreezeGraph(nodesDataset, allNodes) {
  if (nodesDataset && allNodes && allNodes.length) {
    nodesDataset.update(allNodes.map(n => ({ id: n.id, fixed: false })));
  }
}

/** Log a perf milestone: [graph] label: durationMs (since optional startTime) */
function _perfLog(label, startTime) {
  const now = performance.now();
  const elapsed = startTime ? (now - startTime).toFixed(1) : null;
  console.log(`[graph-perf] ${label}${elapsed !== null ? ' (' + elapsed + 'ms)' : ''}`);
  return now;
}

/** Temporarily re-enable physics with current force values, let it settle, then freeze. */
function _applyForces(network, settings, nodesDataset, allNodes) {
  if (!network) return;
  _unfreezeGraph(nodesDataset, allNodes);
  network.setOptions({
    physics: {
      enabled: true,
      stabilization: {
        enabled: true,
        iterations: 200,
        updateInterval: 25,
        onlyDynamicEdges: false,
        fit: false,
      },
      barnesHut: {
        gravitationalConstant: settings.repelForce,
        centralGravity: settings.centreForce,
        springLength: settings.linkDistance,
        springConstant: settings.linkForce,
        damping: 0.85,
        avoidOverlap: 0.1,
      },
      maxVelocity: 15,
      minVelocity: 0.1,
      timestep: 0.35,
      adaptiveTimestep: true,
    },
  });
  network.once('stabilizationIterationsDone', () => {
    network.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' } });
    _freezeGraph(network, nodesDataset, allNodes);
  });
}

export async function renderShardGraph(container, vaultId) {
  if (!window.vis || !container) return;
  const t0 = _perfLog('renderShardGraph start');
  _container = container;
  _graphSettings = _loadSettings();

  container.innerHTML = '<div class="shard-graph-loading">Loading graph...</div>';

  try {
    const qs = new URLSearchParams();
    if (vaultId) qs.set('vault_id', vaultId);
    const tFetch = performance.now();
    const r = await fetch(`${API_BASE}/api/shard/graph?${qs.toString()}`);
    _perfLog('fetch graph data', tFetch);
    if (!r.ok) { container.innerHTML = '<div class="shard-graph-error">Failed to load graph</div>'; return; }
    const data = await r.json();
    _allNodes = data.nodes || [];
    _allEdges = data.edges || [];
    _allTags = data.tags || [];
    _perfLog(`nodes=${_allNodes.length} edges=${_allEdges.length}`);
    _draw();
    _perfLog('renderShardGraph total', t0);
  } catch (e) {
    container.innerHTML = `<div class="shard-graph-error">${e.message}</div>`;
  }
}

function _getFilteredNodes() {
  const s = _graphSettings;
  return _allNodes.filter(n => {
    if (s.showOrphans === false) {
      // If user hides orphans, only show notes that have at least one edge
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

function _destroyNetwork() {
  if (_network) { _network.destroy(); _network = null; }
  if (_graphTooltip) { _graphTooltip.remove(); _graphTooltip = null; }
  _visNodes = null;
  _visEdges = null;
}

function _draw() {
  if (!_container || !window.vis) return;
  const t0 = performance.now();
  _destroyNetwork();
  _container.innerHTML = '';

  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue('--bg').trim() || '#282c34';
  const fg = style.getPropertyValue('--fg').trim() || '#abb2bf';
  const border = style.getPropertyValue('--border').trim() || '#3e4451';

  const s = _graphSettings;
  const nodeCount = _allNodes.length;

  // Adaptive physics based on graph size
  const isLarge = nodeCount > 200;
  const stabilizeIter = isLarge ? 100 : 150;

  const filteredNodes = _getFilteredNodes();
  const visibleIds = new Set(filteredNodes.map(n => n.id));
  const visibleEdges = _allEdges.filter(e => visibleIds.has(e.from) && visibleIds.has(e.to));

  const nodeFont = {
    color: fg,
    face: 'Fira Code, monospace',
    size: 12,
    strokeWidth: 0,
    vadjust: -4,
  };

  const edgeColor = {
    color: '#5c6370',
    highlight: fg,
    hover: fg,
    opacity: 0.85,
  };

  const accentColor = '#00aaff';
  const accentEdgeColor = { color: accentColor, highlight: accentColor, hover: accentColor, opacity: 0.9 };
  const dimmedEdgeColor = { color: '#5c6370', highlight: fg, hover: fg, opacity: 0.1 };

  // ALL nodes in DataSet so _redraw() and search can toggle visibility
  const allNodesStyled = _allNodes.map(n => ({
    ...n,
    value: (n.value || 1) * s.nodeSize,
    hidden: !visibleIds.has(n.id),
  }));

  _visNodes = new window.vis.DataSet(allNodesStyled);
  _visEdges = new window.vis.DataSet(visibleEdges);

  // Precompute adjacency map for O(1) neighbor lookup during hover
  _graphAdjMap = new Map();
  for (const n of _allNodes) _graphAdjMap.set(n.id, new Set());
  for (const e of visibleEdges) {
    _graphAdjMap.get(e.from)?.add(e.to);
    _graphAdjMap.get(e.to)?.add(e.from);
  }
  _graphVisibleIds = visibleIds;
  _graphLastHoverId = null;

  const options = {
    nodes: {
      shape: 'dot',
      font: nodeFont,
      borderWidth: 1,
      borderWidthSelected: 2,
      shadow: false,
      scaling: {
        min: 8,
        max: 30,
        label: { enabled: false },
      },
    },
    edges: {
      width: s.linkThickness,
      color: edgeColor,
      smooth: { type: 'continuous' },
      arrows: s.arrows ? { to: { enabled: true, scaleFactor: 0.5 } } : { to: { enabled: false } },
    },
    physics: {
      enabled: true,
      stabilization: {
        enabled: true,
        iterations: stabilizeIter,
        updateInterval: 25,
        onlyDynamicEdges: false,
        fit: false,
      },
      barnesHut: {
        gravitationalConstant: s.repelForce,
        centralGravity: s.centreForce,
        springLength: s.linkDistance,
        springConstant: s.linkForce,
        damping: 0.85,
        avoidOverlap: 0.1,
      },
      maxVelocity: 15,
      minVelocity: 0.1,
      timestep: 0.35,
      adaptiveTimestep: true,
    },
    interaction: {
      hover: true,
      tooltipDelay: 200,
      zoomView: true,
      dragView: true,
      hideEdgesOnDrag: true,
      hideEdgesOnZoom: false,
    },
    layout: { improvedLayout: !isLarge },
    autoResize: true,
  };

  _network = new window.vis.Network(_container, { nodes: _visNodes, edges: _visEdges }, options);

  // After initial stabilization, freeze nodes so they stop drifting
  _network.once('stabilizationIterationsDone', () => {
    _freezeGraph(_network, _visNodes, _allNodes);
  });

  // Zoom-based label visibility (labels hidden when zoomed out) — throttled
  let _graphLabelsVisible = true;
  let _graphZoomRaf = null;
  _network.on('zoom', () => {
    if (_graphZoomRaf) return;
    _graphZoomRaf = requestAnimationFrame(() => {
      _graphZoomRaf = null;
      const scale = _network.getScale();
      const show = scale >= 0.4;
      if (show !== _graphLabelsVisible) {
        _graphLabelsVisible = show;
        const font = show ? nodeFont : { ...nodeFont, color: 'transparent' };
        // Only update visible nodes to avoid O(n) cost
        const updates = [];
        for (const n of _allNodes) {
          if (_graphVisibleIds.has(n.id)) updates.push({ id: n.id, font });
        }
        _visNodes.update(updates);
      }
    });
  });

  // Create tooltip element
  if (_graphTooltip) _graphTooltip.remove();
  _graphTooltip = document.createElement('div');
  _graphTooltip.className = 'shard-graph-tooltip';
  _container.appendChild(_graphTooltip);

  // Drag state tracking to suppress hover flicker during node drag
  let _graphDragStartTime = 0;
  _network.on('dragStart', () => {
    _graphIsDragging = true;
    _graphDragStartTime = performance.now();
    _stopPhysics(_network); // instant drag response — no physics recomputation
  });
  _network.on('dragEnd', () => {
    _graphIsDragging = false;
    _graphLastHoverId = null;
    _perfLog('dragEnd (total drag)', _graphDragStartTime);
    // Restore everything after drag
    const t0 = performance.now();
    if (_graphTooltip) _graphTooltip.classList.remove('visible');
    const restoreNodes = [];
    for (const n of _allNodes) {
      if (_graphVisibleIds.has(n.id)) {
        restoreNodes.push({ id: n.id, value: (n.value || 1) * s.nodeSize, opacity: 1 });
      }
    }
    _visNodes.update(restoreNodes);
    const restoreEdges = visibleEdges.map(e => ({ id: e.id, color: edgeColor }));
    _visEdges.update(restoreEdges);
    _perfLog('dragEnd restore', t0);
    // Briefly re-enable physics so dragged node settles, then freeze again
    _applyForces(_network, _graphSettings, _visNodes, _allNodes);
  });

  // Click on node → open note; click on background → reset isolation
  _network.on('click', function (params) {
    const t0 = performance.now();
    if (params.nodes.length === 0) {
      const currentVisibleIds = _getVisibleNodeIds();
      const updates = [];
      for (const n of _allNodes) updates.push({ id: n.id, hidden: !currentVisibleIds.has(n.id) });
      _visNodes.update(updates);
    } else {
      const noteId = params.nodes[0];
      window.dispatchEvent(new CustomEvent('odysseus-shard-select-note', { detail: { id: noteId } }));
    }
    _perfLog('click handler', t0);
  });

  // Double-click on node → isolate neighbors
  _network.on('doubleClick', function (params) {
    const t0 = performance.now();
    if (params.nodes.length === 0) return;
    const selected = params.nodes[0];
    const connected = _graphAdjMap.get(selected) || new Set();
    const currentVisibleIds = _getVisibleNodeIds();
    const updates = [];
    for (const n of _allNodes) {
      if (!currentVisibleIds.has(n.id)) continue;
      updates.push({ id: n.id, hidden: !connected.has(n.id) && n.id !== selected });
    }
    _visNodes.update(updates);
    _perfLog('doubleClick handler', t0);
  });

  // Hover: enlarge node, dim non-neighbors, highlight edges, show tooltip
  _network.on('hoverNode', function (params) {
    if (_graphIsDragging) return;
    const hoveredId = params.node;
    if (hoveredId === _graphLastHoverId) return;
    clearTimeout(_graphBlurDebounceTimer);
    _graphHoverDebounceTimer = setTimeout(() => {
      _graphLastHoverId = hoveredId;
      const t0 = performance.now();

      const connected = _graphAdjMap.get(hoveredId);
      if (!connected) return;

      // Show tooltip with node title
      const node = _allNodes.find(n => n.id === hoveredId);
      if (node && _graphTooltip) {
        _graphTooltip.textContent = node.label || node.id;
        const pos = _network.canvasToDOM({ x: node.x || 0, y: node.y || 0 });
        _graphTooltip.style.left = (pos.x) + 'px';
        _graphTooltip.style.top = (pos.y + 15) + 'px';
        _graphTooltip.classList.add('visible');
      }

      const nodeUpdates = [];
      for (const n of _allNodes) {
        if (!_graphVisibleIds.has(n.id)) continue;
        if (n.id === hoveredId) {
          nodeUpdates.push({ id: n.id, value: (n.value || 1) * s.nodeSize * 1.5, opacity: 1 });
        } else if (connected.has(n.id)) {
          nodeUpdates.push({ id: n.id, opacity: 1 });
        } else {
          nodeUpdates.push({ id: n.id, opacity: 0.15 });
        }
      }
      _visNodes.update(nodeUpdates);

      const edgeUpdates = [];
      for (const e of visibleEdges) {
        edgeUpdates.push({
          id: e.id,
          color: (e.from === hoveredId || e.to === hoveredId) ? accentEdgeColor : dimmedEdgeColor,
        });
      }
      _visEdges.update(edgeUpdates);
      _perfLog('hoverNode handler', t0);
    }, 20);
  });

  // Blur: restore sizes and colors, hide tooltip
  _network.on('blurNode', function (params) {
    if (_graphIsDragging) return;
    clearTimeout(_graphHoverDebounceTimer);
    _graphBlurDebounceTimer = setTimeout(() => {
      const t0 = performance.now();
      _graphLastHoverId = null;
      if (_graphTooltip) _graphTooltip.classList.remove('visible');
      const restoreNodes = [];
      for (const n of _allNodes) {
        if (_graphVisibleIds.has(n.id)) {
          restoreNodes.push({ id: n.id, value: (n.value || 1) * s.nodeSize, opacity: 1 });
        }
      }
      _visNodes.update(restoreNodes);
      const restoreEdges = visibleEdges.map(e => ({ id: e.id, color: edgeColor }));
      _visEdges.update(restoreEdges);
      _perfLog('blurNode handler', t0);
    }, 20);
  });

  // Smooth wheel zoom — intercept before vis-network's native handler
  const _smoothZoomMain = (e) => {
    if (!e.target.closest('canvas')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const currentScale = _network.getScale();
    const direction = e.deltaY > 0 ? 0.88 : 1.12;
    const newScale = Math.max(0.05, Math.min(3, currentScale * direction));
    _network.moveTo({
      scale: newScale,
      animation: { duration: 180, easingFunction: 'easeInOutQuad' },
    });
  };
  _container.addEventListener('wheel', _smoothZoomMain, { passive: false, capture: true });

  // Immediate redraw on container resize without changing viewport
  if (_container && window.ResizeObserver) {
    const ro = new ResizeObserver(() => { if (_network) _network.redraw(); });
    ro.observe(_container);
  }

  // Fit view immediately since stabilization is disabled (instant render)
  requestAnimationFrame(() => {
    _network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
    setTimeout(() => {
      const scale = _network.getScale();
      if (scale < 0.4 && _graphLabelsVisible) {
        _graphLabelsVisible = false;
        const font = { ...nodeFont, color: 'transparent' };
        _visNodes.update(_allNodes.map(n => ({ id: n.id, font })));
      }
    }, 500);
  });

  _perfLog('_draw complete', t0);
  _buildToolbar();
  _buildSettingsPanel();
}

function _buildToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'shard-graph-toolbar';

  const fitBtn = document.createElement('button');
  fitBtn.className = 'shard-graph-toolbtn';
  fitBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  fitBtn.title = 'Fit to view';
  fitBtn.addEventListener('click', () => _network?.fit({ animation: true }));
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

function _buildSettingsPanel() {
  // Remove existing panel if any
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

  // Stop events inside panel from reaching the graph canvas / document click-away
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  // Click-away: close panel when clicking outside it
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

  // Search
  panel.querySelector('#sg-filter-search').addEventListener('input', (e) => {
    _graphSettings.searchQuery = e.target.value;
    _saveSettings();
    _redraw();
  });

  // Orphans toggle
  panel.querySelector('#sg-filter-orphans').addEventListener('change', (e) => {
    _graphSettings.showOrphans = e.target.checked;
    _saveSettings();
    _redraw();
  });

  // Display: arrows
  panel.querySelector('#sg-display-arrows').addEventListener('change', (e) => {
    _graphSettings.arrows = e.target.checked;
    _saveSettings();
    _network.setOptions({ edges: { arrows: e.target.checked ? { to: { enabled: true, scaleFactor: 0.5 } } : { to: { enabled: false } } } });
  });

  // Display: node size — scale from backend base value (connection count)
  panel.querySelector('#sg-display-nodeSize').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    _graphSettings.nodeSize = val;
    _saveSettings();
    _visNodes.update(_allNodes.map(n => ({ id: n.id, value: (n.value || 1) * val })));
    panel.querySelector('#sg-display-nodeSize-val').textContent = val;
  });

  // Display: link thickness
  panel.querySelector('#sg-display-linkThickness').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    _graphSettings.linkThickness = val;
    _saveSettings();
    _network.setOptions({ edges: { width: val } });
    panel.querySelector('#sg-display-linkThickness-val').textContent = val;
  });

  // Force sliders — update value display on input, apply on change
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

  panel.querySelector('#sg-force-centre').addEventListener('change', () => _applyForces(_network, _graphSettings, _visNodes, _allNodes));
  panel.querySelector('#sg-force-repel').addEventListener('change', () => _applyForces(_network, _graphSettings, _visNodes, _allNodes));
  panel.querySelector('#sg-force-link').addEventListener('change', () => _applyForces(_network, _graphSettings, _visNodes, _allNodes));
  panel.querySelector('#sg-force-distance').addEventListener('change', () => _applyForces(_network, _graphSettings, _visNodes, _allNodes));

  // Animate button: full force re-simulation
  panel.querySelector('#sg-force-animate').addEventListener('click', () => {
    _applyForces(_network, _graphSettings, _visNodes, _allNodes);
  });
}

function _redraw() {
  if (!_network || !_visNodes) return;
  const t0 = performance.now();
  const visibleIds = _getVisibleNodeIds();
  _graphVisibleIds = visibleIds;

  // Rebuild adjacency from visible nodes only
  _graphAdjMap = new Map();
  for (const n of _allNodes) _graphAdjMap.set(n.id, new Set());
  const visibleEdges = _allEdges.filter(e => visibleIds.has(e.from) && visibleIds.has(e.to));
  for (const e of visibleEdges) {
    _graphAdjMap.get(e.from)?.add(e.to);
    _graphAdjMap.get(e.to)?.add(e.from);
  }

  const updates = [];
  for (const n of _allNodes) updates.push({ id: n.id, hidden: !visibleIds.has(n.id) });
  _visNodes.update(updates);
  _perfLog('_redraw', t0);
}

export function destroyGraph() {
  _destroyNetwork();
  _allNodes = [];
  _allEdges = [];
}

// ── Local Graph ────────────────────────────────────────────

let _localNetwork = null;
let _localContainer = null;
let _localVisNodes = null;
let _localVisEdges = null;
let _localAllNodes = [];
let _localAllEdges = [];
let _localSettings = null;
let _localActiveNoteId = null;
let _localGraphTooltip = null;
let _localIsDragging = false;
let _localAdjMap = null;
let _localVisibleIds = null;
let _localLastHoverId = null;
let _localHoverDebounceTimer = null;
let _localBlurDebounceTimer = null;

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

export async function renderLocalGraph(container, vaultId, noteId) {
  if (!window.vis || !container || !noteId) return;
  const t0 = _perfLog('renderLocalGraph start');
  _localContainer = container;
  _localActiveNoteId = noteId;
  _localSettings = _loadLocalSettings();

  container.innerHTML = '<div class="shard-graph-loading">Loading local graph...</div>';

  try {
    const qs = new URLSearchParams();
    if (vaultId) qs.set('vault_id', vaultId);
    const tFetch = performance.now();
    const r = await fetch(`${API_BASE}/api/shard/graph?${qs.toString()}`);
    _perfLog('fetch local graph data', tFetch);
    if (!r.ok) { container.innerHTML = '<div class="shard-graph-error">Failed to load graph</div>'; return; }
    const data = await r.json();
    _localAllNodes = data.nodes || [];
    _localAllEdges = data.edges || [];
    _perfLog(`local nodes=${_localAllNodes.length} edges=${_localAllEdges.length}`);
    _drawLocal();
    _perfLog('renderLocalGraph total', t0);
  } catch (e) {
    container.innerHTML = `<div class="shard-graph-error">${e.message}</div>`;
  }
}

function _getLocalFilteredNodes() {
  const s = _localSettings;
  const depth = s.depth;
  const centerId = _localActiveNoteId;
  if (!centerId) return [];

  // Build adjacency from all edges (undirected)
  const adj = new Map();
  for (const e of _localAllEdges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    if (!adj.has(e.to)) adj.set(e.to, new Set());
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
  }

  // BFS to find nodes within depth
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
    if (!s.showTags && n.tags && n.tags.length > 0) return false;
    if (!s.showAttachments && n.folder === 'Attachments') return false;
    return true;
  });

  // Always include the center node even if it has no edges (orphan in local graph)
  const hasCenter = result.some(n => n.id === centerId);
  if (!hasCenter) {
    const centerNode = _localAllNodes.find(n => n.id === centerId);
    if (centerNode) {
      result.unshift(centerNode);
    } else {
      // Fallback: create minimal center node if not in global data
      result.unshift({
        id: centerId,
        label: centerId.split('/').pop()?.replace(/\.md$/, '') || centerId,
        value: 1,
        color: {
          background: '#4dabf7',
          border: '#339af0',
          highlight: { background: '#74c0fc', border: '#339af0' },
          hover: { background: '#74c0fc', border: '#339af0' },
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

function _destroyLocalNetwork() {
  if (_localNetwork) { _localNetwork.destroy(); _localNetwork = null; }
  if (_localGraphTooltip) { _localGraphTooltip.remove(); _localGraphTooltip = null; }
  _localVisNodes = null;
  _localVisEdges = null;
}

function _drawLocal() {
  if (!_localContainer || !window.vis) return;
  const t0 = performance.now();
  _destroyLocalNetwork();
  _localContainer.innerHTML = '';

  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue('--bg').trim() || '#282c34';
  const fg = style.getPropertyValue('--fg').trim() || '#abb2bf';
  const border = style.getPropertyValue('--border').trim() || '#3e4451';

  const s = _localSettings;
  const nodeCount = _localAllNodes.length;
  const isLarge = nodeCount > 200;
  const stabilizeIter = isLarge ? 100 : 150;

  const filteredNodes = _getLocalFilteredNodes();
  const visibleIds = new Set(filteredNodes.map(n => n.id));
  const visibleEdges = _getLocalVisibleEdges(visibleIds);

  if (filteredNodes.length === 0) {
    _localContainer.innerHTML = '<div class="shard-graph-loading">Select a note to see its local graph.</div>';
    return;
  }

  const nodeFont = {
    color: fg,
    face: 'Fira Code, monospace',
    size: 12,
    strokeWidth: 0,
    vadjust: -4,
  };

  const edgeColor = {
    color: '#5c6370',
    highlight: fg,
    hover: fg,
    opacity: 0.85,
  };

  const accentColor = '#00aaff';
  const accentEdgeColor = { color: accentColor, highlight: accentColor, hover: accentColor, opacity: 0.9 };
  const dimmedEdgeColor = { color: '#5c6370', highlight: fg, hover: fg, opacity: 0.1 };

  // Ensure center node exists in _localAllNodes (fallback from filteredNodes if missing)
  const hasCenterInAll = _localAllNodes.some(n => n.id === _localActiveNoteId);
  if (!hasCenterInAll) {
    const fallback = filteredNodes.find(n => n.id === _localActiveNoteId);
    if (fallback) _localAllNodes.push(fallback);
  }

  // Build DataSet from all nodes with hidden flag so event handlers can update any node
  const localNodesStyled = _localAllNodes.map(n => {
    const isCenter = n.id === _localActiveNoteId;
    const isVisible = visibleIds.has(n.id);
    return {
      ...n,
      value: (n.value || 1) * s.nodeSize,
      hidden: !isVisible,
      x: isCenter ? 0 : undefined,
      y: isCenter ? 0 : undefined,
      color: isCenter ? {
        background: '#4dabf7',
        border: '#339af0',
        highlight: { background: '#74c0fc', border: '#339af0' },
        hover: { background: '#74c0fc', border: '#339af0' },
      } : n.color,
      borderWidth: isCenter ? 3 : 1,
    };
  });

  _localVisNodes = new window.vis.DataSet(localNodesStyled);
  _localVisEdges = new window.vis.DataSet(visibleEdges);

  // Precompute adjacency map for O(1) neighbor lookup
  _localAdjMap = new Map();
  for (const n of _localAllNodes) _localAdjMap.set(n.id, new Set());
  for (const e of visibleEdges) {
    _localAdjMap.get(e.from)?.add(e.to);
    _localAdjMap.get(e.to)?.add(e.from);
  }
  _localVisibleIds = visibleIds;
  _localLastHoverId = null;

  const options = {
    nodes: {
      shape: 'dot',
      font: nodeFont,
      borderWidth: 1,
      borderWidthSelected: 2,
      shadow: false,
      scaling: {
        min: 8,
        max: 30,
        label: { enabled: false },
      },
    },
    edges: {
      width: s.linkThickness,
      color: edgeColor,
      smooth: { type: 'continuous' },
      arrows: s.arrows ? { to: { enabled: true, scaleFactor: 0.5 } } : { to: { enabled: false } },
    },
    physics: {
      enabled: true,
      stabilization: {
        enabled: true,
        iterations: 100,
        updateInterval: 25,
        onlyDynamicEdges: false,
        fit: false,
      },
      barnesHut: {
        gravitationalConstant: s.repelForce,
        centralGravity: s.centreForce,
        springLength: s.linkDistance,
        springConstant: s.linkForce,
        damping: 0.85,
        avoidOverlap: 0.1,
      },
      maxVelocity: 15,
      minVelocity: 0.1,
      timestep: 0.35,
      adaptiveTimestep: true,
    },
    interaction: {
      hover: true,
      tooltipDelay: 200,
      zoomView: true,
      dragView: true,
      hideEdgesOnDrag: true,
      hideEdgesOnZoom: false,
    },
    layout: { improvedLayout: !isLarge },
    autoResize: true,
  };

  _localNetwork = new window.vis.Network(_localContainer, { nodes: _localVisNodes, edges: _localVisEdges }, options);

  // After initial stabilization, freeze nodes so they stop drifting
  _localNetwork.once('stabilizationIterationsDone', () => {
    _freezeGraph(_localNetwork, _localVisNodes, _localAllNodes);
  });

  // Zoom-based label visibility (labels hidden when zoomed out) — throttled
  let _localGraphLabelsVisible = true;
  let _localZoomRaf = null;
  _localNetwork.on('zoom', () => {
    if (_localZoomRaf) return;
    _localZoomRaf = requestAnimationFrame(() => {
      _localZoomRaf = null;
      const scale = _localNetwork.getScale();
      const show = scale >= 0.5;
      if (show !== _localGraphLabelsVisible) {
        _localGraphLabelsVisible = show;
        const font = show ? nodeFont : { ...nodeFont, color: 'transparent' };
        const updates = [];
        for (const n of _localAllNodes) {
          if (_localVisibleIds.has(n.id)) updates.push({ id: n.id, font });
        }
        _localVisNodes.update(updates);
      }
    });
  });

  // Drag state tracking to suppress hover flicker during node drag
  let _localDragStartTime = 0;
  _localNetwork.on('dragStart', () => {
    _localIsDragging = true;
    _localDragStartTime = performance.now();
    _stopPhysics(_localNetwork); // instant drag response — no physics recomputation
  });
  _localNetwork.on('dragEnd', () => {
    _localIsDragging = false;
    _localLastHoverId = null;
    _perfLog('local dragEnd (total drag)', _localDragStartTime);
    const t0 = performance.now();
    if (_localGraphTooltip) _localGraphTooltip.classList.remove('visible');
    const restoreNodes = [];
    for (const n of _localAllNodes) {
      if (_localVisibleIds.has(n.id)) {
        restoreNodes.push({ id: n.id, value: (n.value || 1) * s.nodeSize, opacity: 1 });
      }
    }
    _localVisNodes.update(restoreNodes);
    const restoreEdges = visibleEdges.map(e => ({ id: e.id, color: edgeColor }));
    _localVisEdges.update(restoreEdges);
    _perfLog('local dragEnd restore', t0);
    // Briefly re-enable physics so dragged node settles, then freeze again
    _applyForces(_localNetwork, _localSettings, _localVisNodes, _localAllNodes);
  });

  // Create tooltip element
  if (_localGraphTooltip) _localGraphTooltip.remove();
  _localGraphTooltip = document.createElement('div');
  _localGraphTooltip.className = 'shard-graph-tooltip';
  _localContainer.appendChild(_localGraphTooltip);

  // Click on node → open note; click on background → reset isolation
  _localNetwork.on('click', function (params) {
    const t0 = performance.now();
    if (params.nodes.length === 0) {
      const updates = [];
      for (const n of _localAllNodes) updates.push({ id: n.id, hidden: !visibleIds.has(n.id) });
      _localVisNodes.update(updates);
    } else {
      const noteId = params.nodes[0];
      window.dispatchEvent(new CustomEvent('odysseus-shard-select-note', { detail: { id: noteId } }));
    }
    _perfLog('local click handler', t0);
  });

  // Double-click on node → isolate neighbors
  _localNetwork.on('doubleClick', function (params) {
    const t0 = performance.now();
    if (params.nodes.length === 0) return;
    const selected = params.nodes[0];
    const connected = _localAdjMap.get(selected) || new Set();
    const updates = [];
    for (const n of _localAllNodes) {
      if (!visibleIds.has(n.id)) continue;
      updates.push({ id: n.id, hidden: !connected.has(n.id) && n.id !== selected });
    }
    _localVisNodes.update(updates);
    _perfLog('local doubleClick handler', t0);
  });

  // Hover: enlarge node, dim non-neighbors, highlight edges, show tooltip
  _localNetwork.on('hoverNode', function (params) {
    if (_localIsDragging) return;
    const hoveredId = params.node;
    if (hoveredId === _localLastHoverId) return;
    clearTimeout(_localBlurDebounceTimer);
    _localHoverDebounceTimer = setTimeout(() => {
      _localLastHoverId = hoveredId;
      const t0 = performance.now();
      const connected = _localAdjMap.get(hoveredId);
      if (!connected) return;

      // Show tooltip with node title
      const node = _localAllNodes.find(n => n.id === hoveredId);
      if (node && _localGraphTooltip) {
        _localGraphTooltip.textContent = node.label || node.id;
        const pos = _localNetwork.canvasToDOM({ x: node.x || 0, y: node.y || 0 });
        _localGraphTooltip.style.left = (pos.x) + 'px';
        _localGraphTooltip.style.top = (pos.y + 15) + 'px';
        _localGraphTooltip.classList.add('visible');
      }

      const nodeUpdates = [];
      for (const n of _localAllNodes) {
        if (!visibleIds.has(n.id)) continue;
        if (n.id === hoveredId) {
          nodeUpdates.push({ id: n.id, value: (n.value || 1) * s.nodeSize * 1.5, opacity: 1 });
        } else if (connected.has(n.id)) {
          nodeUpdates.push({ id: n.id, opacity: 1 });
        } else {
          nodeUpdates.push({ id: n.id, opacity: 0.15 });
        }
      }
      _localVisNodes.update(nodeUpdates);

      const edgeUpdates = [];
      for (const e of visibleEdges) {
        edgeUpdates.push({
          id: e.id,
          color: (e.from === hoveredId || e.to === hoveredId) ? accentEdgeColor : dimmedEdgeColor,
        });
      }
      _localVisEdges.update(edgeUpdates);
      _perfLog('local hoverNode handler', t0);
    }, 20);
  });

  // Blur: restore sizes and colors, hide tooltip
  _localNetwork.on('blurNode', function (params) {
    if (_localIsDragging) return;
    clearTimeout(_localHoverDebounceTimer);
    _localBlurDebounceTimer = setTimeout(() => {
      const t0 = performance.now();
      _localLastHoverId = null;
      if (_localGraphTooltip) _localGraphTooltip.classList.remove('visible');
      const restoreNodes = [];
      for (const n of _localAllNodes) {
        if (visibleIds.has(n.id)) {
          restoreNodes.push({ id: n.id, value: (n.value || 1) * s.nodeSize, opacity: 1 });
        }
      }
      _localVisNodes.update(restoreNodes);
      const restoreEdges = visibleEdges.map(e => ({ id: e.id, color: edgeColor }));
      _localVisEdges.update(restoreEdges);
      _perfLog('local blurNode handler', t0);
    }, 20);
  });

  // Smooth wheel zoom — intercept before vis-network's native handler
  const _smoothZoomLocal = (e) => {
    if (!e.target.closest('canvas')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const currentScale = _localNetwork.getScale();
    const direction = e.deltaY > 0 ? 0.88 : 1.12;
    const newScale = Math.max(0.05, Math.min(3, currentScale * direction));
    _localNetwork.moveTo({
      scale: newScale,
      animation: { duration: 180, easingFunction: 'easeInOutQuad' },
    });
  };
  _localContainer.addEventListener('wheel', _smoothZoomLocal, { passive: false, capture: true });

  // Immediate redraw on container resize without changing viewport
  if (_localContainer && window.ResizeObserver) {
    const ro = new ResizeObserver(() => { if (_localNetwork) _localNetwork.redraw(); });
    ro.observe(_localContainer);
  }

  // Focus center immediately since stabilization is disabled (instant render)
  requestAnimationFrame(() => {
    _localNetwork.focus(_localActiveNoteId, {
      scale: 1.2,
      animation: { duration: 400, easingFunction: 'easeInOutQuad' },
    });
    setTimeout(() => {
      const scale = _localNetwork.getScale();
      if (scale < 0.5 && _localGraphLabelsVisible) {
        _localGraphLabelsVisible = false;
        const font = { ...nodeFont, color: 'transparent' };
        _localVisNodes.update(_localAllNodes.map(n => ({ id: n.id, font })));
      }
    }, 500);
  });

  _perfLog('_drawLocal complete', t0);
  _buildLocalToolbar();
  _buildLocalSettingsPanel();
}

function _buildLocalToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'shard-graph-toolbar';

  const fitBtn = document.createElement('button');
  fitBtn.className = 'shard-graph-toolbtn';
  fitBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  fitBtn.title = 'Fit to view';
  fitBtn.addEventListener('click', () => _localNetwork?.fit({ animation: true }));
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

  // Close button
  panel.querySelector('.shard-graph-settings-close').addEventListener('click', () => {
    panel.classList.add('hidden');
  });

  // Stop events inside panel from reaching the graph canvas / document click-away
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  // Click-away: close panel when clicking outside it
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

  // Depth
  panel.querySelector('#sg-local-depth').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    _localSettings.depth = val;
    _saveLocalSettings();
    panel.querySelector('#sg-local-depth-val').textContent = val;
    _redrawLocal();
  });

  // Filters
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
  // Display: arrows
  panel.querySelector('#sg-local-arrows').addEventListener('change', (e) => {
    _localSettings.arrows = e.target.checked;
    _saveLocalSettings();
    _localNetwork.setOptions({ edges: { arrows: e.target.checked ? { to: { enabled: true, scaleFactor: 0.5 } } : { to: { enabled: false } } } });
  });

  // Display: node size
  panel.querySelector('#sg-local-nodeSize').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    _localSettings.nodeSize = val;
    _saveLocalSettings();
    _localVisNodes.update(_localAllNodes.map(n => ({ id: n.id, value: (n.value || 1) * val })));
    panel.querySelector('#sg-local-nodeSize-val').textContent = val;
  });

  // Display: link thickness
  panel.querySelector('#sg-local-linkThickness').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    _localSettings.linkThickness = val;
    _saveLocalSettings();
    _localNetwork.setOptions({ edges: { width: val } });
    panel.querySelector('#sg-local-linkThickness-val').textContent = val;
  });

  // Force sliders — update value display on input, apply on change
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

  panel.querySelector('#sg-local-centre').addEventListener('change', () => _applyForces(_localNetwork, _localSettings, _localVisNodes, _localAllNodes));
  panel.querySelector('#sg-local-repel').addEventListener('change', () => _applyForces(_localNetwork, _localSettings, _localVisNodes, _localAllNodes));
  panel.querySelector('#sg-local-link').addEventListener('change', () => _applyForces(_localNetwork, _localSettings, _localVisNodes, _localAllNodes));
  panel.querySelector('#sg-local-distance').addEventListener('change', () => _applyForces(_localNetwork, _localSettings, _localVisNodes, _localAllNodes));

  // Animate button: full force re-simulation
  panel.querySelector('#sg-local-animate').addEventListener('click', () => {
    _applyForces(_localNetwork, _localSettings, _localVisNodes, _localAllNodes);
  });
}

function _redrawLocal() {
  const t0 = performance.now();
  _destroyLocalNetwork();
  _drawLocal();
  _perfLog('_redrawLocal', t0);
}

export function destroyLocalGraph() {
  _destroyLocalNetwork();
  _localAllNodes = [];
  _localAllEdges = [];
  _localActiveNoteId = null;
}
