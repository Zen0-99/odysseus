/**
 * Obsidian API Compatibility Shim for Vault
 *
 * Provides an obsidian-compatible API surface so community plugins
 * can run inside the vault. Internally delegates to vault native APIs.
 */

import { Plugin, PluginManager } from './vaultPluginApi.js';

/* ── Re-export the base Plugin class ────────────────────── */
export { Plugin };

/* ── Component ───────────────────────────────────────────── */
export class Component {
  constructor() {
    this._children = [];
    this._loaded = false;
  }

  addChild(child) {
    this._children.push(child);
    if (this._loaded && child.onload) child.onload();
    return child;
  }

  removeChild(child) {
    const idx = this._children.indexOf(child);
    if (idx >= 0) {
      this._children.splice(idx, 1);
      if (child.onunload) child.onunload();
    }
  }

  onload() {
    this._loaded = true;
    this._children.forEach(c => { if (c.onload) c.onload(); });
  }

  onunload() {
    this._loaded = false;
    // Copy array because onunload may mutate it
    [...this._children].forEach(c => { if (c.onunload) c.onunload(); });
    this._children = [];
  }

  register(callback) {
    // Obsidian's Component.register(fn) stores a callback ref
    // that is cleaned up on unload. We wrap via our Plugin's event system.
    this._eventRefs = this._eventRefs || [];
    this._eventRefs.push(callback);
  }
}

/* ── Events / EventRef helpers ───────────────────────────── */
export class Events {
  constructor() {
    this._handlers = new Map();
  }

  on(name, callback) {
    if (!this._handlers.has(name)) this._handlers.set(name, []);
    this._handlers.get(name).push(callback);
    return { fn: callback, name };
  }

  off(name, callback) {
    const list = this._handlers.get(name);
    if (!list) return;
    const idx = list.indexOf(callback);
    if (idx >= 0) list.splice(idx, 1);
  }

  offref(ref) {
    this.off(ref.name, ref.fn);
  }

  trigger(name, ...args) {
    const list = this._handlers.get(name);
    if (!list) return;
    list.forEach(fn => {
      try { fn(...args); } catch (e) { console.error(`[Events] handler error for ${name}:`, e); }
    });
  }
}

/* ── Vault & File Types ──────────────────────────────────── */
export class TAbstractFile {
  constructor(path) { this.path = path; this.name = path.split('/').pop() || path; }
}

export class TFile extends TAbstractFile {
  constructor(path, content = '') {
    super(path);
    this.content = content;
    this.extension = this.name.includes('.') ? this.name.split('.').pop() : '';
  }
}

export class TFolder extends TAbstractFile {
  constructor(path) { super(path); this.children = []; }
}

export class Vault extends Events {
  constructor(opts = {}) {
    super();
    this._notes = opts.notes || [];
    this._folders = opts.folders || [];
    this._adapter = opts.adapter || null;
  }

  getAbstractFileByPath(path) {
    const note = this._notes.find(n => (n.rel_path || n.id) === path || n.title === path);
    if (note) return new TFile(note.rel_path || note.id, note.content || '');
    const folder = this._folders.find(f => (f.rel_path || f.path || f.name) === path);
    if (folder) return new TFolder(folder.rel_path || folder.path || folder.name);
    return null;
  }

  getMarkdownFiles() {
    return this._notes.map(n => new TFile(n.rel_path || n.id, n.content || ''));
  }

  getFiles() {
    return this.getMarkdownFiles();
  }

  read(file) {
    const note = typeof file === 'string'
      ? this._notes.find(n => (n.rel_path || n.id) === file || n.title === file)
      : file;
    return note ? (note.content || '') : null;
  }

  readBinary(file) {
    return Promise.reject(new Error('Binary file reading not supported in vault yet'));
  }

  cachedRead(file) {
    return Promise.resolve(this.read(file));
  }

  exists(path, caseSensitive) {
    const note = this._notes.find(n => (n.rel_path || n.id) === path || n.title === path);
    return Promise.resolve(!!note);
  }

  create(path, data) {
    this.trigger('create', new TFile(path, data || ''));
    return Promise.resolve(new TFile(path, data || ''));
  }

  createFolder(path) {
    this.trigger('create', new TFolder(path));
    return Promise.resolve(new TFolder(path));
  }

  modify(file, data) {
    const note = typeof file === 'string'
      ? this._notes.find(n => (n.rel_path || n.id) === file || n.title === file)
      : file;
    if (note) note.content = data;
    this.trigger('modify', note || new TFile(file, data));
    return Promise.resolve();
  }

  delete(file, force) {
    this.trigger('delete', file);
    return Promise.resolve();
  }

  rename(file, newPath) {
    this.trigger('rename', file, newPath);
    return Promise.resolve();
  }

  getRoot() {
    return new TFolder('/');
  }

  adapter = {
    read: (path) => Promise.resolve(this.read(path)),
    write: (path, data) => this.modify(path, data),
    exists: (path) => this.exists(path),
    mkdir: (path) => this.createFolder(path),
    trashSystem: (path) => Promise.resolve(),
    trashLocal: (path) => Promise.resolve(),
    remove: (path) => this.delete(path),
    rename: (path, newPath) => this.rename(path, newPath),
    list: (path) => Promise.resolve(this._folders.filter(f => f.path?.startsWith(path)).map(f => f.name)),
    stat: (path) => Promise.resolve({ type: 'file', ctime: Date.now(), mtime: Date.now(), size: 0 }),
  };
}

/* ── Workspace ─────────────────────────────────────────── */
export class Workspace extends Events {
  constructor(opts = {}) {
    super();
    this._getActiveFileId = opts.getActiveFileId || (() => null);
    this._vault = opts.vault;
    this._onOpenLink = opts.onOpenLink || (() => {});
  }

  getActiveFile() {
    const id = this._getActiveFileId();
    if (!id || !this._vault) return null;
    return this._vault.getAbstractFileByPath(id);
  }

  getActiveViewOfType(type) {
    // Vault currently only has one editor view
    if (type === 'markdown') return { file: this.getActiveFile() };
    return null;
  }

  openLinkText(text, sourcePath, newLeaf) {
    this._onOpenLink(text);
  }

  onLayoutReady(cb) {
    if (document.readyState === 'complete') cb();
    else window.addEventListener('DOMContentLoaded', cb, { once: true });
  }

  getLeavesOfType(type) {
    // Vault has a single main editor pane
    return [{ getViewState: () => ({ type: 'markdown' }), view: { file: this.getActiveFile() } }];
  }

  getRightLeaf() {
    return null;
  }

  getLeftLeaf() {
    return null;
  }

  activeLeaf = {
    getViewState: () => ({ type: 'markdown' }),
    view: { file: this.getActiveFile() },
  };
}

/* ── FileManager ─────────────────────────────────────────── */
export class FileManager {
  constructor(opts = {}) {
    this._renameFile = opts.renameFile || (() => {});
    this._trashFile = opts.trashFile || (() => {});
  }

  renameFile(file, newPath) {
    return this._renameFile(file, newPath);
  }

  trashFile(file) {
    return this._trashFile(file);
  }

  generateMarkdownLink(file, sourcePath, subpath, alias) {
    const name = alias || file.name || file.path || file;
    return `[[${name}]]`;
  }
}

/* ── MetadataCache ───────────────────────────────────────── */
export class MetadataCache extends Events {
  constructor(opts = {}) {
    super();
    this._notes = opts.notes || [];
  }

  getFileCache(file) {
    const path = typeof file === 'string' ? file : (file.path || file.id);
    return this._notes.find(n => (n.rel_path || n.id) === path || n.title === path) || null;
  }

  getFirstLinkpathDest(linkpath, sourcePath) {
    return this._notes.find(n => n.title === linkpath || n.rel_path === linkpath) || null;
  }

  resolvedLinks = new Map();
  unresolvedLinks = new Map();
}

/* ── Editor Abstraction (Stub — Phase 3 will flesh out) ──── */
export class EditorPosition {
  constructor(line = 0, ch = 0) { this.line = line; this.ch = ch; }
}

export class EditorRange {
  constructor(from, to) { this.from = from; this.to = to; }
}

export class EditorSelection {
  constructor(anchor, head) { this.anchor = anchor; this.head = head || anchor; }
}

export class Editor {
  constructor(opts = {}) {
    this._getValue = opts.getValue || (() => '');
    this._setValue = opts.setValue || (() => {});
    this._getSelection = opts.getSelection || (() => '');
    this._replaceSelection = opts.replaceSelection || (() => {});
    this._getCursor = opts.getCursor || (() => new EditorPosition());
    this._setCursor = opts.setCursor || (() => {});
    this._getLine = opts.getLine || (() => '');
    this._setLine = opts.setLine || (() => {});
    this._offsetToPos = opts.offsetToPos || ((off) => new EditorPosition());
    this._posToOffset = opts.posToOffset || ((pos) => 0);
  }

  getValue() { return this._getValue(); }
  setValue(value) { this._setValue(value); }
  getSelection() { return this._getSelection(); }
  replaceSelection(value, select) { this._replaceSelection(value, select); }
  getCursor(type) { return this._getCursor(type); }
  setCursor(pos, ch) {
    if (typeof pos === 'number') pos = new EditorPosition(pos, ch || 0);
    this._setCursor(pos);
  }
  getLine(line) { return this._getLine(line); }
  setLine(line, text) { this._setLine(line, text); }
  lineCount() { return this.getValue().split('\n').length; }
  lastLine() { return this.lineCount() - 1; }
  getRange(from, to) {
    const lines = this.getValue().split('\n');
    if (from.line === to.line) return lines[from.line]?.slice(from.ch, to.ch) || '';
    let out = lines[from.line]?.slice(from.ch) || '';
    for (let i = from.line + 1; i < to.line; i++) out += '\n' + (lines[i] || '');
    out += '\n' + (lines[to.line]?.slice(0, to.ch) || '');
    return out;
  }
  replaceRange(replacement, from, to) {
    const value = this.getValue();
    const fromOff = this._posToOffset(from);
    const toOff = to ? this._posToOffset(to) : fromOff;
    this.setValue(value.slice(0, fromOff) + replacement + value.slice(toOff));
  }
  offsetToPos(offset) { return this._offsetToPos(offset); }
  posToOffset(pos) { return this._posToOffset(pos); }
  transaction(tx) {
    // Vault doesn't support CodeMirror transactions yet; apply as raw text
    if (tx.changes) {
      let value = this.getValue();
      // Apply changes in reverse offset order so replacements don't shift
      const sorted = [...tx.changes].sort((a, b) => (b.from?.offset || 0) - (a.from?.offset || 0));
      sorted.forEach(chg => {
        const from = chg.from?.offset || 0;
        const to = chg.to?.offset || value.length;
        value = value.slice(0, from) + (chg.text || '') + value.slice(to);
      });
      this.setValue(value);
    }
  }
  refresh() {}
  focus() {}
  hasFocus() { return true; }
  undo() {}
  redo() {}
}

/* ── View / MarkdownView (Stub) ──────────────────────────── */
export class View extends Component {
  constructor(leaf) { super(); this.leaf = leaf; }
  getViewType() { return 'markdown'; }
  getState() { return {}; }
  setState() { return Promise.resolve(); }
}

export class MarkdownView extends View {
  constructor(leaf) { super(leaf); }
  getViewType() { return 'markdown'; }
  getMode() { return 'source'; } // or 'preview', 'live-preview'
  editor = null; // set by vault when editor is active
}

export class WorkspaceLeaf extends Component {
  constructor() { super(); }
  getViewState() { return { type: 'markdown' }; }
  view = new MarkdownView(this);
}

/* ── UI: Notice ────────────────────────────────────────── */
export class Notice {
  constructor(message, duration = 4000) {
    // Use vault's existing toast system if available globally
    if (typeof window !== 'undefined' && window._showVaultToast) {
      window._showVaultToast(String(message), { duration, type: 'info' });
    } else if (typeof window !== 'undefined' && window.showToast) {
      window.showToast(String(message), duration);
    } else {
      console.log('[Notice]', message);
    }
  }
}

/* ── UI: PluginSettingTab + Setting ────────────────────── */
export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = null;
  }
  display() {}
  hide() {}
}

export class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.controlEl = null;
    this.nameEl = null;
    this.descEl = null;
    this._values = [];
  }

  setName(name) {
    if (!this.nameEl) {
      this.nameEl = document.createElement('div');
      this.nameEl.className = 'vault-settings-info';
      this.containerEl.appendChild(this.nameEl);
    }
    this.nameEl.innerHTML = `<span>${name}</span>`;
    return this;
  }

  setDesc(desc) {
    if (!this.descEl) {
      this.descEl = document.createElement('span');
      this.descEl.className = 'vault-settings-desc';
      if (this.nameEl) this.nameEl.appendChild(this.descEl);
      else this.containerEl.appendChild(this.descEl);
    }
    this.descEl.textContent = desc;
    return this;
  }

  addText(cb) {
    const wrap = document.createElement('div');
    wrap.className = 'vault-settings-row';
    wrap.style.gap = '12px';
    this.containerEl.appendChild(wrap);
    this.controlEl = document.createElement('input');
    this.controlEl.type = 'text';
    this.controlEl.className = 'vault-settings-input';
    const textObj = {
      inputEl: this.controlEl,
      setValue: (v) => { this.controlEl.value = v; },
      getValue: () => this.controlEl.value,
      setPlaceholder: (v) => { this.controlEl.placeholder = v; },
      onChange: (fn) => { this.controlEl.addEventListener('change', () => fn(this.controlEl.value)); },
    };
    if (cb) cb(textObj);
    wrap.appendChild(this.controlEl);
    return this;
  }

  addToggle(cb) {
    const wrap = document.createElement('div');
    wrap.className = 'vault-settings-row';
    wrap.style.gap = '12px';
    this.containerEl.appendChild(wrap);
    const label = document.createElement('label');
    label.className = 'admin-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    const slider = document.createElement('span');
    slider.className = 'admin-slider';
    label.appendChild(input);
    label.appendChild(slider);
    const toggleObj = {
      toggleEl: input,
      setValue: (v) => { input.checked = !!v; },
      getValue: () => input.checked,
      onChange: (fn) => { input.addEventListener('change', () => fn(input.checked)); },
    };
    if (cb) cb(toggleObj);
    wrap.appendChild(label);
    return this;
  }

  addSlider(cb) {
    const wrap = document.createElement('div');
    wrap.className = 'vault-settings-row';
    wrap.style.gap = '12px';
    this.containerEl.appendChild(wrap);
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'vault-settings-slider';
    const sliderObj = {
      sliderEl: input,
      setValue: (v) => { input.value = v; },
      getValue: () => parseFloat(input.value),
      setLimits: (min, max, step) => {
        input.min = min; input.max = max; input.step = step || 1;
      },
      onChange: (fn) => { input.addEventListener('input', () => fn(parseFloat(input.value))); },
      setDynamicTooltip: () => {},
    };
    if (cb) cb(sliderObj);
    wrap.appendChild(input);
    return this;
  }

  addButton(cb) {
    const wrap = document.createElement('div');
    wrap.className = 'vault-settings-row';
    wrap.style.gap = '12px';
    this.containerEl.appendChild(wrap);
    const btn = document.createElement('button');
    btn.className = 'admin-btn';
    btn.type = 'button';
    const btnObj = {
      buttonEl: btn,
      setButtonText: (v) => { btn.textContent = v; },
      setCta: () => { btn.classList.add('admin-btn-primary'); },
      onClick: (fn) => { btn.addEventListener('click', fn); },
    };
    if (cb) cb(btnObj);
    wrap.appendChild(btn);
    return this;
  }

  addDropdown(cb) {
    const wrap = document.createElement('div');
    wrap.className = 'vault-settings-row';
    wrap.style.gap = '12px';
    this.containerEl.appendChild(wrap);
    const select = document.createElement('select');
    select.className = 'vault-settings-select';
    const dropObj = {
      selectEl: select,
      addOption: (value, display) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = display || value;
        select.appendChild(opt);
      },
      setValue: (v) => { select.value = v; },
      getValue: () => select.value,
      onChange: (fn) => { select.addEventListener('change', () => fn(select.value)); },
    };
    if (cb) cb(dropObj);
    wrap.appendChild(select);
    return this;
  }

  addTextArea(cb) {
    const wrap = document.createElement('div');
    wrap.className = 'vault-settings-row';
    wrap.style.gap = '12px';
    this.containerEl.appendChild(wrap);
    const ta = document.createElement('textarea');
    ta.className = 'vault-settings-textarea';
    ta.rows = 4;
    const taObj = {
      inputEl: ta,
      setValue: (v) => { ta.value = v; },
      getValue: () => ta.value,
      setPlaceholder: (v) => { ta.placeholder = v; },
      onChange: (fn) => { ta.addEventListener('change', () => fn(ta.value)); },
    };
    if (cb) cb(taObj);
    wrap.appendChild(ta);
    return this;
  }

  addExtraButton(cb) { return this.addButton(cb); }

  then(cb) {
    if (cb) cb(this);
    return this;
  }

  clear() {
    this.containerEl.innerHTML = '';
    return this;
  }
}

/* ── Modal (Stub) ──────────────────────────────────────── */
export class Modal {
  constructor(app) {
    this.app = app;
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'vault-modal';
    this.modalEl = document.createElement('div');
    this.modalEl.className = 'vault-modal-content';
    this.titleEl = document.createElement('h3');
    this.contentEl = document.createElement('div');
    this.modalEl.appendChild(this.titleEl);
    this.modalEl.appendChild(this.contentEl);
    this.containerEl.appendChild(this.modalEl);
  }

  open() {
    document.body.appendChild(this.containerEl);
  }

  close() {
    this.containerEl.remove();
  }

  onOpen() {}
  onClose() {}
}

export class SuggestModal extends Modal {
  constructor(app, items) {
    super(app);
    this.items = items || [];
  }
  getSuggestions(query) {
    return this.items.filter(i => String(i).toLowerCase().includes(query.toLowerCase()));
  }
  renderSuggestion(value, el) { el.textContent = String(value); }
  onChooseSuggestion(item) {}
}

export class FuzzySuggestModal extends SuggestModal {
  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.items.filter(i => String(i).toLowerCase().includes(q));
  }
}

/* ── Menu (Stub) ───────────────────────────────────────── */
export class Menu {
  constructor() {
    this.items = [];
  }
  addItem(cb) {
    const item = { title: '', icon: '', callback: null, checked: false };
    cb({
      setTitle: (t) => { item.title = t; },
      setIcon: (i) => { item.icon = i; },
      onClick: (fn) => { item.callback = fn; },
      setChecked: (c) => { item.checked = c; },
    });
    this.items.push(item);
    return this;
  }
  addSeparator() {
    this.items.push({ separator: true });
    return this;
  }
  showAtMouseEvent(e) {
    console.warn('[Menu] showAtMouseEvent not fully implemented in vault');
  }
  hide() {}
}

/* ── MarkdownRenderer (Stub) ───────────────────────────── */
export class MarkdownRenderer {
  static renderMarkdown(app, markdown, el, sourcePath, component) {
    // Vault should inject its markdown parser here
    el.innerHTML = `<div class="md-content">${markdown.replace(/\n/g, '<br>')}</div>`;
    return Promise.resolve();
  }
  static render(dom, markdown, sourcePath, component) {
    dom.innerHTML = `<div class="md-content">${markdown.replace(/\n/g, '<br>')}</div>`;
    return Promise.resolve();
  }
}

export class MarkdownPostProcessorContext {
  constructor(sourcePath) { this.sourcePath = sourcePath; }
  getSectionInfo() { return null; }
}

/* ── Platform ──────────────────────────────────────────── */
export const Platform = {
  isMobile: false,
  isDesktop: true,
  isMacOS: navigator.platform?.startsWith('Mac') || false,
  isWin: navigator.platform?.startsWith('Win') || false,
  isLinux: navigator.platform?.startsWith('Linux') || false,
};

/* ── Keymap / Scope ────────────────────────────────────── */
export class Scope {
  constructor() { this._keys = []; }
  register(keys, callback) { this._keys.push({ keys, callback }); }
}

export const Keymap = {
  getRootScope() { return new Scope(); },
  isModifier(e, mod) {
    const map = { Mod: 'Control', Cmd: 'Meta' };
    return e.key === (map[mod] || mod);
  },
};

/* ── App ─────────────────────────────────────────────────── */
export class App extends Component {
  constructor(opts = {}) {
    super();
    this.vault = new Vault(opts);
    this.workspace = new Workspace(opts);
    this.fileManager = new FileManager(opts);
    this.metadataCache = new MetadataCache(opts);
    this._commands = [];
  }
}

/* ── Global require shim for Obsidian plugins ────────────── */
const _obsidianModule = {
  Plugin, Component, Events,
  Vault, TFile, TFolder, TAbstractFile,
  Workspace, WorkspaceLeaf, View, MarkdownView,
  FileManager, MetadataCache,
  Editor, EditorPosition, EditorRange, EditorSelection,
  PluginSettingTab, Setting,
  Notice, Modal, SuggestModal, FuzzySuggestModal,
  Menu,
  MarkdownRenderer, MarkdownPostProcessorContext,
  Platform, Scope, Keymap,
  App,
};

// Register as a module so `require('obsidian')` works
if (typeof window !== 'undefined') {
  window.__obsidianShim = _obsidianModule;
  if (!window.require) {
    window.require = function require(id) {
      if (id === 'obsidian') return window.__obsidianShim;
      throw new Error(`Module not found: ${id}`);
    };
  } else {
    const _origRequire = window.require;
    window.require = function require(id) {
      if (id === 'obsidian') return window.__obsidianShim;
      return _origRequire(id);
    };
  }
}

export default _obsidianModule;
