import * as vscode from 'vscode';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class OdysseusClient {
  private host: string;
  private apiToken: string;
  private defaultModel: string;

  constructor() {
    const cfg = vscode.workspace.getConfiguration('odysseus');
    this.host = cfg.get<string>('host', 'http://127.0.0.1:7860').replace(/\/$/, '');
    this.apiToken = cfg.get<string>('apiToken', '');
    this.defaultModel = cfg.get<string>('model', '');
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    };
    if (this.apiToken) {
      h['Authorization'] = `Bearer ${this.apiToken}`;
    }
    return h;
  }

  public reloadConfig(): void {
    const cfg = vscode.workspace.getConfiguration('odysseus');
    this.host = cfg.get<string>('host', 'http://127.0.0.1:7860').replace(/\/$/, '');
    this.apiToken = cfg.get<string>('apiToken', '');
    this.defaultModel = cfg.get<string>('model', '');
  }

  public async health(): Promise<{ ok: boolean; version?: string }> {
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
    } catch {
      return { ok: false };
    }
  }

  public async *chatStream(message: string, sessionId?: string, model?: string): AsyncGenerator<string, void, unknown> {
    const body: Record<string, any> = {
      message,
      stream: true
    };
    if (sessionId) { body.session_id = sessionId; }
    if (model || this.defaultModel) { body.model = model || this.defaultModel; }

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
    if (!reader) { throw new Error('No response body'); }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) { continue; }
        const payload = line.slice(6).trim();
        if (!payload) { continue; }
        if (payload === '[DONE]') { return; }
        try {
          const data = JSON.parse(payload);
          const text = data.choices?.[0]?.delta?.content ?? data.content ?? data.text ?? '';
          if (text) { yield text; }
        } catch {
          // Non-JSON SSE lines (e.g. Odysseus custom format) — yield raw
          yield payload;
        }
      }
    }
  }

  public async listSessions(): Promise<Array<{ id: string; name: string; model?: string }>> {
    const resp = await fetch(`${this.host}/api/sessions`, {
      method: 'GET',
      headers: this.headers
    });
    if (!resp.ok) { return []; }
    const body = await resp.json().catch(() => ({}));
    return body.sessions || [];
  }

  public async listModels(): Promise<{ items: Array<{ url: string; models: string[]; endpoint_id: string; endpoint_name: string }> }> {
    const resp = await fetch(`${this.host}/api/models`, {
      method: 'GET',
      headers: this.headers
    });
    if (!resp.ok) { return { items: [] }; }
    const body = await resp.json().catch(() => ({}));
    return { items: body.items || [] };
  }

  public async createSession(name?: string, model?: string): Promise<{ id: string; name?: string; title?: string }> {
    const models = await this.listModels();
    if (!models.items.length) {
      throw new Error('No model endpoints configured. Add a model in Odysseus first (Settings → Models).');
    }

    const endpoint = models.items[0];
    const params = new URLSearchParams();
    if (name) { params.append('name', name); }
    params.append('endpoint_url', endpoint.url);
    const targetModel = model || this.defaultModel || endpoint.models[0];
    if (targetModel) { params.append('model', targetModel); }

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
