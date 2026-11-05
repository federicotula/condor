// IGJ (Inspección General de Justicia): entidades inscriptas en CABA y sus autoridades/socios.
// Dataset: https://datos.jus.gob.ar/dataset/entidades-constituidas-en-la-inspeccion-general-de-justicia-igj
//
// Cada ZIP del portal trae una o más "fotos" completas (cortes AAAAMM): igj-entidades-202609.csv,
// igj-autoridades-202609.csv, etc. Las etiquetas del portal no siempre coinciden con el contenido
// (p.ej. "2022 semestre 2" trae cortes de 2023), así que se ordena y deduplica por corte, no por ZIP.
//
// Historia (se guarda sólo lo que cambia):
//  - igj_autoridades: una fila por persona+rol en una entidad, vigente de desde_corte a hasta_corte.
//    Si en el corte siguiente sigue igual, se extiende hasta_corte; si desaparece, queda cerrada; si
//    vuelve, abre otra fila. La composición en un corte X: desde_corte <= X <= hasta_corte.
//  - igj_composicion: una fila por versión de la composición de cada entidad (huella del conjunto).
//    Si no cambió, se extiende hasta_corte ("siguió igual"); si cambió, nueva fila con altas/bajas.
//  Los cortes se procesan en orden; un corte anterior al último procesado no se puede intercalar
//  (se avisa y hace falta --forzar para reconstruir).
//
// El dataset NO trae porcentaje de participación, cargo puntual ni fechas de designación.
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import yauzl from 'yauzl';
import { normalize } from '../core/facts.js';
import { USER_AGENT } from '../core/module.js';
import { DB_PATH, openDb } from './sociedades.js';

const CATALOGO = 'https://datos.jus.gob.ar/api/3/action/package_show?id=entidades-constituidas-en-la-inspeccion-general-de-justicia-igj';
const ROL = { S: 'socio', A: 'autoridad', R: 'representante' };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS igj_entidades (
    correlativo TEXT PRIMARY KEY, cuit TEXT, razon_social TEXT, razon_norm TEXT, tipo_societario TEXT,
    dada_de_baja TEXT, codigo_baja TEXT, detalle_baja TEXT, primer_corte TEXT, ultimo_corte TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_igj_ent_cuit ON igj_entidades(cuit);
  CREATE INDEX IF NOT EXISTS ix_igj_ent_razon ON igj_entidades(razon_norm);
  CREATE TABLE IF NOT EXISTS igj_autoridades (
    id INTEGER PRIMARY KEY, correlativo TEXT NOT NULL, rol TEXT, tipo_doc TEXT, documento TEXT, nombre TEXT,
    desde_corte TEXT NOT NULL, hasta_corte TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_igj_aut_ent ON igj_autoridades(correlativo, hasta_corte);
  CREATE INDEX IF NOT EXISTS ix_igj_aut_hasta ON igj_autoridades(hasta_corte);
  CREATE INDEX IF NOT EXISTS ix_igj_aut_doc ON igj_autoridades(documento);
  CREATE TABLE IF NOT EXISTS igj_composicion (
    correlativo TEXT, desde_corte TEXT, hasta_corte TEXT, huella TEXT,
    socios INTEGER, autoridades INTEGER, representantes INTEGER, altas INTEGER, bajas INTEGER,
    PRIMARY KEY (correlativo, desde_corte)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ix_igj_comp_hasta ON igj_composicion(hasta_corte);
  CREATE TABLE IF NOT EXISTS igj_cortes (
    corte TEXT PRIMARY KEY, archivo TEXT, entidades INTEGER, autoridades INTEGER,
    altas INTEGER, bajas INTEGER, entidades_con_cambios INTEGER, importado TEXT
  );
  CREATE TABLE IF NOT EXISTS igj_archivos (
    url TEXT PRIMARY KEY, nombre TEXT, publicado TEXT, importado TEXT, cortes TEXT, omitidos TEXT
  );
`;

async function open(file = DB_PATH, opts = {}) {
  const db = await openDb(file, { create: true, ...opts });
  db.exec(SCHEMA);
  return db;
}

const clean = (x) => String(x ?? '').trim();
const nombreKey = (x) => clean(x).toUpperCase().replace(/\s+/g, ' ');
// numero_correlativo puede venir con BOM en el encabezado.
const col = (r, name) => r[name] ?? r[`﻿${name}`];
const csvRows = (stream) => stream.pipe(parse({ columns: (h) => h.map((x) => x.replace(/^﻿/, '').trim()), bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true }));

// ------------------------------------------------------------------ procesar un corte
// entidades / autoridades: streams de los CSV de ese corte. Todo en una transacción.
export async function procesarCorte(db, corte, { entidades, autoridades, archivo = '' }, log = console.log) {
  const prev = db.prepare('SELECT MAX(corte) AS c FROM igj_cortes').get().c;
  if (prev && corte <= prev) throw new Error(`corte ${corte} no es posterior al último procesado (${prev})`);
  db.exec('BEGIN');
  try {
    // 1) entidades: datos más recientes + primer/último corte en que figura
    const upEnt = db.prepare(`INSERT INTO igj_entidades VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(correlativo) DO UPDATE SET cuit = COALESCE(NULLIF(excluded.cuit, ''), igj_entidades.cuit),
        razon_social = excluded.razon_social, razon_norm = excluded.razon_norm, tipo_societario = excluded.tipo_societario,
        dada_de_baja = excluded.dada_de_baja, codigo_baja = excluded.codigo_baja, detalle_baja = excluded.detalle_baja,
        ultimo_corte = excluded.ultimo_corte`);
    let nEnt = 0;
    for await (const r of csvRows(entidades)) {
      const corr = clean(col(r, 'numero_correlativo'));
      if (!corr) continue;
      upEnt.run(corr, clean(r.cuit).replace(/\D/g, '') || null, clean(r.razon_social), normalize('nombre', clean(r.razon_social)),
        clean(r.descripcion_tipo_societario) || clean(r.tipo_societario), clean(r.dada_de_baja) || null,
        clean(r.codigo_baja) || null, clean(r.detalle_baja) || null, corte, corte);
      if (++nEnt % 250_000 === 0) log(`    ${nEnt.toLocaleString('es-AR')} entidades…`);
    }

    // 2) autoridades del corte a una tabla temporal (la PK deduplica filas repetidas)
    db.exec(`DROP TABLE IF EXISTS temp.igj_t; CREATE TEMP TABLE igj_t (
      correlativo TEXT, rol TEXT, tipo_doc TEXT, documento TEXT, nombre TEXT,
      PRIMARY KEY (correlativo, rol, tipo_doc, documento, nombre)) WITHOUT ROWID`);
    const insT = db.prepare('INSERT OR IGNORE INTO temp.igj_t VALUES (?,?,?,?,?)');
    let nAut = 0;
    for await (const r of csvRows(autoridades)) {
      const corr = clean(col(r, 'numero_correlativo'));
      if (!corr) continue;
      insT.run(corr, ROL[clean(r.tipo_administrador)] || clean(r.descripcion_tipo_administrador).toLowerCase() || '',
        clean(r.descripcion_tipo_documento) || clean(r.tipo_documento), clean(r.numero_documento).replace(/^0+(?=\d)/, ''), nombreKey(r.apellido_nombre));
      if (++nAut % 500_000 === 0) log(`    ${nAut.toLocaleString('es-AR')} autoridades…`);
    }

    // 3) extender las que siguen, abrir las nuevas
    const same = 't.correlativo = a.correlativo AND t.rol = a.rol AND t.tipo_doc = a.tipo_doc AND t.documento = a.documento AND t.nombre = a.nombre';
    if (prev) {
      db.prepare(`UPDATE igj_autoridades AS a SET hasta_corte = ? WHERE a.hasta_corte = ?
        AND EXISTS (SELECT 1 FROM temp.igj_t t WHERE ${same})`).run(corte, prev);
    }
    const altas = db.prepare(`INSERT INTO igj_autoridades (correlativo, rol, tipo_doc, documento, nombre, desde_corte, hasta_corte)
      SELECT t.correlativo, t.rol, t.tipo_doc, t.documento, t.nombre, ?, ? FROM temp.igj_t t
      WHERE NOT EXISTS (SELECT 1 FROM igj_autoridades a WHERE a.correlativo = t.correlativo AND a.hasta_corte = ? AND ${same.replace('t.correlativo = a.correlativo AND ', '')})`)
      .run(corte, corte, corte).changes;
    const bajas = prev ? db.prepare('SELECT COUNT(*) AS c FROM igj_autoridades WHERE hasta_corte = ?').get(prev).c : 0;

    // 4) composición por entidad: misma huella -> se extiende; distinta -> nueva versión
    const prevComp = db.prepare('SELECT huella FROM igj_composicion WHERE correlativo = ? AND hasta_corte = ?');
    const extComp = db.prepare('UPDATE igj_composicion SET hasta_corte = ? WHERE correlativo = ? AND hasta_corte = ?');
    const newComp = db.prepare('INSERT INTO igj_composicion VALUES (?,?,?,?,?,?,?,?,?)');
    const altasDe = db.prepare('SELECT COUNT(*) AS c FROM igj_autoridades WHERE correlativo = ? AND desde_corte = ?');
    const bajasDe = db.prepare('SELECT COUNT(*) AS c FROM igj_autoridades WHERE correlativo = ? AND hasta_corte = ?');
    let cambios = 0;
    const cerrar = (corr, h, cnt) => {
      const p = prev ? prevComp.get(corr, prev) : undefined;
      if (p && p.huella === h) return extComp.run(corte, corr, prev);
      if (!p && !h) return null; // nunca tuvo autoridades: nada que registrar
      if (p) cambios++;
      newComp.run(corr, corte, corte, h, cnt.socio, cnt.autoridad, cnt.representante,
        altasDe.get(corr, corte).c, prev ? bajasDe.get(corr, prev).c : 0);
      return null;
    };
    let cur = null;
    let hash = null;
    let cnt = null;
    const vistas = new Set();
    for (const r of db.prepare('SELECT * FROM temp.igj_t ORDER BY correlativo, rol, tipo_doc, documento, nombre').iterate()) {
      if (r.correlativo !== cur) {
        if (cur !== null) cerrar(cur, hash.digest('hex'), cnt);
        cur = r.correlativo;
        vistas.add(cur);
        hash = crypto.createHash('sha1');
        cnt = { socio: 0, autoridad: 0, representante: 0 };
      }
      hash.update(`${r.rol}|${r.tipo_doc}|${r.documento}|${r.nombre}\n`);
      cnt[r.rol] = (cnt[r.rol] || 0) + 1;
    }
    if (cur !== null) cerrar(cur, hash.digest('hex'), cnt);
    // entidades que tenían composición y en este corte no listan a nadie: versión vacía
    if (prev) {
      for (const { correlativo } of db.prepare('SELECT correlativo FROM igj_composicion WHERE hasta_corte = ?').all(prev)) {
        if (!vistas.has(correlativo)) cerrar(correlativo, '', { socio: 0, autoridad: 0, representante: 0 });
      }
    }
    db.exec('DROP TABLE temp.igj_t');

    db.prepare('INSERT INTO igj_cortes VALUES (?,?,?,?,?,?,?,?)')
      .run(corte, archivo, nEnt, nAut, altas, bajas, cambios, new Date().toISOString());
    db.exec('COMMIT');
    log(`  corte ${corte}: ${nEnt.toLocaleString('es-AR')} entidades, ${nAut.toLocaleString('es-AR')} filas de autoridades` +
      (prev ? ` · ${cambios.toLocaleString('es-AR')} entidades cambiaron (${altas.toLocaleString('es-AR')} altas, ${bajas.toLocaleString('es-AR')} bajas)` : ''));
    return { corte, entidades: nEnt, autoridades: nAut, altas, bajas, cambios };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ------------------------------------------------------------------ archivos del portal
export async function publicados() {
  const resp = await fetch(CATALOGO, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`catálogo IGJ: HTTP ${resp.status}`);
  const { result } = await resp.json();
  return result.resources
    .filter((r) => /\.zip($|\?)/i.test(r.url))
    .map((r) => ({ nombre: String(r.name).replace(/\s+/g, ' ').trim(), url: r.url, publicado: r.last_modified || r.created || null }));
}

// Período de un ZIP sin bajarlo entero: el nombre del primer archivo (encabezado local del ZIP).
// El servidor no siempre respeta Range, así que se lee el comienzo del stream y se corta.
export async function primerCorte(url) {
  const ctrl = new AbortController();
  const resp = await fetch(url, { headers: { 'user-agent': USER_AGENT, range: 'bytes=0-511' }, signal: ctrl.signal });
  const reader = resp.body.getReader();
  let buf = Buffer.alloc(0);
  try {
    while (buf.length < 512) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
    }
  } finally {
    ctrl.abort();
  }
  if (buf.readUInt32LE(0) !== 0x04034b50) return null;
  const name = buf.subarray(30, 30 + buf.readUInt16LE(26)).toString();
  return name.match(/-(\d{6})\.csv$/i)?.[1] ?? null;
}

async function bajar(url, log) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'condor-igj-')), 'igj.zip');
  log(`  descargando ${url}`);
  const resp = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!resp.ok) throw new Error(`descarga falló: HTTP ${resp.status}`);
  await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(file));
  return file;
}

const openZip = (file) => new Promise((res, rej) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (e, z) => (e ? rej(e) : res(z))));
async function entradas(zip) {
  return new Promise((resolve, reject) => {
    const out = [];
    zip.on('entry', (e) => { out.push(e); zip.readEntry(); });
    zip.on('end', () => resolve(out));
    zip.on('error', reject);
    zip.readEntry();
  });
}
const leer = (zip, entry) => new Promise((res, rej) => zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s))));

// Procesa un ZIP (archivo local o URL): sus cortes nuevos, en orden. Devuelve los procesados.
export async function procesarZip({ url, nombre = '', publicado = null }, log = console.log, file = DB_PATH) {
  const local = /^https?:/.test(url) ? await bajar(url, log) : url;
  const db = await open(file, { exclusive: true });
  try {
    const zip = await openZip(local);
    try {
      const porCorte = new Map();
      const raros = [];
      for (const e of await entradas(zip)) {
        const m = e.fileName.match(/igj-(entidades|autoridades)-(\d{6})\.csv$/i);
        if (m) porCorte.set(m[2], { ...porCorte.get(m[2]), [m[1].toLowerCase()]: e });
        else if (/\.csv$/i.test(e.fileName) && !/igj-(asambleas|balances|domicilios)-\d{6}\.csv$/i.test(e.fileName)) raros.push(e.fileName);
      }
      if (!porCorte.size) throw new Error(`no reconozco los archivos del ZIP${raros.length ? `: ${raros.join(', ')}` : ''}`);
      const hechos = new Set(db.prepare('SELECT corte FROM igj_cortes').all().map((r) => r.corte));
      const ultimo = () => db.prepare('SELECT MAX(corte) AS c FROM igj_cortes').get().c;
      const procesados = [];
      const omitidos = [];
      for (const corte of [...porCorte.keys()].sort()) {
        const p = porCorte.get(corte);
        if (hechos.has(corte)) { log(`  corte ${corte}: ya procesado`); continue; }
        if (!p.entidades || !p.autoridades) { log(`  corte ${corte}: incompleto (falta entidades o autoridades), se saltea`); omitidos.push(corte); continue; }
        if (ultimo() && corte < ultimo()) {
          log(`  corte ${corte}: es anterior al último procesado (${ultimo()}); para incorporarlo corré con --forzar`);
          omitidos.push(corte);
          continue;
        }
        procesados.push(await procesarCorte(db, corte, {
          entidades: await leer(zip, p.entidades), autoridades: await leer(zip, p.autoridades), archivo: nombre || url,
        }, log));
      }
      db.prepare('INSERT OR REPLACE INTO igj_archivos VALUES (?,?,?,?,?,?)')
        .run(url, nombre, publicado, new Date().toISOString(), [...porCorte.keys()].sort().join(','), omitidos.join(',') || null);
      return procesados;
    } finally {
      zip.close();
    }
  } finally {
    db.close();
    if (local !== url) fs.rmSync(path.dirname(local), { recursive: true, force: true });
  }
}

// procesarZip en un proceso hijo: si muere por una señal (SIGBUS, OOM…) se informa como error y
// la importación sigue con el archivo siguiente. Lo que no llegó a COMMIT queda descartado por SQLite.
const SENAL = { SIGBUS: 'SIGBUS: falla de acceso a memoria mapeada (típico de SQLite sobre un volumen montado o disco lleno)', SIGKILL: 'SIGKILL: probablemente sin memoria (OOM)', SIGSEGV: 'SIGSEGV: violación de segmento' };
function procesarZipAislado(archivo, log, file) {
  return new Promise((resolve, reject) => {
    // TMPDIR propio: si el hijo muere sin limpiar, el ZIP descargado se borra igual desde acá.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'condor-igj-run-'));
    const child = fork(fileURLToPath(new URL('./igj-worker.js', import.meta.url)), [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, TMPDIR: tmp },
    });
    let res = null;
    child.on('message', (m) => {
      if (m.log !== undefined) log(m.log);
      else res = m;
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (res?.ok) return resolve(res.ok);
      if (res?.error) return reject(new Error(res.error));
      reject(new Error(signal ? `el proceso murió por ${SENAL[signal] || signal}` : `el proceso terminó con código ${code}`));
    });
    child.send({ archivo, file });
  });
}

// Todo lo publicado que falte (o se haya republicado). forzar: borra la historia IGJ y la rehace.
export async function sincronizarIgj({ forzar = false, catalogo = null } = {}, log = console.log, file = DB_PATH) {
  const db = await open(file);
  let hechos;
  try {
    if (forzar) {
      log('IGJ: borrando la historia para reconstruirla');
      db.exec('DELETE FROM igj_autoridades; DELETE FROM igj_composicion; DELETE FROM igj_entidades; DELETE FROM igj_cortes; DELETE FROM igj_archivos;');
    }
    hechos = new Map(db.prepare('SELECT url, publicado FROM igj_archivos').all().map((r) => [r.url, r.publicado]));
  } finally {
    db.close();
  }
  const lista = (catalogo ?? (await publicados())).filter((a) => {
    if (!hechos.has(a.url)) return true;
    const prev = hechos.get(a.url);
    return a.publicado && (!prev || a.publicado > prev);
  });
  if (!lista.length) {
    const e = await estadoIgj(file);
    log(`IGJ: nada nuevo para importar${e?.ultimo ? ` (último corte procesado: ${e.ultimo})` : ''}`);
    return [];
  }
  // Ordenar por el período real (primer archivo de cada ZIP), no por la etiqueta del portal.
  log(`IGJ: ${lista.length} archivo(s) por revisar, ordenando por período…`);
  for (const a of lista) a.orden ??= /^https?:/.test(a.url) ? await primerCorte(a.url).catch(() => null) : null;
  lista.sort((a, b) => (a.orden || '999999').localeCompare(b.orden || '999999') || a.nombre.localeCompare(b.nombre));
  const out = [];
  for (const a of lista) {
    log(`IGJ ${a.nombre}${a.orden ? ` (desde ${a.orden})` : ''}:`);
    try {
      out.push(...(await procesarZipAislado(a, log, file)));
    } catch (e) {
      log(`  error: ${e.message} — se saltea; se reintenta en la próxima corrida`);
    }
  }
  return out;
}

export async function estadoIgj(file = DB_PATH) {
  if (!fs.existsSync(file)) return null;
  const db = await open(file);
  try {
    const cortes = db.prepare('SELECT * FROM igj_cortes ORDER BY corte').all();
    if (!cortes.length) return null;
    return {
      cortes,
      ultimo: cortes.at(-1).corte,
      entidades: db.prepare('SELECT COUNT(*) AS c FROM igj_entidades').get().c,
      conCuit: db.prepare("SELECT COUNT(*) AS c FROM igj_entidades WHERE cuit IS NOT NULL AND cuit != ''").get().c,
      omitidos: db.prepare('SELECT nombre, omitidos FROM igj_archivos WHERE omitidos IS NOT NULL').all(),
    };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ consultas
// Composición actual (último corte procesado) y versiones de una entidad IGJ por CUIT.
export function igjPorCuit(d, cuit) {
  const hasTables = d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'igj_entidades'").get();
  if (!hasTables) return null;
  const ent = d.prepare('SELECT * FROM igj_entidades WHERE cuit = ? ORDER BY ultimo_corte DESC LIMIT 1').get(String(cuit));
  if (!ent) return null;
  const ultimo = d.prepare('SELECT MAX(corte) AS c FROM igj_cortes').get().c;
  return {
    entidad: ent,
    ultimo_corte: ultimo,
    actuales: d.prepare(`SELECT rol, tipo_doc, documento, nombre, desde_corte FROM igj_autoridades
      WHERE correlativo = ? AND hasta_corte = ? ORDER BY rol DESC, nombre`).all(ent.correlativo, ultimo),
    versiones: d.prepare('SELECT * FROM igj_composicion WHERE correlativo = ? ORDER BY desde_corte').all(ent.correlativo),
    historicas: d.prepare(`SELECT rol, tipo_doc, documento, nombre, desde_corte, hasta_corte FROM igj_autoridades
      WHERE correlativo = ? AND hasta_corte < ? ORDER BY hasta_corte DESC, nombre`).all(ent.correlativo, ultimo),
  };
}

export const fmtCorte = (c) => (c ? `${c.slice(4, 6)}/${c.slice(0, 4)}` : '—');
