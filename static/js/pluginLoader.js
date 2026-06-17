/**
 * Plugin Loader for Obsidian Community Plugins
 *
 * - Fetches the Obsidian community plugin registry
 * - Downloads and installs plugins (main.js + manifest.json + styles.css)
 * - Loads them dynamically with the obsidian shim
 * - Wraps all plugin callbacks in try/catch with toast notifications
 */

import { PluginManager } from './vaultPluginApi.js';

const REGISTRY_URL = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';
const REGISTRY_CACHE_KEY = 'vault-obsidian-registry-cache';
const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const INSTALLED_PLUGINS_KEY = 'vault-installed-plugins';
const PLUGIN_DIR = '/plugins'; // Virtual directory prefix

/* ── Registry ────────────────────────────────────────────── */

let _registry = null;

export async function fetchObsidianRegistry() {
  // Try cache first
  try {
    const cached = JSON.parse(localStorage.getItem(REGISTRY_CACHE_KEY) || '{}');
    if (cached.data && cached.ts && (Date.now() - cached.ts) < REGISTRY_CACHE_TTL_MS) {
      _registry = cached.data;
      return _registry;
    }
  } catch {}

  try {
    const r = await fetch(REGISTRY_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    _registry = Array.isArray(data) ? data : [];
    localStorage.setItem(REGISTRY_CACHE_KEY, JSON.stringify({ data: _registry, ts: Date.now() }));
    return _registry;
  } catch (err) {
    console.warn('[PluginLoader] Failed to fetch registry:', err);
    // Return cached even if stale, or empty array
    try {
      const cached = JSON.parse(localStorage.getItem(REGISTRY_CACHE_KEY) || '{}');
      _registry = cached.data || [];
    } catch { _registry = []; }
    return _registry;
  }
}

export function getRegistry() {
  return _registry || [];
}

export function searchRegistry(query) {
  const q = (query || '').toLowerCase();
  if (!q) return _registry || [];
  return (_registry || []).filter(p =>
    (p.id && p.id.toLowerCase().includes(q)) ||
    (p.name && p.name.toLowerCase().includes(q)) ||
    (p.description && p.description.toLowerCase().includes(q)) ||
    (p.author && p.author.toLowerCase().includes(q))
  );
}

/* ── Installation ────────────────────────────────────────── */

function _githubRawUrl(repo, branch, file) {
  const [owner, name] = repo.split('/');
  return `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${file}`;
}

export async function installPlugin(repo, id) {
  if (!repo || !id) throw new Error('repo and id are required');

  // Default to master/main branch; most Obsidian plugins use master
  const branch = 'master';

  const manifestUrl = _githubRawUrl(repo, branch, 'manifest.json');
  const mainUrl = _githubRawUrl(repo, branch, 'main.js');
  const stylesUrl = _githubRawUrl(repo, branch, 'styles.css');

  // Fetch manifest
  const manifestRes = await fetch(manifestUrl);
  if (!manifestRes.ok) throw new Error(`Failed to fetch manifest: HTTP ${manifestRes.status}`);
  const manifest = await manifestRes.json();

  // Fetch main.js
  const mainRes = await fetch(mainUrl);
  if (!mainRes.ok) throw new Error(`Failed to fetch main.js: HTTP ${mainRes.status}`);
  const mainJs = await mainRes.text();

  // Fetch styles.css (optional)
  let stylesCss = null;
  try {
    const stylesRes = await fetch(stylesUrl);
    if (stylesRes.ok) stylesCss = await stylesRes.text();
  } catch {}

  // Store in localStorage under prefixed keys (simple virtual fs)
  const installed = getInstalledPlugins();
  installed[id] = {
    id,
    repo,
    manifest,
    mainJs,
    stylesCss,
    installedAt: Date.now(),
    enabled: false,
  };
  _saveInstalled(installed);

  return installed[id];
}

export function uninstallPlugin(id) {
  const installed = getInstalledPlugins();
  if (installed[id]) {
    delete installed[id];
    _saveInstalled(installed);
  }
}

export function getInstalledPlugins() {
  try {
    return JSON.parse(localStorage.getItem(INSTALLED_PLUGINS_KEY) || '{}');
  } catch { return {}; }
}

function _saveInstalled(installed) {
  localStorage.setItem(INSTALLED_PLUGINS_KEY, JSON.stringify(installed));
}

export function isPluginInstalled(id) {
  return !!getInstalledPlugins()[id];
}

/* ── Loading & Guard System ────────────────────────────── */

let _pluginManager = null;

export function setPluginManager(pm) {
  _pluginManager = pm;
}

export function getPluginManager() {
  return _pluginManager;
}

const _loadedPluginClasses = new Map(); // id -> PluginClass

/**
 * Load a community plugin's main.js and register it with the PluginManager.
 * All lifecycle calls are wrapped in try/catch with toast notifications.
 */
export async function loadCommunityPlugin(id) {
  const installed = getInstalledPlugins();
  const entry = installed[id];
  if (!entry) throw new Error(`Plugin ${id} is not installed`);
  if (!entry.mainJs) throw new Error(`Plugin ${id} has no main.js`);

  // If already loaded, just enable
  if (_loadedPluginClasses.has(id)) {
    if (_pluginManager) {
      await _safePluginManagerEnable(id);
    }
    return;
  }

  // Inject styles.css if present
  if (entry.stylesCss) {
    const styleId = `plugin-style-${id}`;
    if (!document.getElementById(styleId)) {
      const styleEl = document.createElement('style');
      styleEl.id = styleId;
      styleEl.textContent = entry.stylesCss;
      document.head.appendChild(styleEl);
    }
  }

  // Build the plugin class from the downloaded JS
  // We wrap it in a function that receives `require`, `module`, `exports`
  // so that CommonJS-style `module.exports = class MyPlugin extends require('obsidian').Plugin {}`
  // works correctly.
  const moduleShim = { exports: {} };
  const requireShim = (modId) => {
    if (modId === 'obsidian') {
      if (window.__obsidianShim) return window.__obsidianShim;
      throw new Error('Obsidian shim not loaded. Make sure obsidianShim.js is imported before pluginLoader.js');
    }
    if (window.require) {
      try { return window.require(modId); } catch {}
    }
    throw new Error(`Plugin "${id}" requires module "${modId}" which is not available in vault.`);
  };

  // Wrap the plugin source in a guarded IIFE so syntax errors don't blow up the whole app
  let PluginClass;
  try {
    const wrappedSource = `
      (function(require, module, exports) {
        "use strict";
        ${entry.mainJs}
      })
    `;
    const pluginFactory = new Function('return ' + wrappedSource.trim())();
    pluginFactory(requireShim, moduleShim, moduleShim.exports);

    // Most Obsidian plugins do: module.exports = class MyPlugin extends Plugin {}
    // Some do: exports.default = class MyPlugin ...
    PluginClass = moduleShim.exports?.default || moduleShim.exports;
    if (!PluginClass || typeof PluginClass !== 'function') {
      throw new Error(`Plugin "${id}" did not export a valid class. Got: ${typeof PluginClass}`);
    }
  } catch (err) {
    _pluginToast(id, `Failed to load: ${err.message}`, 'error');
    console.error(`[PluginLoader] Syntax/load error for ${id}:`, err);
    throw err;
  }

  // Register with PluginManager
  if (!_pluginManager) {
    throw new Error('PluginManager not set. Call setPluginManager() before loadCommunityPlugin().');
  }

  _pluginManager.register(entry.manifest, PluginClass);
  _loadedPluginClasses.set(id, PluginClass);

  await _safePluginManagerEnable(id);
}

/**
 * Enable a plugin with graceful guard.
 */
async function _safePluginManagerEnable(id) {
  if (!_pluginManager) return;

  const entry = getInstalledPlugins()[id];
  const manifest = entry?.manifest || _pluginManager.getManifest(id);

  try {
    const ok = await _pluginManager.enable(id);
    if (ok) {
      _pluginToast(id, `${manifest?.name || id} enabled`, 'success');
      // Update persisted state
      entry.enabled = true;
      _saveInstalled(getInstalledPlugins());
    }
  } catch (err) {
    _pluginToast(id, `Failed to enable: ${err.message}`, 'error');
    console.error(`[PluginLoader] Enable error for ${id}:`, err);
    // Auto-disable after repeated failures
    _incrementFailure(id);
  }
}

/**
 * Disable a community plugin.
 */
export async function disableCommunityPlugin(id) {
  if (!_pluginManager) return;
  try {
    await _pluginManager.disable(id);
    const installed = getInstalledPlugins();
    if (installed[id]) {
      installed[id].enabled = false;
      _saveInstalled(installed);
    }
    _pluginToast(id, `${_pluginManager.getManifest(id)?.name || id} disabled`, 'info');
  } catch (err) {
    _pluginToast(id, `Failed to disable: ${err.message}`, 'error');
    console.error(`[PluginLoader] Disable error for ${id}:`, err);
  }
}

/**
 * Unload everything and remove styles.
 */
export async function unloadCommunityPlugin(id) {
  await disableCommunityPlugin(id);
  _loadedPluginClasses.delete(id);
  const styleId = `plugin-style-${id}`;
  const styleEl = document.getElementById(styleId);
  if (styleEl) styleEl.remove();
}

/* ── Guard Infrastructure ────────────────────────────────── */

const _failureCounts = new Map();
const FAILURE_THRESHOLD = 3;

function _incrementFailure(id) {
  const count = (_failureCounts.get(id) || 0) + 1;
  _failureCounts.set(id, count);
  if (count >= FAILURE_THRESHOLD) {
    _pluginToast(id, `Disabled after ${count} failures. Check console for details.`, 'warn');
    if (_pluginManager) {
      _pluginManager.disable(id).catch(() => {});
    }
  }
}

function _pluginToast(id, message, type = 'info') {
  const manifest = getInstalledPlugins()[id]?.manifest || _pluginManager?.getManifest(id);
  const name = manifest?.name || id;
  const fullMsg = `Plugin "${name}": ${message}`;

  if (typeof window !== 'undefined') {
    if (window._showVaultToast) {
      window._showVaultToast(fullMsg, { duration: type === 'error' ? 6000 : 4000, type });
    } else if (window.showToast) {
      window.showToast(fullMsg, type === 'error' ? 6000 : 4000);
    } else if (type === 'error' && window.showError) {
      window.showError(fullMsg);
    } else {
      console.log(`[Plugin Toast] ${fullMsg}`);
    }
  }
}

/**
 * Call a plugin method safely. Used internally by PluginManager wrapper.
 */
export async function safePluginCall(plugin, methodName, ...args) {
  try {
    return await plugin[methodName](...args);
  } catch (err) {
    const id = plugin.manifest?.id || 'unknown';
    _pluginToast(id, `${methodName} error: ${err.message}`, 'error');
    console.error(`[Plugin Guard] ${plugin.manifest?.id}.${methodName}:`, err);
    _incrementFailure(id);
    return undefined;
  }
}

/* ── Bulk Load on Startup ───────────────────────────────── */

/**
 * Load all installed plugins that are marked enabled.
 */
export async function loadAllEnabledPlugins(pluginManager) {
  setPluginManager(pluginManager);
  const installed = getInstalledPlugins();
  for (const [id, entry] of Object.entries(installed)) {
    if (!entry.enabled) continue;
    try {
      await loadCommunityPlugin(id);
    } catch (err) {
      console.warn(`[PluginLoader] Skipped loading ${id} on startup:`, err);
    }
  }
}

/* ── UI Helpers ─────────────────────────────────────────── */

/**
 * Render a list of available plugins from the registry (not yet installed).
 */
export function renderPluginBrowser(container, onInstall) {
  if (!container) return;
  container.innerHTML = '<div style="padding:8px;text-align:center;opacity:0.5;font-size:12px;">Loading plugins...</div>';

  fetchObsidianRegistry().then(registry => {
    const installed = getInstalledPlugins();
    container.innerHTML = '';

    if (!registry.length) {
      container.innerHTML = '<div style="padding:8px;text-align:center;opacity:0.5;font-size:12px;">No plugins found in registry.</div>';
      return;
    }

    const searchWrap = document.createElement('div');
    searchWrap.className = 'vault-settings-row';
    searchWrap.style.marginBottom = '8px';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'vault-settings-input';
    input.placeholder = 'Search Obsidian community plugins...';
    searchWrap.appendChild(input);
    container.appendChild(searchWrap);

    const list = document.createElement('div');
    list.className = 'vault-community-plugins-list';
    list.style.maxHeight = '400px';
    list.style.overflow = 'auto';
    container.appendChild(list);

    function renderList(filter = '') {
      list.innerHTML = '';
      const results = searchRegistry(filter);
      results.forEach(p => {
        const isInstalled = !!installed[p.id];
        const row = document.createElement('div');
        row.className = 'vault-settings-row';
        row.style.gap = '12px';
        row.style.alignItems = 'flex-start';

        const info = document.createElement('div');
        info.style.flex = '1';
        info.innerHTML = `<div style="font-weight:600;font-size:13px;">${_esc(p.name)} <span style="opacity:0.5;font-weight:400;">by ${_esc(p.author)}</span></div>
                          <div style="font-size:11px;opacity:0.7;margin-top:2px;">${_esc(p.description || '')}</div>`;

        const btn = document.createElement('button');
        btn.className = 'admin-btn-sm';
        btn.type = 'button';
        btn.textContent = isInstalled ? 'Installed' : 'Install';
        btn.disabled = isInstalled;
        btn.addEventListener('click', () => {
          if (isInstalled) return;
          btn.textContent = 'Installing...';
          btn.disabled = true;
          installPlugin(p.repo, p.id).then(() => {
            btn.textContent = 'Installed';
            if (onInstall) onInstall(p);
          }).catch(err => {
            btn.textContent = 'Retry';
            btn.disabled = false;
            _pluginToast(p.id, `Install failed: ${err.message}`, 'error');
          });
        });

        row.appendChild(info);
        row.appendChild(btn);
        list.appendChild(row);
      });
    }

    input.addEventListener('input', () => renderList(input.value));
    renderList();
  });
}

function _esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
