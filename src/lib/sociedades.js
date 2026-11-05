// E. Registro Nacional de Sociedades: base local (SQLite) importada desde datos abiertos.
// Dataset: https://datos.jus.gob.ar/dataset/registro-nacional-de-sociedades
// No hay API de consulta, así que se descarga el CSV/ZIP y se indexa localmente.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import yauzl from 'yauzl';
import { splitDireccion } from '../core/ar.js';
import { normalize } from '../core/facts.js';
import { USER_AGENT } from '../core/module.js';

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
export const DB_PATH = path.resolve(DATA_DIR, 'sociedades.db');

// Palabras que no ayudan a identificar una calle ("Av. Corrientes" ~ "CORRIENTES AV").
const STREET_NOISE = new Set(['av', 'avda', 'avenida', 'calle', 'cl', 'pje', 'pasaje', 'bv', 'bvard', 'boulevard', 'diag', 'diagonal', 'ruta', 'de', 'del', 'la', 'las', 'los', 'el', 'gral', 'general', 'dr', 'pres', 'presidente']);
export const streetKey = (calle) => normalize('domicilio', calle || '').split(' ').filter((w) => w && !STREET_NOISE.has(w)).join(' ');

export const parseDireccion = splitDireccion;

let sqlite = null;
async function openDb(file = DB_PATH, { create = false } = {}) {
  if (!create && !fs.existsSync(file)) return null;
  sqlite ??= await import('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
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
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
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

async function importCsv(db, stream, log) {
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
  const parser = stream.pipe(parse({ columns: true, bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true }));
  let n = 0;
  db.exec('BEGIN');
  for await (const r of parser) {
    if (!r.cuit) continue;
    up.run(String(r.cuit), r.razon_social, normalize('nombre', r.razon_social || ''), r.tipo_societario,
      r.fecha_hora_contrato_social, r.fecha_hora_actualizacion || '',
      r.dom_fiscal_provincia, r.dom_fiscal_localidad, r.dom_fiscal_calle, int(r.dom_fiscal_numero), r.dom_fiscal_piso,
      r.dom_fiscal_departamento, r.dom_fiscal_cp, r.dom_fiscal_estado_domicilio, streetKey(r.dom_fiscal_calle),
      r.dom_legal_provincia, r.dom_legal_localidad, r.dom_legal_calle, int(r.dom_legal_numero), r.dom_legal_piso,
      r.dom_legal_departamento, r.dom_legal_cp, r.dom_legal_estado_domicilio, streetKey(r.dom_legal_calle));
    if (r.actividad_codigo) {
      act.run(String(r.cuit), r.actividad_codigo, r.actividad_descripcion, int(r.actividad_orden), r.actividad_estado, r.actividad_vigencia);
    }
    if (++n % 50_000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); log(`  ${n.toLocaleString('es-AR')} filas…`); }
  }
  db.exec('COMMIT');
  return n;
}

// Importa uno o varios datasets (clave de DATASETS, URL o archivo local .csv/.zip).
export async function importar(sources, log = console.log) {
  const db = await openDb(DB_PATH, { create: true });
  let total = 0;
  try {
    for (const src of sources) {
      const ref = DATASETS[src] ?? src;
      const buf = /^https?:/.test(ref) ? await download(ref, log) : fs.readFileSync(ref);
      if (/\.zip($|\?)/i.test(ref) || buf.subarray(0, 2).toString() === 'PK') {
        const { zip, entries } = await csvStreamsFromZip(buf);
        if (!entries.length) throw new Error('el ZIP no contiene archivos .csv');
        for (const e of entries) { log(`importando ${e.fileName}`); total += await importCsv(db, await openEntry(zip, e), log); }
        zip.close();
      } else {
        total += await importCsv(db, Readable.from(buf), log);
      }
      db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(`import:${src}`, new Date().toISOString());
    }
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM sociedades').get();
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('total', String(c));
    log(`listo: ${total.toLocaleString('es-AR')} filas procesadas, ${c.toLocaleString('es-AR')} sociedades en la base (${DB_PATH})`);
    return { filas: total, sociedades: c };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ consultas
let shared = null;
async function db() {
  if (shared) return shared;
  shared = await openDb(DB_PATH);
  if (!shared) throw new Error(`base de sociedades no importada. Corré: condor import-sociedades 2026  (${DB_PATH})`);
  return shared;
}

const actividadesDe = (d, cuit) => d.prepare('SELECT codigo, descripcion, orden, estado FROM actividades WHERE cuit = ? ORDER BY orden').all(cuit);

export async function porCuit(cuit) {
  const d = await db();
  const s = d.prepare('SELECT * FROM sociedades WHERE cuit = ?').get(String(cuit));
  return s ? { ...s, actividades: actividadesDe(d, s.cuit) } : null;
}

export async function porNombre(texto, limit = 20) {
  const d = await db();
  const words = normalize('nombre', texto).split(' ').filter((w) => w.length > 1);
  if (!words.length) return [];
  const where = words.map(() => 'razon_norm LIKE ?').join(' AND ');
  return d.prepare(`SELECT * FROM sociedades WHERE ${where} LIMIT ?`).all(...words.map((w) => `%${w}%`), limit);
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
  return { parsed: { ...p, key }, rows };
}

export const fmtDom = (s, pre) => {
  const calle = [s[`${pre}_calle`], s[`${pre}_numero`]].filter(Boolean).join(' ');
  const extra = [s[`${pre}_piso`] && `piso ${s[`${pre}_piso`]}`, s[`${pre}_depto`] && `dto ${s[`${pre}_depto`]}`].filter(Boolean).join(' ');
  return [calle, extra, s[`${pre}_localidad`], s[`${pre}_provincia`]].filter(Boolean).join(', ') || null;
};
