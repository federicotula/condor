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
