// Cliente mínimo para Ollama (LLM local en Docker).
export class LLMError extends Error {}

export class LLM {
  constructor(url, model, timeoutMs = 180_000) {
    this.url = url.replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  // Pregunta al LLM. Con json: true devuelve el JSON ya parseado.
  async ask(prompt, { system, json = false, model, options, signal } = {}) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    const body = { model: model || this.model, messages, stream: false };
    if (json) body.format = 'json';
    if (options) body.options = options;

    let resp;
    try {
      resp = await fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new LLMError(`No se pudo conectar a Ollama en ${this.url}: ${e.message}`);
    }
    if (!resp.ok) throw new LLMError(`Ollama respondió ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const content = (await resp.json())?.message?.content ?? '';
    if (!json) return content;
    try {
      return JSON.parse(content);
    } catch {
      throw new LLMError(`El LLM no devolvió JSON válido: ${content.slice(0, 300)}`);
    }
  }

  async status() {
    try {
      const r = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const models = ((await r.json()).models || []).map((m) => m.name);
      const ready = models.some((m) => m === this.model || m.split(':')[0] === this.model);
      return { ok: true, url: this.url, model: this.model, model_ready: ready, models };
    } catch (e) {
      return { ok: false, url: this.url, model: this.model, error: e.message };
    }
  }
}
