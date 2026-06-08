/**
 * Shard-style Plugin API (Phase 4.1 / 4.2)
 *
 * - Plugin base class with lifecycle hooks
 * - PluginManager for register / enable / disable / settings persistence
 * - App API object mimicking Shard's `app` namespace
 * - Core plugins that wrap existing Shard panel features
 */

/* ── Plugin Base Class ────────────────────────────────────── */

export class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this._eventRefs = [];
    this._domListeners = [];
    this._intervals = [];
  }

  /** Override: runs when plugin is enabled */
  async onload() {}

  /** Override: runs when plugin is disabled */
  async onunload() {
    // Clean up registered DOM events
    this._domListeners.forEach(({ el, type, cb }) => {
      try { el.removeEventListener(type, cb); } catch {}
    });
    this._domListeners = [];
    // Clean up intervals
    this._intervals.forEach(id => clearInterval(id));
    this._intervals = [];
    this._eventRefs = [];
  }

  /* ── Helpers ── */

  registerDomEvent(el, type, callback) {
    el.addEventListener(type, callback);
    this._domListeners.push({ el, type, cb: callback });
  }

  registerEvent(eventRef) {
    this._eventRefs.push(eventRef);
  }

  registerInterval(id) {
    this._intervals.push(id);
  }

  addRibbonIcon(iconSvg, title, callback) {
    const ribbon = document.getElementById('shard-ribbon-bar');
    if (!ribbon) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shard-ribbon-btn';
    btn.title = title;
    btn.innerHTML = iconSvg;
    btn.addEventListener('click', callback);
    ribbon.appendChild(btn);
    this._domListeners.push({ el: btn, type: 'click', cb: callback });
    return btn;
  }

  addCommand(id, name, callback, hotkey) {
    // Commands are registered globally; we store them on the app for the palette
    if (!this.app._commands) this.app._commands = [];
    this.app._commands.push({
      pluginId: this.manifest.id,
      id: `${this.manifest.id}:${id}`,
      name,
      callback,
      hotkey,
    });
  }

  addStatusBarItem() {
    const bar = document.getElementById('shard-status-bar');
    if (!bar) return null;
    const el = document.createElement('span');
    el.className = 'shard-status-bar-item';
    bar.appendChild(el);
    return el;
  }
}

/* ── App API ──────────────────────────────────────────────── */

export function createAppApi(opts) {
  const app = {
    _commands: [],

    vault: {
      getNotes: () => opts.vaultNotes || [],
      getFolders: () => opts.vaultFolders || [],
      getAbstractFileByPath(path) {
        return app.vault.getNotes().find(n =>
          (n.rel_path || n.id) === path || n.title === path
        );
      },
      read(file) {
        const note = typeof file === 'string'
          ? app.vault.getAbstractFileByPath(file)
          : file;
        return note ? (note.content || '') : null;
      },
    },

    workspace: {
      getActiveFile() {
        const id = opts.getActiveFileId ? opts.getActiveFileId() : null;
        return app.vault.getNotes().find(n => n.id === id) || null;
      },
      onLayoutReady(cb) { cb(); },
      openLinkText(text, _sourcePath) {
        if (opts.onOpenLink) opts.onOpenLink(text);
      },
    },

    fileManager: {
      renameFile(file, newPath) {
        if (opts.renameFile) return opts.renameFile(file, newPath);
      },
      trashFile(file) {
        if (opts.trashFile) return opts.trashFile(file);
      },
    },

    metadataCache: {
      getFileCache(file) {
        const note = typeof file === 'string'
          ? app.vault.getAbstractFileByPath(file)
          : file;
        return note || null;
      },
    },
  };

  return app;
}

/* ── Plugin Manager ───────────────────────────────────────── */

export class PluginManager {
  constructor(app) {
    this.app = app;
    this._registry = new Map();   // id -> { manifest, PluginClass }
    this._instances = new Map();    // id -> Plugin instance
  }

  register(manifest, PluginClass) {
    if (!manifest || !manifest.id) {
      console.warn('[PluginManager] skipped register: missing manifest.id');
      return;
    }
    this._registry.set(manifest.id, { manifest, PluginClass });
  }

  async enable(id) {
    if (this._instances.has(id)) return true;
    const entry = this._registry.get(id);
    if (!entry) {
      console.warn(`[PluginManager] unknown plugin: ${id}`);
      return false;
    }
    const instance = new entry.PluginClass(this.app, entry.manifest);
    await instance.onload();
    this._instances.set(id, instance);
    return true;
  }

  async disable(id) {
    const instance = this._instances.get(id);
    if (!instance) return;
    await instance.onunload();
    this._instances.delete(id);
  }

  isEnabled(id) {
    return this._instances.has(id);
  }

  getInstance(id) {
    return this._instances.get(id) || null;
  }

  getManifest(id) {
    return this._registry.get(id)?.manifest || null;
  }

  getAllManifests() {
    return Array.from(this._registry.values()).map(r => r.manifest);
  }

  getEnabledManifests() {
    return this.getAllManifests().filter(m => this.isEnabled(m.id));
  }

  /** Load enabled plugins from persisted settings */
  async loadFromSettings(settings) {
    const enabled = settings?.enabledPlugins || [];
    for (const id of enabled) {
      await this.enable(id).catch(err => {
        console.warn(`[PluginManager] failed to load ${id}:`, err);
      });
    }
  }

  /** Persist current enabled state to settings object */
  saveToSettings(settings) {
    settings.enabledPlugins = Array.from(this._instances.keys());
  }
}

/* ── Core Plugin Manifests ──────────────────────────────────── */

export const CORE_PLUGINS = [
  { id: 'graph',          name: 'Graph',          description: 'Visual graph of vault links',      minAppVersion: '0.1.0' },
  { id: 'backlinks',      name: 'Backlinks',      description: 'Backlinks panel',                   minAppVersion: '0.1.0' },
  { id: 'outgoing-links', name: 'Outgoing Links', description: 'Outgoing links panel',              minAppVersion: '0.1.0' },
  { id: 'unlinked',       name: 'Unlinked Mentions', description: 'Unlinked mentions panel',         minAppVersion: '0.1.0' },
  { id: 'outline',        name: 'Outline',        description: 'Heading outline panel',             minAppVersion: '0.1.0' },
  { id: 'orphans',        name: 'Orphans',        description: 'Orphan links panel',                minAppVersion: '0.1.0' },
  { id: 'bookmarks',      name: 'Bookmarks',      description: 'Bookmarked notes & folders',        minAppVersion: '0.1.0' },
  { id: 'tags',           name: 'Tags',           description: 'Tag browser',                       minAppVersion: '0.1.0' },
  { id: 'search',         name: 'Search',         description: 'Full-text search sidebar',          minAppVersion: '0.1.0' },
  { id: 'daily-notes',    name: 'Daily Notes',    description: 'Daily note creation & navigation',  minAppVersion: '0.1.0' },
  { id: 'templates',      name: 'Templates',      description: 'Note template insertion',           minAppVersion: '0.1.0' },
  { id: 'word-count',     name: 'Word Count',     description: 'Status bar word count',             minAppVersion: '0.1.0' },
  { id: 'page-preview',   name: 'Page Preview',   description: 'Hover preview on wikilinks',        minAppVersion: '0.1.0' },
  { id: 'random-note',    name: 'Random Note',    description: 'Open a random note',                minAppVersion: '0.1.0' },
];

/* ── Core Plugin Classes ──────────────────────────────────── */

/** Simple wrapper: declares a right-sidebar feature is active */
function _makeSidebarPlugin(tabId) {
  return class extends Plugin {
    async onload() {
      // Right sidebar rendering is still handled by shardPanel.js;
      // the plugin's existence simply means the tab is shown.
      this._active = true;
    }
  };
}

export const GraphPlugin          = _makeSidebarPlugin('graph');
export const BacklinksPlugin      = _makeSidebarPlugin('backlinks');
export const OutgoingLinksPlugin  = _makeSidebarPlugin('outgoing');
export const UnlinkedMentionsPlugin = _makeSidebarPlugin('unlinked');
export const OutlinePlugin        = _makeSidebarPlugin('outline');
export const OrphansPlugin        = _makeSidebarPlugin('orphans');

export class BookmarksPlugin extends Plugin {
  async onload() {
    // Bookmarks are rendered by _renderBookmarksPane in shardPanel.js
    // Nothing extra needed here yet.
  }
}

export class TagsPlugin extends Plugin {
  async onload() {
    // Tags rendered by _renderTagsPane / _renderNoteTagsPane in shardPanel.js
  }
}

export class SearchPlugin extends Plugin {
  async onload() {
    // Search rendered by _renderSearchPane in shardPanel.js
  }
}

export class DailyNotesPlugin extends Plugin {
  async onload() {
    this.addCommand('open-daily-note', 'Open daily note', () => {
      if (this.app._openDailyNote) this.app._openDailyNote();
    }, 'Ctrl+Alt+D');
  }
}

export class TemplatesPlugin extends Plugin {
  async onload() {
    this.addCommand('insert-template', 'Insert template', () => {
      if (this.app._insertTemplate) this.app._insertTemplate();
    });
  }
}

export class PagePreviewPlugin extends Plugin {
  async onload() {
    // Page preview logic is already in shardPanel.js wikilink hover
  }
}

export class WordCountPlugin extends Plugin {
  async onload() {
    this._statusItem = this.addStatusBarItem();
    if (!this._statusItem) return;

    const update = () => {
      const note = this.app.workspace.getActiveFile();
      const text = note ? (note.content || '') : '';
      const count = text.split(/\s+/).filter(Boolean).length;
      this._statusItem.textContent = `${count} words`;
    };

    // Update when note changes
    this._updateFn = update;
    // Initial update
    update();
  }

  async onunload() {
    if (this._statusItem) {
      try { this._statusItem.remove(); } catch {}
    }
    super.onunload();
  }

  update() {
    if (this._updateFn) this._updateFn();
  }
}

export class RandomNotePlugin extends Plugin {
  async onload() {
    this.addCommand('open-random-note', 'Open random note', () => {
      const notes = this.app.vault.getNotes();
      if (!notes.length) return;
      const pick = notes[Math.floor(Math.random() * notes.length)];
      this.app.workspace.openLinkText(pick.title);
    });
  }
}
