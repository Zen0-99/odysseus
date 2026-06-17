/**
 * Pixi Graph Renderer — GPU-accelerated graph using Pixi.js + Web Worker physics.
 */

let _hoverNodeId = null;
let _settingsPanelHovered = false;

export function setSettingsPanelHover(val) { _settingsPanelHovered = val; }
export function clearGraphHover() {
  _hoverNodeId = null;
}

function _getAccentColor() {
  const el = document.createElement('div');
  el.style.color = 'var(--accent, var(--red, #4a9eff))';
  el.style.position = 'absolute'; el.style.visibility = 'hidden';
  document.body.appendChild(el);
  const c = getComputedStyle(el).color;
  document.body.removeChild(el);
  return c || '#4a9eff';
}

// Node size grows in discrete steps based on link count (degree), so a
// single-link note isn't instantly bigger than an orphan. Thresholds mirror
// Obsidian's bucketed sizing.
function _degreeScale(degree) {
  if (degree >= 20) return 2.5;
  if (degree >= 10) return 2.0;
  if (degree >= 5) return 1.6;
  if (degree >= 2) return 1.3;
  return 1.0; // 0 or 1 links → base size
}

function _buildAdjMap(nodes, edges) {
  const m = new Map();
  for (const n of nodes) m.set(String(n.id), new Set());
  for (const e of edges) {
    const f = String(e.from ?? e.source);
    const t = String(e.to ?? e.target);
    m.get(f)?.add(t); m.get(t)?.add(f);
  }
  return m;
}

function _computeNodeDegrees(nodes, edges) {
  const d = new Map();
  for (const n of nodes) d.set(String(n.id), 0);
  for (const e of edges) {
    const f = String(e.from ?? e.source), t = String(e.to ?? e.target);
    d.set(f, (d.get(f) || 0) + 1); d.set(t, (d.get(t) || 0) + 1);
  }
  return d;
}

function _nodeMatchesGroup(node, query) {
  if (!query) return false;
  const q = query.toLowerCase().trim();
  if (!q) return false;
  if (q.startsWith('tag:')) {
    const tq = q.slice(4).trim().replace(/^#/, '');
    return (node.tags || []).some(t => String(t).toLowerCase().replace(/^#/, '').includes(tq));
  }
  const name = String(node.label || node.title || node.name || node.id || '').toLowerCase();
  const path = String(node.rel_path || node.path || '').toLowerCase();
  return name.includes(q) || path.includes(q);
}

function _resolveGroupColor(node, groups) {
  if (!groups?.length) return null;
  for (const g of groups) if (g.query && _nodeMatchesGroup(node, g.query)) return g.color || '#00aaff';
  return null;
}

function _toGraphData(data, settings, activeNoteId) {
  const safeNodes = (data.nodes || []).filter(n => n.id != null && String(n.id).length > 0).map(n => ({ ...n, id: String(n.id) }));
  const ids = new Set(safeNodes.map(n => n.id));
  const safeEdges = (data.edges || []).filter(e => {
    const f = e.from != null ? String(e.from) : (typeof e.source === 'string' ? e.source : '');
    const t = e.to != null ? String(e.to) : (typeof e.target === 'string' ? e.target : '');
    return ids.has(f) && ids.has(t);
  });
  const degrees = _computeNodeDegrees(safeNodes, safeEdges);
  const maxDeg = Math.max(1, ...degrees.values());
  const baseVal = 8 * settings.nodeSize;
  return {
    nodes: safeNodes.map(n => {
      const deg = degrees.get(n.id) || 0;
      const scale = _degreeScale(deg);
      const gc = _resolveGroupColor(n, settings.groups);
      return {
        id: n.id, name: n.label || n.id, val: baseVal * scale,
        color: n.id === activeNoteId ? (settings.accentColor || '#00aaff') : (gc || n.color?.background || settings.nodeColor || '#5c6370'),
        created: n.created,
      };
    }),
    links: safeEdges.map(e => {
      const f = e.from != null ? String(e.from) : (typeof e.source === 'string' ? e.source : '');
      const t = e.to != null ? String(e.to) : (typeof e.target === 'string' ? e.target : '');
      return { source: f, target: t };
    }),
  };
}

function _colorToHex(str) {
  if (!str || str[0] === '#') return str || '#5c6370';
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = str;
  return c.fillStyle;
}

// ─── Spatial Hash for O(1) hover ───────────────────────────────────────────

class SpatialHash {
  constructor(cellSize = 80) { this.cellSize = cellSize; this.clear(); }
  clear() { this.cells = new Map(); }
  _key(cx, cy) { return `${cx},${cy}`; }
  insert(id, x, y, radius) {
    const r = radius + 2;
    const minX = Math.floor((x - r) / this.cellSize), maxX = Math.floor((x + r) / this.cellSize);
    const minY = Math.floor((y - r) / this.cellSize), maxY = Math.floor((y + r) / this.cellSize);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const k = this._key(cx, cy);
        if (!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k).push({ id, x, y, r });
      }
    }
  }
  query(x, y) {
    const cx = Math.floor(x / this.cellSize), cy = Math.floor(y / this.cellSize);
    const items = this.cells.get(this._key(cx, cy)) || [];
    let best = null, bestD = Infinity;
    for (const item of items) {
      const d2 = (x - item.x) ** 2 + (y - item.y) ** 2;
      if (d2 <= item.r * item.r && d2 < bestD) { bestD = d2; best = item.id; }
    }
    return best;
  }
}

// ─── Graph Engine ──────────────────────────────────────────────────────────

class GraphEngine {
  constructor(container, data, settings, isLocal = false, activeNoteId = null) {
    this.container = container;
    this.settings = settings;
    this.isLocal = isLocal;
    this.activeNoteId = activeNoteId;
    this._rawData = data;
    this.adjMap = _buildAdjMap(data.nodes, data.edges);
    this.graphData = _toGraphData(data, settings, activeNoteId);
    this.nodes = this.graphData.nodes;
    this.links = this.graphData.links;
    this._nodeById = new Map(this.nodes.map(n => [n.id, n]));
    this.posMap = new Map();
    this.spatial = new SpatialHash();
    this.destroyed = false;
    this._isFiltered = false;
    this._originalNodes = null;
    this._originalLinks = null;
    this._hasAutoZoomed = false;
    // View-easing targets (zoom/pan ease-out)
    this._targetScale = 0.5;
    this._targetX = 0;
    this._targetY = 0;
    this._dirty = true;       // request a redraw
    this._physicsActive = true;

    // ── Animation playback state ─────────────────────────────────────────
    this._isAnimating = false;
    this._animationTime = 0;          // current cursor (ms timestamp) — exposed to UI
    this._animationSpeed = 1;         // playback speed multiplier
    this._animationRaf = null;        // requestAnimationFrame handle
    this._animationStartReal = 0;     // Date.now() when play began
    this._animationPausedAt = 0;      // animationTime when paused
    this._animProgress = 0;           // 0-1 virtual progress
    this._animBaseProgress = 0;       // progress at segment start
    this._animSegmentStartReal = 0;   // Date.now() when current segment began
    this._timedNodes = [];            // nodes with valid created timestamps
    this._untimedNodeIds = new Set(); // nodes with missing/invalid created
    this._sortedEdges = [];           // edges sorted by max(endpoint created)
    this._minCreated = 0;
    this._maxCreated = 0;
    this._onAnimationTick = null;     // callback for UI (time, count)
    this._onAnimationEnd = null;      // callback when finished
    this._lastRevealCount = -1;       // cache to skip redundant worker posts
    this._lastUntimedSize = -1;       // cache to skip redundant worker posts

    this._initPixi();
    this._initWorker();
    this._initInteractions();
    this._startRenderLoop();
    this._perfLogLast = 0;
  }

  _startRenderLoop() {
    this.app.ticker.add(() => {
      if (this.destroyed) return;
      const viewMoving = this._animateView();
      const nodesMoving = this._animateNodes();
      if (this._dirty || viewMoving || nodesMoving) {
        this._drawLinks();
        this._drawNodes();
        this._drawArrows();
        this._updateLabels();
        this._dirty = false;
      }
      // Infrequent performance log
      const now = Date.now();
      if (now - this._perfLogLast > 30000) {
        this._perfLogLast = now;
        const vis = this.nodes.filter(n => n._visible !== false).length;
        console.log('[pixi-graph] perf', this.nodes.length, 'nodes,', this.links.length, 'links,', vis, 'visible');
      }
    });
  }

  // Ease the viewport toward its target scale/translation (zoom ease-out).
  _animateView() {
    const v = this.viewport;
    if (!v) return false;
    const ease = 0.18;
    const ds = this._targetScale - v.scale.x;
    const dx = this._targetX - v.x;
    const dy = this._targetY - v.y;
    if (Math.abs(ds) < 0.0005 && Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) return false;
    v.scale.set(v.scale.x + ds * ease);
    v.x += dx * ease;
    v.y += dy * ease;
    return true;
  }

  _appearOf(id) {
    const n = this._nodeById?.get(id);
    return n ? (n._appear == null ? 1 : n._appear) : 1;
  }

  // Lerp each node's appear-scale toward its visibility target (0 or 1).
  _animateNodes() {
    let animating = false;
    for (const node of this.nodes) {
      const target = node._visible === false ? 0 : 1;
      if (node._appear == null) node._appear = target;
      const d = target - node._appear;
      if (Math.abs(d) > 0.001) { node._appear += d * 0.18; animating = true; }
      else node._appear = target;
    }
    return animating;
  }

  _initPixi() {
    const PIXI = window.PIXI;
    if (!PIXI) { console.error('[pixi-graph] Pixi.js not loaded'); return; }

    const bg = _colorToHex(this.settings.bg || '#282c34');
    this.app = new PIXI.Application({
      resizeTo: this.container,
      backgroundColor: parseInt(bg.slice(1), 16),
      antialias: true,
      resolution: Math.min(window.devicePixelRatio, 2),
      autoDensity: true,
    });
    this.container.appendChild(this.app.view);
    this.app.view.style.width = '100%';
    this.app.view.style.height = '100%';
    this.app.view.style.display = 'block';

    // Self-contained pan/zoom container (no pixi-viewport dependency)
    this.viewport = new PIXI.Container();
    this.viewport.scale.set(0.5);
    this.app.stage.addChild(this.viewport);
    this._initPanZoom();

    // Link graphics (single draw call)
    this.linkGraphics = new PIXI.Graphics();
    this.viewport.addChild(this.linkGraphics);

    // Vector node graphics (single Graphics object, redrawn each frame)
    this.nodeGraphics = new PIXI.Graphics();
    this.viewport.addChild(this.nodeGraphics);

    // Arrow graphics (on top of nodes so tips are visible)
    this.arrowGraphics = new PIXI.Graphics();
    this.viewport.addChild(this.arrowGraphics);

    // Labels container (on top)
    this.labelContainer = new PIXI.Container();
    this.viewport.addChild(this.labelContainer);

    this._buildLabels();
    this._drawLinks();
    this._drawNodes();
  }

  _buildLabels() {
    this.labels = new Map();
    const fg = _colorToHex(this.settings.fg || '#abb2bf');
    for (const node of this.nodes) {
      const lbl = new PIXI.Text(node.name, {
        fontFamily: '"Fira Code", monospace',
        fontSize: 16,
        fill: fg,
        align: 'center',
      });
      lbl.anchor.set(0.5, 0);
      lbl.visible = false;
      this.labelContainer.addChild(lbl);
      this.labels.set(node.id, lbl);
    }
  }

  _drawNodes() {
    const g = this.nodeGraphics;
    g.clear();
    const accent = parseInt(_colorToHex(this.settings.accentColor || '#00aaff').slice(1), 16);
    const dimmedColor = parseInt('5c6370', 16);

    for (const node of this.nodes) {
      const pos = this.posMap.get(node.id);
      if (!pos) continue;
      const appear = node._appear == null ? 1 : node._appear;
      if (appear < 0.01) continue; // fully scaled out

      const isHov = !_settingsPanelHovered && node.id === _hoverNodeId;
      const neighbors = this.adjMap.get(node.id) || new Set();
      const isNei = _hoverNodeId && !_settingsPanelHovered && neighbors.has(_hoverNodeId);
      const isDim = _hoverNodeId && !_settingsPanelHovered && !isHov && !isNei;

      const color = isDim ? dimmedColor : (isHov ? accent : parseInt(_colorToHex(node.color).slice(1), 16));
      const alpha = (isDim ? 0.2 : 1) * appear;
      const size = (isHov ? node.val * 1.1 : node.val) * appear;

      g.lineStyle(0);
      g.beginFill(color, alpha);
      g.drawCircle(pos.x, pos.y, size);
      g.endFill();
    }
  }

  _drawLinks() {
    const g = this.linkGraphics;
    g.clear();
    const s = this.settings;
    const accent = parseInt(_colorToHex(this.settings.accentColor || '#00aaff').slice(1), 16);
    const baseColor = parseInt('5c6370', 16);

    for (const link of this.links) {
      const src = this.posMap.get(link.source);
      const tgt = this.posMap.get(link.target);
      if (!src || !tgt) continue;
      const sa = this._appearOf(link.source), ta = this._appearOf(link.target);
      const appear = Math.min(sa, ta);
      if (appear < 0.01) continue;

      const isHov = !_settingsPanelHovered && (link.source === _hoverNodeId || link.target === _hoverNodeId);
      const color = isHov ? accent : baseColor;
      const alpha = (isHov ? 1.0 : (_hoverNodeId && !_settingsPanelHovered) ? 0.05 : 0.6) * appear;

      g.lineStyle(s.linkThickness || 1, color, alpha);
      g.moveTo(src.x, src.y);
      if (s.curvedLines) {
        const mx = (src.x + tgt.x) / 2, my = (src.y + tgt.y) / 2;
        const angle = Math.atan2(tgt.y - src.y, tgt.x - src.x);
        const perp = angle + Math.PI / 2;
        const curve = s.curveAngle || 0.5;
        const dist = Math.hypot(tgt.x - src.x, tgt.y - src.y) * curve;
        g.quadraticCurveTo(mx + Math.cos(perp) * dist, my + Math.sin(perp) * dist, tgt.x, tgt.y);
      } else {
        g.lineTo(tgt.x, tgt.y);
      }

    }
  }

  _drawArrows() {
    const g = this.arrowGraphics;
    g.clear();
    const s = this.settings;
    if (!s.arrows) return;
    const accent = parseInt(_colorToHex(this.settings.accentColor || '#00aaff').slice(1), 16);
    const baseColor = parseInt('5c6370', 16);

    for (const link of this.links) {
      const src = this.posMap.get(link.source);
      const tgt = this.posMap.get(link.target);
      if (!src || !tgt) continue;
      const sa = this._appearOf(link.source), ta = this._appearOf(link.target);
      const appear = Math.min(sa, ta);
      if (appear < 0.01) continue;

      const isHov = !_settingsPanelHovered && (link.source === _hoverNodeId || link.target === _hoverNodeId);
      const color = isHov ? accent : baseColor;
      const alpha = (isHov ? 1.0 : (_hoverNodeId && !_settingsPanelHovered) ? 0.05 : 0.6) * appear;

      const angle = Math.atan2(tgt.y - src.y, tgt.x - src.x);
      const tgtNode = this.nodes.find(n => n.id === link.target);
      const tgtRadius = (tgtNode ? tgtNode.val : 4) * appear;
      const offset = tgtRadius + 3;
      const tipX = tgt.x - offset * Math.cos(angle);
      const tipY = tgt.y - offset * Math.sin(angle);
      const as = 7;

      g.lineStyle(0);
      g.beginFill(color, alpha);
      g.moveTo(tipX, tipY);
      g.lineTo(tipX - as * Math.cos(angle - Math.PI / 5), tipY - as * Math.sin(angle - Math.PI / 5));
      g.lineTo(tipX - as * 0.5 * Math.cos(angle), tipY - as * 0.5 * Math.sin(angle));
      g.lineTo(tipX - as * Math.cos(angle + Math.PI / 5), tipY - as * Math.sin(angle + Math.PI / 5));
      g.closePath();
      g.endFill();
    }
  }

  _updateHoverVisuals() {
    // Nodes are redrawn each frame in _drawNodes, hover state is applied there
    this._drawNodes();
  }

  _updateLabels() {
    const zoom = this.viewport?.scale?.x || 1;
    // Zoom-based opacity band: labels fade in from 20% at zoom=0.25 to 100% at zoom=0.30
    let zoomAlpha = 1;
    if (zoom <= 0.25) zoomAlpha = 0;
    else if (zoom >= 0.30) zoomAlpha = 1;
    else zoomAlpha = 0.2 + (zoom - 0.25) / 0.05 * 0.8;

    const hoverScale = zoom >= 0.25 ? 1 : Math.min(4, 0.25 / zoom);

    for (const node of this.nodes) {
      const lbl = this.labels.get(node.id);
      if (!lbl) continue;
      const pos = this.posMap.get(node.id);
      if (!pos) continue;
      const appear = node._appear == null ? 1 : node._appear;
      const radius = node.val || 8;
      lbl.x = pos.x;
      lbl.y = pos.y + radius + 4; // sit just below the node circle

      const isHov = node.id === _hoverNodeId;
      const shouldShow = (zoomAlpha > 0 || isHov) && appear > 0.5;

      lbl.visible = shouldShow;
      if (lbl.visible) {
        if (isHov) {
          lbl.scale.set(hoverScale);
          lbl.alpha = appear;
        } else {
          lbl.scale.set(1);
          lbl.alpha = appear * zoomAlpha;
        }
      }
    }
  }

  _initWorker() {
    try {
      this.worker = new Worker('/static/js/graphPhysicsWorker.js');
    } catch (e) {
      console.error('[pixi-graph] Failed to create worker:', e);
      return;
    }
    this.worker.onerror = (e) => {
      console.error('[pixi-graph] Worker error:', e.message, e.filename, 'line', e.lineno);
    };
    this.worker.onmessage = (e) => {
      if (this.destroyed) return;
      const { type, positions, alpha } = e.data;
      if (type === 'tick') {
        for (const p of positions) this.posMap.set(p.id, p);
        this.spatial.clear();
        for (const node of this.nodes) {
          if (node._visible === false) continue; // not hoverable while hidden
          const pos = this.posMap.get(node.id);
          if (pos) this.spatial.insert(node.id, pos.x, pos.y, node.val);
        }
        this._physicsActive = alpha > 0.005;
        if (this._physicsActive) this._dirty = true; // redraw only while moving
        if (!this._hasAutoZoomed) {
          this._hasAutoZoomed = true;
          this.zoomToFit();
        }
      }
    };
    this.worker.postMessage({
      type: 'init',
      nodes: this.nodes.map(n => ({ id: n.id, val: n.val, x: n.x != null ? n.x : undefined, y: n.y != null ? n.y : undefined })),
      links: this.links,
      settings: this.settings,
    });
  }

  _syncPositions() {
    // Positions stored in posMap, drawn each frame in _drawNodes
  }

  _screenToWorld(sx, sy) {
    const s = this.viewport.scale.x || 1;
    return {
      x: (sx - this.viewport.x) / s,
      y: (sy - this.viewport.y) / s,
    };
  }

  _worldToScreen(wx, wy) {
    const s = this.viewport.scale.x || 1;
    return {
      x: wx * s + this.viewport.x,
      y: wy * s + this.viewport.y,
    };
  }

  _initPanZoom() {
    const canvas = this.app.view;
    let panning = false, panStart = { x: 0, y: 0 }, viewStart = { x: 0, y: 0 };

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomSpeed = 0.0015;
      // Zoom relative to the current TARGET so rapid scrolls accumulate smoothly
      const oldTarget = this._targetScale;
      const newScale = Math.max(0.05, Math.min(5, oldTarget * (1 - e.deltaY * zoomSpeed)));
      const mouseX = e.offsetX, mouseY = e.offsetY;
      // Keep the point under the cursor fixed at the new target scale (eased in ticker)
      this._targetX = mouseX - (mouseX - this._targetX) * (newScale / oldTarget);
      this._targetY = mouseY - (mouseY - this._targetY) * (newScale / oldTarget);
      this._targetScale = newScale;
    }, { passive: false });

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || (e.button === 0 && !this.spatial.query(this._screenToWorld(e.offsetX, e.offsetY).x, this._screenToWorld(e.offsetX, e.offsetY).y))) {
        panning = true;
        panStart = { x: e.clientX, y: e.clientY };
        viewStart = { x: this.viewport.x, y: this.viewport.y };
        canvas.style.cursor = 'grabbing';
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (panning) {
        const nx = viewStart.x + (e.clientX - panStart.x);
        const ny = viewStart.y + (e.clientY - panStart.y);
        this.viewport.x = nx; this.viewport.y = ny;
        this._targetX = nx; this._targetY = ny; // keep target in sync (instant pan)
        this._dirty = true;
      }
    });

    canvas.addEventListener('pointerup', () => {
      if (panning) { panning = false; canvas.style.cursor = ''; }
    });

    canvas.addEventListener('pointerleave', () => {
      if (panning) { panning = false; canvas.style.cursor = ''; }
    });
  }

  _initInteractions() {
    const canvas = this.app.view;
    let dragging = false, dragId = null;
    let _downX = 0, _downY = 0, _moved = false;

    canvas.addEventListener('pointerdown', (e) => {
      _downX = e.offsetX; _downY = e.offsetY; _moved = false;
      const world = this._screenToWorld(e.offsetX, e.offsetY);
      const id = this.spatial.query(world.x, world.y);
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        dragging = true; dragId = id; _hoverNodeId = id;
        this.worker?.postMessage({ type: 'dragStart', nodeId: id });
        canvas.setPointerCapture(e.pointerId);
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (Math.abs(e.offsetX - _downX) > 4 || Math.abs(e.offsetY - _downY) > 4) _moved = true;
      const world = this._screenToWorld(e.offsetX, e.offsetY);
      if (dragging && dragId) {
        this.worker?.postMessage({ type: 'drag', nodeId: dragId, x: world.x, y: world.y });
        return;
      }
      const id = this.spatial.query(world.x, world.y);
      if (_hoverNodeId !== id) {
        _hoverNodeId = id;
        this._dirty = true;
        this.container.classList.toggle('graph-node-hover', !!id);
      }
    });

    canvas.addEventListener('pointerup', () => {
      if (dragging && dragId) {
        this.worker?.postMessage({ type: 'dragEnd', nodeId: dragId });
        dragging = false; dragId = null;
      }
    });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const world = this._screenToWorld(e.offsetX, e.offsetY);
      const id = this.spatial.query(world.x, world.y);
      if (id) {
        const connected = this.adjMap.get(id) || new Set();
        const newNodes = this.nodes.filter(n => n.id === id || connected.has(n.id));
        const newNodeIds = new Set(newNodes.map(n => n.id));
        const newLinks = this.links.filter(l => newNodeIds.has(l.source) && newNodeIds.has(l.target));
        this._setFilteredData(newNodes, newLinks);
      }
    });

    canvas.addEventListener('click', (e) => {
      // Background click: if we filtered, restore full graph
      const world = this._screenToWorld(e.offsetX, e.offsetY);
      const id = this.spatial.query(world.x, world.y);
      if (!id && this._isFiltered) {
        this._restoreData();
        return;
      }
      // Only open the note on a genuine click, not at the end of a drag
      if (id && !_moved) {
        window.dispatchEvent(new CustomEvent('odysseus-vault-select-note', { detail: { id } }));
      }
    });

    this.container.addEventListener('mouseleave', () => {
      _hoverNodeId = null;
      this._dirty = true;
      this.container.classList.remove('graph-node-hover');
    });
  }

  _setFilteredData(filteredNodes, filteredLinks) {
    if (!this._isFiltered) {
      this._originalNodes = this.nodes;
      this._originalLinks = this.links;
      this._isFiltered = true;
    }
    this.nodes = filteredNodes;
    this.links = filteredLinks;
    // Hide labels not in filtered set
    const visibleIds = new Set(filteredNodes.map(n => n.id));
    for (const [id, lbl] of this.labels) lbl.visible = visibleIds.has(id) && lbl.visible;
    this._drawLinks();
    this.worker?.postMessage({
      type: 'init',
      nodes: this.nodes.map(n => ({ id: n.id, val: n.val, x: this.posMap.get(n.id)?.x || 0, y: this.posMap.get(n.id)?.y || 0 })),
      links: this.links,
      settings: this.settings,
    });
  }

  _restoreData() {
    if (!this._isFiltered) return;
    this.nodes = this._originalNodes;
    this.links = this._originalLinks;
    this._isFiltered = false;
    this._drawLinks();
    this.worker?.postMessage({
      type: 'init',
      nodes: this.nodes.map(n => ({ id: n.id, val: n.val, x: this.posMap.get(n.id)?.x || 0, y: this.posMap.get(n.id)?.y || 0 })),
      links: this.links,
      settings: this.settings,
    });
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  updateData(newData) {
    this._rawData = newData;
    this.adjMap = _buildAdjMap(newData.nodes, newData.edges);
    const gd = _toGraphData(newData, this.settings, this.activeNoteId);
    // Preserve positions
    for (const n of gd.nodes) {
      const p = this.posMap.get(n.id);
      if (p) { n.x = p.x; n.y = p.y; }
    }
    this.nodes = gd.nodes;
    this.links = gd.links;
    this.graphData = gd;
    this._nodeById = new Map(this.nodes.map(n => [n.id, n]));
    this._isFiltered = false;
    this._originalNodes = null;
    this._originalLinks = null;
    // Rebuild labels if node count changed
    if (this.labels.size !== this.nodes.length) {
      this.labelContainer.removeChildren();
      this.labels.clear();
      this._buildLabels();
    }
    this.worker?.postMessage({
      type: 'init',
      nodes: this.nodes.map(n => ({ id: n.id, val: n.val, x: this.posMap.get(n.id)?.x || 0, y: this.posMap.get(n.id)?.y || 0 })),
      links: this.links,
      settings: this.settings,
    });
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    this.worker?.postMessage({ type: 'updateSettings', settings: this.settings });
  }

  updateNodeSize(size) {
    const ratio = size / this.settings.nodeSize;
    this.settings.nodeSize = size;
    for (const node of this.nodes) {
      node.val *= ratio;
    }
    this.worker?.postMessage({ type: 'updateSettings', settings: this.settings });
  }

  updateLinkThickness(t) { this.settings.linkThickness = t; this._dirty = true; }
  updateArrows(v) { this.settings.arrows = v; this._dirty = true; }
  updateCurveAngle(v) { this.settings.curveAngle = v; this._dirty = true; }
  // Curved lines also enable a radial "gravitational" layout in the worker.
  updateCurvedLines(v) {
    this.settings.curvedLines = v;
    this.worker?.postMessage({ type: 'updateSettings', settings: this.settings });
    this._dirty = true;
  }

  // Show/hide nodes (orphans toggle + name search) without resetting physics.
  // Hidden nodes scale out; the worker reflows only the visible subset gently.
  setVisibilityFilter({ showOrphans, searchQuery } = {}) {
    const q = (searchQuery || '').trim().toLowerCase();
    for (const node of this.nodes) {
      let vis = true;
      if (showOrphans === false && (this.adjMap.get(node.id)?.size || 0) === 0) vis = false;
      if (vis && q) vis = String(node.name || node.id || '').toLowerCase().includes(q);
      node._visible = vis;
    }
    const visibleIds = new Set(this.nodes.filter(n => n._visible !== false).map(n => n.id));
    const physNodes = this.nodes.filter(n => visibleIds.has(n.id));
    const physLinks = this.links.filter(l => visibleIds.has(l.source) && visibleIds.has(l.target));
    this.worker?.postMessage({
      type: 'setData',
      nodes: physNodes.map(n => ({ id: n.id, val: n.val, x: this.posMap.get(n.id)?.x || 0, y: this.posMap.get(n.id)?.y || 0 })),
      links: physLinks,
      settings: this.settings,
    });
    this._dirty = true;
  }

  // Recompute group colours only (no physics change).
  setGroups(groups) {
    this.settings.groups = groups;
    const gd = _toGraphData(this._rawData, this.settings, this.activeNoteId);
    const colorById = new Map(gd.nodes.map(n => [n.id, n.color]));
    for (const node of this.nodes) {
      const c = colorById.get(node.id);
      if (c) node.color = c;
    }
    this._dirty = true;
  }

  zoomToFit() {
    if (!this.viewport) return;
    const visible = this.nodes.filter(n => n._visible !== false);
    const pts = (visible.length ? visible : this.nodes)
      .map(n => this.posMap.get(n.id)).filter(Boolean);
    if (!pts.length) return;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX + 200;
    const h = maxY - minY + 200;
    const sw = this.container.clientWidth || 800;
    const sh = this.container.clientHeight || 600;
    const scale = Math.min(sw / w, sh / h, 2);
    const cx = this.container.clientWidth / 2;
    const cy = this.container.clientHeight / 2;
    // Set eased targets; the render loop animates the viewport into place.
    this._targetScale = scale;
    this._targetX = cx - ((minX + maxX) / 2) * scale;
    this._targetY = cy - ((minY + maxY) / 2) * scale;
    this._dirty = true;
  }

  destroy() {
    this.destroyed = true;
    this.worker?.postMessage({ type: 'stop' });
    this.worker?.terminate();
    this.app?.destroy(true, { children: true, texture: true, baseTexture: true });
  }

  // ─── Animation playback API ───────────────────────────────────────────────

  _initAnimationData() {
    const toMs = (v) => {
      if (!v) return 0;
      const n = Number(v);
      if (!isNaN(n) && n > 1e12) return n;
      const d = new Date(v).getTime();
      return isNaN(d) ? 0 : d;
    };
    const timed = [];
    const untimed = [];
    for (const n of this.nodes) {
      const t = toMs(n.created);
      if (t > 0) timed.push({ node: n, t });
      else untimed.push(n.id);
    }
    this._timedNodes = timed.sort((a, b) => a.t - b.t);
    this._untimedNodeIds = new Set(untimed);
    this._minCreated = this._timedNodes.length ? this._timedNodes[0].t : 0;
    this._maxCreated = this._timedNodes.length ? this._timedNodes[this._timedNodes.length - 1].t : 0;

    const nodeTime = new Map(this._timedNodes.map(s => [s.node.id, s.t]));
    this._lastRevealCount = -1;
    this._lastUntimedSize = -1;
    this._sortedEdges = this.links.map(l => {
      const st = nodeTime.get(String(l.source)) || 0;
      const tt = nodeTime.get(String(l.target)) || 0;
      return { link: l, t: Math.max(st, tt) };
    }).sort((a, b) => a.t - b.t);
  }

  startAnimation() {
    this._initAnimationData();
    this._isAnimating = true;
    this._animProgress = 0;
    this._animBaseProgress = 0;
    this._animSegmentStartReal = Date.now();
    this._animationTime = this._minCreated;
    this._applyAnimationVisibility();
    this._animationRaf = requestAnimationFrame(() => this._animationLoop());
    if (this._onAnimationTick) this._onAnimationTick(this._animationTime, this._visibleCount());
  }

  pauseAnimation() {
    if (!this._isAnimating) return;
    if (this._animationRaf) { cancelAnimationFrame(this._animationRaf); this._animationRaf = null; }
  }

  resumeAnimation() {
    if (!this._isAnimating) return;
    this._animSegmentStartReal = Date.now();
    if (this._animationRaf) { cancelAnimationFrame(this._animationRaf); }
    this._animationRaf = requestAnimationFrame(() => this._animationLoop());
  }

  resetAnimation() {
    if (!this._isAnimating) return;
    this.pauseAnimation();
    this._animProgress = 0;
    this._animBaseProgress = 0;
    this._animationTime = this._minCreated;
    this._lastRevealCount = -1;
    this._lastUntimedSize = -1;
    this._applyAnimationVisibility();
    if (this._onAnimationTick) this._onAnimationTick(this._animationTime, this._visibleCount());
  }

  seekAnimation(targetTime) {
    if (!this._isAnimating) return;
    const timeSpan = this._maxCreated - this._minCreated;
    if (timeSpan > 0) {
      this._animProgress = (targetTime - this._minCreated) / timeSpan;
    } else {
      this._animProgress = 1;
    }
    this._animationTime = Math.max(this._minCreated, Math.min(this._maxCreated, targetTime));
    this._animBaseProgress = this._animProgress;
    this._animSegmentStartReal = Date.now();
    this._applyAnimationVisibility();
    if (this._onAnimationTick) this._onAnimationTick(this._animationTime, this._visibleCount());
  }

  setAnimationSpeed(speed) {
    if (!this._isAnimating) return;
    const elapsed = Date.now() - this._animSegmentStartReal;
    this._animBaseProgress = Math.min(1, this._animBaseProgress + (elapsed * this._animationSpeed) / 10000);
    this._animSegmentStartReal = Date.now();
    this._animationSpeed = Math.max(0.1, Math.min(10, speed));
  }

  stopAnimation() {
    this._isAnimating = false;
    if (this._animationRaf) { cancelAnimationFrame(this._animationRaf); this._animationRaf = null; }
    // Restore normal visibility (all nodes that pass current filter)
    for (const node of this.nodes) node._visible = true;
    this._dirty = true;
    this._lastRevealCount = -1;
    this._lastUntimedSize = -1;
    if (this._onAnimationEnd) this._onAnimationEnd();
  }

  _visibleCount() {
    return this.nodes.filter(n => n._visible !== false).length;
  }

  _animationLoop() {
    if (!this._isAnimating || this.destroyed) return;
    const elapsed = Date.now() - this._animSegmentStartReal;
    const duration = 10000;
    this._animProgress = Math.min(1, this._animBaseProgress + (elapsed * this._animationSpeed) / duration);
    const timeSpan = this._maxCreated - this._minCreated;
    this._animationTime = timeSpan > 0 ? this._minCreated + this._animProgress * timeSpan : this._maxCreated;

    if (this._animProgress >= 1) {
      this._applyAnimationVisibility();
      if (this._onAnimationTick) this._onAnimationTick(this._animationTime, this._visibleCount());
      this.pauseAnimation();
      if (this._onAnimationEnd) this._onAnimationEnd();
      return;
    }

    this._applyAnimationVisibility();
    if (this._onAnimationTick) this._onAnimationTick(this._animationTime, this._visibleCount());
    this._animationRaf = requestAnimationFrame(() => this._animationLoop());
  }

  _applyAnimationVisibility() {
    const totalTimed = this._timedNodes.length;
    const revealCount = totalTimed > 0 ? Math.max(0, Math.ceil(this._animProgress * totalTimed)) : 0;

    // Skip redundant heavy updates during scrubbing / animation
    if (this._lastRevealCount === revealCount && this._lastUntimedSize === this._untimedNodeIds.size) {
      return;
    }
    this._lastRevealCount = revealCount;
    this._lastUntimedSize = this._untimedNodeIds.size;

    const visibleNodeIds = new Set(this._untimedNodeIds);
    for (let i = 0; i < revealCount; i++) {
      visibleNodeIds.add(this._timedNodes[i].node.id);
    }

    const visibleEdges = this._sortedEdges.filter(e =>
      visibleNodeIds.has(String(e.link.source)) && visibleNodeIds.has(String(e.link.target))
    );

    for (const node of this.nodes) {
      node._visible = visibleNodeIds.has(node.id);
    }

    const physNodes = this.nodes.filter(n => n._visible !== false).map(n => ({
      id: n.id, val: n.val, x: this.posMap.get(n.id)?.x || 0, y: this.posMap.get(n.id)?.y || 0
    }));
    const physLinks = visibleEdges.map(e => e.link);
    this.worker?.postMessage({
      type: 'setData',
      nodes: physNodes,
      links: physLinks,
      settings: this.settings,
    });
    this._dirty = true;
  }
}

// ─── Factory exports (same API as old forceGraphRenderer.js) ───────────────

export function createMainGraph(container, data, settings) {
  if (!window.PIXI) {
    setTimeout(() => createMainGraph(container, data, settings), 100);
    return null;
  }
  const s = getComputedStyle(document.documentElement);
  settings = {
    ...settings,
    bg: s.getPropertyValue('--bg').trim() || '#282c34',
    fg: s.getPropertyValue('--fg').trim() || '#abb2bf',
    accentColor: _getAccentColor(),
    nodeColor: s.getPropertyValue('--fg-muted').trim() || '#5c6370',
  };
  const engine = new GraphEngine(container, data, settings);
  return {
    graph: engine,
    updateData: (d) => engine.updateData(d),
    updateSettings: (s) => engine.updateSettings(s),
    updateNodeSize: (v) => engine.updateNodeSize(v),
    updateLinkThickness: (v) => engine.updateLinkThickness(v),
    updateArrows: (v) => engine.updateArrows(v),
    updateCurvedLines: (v) => engine.updateCurvedLines(v),
    updateCurveAngle: (v) => engine.updateCurveAngle(v),
    setVisibilityFilter: (o) => engine.setVisibilityFilter(o),
    setGroups: (g) => engine.setGroups(g),
    zoomToFit: () => engine.zoomToFit(),
    destroy: () => engine.destroy(),
    // Animation API
    startAnimation: () => engine.startAnimation(),
    pauseAnimation: () => engine.pauseAnimation(),
    resumeAnimation: () => engine.resumeAnimation(),
    resetAnimation: () => engine.resetAnimation(),
    seekAnimation: (t) => engine.seekAnimation(t),
    setAnimationSpeed: (s) => engine.setAnimationSpeed(s),
    stopAnimation: () => engine.stopAnimation(),
    get isAnimating() { return engine._isAnimating; },
    get animationTime() { return engine._animationTime; },
    get minCreated() { return engine._minCreated; },
    get maxCreated() { return engine._maxCreated; },
    set onAnimationTick(fn) { engine._onAnimationTick = fn; },
    set onAnimationEnd(fn) { engine._onAnimationEnd = fn; },
  };
}

export function createLocalGraph(container, data, activeNoteId, settings) {
  if (!window.PIXI) {
    setTimeout(() => createLocalGraph(container, data, activeNoteId, settings), 100);
    return null;
  }
  const s = getComputedStyle(document.documentElement);
  settings = {
    ...settings,
    bg: s.getPropertyValue('--bg').trim() || '#282c34',
    fg: s.getPropertyValue('--fg').trim() || '#abb2bf',
    accentColor: _getAccentColor(),
    nodeColor: s.getPropertyValue('--fg-muted').trim() || '#5c6370',
  };
  const engine = new GraphEngine(container, data, settings, true, activeNoteId);
  return {
    graph: engine,
    updateData: (d) => engine.updateData(d),
    updateSettings: (s) => engine.updateSettings(s),
    updateNodeSize: (v) => engine.updateNodeSize(v),
    updateLinkThickness: (v) => engine.updateLinkThickness(v),
    updateArrows: (v) => engine.updateArrows(v),
    updateCurvedLines: (v) => engine.updateCurvedLines(v),
    updateCurveAngle: (v) => engine.updateCurveAngle(v),
    setVisibilityFilter: (o) => engine.setVisibilityFilter(o),
    setGroups: (g) => engine.setGroups(g),
    zoomToFit: () => engine.zoomToFit(),
    destroy: () => engine.destroy(),
    // Animation API
    startAnimation: () => engine.startAnimation(),
    pauseAnimation: () => engine.pauseAnimation(),
    resumeAnimation: () => engine.resumeAnimation(),
    resetAnimation: () => engine.resetAnimation(),
    seekAnimation: (t) => engine.seekAnimation(t),
    setAnimationSpeed: (s) => engine.setAnimationSpeed(s),
    stopAnimation: () => engine.stopAnimation(),
    get isAnimating() { return engine._isAnimating; },
    get animationTime() { return engine._animationTime; },
    get minCreated() { return engine._minCreated; },
    get maxCreated() { return engine._maxCreated; },
    set onAnimationTick(fn) { engine._onAnimationTick = fn; },
    set onAnimationEnd(fn) { engine._onAnimationEnd = fn; },
  };
}
