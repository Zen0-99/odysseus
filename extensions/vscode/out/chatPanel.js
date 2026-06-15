"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatPanelProvider = void 0;
const vscode = __importStar(require("vscode"));
const odysseusClient_1 = require("./odysseusClient");
class ChatPanelProvider {
    _extensionUri;
    static viewType = 'odysseus.chatPanel';
    _view;
    _client;
    _messages = [];
    _sessionId;
    _isStreaming = false;
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
        this._client = new odysseusClient_1.OdysseusClient();
    }
    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._getHtml();
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'send':
                    if (msg.text) {
                        await this._handleSend(msg.text);
                    }
                    break;
                case 'newSession':
                    await this._handleNewSession(msg.model);
                    break;
                case 'loadModels':
                    await this._loadModels();
                    break;
                case 'reloadConfig':
                    this._client.reloadConfig();
                    vscode.window.showInformationMessage('Odysseus config reloaded');
                    break;
            }
        });
    }
    async _handleSend(text) {
        if (!text.trim() || this._isStreaming) {
            return;
        }
        this._messages.push({ role: 'user', content: text });
        this._postMessage({ type: 'addMessage', role: 'user', content: text });
        this._isStreaming = true;
        this._postMessage({ type: 'setStreaming', value: true });
        let assistantText = '';
        const assistantIndex = this._messages.length;
        this._messages.push({ role: 'assistant', content: '' });
        this._postMessage({ type: 'addMessage', role: 'assistant', content: '' });
        try {
            for await (const chunk of this._client.chatStream(text, this._sessionId)) {
                assistantText += chunk;
                this._messages[assistantIndex].content = assistantText;
                this._postMessage({ type: 'updateMessage', index: assistantIndex, content: assistantText });
            }
        }
        catch (err) {
            const errorMsg = `Error: ${err.message || String(err)}`;
            this._messages[assistantIndex].content = errorMsg;
            this._postMessage({ type: 'updateMessage', index: assistantIndex, content: errorMsg });
        }
        finally {
            this._isStreaming = false;
            this._postMessage({ type: 'setStreaming', value: false });
        }
    }
    async _handleNewSession(model) {
        try {
            const session = await this._client.createSession('VS Code Chat', model);
            this._sessionId = session.id;
            this._messages = [];
            this._postMessage({ type: 'clearMessages' });
            this._postMessage({ type: 'setSession', id: session.id, title: session.name || session.title || 'New Chat' });
        }
        catch (err) {
            vscode.window.showErrorMessage(`Failed to create session: ${err.message}`);
        }
    }
    async _loadModels() {
        try {
            const result = await this._client.listModels();
            const models = result.items.flatMap(ep => (ep.models || []).map(m => ({
                id: m,
                name: m.split('/').pop() || m,
                endpoint: ep.endpoint_name || ep.endpoint_id
            })));
            this._postMessage({ type: 'setModels', models });
        }
        catch {
            this._postMessage({ type: 'setModels', models: [] });
        }
    }
    _postMessage(msg) {
        this._view?.webview.postMessage(msg);
    }
    _getHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Top tab bar */
    #tab-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12));
      background: var(--vscode-sideBar-background);
    }
    #tab-new {
      width: 22px; height: 22px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 15px;
      line-height: 1;
      padding: 0;
      flex-shrink: 0;
    }
    #tab-new:hover { background: var(--vscode-toolbar-hoverBackground); }
    #tab-title {
      font-size: 12px;
      opacity: 0.85;
      padding: 2px 8px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Messages */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .msg-row {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .msg-row.user { flex-direction: row-reverse; }
    .msg-avatar {
      width: 26px; height: 26px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px;
      font-weight: 600;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .msg-row.assistant .msg-avatar {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .msg-row.user .msg-avatar {
      background: var(--vscode-button-secondaryBackground, var(--vscode-editor-inactiveSelectionBackground));
      color: var(--vscode-foreground);
    }
    .msg-bubble {
      max-width: calc(100% - 40px);
      padding: 10px 14px;
      border-radius: 14px;
      word-wrap: break-word;
      white-space: pre-wrap;
      line-height: 1.5;
      font-size: 13px;
    }
    .msg-row.assistant .msg-bubble {
      background: var(--vscode-editor-inactiveSelectionBackground);
      color: var(--vscode-foreground);
      border-bottom-left-radius: 4px;
    }
    .msg-row.user .msg-bubble {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-bottom-right-radius: 4px;
    }
    .msg-bubble.error {
      background: var(--vscode-inputValidation-errorBackground) !important;
      color: var(--vscode-inputValidation-errorForeground) !important;
    }

    /* Bottom panel */
    #bottom-panel {
      padding: 8px 12px 10px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12));
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #input-wrap {
      position: relative;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 18px;
      padding: 12px 48px 12px 16px;
      min-height: 48px;
    }
    #input-wrap:focus-within {
      border-color: var(--vscode-focusBorder);
    }
    #input {
      width: 100%;
      border: none;
      outline: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: 13px;
      resize: none;
      min-height: 22px;
      max-height: 120px;
      line-height: 1.4;
    }
    #input::placeholder { opacity: 0.45; }
    #send-btn {
      position: absolute;
      right: 10px;
      bottom: 10px;
      width: 28px; height: 28px;
      border-radius: 50%;
      border: none;
      background: #4a86ff;
      color: #fff;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px;
      padding: 0;
      line-height: 1;
    }
    #send-btn:hover { opacity: 0.9; }
    #send-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    /* Bottom toolbar row - exactly like Cascade */
    #bottom-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 4px;
    }
    #bt-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
    }
    .pill {
      display: flex; align-items: center; gap: 4px;
      padding: 3px 10px;
      border-radius: 12px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      font-size: 11px;
      cursor: pointer;
      user-select: none;
      opacity: 0.9;
    }
    .pill:hover { opacity: 1; }
    .pill.active {
      background: #4a86ff;
      color: #fff;
      border-color: #4a86ff;
      opacity: 1;
    }
    #model-select {
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      outline: none;
      opacity: 0.8;
      padding: 0;
      max-width: 140px;
    }
    #model-select:hover { opacity: 1; }
    #bt-right {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
    }
    #bt-status {
      opacity: 0.6;
      font-size: 11px;
    }
    .agent-label {
      display: flex; align-items: center; gap: 4px;
      font-size: 12px;
      opacity: 0.8;
    }

    /* Chips row */
    #chips-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 4px;
    }
    .chip {
      display: flex; align-items: center; gap: 3px;
      padding: 2px 8px;
      border-radius: 10px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      cursor: pointer;
      font-size: 11px;
      opacity: 0.65;
    }
    .chip:hover { opacity: 1; }

    #empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      opacity: 0.35;
      font-size: 13px;
      text-align: center;
      padding: 20px;
    }
    .hidden { display: none !important; }
    .typing-dot {
      display: inline-block;
      width: 5px; height: 5px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.4;
      animation: blink 1.4s infinite both;
      margin: 0 1px;
    }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink {
      0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
      40% { opacity: 0.9; transform: scale(1); }
    }
  </style>
</head>
<body>
  <div id="tab-bar">
    <button id="tab-new" title="New chat">+</button>
    <span id="tab-title">New Chat</span>
  </div>

  <div id="empty-state">
    <div style="font-size:28px; margin-bottom:4px;">O</div>
    <div>Start a new chat to talk with Odysseus</div>
  </div>
  <div id="messages" class="hidden"></div>

  <div id="bottom-panel">
    <div id="input-wrap">
      <textarea id="input" placeholder="Ask anything (Ctrl+L)" rows="1"></textarea>
      <button id="send-btn" title="Send">&#8593;</button>
    </div>

    <div id="bottom-toolbar">
      <div id="bt-left">
        <div class="pill active" id="code-mode" title="Code mode"><span>&lt;/&gt;</span><span>Code</span></div>
        <select id="model-select">
          <option>No models</option>
        </select>
      </div>
      <div id="bt-right">
        <span id="bt-status"></span>
        <span class="agent-label">O</span>
      </div>
    </div>

    <div id="chips-row">
      <div class="chip" title="Local context">Local</div>
      <div class="chip" title="Current workspace">Project: odysseus</div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const emptyStateEl = document.getElementById('empty-state');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send-btn');
    const tabNewBtn = document.getElementById('tab-new');
    const tabTitleEl = document.getElementById('tab-title');
    const modelSelect = document.getElementById('model-select');
    const btStatusEl = document.getElementById('bt-status');
    let messageEls = [];
    let isStreaming = false;
    let models = [];
    let activeModel = '';

    function setView(hasMessages) {
      if (hasMessages) {
        emptyStateEl.classList.add('hidden');
        messagesEl.classList.remove('hidden');
      } else {
        emptyStateEl.classList.remove('hidden');
        messagesEl.classList.add('hidden');
      }
    }

    sendBtn.addEventListener('click', () => {
      const text = inputEl.value.trim();
      if (!text || isStreaming) return;
      vscode.postMessage({ type: 'send', text });
      inputEl.value = '';
      inputEl.style.height = '20px';
      setView(true);
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
      }
    });

    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    tabNewBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'newSession', model: activeModel });
    });

    modelSelect.addEventListener('change', () => {
      activeModel = modelSelect.value;
    });

    vscode.postMessage({ type: 'loadModels' });

    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'addMessage':
          const row = document.createElement('div');
          row.className = 'msg-row ' + msg.role;
          const avatar = document.createElement('div');
          avatar.className = 'msg-avatar';
          avatar.textContent = msg.role === 'user' ? 'You' : 'O';
          const bubble = document.createElement('div');
          bubble.className = 'msg-bubble ' + msg.role;
          bubble.textContent = msg.content;
          row.appendChild(avatar);
          row.appendChild(bubble);
          messagesEl.appendChild(row);
          messageEls.push(bubble);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          setView(true);
          break;
        case 'updateMessage':
          if (messageEls[msg.index]) {
            messageEls[msg.index].textContent = msg.content;
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
          break;
        case 'clearMessages':
          messagesEl.innerHTML = '';
          messageEls = [];
          setView(false);
          break;
        case 'setStreaming':
          isStreaming = msg.value;
          sendBtn.disabled = isStreaming;
          btStatusEl.textContent = isStreaming ? 'Thinking...' : '';
          if (isStreaming && messageEls.length) {
            const last = messageEls[messageEls.length - 1];
            if (!last.textContent.trim()) {
              last.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
            }
          }
          break;
        case 'setSession':
          tabTitleEl.textContent = msg.title || ('Session ' + msg.id.slice(0, 6));
          break;
        case 'setModels':
          models = msg.models || [];
          modelSelect.innerHTML = '';
          if (!models.length) {
            const opt = document.createElement('option');
            opt.textContent = 'No models';
            modelSelect.appendChild(opt);
            activeModel = '';
          } else {
            models.forEach(m => {
              const opt = document.createElement('option');
              opt.value = m.id;
              opt.textContent = m.name;
              modelSelect.appendChild(opt);
            });
            activeModel = models[0].id;
            modelSelect.value = activeModel;
          }
          break;
      }
    });
  </script>
</body>
</html>`;
    }
}
exports.ChatPanelProvider = ChatPanelProvider;
//# sourceMappingURL=chatPanel.js.map