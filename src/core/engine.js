// Motor: búsqueda de candidatos + ejecución del árbol de módulos.
//
// Reglas:
// - La persona seleccionada es el nodo raíz; sus facts disparan los módulos de `roots`.
// - Cuando un módulo termina OK se evalúan sus `triggers`:
//     * el hijo necesita todos sus `requires` disponibles en la rama (persona + ancestros);
//     * al menos uno de esos datos tiene que haberlo aportado el padre (si no, no lo "disparó");
//     * se ejecuta una vez por cada combinación distinta de valores.
// - Deduplicación: (módulo + datos de entrada normalizados) corre una sola vez por corrida,
//   aunque lo disparen ramas distintas. Las demás apariciones quedan como "duplicate".
// - Los módulos deshabilitados no se crean (no aparecen en el árbol de la corrida).
// - Todos los módulos corren en paralelo (hasta max_concurrency) como tareas asíncronas.
import * as F from './facts.js';
import { candidate, newId, node as newNode, now, run as newRun, Status } from './models.js';
import { createContext, dedupKey, moduleMeta, searcherMeta, settingsHash } from './module.js';

export const ROOT_MODULE = '__persona__';
const ACTIVE = new Set([Status.WAITING, Status.PENDING, Status.RUNNING, Status.INPUT]);

class TimeoutError extends Error {}

function semaphore(max) {
  let active = 0;
  const queue = [];
  const release = () => { active--; if (queue.length) { active++; queue.shift()(); } };
  return async (fn) => {
    if (active >= max) await new Promise((r) => queue.push(r));
    else active++;
    try { return await fn(); } finally { release(); }
  };
}

const jsonable = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x ?? null)));

function coerce(r) {
  if (r === null || r === undefined) return { facts: {}, data: null, view: null, summary: '' };
  if (typeof r !== 'object') throw new TypeError(`El módulo devolvió ${typeof r}; se espera { facts, data, view, summary }`);
  const view = r.view == null ? null : [r.view].flat().filter(Boolean);
  return { facts: r.facts || {}, data: r.data ?? null, view, summary: r.summary || '', noCache: !!r.noCache };
}

const autoSummary = (facts) => {
  const e = Object.entries(facts);
  return e.length ? e.map(([k, v]) => `${k} (${v.length})`).join(', ') : 'sin datos nuevos';
};

function* product(pools) {
  if (!pools.length) { yield []; return; }
  const [first, ...rest] = pools;
  for (const x of first) for (const tail of product(rest)) yield [x, ...tail];
}

export class SearchInputError extends Error {}

// Tipo elegido a mano en la UI/CLI: valida y normaliza el valor en vez de autodetectar.
export function explicitKind(kind, query) {
  const q = (query || '').trim();
  if (!q) throw new SearchInputError('Ingresá un identificador');
  if (kind === 'cuit' || kind === 'dni') {
    const d = q.replace(/\D/g, '');
    if (kind === 'cuit' && d.length !== 11) throw new SearchInputError('El CUIT/CUIL debe tener 11 dígitos');
    if (kind === 'dni' && (d.length < 6 || d.length > 8)) throw new SearchInputError('El DNI debe tener entre 6 y 8 dígitos');
    return { [kind]: [d] };
  }
  if (!/^[a-z_]+$/.test(kind)) throw new SearchInputError(`Tipo de búsqueda inválido: ${kind}`);
  return { [kind]: [q] };
}

export function mergeCandidates(cands) {
  const key = (c) => {
    for (const k of ['cuit', 'dni', 'email']) if (c.facts[k]?.length) return `${k}:${F.normalize(k, c.facts[k][0])}`;
    return `id:${c.id}`;
  };
  const merged = new Map();
  for (const c of cands) {
    c.facts = F.clean(c.facts);
    const k = key(c);
    const m = merged.get(k);
    if (m) {
      m.facts = F.merge(m.facts, c.facts);
      m.sources = [...new Set([...m.sources, c.source])];
      m.detail ||= c.detail;
    } else {
      c.sources = [c.source];
      merged.set(k, c);
    }
  }
  return [...merged.values()];
}

export class Engine {
  constructor({ store, config, llm, modules, searchers, loadErrors = [], logger = console }) {
    this.store = store;
    this.config = config;
    this.llm = llm;
    this.modules = modules;       // Map id -> módulo
    this.searchers = searchers;   // Map id -> buscador
    this.loadErrors = loadErrors;
    this.log = logger;
    this.active = new Map();      // runId -> { run, promise }
    this.pendingAsks = new Map(); // askId -> { resolve, runId, nodeId }
    // Si está definido (CLI), las preguntas de ctx.ask se responden con esta función en vez de la web.
    this.askHandler = null;
    this.config.sync([...modules.keys()], [...searchers.keys()]);
  }

  // Respuesta del usuario a un ctx.ask (desde la web). values = { campo: valor } o null para saltear.
  answer(runId, nodeId, askId, values) {
    const p = this.pendingAsks.get(askId);
    if (!p || p.runId !== runId || p.nodeId !== nodeId) return false;
    p.resolve(values);
    return true;
  }

  // Settings efectivos de un módulo: defaults + JSON.
  moduleSettings(mod, cfg = this.config.load()) {
    return {
      ...(mod.defaultSettings || {}),
      ...(mod.settingsFrom ? cfg.modules[mod.settingsFrom]?.settings || {} : {}),
      ...(cfg.modules[mod.id]?.settings || {}),
    };
  }

  // Un módulo puede definir check(settings) -> [problemas] para avisar qué le falta configurar.
  async catalog() {
    const cfg = this.config.load();
    const modules = await Promise.all([...this.modules.values()].map(async (m) => {
      let problems = [];
      if (typeof m.check === 'function') {
        try { problems = [(await m.check(this.moduleSettings(m, cfg))) || []].flat().filter(Boolean); }
        catch (e) { problems = [`check falló: ${e.message}`]; }
      }
      return { ...moduleMeta(m), problems };
    }));
    return {
      modules,
      searchers: [...this.searchers.values()].map(searcherMeta),
      errors: this.loadErrors,
      fact_types: F.KNOWN,
    };
  }

  // ---------------------------------------------------------------- búsqueda
  // Buscadores habilitados (para que la UI ofrezca elegir el método de búsqueda).
  enabledSearchers() {
    const cfg = this.config.load();
    return [...this.searchers.values()].filter((s) => cfg.searchers[s.id]?.enabled).map(searcherMeta);
  }

  // opts.kind: 'auto' (default) o un tipo explícito ('nombre', 'dni', 'cuit'…) que pisa la autodetección.
  // opts.searcher: id de un buscador puntual; si se indica, corre sólo ese (sin fallback).
  async search(query, { kind = 'auto', searcher = null } = {}) {
    const cfg = this.config.load();
    const detected = !kind || kind === 'auto' ? F.detect(query) : explicitKind(kind, query);
    const primary = [];
    const fallback = [];
    for (const [id, s] of this.searchers) {
      if (!cfg.searchers[id]?.enabled) continue;
      if (searcher && id !== searcher) continue;
      if (!(s.accepts || []).some((k) => k in detected)) continue;
      (s.fallback && !searcher ? fallback : primary).push(s);
    }
    if (searcher && !primary.length) {
      throw new SearchInputError(`El buscador '${searcher}' no está habilitado o no acepta ${Object.keys(detected)[0] || 'ese dato'}`);
    }
    let { cands, manual, errors } = await this.#runSearchers(primary, query, detected, cfg);
    if (!cands.length && !manual.length && fallback.length) {
      const more = await this.#runSearchers(fallback, query, detected, cfg);
      cands = more.cands;
      manual = more.manual;
      errors = [...errors, ...more.errors];
    }
    return { query, detected, candidates: mergeCandidates(cands), manual, errors };
  }

  async #runSearchers(list, query, detected, cfg) {
    const results = await Promise.all(list.map(async (s) => {
      const ctx = {
        query, detected, llm: this.llm, log: (m) => this.log.info?.(`[${s.id}] ${m}`),
        // settingsFrom: el buscador reutiliza los settings de un módulo (p.ej. arca_dni <- arca_padron)
        settings: {
          ...(s.defaultSettings || {}),
          ...(s.settingsFrom ? cfg.modules[s.settingsFrom]?.settings || {} : {}),
          ...(cfg.searchers[s.id]?.settings || {}),
        },
        signal: AbortSignal.timeout((s.timeout || 30) * 1000),
      };
      try {
        const res = (await s.search(ctx)) || [];
        // Un resultado con `manual: true` no es una persona: es un link para buscar a mano
        // (p.ej. Dateas) y el dato que hay que traer de vuelta (`field`, por defecto cuit).
        return {
          cands: res.filter((c) => !c.manual).map((c) => candidate({ source: s.id, ...c })),
          manual: res.filter((c) => c.manual).map((m) => ({
            source: s.id, label: m.label || s.name || s.id, detail: m.detail || '', url: m.url, field: m.field || 'cuit',
          })),
        };
      } catch (e) {
        this.log.warn(`[condor] buscador ${s.id} falló: ${e.message}`);
        return { cands: [], manual: [], error: { searcher: s.id, error: `${e.name}: ${e.message}` } };
      }
    }));
    return {
      cands: results.flatMap((r) => r.cands),
      manual: results.flatMap((r) => r.manual),
      errors: results.filter((r) => r.error).map((r) => r.error),
    };
  }

  // ---------------------------------------------------------------- ejecución
  // Arranca una corrida en background y devuelve el objeto run (se muta en vivo).
  start(person, query = '') {
    const run = newRun({ query, person: candidate(person) });
    const exe = new RunExecution(this, run, this.config.load());
    const promise = exe.go().finally(() => this.active.delete(run.id));
    this.active.set(run.id, { run, promise });
    return run;
  }

  async wait(runId) { await this.active.get(runId)?.promise; }
  isRunning(runId) { return this.active.has(runId); }

  async run(person, query = '') {
    const run = this.start(person, query);
    await this.wait(run.id);
    return run;
  }
}

class RunExecution {
  constructor(engine, run, cfg) {
    this.e = engine;
    this.run = run;
    this.cfg = cfg;
    const s = cfg.settings;
    this.limit = semaphore(Math.max(1, Number(s.max_concurrency)));
    this.maxDepth = Number(s.max_depth);
    this.defaultTimeout = Number(s.default_timeout);
    this.maxCombinations = Number(s.max_combinations);
    this.executed = new Map();  // dedupKey -> nodeId
    this.lineage = new Map();   // nodeId -> facts conocidos en la rama
    this.tasks = new Set();
  }

  mcfg(id) { return this.cfg.modules[id] || {}; }
  enabled(id) { return this.e.modules.has(id) && !!this.mcfg(id).enabled; }
  triggers(n) {
    const ids = n.id === this.run.root_id ? this.cfg.roots : this.mcfg(n.module_id).triggers || [];
    return [...new Set(ids)].filter((id) => this.enabled(id));
  }

  addNode(mod, parent) {
    const n = newNode({ moduleId: mod.id, moduleName: mod.name || mod.id, parentId: parent.id, depth: parent.depth + 1 });
    this.run.nodes[n.id] = n;
    parent.children.push(n.id);
    return n;
  }

  async emit(n) {
    try {
      await this.e.store.saveRun(this.run);
      await this.e.store.publish(this.run.id, { type: 'node', node: n });
    } catch (e) {
      this.e.log.warn(`[condor] no se pudo publicar evento: ${e.message}`); // Redis caído no corta la corrida
    }
  }

  async go() {
    const p = this.run.person;
    const root = newNode({ moduleId: ROOT_MODULE, moduleName: p.label || 'Persona', parentId: null, depth: 0, status: Status.DONE });
    Object.assign(root, { facts: F.clean(p.facts), summary: p.detail || '', started_at: now(), finished_at: now() });
    this.run.root_id = root.id;
    this.run.nodes[root.id] = root;
    this.lineage.set(root.id, root.facts);
    try {
      await this.emit(root);
      await this.expand(root);
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
      this.run.status = 'done';
    } catch (e) {
      this.e.log.error(`[condor] corrida ${this.run.id} falló:`, e);
      this.run.status = 'error';
    } finally {
      for (const n of Object.values(this.run.nodes)) {
        if (ACTIVE.has(n.status)) { n.status = Status.SKIPPED; n.reason ||= 'corrida finalizada'; }
      }
      this.run.finished_at = now();
      try {
        await this.e.store.saveRun(this.run);
        await this.e.store.publish(this.run.id, { type: 'run', status: this.run.status, finished_at: this.run.finished_at });
      } catch (e) {
        this.e.log.warn(`[condor] no se pudo guardar el final de la corrida: ${e.message}`);
      }
    }
  }

  combinations(mod, known, contributed, parent) {
    const req = mod.requires || [];
    if (!req.length) return { combos: [{}] };
    const missing = req.filter((k) => !known[k]?.length);
    if (missing.length) return { combos: [], reason: `no se encontró: ${missing.join(', ')}` };
    if (contributed && !req.some((k) => contributed[k]?.length)) {
      return { combos: [], reason: `${parent.module_name} no aportó ${req.join(' / ')}` };
    }
    const pools = req.map((k) => F.dedupe(k, contributed?.[k]?.length ? contributed[k] : known[k]).map((v) => [k, v]));
    const limit = mod.maxCombinations || this.maxCombinations;
    const combos = [];
    for (const c of product(pools)) {
      if (combos.length >= limit) break;
      combos.push(Object.fromEntries(c));
    }
    return { combos };
  }

  async expand(parent) {
    const known = this.lineage.get(parent.id);
    const contributed = parent.id === this.run.root_id ? null : parent.facts;
    const waiting = new Map();
    for (const cid of parent.children) {
      const c = this.run.nodes[cid];
      if (c.status === Status.WAITING && !waiting.has(c.module_id)) waiting.set(c.module_id, c);
    }

    for (const id of this.triggers(parent)) {
      const mod = this.e.modules.get(id);
      const placeholder = waiting.get(id);
      waiting.delete(id);
      const { combos, reason } = parent.depth + 1 > this.maxDepth
        ? { combos: [], reason: `profundidad máxima (${this.maxDepth})` }
        : this.combinations(mod, known, contributed, parent);

      if (!combos.length) {
        const n = placeholder || this.addNode(mod, parent);
        Object.assign(n, { status: Status.SKIPPED, reason, finished_at: now() });
        await this.emit(n);
        continue;
      }

      for (const [i, inputs] of combos.entries()) {
        const n = i === 0 && placeholder ? placeholder : this.addNode(mod, parent);
        n.inputs = inputs;
        n.input_key = dedupKey(mod, inputs);
        const prev = this.executed.get(n.input_key);
        if (prev) {
          Object.assign(n, { status: Status.DUPLICATE, duplicate_of: prev, reason: 'ya se ejecutó con los mismos datos', finished_at: now() });
          await this.emit(n);
          continue;
        }
        this.executed.set(n.input_key, n.id);
        Object.assign(n, { status: Status.PENDING, reason: null });
        this.lineage.set(n.id, known);
        await this.emit(n);
        await this.addWaiting(n);
        this.spawn(n, mod);
      }
    }

    for (const ph of waiting.values()) {
      Object.assign(ph, { status: Status.SKIPPED, reason: 'no aplicable', finished_at: now() });
      await this.emit(ph);
    }
  }

  // Muestra los hijos posibles como "esperando" mientras corre el padre.
  async addWaiting(n) {
    for (const id of this.triggers(n)) {
      const child = this.addNode(this.e.modules.get(id), n);
      child.reason = `esperando a ${n.module_name}`;
      await this.emit(child);
    }
  }

  // Pausa el módulo y le pide datos al usuario (web o CLI). Devuelve { campo: valor },
  // { __action: 'refresh' } si pidió otra imagen, o null si eligió saltear.
  async ask(n, spec = {}) {
    const timeoutSec = Number(spec.timeoutSec || 300);
    const ask = {
      id: newId(), title: spec.title || 'Se necesita tu respuesta', text: spec.text || '', image: spec.image || null,
      fields: spec.fields || [{ name: 'valor', label: 'Respuesta' }], actions: spec.actions || [],
      expires_at: now() + timeoutSec,
    };
    Object.assign(n, { status: Status.INPUT, ask });
    await this.emit(n);
    let timer;
    try {
      const answer = this.e.askHandler
        ? Promise.resolve(this.e.askHandler({ run: this.run, node: n, ask }))
        : new Promise((resolve) => this.e.pendingAsks.set(ask.id, { resolve, runId: this.run.id, nodeId: n.id }));
      const expired = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`sin respuesta en ${timeoutSec}s`)), timeoutSec * 1000); });
      return await Promise.race([answer, expired]);
    } finally {
      clearTimeout(timer);
      this.e.pendingAsks.delete(ask.id);
      Object.assign(n, { status: Status.RUNNING, ask: null });
      await this.emit(n);
    }
  }

  spawn(n, mod) {
    const t = this.execute(n, mod).catch((e) => this.e.log.error(`[condor] error interno en ${mod.id}:`, e));
    this.tasks.add(t);
    t.finally(() => this.tasks.delete(t));
  }

  async execute(n, mod) {
    const mc = this.mcfg(mod.id);
    const settings = this.e.moduleSettings(mod, this.cfg);
    const timeoutSec = Number(mc.timeout || mod.timeout || this.defaultTimeout);
    // la caché se invalida si cambian los datos, los settings o el código del módulo
    const cacheKey = `${n.input_key}#${settingsHash(settings)}#${mod._hash || ''}`;

    await this.limit(async () => {
      Object.assign(n, { status: Status.RUNNING, started_at: now() });
      await this.emit(n);
      const ac = new AbortController();
      const ctx = createContext({
        runId: this.run.id, node: n, mod, inputs: { ...n.inputs }, facts: this.lineage.get(n.id),
        person: this.run.person, settings, llm: this.e.llm, signal: ac.signal,
        ask: (spec) => this.ask(n, spec),
      });
      let timer;
      try {
        const hit = mod.cacheTtl ? await this.e.store.cacheGet(cacheKey) : null;
        let result;
        if (hit) {
          result = hit;
          n.cached = true;
        } else {
          const timeout = new Promise((_, rej) => {
            timer = setTimeout(() => { ac.abort(); rej(new TimeoutError()); }, timeoutSec * 1000);
          });
          result = coerce(await Promise.race([Promise.resolve().then(() => mod.run(ctx)), timeout]));
        }
        n.facts = F.clean(result.facts);
        n.data = jsonable(result.data);
        n.view = jsonable(result.view ?? null);
        n.summary = result.summary || autoSummary(n.facts);
        n.status = Status.DONE;
        if (mod.cacheTtl && !n.cached && !result.noCache) {
          await this.e.store.cacheSet(cacheKey, { facts: n.facts, data: n.data, view: n.view, summary: n.summary }, mod.cacheTtl);
        }
      } catch (e) {
        n.status = Status.ERROR;
        n.error = e instanceof TimeoutError ? `timeout (${timeoutSec}s)` : `${e.name}: ${e.message}`;
        if (!(e instanceof TimeoutError)) n.logs.push(e.stack?.split('\n').slice(0, 4).join('\n') || String(e));
      } finally {
        clearTimeout(timer);
        n.finished_at = now();
      }
      await this.emit(n);
    });

    if (n.status === Status.DONE) {
      this.lineage.set(n.id, F.merge(this.lineage.get(n.id), n.facts));
      await this.expand(n);
    } else {
      for (const cid of n.children) {
        const c = this.run.nodes[cid];
        if (c.status === Status.WAITING) {
          Object.assign(c, { status: Status.SKIPPED, reason: `falló ${n.module_name}`, finished_at: now() });
          await this.emit(c);
        }
      }
    }
  }
}

export { newId };
