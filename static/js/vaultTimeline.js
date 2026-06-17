/**
 * Vault Timeline Player — chronological vault growth animation.
 */

const API_BASE = window.location.origin;

let _network = null;
let _container = null;
let _frames = [];
let _currentFrame = 0;
let _playing = false;
let _speed = 1;
let _timer = null;
let _nodeSet = null;
let _edgeSet = null;

export async function renderVaultTimeline(container) {
  _container = container;
  container.innerHTML = '<div class="vault-timeline-loading">Loading timeline...</div>';

  try {
    const r = await fetch(`${API_BASE}/api/vault/timeline`);
    if (!r.ok) { container.innerHTML = '<div class="vault-timeline-error">Failed to load timeline</div>'; return; }
    const data = await r.json();
    _frames = data.frames || [];
    _currentFrame = 0;
    _buildUI();
    _initCanvas();
    _renderFrame(0);
  } catch (e) {
    container.innerHTML = `<div class="vault-timeline-error">${e.message}</div>`;
  }
}

function _buildUI() {
  if (!_container) return;
  _container.innerHTML = '';

  // Controls bar
  const controls = document.createElement('div');
  controls.className = 'vault-timeline-controls';
  controls.innerHTML = `
    <button class="vault-timeline-btn" id="otl-play">▶</button>
    <button class="vault-timeline-btn" id="otl-pause" style="display:none">⏸</button>
    <input type="range" class="vault-timeline-seek" id="otl-seek" min="0" max="${_frames.length - 1}" value="0" />
    <select class="vault-timeline-speed" id="otl-speed">
      <option value="0.5">0.5×</option>
      <option value="1" selected>1×</option>
      <option value="2">2×</option>
      <option value="5">5×</option>
    </select>
    <span class="vault-timeline-info" id="otl-info">0 notes, 0 links</span>
  `;
  _container.appendChild(controls);

  // Canvas container
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'vault-timeline-canvas';
  canvasWrap.id = 'vault-timeline-canvas';
  _container.appendChild(canvasWrap);

  // Info bar
  const infoBar = document.createElement('div');
  infoBar.className = 'vault-timeline-infobar';
  infoBar.id = 'vault-timeline-infobar';
  infoBar.textContent = 'Paused';
  _container.appendChild(infoBar);

  // Bind controls
  const playBtn = controls.querySelector('#otl-play');
  const pauseBtn = controls.querySelector('#otl-pause');
  const seek = controls.querySelector('#otl-seek');
  const speed = controls.querySelector('#otl-speed');

  playBtn.addEventListener('click', () => _play());
  pauseBtn.addEventListener('click', () => _pause());
  seek.addEventListener('input', () => {
    _pause();
    _renderFrame(parseInt(seek.value, 10));
  });
  speed.addEventListener('change', () => { _speed = parseFloat(speed.value); });
}

function _initCanvas() {
  const canvasWrap = document.getElementById('vault-timeline-canvas');
  if (!canvasWrap || !window.vis) return;

  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue('--bg').trim() || '#282c34';
  const fg = style.getPropertyValue('--fg').trim() || '#abb2bf';
  const border = style.getPropertyValue('--border').trim() || '#3e4451';

  _nodeSet = new window.vis.DataSet([]);
  _edgeSet = new window.vis.DataSet([]);

  const options = {
    nodes: {
      shape: 'dot',
      font: { color: fg, face: 'Fira Code, monospace', size: 11 },
      borderWidth: 1,
    },
    edges: {
      width: 1,
      color: { color: border, opacity: 0.35 },
      smooth: { type: 'continuous' },
      arrows: { to: { scaleFactor: 0.5 } },
    },
    physics: {
      stabilization: { iterations: 100 },
      barnesHut: {
        gravitationalConstant: -2000,
        centralGravity: 0.3,
        springLength: 100,
        springConstant: 0.04,
        damping: 0.09,
      },
    },
    interaction: { zoomView: true, dragView: true },
  };

  _network = new window.vis.Network(canvasWrap, { nodes: _nodeSet, edges: _edgeSet }, options);

  // Click pauses
  _network.on('click', () => _pause());
}

function _renderFrame(idx) {
  if (!_frames.length) return;
  idx = Math.max(0, Math.min(idx, _frames.length - 1));
  _currentFrame = idx;

  // Rebuild cumulative state up to this frame
  const nodes = [];
  const edges = [];
  const seenNodes = new Set();
  const seenEdges = new Set();

  for (let i = 0; i <= idx; i++) {
    const f = _frames[i];
    for (const n of f.nodes_added || []) {
      if (!seenNodes.has(n.id)) {
        seenNodes.add(n.id);
        nodes.push({ id: n.id, label: n.label, value: 1 });
      }
    }
    for (const e of f.edges_added || []) {
      const key = `${e.from}->${e.to}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push({ from: e.from, to: e.to, arrows: 'to' });
      }
    }
  }

  if (_nodeSet && _edgeSet) {
    _nodeSet.clear();
    _edgeSet.clear();
    _nodeSet.add(nodes);
    _edgeSet.add(edges);
  }

  // Update UI
  const seek = document.getElementById('otl-seek');
  if (seek) seek.value = idx;

  const info = document.getElementById('otl-info');
  if (info) {
    const f = _frames[idx];
    info.textContent = `${f.note_count} notes, ${f.link_count} links`;
  }

  const infobar = document.getElementById('vault-timeline-infobar');
  if (infobar) {
    const ts = _frames[idx].timestamp;
    infobar.textContent = ts ? ts.slice(0, 10) : `Frame ${idx + 1}/${_frames.length}`;
  }
}

function _play() {
  if (_playing) return;
  _playing = true;
  document.getElementById('otl-play').style.display = 'none';
  document.getElementById('otl-pause').style.display = '';

  const step = () => {
    if (!_playing) return;
    if (_currentFrame >= _frames.length - 1) {
      _pause();
      return;
    }
    _renderFrame(_currentFrame + 1);
    const delay = Math.max(200, 1000 / _speed);
    _timer = setTimeout(step, delay);
  };
  step();
}

function _pause() {
  _playing = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  const playBtn = document.getElementById('otl-play');
  const pauseBtn = document.getElementById('otl-pause');
  if (playBtn) playBtn.style.display = '';
  if (pauseBtn) pauseBtn.style.display = 'none';
}

export function destroyTimeline() {
  _pause();
  if (_network) { _network.destroy(); _network = null; }
  _nodeSet = null;
  _edgeSet = null;
}
