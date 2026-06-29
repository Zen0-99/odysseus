/**
 * vaultSlashMenu.js — floating slash-command menu for the vault editor.
 *
 * Attach to a contenteditable editor container. When the user types `/` at the
 * start of a line or after whitespace, a Notion-style menu appears with block
 * insertion commands (Headings, Table, Database, Callout, Code, Math, Embed,
 * Attachment).
 */

const _COMMANDS = [
  { id: 'heading-1', label: 'Heading 1', icon: _headingIcon('H1'), text: '# ' },
  { id: 'heading-2', label: 'Heading 2', icon: _headingIcon('H2'), text: '## ' },
  { id: 'heading-3', label: 'Heading 3', icon: _headingIcon('H3'), text: '### ' },
  { id: 'table', label: 'Table', icon: _tableIcon(), text: '|  |  |\n| --- | --- |\n|  |  |\n' },
  { id: 'database', label: 'Database', icon: _databaseIcon(), text: () => _databaseTemplate() },
  { id: 'callout', label: 'Callout', icon: _calloutIcon(), text: '> [!note]\n> ' },
  { id: 'code', label: 'Code', icon: _codeIcon(), text: '```\n\n```\n' },
  { id: 'math', label: 'Math', icon: _mathIcon(), text: '$$\n\n$$\n' },
  { id: 'embed', label: 'Embed', icon: _embedIcon(), text: '![[]]' },
  { id: 'attachment', label: 'Attachment', icon: _attachmentIcon(), text: '![[]]()' },
];

function _randomId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function _databaseTemplate() {
  return `<!-- database: db-${_randomId()} -->\n| Name |\n| --- |\n|  |\n`;
}

function _headingIcon(text) {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><text x="7" y="17" font-size="13" font-weight="600" fill="currentColor" stroke="none">${text}</text></svg>`;
}

function _tableIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M12 5v14"/></svg>`;
}

function _databaseIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>`;
}

function _calloutIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>`;
}

function _codeIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
}

function _mathIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10"/><path d="M7 12h5"/><path d="M7 17h8"/></svg>`;
}

function _embedIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M15 12h6"/><path d="M18 9v6"/></svg>`;
}

function _attachmentIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;
}

function _esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function createVaultSlashMenu() {
  let _menu = null;
  let _editor = null;
  let _slashRange = null; // Range covering the '/' and typed query
  let _slashNode = null;
  let _slashOffset = -1;
  let _query = '';
  let _selectedIndex = 0;
  let _filtered = [];
  let _keydownHandler = null;
  let _clickAwayHandler = null;
  let _inputHandler = null;
  let _boundEditor = null;

  function _focusEditor() {
    if (!_editor) return;
    const activeSource = _editor.querySelector('.lp-line.active .lp-source');
    if (activeSource) activeSource.focus();
    else if (_editor.isContentEditable) _editor.focus();
  }

  function _hide() {
    if (_menu) { _menu.remove(); _menu = null; }
    _editor = null;
    _slashRange = null;
    _slashNode = null;
    _slashOffset = -1;
    _query = '';
    _selectedIndex = 0;
    _filtered = [];
    if (_keydownHandler) { document.removeEventListener('keydown', _keydownHandler, true); _keydownHandler = null; }
    if (_clickAwayHandler) { document.removeEventListener('click', _clickAwayHandler, true); _clickAwayHandler = null; }
  }

  function _slashRect() {
    if (!_slashRange) return null;
    const slashPos = document.createRange();
    try {
      slashPos.setStart(_slashRange.startContainer, _slashRange.startOffset);
      slashPos.setEnd(_slashRange.startContainer, _slashRange.startOffset + 1);
      const rect = slashPos.getBoundingClientRect();
      if (rect.width || rect.height) return rect;
    } catch {}
    if (_editor) return _editor.getBoundingClientRect();
    return null;
  }

  function _positionMenu() {
    if (!_menu) return;
    const rect = _slashRect();
    if (!rect) return;
    // The menu is position:fixed, so use viewport coordinates (no scroll offsets).
    let x = rect.left;
    let y = rect.bottom + 6;
    _menu.style.left = `${x}px`;
    _menu.style.top = `${y}px`;
    // Keep inside viewport the same way the right-click context menu does.
    const mRect = _menu.getBoundingClientRect();
    if (mRect.right > window.innerWidth) x = window.innerWidth - mRect.width - 8;
    if (mRect.bottom > window.innerHeight) y = window.innerHeight - mRect.height - 8;
    _menu.style.left = `${x}px`;
    _menu.style.top = `${y}px`;
  }

  function _render() {
    if (!_menu) return;
    const q = _query.toLowerCase();
    _filtered = q
      ? _COMMANDS.filter((c) => c.label.toLowerCase().includes(q) || c.id.includes(q))
      : _COMMANDS.slice();
    if (_selectedIndex >= _filtered.length) _selectedIndex = Math.max(0, _filtered.length - 1);

    if (_filtered.length === 0) {
      _menu.innerHTML = '<div class="vault-context-menu-item disabled">No commands found</div>';
      return;
    }

    _menu.innerHTML = _filtered.map((c, i) => `
      <div class="vault-context-menu-item ${i === _selectedIndex ? 'selected' : ''}" data-index="${i}">
        <span><span style="margin-right:8px;opacity:0.8;display:inline-flex;align-items:center;vertical-align:middle;">${c.icon}</span>${_esc(c.label)}</span>
      </div>
    `).join('');
  }

  function _setSelected(index) {
    if (!_menu || index === _selectedIndex || index < 0 || index >= _filtered.length) return;
    const items = _menu.querySelectorAll('.vault-context-menu-item');
    items[_selectedIndex]?.classList.remove('selected');
    _selectedIndex = index;
    items[_selectedIndex]?.classList.add('selected');
  }

  function _execute() {
    console.log('[vault slash] execute', { selectedIndex: _selectedIndex, query: _query, slashRange: !!_slashRange, slashNode: !!_slashNode, slashOffset: _slashOffset, editor: !!_editor });
    const cmd = _filtered[_selectedIndex];
    if (!cmd) {
      console.warn('[vault slash] no command at selected index');
      return _hide();
    }
    console.log('[vault slash] command', cmd.id, cmd.text);

    const slashNode = _slashNode;
    const slashOffset = _slashOffset;
    if (!slashNode || !slashNode.isConnected) {
      console.error('[vault slash] slash node is no longer in the document');
      return _hide();
    }
    if (slashNode.nodeType !== Node.TEXT_NODE) {
      console.error('[vault slash] slash node is not a text node');
      return _hide();
    }
    const nodeText = slashNode.textContent;
    if (nodeText[slashOffset] !== '/') {
      console.error('[vault slash] no slash at stored offset', nodeText, slashOffset);
      return _hide();
    }

    const text = typeof cmd.text === 'function' ? cmd.text() : cmd.text;

    // Directly replace the slash character in the text node. This is more
    // reliable than restoring the saved selection range after focus changes.
    try {
      const before = nodeText.slice(0, slashOffset);
      const after = nodeText.slice(slashOffset + 1);
      slashNode.textContent = before + text + after;
      console.log('[vault slash] replaced slash', { before, after, text, result: slashNode.textContent });

      // Move cursor to the end of the inserted command text.
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(slashNode, slashOffset + text.length);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);

      // Notify the editor so the live preview / source mode updates its state.
      const editable = slashNode.parentElement?.closest('[contenteditable="true"]') || _editor;
      if (editable && editable.dispatchEvent) {
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      }
      console.log('[vault slash] inserted command text', cmd.id, text);
    } catch (err) {
      console.error('[vault slash] failed to insert command text', err);
      document.execCommand('insertText', false, text);
    }

    _hide();
  }

  function _handleKey(e) {
    if (!_menu) return;
    console.log('[vault slash] keydown', e.key, 'menu open');
    if (e.key === 'ArrowDown' || e.key === 'Down') {
      e.preventDefault();
      e.stopPropagation();
      _setSelected(Math.min(_selectedIndex + 1, _filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'Up') {
      e.preventDefault();
      e.stopPropagation();
      _setSelected(Math.max(_selectedIndex - 1, 0));
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      _hide();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      console.log('[vault slash] Enter pressed');
      _execute();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      _focusEditor();
      _hide();
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      if (_query.length === 0) {
        _hide();
      } else {
        _query = _query.slice(0, -1);
        _selectedIndex = 0;
        _render();
      }
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      _query += e.key;
      _selectedIndex = 0;
      _render();
      return;
    }
  }

  function _show(editor, slashNode, slashOffset) {
    _query = '';
    _selectedIndex = 0;
    if (!slashNode || !slashNode.isConnected) return;
    const slashRange = document.createRange();
    slashRange.setStart(slashNode, slashOffset);
    slashRange.setEnd(slashNode, slashOffset + 1);

    _hide(); // clears _slashRange, so reassign below
    _editor = editor;
    _slashRange = slashRange;
    _slashNode = slashNode;
    _slashOffset = slashOffset;
    console.log('[vault slash] _show', slashNode.textContent, slashOffset);
    _menu = document.createElement('div');
    _menu.className = 'vault-context-menu';
    _menu.dataset.slashMenu = '1';
    // Use event delegation so item clicks/hovers survive re-renders.
    _menu.addEventListener('mousedown', (e) => {
      // Prevent the click from blurring the active editor line so the slash
      // command can still operate on the saved range.
      e.preventDefault();
    });
    _menu.addEventListener('click', (e) => {
      const item = e.target.closest('.vault-context-menu-item');
      if (!item || item.classList.contains('disabled')) return;
      _selectedIndex = Number(item.dataset.index);
      const clickedCmd = _filtered[_selectedIndex];
      console.log('[vault slash] click item', clickedCmd?.id);
      _execute();
    });
    _menu.addEventListener('mouseenter', (e) => {
      const item = e.target.closest('.vault-context-menu-item');
      if (!item || item.classList.contains('disabled')) return;
      _setSelected(Number(item.dataset.index));
    }, true);
    document.body.appendChild(_menu);
    _render();
    _positionMenu();

    _keydownHandler = (e) => _handleKey(e);
    _clickAwayHandler = (e) => {
      if (!_menu.contains(e.target)) {
        _focusEditor();
        _hide();
      }
    };
    document.addEventListener('keydown', _keydownHandler, true);
    document.addEventListener('click', _clickAwayHandler, true);
    console.log('[vault slash] keydown handler attached');
  }

  function _onInput(editor, e) {
    if (_menu) {
      // Extend the slash range to the current cursor so the whole query is replaced.
      const sel = window.getSelection();
      if (sel.rangeCount && _slashRange) {
        const range = sel.getRangeAt(0);
        try { _slashRange.setEnd(range.endContainer, range.endOffset); } catch {}
      }
      return;
    }
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent;
    const offset = range.startOffset;
    if (offset === 0 || text[offset - 1] !== '/') return;
    // Only show at start of a line or after whitespace
    const beforeSlash = text.slice(0, offset - 1);
    if (beforeSlash.length && !/\s$/.test(beforeSlash)) return;
    _show(editor, node, offset - 1);
  }

  function attach(editor) {
    if (!editor) return;
    detach();
    _boundEditor = editor;
    _inputHandler = (e) => _onInput(editor, e);
    editor.addEventListener('input', _inputHandler);
  }

  function detach() {
    _hide();
    if (_boundEditor && _inputHandler) {
      _boundEditor.removeEventListener('input', _inputHandler);
    }
    _inputHandler = null;
    _boundEditor = null;
  }

  return { attach, detach, hide: _hide };
}
