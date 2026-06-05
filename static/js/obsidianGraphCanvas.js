/**
 * Obsidian Graph Canvas — vis-network wrapper for interactive backlink graph.
 */

const API_BASE = window.location.origin;

let _network = null;
let _container = null;

export async function renderObsidianGraph(container) {
  if (!window.vis || !container) return;
  _container = container;
  container.innerHTML = '<div class="obsidian-graph-loading">Loading graph...</div>';

  try {
    const r = await fetch(`${API_BASE}/api/obsidian/graph`);
    if (!r.ok) { container.innerHTML = '<div class="obsidian-graph-error">Failed to load graph</div>'; return; }
    const data = await r.json();
    _draw(data.nodes, data.edges, data.groups);
  } catch (e) {
    container.innerHTML = `<div class="obsidian-graph-error">${e.message}</div>`;
  }
}

function _draw(nodes, edges, groups) {
  if (!_container || !window.vis) return;
  _container.innerHTML = '';

  // Style from CSS variables where possible
  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue('--bg').trim() || '#282c34';
  const fg = style.getPropertyValue('--fg').trim() || '#abb2bf';
  const border = style.getPropertyValue('--border').trim() || '#3e4451';

  const nodeFont = { color: fg, face: 'Fira Code, monospace', size: 12 };
  const edgeColor = { color: border, highlight: fg, hover: fg, opacity: 0.35 };

  const visNodes = new window.vis.DataSet(nodes);
  const visEdges = new window.vis.DataSet(edges);

  const options = {
    nodes: {
      shape: 'dot',
      font: nodeFont,
      borderWidth: 1,
      borderWidthSelected: 2,
      shadow: false,
    },
    edges: {
      width: 1,
      color: edgeColor,
      smooth: { type: 'continuous' },
      arrows: { to: { scaleFactor: 0.5 } },
    },
    groups: groups.reduce((acc, g) => {
      acc[g.id] = { color: { background: g.color, border: g.color } };
      return acc;
    }, {}),
    physics: {
      stabilization: { iterations: 200 },
      barnesHut: {
        gravitationalConstant: -3000,
        centralGravity: 0.3,
        springLength: 120,
        springConstant: 0.04,
        damping: 0.09,
      },
    },
    interaction: {
      hover: true,
      tooltipDelay: 200,
      zoomView: true,
      dragView: true,
    },
    layout: { improvedLayout: true },
  };

  _network = new window.vis.Network(_container, { nodes: visNodes, edges: visEdges }, options);

  // Click to highlight neighbors
  _network.on('click', function (params) {
    if (params.nodes.length === 0) {
      // Reset dimming
      visNodes.update(nodes.map(n => ({ id: n.id, color: null, opacity: 1 })));
      return;
    }
    const selected = params.nodes[0];
    const connected = new Set([selected]);
    edges.forEach(e => {
      if (e.from === selected) connected.add(e.to);
      if (e.to === selected) connected.add(e.from);
    });

    const updates = nodes.map(n => {
      if (connected.has(n.id)) {
        return { id: n.id, opacity: 1 };
      }
      return { id: n.id, opacity: 0.15 };
    });
    visNodes.update(updates);
  });

  // Double-click to open note preview
  _network.on('doubleClick', function (params) {
    if (params.nodes.length > 0) {
      const noteId = params.nodes[0];
      window.dispatchEvent(new CustomEvent('odysseus-obsidian-select-note', { detail: { id: noteId } }));
    }
  });

  // Fit button
  const fitBtn = document.createElement('button');
  fitBtn.className = 'obsidian-graph-fit-btn';
  fitBtn.textContent = 'Fit';
  fitBtn.title = 'Fit graph to view';
  fitBtn.addEventListener('click', () => _network?.fit({ animation: true }));
  _container.appendChild(fitBtn);
}

export function destroyGraph() {
  if (_network) { _network.destroy(); _network = null; }
}
