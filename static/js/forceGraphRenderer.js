/**
 * Force Graph Renderer — WebGL-based graph rendering using force-graph library.
 * Replaces vis-network for GPU-accelerated performance.
 */

let _hoverNodeId = null;
let _tooltipEl = null;
let _settingsPanelHovered = false;

export function setSettingsPanelHover(val) { _settingsPanelHovered = val; }
export function clearGraphHover() {
  _hoverNodeId = null;
  if (_tooltipEl) _tooltipEl.classList.remove('visible');
}

function _waitForLibs(callback) {
  if (window.ForceGraph && window.d3) {
    callback();
    return;
  }
  const interval = setInterval(() => {
    if (window.ForceGraph && window.d3) {
      clearInterval(interval);
      callback();
    }
  }, 100);
}

function _getAccentColor() {
  const el = document.createElement('div');
  el.style.color = 'var(--accent, var(--color-accent, #00aaff))';
  el.style.position = 'absolute';
  el.style.visibility = 'hidden';
  document.body.appendChild(el);
  const color = getComputedStyle(el).color;
  document.body.removeChild(el);
  return color || '#00aaff';
}

function _setInitialView(graph) {
  // Center at origin (where center force pulls) with a moderate zoom, no animation
  graph.centerAt(0, 0, 0);
  graph.zoom(0.25, 0);
}

function _resolveLink(link, nodes) {
  const source = typeof link.source === 'object' ? link.source : nodes.find(n => n.id === link.source);
  const target = typeof link.target === 'object' ? link.target : nodes.find(n => n.id === link.target);
  return { source, target };
}

function _buildAdjMap(nodes, edges) {
  const adjMap = new Map();
  for (const n of nodes) adjMap.set(String(n.id), new Set());
  for (const e of edges) {
    const from = String(e.from);
    const to = String(e.to);
    adjMap.get(from)?.add(to);
    adjMap.get(to)?.add(from);
  }
  return adjMap;
}

function _computeNodeDegrees(nodes, edges) {
  const deg = new Map();
  for (const n of nodes) deg.set(String(n.id), 0);
  for (const e of edges) {
    const from = String(e.from);
    const to = String(e.to);
    deg.set(from, (deg.get(from) || 0) + 1);
    deg.set(to, (deg.get(to) || 0) + 1);
  }
  return deg;
}

function _nodeMatchesGroup(node, query) {
  if (!query) return false;
  const q = query.toLowerCase().trim();
  if (!q) return false;
  if (q.startsWith('tag:')) {
    const tagQuery = q.slice(4).trim().replace(/^#/, '');
    const tags = (node.tags || []);
    return tags.some(t => String(t).toLowerCase().replace(/^#/, '').includes(tagQuery));
  }
  const name = String(node.label || node.title || node.name || node.id || '').toLowerCase();
  const path = String(node.rel_path || node.path || '').toLowerCase();
  return name.includes(q) || path.includes(q);
}

function _resolveGroupColor(node, groups) {
  if (!groups || !groups.length) return null;
  for (const g of groups) {
    if (g.query && _nodeMatchesGroup(node, g.query)) {
      return g.color || '#00aaff';
    }
  }
  return null;
}

function _toGraphData(data, settings, activeNoteId) {
  const safeNodes = (data.nodes || [])
    .filter(n => n.id != null && String(n.id).length > 0)
    .map(n => ({ ...n, id: String(n.id) }));
  const nodeIdSet = new Set(safeNodes.map(n => n.id));
  const safeEdges = (data.edges || []).filter(e => {
    const from = e.from != null ? String(e.from) : '';
    const to = e.to != null ? String(e.to) : '';
    return nodeIdSet.has(from) && nodeIdSet.has(to);
  });

  const degrees = _computeNodeDegrees(safeNodes, safeEdges);
  const maxDegree = Math.max(1, ...degrees.values());
  const baseVal = 8 * settings.nodeSize;

  return {
    nodes: safeNodes.map(n => {
      const degree = degrees.get(n.id) || 0;
      const scale = Math.min(2.5, 1 + Math.sqrt(degree / maxDegree) * 3); // 1x to 2.5x, sqrt for better differentiation
      const groupColor = _resolveGroupColor(n, settings.groups);
      return {
        id: n.id,
        name: n.label || n.id,
        val: baseVal * scale,
        color: n.id === activeNoteId ? (settings.accentColor || '#00aaff') : (groupColor || n.color?.background || settings.nodeColor || '#5c6370'),
        x: (activeNoteId && n.id === activeNoteId) ? 0 : n.x,
        y: (activeNoteId && n.id === activeNoteId) ? 0 : n.y,
      };
    }),
    links: safeEdges.map(e => ({
      source: String(e.from),
      target: String(e.to),
    })),
  };
}

function _createTooltip(container) {
  if (_tooltipEl) _tooltipEl.remove();
  _tooltipEl = document.createElement('div');
  _tooltipEl.className = 'vault-graph-tooltip';
  container.appendChild(_tooltipEl);
}

let _lastPerfLog = 0;
function _buildNodeCanvasObject(adjMap, fg, settings) {
  return (node, ctx, globalScale) => {
    const isHovered = !_settingsPanelHovered && node.id === _hoverNodeId;
    const neighbors = adjMap.get(node.id) || new Set();
    const isNeighbor = _hoverNodeId && !_settingsPanelHovered && neighbors.has(_hoverNodeId);
    const isDimmed = _hoverNodeId && !_settingsPanelHovered && !isHovered && !isNeighbor;

    const minScreenSize = 1.5 / globalScale;
    const size = Math.max(isHovered ? node.val * 1.1 : node.val, minScreenSize);
    const color = isDimmed ? 'rgba(92, 99, 112, 0.35)' : (isHovered ? (settings.accentColor || '#00aaff') : node.color);
    const opacity = isDimmed ? 0.35 : 1;

    ctx.beginPath();
    ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity;
    ctx.fill();
    ctx.globalAlpha = 1;

    if (globalScale >= 0.4) {
      ctx.font = `12px "Fira Code", monospace`;
      ctx.fillStyle = isDimmed ? 'rgba(171,178,191,0.45)' : fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.name, node.x, node.y + size + 12);
    }
  };
}

function _buildNodePointerAreaPaint(settings) {
  return (node, color, ctx, globalScale) => {
    const minScreenSize = 1.5 / globalScale;
    const size = Math.max(node.val, minScreenSize) + 2;
    ctx.beginPath();
    ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);
    ctx.fillStyle = color;
    ctx.fill();
  };
}

function _buildLinkCanvasObject(settings, nodes, accentColor) {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  return (link, ctx, globalScale) => {
    const source = typeof link.source === 'object' ? link.source : nodeMap.get(link.source);
    const target = typeof link.target === 'object' ? link.target : nodeMap.get(link.target);
    if (!source || !target) return;

    const isHovered = !_settingsPanelHovered && (source.id === _hoverNodeId || target.id === _hoverNodeId);
    const color = isHovered ? accentColor : '#5c6370';
    const opacity = isHovered ? 1.0 : (_hoverNodeId && !_settingsPanelHovered) ? 0.05 : 0.6;

    ctx.beginPath();
    if (settings.curvedLines) {
      const midX = (source.x + target.x) / 2;
      const midY = (source.y + target.y) / 2;
      const angle = Math.atan2(target.y - source.y, target.x - source.x);
      const perp = angle + Math.PI / 2;
      const curve = settings.curveAngle || 0.5;
      const dist = Math.hypot(target.x - source.x, target.y - source.y) * curve;
      const cpX = midX + Math.cos(perp) * dist;
      const cpY = midY + Math.sin(perp) * dist;
      ctx.moveTo(source.x, source.y);
      ctx.quadraticCurveTo(cpX, cpY, target.x, target.y);
    } else {
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = settings.linkThickness;
    ctx.globalAlpha = opacity;
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (settings.arrows) {
      let angle;
      if (settings.curvedLines) {
        const midX = (source.x + target.x) / 2;
        const midY = (source.y + target.y) / 2;
        const baseAngle = Math.atan2(target.y - source.y, target.x - source.x);
        const perp = baseAngle + Math.PI / 2;
        const curve = settings.curveAngle || 0.5;
        const dist = Math.hypot(target.x - source.x, target.y - source.y) * curve;
        const cpX = midX + Math.cos(perp) * dist;
        const cpY = midY + Math.sin(perp) * dist;
        angle = Math.atan2(target.y - cpY, target.x - cpX);
      } else {
        angle = Math.atan2(target.y - source.y, target.x - source.x);
      }
      const arrowSize = 5;
      ctx.beginPath();
      ctx.moveTo(target.x, target.y);
      ctx.lineTo(
        target.x - arrowSize * Math.cos(angle - Math.PI / 6),
        target.y - arrowSize * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(
        target.x - arrowSize * Math.cos(angle + Math.PI / 6),
        target.y - arrowSize * Math.sin(angle + Math.PI / 6)
      );
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
  };
}

function _computeDynamicLinkDistances(nodes, edges, baseDistance) {
  const adj = new Map();
  for (const n of nodes) adj.set(String(n.id), new Set());
  for (const e of edges) {
    adj.get(String(e.from))?.add(String(e.to));
    adj.get(String(e.to))?.add(String(e.from));
  }
  return edges.map(e => {
    const from = String(e.from);
    const to = String(e.to);
    const a = adj.get(from);
    const b = adj.get(to);
    if (!a || !b) return { source: from, target: to, distance: baseDistance };
    let common = 0;
    for (const nb of a) if (b.has(nb)) common++;
    // Dense clusters = shorter links, sparse bridges = longer links
    const scale = Math.max(0.6, 1.6 - common * 0.15);
    return { source: from, target: to, distance: Math.round(baseDistance * scale) };
  });
}

function _configureForces(graph, settings) {
  if (!window.d3) return;

  // UI repel 0-20 maps to internal -(val*500)
  const repelStrength = settings.repelForce >= 0 ? -(settings.repelForce * 500) : settings.repelForce;
  graph.d3Force('charge', window.d3.forceManyBody().strength(repelStrength));
  graph.d3Force('center', null);
  graph.d3Force('x', window.d3.forceX(0).strength(settings.centreForce));
  graph.d3Force('y', window.d3.forceY(0).strength(settings.centreForce));

  // Only update the existing link force's parameters — never replace the force
  // object itself, because force-graph's internal linkMethod will try to
  // re-initialize it with the graph's current links and can hit
  // "node not found: undefined" if source/target values are in flux.
  const linkForce = graph.d3Force('link');
  if (linkForce) {
    linkForce.distance(d => d.distance || settings.linkDistance)
           .strength(settings.linkForce);
  }

  graph.d3AlphaDecay(0.08);
}

/**
 * Create main graph instance.
 * @param {HTMLElement} container - Container element for the graph
 * @param {Object} data - Graph data with nodes and edges
 * @param {Object} settings - Graph settings (forces, display options)
 * @returns {Object} Graph instance with control API
 */
export function createMainGraph(container, data, settings) {
  if (!window.ForceGraph || !window.d3) {
    _waitForLibs(() => createMainGraph(container, data, settings));
    return null;
  }

  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue('--bg').trim() || '#282c34';
  const fg = style.getPropertyValue('--fg').trim() || '#abb2bf';
  const accentColor = _getAccentColor();
  const mutedColor = style.getPropertyValue('--fg-muted').trim() || '#5c6370';
  settings = { ...settings, nodeColor: mutedColor, accentColor };

  const adjMap = _buildAdjMap(data.nodes, data.edges);
  const graphData = _toGraphData(data, settings);
  _createTooltip(container);

  let graph;
  try {
    graph = window.ForceGraph()(container)
      .graphData(graphData)
      .backgroundColor(bg)
      .nodeCanvasObjectMode(() => 'replace')
      .nodeCanvasObject(_buildNodeCanvasObject(adjMap, fg, settings))
      .linkCanvasObjectMode(() => 'replace')
      .linkCanvasObject(_buildLinkCanvasObject(settings, graphData.nodes, accentColor))
      .onNodeHover(node => {
        const t0 = performance.now();
        const nextId = node ? node.id : null;
        if (_hoverNodeId === nextId) return;
        _hoverNodeId = nextId;
        container.classList.toggle('graph-node-hover', !!node);
        const t1 = performance.now();
        if (t1 - t0 > 5) console.log(`[perf] onNodeHover took ${Math.round(t1 - t0)}ms`);
        if (_tooltipEl) {
          if (node) {
            _tooltipEl.textContent = node.name;
            _tooltipEl.classList.add('visible');
          } else {
            _tooltipEl.classList.remove('visible');
          }
        }
      })
      .onNodeDrag(node => {
        if (node) _hoverNodeId = node.id;
      })
      .onNodeClick(node => {
        if (node) {
          window.dispatchEvent(new CustomEvent('odysseus-vault-select-note', { detail: { id: node.id } }));
        }
      })
      .onNodeRightClick(node => {
        if (node) {
          const connected = adjMap.get(node.id) || new Set();
          const newNodes = graphData.nodes.filter(n => n.id === node.id || connected.has(n.id));
          const newNodeIds = new Set(newNodes.map(n => n.id));
          const newLinks = data.edges
            .filter(e => newNodeIds.has(String(e.from)) && newNodeIds.has(String(e.to)))
            .map(e => ({ source: String(e.from), target: String(e.to) }));
          graph.graphData({ nodes: newNodes, links: newLinks });
        }
      })
      .onBackgroundClick(() => {
        const current = graph.graphData();
        if (current.nodes.length < graphData.nodes.length) {
          graph.graphData(graphData);
        }
      });
  } catch (err) {
    console.error('[force-graph] Failed to initialize graph:', err.message, err);
    container.innerHTML = `<div class="vault-graph-error">Graph error: ${err.message}</div>`;
    return null;
  }

  try {
    _configureForces(graph, settings);
  } catch (err) {
    console.error('[force-graph] Failed to configure forces:', err.message, err);
  }

  graph.enableZoomInteraction(true);
  graph.enablePanInteraction(true);
  graph.onNodeDrag(() => graph.d3ReheatSimulation());
  graph.nodePointerAreaPaint(_buildNodePointerAreaPaint(settings));
  graph.onEngineStop(() => console.log('[force-graph] simulation stopped'));

  // Let the simulation spread nodes before first render, then stop quickly
  graph.warmupTicks(50);
  graph.cooldownTicks(0);
  graph.cooldownTime(0);

  let _lastMouseMove = 0;
  container.addEventListener('mousemove', () => {
    const now = performance.now();
    const delta = now - _lastMouseMove;
    _lastMouseMove = now;
    if (delta > 50) {
      console.log(`[perf] mousemove interval: ${Math.round(delta)}ms (jank detected)`);
    }
  });

  container.addEventListener('mouseleave', () => {
    if (_hoverNodeId !== null) {
      _hoverNodeId = null;
      container.classList.remove('graph-node-hover');
      if (_tooltipEl) _tooltipEl.classList.remove('visible');
    }
  });

  _setInitialView(graph);

  return {
    graph,
    updateData: (newData) => {
      const current = graph.graphData();
      const posMap = new Map();
      current.nodes.forEach(n => {
        if (n.x != null && n.y != null) posMap.set(n.id, { x: n.x, y: n.y, vx: n.vx || 0, vy: n.vy || 0 });
      });
      const newGraphData = _toGraphData(newData, settings);
      newGraphData.nodes.forEach(n => {
        const p = posMap.get(n.id);
        if (p) { n.x = p.x; n.y = p.y; n.vx = p.vx; n.vy = p.vy; }
      });
      graph.graphData(newGraphData);
    },
    updateSettings: (newSettings) => {
      _configureForces(graph, newSettings);
      // Removed d3ReheatSimulation: slider tweaks should not restart physics
    },
    updateNodeSize: (size) => {
      const ratio = size / settings.nodeSize;
      const current = graph.graphData();
      current.nodes.forEach(n => { n.val *= ratio; });
      settings.nodeSize = size;
      graph.graphData(current);
    },
    updateLinkThickness: (thickness) => {
      settings.linkThickness = thickness;
      graph.graphData(graph.graphData());
    },
    updateArrows: (showArrows) => {
      settings.arrows = showArrows;
      graph.graphData(graph.graphData());
    },
    updateCurvedLines: (curved) => {
      settings.curvedLines = curved;
      graph.graphData(graph.graphData());
    },
    updateCurveAngle: (angle) => {
      settings.curveAngle = angle;
      graph.graphData(graph.graphData());
    },
    zoomToFit: () => graph.zoomToFit(600),
    destroy: () => {
      graph._destructor();
      if (_tooltipEl) {
        _tooltipEl.remove();
        _tooltipEl = null;
      }
    },
  };
}

/**
 * Create local graph instance.
 * @param {HTMLElement} container - Container element for the graph
 * @param {Object} data - Graph data with nodes and edges
 * @param {string} activeNoteId - ID of the center note
 * @param {Object} settings - Graph settings (forces, display options)
 * @returns {Object} Graph instance with control API
 */
export function createLocalGraph(container, data, activeNoteId, settings) {
  if (!window.ForceGraph || !window.d3) {
    _waitForLibs(() => createLocalGraph(container, data, activeNoteId, settings));
    return null;
  }

  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue('--bg').trim() || '#282c34';
  const fg = style.getPropertyValue('--fg').trim() || '#abb2bf';
  const accentColor = _getAccentColor();
  const mutedColor = style.getPropertyValue('--fg-muted').trim() || '#5c6370';
  settings = { ...settings, nodeColor: mutedColor, accentColor };

  const adjMap = _buildAdjMap(data.nodes, data.edges);
  const graphData = _toGraphData(data, settings, activeNoteId);
  _createTooltip(container);

  let graph;
  try {
    graph = window.ForceGraph()(container)
      .graphData(graphData)
      .backgroundColor(bg)
      .nodeCanvasObjectMode(() => 'replace')
      .nodeCanvasObject(_buildNodeCanvasObject(adjMap, fg, settings))
      .linkCanvasObjectMode(() => 'replace')
      .linkCanvasObject(_buildLinkCanvasObject(settings, graphData.nodes, accentColor))
      .onNodeHover(node => {
        const t0 = performance.now();
        const nextId = node ? node.id : null;
        if (_hoverNodeId === nextId) return;
        _hoverNodeId = nextId;
        container.classList.toggle('graph-node-hover', !!node);
        const t1 = performance.now();
        if (t1 - t0 > 5) console.log(`[perf] onNodeHover took ${Math.round(t1 - t0)}ms`);
        if (_tooltipEl) {
          if (node) {
            _tooltipEl.textContent = node.name;
            _tooltipEl.classList.add('visible');
          } else {
            _tooltipEl.classList.remove('visible');
          }
        }
      })
      .onNodeDrag(node => {
        if (node) _hoverNodeId = node.id;
      })
      .onNodeClick(node => {
        if (node) {
          window.dispatchEvent(new CustomEvent('odysseus-vault-select-note', { detail: { id: node.id } }));
        }
      })
      .onNodeRightClick(node => {
        if (node) {
          const connected = adjMap.get(node.id) || new Set();
          const newNodes = graphData.nodes.filter(n => n.id === node.id || connected.has(n.id));
          const newNodeIds = new Set(newNodes.map(n => n.id));
          const newLinks = data.edges
            .filter(e => newNodeIds.has(String(e.from)) && newNodeIds.has(String(e.to)))
            .map(e => ({ source: String(e.from), target: String(e.to) }));
          graph.graphData({ nodes: newNodes, links: newLinks });
        }
      })
      .onBackgroundClick(() => {
        const current = graph.graphData();
        if (current.nodes.length < graphData.nodes.length) {
          graph.graphData(graphData);
        }
      });
  } catch (err) {
    console.error('[force-graph] Failed to initialize local graph:', err.message, err);
    container.innerHTML = `<div class="vault-graph-error">Graph error: ${err.message}</div>`;
    return null;
  }

  try {
    _configureForces(graph, settings);
  } catch (err) {
    console.error('[force-graph] Failed to configure local forces:', err.message, err);
  }

  graph.enableZoomInteraction(true);
  graph.enablePanInteraction(true);
  graph.onNodeDrag(() => graph.d3ReheatSimulation());
  graph.nodePointerAreaPaint(_buildNodePointerAreaPaint(settings));
  graph.onEngineStop(() => console.log('[force-graph] simulation stopped'));

  graph.warmupTicks(50);
  graph.cooldownTicks(0);
  graph.cooldownTime(0);

  let _lastMouseMove = 0;
  container.addEventListener('mousemove', () => {
    const now = performance.now();
    const delta = now - _lastMouseMove;
    _lastMouseMove = now;
    if (delta > 50) {
      console.log(`[perf] mousemove interval: ${Math.round(delta)}ms (jank detected)`);
    }
  });

  container.addEventListener('mouseleave', () => {
    if (_hoverNodeId !== null) {
      _hoverNodeId = null;
      container.classList.remove('graph-node-hover');
      if (_tooltipEl) _tooltipEl.classList.remove('visible');
    }
  });

  _setInitialView(graph);

  return {
    graph,
    updateData: (newData) => {
      const current = graph.graphData();
      const posMap = new Map();
      current.nodes.forEach(n => {
        if (n.x != null && n.y != null) posMap.set(n.id, { x: n.x, y: n.y, vx: n.vx || 0, vy: n.vy || 0 });
      });
      const newGraphData = _toGraphData(newData, settings, activeNoteId);
      newGraphData.nodes.forEach(n => {
        const p = posMap.get(n.id);
        if (p) { n.x = p.x; n.y = p.y; n.vx = p.vx; n.vy = p.vy; }
      });
      graph.graphData(newGraphData);
    },
    updateSettings: (newSettings) => {
      _configureForces(graph, newSettings);
    },
    updateNodeSize: (size) => {
      const ratio = size / settings.nodeSize;
      const current = graph.graphData();
      current.nodes.forEach(n => { n.val *= ratio; });
      settings.nodeSize = size;
      graph.graphData(current);
    },
    updateLinkThickness: (thickness) => {
      settings.linkThickness = thickness;
      graph.graphData(graph.graphData());
    },
    updateArrows: (showArrows) => {
      settings.arrows = showArrows;
      graph.graphData(graph.graphData());
    },
    updateCurvedLines: (curved) => {
      settings.curvedLines = curved;
      graph.graphData(graph.graphData());
    },
    updateCurveAngle: (angle) => {
      settings.curveAngle = angle;
      graph.graphData(graph.graphData());
    },
    zoomToFit: () => graph.zoomToFit(600),
    destroy: () => {
      graph._destructor();
      if (_tooltipEl) {
        _tooltipEl.remove();
        _tooltipEl = null;
      }
    },
  };
}
