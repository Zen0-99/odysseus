/**
 * Obsidian-flavored markdown extensions:
 * - [[WikiLinks]] → clickable note links
 * - ![[Embeds]] → inline rendered content
 * - > [!INFO] Callouts → styled blocks
 * - Frontmatter strip (shown in Properties pane instead)
 */

import { mdToHtml } from './markdown.js';

const CALLOUT_TYPES = {
  info:    { icon: 'ℹ️',  class: 'callout-info' },
  warning: { icon: '⚠️',  class: 'callout-warning' },
  danger:  { icon: '⛔',  class: 'callout-danger' },
  tip:     { icon: '💡',  class: 'callout-tip' },
  note:    { icon: '📝',  class: 'callout-note' },
  quote:   { icon: '❝',   class: 'callout-quote' },
  example: { icon: '📋',  class: 'callout-example' },
};

/**
 * Convert Obsidian-flavored markdown to HTML.
 * @param {string} rawContent - Raw note markdown
 * @param {Map<string,object>} noteCache - Map of note title → note object for resolving links
 * @param {Set<string>} embedChain - Track embed chain to prevent circular embeds
 */
export function obsidianMdToHtml(rawContent, noteCache = new Map(), embedChain = new Set()) {
  let s = rawContent ?? '';

  // 1. Strip frontmatter
  s = _stripFrontmatter(s);

  // 2. Extract embeds ![[Note Title]] before wikilinks so we don't double-process
  const embedBlocks = [];
  s = s.replace(/!\[\[([^\]]+)\]\]/g, (_, title) => {
    const t = title.trim();
    const placeholder = `___EMBED_${embedBlocks.length}___`;
    if (embedChain.has(t)) {
      embedBlocks.push(`<div class="obsidian-embed-error">Circular embed: ${escapeHtml(t)}</div>`);
      return placeholder;
    }
    const target = noteCache.get(t);
    if (!target) {
      embedBlocks.push(`<div class="obsidian-embed-error">Embed not found: ${escapeHtml(t)}</div>`);
      return placeholder;
    }
    const nextChain = new Set(embedChain);
    nextChain.add(t);
    const inner = obsidianMdToHtml(target.content || '', noteCache, nextChain);
    embedBlocks.push(`<div class="obsidian-embed" data-embed-title="${escapeHtml(t)}">${inner}</div>`);
    return placeholder;
  });

  // 3. Convert wikilinks [[Note Title]] → <a class="wikilink">
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
    const t = title.trim();
    const exists = noteCache.has(t);
    return `<a class="wikilink ${exists ? '' : 'ghost'}" data-note="${escapeHtml(t)}">${escapeHtml(t)}</a>`;
  });

  // 4. Convert callouts > [!TYPE] Title\n> ...
  const calloutBlocks = [];
  s = s.replace(/^>\s*\[!([A-Za-z]+)\]\s*(.*?)\n((?:>.*\n?)*)/gm, (match, type, title, body) => {
    const cfg = CALLOUT_TYPES[type.toLowerCase()] || CALLOUT_TYPES.note;
    const cleanBody = body.replace(/^>\s?/gm, '').trim();
    const placeholder = `___CALLOUT_${calloutBlocks.length}___`;
    // We can't run obsidianMdToHtml recursively on callout body because it would
    // re-process wikilinks that are already processed. Instead, run mdToHtml on
    // the clean body, but we need to do this after the main mdToHtml pass.
    calloutBlocks.push({ cfg, title: title.trim(), body: cleanBody });
    return placeholder;
  });

  // 5. Run standard markdown → HTML
  let html = mdToHtml(s);

  // 6. Restore embeds
  html = html.replace(/___EMBED_(\d+)___/g, (_, i) => embedBlocks[+i] || '');

  // 7. Restore callouts (render body with mdToHtml now)
  html = html.replace(/___CALLOUT_(\d+)___/g, (_, i) => {
    const c = calloutBlocks[+i];
    if (!c) return '';
    const bodyHtml = mdToHtml(c.body);
    return `<div class="obsidian-callout ${c.cfg.class}">
      <div class="obsidian-callout-title"><span class="obsidian-callout-icon">${c.cfg.icon}</span> ${escapeHtml(c.title)}</div>
      <div class="obsidian-callout-body">${bodyHtml}</div>
    </div>`;
  });

  return html;
}

function _stripFrontmatter(s) {
  return s.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Build a note cache from an array of notes for wikilink resolution.
 * @param {Array} notes
 * @returns {Map<string, object>}
 */
export function buildNoteCache(notes) {
  const cache = new Map();
  for (const n of notes) {
    if (n.title) cache.set(n.title, n);
  }
  return cache;
}
