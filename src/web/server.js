import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { buildEngine } from '../core/bootstrap.js';
import { ConfigError, configWarnings } from '../core/config.js';
import { SearchInputError } from '../core/engine.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export async function createApp(engine) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(PUBLIC));
  // Archivos descargados por módulos (p.ej. constancias en PDF), sólo accesibles localmente.
  app.use('/files', express.static(path.resolve(process.env.CONDOR_DATA ?? 'data', 'files')));

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    const code = e instanceof ConfigError || e instanceof SearchInputError ? 400 : 500;
    if (code === 500) console.error(e);
    res.status(code).json({ error: e.message });
  });

  app.get('/api/health', wrap(async (_req, res) => {
    res.json({ store: await engine.store.status(), llm: await engine.llm.status() });
  }));

  app.post('/api/search', wrap(async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'Ingresá un identificador' });
    const { kind = 'auto', searcher = null } = req.body || {};
    res.json(await engine.search(query, { kind: String(kind), searcher: searcher ? String(searcher) : null }));
  }));

  app.get('/api/searchers', wrap(async (_req, res) => res.json(engine.enabledSearchers())));

  app.post('/api/runs', wrap(async (req, res) => {
    const { person, query = '' } = req.body || {};
    if (!person?.facts) return res.status(400).json({ error: 'Falta la persona seleccionada' });
    const run = engine.start(person, query);
    res.json({ id: run.id });
  }));

  app.get('/api/runs', wrap(async (_req, res) => res.json(await engine.store.listRuns(30))));

  const getRun = async (id) => engine.active.get(id)?.run ?? (await engine.store.getRun(id));

  app.get('/api/runs/:id', wrap(async (req, res) => {
    const run = await getRun(req.params.id);
    return run ? res.json(run) : res.status(404).json({ error: 'No existe' });
  }));

  // Server-Sent Events: snapshot inicial + actualizaciones de nodos en vivo.
  app.get('/api/runs/:id/events', wrap(async (req, res) => {
    const id = req.params.id;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const unsubscribe = await engine.store.subscribe(id, (ev) => {
      send(ev);
      if (ev.type === 'run') res.end();
    }); // suscribirse antes del snapshot para no perder eventos
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); unsubscribe(); });
    const run = await getRun(id);
    if (!run) { send({ type: 'error', error: 'No existe' }); return res.end(); }
    send({ type: 'snapshot', run });
    if (run.status !== 'running') res.end();
  }));

  // Borra el historial de corridas (las que están en curso se conservan).
  app.delete('/api/runs', wrap(async (_req, res) => {
    res.json({ deleted: await engine.store.clearRuns([...engine.active.keys()]) });
  }));

  // Respuesta del usuario a un módulo que preguntó algo (ctx.ask), p.ej. un captcha.
  app.post('/api/runs/:id/answer', wrap(async (req, res) => {
    const { node_id, ask_id, values = null } = req.body || {};
    const ok = engine.answer(req.params.id, node_id, ask_id, values);
    return ok ? res.json({ ok }) : res.status(409).json({ error: 'La pregunta ya no está activa (venció o se respondió)' });
  }));

  app.delete('/api/cache', wrap(async (req, res) => {
    res.json({ deleted: await engine.store.cacheClear(req.query.module || null) });
  }));

  // Explorador del Registro Nacional de Sociedades (pestaña Sociedades).
  const soc = () => import('../lib/sociedades.js');
  const sinBase = async (res) => {
    const { DB_PATH } = await soc();
    if (fs.existsSync(DB_PATH)) return false;
    res.status(404).json({ error: 'La base de sociedades no está importada.', comando: 'make sociedades-historico' });
    return true;
  };
  app.get('/api/sociedades/opciones', wrap(async (_req, res) => {
    if (await sinBase(res)) return;
    res.json(await (await soc()).opciones());
  }));
  app.get('/api/sociedades', wrap(async (req, res) => {
    if (await sinBase(res)) return;
    const { page, per, ...filtros } = req.query;
    res.json(await (await soc()).explorar(filtros, { page, per }));
  }));
  app.get('/api/sociedades/:cuit', wrap(async (req, res) => {
    if (await sinBase(res)) return;
    const { porCuit, vistaSociedad } = await soc();
    const s = await porCuit(String(req.params.cuit).replace(/\D/g, ''));
    if (!s) return res.status(404).json({ error: 'No figura en la base' });
    res.json({ sociedad: s, view: vistaSociedad(s) });
  }));

  app.get('/api/catalog', wrap(async (_req, res) => res.json(await engine.catalog())));

  app.get('/api/config', wrap(async (_req, res) => {
    const cfg = engine.config.load();
    res.json({ config: cfg, warnings: configWarnings(cfg, engine.modules.keys()), path: engine.config.file });
  }));

  app.put('/api/config', wrap(async (req, res) => {
    const cfg = engine.config.save(req.body);
    res.json({ config: cfg, warnings: configWarnings(cfg, engine.modules.keys()) });
  }));

  return app;
}

export async function startWeb({ host = '127.0.0.1', port = 8000 } = {}) {
  const engine = await buildEngine();
  const app = await createApp(engine);
  const server = app.listen(port, host, () => {
    console.log(`[condor] web en http://${host === '0.0.0.0' ? 'localhost' : host}:${port}  (store: ${engine.store.name})`);
  });
  const shutdown = () => { server.close(); engine.close().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}
