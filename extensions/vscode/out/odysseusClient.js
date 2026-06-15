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
exports.OdysseusClient = void 0;
const vscode = __importStar(require("vscode"));
class OdysseusClient {
    host;
    apiToken;
    defaultModel;
    constructor() {
        const cfg = vscode.workspace.getConfiguration('odysseus');
        this.host = cfg.get('host', 'http://127.0.0.1:7860').replace(/\/$/, '');
        this.apiToken = cfg.get('apiToken', '');
        this.defaultModel = cfg.get('model', '');
    }
    get headers() {
        const h = {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream'
        };
        if (this.apiToken) {
            h['Authorization'] = `Bearer ${this.apiToken}`;
        }
        return h;
    }
    reloadConfig() {
        const cfg = vscode.workspace.getConfiguration('odysseus');
        this.host = cfg.get('host', 'http://127.0.0.1:7860').replace(/\/$/, '');
        this.apiToken = cfg.get('apiToken', '');
        this.defaultModel = cfg.get('model', '');
    }
    async health() {
        try {
            const resp = await fetch(`${this.host}/api/health`, {
                method: 'GET',
                headers: this.headers
            });
            if (resp.ok) {
                const body = await resp.json().catch(() => ({}));
                return { ok: true, version: body.version };
            }
            return { ok: false };
        }
        catch {
            return { ok: false };
        }
    }
    async *chatStream(message, sessionId, model) {
        const body = {
            message,
            stream: true
        };
        if (sessionId) {
            body.session_id = sessionId;
        }
        if (model || this.defaultModel) {
            body.model = model || this.defaultModel;
        }
        const resp = await fetch(`${this.host}/api/chat_stream`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(body)
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => 'Unknown error');
            throw new Error(`Odysseus chat error ${resp.status}: ${text}`);
        }
        const reader = resp.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) {
                    continue;
                }
                const payload = line.slice(6).trim();
                if (!payload) {
                    continue;
                }
                if (payload === '[DONE]') {
                    return;
                }
                try {
                    const data = JSON.parse(payload);
                    const text = data.choices?.[0]?.delta?.content ?? data.content ?? data.text ?? '';
                    if (text) {
                        yield text;
                    }
                }
                catch {
                    // Non-JSON SSE lines (e.g. Odysseus custom format) — yield raw
                    yield payload;
                }
            }
        }
    }
    async listSessions() {
        const resp = await fetch(`${this.host}/api/sessions`, {
            method: 'GET',
            headers: this.headers
        });
        if (!resp.ok) {
            return [];
        }
        const body = await resp.json().catch(() => ({}));
        return body.sessions || [];
    }
    async listModels() {
        const resp = await fetch(`${this.host}/api/models`, {
            method: 'GET',
            headers: this.headers
        });
        if (!resp.ok) {
            return { items: [] };
        }
        const body = await resp.json().catch(() => ({}));
        return { items: body.items || [] };
    }
    async createSession(name, model) {
        const models = await this.listModels();
        if (!models.items.length) {
            throw new Error('No model endpoints configured. Add a model in Odysseus first (Settings → Models).');
        }
        const endpoint = models.items[0];
        const params = new URLSearchParams();
        if (name) {
            params.append('name', name);
        }
        params.append('endpoint_url', endpoint.url);
        const targetModel = model || this.defaultModel || endpoint.models[0];
        if (targetModel) {
            params.append('model', targetModel);
        }
        const resp = await fetch(`${this.host}/api/session`, {
            method: 'POST',
            headers: { ...this.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => `HTTP ${resp.status}`);
            throw new Error(`HTTP ${resp.status}: ${text}`);
        }
        return await resp.json();
    }
}
exports.OdysseusClient = OdysseusClient;
//# sourceMappingURL=odysseusClient.js.map