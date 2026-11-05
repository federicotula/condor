import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cuitsFromDni, isValidCuit } from '../src/core/ar.js';
import { ConfigStore } from '../src/core/config.js';
import { Engine } from '../src/core/engine.js';
import { detect, normalize } from '../src/core/facts.js';
import { MemoryStore } from '../src/core/store.js';

const quiet = { info() {}, warn() {}, error() {} };

function makeEngine(modules, cfg) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'condor-')), 'modules.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  return new Engine({
    store: new MemoryStore(), config: new ConfigStore(file), llm: null, logger: quiet,
    modules: new Map(modules.map((m) => [m.id, m])), searchers: new Map(),
  });
}

const byModule = (run, id) => Object.values(run.nodes).filter((n) => n.module_id === id);

test('detect / normalize', () => {
  assert.deepEqual(detect('20-12345678-6'), { cuit: ['20123456786'] });
  assert.deepEqual(detect('12.345.678'), { dni: ['12345678'] });
  assert.deepEqual(detect('a@b.com'), { email: ['a@b.com'] });
  assert.deepEqual(detect('domicilio: Florida 100'), { domicilio: ['Florida 100'] });
  assert.equal(normalize('domicilio', 'Av. Córdoba 1500, CABA'), normalize('domicilio', 'AV CORDOBA 1500 - caba'));
});

test('cuits desde dni son válidos', () => {
  const cuits = cuitsFromDni('12345678');
  assert.ok(cuits.length >= 2);
  for (const c of cuits) assert.ok(isValidCuit(c), c);
});

test('dedup, skip, error y ramas', async () => {
  const calls = [];
  const modules = [
    { id: 'a', requires: ['id'], run: async () => ({ facts: { domicilio: ['Calle 1, X'], email: ['x@y.z'] } }) },
    { id: 'b', requires: ['email'], run: async () => ({ facts: { domicilio: ['CALLE 1 - x', 'Otra 2'] } }) },
    { id: 'geo', requires: ['domicilio'], run: async (ctx) => { calls.push(ctx.inputs.domicilio); return {}; } },
    { id: 'tel', requires: ['telefono'], run: async () => ({}) },
    { id: 'boom', requires: ['id'], run: async () => { throw new Error('falla'); } },
    { id: 'after_boom', requires: ['id'], run: async () => ({}) },
    { id: 'off', requires: ['id'], run: async () => ({}) },
  ];
  const engine = makeEngine(modules, {
    roots: ['a', 'boom', 'off'],
    modules: {
      a: { enabled: true, triggers: ['geo', 'b', 'tel'] },
      b: { enabled: true, triggers: ['geo'] },
      geo: { enabled: true }, tel: { enabled: true },
      boom: { enabled: true, triggers: ['after_boom'] }, after_boom: { enabled: true },
      off: { enabled: false },
    },
  });
  const run = await engine.run({ label: 'P', facts: { id: ['1'] } });

  assert.equal(run.status, 'done');
  assert.deepEqual(calls.sort(), ['Calle 1, X', 'Otra 2']);       // cada domicilio distinto, una sola vez
  assert.deepEqual(byModule(run, 'geo').map((n) => n.status).sort(), ['done', 'done', 'duplicate']);
  assert.equal(byModule(run, 'tel')[0].status, 'skipped');        // falta telefono
  assert.equal(byModule(run, 'boom')[0].status, 'error');
  assert.equal(byModule(run, 'after_boom')[0].status, 'skipped'); // padre falló
  assert.equal(byModule(run, 'off').length, 0);                   // deshabilitado: no aparece
});

test('hijo no se dispara si el padre no aportó el dato', async () => {
  const modules = [
    { id: 'a', requires: ['id'], run: async () => ({ facts: { otro: ['z'] } }) },
    { id: 'c', requires: ['id'], run: async () => ({}) },
  ];
  const engine = makeEngine(modules, { roots: ['a'], modules: { a: { enabled: true, triggers: ['c'] }, c: { enabled: true } } });
  const run = await engine.run({ label: 'P', facts: { id: ['1'] } });
  const c = byModule(run, 'c')[0];
  assert.equal(c.status, 'skipped');
  assert.match(c.reason, /no aportó/);
});

test('ciclos terminan por deduplicación y el timeout funciona', async () => {
  const modules = [
    { id: 'loop', requires: ['x'], run: async (ctx) => ({ facts: { x: [ctx.inputs.x] } }) },
    { id: 'slow', requires: ['x'], timeout: 0.05, run: () => new Promise((r) => setTimeout(r, 1000)) },
  ];
  const engine = makeEngine(modules, {
    roots: ['loop', 'slow'],
    modules: { loop: { enabled: true, triggers: ['loop'] }, slow: { enabled: true } },
  });
  const run = await engine.run({ label: 'P', facts: { x: ['1'] } });
  assert.deepEqual(byModule(run, 'loop').map((n) => n.status), ['done', 'duplicate']);
  assert.match(byModule(run, 'slow')[0].error, /timeout/);
});

test('view se guarda en el nodo y en caché', async () => {
  let calls = 0;
  const modules = [{
    id: 'v', requires: ['x'], cacheTtl: 60,
    run: async () => { calls++; return { data: { a: 1 }, view: { type: 'kv', items: [{ label: 'a', value: 1 }] } }; },
  }];
  const engine = makeEngine(modules, { roots: ['v'], modules: { v: { enabled: true } } });
  const r1 = await engine.run({ label: 'P', facts: { x: ['1'] } });
  const r2 = await engine.run({ label: 'P', facts: { x: ['1'] } });
  const n1 = byModule(r1, 'v')[0];
  const n2 = byModule(r2, 'v')[0];
  assert.deepEqual(n1.view, [{ type: 'kv', items: [{ label: 'a', value: 1 }] }]); // objeto suelto -> array
  assert.equal(calls, 1);
  assert.ok(n2.cached);
  assert.deepEqual(n2.view, n1.view);
});

test('cacheClear borra todo o por módulo', async () => {
  const st = new MemoryStore();
  await st.cacheSet('a|x=1#s#h', 1, 60);
  await st.cacheSet('b|x=1#s#h', 2, 60);
  assert.equal(await st.cacheClear('a'), 1);
  assert.equal(await st.cacheGet('a|x=1#s#h'), null);
  assert.equal(await st.cacheClear(), 1);
});

test('splitDireccion', async () => {
  const { splitDireccion } = await import('../src/core/ar.js');
  assert.deepEqual(splitDireccion('Av. Corrientes 1500, CABA'), { calle: 'Av. Corrientes', numero: 1500, localidad: null, provincia: 'CABA' });
  assert.deepEqual(splitDireccion('PERON, JUAN TTE.GRAL. 430, piso 6, CAPITAL FEDERAL, CIUDAD AUTONOMA BUENOS AIRES'),
    { calle: 'PERON JUAN TTE.GRAL.', numero: 430, localidad: 'CAPITAL FEDERAL', provincia: 'CIUDAD AUTONOMA BUENOS AIRES' });
  assert.equal(splitDireccion('25 de Mayo 100').numero, 100);
  assert.equal(splitDireccion('25 de Mayo 100').calle, '25 de Mayo');
  assert.equal(splitDireccion('Calle 7 1234 - La Plata').numero, 1234);
  assert.equal(splitDireccion('sin numero'), null);
});

test('ctx.ask: responder, saltear y vencer', async () => {
  const seen = [];
  const modules = [
    { id: 'q', requires: ['x'], run: async (ctx) => {
      const a = await ctx.ask({ title: 't', fields: [{ name: 'codigo' }] });
      seen.push(a);
      return a ? { facts: { codigo: [a.codigo] } } : { noCache: true, summary: 'salteado' };
    } },
    { id: 'slowask', requires: ['x'], run: async (ctx) => { await ctx.ask({ timeoutSec: 0.05 }); return {}; } },
  ];
  const engine = makeEngine(modules, { roots: ['q', 'slowask'], modules: { q: { enabled: true }, slowask: { enabled: true } } });
  const run = engine.start({ label: 'P', facts: { x: ['1'] } });
  // esperar a que el nodo q quede pidiendo respuesta
  let qn;
  for (let i = 0; i < 100 && !(qn = byModule(run, 'q')[0])?.ask; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(qn.status, 'input');
  assert.equal(engine.answer(run.id, qn.id, 'otro-id', { codigo: 'x' }), false);
  assert.equal(engine.answer(run.id, qn.id, qn.ask.id, { codigo: 'ABC' }), true);
  await engine.wait(run.id);
  assert.deepEqual(seen, [{ codigo: 'ABC' }]);
  assert.equal(byModule(run, 'q')[0].status, 'done');
  assert.equal(byModule(run, 'q')[0].ask, null);
  assert.match(byModule(run, 'slowask')[0].error, /sin respuesta/);

  // con askHandler (CLI) y salteando
  engine.askHandler = async () => null;
  const run2 = await engine.run({ label: 'P', facts: { x: ['2'] } });
  assert.equal(byModule(run2, 'q')[0].summary, 'salteado');
});

test('clearRuns conserva las corridas activas', async () => {
  const st = new MemoryStore();
  await st.saveRun({ id: 'a', created_at: 1, nodes: {} });
  await st.saveRun({ id: 'b', created_at: 2, nodes: {} });
  assert.equal(await st.clearRuns(['b']), 1);
  assert.deepEqual((await st.listRuns()).map((r) => r.id), ['b']);
});

test('parseConstancia (formato por secciones de ARCA)', async () => {
  const { parseConstancia } = await import('../src/modules/arca_constancia_web.js');
  const { splitDireccion } = await import('../src/core/ar.js');
  const base = (impuestos) => [
    'Formulario de Impresión de Constancia de', 'Inscripción', 'Volver', 'Imprimir Pantalla',
    'AGENCIA DE RECAUDACION Y CONTROL ADUANERO', 'CONSTANCIA DE INSCRIPCION', 'PEREZ JUAN CARLOS', 'CUIT:', '20-11111111-2',
    'IMPUESTOS/REGIMENES NACIONALES REGISTRADOS Y FECHA DE ALTA', ...impuestos,
    '****************************************************',
    'Contribuyente no amparado en los beneficios promocionales INDUSTRIALES establecidos por Ley 22021.',
    'Esta constancia no da cuenta de la inscripción en:', '- Impuesto Bienes Personales: de corresponder,', 'deberán solicitarse en la dependencia.',
    'DOMICILIO FISCAL - ARCA', 'FLORIDA 100 Piso:3 Dpto:B - BARRIO : SAN NICOLAS', '1005-CIUDAD AUTONOMA BUENOS AIRES',
    'Vigencia de la', 'presente constancia: 05-11-2026', 'a 05-12-2026', 'Hora', '18:35:20', 'Verificador', '123456789012',
    'Los datos contenidos en', 'la presente constancia deberán ser validados por el receptor',
  ];
  const c = parseConstancia(base(['No registra', 'impuestos activos']));
  assert.equal(c.nombre, 'PEREZ JUAN CARLOS');
  assert.equal(c.cuit, '20-11111111-2');
  assert.equal(c.sinImpuestos, true);
  assert.deepEqual(c.impuestos, []);
  assert.deepEqual(c.vigencia, { desde: '05-11-2026', hasta: '05-12-2026' });
  assert.equal(c.hora, '18:35:20');
  assert.equal(c.verificador, '123456789012');
  assert.equal(c.notas.length, 3);
  const d = c.domicilios[0];
  assert.equal(d.tipo, 'DOMICILIO FISCAL - ARCA');
  assert.deepEqual([d.calle, d.piso, d.dpto, d.barrio, d.cp, d.localidad], ['FLORIDA 100', '3', 'B', 'SAN NICOLAS', '1005', 'CIUDAD AUTONOMA BUENOS AIRES']);
  assert.equal(d.texto, 'FLORIDA 100, piso 3 dto B, SAN NICOLAS, CIUDAD AUTONOMA BUENOS AIRES');
  // el texto del domicilio tiene que poder separarse para Georef / sociedades
  assert.deepEqual(splitDireccion(d.texto), { calle: 'FLORIDA', numero: 100, localidad: 'SAN NICOLAS', provincia: 'CIUDAD AUTONOMA BUENOS AIRES' });

  const c2 = parseConstancia(base(['GANANCIAS PERSONAS FISICAS 03-2015', 'IVA 03-2015']));
  assert.equal(c2.sinImpuestos, false);
  assert.deepEqual(c2.impuestos, [{ impuesto: 'GANANCIAS PERSONAS FISICAS', alta: '03-2015' }, { impuesto: 'IVA', alta: '03-2015' }]);
});

test('search: tipo explícito, buscador puntual y resultados manuales', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'condor-')), 'modules.json');
  fs.writeFileSync(file, JSON.stringify({
    roots: [], modules: {},
    searchers: { manual: { enabled: true }, pornombre: { enabled: true }, directo: { enabled: true } },
  }));
  const searchers = new Map([
    ['manual', { id: 'manual', accepts: ['nombre'], manual: true, search: (ctx) => [{ manual: true, label: 'M', url: `https://x/?q=${ctx.detected.nombre[0]}` }] }],
    ['pornombre', { id: 'pornombre', accepts: ['nombre'], search: () => [{ label: 'Ana', facts: { cuit: ['20123456786'] } }] }],
    ['directo', { id: 'directo', accepts: ['nombre', 'cuit', 'dni'], fallback: true, search: (ctx) => [{ label: 'directo', facts: ctx.detected }] }],
  ]);
  const engine = new Engine({ store: new MemoryStore(), config: new ConfigStore(file), llm: null, logger: quiet, modules: new Map(), searchers });

  // auto: "12345678" es DNI; forzando nombre se trata como nombre.
  assert.deepEqual((await engine.search('12345678')).detected, { dni: ['12345678'] });
  const all = await engine.search('12345678', { kind: 'nombre' });
  assert.deepEqual(all.detected, { nombre: ['12345678'] });
  assert.equal(all.candidates.length, 1);
  assert.equal(all.manual.length, 1);
  assert.equal(all.manual[0].field, 'cuit');

  // un buscador puntual: sólo ese, y un resultado manual evita el fallback.
  const only = await engine.search('ana', { kind: 'nombre', searcher: 'manual' });
  assert.equal(only.candidates.length, 0);
  assert.equal(only.manual[0].url, 'https://x/?q=ana');
  await assert.rejects(engine.search('ana', { searcher: 'nope' }), /no está habilitado/);

  // cuit/dni explícitos se validan y normalizan.
  assert.deepEqual((await engine.search('20-12345678-6', { kind: 'cuit' })).detected, { cuit: ['20123456786'] });
  await assert.rejects(engine.search('123', { kind: 'cuit' }), /11 dígitos/);
  await assert.rejects(engine.search('20123456786', { kind: 'dni' }), /DNI/);
});

test('sociedades: histórico por año, bajas, reapariciones y sólo lo nuevo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'condor-soc-'));
  const file = path.join(dir, 'sociedades.db');
  const head = 'cuit,razon_social,fecha_hora_contrato_social,tipo_societario,fecha_hora_actualizacion,actividad_codigo';
  const csv = (anio, cuits) => {
    const f = path.join(dir, `${anio}.csv`);
    fs.writeFileSync(f, [head, ...cuits.flatMap((c) => [`${c},SOC ${c},2000-01-01,SA,${anio}-01-01,1`, `${c},SOC ${c},2000-01-01,SA,${anio}-01-01,2`])].join('\n'));
    return f;
  };
  const { sincronizar, procesados, estadoRegistro } = await import('../src/lib/sociedades.js');
  const cat = [
    { serie: 'sociedades', anio: 2019, url: csv(2019, ['A', 'B', 'C']), publicado: '2026-03-01' },
    { serie: 'sociedades', anio: 2020, url: csv(2020, ['A', 'C']), publicado: '2026-03-01' },        // B se va
    { serie: 'sociedades', anio: 2021, url: csv(2021, ['A', 'B', 'D']), publicado: '2026-03-01' },   // B vuelve, C se va
  ];
  await sincronizar({ catalogo: cat }, () => {}, file);
  assert.deepEqual(await sincronizar({ catalogo: cat }, () => {}, file), []); // segunda corrida: nada
  const reg = async () => Object.fromEntries((await consultar(file, 'SELECT * FROM registro')).map((r) => [r.cuit, r]));
  let r = await reg();
  assert.equal(r.A.baja_desde, null);
  assert.equal(r.B.baja_desde, null);           // reapareció
  assert.equal(r.C.baja_desde, 2021);
  assert.equal(r.C.ultimo_anio, 2020);
  assert.equal(r.D.primer_anio, 2021);
  const padron2020 = (await consultar(file, "SELECT cuit FROM padron WHERE serie = 'sociedades' AND anio = 2020 ORDER BY cuit")).map((x) => x.cuit);
  assert.deepEqual(padron2020, ['A', 'C']);

  // sólo lo nuevo: nada cambió -> no importa nada
  assert.deepEqual(await sincronizar({ solo: 'nuevos', catalogo: cat }, () => {}, file), []);
  // 2021 republicado sin D, y aparece 2022 sin A
  cat[2] = { ...cat[2], url: csv(2021, ['A', 'B']), publicado: '2026-09-18' };
  cat.push({ serie: 'sociedades', anio: 2022, url: csv(2022, ['B']), publicado: '2026-09-18' });
  const hechos = await sincronizar({ solo: 'nuevos', catalogo: cat }, () => {}, file);
  assert.deepEqual(hechos.map((h) => h.anio), [2021, 2022]);
  r = await reg();
  assert.equal(r.A.baja_desde, 2022);
  assert.equal(r.D.ultimo_anio, null);           // ya no figura en ningún año procesado
  assert.equal(r.D.baja_desde, 2019);
  assert.equal((await procesados(file)).at(-1).anio, 2022);

  // un archivo que falla a mitad no deja la base a medias
  cat.push({ serie: 'sociedades', anio: 2023, url: path.join(dir, 'no-existe.csv'), publicado: '2026-10-01' });
  await assert.rejects(sincronizar({ solo: 'nuevos', catalogo: cat }, () => {}, file));
  assert.equal((await procesados(file)).at(-1).anio, 2022);

  assert.deepEqual(estadoRegistro([{ serie: 'sociedades', primer_anio: 2019, ultimo_anio: 2020, baja_desde: 2021 }]),
    { vigente: false, primer_anio: 2019, ultimo_anio: 2020, baja_desde: 2021, series: ['sociedades'] });
});

// ZIP mínimo sin compresión (sólo para tests).
async function zipStore(file, entries) {
  const { crc32 } = await import('node:zlib');
  const parts = []; const central = []; let off = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text); const n = Buffer.from(name); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, n, data); central.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, cd, end]));
}

test('IGJ: evolución de autoridades por corte y sólo lo nuevo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'condor-igj-'));
  const file = path.join(dir, 'sociedades.db');
  const ent = (rows) => ['﻿numero_correlativo,tipo_societario,descripcion_tipo_societario,razon_social,dada_de_baja,codigo_baja,detalle_baja,cuit',
    ...rows].join('\n');
  const aut = (rows) => ['numero_correlativo,apellido_nombre,tipo_administrador,descripcion_tipo_administrador,tipo_documento,descripcion_tipo_documento,numero_documento,genero_autoridad',
    ...rows.map(([c, nom, rol, doc]) => `${c},${nom},${rol},X,1,DNI,${doc},`)].join('\n');
  const E = ent(['1,40,SRL,ALFA SRL,,,,30111111118', '2,50,SA,BETA SA,,,,']);
  const z1 = path.join(dir, 'a.zip');
  await zipStore(z1, {
    'igj-entidades-202601.csv': E,
    'igj-autoridades-202601.csv': aut([[1, 'PEREZ JUAN', 'S', '111'], [1, 'PEREZ JUAN', 'S', '111'], [1, 'GOMEZ ANA', 'A', '222'], [2, 'ROJAS LUIS', 'A', '333']]),
    'igj-entidades-202602.csv': E, // sin cambios
    'igj-autoridades-202602.csv': aut([[1, 'PEREZ JUAN', 'S', '111'], [1, 'GOMEZ  ANA', 'A', '222'], [2, 'ROJAS LUIS', 'A', '333']]),
    'igj-asambleas-202602.csv': 'x',
  });
  const z2 = path.join(dir, 'b.zip');
  await zipStore(z2, {
    'igj-entidades-202603.csv': E, // en 1 sale GOMEZ y entra DIAZ; 2 se queda sin nadie
    'igj-autoridades-202603.csv': aut([[1, 'PEREZ JUAN', 'S', '111'], [1, 'DIAZ EVA', 'A', '444']]),
  });
  const { sincronizarIgj, estadoIgj } = await import('../src/lib/igj.js');
  const cat = [{ nombre: 'b', url: z2, publicado: '1' }, { nombre: 'a', url: z1, publicado: '1' }];
  // sin `orden` (archivos locales) se procesan por nombre: a (01-02) y después b (03)
  const r = await sincronizarIgj({ catalogo: cat }, () => {}, file);
  assert.deepEqual(r.map((x) => x.corte), ['202601', '202602', '202603']);
  assert.deepEqual(r.map((x) => x.cambios), [0, 0, 2]);
  const q = (sql, ...a) => consultar(file, sql, ...a);
  // PEREZ sigue de 01 a 03 en una sola fila; GOMEZ (espacios distintos = mismo nombre) cerró en 02
  assert.deepEqual(await q("SELECT nombre, desde_corte, hasta_corte FROM igj_autoridades WHERE correlativo = '1' ORDER BY nombre"), [
    { nombre: 'DIAZ EVA', desde_corte: '202603', hasta_corte: '202603' },
    { nombre: 'GOMEZ ANA', desde_corte: '202601', hasta_corte: '202602' },
    { nombre: 'PEREZ JUAN', desde_corte: '202601', hasta_corte: '202603' },
  ]);
  // composición: 1 tuvo dos versiones; 2 pasó a vacía
  assert.deepEqual(await q("SELECT correlativo, desde_corte, hasta_corte, socios, autoridades, altas, bajas FROM igj_composicion ORDER BY correlativo, desde_corte"), [
    { correlativo: '1', desde_corte: '202601', hasta_corte: '202602', socios: 1, autoridades: 1, altas: 2, bajas: 0 },
    { correlativo: '1', desde_corte: '202603', hasta_corte: '202603', socios: 1, autoridades: 1, altas: 1, bajas: 1 },
    { correlativo: '2', desde_corte: '202601', hasta_corte: '202602', socios: 0, autoridades: 1, altas: 1, bajas: 0 },
    { correlativo: '2', desde_corte: '202603', hasta_corte: '202603', socios: 0, autoridades: 0, altas: 0, bajas: 1 },
  ]);
  assert.equal((await estadoIgj(file)).ultimo, '202603');

  // segunda corrida: nada; un ZIP republicado con cortes ya hechos no reprocesa; uno viejo se saltea
  assert.deepEqual(await sincronizarIgj({ catalogo: cat }, () => {}, file), []);
  const z0 = path.join(dir, 'c.zip');
  await zipStore(z0, { 'igj-entidades-202512.csv': E, 'igj-autoridades-202512.csv': aut([[1, 'X', 'S', '9']]) });
  const logs = [];
  const r2 = await sincronizarIgj({ catalogo: [...cat.map((c) => ({ ...c, publicado: '2' })), { nombre: 'c', url: z0, publicado: '1' }] }, (m) => logs.push(m), file);
  assert.deepEqual(r2, []);
  assert.ok(logs.some((m) => /202512.*anterior al último/.test(m)));
  assert.equal((await estadoIgj(file)).omitidos.length, 1);

  // --forzar reconstruye (ordenado por nombre: a, b, c → 202512 queda afuera por ser anterior)
  const r3 = await sincronizarIgj({ forzar: true, catalogo: [{ nombre: '0', url: z0, publicado: '1' }, ...cat] }, () => {}, file);
  assert.deepEqual(r3.map((x) => x.corte), ['202512', '202601', '202602', '202603']);
});

// Consulta y cierra: una conexión abierta impediría que la importación tome la base en exclusiva.
async function consultar(file, sql, ...args) {
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(file);
  try { return d.prepare(sql).all(...args).map((x) => ({ ...x })); } finally { d.close(); }
}
