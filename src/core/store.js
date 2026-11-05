// Persistencia de corridas, caché de resultados y eventos en vivo.
// RedisStore es lo normal (docker compose). Si Redis no está disponible
// (p.ej. CLI fuera de Docker sin Redis) se usa MemoryStore.
import { EventEmitter } from 'node:events';
import Redis from 'ioredis';

function summary(run) {
  const counts = {};
  for (const n of Object.values(run.nodes || {})) counts[n.status] = (counts[n.status] || 0) + 1;
  return {
    id: run.id, query: run.query, label: run.person?.label, status: run.status,
    created_at: run.created_at, finished_at: run.finished_at, counts,
  };
}

export class MemoryStore {
  name = 'memory';
  runs = new Map();
  cache = new Map();
  bus = new EventEmitter().setMaxListeners(0);

  async saveRun(run) { this.runs.set(run.id, structuredClone(run)); }
  async getRun(id) { return this.runs.get(id) ?? null; }
  async listRuns(limit = 30) {
    return [...this.runs.values()].sort((a, b) => b.created_at - a.created_at).slice(0, limit).map(summary);
  }
  async clearRuns(keep = []) {
    let n = 0;
    for (const id of [...this.runs.keys()]) if (!keep.includes(id)) { this.runs.delete(id); n++; }
    return n;
  }
  async publish(runId, event) { this.bus.emit(runId, event); }
  // Devuelve una función para desuscribirse.
  async subscribe(runId, onEvent) {
    this.bus.on(runId, onEvent);
    return () => this.bus.off(runId, onEvent);
  }
  async cacheGet(key) {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (hit.exp < Date.now()) { this.cache.delete(key); return null; }
    return hit.value;
  }
  async cacheSet(key, value, ttlSec) { this.cache.set(key, { exp: Date.now() + ttlSec * 1000, value }); }
  // Borra la caché de resultados (toda, o sólo la de un módulo).
  async cacheClear(moduleId = null) {
    let n = 0;
    for (const k of [...this.cache.keys()]) if (!moduleId || k.startsWith(`${moduleId}|`)) { this.cache.delete(k); n++; }
    return n;
  }
  async status() { return { ok: true, backend: this.name, note: 'sin Redis: nada se persiste' }; }
  async close() {}
}

export class RedisStore {
  name = 'redis';
  P = 'condor';

  constructor(client, runTtlSec = 60 * 60 * 24 * 30) {
    this.r = client;
    this.runTtl = runTtlSec;
    this.sub = null;              // conexión dedicada a pub/sub (compartida)
    this.listeners = new Map();   // channel -> Set<fn>
  }

  static async connect(url) {
    const client = new Redis(url, { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 2 });
    client.on('error', () => {}); // ioredis reintenta solo; evitamos "unhandled error"
    try {
      await Promise.race([client.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))]);
      await client.ping();
    } catch (e) {
      client.disconnect();
      throw e;
    }
    return new RedisStore(client);
  }

  async saveRun(run) {
    await this.r.multi()
      .set(`${this.P}:run:${run.id}`, JSON.stringify(run), 'EX', this.runTtl)
      .zadd(`${this.P}:runs`, run.created_at, run.id)
      .exec();
  }
  async getRun(id) {
    const raw = await this.r.get(`${this.P}:run:${id}`);
    return raw ? JSON.parse(raw) : null;
  }
  async listRuns(limit = 30) {
    const ids = await this.r.zrevrange(`${this.P}:runs`, 0, limit - 1);
    if (!ids.length) return [];
    const raws = await this.r.mget(ids.map((i) => `${this.P}:run:${i}`));
    return raws.filter(Boolean).map((x) => summary(JSON.parse(x)));
  }
  // Borra el historial de corridas (menos las que están en curso).
  async clearRuns(keep = []) {
    const ids = (await this.r.zrange(`${this.P}:runs`, 0, -1)).filter((id) => !keep.includes(id));
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await this.r.multi().del(...chunk.map((id) => `${this.P}:run:${id}`)).zrem(`${this.P}:runs`, ...chunk).exec();
    }
    return ids.length;
  }
  async publish(runId, event) {
    await this.r.publish(`${this.P}:events:${runId}`, JSON.stringify(event));
  }
  async subscribe(runId, onEvent) {
    const ch = `${this.P}:events:${runId}`;
    if (!this.sub) {
      this.sub = this.r.duplicate();
      this.sub.on('error', () => {});
      this.sub.on('message', (channel, msg) => {
        for (const fn of this.listeners.get(channel) || []) fn(JSON.parse(msg));
      });
    }
    if (!this.listeners.has(ch)) {
      this.listeners.set(ch, new Set());
      await this.sub.subscribe(ch);
    }
    this.listeners.get(ch).add(onEvent);
    return () => {
      const set = this.listeners.get(ch);
      if (!set) return;
      set.delete(onEvent);
      if (!set.size) { this.listeners.delete(ch); this.sub.unsubscribe(ch).catch(() => {}); }
    };
  }
  async cacheGet(key) {
    const raw = await this.r.get(`${this.P}:cache:${key}`);
    return raw ? JSON.parse(raw) : null;
  }
  async cacheSet(key, value, ttlSec) {
    await this.r.set(`${this.P}:cache:${key}`, JSON.stringify(value), 'EX', ttlSec);
  }
  // Borra la caché de resultados (toda, o sólo la de un módulo). No toca el historial.
  async cacheClear(moduleId = null) {
    const match = `${this.P}:cache:${moduleId ? `${moduleId}|` : ''}*`;
    let cursor = '0';
    let n = 0;
    do {
      const [next, keys] = await this.r.scan(cursor, 'MATCH', match, 'COUNT', 500);
      cursor = next;
      if (keys.length) n += await this.r.del(...keys);
    } while (cursor !== '0');
    return n;
  }
  async status() {
    try { await this.r.ping(); return { ok: true, backend: this.name }; }
    catch (e) { return { ok: false, backend: this.name, error: e.message }; }
  }
  async close() {
    this.sub?.disconnect();
    this.r.disconnect();
  }
}

export async function makeStore(url, logger = console) {
  if (url) {
    try {
      return await RedisStore.connect(url);
    } catch (e) {
      logger.warn(`[condor] Redis no disponible en ${url} (${e.message}). Uso almacenamiento en memoria.`);
    }
  }
  return new MemoryStore();
}
