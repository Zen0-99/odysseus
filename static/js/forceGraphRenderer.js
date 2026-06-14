/**
 * Force Graph Renderer — WebGL-based graph rendering using force-graph library.
 * Replaces vis-network for GPU-accelerated performance.
 */

let _hoverNodeId = null;
let _tooltipEl = null;

/**
 * Create main graph instance.
 * @param {HTMLElement} container - Container element for the graph
 * @param {Object} data - Graph data with nodes and edges
 * @param {Object} settings - Graph settings (forces, display options)
 * @returns {Object} Graph instance with control API
 */
export function createMainGraph(container, data, settings) {
  if (!window.ForceGraph) {
    console.error('[force-graph] ForceGraph library not loaded');
    return null;
  }

  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue('--bg').trim() || '#282c34';
  const fg = style.getPropertyValue('--fg').trim() || '#abb2bf';
  const border = style.getPropertyValue('--border').trim() || '#3e4451';
  const accentColor = '#00aaff';

  // Build adjacency map for hover neighbor detection
  const adjMap = new Map();
  for (const n of data.nodes) adjMap.set(n.id, new Set());
  for (const e of data.edges) {
    adjMap.get(e.from)?.add(e.to);
    adjMap.get(e.to)?.add(e.from);
  }

  // Convert vis-network format to force-graph format
  const graphData = {
    nodes: data.nodes.map(n => ({
      id: n.id,
      name: n.label || n.id,
      val: (n.value || 1) * settings.nodeSize,
      color: n.color?.background || '#5c6370',
      x: n.x,
      y: n.y,
    })),
    links: data.edges.map(e => ({
      source: e.from,
      target: e.to,
    })),
  };

  // Create tooltip element
  if (_tooltipEl) _tooltipEl.remove();
  _tooltipEl = document.createElement('div');
  _tooltipEl.className = 'shard-graph-tooltip';
  container.appendChild(_tooltipEl);

  // Create force-graph instance
  const graph = window.ForceGraph()(container)
    .graphData(graphData)
    .backgroundColor(bg)
    .nodeCanvasObject((node, ctx, globalScale) => {
      const isHovered = node.id === _hoverNodeId;
      const neighbors = adjMap.get(node.id) || new Set();
      const isNeighbor = _hoverNodeId && neighbors.has(_hoverNodeId);
      const isDimmed = _hoverNodeId && !isHovered && !isNeighbor;

      const size = isHovered ? node.val * 1.5 : node.val;
      const color = isDimmed ? 'rgba(92, 99, 112, 0.15)' : node.color;
      const opacity = isDimmed ? 0.15 : 1;

      ctx.beginPath();
      ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);
      ctx.fillStyle = color;
      ctx.globalAlpha = opacity;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Draw label if zoomed in enough
      if (globalScale >= 0.4) {
        ctx.font = `12px "Fira Code", monospace`;
        ctx.fillStyle = fg;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.name, node.x, node.y + size + 12);
      }
    })
    .linkCanvasObject((link, ctx, globalScale) => {
      const isHovered = link.source.id === _hoverNodeId || link.target.id === _hoverNodeId;
      const color = isHovered ? accentColor : '#5c6370';
      const opacity = isHovered ? 0.9 : _hoverNodeId ? 0.1 : 0.85;

      ctx.beginPath();
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(link.target.x, link.target.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = settings.linkThickness;
      ctx.globalAlpha = opacity;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Draw arrows if enabled
      if (settings.arrows) {
        const angle = Math.atan2(link.target.y - link.source.y, link.target.x - link.source.x);
        const arrowSize = 5;
        ctx.beginPath();
        ctx.moveTo(link.target.x, link.target.y);
        ctx.lineTo(
          link.target.x - arrowSize * Math.cos(angle - Math.PI / 6),
          link.target.y - arrowSize * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          link.target.x - arrowSize * Math.cos(angle + Math.PI / 6),
          link.target.y - arrowSize * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }
    })
    .onNodeHover(node => {
      _hoverNodeId = node ? node.id : null;
      if (_tooltipEl) {
        if (node) {
          _tooltipEl.textContent = node.name;
          _tooltipEl.classList.add('visible');
        } else {
          _tooltipEl.classList.remove('visible');
        }
      }
    })
    .onNodeClick(node => {
      if (node) {
        window.dispatchEvent(new CustomEvent('odysseus-shard-select-note', { detail: { id: node.id } }));
      }
    })
    .onNodeRightClick(node => {
      if (node) {
        // Isolate neighbors on double-click
        const connected = adjMap.get(node.id) || new Set();
        const newNodes = graphData.nodes.filter(n => n.id === node.id || connected.has(n.id));
        graph.graphData({ nodes: newNodes, links: graphData.links });
      }
    })
    .onBackgroundClick(() => {
      // Reset to full graph
      graph.graphData(graphData);
    })
    .d3Force('charge', d3 => d3.forceManyBody().strength(settings.repelForce))
    .d3Force('center', d3 => d3.forceCenter().strength(settings.centreForce))
    .d3Force('link', d3 => d3.forceLink().distance(settings.linkDistance).strength(settings.linkForce));

  // Zoom configuration
  graph.enableZoomInteraction(true);
  graph.enablePanInteraction(true);

  // Initial fit
  setTimeout(() => {
    graph.zoomToFit(400);
  }, 100);

  // Cooldown simulation after initial stabilization
  setTimeout(() => {
    graph.cooldownTicks(0);
  }, 3000);

  // Return control API
  return {
    graph,
    updateData: (newData) => {
      const newGraphData = {
        nodes: newData.nodes.map(n => ({
          id: n.id,
          name: n.label || n.id,
          val: (n.value || 1) * settings.nodeSize,
          color: n.color?.background || '#5c6370',
          x: n.x,
          y: n.y,
        })),
        links: newData.edges.map(e => ({
          source: e.from,
          target: e.to,
        })),
      };
      graph.graphData(newGraphData);
    },
    updateSettings: (newSettings) => {
      graph
        .d3Force('charge', d3 => d3.forceManyBody().strength(newSettings.repelForce))
        .d3Force('center', d3 => d3.forceCenter().strength(newSettings.centreForce))
        .d3Force('link', d3 => d3.forceLink().distance(newSettings.linkDistance).strength(newSettings.linkForce));
      graph.d3ReheatSimulation(1000);
      setTimeout(() => graph.cooldownTicks(0), 1000);
    },
    updateNodeSize: (size) => {
      graphData.nodes.forEach(n => n.val = (n.val / settings.nodeSize) * size);
      settings.nodeSize = size;
      graph.graphData(graphData);
    },
    updateLinkThickness: (thickness) => {
      settings.linkThickness = thickness;
    },
    updateArrows: (showArrows) => {
      settings.arrows = showArrows;
    },
    zoomToFit: () => graph.zoomToFit(400),
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
  if (!window.ForceGraph) {
    console.error('[force-graph] ForceGraph library not loaded');
    return null;
  }

  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue('--bg').trim() || '#282c34';
  const fg = style.getPropertyValue('--fg').trim() || '#abb2bf';
  const accentColor = '#00aaff';

  // Build adjacency map
  const adjMap = new Map();
  for (const n of data.nodes) adjMap.set(n.id, new Set());
  for (const e of data.edges) {
    adjMap.get(e.from)?.add(e.to);
    adjMap.get(e.to)?.add(e.from);
  }

  // Convert to force-graph format
  const graphData = {
    nodes: data.nodes.map(n => ({
      id: n.id,
      name: n.label || n.id,
      val: (n.value || 1) * settings.nodeSize,
      color: n.id === activeNoteId ? '#4dabf7' : (n.color?.background || '#5c6370'),
      x: n.id === activeNoteId ? 0 : n.x,
      y: n.id === activeNoteId ? 0 : n.y,
    })),
    links: data.edges.map(e => ({
      source: e.from,
      target: e.to,
    })),
  };

  // Create tooltip
  if (_tooltipEl) _tooltipEl.remove();
  _tooltipEl = document.createElement('div');
  _tooltipEl.className = 'shard-graph-tooltip';
  container.appendChild(_tooltipEl);

  const graph = window.ForceGraph()(container)
    .graphData(graphData)
    .backgroundColor(bg)
    .nodeCanvasObject((node, ctx, globalScale) => {
      const isHovered = node.id === _hoverNodeId;
      const neighbors = adjMap.get(node.id) || new Set();
      const isNeighbor = _hoverNodeId && neighbors.has(_hoverNodeId);
      const isDimmed = _hoverNodeId && !isHovered && !isNeighbor;

      const size = isHovered ? node.val * 1.5 : node.val;
      const color = isDimmed ? 'rgba(92, 99, 112, 0.15)' : node.color;
      const opacity = isDimmed ? 0.15 : 1;

      ctx.beginPath();
      ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);
      ctx.fillStyle = color;
      ctx.globalAlpha = opacity;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (globalScale >= 0.5) {
        ctx.font = `12px "Fira Code", monospace`;
        ctx.fillStyle = fg;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.name, node.x, node.y + size + 12);
      }
    })
    .linkCanvasObject((link, ctx, globalScale) => {
      const isHovered = link.source.id === _hoverNodeId || link.target.id === _hoverNodeId;
      const color = isHovered ? accentColor : '#5c6370';
      const opacity = isHovered ? 0.9 : _hoverNodeId ? 0.1 : 0.85;

      ctx.beginPath();
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(link.target.x, link.target.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = settings.linkThickness;
      ctx.globalAlpha = opacity;
      ctx.stroke();
      ctx.globalAlpha = 1;

      if (settings.arrows) {
        const angle = Math.atan2(link.target.y - link.source.y, link.target.x - link.source.x);
        const arrowSize = 5;
        ctx.beginPath();
        ctx.moveTo(link.target.x, link.target.y);
        ctx.lineTo(
          link.target.x - arrowSize * Math.cos(angle - Math.PI / 6),
          link.target.y - arrowSize * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          link.target.x - arrowSize * Math.cos(angle + Math.PI / 6),
          link.target.y - arrowSize * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }
    })
    .onNodeHover(node => {
      _hoverNodeId = node ? node.id : null;
      if (_tooltipEl) {
        if (node) {
          _tooltipEl.textContent = node.name;
          _tooltipEl.classList.add('visible');
        } else {
          _tooltipEl.classList.remove('visible');
        }
      }
    })
    .onNodeClick(node => {
      if (node) {
        window.dispatchEvent(new CustomEvent('odysseus-shard-select-note', { detail: { id: node.id } }));
      }
    })
    .onNodeRightClick(node => {
      if (node) {
        const connected = adjMap.get(node.id) || new Set();
        const newNodes = graphData.nodes.filter(n => n.id === node.id || connected.has(n.id));
        graph.graphData({ nodes: newNodes, links: graphData.links });
      }
    })
    .onBackgroundClick(() => {
      graph.graphData(graphData);
    })
    .d3Force('charge', d3 => d3.forceManyBody().strength(settings.repelForce))
    .d3Force('center', d3 => d3.forceCenter().strength(settings.centreForce))
    .d3Force('link', d3 => d3.forceLink().distance(settings.linkDistance).strength(settings.linkForce));

  graph.enableZoomInteraction(true);
  graph.enablePanInteraction(true);

  // Focus on active note
  setTimeout(() => {
    graph.zoomToFit(400);
  }, 100);

  setTimeout(() => {
    graph.cooldownTicks(0);
  }, 3000);

  return {
    graph,
    updateData: (newData) => {
      const newGraphData = {
        nodes: newData.nodes.map(n => ({
          id: n.id,
          name: n.label || n.id,
          val: (n.value || 1) * settings.nodeSize,
          color: n.id === activeNoteId ? '#4dabf7' : (n.color?.background || '#5c6370'),
          x: n.id === activeNoteId ? 0 : n.x,
          y: n.id === activeNoteId ? 0 : n.y,
        })),
        links: newData.edges.map(e => ({
          source: e.from,
          target: e.to,
        })),
      };
      graph.graphData(newGraphData);
    },
    updateSettings: (newSettings) => {
      graph
        .d3Force('charge', d3 => d3.forceManyBody().strength(newSettings.repelForce))
        .d3Force('center', d3 => d3.forceCenter().strength(newSettings.centreForce))
        .d3Force('link', d3 => d3.forceLink().distance(newSettings.linkDistance).strength(newSettings.linkForce));
      graph.d3ReheatSimulation(1000);
      setTimeout(() => graph.cooldownTicks(0), 1000);
    },
    updateNodeSize: (size) => {
      graphData.nodes.forEach(n => n.val = (n.val / settings.nodeSize) * size);
      settings.nodeSize = size;
      graph.graphData(graphData);
    },
    updateLinkThickness: (thickness) => {
      settings.linkThickness = thickness;
    },
    updateArrows: (showArrows) => {
      settings.arrows = showArrows;
    },
    zoomToFit: () => graph.zoomToFit(400),
    destroy: () => {
      graph._destructor();
      if (_tooltipEl) {
        _tooltipEl.remove();
        _tooltipEl = null;
      }
    },
  };
}
