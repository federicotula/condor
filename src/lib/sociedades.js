// E. Registro Nacional de Sociedades: base local (SQLite) importada desde datos abiertos.
// Dataset: https://datos.jus.gob.ar/dataset/registro-nacional-de-sociedades
// No hay API de consulta, así que se descarga el CSV/ZIP y se indexa localmente.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import yauzl from 'yauzl';
import { formatCuit, splitDireccion } from '../core/ar.js';
import { normalize } from '../core/facts.js';
import { USER_AGENT } from '../core/module.js';
import { view as v } from '../core/view.js';
import { fmtCorte, igjPorCuit } from './igj.js';

const BASE = 'https://datos.jus.gob.ar/dataset/ee83de85-4305-4c53-9a9f-fd3d15e42c36/resource';
export const DATASETS = {
  muestra: `${BASE}/6096331b-0511-4728-b01b-6c6b535f4c2b/download/registro-nacional-sociedades-muestreo.csv`,
  2026: `${BASE}/13a1a66f-9f49-4d2d-9582-7b4540ef1b83/download/registro-nacional-sociedades-2026.zip`,
  2025: `${BASE}/cf93b46f-ec0b-4956-bcaf-412cd4799eef/download/registro-nacional-sociedades-2025.zip`,
  2024: `${BASE}/a3f34d54-72fc-4848-802e-d3307310b1e9/download/registro-nacional-sociedades-2024.zip`,
  2023: `${BASE}/fa9253b2-50c5-43c2-80db-8095e0dcbc8f/download/registro-nacional-sociedades-2023.zip`,
  2022: `${BASE}/1126bd77-449e-4cdd-a96c-41e8c414fa75/download/registro-nacional-sociedades-2022.zip`,
  2021: `${BASE}/763036e5-d6a4-4249-9e8d-dc204db63f58/download/registro-nacional-sociedades-2021.zip`,
  2020: `${BASE}/1b5f96fa-9399-4580-b97a-cd2739cfa8cd/download/registro-nacional-sociedades-2020.zip`,
  2019: `${BASE}/ac42fc32-7d72-4be5-9d37-e1f796634e55/download/registro-nacional-sociedades-2019.zip`,
  asociaciones: `${BASE}/a0301845-8440-4640-9435-9d975b496cac/download/registro-nacional-sociedades-asociaciones-sin-fines-lucro-2026.zip`,
};

const DATA_DIR = process.env.CONDOR_DATA ?? 'data';
const BIT0 = 2000; // año del bit 0 en registro.anios (máscara exacta en JS hasta 2052)
const CATALOGO = 'https://datos.jus.gob.ar/api/3/action/package_show?id=registro-nacional-de-sociedades';
export const SERIES = ['sociedades', 'asociaciones'];
export const DB_PATH = path.resolve(DATA_DIR, 'sociedades.db');

// Palabras que no ayudan a identificar una calle ("Av. Corrientes" ~ "CORRIENTES AV").
const STREET_NOISE = new Set(['av', 'avda', 'avenida', 'calle', 'cl', 'pje', 'pasaje', 'bv', 'bvard', 'boulevard', 'diag', 'diagonal', 'ruta', 'de', 'del', 'la', 'las', 'los', 'el', 'gral', 'general', 'dr', 'pres', 'presidente']);
export const streetKey = (calle) => normalize('domicilio', calle || '').split(' ').filter((w) => w && !STREET_NOISE.has(w)).join(' ');

export const parseDireccion = splitDireccion;

let sqlite = null;
// exclusive: para importaciones. Con locking_mode=EXCLUSIVE fijado antes de tocar el WAL, SQLite no
// mapea el archivo -shm en memoria (lo mantiene en el heap). Ese mmap sobre ./data (carpeta del host
// montada en Docker) es la causa probable de los SIGBUS. Mientras está abierta, nadie más puede leer
// la base (la web recibe "database is locked").
export async function openDb(file = DB_PATH, { create = false, exclusive = false } = {}) {
  if (!create && !fs.existsSync(file)) return null;
  sqlite ??= await import('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  if (exclusive) {
    try {
      db.exec('PRAGMA busy_timeout = 30000; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    } catch (e) {
      db.close();
      throw new Error(`no se pudo tomar la base en exclusiva (${e.message}): otro proceso la tiene abierta. ` +
        'La web suelta la base al minuto de no usarse; si sigue, reiniciá la app (docker compose restart app) y volvé a correr');
    }
  }
  // norm(x): misma normalización que razon_norm (sin acentos, minúsculas), para filtrar texto libre.
  db.function?.('norm', { deterministic: true }, (x) => (x === null ? null : normalize('nombre', String(x))));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sociedades (
      cuit TEXT PRIMARY KEY, razon_social TEXT, razon_norm TEXT, tipo_societario TEXT,
      fecha_contrato TEXT, fecha_actualizacion TEXT,
      fiscal_provincia TEXT, fiscal_localidad TEXT, fiscal_calle TEXT, fiscal_numero INTEGER, fiscal_piso TEXT,
      fiscal_depto TEXT, fiscal_cp TEXT, fiscal_estado TEXT, fiscal_calle_key TEXT,
      legal_provincia TEXT, legal_localidad TEXT, legal_calle TEXT, legal_numero INTEGER, legal_piso TEXT,
      legal_depto TEXT, legal_cp TEXT, legal_estado TEXT, legal_calle_key TEXT
    );
    CREATE TABLE IF NOT EXISTS actividades (
      cuit TEXT, codigo TEXT, descripcion TEXT, orden INTEGER, estado TEXT, vigencia TEXT,
      PRIMARY KEY (cuit, codigo)
    );
    CREATE INDEX IF NOT EXISTS ix_razon ON sociedades(razon_norm);
    CREATE INDEX IF NOT EXISTS ix_fiscal ON sociedades(fiscal_numero, fiscal_calle_key);
    CREATE INDEX IF NOT EXISTS ix_legal ON sociedades(legal_numero, legal_calle_key);
    CREATE INDEX IF NOT EXISTS ix_tipo ON sociedades(tipo_societario);
    CREATE INDEX IF NOT EXISTS ix_prov ON sociedades(fiscal_provincia);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

    -- Historia en el registro. Cada archivo anual es una foto completa del padrón de ese año, por
    -- serie ('sociedades' o 'asociaciones'). anios es una máscara de bits: bit (año - 2000) = figura.
    -- baja_desde: primer año procesado posterior al último en que figura (NULL = sigue en el registro).
    CREATE TABLE IF NOT EXISTS registro (
      cuit TEXT, serie TEXT, anios INTEGER NOT NULL DEFAULT 0,
      primer_anio INTEGER, ultimo_anio INTEGER, baja_desde INTEGER,
      PRIMARY KEY (cuit, serie)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS ix_registro_baja ON registro(serie, baja_desde);
    -- Archivos anuales ya importados (publicado = fecha de última modificación en el portal).
    CREATE TABLE IF NOT EXISTS procesados (
      serie TEXT, anio INTEGER, url TEXT, publicado TEXT, importado TEXT, filas INTEGER, cuits INTEGER,
      PRIMARY KEY (serie, anio)
    );
    -- Padrón de un año: SELECT * FROM padron WHERE serie = 'sociedades' AND anio = 2021.
    -- (Los datos de cada sociedad son los más recientes que se tengan, no los de ese año.)
    CREATE VIEW IF NOT EXISTS padron AS
      SELECT p.serie, p.anio, s.* FROM procesados p
      JOIN registro r ON r.serie = p.serie AND ((r.anios >> (p.anio - ${BIT0})) & 1) = 1
      JOIN sociedades s ON s.cuit = r.cuit;
  `);
  return db;
}

// ------------------------------------------------------------------ importación
async function download(url, log) {
  log(`descargando ${url}`);
  const resp = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!resp.ok) throw new Error(`descarga falló: HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

function csvStreamsFromZip(buf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const entries = [];
      zip.on('entry', (e) => { if (/\.csv$/i.test(e.fileName)) entries.push(e); zip.readEntry(); });
      zip.on('end', () => resolve({ zip, entries }));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

const openEntry = (zip, entry) => new Promise((res, rej) => zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s))));
const int = (x) => (x === '' || x === null || x === undefined || Number.isNaN(Number(x)) ? null : Number(x));

// La transacción la maneja quien llama. onCuit(cuit) se llama por cada fila (para marcar presencia).
async function importCsv(db, stream, log, onCuit = null) {
  const up = db.prepare(`INSERT INTO sociedades VALUES (?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?)
    ON CONFLICT(cuit) DO UPDATE SET razon_social=excluded.razon_social, razon_norm=excluded.razon_norm,
      tipo_societario=excluded.tipo_societario, fecha_contrato=excluded.fecha_contrato, fecha_actualizacion=excluded.fecha_actualizacion,
      fiscal_provincia=excluded.fiscal_provincia, fiscal_localidad=excluded.fiscal_localidad, fiscal_calle=excluded.fiscal_calle,
      fiscal_numero=excluded.fiscal_numero, fiscal_piso=excluded.fiscal_piso, fiscal_depto=excluded.fiscal_depto, fiscal_cp=excluded.fiscal_cp,
      fiscal_estado=excluded.fiscal_estado, fiscal_calle_key=excluded.fiscal_calle_key,
      legal_provincia=excluded.legal_provincia, legal_localidad=excluded.legal_localidad, legal_calle=excluded.legal_calle,
      legal_numero=excluded.legal_numero, legal_piso=excluded.legal_piso, legal_depto=excluded.legal_depto, legal_cp=excluded.legal_cp,
      legal_estado=excluded.legal_estado, legal_calle_key=excluded.legal_calle_key
    WHERE excluded.fecha_actualizacion >= COALESCE(sociedades.fecha_actualizacion, '')`);
  const act = db.prepare('INSERT OR REPLACE INTO actividades VALUES (?,?,?,?,?,?)');
  const nul = (xs) => xs.map((x) => (x === undefined ? null : x)); // columnas que falten en algún año
  const parser = stream.pipe(parse({ columns: true, bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true }));
  let n = 0;
  for await (const r of parser) {
    if (!r.cuit) continue;
    up.run(...nul([String(r.cuit), r.razon_social, normalize('nombre', r.razon_social || ''), r.tipo_societario,
      r.fecha_hora_contrato_social, r.fecha_hora_actualizacion || '',
      r.dom_fiscal_provincia, r.dom_fiscal_localidad, r.dom_fiscal_calle, int(r.dom_fiscal_numero), r.dom_fiscal_piso,
      r.dom_fiscal_departamento, r.dom_fiscal_cp, r.dom_fiscal_estado_domicilio, streetKey(r.dom_fiscal_calle),
      r.dom_legal_provincia, r.dom_legal_localidad, r.dom_legal_calle, int(r.dom_legal_numero), r.dom_legal_piso,
      r.dom_legal_departamento, r.dom_legal_cp, r.dom_legal_estado_domicilio, streetKey(r.dom_legal_calle)]));
    if (r.actividad_codigo?.trim()) {
      act.run(...nul([String(r.cuit), String(r.actividad_codigo).trim(), r.actividad_descripcion?.trim(), int(r.actividad_orden), r.actividad_estado, r.actividad_vigencia]));
    }
    onCuit?.(String(r.cuit));
    if (++n % 100_000 === 0) log(`  ${n.toLocaleString('es-AR')} filas…`);
  }
  return n;
}

async function importBuffer(db, ref, buf, log, onCuit) {
  let total = 0;
  if (/\.zip($|\?)/i.test(ref) || buf.subarray(0, 2).toString() === 'PK') {
    const { zip, entries } = await csvStreamsFromZip(buf);
    if (!entries.length) throw new Error('el ZIP no contiene archivos .csv');
    try {
      for (const e of entries) { log(`importando ${e.fileName}`); total += await importCsv(db, await openEntry(zip, e), log, onCuit); }
    } finally { zip.close(); }
  } else {
    total += await importCsv(db, Readable.from(buf), log, onCuit);
  }
  return total;
}

const readSource = async (ref, log) => (/^https?:/.test(ref) ? download(ref, log) : fs.readFileSync(ref));

// Recalcula primer/último año y baja_desde de una serie a partir de las máscaras y los años procesados.
function recalcular(db, serie) {
  const bit = `((registro.anios >> (p.anio - ${BIT0})) & 1) = 1`;
  db.prepare(`UPDATE registro SET
      primer_anio = (SELECT MIN(p.anio) FROM procesados p WHERE p.serie = registro.serie AND ${bit}),
      ultimo_anio = (SELECT MAX(p.anio) FROM procesados p WHERE p.serie = registro.serie AND ${bit})
    WHERE serie = ?`).run(serie);
  db.prepare(`UPDATE registro SET
      baja_desde = (SELECT MIN(p.anio) FROM procesados p WHERE p.serie = registro.serie AND p.anio > COALESCE(registro.ultimo_anio, 0))
    WHERE serie = ?`).run(serie);
}

// Importa la foto anual de una serie. Todo el año va en una sola transacción: si falla a mitad,
// la base queda como estaba. Reimportar un año (p.ej. el actual, que se republica) lo reemplaza.
export async function importarAnio({ serie, anio, url, publicado = null }, log = console.log, file = DB_PATH) {
  if (!SERIES.includes(serie)) throw new Error(`serie desconocida: ${serie}`);
  if (!(anio >= BIT0 && anio < BIT0 + 53)) throw new Error(`año fuera de rango: ${anio}`);
  const buf = await readSource(url, log);
  const db = await openDb(file, { create: true, exclusive: true });
  const mask = 2 ** (anio - BIT0);
  try {
    const marcar = db.prepare(`INSERT INTO registro (cuit, serie, anios) VALUES (?, ?, ${mask})
      ON CONFLICT(cuit, serie) DO UPDATE SET anios = anios | ${mask}`);
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE registro SET anios = anios & ~${mask} WHERE serie = ?`).run(serie);
      log(`${serie} ${anio}:`);
      const filas = await importBuffer(db, url, buf, log, (cuit) => marcar.run(cuit, serie));
      const { c } = db.prepare(`SELECT COUNT(*) AS c FROM registro WHERE serie = ? AND (anios & ${mask}) != 0`).get(serie);
      if (!c) throw new Error(`el archivo de ${serie} ${anio} no trajo ninguna CUIT`);
      db.prepare('INSERT OR REPLACE INTO procesados VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(serie, anio, url, publicado, new Date().toISOString(), filas, c);
      recalcular(db, serie);
      db.exec('COMMIT');
      const bajas = db.prepare('SELECT COUNT(*) AS c FROM registro WHERE serie = ? AND baja_desde = ?').get(serie, anio).c;
      log(`  ${filas.toLocaleString('es-AR')} filas, ${c.toLocaleString('es-AR')} CUIT en ${anio}` +
        (bajas ? `, ${bajas.toLocaleString('es-AR')} que figuraban antes ya no están` : ''));
      return { serie, anio, filas, cuits: c, bajas };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

// Archivos anuales publicados en el portal (la URL de cada año tiene un id que no se puede adivinar).
// Se ignoran los cortes parciales (bimestres), la muestra y los CSV fechados (duplican el ZIP del año).
export async function publicados(log = console.log) {
  try {
    const resp = await fetch(CATALOGO, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { result } = await resp.json();
    const out = [];
    for (const r of result.resources) {
      const name = String(r.name || '').replace(/\s+/g, ' ').trim();
      const m = name.match(/^Registro Nacional de Sociedades - (?:(Asociaciones sin fines de lucro) - )?(\d{4})\.?$/i);
      if (m) out.push({ serie: m[1] ? 'asociaciones' : 'sociedades', anio: Number(m[2]), url: r.url, publicado: r.last_modified || r.created || null });
    }
    if (!out.length) throw new Error('el catálogo no lista archivos anuales');
    return out.sort((a, b) => a.anio - b.anio || a.serie.localeCompare(b.serie));
  } catch (e) {
    log(`no se pudo leer el catálogo del portal (${e.message}); uso la lista conocida`);
    return Object.entries(DATASETS).filter(([k]) => /^\d{4}$/.test(k))
      .map(([k, url]) => ({ serie: 'sociedades', anio: Number(k), url, publicado: null }))
      .concat([{ serie: 'asociaciones', anio: 2026, url: DATASETS.asociaciones, publicado: null }])
      .sort((a, b) => a.anio - b.anio);
  }
}

export async function procesados(file = DB_PATH) {
  const db = await openDb(file);
  if (!db) return [];
  try { return db.prepare('SELECT * FROM procesados ORDER BY serie, anio').all(); } finally { db.close(); }
}

// Años publicados, del más viejo al más nuevo (el orden no cambia el resultado, pero así el log de
// bajas se lee en orden). solo: 'nuevos' (default) saltea los años ya procesados que no se
// republicaron, así correrlo dos veces no hace nada; 'todos' reimporta todo.
export async function sincronizar({ solo = 'nuevos', desde = 0, series = SERIES, catalogo = null } = {}, log = console.log, file = DB_PATH) {
  const hechos = new Map((await procesados(file)).map((p) => [`${p.serie}:${p.anio}`, p]));
  const lista = (catalogo ?? (await publicados(log))).filter((d) => d.anio >= desde && series.includes(d.serie)).filter((d) => {
    if (solo !== 'nuevos') return true;
    const prev = hechos.get(`${d.serie}:${d.anio}`);
    return !prev || (d.publicado && (!prev.publicado || d.publicado > prev.publicado));
  });
  if (!lista.length) {
    const ultimo = Math.max(...[...hechos.values()].map((p) => p.anio));
    log(hechos.size ? `nada nuevo para importar (último año procesado: ${ultimo})` : 'nada para importar');
    return [];
  }
  log(`a importar: ${lista.map((d) => `${d.serie} ${d.anio}${hechos.has(`${d.serie}:${d.anio}`) ? ' (republicado)' : ''}`).join(', ')}`);
  const out = [];
  for (const d of lista) out.push(await importarAnio(d, log, file));
  return out;
}

export async function estado(file = DB_PATH) {
  const db = await openDb(file);
  if (!db) return null;
  try {
    return {
      procesados: db.prepare('SELECT serie, anio, publicado, importado, filas, cuits FROM procesados ORDER BY serie, anio').all(),
      bajas: db.prepare('SELECT serie, baja_desde AS anio, COUNT(*) AS c FROM registro WHERE baja_desde IS NOT NULL GROUP BY serie, baja_desde ORDER BY serie, baja_desde').all(),
      vigentes: db.prepare('SELECT serie, COUNT(*) AS c FROM registro WHERE baja_desde IS NULL GROUP BY serie').all(),
      sociedades: db.prepare('SELECT COUNT(*) AS c FROM sociedades').get().c,
    };
  } finally {
    db.close();
  }
}

// Importa uno o varios datasets (clave de DATASETS, URL o archivo local .csv/.zip).
// Los años (2019..) y 'asociaciones' registran presencia/bajas; una URL o archivo suelto, no.
export async function importar(sources, log = console.log) {
  let total = 0;
  for (const src of sources) {
    if (/^\d{4}$/.test(src) && DATASETS[src]) { total += (await importarAnio({ serie: 'sociedades', anio: Number(src), url: DATASETS[src] }, log)).filas; continue; }
    if (src === 'asociaciones') { total += (await importarAnio({ serie: 'asociaciones', anio: 2026, url: DATASETS.asociaciones }, log)).filas; continue; }
    const ref = DATASETS[src] ?? src;
    const buf = await readSource(ref, log);
    const db = await openDb(DB_PATH, { create: true });
    try {
      db.exec('BEGIN');
      try { total += await importBuffer(db, ref, buf, log); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(`import:${src}`, new Date().toISOString());
    } finally { db.close(); }
  }
  const db = await openDb(DB_PATH);
  try {
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM sociedades').get();
    log(`listo: ${total.toLocaleString('es-AR')} filas procesadas, ${c.toLocaleString('es-AR')} sociedades en la base (${DB_PATH})`);
    return { filas: total, sociedades: c };
  } finally { db.close(); }
}

// ------------------------------------------------------------------ consultas
// Conexión compartida de la web. Se cierra tras un minuto sin uso: una conexión WAL abierta, aunque
// esté inactiva, impide que la importación tome la base en modo exclusivo.
let shared = null;
let idle = null;
async function db() {
  shared ??= await openDb(DB_PATH);
  if (!shared) throw new Error(`base de sociedades no importada. Corré: make sociedades-historico  (o condor sociedades-historico; ${DB_PATH})`);
  clearTimeout(idle);
  idle = setTimeout(() => { shared?.close(); shared = null; }, 60_000).unref();
  return shared;
}

// Estado en el registro combinando series: vigente si figura en el último año de alguna.
export function estadoRegistro(rows) {
  if (!rows?.length) return null;
  const vigente = rows.some((r) => r.baja_desde === null);
  return {
    vigente,
    primer_anio: Math.min(...rows.map((r) => r.primer_anio ?? Infinity)),
    ultimo_anio: Math.max(...rows.map((r) => r.ultimo_anio ?? -Infinity)),
    baja_desde: vigente ? null : Math.max(...rows.map((r) => r.baja_desde)),
    series: rows.map((r) => r.serie),
  };
}
const registroDe = (d, cuit) => estadoRegistro(d.prepare('SELECT serie, primer_anio, ultimo_anio, baja_desde FROM registro WHERE cuit = ?').all(cuit));
const conRegistro = (d, rows) => rows.map((s) => ({ ...s, registro: registroDe(d, s.cuit) }));

const actividadesDe = (d, cuit) => d.prepare('SELECT codigo, descripcion, orden, estado FROM actividades WHERE cuit = ? ORDER BY orden').all(cuit);

export async function porCuit(cuit) {
  const d = await db();
  const s = d.prepare('SELECT * FROM sociedades WHERE cuit = ?').get(String(cuit));
  return s ? { ...s, actividades: actividadesDe(d, s.cuit), registro: registroDe(d, s.cuit), igj: igjPorCuit(d, s.cuit) } : null;
}

export async function porNombre(texto, limit = 20) {
  const d = await db();
  const words = normalize('nombre', texto).split(' ').filter((w) => w.length > 1);
  if (!words.length) return [];
  const where = words.map(() => 'razon_norm LIKE ?').join(' AND ');
  return conRegistro(d, d.prepare(`SELECT * FROM sociedades WHERE ${where} LIMIT ?`).all(...words.map((w) => `%${w}%`), limit));
}

// Sociedades con domicilio fiscal o legal en la misma calle y altura.
export async function porDomicilio(direccion, limit = 50) {
  const p = parseDireccion(direccion);
  if (!p) return { parsed: null, rows: [] };
  const key = streetKey(p.calle);
  const main = key.split(' ').sort((a, b) => b.length - a.length)[0];
  if (!main) return { parsed: p, rows: [] };
  const d = await db();
  const rows = d.prepare(`SELECT * FROM sociedades
    WHERE (fiscal_numero = ? AND fiscal_calle_key LIKE ?) OR (legal_numero = ? AND legal_calle_key LIKE ?) LIMIT ?`)
    .all(p.numero, `%${main}%`, p.numero, `%${main}%`, limit);
  return { parsed: { ...p, key }, rows: conRegistro(d, rows) };
}

// ------------------------------------------------------------------ explorador (pestaña Sociedades)
// Búsqueda por filtros combinables. Todos opcionales; los textos se comparan normalizados.
const MAX_COUNT = 10_000; // contar más que esto es lento y no aporta: se muestra "10.000+"

export async function explorar(f = {}, { page = 1, per = 50 } = {}) {
  const d = await db();
  const where = [];
  const args = [];
  const words = (x) => normalize('nombre', x || '').split(' ').filter((w) => w.length > 1);

  for (const w of words(f.q)) { where.push('s.razon_norm LIKE ?'); args.push(`%${w}%`); }
  const cuit = String(f.cuit || '').replace(/\D/g, '');
  if (cuit) { where.push(cuit.length === 11 ? 's.cuit = ?' : 's.cuit LIKE ?'); args.push(cuit.length === 11 ? cuit : `%${cuit}%`); }
  if (f.tipo) { where.push('s.tipo_societario = ?'); args.push(f.tipo); }
  if (f.provincia) { where.push('s.fiscal_provincia = ?'); args.push(f.provincia); }
  // Sin norm() (Node viejo) se compara con LIKE, que ignora mayúsculas pero no acentos.
  const N = d.function ? (c) => `norm(${c})` : (c) => c;
  const like = (w) => `%${w}%`;
  if (f.localidad) {
    for (const w of words(f.localidad)) {
      where.push(`(${N('s.fiscal_localidad')} LIKE ? OR ${N('s.legal_localidad')} LIKE ?)`); args.push(like(w), like(w));
    }
  }
  const calle = streetKey(f.calle).split(' ').sort((a, b) => b.length - a.length)[0];
  const altura = Number.parseInt(f.altura, 10);
  if (calle && Number.isFinite(altura)) {
    where.push('((s.fiscal_numero = ? AND s.fiscal_calle_key LIKE ?) OR (s.legal_numero = ? AND s.legal_calle_key LIKE ?))');
    args.push(altura, `%${calle}%`, altura, `%${calle}%`);
  } else if (calle) {
    where.push('(s.fiscal_calle_key LIKE ? OR s.legal_calle_key LIKE ?)'); args.push(`%${calle}%`, `%${calle}%`);
  } else if (Number.isFinite(altura)) {
    where.push('(s.fiscal_numero = ? OR s.legal_numero = ?)'); args.push(altura, altura);
  }
  if (f.actividad) {
    const a = String(f.actividad).trim();
    if (/^\d+$/.test(a)) { where.push('EXISTS (SELECT 1 FROM actividades a WHERE a.cuit = s.cuit AND trim(a.codigo) LIKE ?)'); args.push(`${a}%`); } else {
      const ws = words(a);
      if (ws.length) {
        where.push(`EXISTS (SELECT 1 FROM actividades a WHERE a.cuit = s.cuit AND ${ws.map(() => `${N('a.descripcion')} LIKE ?`).join(' AND ')})`);
        args.push(...ws.map(like));
      }
    }
  }
  const desde = Number.parseInt(f.desde, 10);
  const hasta = Number.parseInt(f.hasta, 10);
  if (Number.isFinite(desde)) { where.push("substr(s.fecha_contrato, 1, 4) >= ?"); args.push(String(desde)); }
  if (Number.isFinite(hasta)) { where.push("substr(s.fecha_contrato, 1, 4) <= ?"); args.push(String(hasta)); }
  // Estado en el registro (combinando series): vigente si figura en el último año de alguna.
  const vigente = 'EXISTS (SELECT 1 FROM registro r WHERE r.cuit = s.cuit AND r.baja_desde IS NULL)';
  if (f.estado === 'vigente') where.push(vigente);
  if (f.estado === 'baja') where.push(`NOT ${vigente} AND EXISTS (SELECT 1 FROM registro r WHERE r.cuit = s.cuit)`);
  const baja = Number.parseInt(f.baja, 10);
  if (Number.isFinite(baja)) {
    where.push(`NOT ${vigente} AND (SELECT MAX(r.baja_desde) FROM registro r WHERE r.cuit = s.cuit) = ?`); args.push(baja);
  }

  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  per = Math.min(Math.max(Number(per) || 50, 1), 200);
  page = Math.max(Number(page) || 1, 1);
  const rows = d.prepare(`SELECT s.* FROM sociedades s ${w} ORDER BY s.razon_norm LIMIT ? OFFSET ?`).all(...args, per, (page - 1) * per);
  const { c } = d.prepare(`SELECT COUNT(*) AS c FROM (SELECT 1 FROM sociedades s ${w} LIMIT ${MAX_COUNT + 1})`).get(...args);
  return { rows: conRegistro(d, rows), total: Math.min(c, MAX_COUNT), more: c > MAX_COUNT, page, per };
}

// Valores para los desplegables (cacheados: sólo cambian al importar).
let opcionesCache = null;
export async function opciones() {
  const d = await db();
  const firma = JSON.stringify(d.prepare('SELECT serie, anio, importado FROM procesados').all());
  if (opcionesCache?.firma === firma) return opcionesCache.data;
  const col = (c) => d.prepare(`SELECT DISTINCT ${c} AS v FROM sociedades WHERE ${c} IS NOT NULL AND ${c} != '' ORDER BY ${c}`).all().map((r) => r.v);
  const data = {
    tipos: col('tipo_societario'),
    provincias: col('fiscal_provincia'),
    bajas: d.prepare('SELECT DISTINCT baja_desde AS v FROM registro WHERE baja_desde IS NOT NULL ORDER BY v').all().map((r) => r.v),
    procesados: d.prepare('SELECT serie, anio, publicado FROM procesados ORDER BY serie, anio').all(),
    total: d.prepare('SELECT COUNT(*) AS c FROM sociedades').get().c,
  };
  opcionesCache = { firma, data };
  return data;
}

export const fmtDom = (s, pre) => {
  const calle = [s[`${pre}_calle`], s[`${pre}_numero`]].filter(Boolean).join(' ');
  const extra = [s[`${pre}_piso`] && `piso ${s[`${pre}_piso`]}`, s[`${pre}_depto`] && `dto ${s[`${pre}_depto`]}`].filter(Boolean).join(' ');
  return [calle, extra, s[`${pre}_localidad`], s[`${pre}_provincia`]].filter(Boolean).join(', ') || null;
};

// "vigente (2019–2026)" / "no figura desde 2023 (última vez 2022)"
export function fmtRegistro(r) {
  if (!r) return null;
  const rango = r.primer_anio === r.ultimo_anio ? `${r.ultimo_anio}` : `${r.primer_anio}–${r.ultimo_anio}`;
  return r.vigente ? `vigente (figura ${rango})` : `no figura desde ${r.baja_desde} (figuró ${rango})`;
}

// Ficha de una sociedad (bloques `view`): la usan el módulo por CUIT y la pestaña Sociedades.
export function vistaSociedad(s) {
  const fiscal = fmtDom(s, 'fiscal');
  const legal = fmtDom(s, 'legal');
  const activas = s.actividades.filter((a) => a.estado !== 'BD');
  return [
    s.registro && !s.registro.vigente
      ? v.alert(`No figura en el registro desde ${s.registro.baja_desde} (última vez: ${s.registro.ultimo_anio}). Los datos son los de esa última aparición.`, 'warn')
      : null,
    v.stats([
      { label: 'Constitución', value: s.fecha_contrato?.slice(0, 10) || '—', format: 'date' },
      { label: 'Actividades activas', value: activas.length },
      s.registro ? { label: 'En el registro', value: s.registro.vigente ? 'vigente' : `baja ${s.registro.baja_desde}`, tone: s.registro.vigente ? 'ok' : 'warn' } : null,
    ].filter(Boolean)),
    v.kv([
      { label: 'Razón social', value: s.razon_social },
      { label: 'CUIT', value: formatCuit(s.cuit) },
      { label: 'Tipo', value: s.tipo_societario },
      { label: 'Domicilio fiscal', value: fiscal, tone: s.fiscal_estado && s.fiscal_estado !== 'CONFIRMADO' ? 'warn' : undefined },
      { label: 'Estado dom. fiscal', value: s.fiscal_estado },
      { label: 'Domicilio legal', value: legal },
      { label: 'Estado dom. legal', value: s.legal_estado },
      { label: 'Última actualización', value: s.fecha_actualizacion?.slice(0, 10), format: 'date' },
      { label: 'En el registro', value: fmtRegistro(s.registro), tone: s.registro && !s.registro.vigente ? 'warn' : undefined },
    ].filter((x) => x.value)),
    v.table(s.actividades.map((a) => ({
      orden: a.orden === 0 ? 'monotributo' : a.orden === 1 ? 'principal' : 'secundaria',
      codigo: a.codigo, actividad: a.descripcion,
      estado: { value: a.estado === 'BD' ? 'baja' : 'activa', tone: a.estado === 'BD' ? 'muted' : 'ok' },
    })), { title: 'Actividades', emptyText: 'sin actividades informadas' }),
    ...vistaIgj(s.igj),
  ].filter(Boolean);
}

// Socios y autoridades según la IGJ (sólo entidades inscriptas en CABA).
function vistaIgj(g) {
  if (!g) return [];
  const persona = (a) => ({ rol: a.rol, nombre: a.nombre, documento: [a.tipo_doc, a.documento].filter(Boolean).join(' ') });
  const cambios = g.versiones.length - 1;
  return [
    v.section(`IGJ · socios y autoridades (corte ${fmtCorte(g.ultimo_corte)})`, [
      g.entidad.dada_de_baja === 'S' ? v.alert(`Dada de baja en IGJ: ${g.entidad.detalle_baja || g.entidad.codigo_baja || 'sin detalle'}`, 'warn') : null,
      v.text('Personas que la IGJ lista para la entidad en el último corte. La IGJ parece acumular autoridades históricas (en los cortes revisados no quitó a nadie), así que puede incluir personas que ya no están. No informa porcentaje de participación, cargo ni fecha de designación; "desde" es el primer corte importado en que figura.'),
      v.table(g.actuales.map((a) => ({ ...persona(a), desde: fmtCorte(a.desde_corte) })), { emptyText: 'sin socios ni autoridades en el último corte' }),
      cambios > 0 ? v.table(g.versiones.map((c) => ({
        desde: fmtCorte(c.desde_corte), hasta: fmtCorte(c.hasta_corte), socios: c.socios, autoridades: c.autoridades,
        representantes: c.representantes, altas: c.altas, bajas: c.bajas,
      })), { title: `Evolución (${cambios} cambio${cambios === 1 ? '' : 's'})` }) : v.text(`Sin cambios desde ${fmtCorte(g.versiones[0]?.desde_corte)}.`),
      g.historicas.length ? v.table(g.historicas.map((a) => ({ ...persona(a), desde: fmtCorte(a.desde_corte), hasta: fmtCorte(a.hasta_corte) })), { title: 'Ya no figuran' }) : null,
    ].filter(Boolean)),
  ];
}
