// Registro Único de Audiencias de Gestión de Intereses: copia local (SQLite) de todas las audiencias.
//
// Fuente: la API JSON pública que usa https://audiencias.mininterior.gob.ar/ (no documentada):
//   GET /api/public/audiencias?date_from=AAAA-MM-DD&date_to=AAAA-MM-DD&per_page=1000&view=export
// `view=export` trae el detalle completo (funcionario, solicitante, representado, participantes con
// documento). date_from/date_to filtran por fecha de la audiencia (inclusive).
//
// La API ordena sólo por fecha, así que paginar en profundidad no es estable (empates). En vez de
// paginar, se parte el rango de fechas por la mitad hasta que cada ventana entra en una página de
// 1000. Cada año se reemplaza completo en una transacción: lo que la API ya no devuelve en ese año
// (borrado o movido de fecha) desaparece de la base.
//
// Actualización incremental: por cada año se compara la cantidad en la API con la local y se
// rebajan los años que difieren, más el año en curso y los futuros (hay audiencias con fecha
// futura, y se cargan días después de ocurrir). Ediciones de años viejos que no cambian la
// cantidad sólo se ven con --completo.
//
// Los datos abiertos de datos.gob.ar (CSV por año) no se usan: llegan hasta agosto 2025 y tienen
// dos formatos distintos; la API cubre todo el período con un solo esquema.
import fs from 'node:fs';
import path from 'node:path';
import { dniFromCuit } from '../core/ar.js';
import { httpGetJson } from '../core/module.js';

export const BASE = 'https://audiencias.mininterior.gob.ar';
const API = `${BASE}/api/public/audiencias`;
const DATA_DIR = process.env.CONDOR_DATA ?? 'data';
export const DB_PATH = path.resolve(DATA_DIR, 'audiencias.db');
const PAGE = 1000;
// Pausa mínima entre llamadas a la API (segundos). --delay en la CLI o AUDIENCIAS_DELAY.
export const DEFAULT_DELAY = Number(process.env.AUDIENCIAS_DELAY ?? 10);
let delayMs = DEFAULT_DELAY * 1000;
let ultimaLlamada = 0;
export const llamadas = { n: 0 };
const PRIMER_ANIO = 2003; // el registro arranca con el Decreto 1172/2003

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS audiencias (
    id INTEGER PRIMARY KEY, identificador TEXT, fecha TEXT, hora TEXT, fecha_api TEXT, fecha_solicitud TEXT,
    estado TEXT, tipo TEXT, interes TEXT, motivo TEXT, sintesis TEXT, lugar TEXT, direccion TEXT,
    dependencia_id INTEGER, dependencia TEXT, cargo_funcionario TEXT,
    representacion TEXT, representa_tipo TEXT, representa_nombre TEXT, representa_cuit TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_aud_fecha_api ON audiencias(fecha_api);
  -- rol: funcionario | solicitante | participante | representado (persona humana representada)
  CREATE TABLE IF NOT EXISTS personas (
    audiencia_id INTEGER NOT NULL, rol TEXT NOT NULL, documento TEXT, nombre TEXT, pais TEXT,
    ocupacion TEXT, presente INTEGER
  );
  CREATE INDEX IF NOT EXISTS ix_per_doc ON personas(documento);
  CREATE INDEX IF NOT EXISTS ix_per_aud ON personas(audiencia_id);
  CREATE TABLE IF NOT EXISTS ventanas (desde TEXT PRIMARY KEY, hasta TEXT, total INTEGER, importado TEXT);
`;

let sqlite = null;
// exclusive: para escribir (ver openDb en sociedades.js: evita el mmap del -shm en ./data montado en Docker).
async function openDb(file = DB_PATH, { create = false, exclusive = false } = {}) {
  if (!create && !fs.existsSync(file)) return null;
  sqlite ??= await import('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  if (exclusive) {
    try {
      db.exec('PRAGMA busy_timeout = 30000; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    } catch (e) {
      db.close();
      throw Object.assign(new Error(`no se pudo tomar la base de audiencias en exclusiva (${e.message})`), { locked: true });
    }
  }
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

// La web suelta la base a los 60 s sin uso: si está tomada, se reintenta un rato.
async function openParaEscribir(file, log) {
  for (let i = 0; ; i++) {
    try { return await openDb(file, { create: true, exclusive: true }); } catch (e) {
      if (!e.locked || i >= 6) throw new Error(`${e.message}. Otro proceso la tiene abierta; reiniciá la app (docker compose restart app) y volvé a correr`);
      if (i === 0) log('  la base está en uso (la web la suelta al minuto sin consultas); esperando…');
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

// Documento normalizado: sin puntos/espacios ni ceros a la izquierda; pasaportes en mayúsculas.
export const normDoc = (x) => String(x ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^0+/, '') || null;

// ------------------------------------------------------------------ fechas (AAAA-MM-DD, UTC)
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => fmt(new Date(toDate(s).getTime() + n * 86_400_000));
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86_400_000);

// Ventanas de importación: antes del registro, un año por ventana, y todo lo futuro junto.
export function ventanas(hoy = new Date()) {
  const y = hoy.getUTCFullYear();
  const out = [{ desde: '1900-01-01', hasta: `${PRIMER_ANIO}-12-31`, nombre: `≤${PRIMER_ANIO}` }];
  for (let a = PRIMER_ANIO + 1; a <= y + 1; a++) out.push({ desde: `${a}-01-01`, hasta: `${a}-12-31`, nombre: String(a) });
  out.push({ desde: `${y + 2}-01-01`, hasta: '2999-12-31', nombre: `≥${y + 2}` });
  return out;
}

// ------------------------------------------------------------------ API
// Respeta delayMs desde el final de la llamada anterior (también entre reintentos).
async function esperarTurno(signal) {
  const falta = ultimaLlamada + delayMs - Date.now();
  if (falta > 0) await new Promise((res, rej) => {
    const t = setTimeout(res, falta);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
  });
}

async function api(params, { signal, intentos = 4 } = {}) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    await esperarTurno(signal);
    llamadas.n++;
    try {
      const r = await httpGetJson(API, { params, timeoutMs: 180_000, signal });
      if (r.ok && r.data && Array.isArray(r.data.data)) return r.data;
      ultimo = new Error(`HTTP ${r.status}${r.data?.message ? `: ${r.data.message}` : ''}`);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) break;
    } catch (e) { ultimo = e; } finally { ultimaLlamada = Date.now(); }
    // backoff extra además del delay entre llamadas
    await new Promise((res) => setTimeout(res, [2_000, 5_000, 15_000, 30_000][i]));
  }
  throw new Error(`API de audiencias (${JSON.stringify(params)}): ${ultimo?.message}`);
}

export const contar = async (desde, hasta, opts) => (await api({ date_from: desde, date_to: hasta, per_page: 1 }, opts)).total ?? 0;

// Todas las audiencias de [desde, hasta], partiendo el rango hasta que cada parte entra en una página.
// Para ahorrar llamadas no se cuenta antes: se pide la página directamente y, si la API informa más de
// 1000, se descarta y se parte el rango en tramos proporcionales a la cantidad (no por la mitad).
// `total`: cantidad ya conocida (evita pedir una página que se sabe que no entra).
async function descargar(desde, hasta, total, opts) {
  if (total === 0) return [];
  if (total == null || total <= PAGE) {
    for (let i = 0; i < 3; i++) {
      const d = await api({ date_from: desde, date_to: hasta, per_page: PAGE, page: 1, view: 'export' }, opts);
      if (d.total > PAGE) return descargar(desde, hasta, d.total, opts);
      if (d.data.length === d.total) return d.data;
    }
    throw new Error(`${desde}..${hasta}: la API devolvió una cantidad distinta de la que informa`);
  }
  if (desde === hasta) {
    // un solo día con más de 1000 audiencias: no se puede partir más, se pagina y se deduplica.
    const porId = new Map();
    for (let p = 1; p <= Math.ceil(total / PAGE) + 1; p++) {
      const d = await api({ date_from: desde, date_to: hasta, per_page: PAGE, page: p, view: 'export' }, opts);
      for (const a of d.data) porId.set(a.id, a);
      if (!d.data.length) break;
    }
    if (porId.size < total) throw new Error(`${desde}: ${total} audiencias en un solo día y la paginación trajo ${porId.size}`);
    return [...porId.values()];
  }
  // Tramos de igual cantidad de días, apuntando a ~700 por tramo (las audiencias no son parejas en el tiempo).
  const dias = daysBetween(desde, hasta) + 1;
  const partes = Math.min(dias, Math.max(2, Math.ceil(total / 700)));
  const out = [];
  for (let k = 0; k < partes; k++) {
    const a = addDays(desde, Math.floor((k * dias) / partes));
    const b = k === partes - 1 ? hasta : addDays(desde, Math.floor(((k + 1) * dias) / partes) - 1);
    out.push(...await descargar(a, b, null, opts));
  }
  return out;
}

// ------------------------------------------------------------------ registro de la API -> filas
const persona = (x) => x?.person ?? {};

export function filas(a) {
  const ob = a.obligee ?? {};
  const ap = a.applicant ?? {};
  const ent = ap.represented_entity ?? null;
  const fechaApi = String(a.date ?? '').slice(0, 10);
  const aud = {
    id: a.id, identificador: a.identifier ?? null,
    fecha: a.local_date ?? fechaApi, hora: a.local_time ?? (String(a.date ?? '').slice(11, 16) || null), fecha_api: fechaApi,
    fecha_solicitud: a.request_date ?? null, estado: a.status ?? null, tipo: a.type ?? null, interes: a.interest_type ?? null,
    motivo: a.motif ?? null, sintesis: a.summary ?? null, lugar: a.place ?? null, direccion: a.address ?? null,
    dependencia_id: a.dependency_id ?? null, dependencia: ob.dependency_name ?? a.dependency?.name ?? null,
    cargo_funcionario: ob.position ?? null,
    representacion: ap.representation_type ?? null, representa_tipo: ent?.entity_type ?? null,
    representa_nombre: ent?.entity_name ?? null, representa_cuit: ent?.cuit ?? null,
  };
  const per = (rol, x, extra = {}) => {
    const p = persona(x);
    return { audiencia_id: a.id, rol, documento: normDoc(p.document), nombre: p.name ?? null, pais: p.country ?? null, ocupacion: x?.occupation ?? null, presente: typeof x?.present === 'boolean' ? Number(x.present) : null, ...extra };
  };
  const personas = [];
  if (a.obligee) personas.push(per('funcionario', ob, { ocupacion: ob.position ?? null }));
  if (a.applicant) personas.push(per('solicitante', ap));
  for (const p of a.participants ?? a.other_participants?.items ?? []) personas.push(per('participante', p));
  // Persona humana representada: la API no da su documento, sólo la CUIT (si la cargaron).
  if (ent?.entity_type === 'individual_person') {
    personas.push({ audiencia_id: a.id, rol: 'representado', documento: normDoc(dniFromCuit(ent.cuit)), nombre: ent.entity_name ?? null, pais: null, ocupacion: null, presente: null });
  }
  return { aud, personas };
}

// Reemplaza todas las audiencias de [desde, hasta] (por fecha de la API) por `registros`.
function reemplazar(db, { desde, hasta }, registros, total) {
  const cols = ['id', 'identificador', 'fecha', 'hora', 'fecha_api', 'fecha_solicitud', 'estado', 'tipo', 'interes', 'motivo', 'sintesis', 'lugar', 'direccion', 'dependencia_id', 'dependencia', 'cargo_funcionario', 'representacion', 'representa_tipo', 'representa_nombre', 'representa_cuit'];
  const insA = db.prepare(`INSERT OR REPLACE INTO audiencias (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  const pcols = ['audiencia_id', 'rol', 'documento', 'nombre', 'pais', 'ocupacion', 'presente'];
  const insP = db.prepare(`INSERT INTO personas (${pcols.join(',')}) VALUES (${pcols.map(() => '?').join(',')})`);
  const delP = db.prepare('DELETE FROM personas WHERE audiencia_id = ?');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM personas WHERE audiencia_id IN (SELECT id FROM audiencias WHERE fecha_api BETWEEN ? AND ?)').run(desde, hasta);
    const borradas = db.prepare('DELETE FROM audiencias WHERE fecha_api BETWEEN ? AND ?').run(desde, hasta).changes;
    for (const r of registros) {
      const { aud, personas } = filas(r);
      delP.run(aud.id); // por si estaba en otra ventana (cambió de fecha)
      insA.run(...cols.map((c) => aud[c]));
      for (const p of personas) insP.run(...pcols.map((c) => p[c]));
    }
    db.prepare('INSERT OR REPLACE INTO ventanas VALUES (?, ?, ?, ?)').run(desde, hasta, total, new Date().toISOString());
    db.exec('COMMIT');
    return { borradas };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const contarLocal = (db, { desde, hasta }) => db.prepare('SELECT COUNT(*) AS c FROM audiencias WHERE fecha_api BETWEEN ? AND ?').get(desde, hasta).c;

// completo: rebaja todos los años. Si no, sólo los que difieren de la API + año en curso y futuros.
export async function sincronizar({ completo = false, delay = DEFAULT_DELAY, desde = 0, signal } = {}, log = console.log, file = DB_PATH) {
  const n = (x) => Number(x).toLocaleString('es-AR');
  delayMs = Math.max(0, Number(delay) || 0) * 1000;
  const llamadas0 = llamadas.n;
  const hoy = new Date();
  const anioActual = hoy.getUTCFullYear();
  // desde: sólo años >= desde (la ventana de años anteriores al registro cuenta como el primero)
  const lista = ventanas(hoy).filter((w) => !desde || Number(w.hasta.slice(0, 4)) >= desde);

  const lectura = await openDb(file, { create: true });
  const locales = Object.fromEntries(lista.map((w) => [w.desde, contarLocal(lectura, w)]));
  lectura.close();

  log(`Registro Único de Audiencias → ${file} (${delayMs / 1000} s entre llamadas)`);
  const hechas = [];
  for (const w of lista) {
    const total = await contar(w.desde, w.hasta, { signal });
    const local = locales[w.desde];
    const vigente = Number(w.desde.slice(0, 4)) >= anioActual;
    if (!completo && !vigente && total === local) continue;
    if (!total && !local) continue;
    const t0 = Date.now();
    log(`  ${w.nombre}: ${n(total)} audiencias en la API${local ? ` (${n(local)} en la base)` : ''}, descargando…`);
    const registros = await descargar(w.desde, w.hasta, total, { signal });
    const db = await openParaEscribir(file, log);
    let r;
    try { r = reemplazar(db, w, registros, total); } finally { db.close(); }
    const dif = registros.length - local;
    log(`  ${w.nombre}: ${n(registros.length)} guardadas${local && dif ? ` (${dif > 0 ? '+' : ''}${n(dif)})` : ''} en ${Math.round((Date.now() - t0) / 1000)} s`);
    hechas.push({ ...w, total: registros.length, antes: local, borradas: r.borradas });
  }
  if (!hechas.length) log('  sin cambios');
  log(`  ${llamadas.n - llamadas0} llamadas a la API`);
  return hechas;
}

export async function estado(file = DB_PATH) {
  const db = await openDb(file);
  if (!db) return null;
  try {
    return {
      audiencias: db.prepare('SELECT COUNT(*) AS c FROM audiencias').get().c,
      documentos: db.prepare('SELECT COUNT(DISTINCT documento) AS c FROM personas WHERE documento IS NOT NULL').get().c,
      rango: db.prepare('SELECT MIN(fecha) AS desde, MAX(fecha) AS hasta FROM audiencias').get(),
      porAnio: db.prepare('SELECT substr(fecha_api, 1, 4) AS anio, COUNT(*) AS c FROM audiencias GROUP BY 1 ORDER BY 1').all(),
      ultimaSync: db.prepare('SELECT MAX(importado) AS c FROM ventanas').get().c,
    };
  } finally { db.close(); }
}

// ------------------------------------------------------------------ consultas (web / módulo)
// Conexión compartida; se cierra al minuto sin uso para no bloquear la importación.
let shared = null;
let idle = null;
async function db() {
  shared ??= await openDb(DB_PATH);
  if (!shared) throw new Error(`base de audiencias no importada. Corré: make audiencias-actualizar  (o condor audiencias-actualizar; ${DB_PATH})`);
  clearTimeout(idle);
  idle = setTimeout(() => { shared?.close(); shared = null; }, 60_000).unref();
  return shared;
}

// Audiencias donde el documento figura (cualquier rol), con todas sus personas. Más nuevas primero.
export async function porDocumento(documento) {
  const d = await db();
  const doc = normDoc(documento);
  const auds = d.prepare(`SELECT * FROM audiencias WHERE id IN (SELECT audiencia_id FROM personas WHERE documento = ?)
    ORDER BY fecha DESC, hora DESC`).all(doc);
  const personas = auds.length
    ? d.prepare('SELECT * FROM personas WHERE audiencia_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(auds.map((a) => a.id)))
    : [];
  const porAud = Map.groupBy(personas, (p) => p.audiencia_id);
  const ultimaSync = d.prepare('SELECT MAX(importado) AS c FROM ventanas').get().c;
  return { documento: doc, ultimaSync, audiencias: auds.map((a) => ({ ...a, personas: porAud.get(a.id) ?? [] })) };
}
