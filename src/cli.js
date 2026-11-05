#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Command } from 'commander';
import { buildEngine } from './core/bootstrap.js';
import { merge } from './core/facts.js';

// --------------------------------------------------------------- colores / árbol
const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = { dim: c(2), bold: c(1), green: c(32), red: c(31), blue: c(34), yellow: c(33), magenta: c(35), gray: c(90) };

const ICON = {
  waiting: C.gray('… esperando'), pending: C.gray('◌ en cola'), running: C.blue('▶ ejecutando'), input: C.yellow('? tu respuesta'),
  done: C.green('✔'), error: C.red('✘'), skipped: C.dim('⊘ no se ejecuta'), duplicate: C.magenta('≡ duplicado'),
};

function renderTree(run, { details = false } = {}) {
  const nodes = run.nodes;
  const root = nodes[run.root_id];
  if (!root) return [];
  const facts = Object.entries(root.facts).map(([k, v]) => `${k}=${v.join(',')}`).join(' ');
  const lines = [`${C.bold(root.module_name)} ${C.dim(facts)}`];
  const walk = (n, prefix, last) => {
    const inputs = Object.entries(n.inputs || {}).map(([k, v]) => `${k}=${v}`).join(' ');
    const info = n.status === 'done' ? n.summary : n.status === 'error' ? C.red(n.error) : C.dim(n.reason || '');
    const time = n.started_at && n.finished_at ? C.dim(` ${(n.finished_at - n.started_at).toFixed(1)}s`) : '';
    const cached = n.cached ? C.dim(' [caché]') : '';
    lines.push(`${prefix}${last ? '└─ ' : '├─ '}${ICON[n.status]} ${C.bold(n.module_name)} ${C.dim(inputs)} ${info}${time}${cached}`);
    const childPrefix = prefix + (last ? '   ' : '│  ');
    if (details && n.status === 'done' && Object.keys(n.facts).length) {
      for (const [k, v] of Object.entries(n.facts)) lines.push(`${childPrefix}${C.gray(`  · ${k}: ${v.join(' | ')}`)}`);
    }
    n.children.forEach((id, i) => walk(nodes[id], childPrefix, i === n.children.length - 1));
  };
  root.children.forEach((id, i) => walk(nodes[id], '', i === root.children.length - 1));
  return lines;
}

const collectedFacts = (run) => merge(...Object.values(run.nodes).filter((n) => n.status === 'done').map((n) => n.facts));

// Redibuja el árbol en el mismo lugar de la terminal.
function liveRenderer() {
  let prev = 0;
  return (lines) => {
    if (!tty) return;
    const rows = process.stdout.rows || 50;
    const shown = lines.length > rows - 2 ? [...lines.slice(0, rows - 3), C.dim(`… (${lines.length - rows + 3} más)`)] : lines;
    let out = prev ? `\x1b[${prev}A\x1b[0J` : '';
    out += shown.map((l) => l.slice(0, 400)).join('\n') + '\n';
    process.stdout.write(out);
    prev = shown.length;
  };
}

async function withEngine(fn) {
  const engine = await buildEngine(undefined, { ...console, info: () => {} });
  try { return await fn(engine); } finally { await engine.close(); }
}

// --------------------------------------------------------------- comandos
const program = new Command();
program.name('condor').description('Búsqueda de información sobre personas mediante módulos encadenados');

program.command('search')
  .description('Busca personas por un identificador y ejecuta el árbol de módulos')
  .argument('<query...>', 'nombre, DNI, CUIT, email… (o "tipo: valor")')
  .option('-t, --tipo <tipo>', 'buscar como: auto (default), nombre, dni o cuit', 'auto')
  .option('-b, --buscador <id>', 'usar sólo este buscador (ver `condor modules`)')
  .option('-p, --pick <n>', 'elegir el candidato n sin preguntar (o un CUIT/CUIL si hay búsqueda manual)')
  .option('-j, --json <file>', 'guardar la corrida completa en un JSON')
  .option('-d, --details', 'mostrar los datos encontrados por cada módulo')
  .action(async (parts, opts) => withEngine(async (engine) => {
    let query = parts.join(' ');
    let res = await engine.search(query, { kind: opts.tipo, searcher: opts.buscador || null });
    let pick = opts.pick;
    let person = null;
    for (;;) {
      for (const e of res.errors) console.error(C.yellow(`! ${e.searcher}: ${e.error}`));
      const kind = Object.keys(res.detected)[0] || '?';
      if (!res.candidates.length && !res.manual.length) { console.error(`Sin resultados (buscado como ${kind}).`); process.exitCode = 1; return; }
      if (res.candidates.length === 1 && !res.manual.length) { person = res.candidates[0]; break; }

      res.candidates.forEach((cand, i) => console.log(`  ${C.bold(i + 1)}) ${cand.label} ${C.dim([cand.detail, cand.sources.join(',')].filter(Boolean).join(' · '))}`));
      for (const m of res.manual) console.log(`  ${C.yellow('↗')} ${m.label}: ${m.url}\n    ${C.dim(`buscá a mano y escribí acá el ${m.field}`)}`);
      let answer = pick;
      pick = undefined; // --pick vale sólo para la primera pregunta
      if (!answer) {
        const range = res.candidates.length ? `[1-${res.candidates.length}]` : '';
        const hint = [range, ...new Set(res.manual.map((m) => m.field))].filter(Boolean).join(' o ');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        answer = await rl.question(`¿Cuál? ${hint}: `);
        rl.close();
      }
      answer = String(answer).trim();
      const n = /^\d{1,3}$/.test(answer) ? Number(answer) : NaN;
      if (res.candidates[n - 1]) { person = res.candidates[n - 1]; break; }
      const field = res.manual[0]?.field;
      if (!field || !answer) { console.error('Opción inválida'); process.exitCode = 1; return; }
      query = `${query} → ${answer}`;
      res = await engine.search(answer, { kind: field });
    }
    console.log(C.dim(`→ ${person.label}\n`));

    // Preguntas de módulos (ctx.ask), p.ej. captchas: se pausa el árbol y se pregunta acá.
    let paused = false;
    let draw = liveRenderer();
    let queue = Promise.resolve();
    engine.askHandler = ({ node, ask }) => (queue = queue.then(() => askInTerminal(node, ask)));
    async function askInTerminal(node, ask) {
      paused = true;
      try {
        console.log(`\n${C.yellow('?')} ${C.bold(node.module_name)}: ${ask.title}`);
        if (ask.text) console.log(C.dim(ask.text));
        if (ask.image?.startsWith('data:')) {
          const [, ext, b64] = ask.image.match(/^data:image\/(\w+);base64,(.*)$/) || [];
          if (b64) {
            const file = path.join(os.tmpdir(), `condor-${ask.id}.${ext === 'jpeg' ? 'jpg' : ext}`);
            fs.writeFileSync(file, Buffer.from(b64, 'base64'));
            console.log(`  imagen: ${file}`);
            if (process.platform === 'darwin') spawn('open', [file], { stdio: 'ignore', detached: true }).unref();
          }
        }
        const hint = ask.actions.includes('refresh') ? ' (enter = saltear, "r" = otra imagen)' : ' (enter = saltear)';
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const values = {};
        try {
          for (const f of ask.fields) {
            const v = (await rl.question(`  ${f.label || f.name}${f.help ? C.dim(` [${f.help}]`) : ''}${C.dim(hint)}: `)).trim();
            if (!v) return null;
            if (v.toLowerCase() === 'r' && ask.actions.includes('refresh')) return { __action: 'refresh' };
            values[f.name] = v;
          }
        } finally { rl.close(); }
        return values;
      } finally {
        paused = false;
        draw = liveRenderer(); // arrancar a dibujar de nuevo debajo de la pregunta
      }
    }

    const run = engine.start(person, query);
    const timer = setInterval(() => { if (!paused) draw(renderTree(run)); }, 250);
    await engine.wait(run.id);
    clearInterval(timer);
    if (tty) draw(renderTree(run, { details: opts.details }));
    else console.log(renderTree(run, { details: opts.details }).join('\n'));

    console.log(`\n${C.bold('Datos recolectados')}`);
    for (const [k, v] of Object.entries(collectedFacts(run))) console.log(`  ${C.bold(k)}: ${v.join(' | ')}`);
    console.log(C.dim(`\ncorrida ${run.id} · ${run.status} · store: ${engine.store.name}`));
    if (opts.json) { fs.writeFileSync(opts.json, JSON.stringify(run, null, 2)); console.log(C.dim(`guardado en ${opts.json}`)); }
  }));

program.command('modules')
  .description('Muestra los módulos disponibles y el árbol configurado (config/modules.json)')
  .action(async () => withEngine(async (engine) => {
    const cfg = engine.config.load();
    const cat = await engine.catalog();
    console.log(C.bold(`Árbol (${engine.config.file})`));
    console.log('Persona');
    const walk = (id, prefix, last, path) => {
      const m = cat.modules.find((x) => x.id === id);
      const e = cfg.modules[id] || {};
      const name = m ? `${m.name} ${C.dim(`(${id}) ${m.requires.join(',') || '—'} → ${m.provides.join(',') || '—'}`)}` : C.red(`${id} (sin código)`);
      const state = e.enabled ? C.green('●') : C.gray('○');
      const cycle = path.includes(id) ? C.magenta(' ↻ ciclo') : '';
      const probs = e.enabled && m?.problems?.length ? C.red(` ⚠ ${m.problems.join('; ')}`) : '';
      console.log(`${prefix}${last ? '└─ ' : '├─ '}${state} ${name}${cycle}${probs}`);
      if (cycle) return;
      const t = e.triggers || [];
      t.forEach((c2, i) => walk(c2, prefix + (last ? '   ' : '│  '), i === t.length - 1, [...path, id]));
    };
    cfg.roots.forEach((r, i) => walk(r, '', i === cfg.roots.length - 1, []));
    console.log(`\n${C.bold('Buscadores')}`);
    for (const s of cat.searchers) console.log(`  ${cfg.searchers[s.id]?.enabled ? C.green('●') : C.gray('○')} ${s.name} ${C.dim(`(${s.id}) por ${s.accepts.join(',')}`)}`);
    for (const e of cat.errors) console.log(C.red(`! ${e.file}: ${e.error}`));
    console.log(C.dim('\nPara habilitar/deshabilitar o cambiar el árbol, editá el JSON o usá la web.'));
  }));

program.command('runs')
  .description('Lista las últimas corridas guardadas (requiere Redis)')
  .action(async () => withEngine(async (engine) => {
    for (const r of await engine.store.listRuns(30)) {
      console.log(`${r.id}  ${new Date(r.created_at * 1000).toLocaleString('es-AR')}  ${r.label}  ${C.dim(r.query || '')}  ${r.status}`);
    }
  }));

program.command('show')
  .description('Muestra una corrida guardada')
  .argument('<id>')
  .option('-d, --details', 'mostrar los datos encontrados por cada módulo')
  .action(async (id, opts) => withEngine(async (engine) => {
    const run = await engine.store.getRun(id);
    if (!run) { console.error('No existe'); process.exitCode = 1; return; }
    console.log(renderTree(run, { details: opts.details }).join('\n'));
  }));

program.command('import-sociedades')
  .description('Descarga e importa el Registro Nacional de Sociedades (datos abiertos) a la base local')
  .argument('[fuentes...]', 'muestra | 2019..2026 | asociaciones | URL | archivo .csv/.zip', ['2026'])
  .action(async (fuentes) => {
    const { importar, DATASETS } = await import('./lib/sociedades.js');
    const bad = fuentes.filter((f) => !DATASETS[f] && !/^https?:/.test(f) && !fs.existsSync(f));
    if (bad.length) {
      console.error(`Fuente desconocida: ${bad.join(', ')}. Opciones: ${Object.keys(DATASETS).join(', ')}, una URL o un archivo.`);
      process.exitCode = 1;
      return;
    }
    await importar(fuentes, (m) => console.log(C.dim(m)));
  });

program.command('sociedades-historico')
  .description('Registro Nacional de Sociedades (todos los años, con bajas) + IGJ (autoridades y su evolución)')
  .option('--desde <año>', 'Registro de Sociedades: empezar desde este año', (v) => Number(v), 0)
  .option('--sin-asociaciones', 'no importar asociaciones sin fines de lucro')
  .option('--sin-igj', 'no importar IGJ (autoridades/socios)')
  .option('--solo-igj', 'importar sólo IGJ')
  .option('--forzar', 'rehacer todo aunque ya esté procesado (IGJ: borra la historia y la reconstruye)')
  .action((opts) => importarTodo({ ...opts, solo: opts.forzar ? 'todos' : 'nuevos' }));

program.command('sociedades-actualizar')
  .description('Importa sólo lo nuevo (años / cortes IGJ no procesados o republicados)')
  .option('--sin-asociaciones', 'no importar asociaciones sin fines de lucro')
  .option('--sin-igj', 'no importar IGJ (autoridades/socios)')
  .action((opts) => importarTodo({ ...opts, solo: 'nuevos' }));

async function importarTodo(opts) {
  const log = (m) => console.log(C.dim(m));
  let algo = false;
  if (!opts.soloIgj) {
    const { sincronizar } = await import('./lib/sociedades.js');
    const series = opts.sinAsociaciones ? ['sociedades'] : undefined;
    algo = (await sincronizar({ solo: opts.solo, desde: opts.desde || 0, series }, log)).length > 0 || algo;
  }
  if (!opts.sinIgj) {
    const { sincronizarIgj } = await import('./lib/igj.js');
    algo = (await sincronizarIgj({ forzar: !!opts.forzar }, log)).length > 0 || algo;
  }
  if (algo) await printEstadoSociedades();
}

program.command('sociedades-estado')
  .description('Años importados del Registro Nacional de Sociedades, vigentes y bajas por año')
  .action(() => printEstadoSociedades());

async function printEstadoSociedades() {
  const { estado } = await import('./lib/sociedades.js');
  const e = await estado();
  if (!e) { console.log('Base de sociedades no importada. Corré: condor sociedades-historico'); return; }
  const n = (x) => Number(x).toLocaleString('es-AR');
  console.log(`\n${C.bold('Registro Nacional de Sociedades')}  ${C.dim(`${n(e.sociedades)} CUIT en la base`)}`);
  for (const serie of [...new Set(e.procesados.map((p) => p.serie))]) {
    const ps = e.procesados.filter((p) => p.serie === serie);
    const vig = e.vigentes.find((v) => v.serie === serie)?.c ?? 0;
    console.log(`\n${C.bold(serie)} · último año procesado: ${C.green(ps.at(-1).anio)} · vigentes: ${n(vig)}`);
    for (const p of ps) {
      const bajas = e.bajas.find((b) => b.serie === serie && b.anio === p.anio)?.c;
      console.log(`  ${p.anio}  ${n(p.cuits).padStart(11)} CUIT${bajas ? C.yellow(`  ${n(bajas)} bajas`) : ''}  ${C.dim(`publicado ${p.publicado?.slice(0, 10) || '?'} · importado ${p.importado.slice(0, 10)}`)}`);
    }
  }
  const { estadoIgj, fmtCorte } = await import('./lib/igj.js');
  const g = await estadoIgj();
  if (!g) { console.log(`\n${C.bold('IGJ')} · sin importar`); return; }
  console.log(`\n${C.bold('IGJ')} · último corte procesado: ${C.green(fmtCorte(g.ultimo))} · ${n(g.entidades)} entidades (${n(g.conCuit)} con CUIT)`);
  for (const c of g.cortes) {
    console.log(`  ${fmtCorte(c.corte)}  ${n(c.entidades).padStart(10)} entidades ${n(c.autoridades).padStart(10)} autoridades` +
      (c.entidades_con_cambios ? C.yellow(`  ${n(c.entidades_con_cambios)} cambiaron (+${n(c.altas)} −${n(c.bajas)})`) : '') +
      `  ${C.dim(`importado ${c.importado.slice(0, 10)}`)}`);
  }
  for (const o of g.omitidos) console.log(C.yellow(`  ! ${o.nombre}: cortes salteados ${o.omitidos} (ver log; --forzar para reconstruir)`));
}

program.command('arca-csr')
  .description('Genera clave privada y pedido de certificado (CSR) para los web services de ARCA')
  .argument('<cuit>', 'tu CUIT (la que va a usar el certificado)')
  .argument('[nombre]', 'nombre o razón social para el certificado', 'condor')
  .option('--force', 'reemplazar una clave existente')
  .action(async (cuit, nombre, opts) => {
    const { generarCsr } = await import('./lib/arca.js');
    const { keyPath, csrPath } = generarCsr({ cuit, nombre, force: opts.force });
    console.log(`${C.green('✔')} clave: ${keyPath}  (no la compartas)\n${C.green('✔')} pedido: ${csrPath}\n`);
    console.log(C.bold('Siguientes pasos en ARCA (con clave fiscal):'));
    console.log(`  1. Servicio "Administración de Certificados Digitales" → agregar alias "condor" → subir ${csrPath}`);
    console.log('  2. Descargar el certificado y guardarlo como secrets/arca.crt');
    console.log('  3. Servicio "Administrador de Relaciones de Clave Fiscal" → Nueva relación → buscar');
    console.log('     "ws_sr_padron_a13" (y "ws_sr_constancia_inscripcion") → representante: el alias "condor"');
    console.log(`  4. En la web → Módulos → arca_padron → settings: { "cuit_representada": "${String(cuit).replace(/\D/g, '')}" } y habilitar`);
  });

program.command('runs-clear')
  .description('Borra todo el historial de corridas guardado')
  .action(async () => withEngine(async (engine) => {
    console.log(`${await engine.store.clearRuns()} corridas borradas (store: ${engine.store.name})`);
  }));

program.command('cache-clear')
  .description('Borra la caché de resultados de los módulos (no toca el historial)')
  .argument('[modulo]', 'id de un módulo; sin argumento borra toda la caché')
  .action(async (moduleId) => withEngine(async (engine) => {
    const n = await engine.store.cacheClear(moduleId || null);
    console.log(`${n} resultados borrados de la caché${moduleId ? ` de ${moduleId}` : ''} (store: ${engine.store.name})`);
  }));

program.command('web')
  .description('Levanta la web local')
  .option('--host <host>', 'host', process.env.HOST || '127.0.0.1')
  .option('--port <port>', 'puerto', process.env.PORT || '8000')
  .action(async (opts) => {
    const { startWeb } = await import('./web/server.js');
    await startWeb({ host: opts.host, port: Number(opts.port) });
  });

program.parseAsync().catch((e) => { console.error(C.red(e.message)); process.exit(1); });
