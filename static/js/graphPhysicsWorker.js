/**
 * Graph Physics Worker — runs d3-force simulation off the main thread.
 * Posts position updates back at 30fps.
 */

/* global importScripts */
try {
  importScripts('https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js');
} catch (e) {
  importScripts('./d3.min.js');
}

if (typeof d3 === 'undefined') {
  console.error('[worker] CRITICAL: d3 is undefined after importScripts');
}

let _simulation = null;
let _nodes = [];
let _links = [];
let _settings = {};
let _tickInterval = null;
let _dragNode = null;

function _initSimulation(nodes, links, settings, opts = {}) {
  if (!d3) { console.error('[worker] d3 not available, cannot init'); return; }
  if (_simulation) _simulation.stop();
  if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }

  const startAlpha = opts.alpha != null ? opts.alpha : 1;

  // Preserve x/y when present (cached positions) so reopening skips warmup.
  // Use undefined (not 0) when absent so d3 assigns a phyllotaxis spiral.
  const hasPositions = nodes.length > 0 && nodes[0].x != null && nodes[0].y != null;
  _nodes = nodes.map(n => ({ ...n, x: n.x != null ? n.x : undefined, y: n.y != null ? n.y : undefined, vx: 0, vy: 0 }));
  _links = links.map(l => ({ ...l }));
  _settings = settings;

  _simulation = d3.forceSimulation(_nodes)
    .force('link', d3.forceLink(_links).id(d => d.id))
    .alphaDecay(0.08)
    .velocityDecay(0.4)
    .alpha(startAlpha)
    .stop(); // Don't auto-tick — we drive it manually

  _configureForces(settings);

  // Warm-up: skip entirely when cached positions exist (instant reopen),
  // otherwise use a shorter default (20 ticks) to reduce build time.
  const warmup = hasPositions ? 0 : (opts.warmup != null ? opts.warmup : 20);
  for (let i = 0; i < warmup; i++) _simulation.tick();

  _startPosting();
}

// Gentle topology update: keep existing node positions, swap node/link sets,
// and give a small alpha nudge so the layout reflows without rotating.
function _setData(nodes, links, settings) {
  if (!_simulation) { _initSimulation(nodes, links, settings); return; }
  _settings = settings || _settings;
  _nodes = nodes.map(n => ({ ...n, x: n.x != null ? n.x : undefined, y: n.y != null ? n.y : undefined, vx: 0, vy: 0 }));
  _links = links.map(l => ({ ...l }));
  _simulation.nodes(_nodes);
  _configureForces(_settings);
  _simulation.alpha(Math.max(_simulation.alpha(), 0.15));
  if (!_tickInterval) _startPosting();
}

// Radial "gravitational" force used when curved lines are enabled: pulls each
// node onto an orbit whose radius shrinks with its link count, so hubs settle
// near the centre and leaves orbit further out — a visibly circular layout.
// Strength is kept low (0.06) so the base charge/link forces still dominate;
// the radial force is only a gentle nudge toward orbital arrangement.
function _applyRadialForce(settings) {
  if (!_simulation) return;
  if (settings && settings.curvedLines) {
    const baseVal = 8 * (settings.nodeSize || 1);
    const linkDist = settings.linkDistance || 120;
    _simulation.force('radial', d3.forceRadial(d => {
      const norm = Math.max(1, Math.min(2.5, (d.val || baseVal) / baseVal)); // 1..2.5
      return linkDist * (2.2 - norm * 0.5); // softer radius spread
    }, 0, 0).strength(0.06));
  } else {
    _simulation.force('radial', null);
  }
}

function _configureForces(settings) {
  if (!_simulation) return;
  settings = settings || _settings;

  // Link force is always present; update its distance/strength in place.
  const linkDist = settings.linkDistance || 120;
  const linkStr = settings.linkForce;
  const linkForce = _simulation.force('link');
  if (linkForce) linkForce.distance(d => d.distance || linkDist).strength(linkStr);

  // Centre force has a hard floor so the graph never loses its global anchor.
  const centreStr = Math.max(0.5, settings.centreForce || 0.5);

  if (settings && settings.hubGravityMode) {
    // Hub gravity: centre slider = hub attraction, repel slider = hub repulsion.
    // A tiny global centre force keeps the whole graph from drifting to infinity.
    _simulation.force('charge', null);
    _simulation.force('x', d3.forceX(0).strength(0.02));
    _simulation.force('y', d3.forceY(0).strength(0.02));
    _simulation.force('hubGravity', _hubGravityForce(centreStr).links(_links));
    _simulation.force('hubRepel', _hubRepelForce(settings.repelForce));
  } else {
    // Standard mode: global centre + global many-body repulsion.
    const repel = settings.repelForce >= 0 ? -(settings.repelForce * 500) : settings.repelForce;
    _simulation.force('charge', d3.forceManyBody().strength(repel));
    _simulation.force('x', d3.forceX(0).strength(centreStr));
    _simulation.force('y', d3.forceY(0).strength(centreStr));
    _simulation.force('hubGravity', null);
    _simulation.force('hubRepel', null);
  }

  _applyRadialForce(settings);
}

// Custom force: each connected node (hub) attracts its linked neighbors and,
// for orphans, the nearest hub. The centre-force slider controls the strength.
function _hubGravityForce(strength) {
  let nodes = [];
  let nodeById = new Map();
  let adj = new Map();

  const force = {
    initialize: function(n) {
      nodes = n;
      nodeById = new Map(nodes.map(n => [n.id, n]));
    },
    links: function(l) {
      adj = new Map();
      for (const link of l) {
        const aId = typeof link.source === 'object' ? link.source?.id : link.source;
        const bId = typeof link.target === 'object' ? link.target?.id : link.target;
        if (!aId || !bId) continue;
        if (!adj.has(aId)) adj.set(aId, []);
        if (!adj.has(bId)) adj.set(bId, []);
        adj.get(aId).push(bId);
        adj.get(bId).push(aId);
      }
      return force;
    },
    call: function(alpha) {
      const hubs = nodes.filter(n => (n.degree || 0) > 0);
      if (hubs.length === 0) return;
      const scale = (strength * 80 * alpha) / Math.max(1, hubs.length);

      for (const node of nodes) {
        const neighbors = adj.get(node.id) || [];
        let targetHub = null;

        if (neighbors.length > 0) {
          // Pull toward the highest-degree neighbor that outranks this node
          let bestDeg = node.degree || 0;
          for (const nbId of neighbors) {
            const nb = nodeById.get(nbId);
            if (nb && (nb.degree || 0) > bestDeg) {
              bestDeg = nb.degree || 0;
              targetHub = nb;
            }
          }
        }

        // Orphans fall toward the nearest hub
        if (!targetHub && (node.degree || 0) === 0) {
          let minDist = Infinity;
          for (const hub of hubs) {
            const dx = hub.x - node.x;
            const dy = hub.y - node.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) {
              minDist = dist;
              targetHub = hub;
            }
          }
        }

        if (targetHub && targetHub !== node) {
          const dx = targetHub.x - node.x;
          const dy = targetHub.y - node.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const mass = Math.max(1, targetHub.degree || 1);
          const f = (scale * mass) / dist; // linear falloff keeps distant nodes influenced
          node.vx += (dx / dist) * f;
          node.vy += (dy / dist) * f;
        }
      }
    }
  };
  return force;
}

// Custom force: hub nodes repel each other. The repel-force slider controls strength.
function _hubRepelForce(strength) {
  let nodes = [];

  return {
    initialize: function(n) { nodes = n; },
    call: function(alpha) {
      const hubs = nodes.filter(n => (n.degree || 0) > 0);
      const scale = strength * 400 * alpha;

      for (let i = 0; i < hubs.length; i++) {
        for (let j = i + 1; j < hubs.length; j++) {
          const a = hubs[i], b = hubs[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const mass = Math.max(1, (a.degree || 1) * (b.degree || 1));
          const f = (scale * mass) / (dist * dist);
          const fx = (dx / dist) * f;
          const fy = (dy / dist) * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }
    }
  };
}

let _settledPosted = false;
function _startPosting() {
  if (_tickInterval) clearInterval(_tickInterval);
  _settledPosted = false;
  _tickInterval = setInterval(() => {
    if (!_simulation) return;
    // Manually tick the simulation. Let it settle naturally (like Obsidian);
    // drag/hover reheat re-energises it when the user interacts.
    _simulation.tick();
    const alpha = _simulation.alpha();
    const active = alpha > 0.005 || _dragNode;
    // Once settled, post one final frame then go quiet until reheated.
    if (!active) {
      if (_settledPosted) return;
      _settledPosted = true;
    } else {
      _settledPosted = false;
    }
    const positions = _nodes.map(n => ({ id: n.id, x: n.x, y: n.y }));
    postMessage({ type: 'tick', positions, alpha });
  }, 33); // ~30fps
}

function _updateSettings(settings) {
  if (!_simulation) return;
  _settings = { ..._settings, ...settings };
  _configureForces(_settings);
  _simulation.alpha(0.3);
}

function _reheat() {
  if (!_simulation) return;
  _simulation.alpha(1);
}

function _dragStart(nodeId) {
  if (!_simulation) return;
  _dragNode = _nodes.find(n => n.id === nodeId);
  if (_dragNode) {
    _dragNode.fx = _dragNode.x;
    _dragNode.fy = _dragNode.y;
    _simulation.alphaTarget(0.3);
  }
}

function _drag(nodeId, x, y) {
  if (!_simulation || !_dragNode || _dragNode.id !== nodeId) return;
  _dragNode.fx = x;
  _dragNode.fy = y;
}

function _dragEnd(nodeId) {
  if (!_simulation || !_dragNode || _dragNode.id !== nodeId) return;
  _dragNode.fx = null;
  _dragNode.fy = null;
  _dragNode = null;
  _simulation.alphaTarget(0);
}

onmessage = (e) => {
  const { type } = e.data;
  switch (type) {
    case 'init':
      _initSimulation(e.data.nodes, e.data.links, e.data.settings, e.data.opts);
      break;
    case 'setData':
      _setData(e.data.nodes, e.data.links, e.data.settings);
      break;
    case 'updateSettings':
      _updateSettings(e.data.settings);
      break;
    case 'reheat':
      _reheat();
      break;
    case 'dragStart':
      _dragStart(e.data.nodeId);
      break;
    case 'drag':
      _drag(e.data.nodeId, e.data.x, e.data.y);
      break;
    case 'dragEnd':
      _dragEnd(e.data.nodeId);
      break;
    case 'stop':
      if (_simulation) _simulation.stop();
      if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
      break;
  }
};
