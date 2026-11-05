// Contrato de módulos y buscadores + el contexto que recibe cada ejecución.
//
// Un módulo es un archivo en src/modules/ que exporta por default un objeto:
//
//   export default {
//     id: 'mi_modulo',
//     name: 'Mi módulo',
//     requires: ['domicilio'],     // se dispara cuando hay un domicilio
//     provides: ['telefono'],      // informativo (para la UI)
//     cacheTtl: 3600,              // segundos de caché en Redis (0 = sin caché)
//     defaultSettings: {},
//     async run(ctx) {
//       const { data } = await ctx.getJson('https://...', { params: { q: ctx.inputs.domicilio } });
//       return { facts: { telefono: [...] }, data, summary: '1 teléfono' };
//     },
//   };
import { createHash } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import { normalize } from './facts.js';

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
export const USER_AGENT = 'condor/0.1';

// fetch con params, timeout, señal de cancelación y opción de ignorar SSL.
export async function httpFetch(url, { params, insecure = false, timeoutMs = 30_000, signal, headers, ...init } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const opts = { ...init, headers: { 'user-agent': USER_AGENT, ...headers }, signal: sig };
  return insecure ? undiciFetch(u, { ...opts, dispatcher: insecureAgent }) : fetch(u, opts);
}

export async function httpGetJson(url, opts = {}) {
  const resp = await httpFetch(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: resp.status, ok: resp.ok, data };
}

export function createContext({ runId, node, mod, inputs, facts, person, settings, llm, signal, ask }) {
  return {
    runId,
    nodeId: node.id,
    moduleId: mod.id,
    inputs,         // valores concretos que dispararon esta ejecución
    facts,          // todo lo conocido en esta rama (persona + ancestros)
    person,         // persona seleccionada
    settings,       // defaultSettings + settings del JSON
    llm,            // ctx.llm.ask(prompt, { json: true, system })
    signal,         // se aborta por timeout: pasalo a fetch si usás otro cliente
    log: (msg) => node.logs.push(`[${new Date().toLocaleTimeString('es-AR', { hour12: false })}] ${msg}`),
    first: (kind, def = null) => facts[kind]?.[0] ?? def,
    fetch: (url, opts = {}) => httpFetch(url, { signal, ...opts }),
    getJson: (url, opts = {}) => httpGetJson(url, { signal, ...opts }),
    // Pausa y le pide datos al usuario: await ctx.ask({ title, text, image, fields: [{ name, label, help }], actions: ['refresh'] })
    // -> { name: valor } | { __action: 'refresh' } | null (salteado)
    ask: ask || (async () => { throw new Error('este contexto no admite preguntas al usuario'); }),
  };
}

// Clave de deduplicación: mismo módulo + mismos datos normalizados = misma ejecución.
// Un módulo puede definir su propio dedupKey(inputs) si necesita otra noción de "mismo dato".
export function dedupKey(mod, inputs) {
  if (typeof mod.dedupKey === 'function') return `${mod.id}|${mod.dedupKey(inputs)}`;
  const parts = Object.keys(inputs).sort().map((k) => `${k}=${normalize(k, inputs[k])}`);
  return `${mod.id}|${parts.join('|')}`;
}

export const settingsHash = (s) => createHash('sha1').update(JSON.stringify(s ?? {})).digest('hex').slice(0, 10);

export function moduleMeta(m) {
  return {
    id: m.id, name: m.name || m.id, description: m.description || '',
    requires: m.requires || [], provides: m.provides || [],
    cache_ttl: m.cacheTtl || 0, default_settings: m.defaultSettings || {},
  };
}

// Buscador: export default { id, name, accepts: ['dni','cuit'], fallback?: bool, async search(ctx) -> [candidate] }
export function searcherMeta(s) {
  return {
    id: s.id, name: s.name || s.id, description: s.description || '',
    accepts: s.accepts || [], fallback: !!s.fallback, default_settings: s.defaultSettings || {},
  };
}
