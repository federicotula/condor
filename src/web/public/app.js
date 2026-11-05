// UI de Cóndor: búsqueda, selección de persona, árbol de ejecución en vivo y editor del árbol de módulos.
import { $, h } from './dom.js';
import { autoView, jsonTree, renderView } from './views.js';

const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

const STATUS = {
  waiting: 'esperando', pending: 'en cola', running: 'ejecutando', done: 'ok',
  error: 'error', skipped: 'no se ejecuta', duplicate: 'duplicado', input: 'tu respuesta',
};

// ------------------------------------------------------------------ tabs + salud
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${b.dataset.tab}`));
  if (b.dataset.tab === 'modulos') loadConfig();
}));

async function loadHealth() {
  try {
    const { store, llm } = await api('/api/health');
    const llmCls = !llm.ok ? 'bad' : llm.model_ready ? 'ok' : 'warn';
    $('#health').replaceChildren(
      h('span', { title: store.note || store.error || '' }, h('i', { class: `dot ${store.ok && store.backend === 'redis' ? 'ok' : 'warn'}` }), store.backend),
      h('span', { title: llm.error || (llm.model_ready ? '' : `modelo ${llm.model} no descargado`) },
        h('i', { class: `dot ${llmCls}` }), `LLM ${llm.model}`),
    );
  } catch { /* noop */ }
}
loadHealth();
setInterval(loadHealth, 30000);

// ------------------------------------------------------------------ búsqueda
let lastQuery = '';

$('#search-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const query = $('#query').value.trim();
  if (!query) return;
  lastQuery = query;
  setMsg('Buscando…');
  $('#search-btn').disabled = true;
  try {
    const res = await api('/api/search', { method: 'POST', body: JSON.stringify({ query }) });
    const errs = res.errors.map((e) => `${e.searcher}: ${e.error}`).join(' · ');
    const kind = Object.keys(res.detected)[0] || '?';
    if (!res.candidates.length) return setMsg(`Sin resultados (buscado como ${kind}). ${errs}`, true);
    setMsg(errs ? `Avisos: ${errs}` : '');
    if (res.candidates.length === 1) return startRun(res.candidates[0]);
    showCandidates(res.candidates, kind);
  } catch (e) {
    setMsg(e.message, true);
  } finally {
    $('#search-btn').disabled = false;
  }
});

function setMsg(text, err = false) {
  const m = $('#search-msg');
  m.textContent = text;
  m.classList.toggle('err', err);
}

function showCandidates(cands, kind) {
  $('#modal-sub').textContent = `${cands.length} coincidencias (buscado como ${kind})`;
  $('#candidates').replaceChildren(...cands.map((c) => h('button', {
    class: 'cand',
    onclick: () => { $('#modal').classList.add('hidden'); startRun(c); },
  }, h('b', {}, c.label), h('small', {}, [c.detail, `fuente: ${c.sources.join(', ')}`].filter(Boolean).join(' · ')))));
  $('#modal').classList.remove('hidden');
}
$('#modal-cancel').addEventListener('click', () => $('#modal').classList.add('hidden'));

// ------------------------------------------------------------------ corrida en vivo
let current = null;   // run
let es = null;        // EventSource
let selected = null;  // id del nodo abierto en el panel de detalle

async function startRun(person) {
  const { id } = await api('/api/runs', { method: 'POST', body: JSON.stringify({ person, query: lastQuery }) });
  watchRun(id);
}

// La URL guarda la corrida y el nodo abiertos: #run=<id>&node=<id>
function setHash() {
  const p = new URLSearchParams();
  if (current?.id) p.set('run', current.id);
  if (selected) p.set('node', selected);
  history.replaceState(null, '', p.toString() ? `#${p}` : location.pathname);
}

function watchRun(id, openNode = null) {
  es?.close();
  closeDrawer();
  current = null;
  es = new EventSource(`/api/runs/${id}/events`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'snapshot') {
      current = ev.run;
      setHash();
      const waitingInput = Object.values(current.nodes).find((x) => x.status === 'input');
      if (waitingInput) openDrawer(waitingInput.id);
      else if (openNode && current.nodes[openNode]) openDrawer(openNode);
    } else if (ev.type === 'node' && current) {
      const prev = current.nodes[ev.node.id];
      current.nodes[ev.node.id] = ev.node;
      const nowAsking = ev.node.status === 'input' && (prev?.status !== 'input' || prev?.ask?.id !== ev.node.ask?.id);
      const selectedIsAsking = current.nodes[selected]?.status === 'input' && selected !== ev.node.id;
      // Un módulo pide una respuesta: abrir su panel (salvo que ya estés respondiendo otro).
      if (nowAsking && !selectedIsAsking) openDrawer(ev.node.id);
      else if (ev.node.id === selected && prev?.status !== ev.node.status) openDrawer(ev.node.id);
    }
    else if (ev.type === 'run' && current) { Object.assign(current, ev); es.close(); loadHistory(); }
    else if (ev.type === 'error') { setMsg(ev.error, true); es.close(); }
    scheduleRender();
  };
  es.onerror = () => {
    if (current && current.status !== 'running') es.close();
  };
}

let raf = 0;
function scheduleRender() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderRun(); });
}

const dur = (n) => (n.started_at && n.finished_at ? `${(n.finished_at - n.started_at).toFixed(1)}s`
  : n.started_at ? `${(Date.now() / 1000 - n.started_at).toFixed(0)}s…` : '');

function renderRun() {
  if (!current) return;
  $('#run').classList.remove('hidden');
  const nodes = current.nodes;
  const root = nodes[current.root_id];
  $('#run-title').textContent = current.person.label;
  $('#run-sub').textContent = `${current.person.detail || ''} · ${current.status === 'running' ? 'ejecutando…' : `finalizado (${current.status})`}`;

  const counts = {};
  for (const n of Object.values(nodes)) if (n.id !== current.root_id) counts[n.status] = (counts[n.status] || 0) + 1;
  $('#run-counts').replaceChildren(...Object.entries(counts).map(([s, c]) => h('span', { class: `pill s-${s}` }, `${STATUS[s]} ${c}`)));

  const renderNode = (n) => {
    const kids = n.children.map((c) => nodes[c]).filter(Boolean);
    const inputs = Object.entries(n.inputs || {}).map(([k, v]) => h('span', { class: 'chip', title: k }, `${k}: ${v}`));
    const info = n.status === 'done' ? n.summary : n.status === 'error' ? n.error : n.reason || '';
    const li = h('li', { class: `st-${n.status}`, id: `n-${n.id}` },
      h('div', { class: `row ${selected === n.id ? 'selected' : ''}`, onclick: () => openDrawer(n.id) },
        h('span', { class: `pill s-${n.status}` }, STATUS[n.status]),
        h('span', { class: 'name' }, n.module_name),
        ...inputs,
        h('span', { class: 'info', title: info }, info),
        n.cached ? h('span', { class: 'chip' }, 'caché') : null,
        h('span', { class: 'time' }, dur(n))),
      kids.length ? h('ul', {}, kids.map(renderNode)) : null);
    return li;
  };

  const rootLi = h('li', {}, h('div', { class: `row ${selected === root.id ? 'selected' : ''}`, onclick: () => openDrawer(root.id) },
    h('span', { class: 'pill s-done' }, 'persona'),
    h('span', { class: 'name' }, root.module_name),
    ...Object.entries(root.facts).map(([k, v]) => h('span', { class: 'chip' }, `${k}: ${v.join(', ')}`))),
  h('ul', {}, root.children.map((c) => nodes[c]).filter(Boolean).map(renderNode)));
  $('#tree').replaceChildren(h('ul', {}, rootLi));

  // Datos recolectados: unión de facts de todos los nodos OK.
  const all = {};
  for (const n of Object.values(nodes)) {
    if (n.status !== 'done') continue;
    for (const [k, vals] of Object.entries(n.facts || {})) {
      all[k] ||= new Map();
      for (const v of vals) {
        const key = String(v).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
        if (!all[k].has(key)) all[k].set(key, v);
      }
    }
  }
  const entries = Object.entries(all);
  $('#facts').replaceChildren(...(entries.length ? entries.map(([k, m]) => h('div', { class: 'fact' }, h('b', {}, k),
    ...[...m.values()].map((v) => h('span', {}, typeof v === 'object' ? JSON.stringify(v) : v))))
    : [h('div', { class: 'muted' }, 'todavía nada')]));
}

// ------------------------------------------------------------------ panel de detalle del nodo
function closeDrawer() {
  selected = null;
  if (current) setHash();
  $('#drawer').classList.add('hidden');
  scheduleRender();
}
$('#drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); $('#modal').classList.add('hidden'); } });

// Se redibuja sólo al abrirlo o cuando cambia el estado de ese nodo (no con cada evento del árbol),
// así no se pierden el orden de tablas, secciones abiertas o el mapa.
function openDrawer(id) {
  const n = current?.nodes[id];
  if (!n) return;
  selected = id;
  setHash();
  scheduleRender();
  const inputs = Object.entries(n.inputs || {}).map(([k, v]) => h('span', { class: 'chip' }, `${k}: ${v}`));
  const facts = Object.entries(n.facts || {});
  const view = n.view?.length ? n.view : autoView(n.data);

  fill($('#drawer-head'),
    h('div', { class: 'drawer-title' },
      h('span', { class: `pill s-${n.status}` }, n.module_id === '__persona__' ? 'persona' : STATUS[n.status]),
      h('h3', {}, n.module_name)),
    h('div', { class: 'drawer-meta' }, ...inputs,
      dur(n) ? h('span', { class: 'muted small' }, dur(n)) : null,
      n.cached ? h('span', { class: 'chip' }, 'desde caché') : null),
    n.summary ? h('div', { class: 'muted' }, n.summary) : null);

  fill($('#drawer-body'),
    n.error ? h('div', { class: 'vb vb-alert t-bad' }, n.error) : null,
    n.status === 'skipped' || n.status === 'waiting' || n.status === 'pending' ? h('div', { class: 'vb vb-alert t-info' }, n.reason || STATUS[n.status]) : null,
    n.duplicate_of ? h('div', { class: 'vb vb-alert t-info' }, 'Ya se ejecutó con los mismos datos en otra rama. ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); openDrawer(n.duplicate_of); flash(n.duplicate_of); } }, 'Ver resultado original →')) : null,
    n.status === 'running' ? h('div', { class: 'muted' }, 'Ejecutando…') : null,
    n.status === 'input' && n.ask ? askForm(n) : null,
    view.length ? renderView(view) : null,
    facts.length ? h('div', { class: 'vb' }, h('div', { class: 'vb-title' }, 'Datos que aporta (pueden disparar otros módulos)'),
      h('dl', { class: 'kv' }, facts.flatMap(([k, vals]) => [h('dt', {}, k), h('dd', {}, vals.map((v) => h('span', { class: 'badge t-info' }, typeof v === 'object' ? JSON.stringify(v) : v)))]))) : null,
    n.logs?.length ? h('details', { class: 'vb vb-section' }, h('summary', {}, `Log (${n.logs.length})`), h('pre', { class: 'json' }, n.logs.join('\n'))) : null,
    n.data !== null && n.data !== undefined ? h('details', { class: 'vb vb-section' }, h('summary', {}, 'Respuesta cruda (JSON)'), jsonTree(n.data)) : null,
    h('div', { class: 'muted small' }, `módulo: ${n.module_id}${n.input_key ? ` · clave: ${n.input_key}` : ''}`));
  $('#drawer').classList.remove('hidden');
}

// Formulario para responder a un módulo que pidió datos (ctx.ask), p.ej. un captcha.
function askForm(n) {
  const a = n.ask;
  const msg = h('div', { class: 'muted small' });
  const send = async (values) => {
    form.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
    msg.textContent = 'enviando…';
    try {
      await api(`/api/runs/${current.id}/answer`, { method: 'POST', body: JSON.stringify({ node_id: n.id, ask_id: a.id, values }) });
    } catch (e) {
      msg.textContent = e.message;
      form.querySelectorAll('button, input').forEach((el) => { el.disabled = false; });
    }
  };
  const inputs = a.fields.map((f) => h('input', {
    name: f.name, placeholder: f.placeholder || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', required: true,
  }));
  const left = () => Math.max(0, Math.round(a.expires_at - Date.now() / 1000));
  const fmtLeft = (s) => `vence en ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const countdown = h('div', { class: 'muted small' }, fmtLeft(left()));
  const tick = setInterval(() => {
    if (!countdown.isConnected) return clearInterval(tick);
    countdown.textContent = left() ? fmtLeft(left()) : 'venció: el módulo va a fallar por falta de respuesta';
  }, 1000);
  const form = h('form', {
    class: 'ask',
    onsubmit: (e) => { e.preventDefault(); send(Object.fromEntries(inputs.map((i) => [i.name, i.value.trim()]))); },
  },
  h('div', { class: 'ask-title' }, a.title),
  a.text ? h('p', {}, a.text) : null,
  a.image ? h('img', { class: 'ask-img', src: a.image, alt: 'imagen a resolver' }) : null,
  ...a.fields.map((f, i) => h('label', { class: 'ask-field' }, f.label || f.name, inputs[i], f.help ? h('span', { class: 'muted small' }, f.help) : null)),
  h('div', { class: 'ask-actions' },
    h('button', { type: 'submit' }, 'Enviar'),
    a.actions.includes('refresh') ? h('button', { type: 'button', class: 'ghost', onclick: () => send({ __action: 'refresh' }) }, 'Otra imagen') : null,
    h('button', { type: 'button', class: 'ghost', onclick: () => send(null) }, 'Saltear')),
  countdown,
  msg);
  setTimeout(() => inputs[0]?.focus(), 50);
  return form;
}

function flash(id) {
  const row = document.querySelector(`#n-${id} > .row`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1600);
}

setInterval(() => { if (current?.status === 'running') scheduleRender(); }, 1000); // refresca duraciones

async function loadHistory() {
  try {
    const runs = await api('/api/runs');
    $('#history').replaceChildren(...runs.map((r) => h('div', { class: 'hist-item', onclick: () => watchRun(r.id) },
      h('span', { class: 'muted' }, new Date(r.created_at * 1000).toLocaleString('es-AR')),
      h('span', {}, r.label), h('span', { class: 'muted' }, `(${r.query || ''})`), h('span', { class: 'muted' }, r.status))));
  } catch { /* noop */ }
}
loadHistory();

{
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('run')) watchRun(p.get('run'), p.get('node'));
}

// ------------------------------------------------------------------ editor del árbol de módulos
let cfg = null;
let catalog = null;
let dirty = false;
let saveTimer = null;

// Cada cambio se guarda solo (con una pequeña espera para agrupar cambios seguidos).
// rerender=false para los textarea, así no se pierde el foco mientras escribís.
function scheduleSave(rerender = true) {
  dirty = true;
  $('#cfg-dirty').textContent = 'guardando…';
  if (rerender) renderConfig();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveConfig(rerender), 500);
}
const markDirty = () => scheduleSave(true);

async function saveConfig(rerender = true) {
  try {
    const res = await api('/api/config', { method: 'PUT', body: JSON.stringify(cfg) });
    catalog = await api('/api/catalog'); // re-evalúa qué le falta a cada módulo con la config nueva
    if (rerender) cfg = res.config;
    dirty = false;
    $('#cfg-dirty').textContent = `guardado ✓ ${new Date().toLocaleTimeString('es-AR')}`;
    renderWarnings(res.warnings);
    if (rerender) renderConfig(); else renderProblems();
  } catch (e) {
    $('#cfg-dirty').textContent = `error al guardar: ${e.message}`;
  }
}

async function loadConfig(force = false) {
  if (dirty && !force) return;
  const [c, cat] = await Promise.all([api('/api/config'), api('/api/catalog')]);
  cfg = c.config;
  catalog = cat;
  dirty = false;
  $('#cfg-dirty').textContent = '';
  $('#cfg-path').textContent = c.path;
  renderWarnings(c.warnings);
  renderConfig();
}

function renderWarnings(warnings) {
  const errs = (catalog?.errors || []).map((e) => `Error cargando ${e.file}: ${e.error}`);
  $('#cfg-warnings').replaceChildren(...[...errs, ...warnings].map((w) => h('div', { class: 'warn-box' }, w)));
}

$('#cfg-reload').addEventListener('click', () => loadConfig(true));
$('#history-clear').addEventListener('click', async () => {
  if (!confirm('¿Borrar todo el historial de búsquedas? No se puede deshacer.')) return;
  try {
    const { deleted } = await api('/api/runs', { method: 'DELETE' });
    $('#cfg-dirty').textContent = `historial borrado (${deleted} corridas)`;
    loadHistory();
  } catch (e) {
    $('#cfg-dirty').textContent = `error: ${e.message}`;
  }
});
$('#cache-clear').addEventListener('click', async () => {
  try {
    const { deleted } = await api('/api/cache', { method: 'DELETE' });
    $('#cfg-dirty').textContent = `caché borrada (${deleted} resultados)`;
  } catch (e) {
    $('#cfg-dirty').textContent = `error: ${e.message}`;
  }
});
const meta = (id) => catalog.modules.find((m) => m.id === id) || { id, name: `${id} (sin código)`, requires: [], provides: [] };

// Lo que le falta configurar a un módulo habilitado (lo informa el propio módulo con check()).
const problemsOf = (id) => (cfg.modules[id]?.enabled ? meta(id).problems || [] : []);
const problemChip = (id) => {
  const p = problemsOf(id);
  return p.length ? h('span', { class: 'badge t-bad', title: p.join('\n') }, `⚠ ${p[0]}${p.length > 1 ? ` (+${p.length - 1})` : ''}`) : null;
};
function renderProblems() {
  document.querySelectorAll('[data-problems]').forEach((el) => el.replaceChildren(...[problemChip(el.dataset.problems)].filter(Boolean)));
}
const entry = (id) => (cfg.modules[id] ||= { enabled: false, triggers: [], settings: {} });

function addChildSelect(parentProvides, existing, onAdd) {
  const opts = catalog.modules
    .filter((m) => !existing.includes(m.id))
    .map((m) => ({ m, fit: !parentProvides || m.requires.some((r) => parentProvides.includes(r)) }))
    .sort((a, b) => b.fit - a.fit || a.m.name.localeCompare(b.m.name));
  return h('span', { class: 'add-child' }, h('select', {
    onchange: (e) => { if (e.target.value) onAdd(e.target.value); },
  }, h('option', { value: '' }, '+ agregar módulo hijo…'),
  ...opts.map(({ m, fit }) => h('option', { value: m.id }, `${fit ? '★ ' : ''}${m.name}  [${m.requires.join(', ') || '—'}]`))));
}

function renderConfig() {
  if (!cfg || !catalog) return;

  const renderBranch = (id, path, removeFn) => {
    const m = meta(id);
    const e = entry(id);
    const cycle = path.includes(id);
    const row = h('div', { class: `cfg-row ${e.enabled ? '' : 'off'}` },
      h('input', { type: 'checkbox', checked: e.enabled, title: 'habilitado', onchange: (ev) => { e.enabled = ev.target.checked; markDirty(); } }),
      h('span', { class: 'label' }, h('b', {}, m.name), ' ', h('span', { class: 'muted' }, `(${id})`)),
      h('span', { class: 'io' }, `${m.requires.join(', ') || '—'} → ${m.provides.join(', ') || '—'}`),
      cycle ? h('span', { class: 'chip' }, '↻ ciclo (se corta por deduplicación)') : null,
      h('span', { 'data-problems': id }, problemChip(id)),
      h('button', { class: 'ghost small x', title: 'quitar de esta rama', onclick: removeFn }, '✕'));
    if (cycle) return h('li', {}, row);
    const kids = e.triggers.map((t) => renderBranch(t, [...path, id], () => { e.triggers = e.triggers.filter((x) => x !== t); markDirty(); }));
    return h('li', {}, row, h('ul', {}, ...kids,
      h('li', {}, addChildSelect(m.provides, e.triggers, (t) => { e.triggers.push(t); entry(t); markDirty(); }))));
  };

  $('#cfg-tree').replaceChildren(h('ul', {},
    h('li', {}, h('div', { class: 'cfg-row' }, h('b', {}, 'Persona seleccionada'), h('span', { class: 'io' }, 'cuit, dni, nombre, …')),
      h('ul', {}, ...cfg.roots.map((r) => renderBranch(r, [], () => { cfg.roots = cfg.roots.filter((x) => x !== r); markDirty(); })),
        h('li', {}, addChildSelect(null, cfg.roots, (id) => { cfg.roots.push(id); entry(id); markDirty(); }))))));

  $('#cfg-modules').replaceChildren(...catalog.modules.map((m) => {
    const e = entry(m.id);
    const ta = h('textarea', {
      spellcheck: 'false',
      oninput: (ev) => {
        try { e.settings = JSON.parse(ev.target.value || '{}'); ev.target.classList.remove('bad'); scheduleSave(false); }
        catch { ev.target.classList.add('bad'); $('#cfg-dirty').textContent = 'JSON inválido: no se guarda hasta corregirlo'; }
      },
    });
    ta.value = JSON.stringify(e.settings, null, 2);
    return h('div', { class: 'card' },
      h('header', {}, h('input', { type: 'checkbox', checked: e.enabled, onchange: (ev) => { e.enabled = ev.target.checked; markDirty(); } }),
        h('b', {}, m.name), h('span', { class: 'muted' }, m.id)),
      h('div', { 'data-problems': m.id }, problemChip(m.id)),
      m.description ? h('p', {}, m.description) : null,
      h('p', {}, `requiere: ${m.requires.join(', ') || '—'} · aporta: ${m.provides.join(', ') || '—'}${m.cache_ttl ? ` · caché ${m.cache_ttl}s` : ''}`),
      h('p', {}, `defaults: ${JSON.stringify(m.default_settings)}`),
      h('label', { class: 'muted' }, 'settings (JSON, pisan los defaults)'), ta);
  }));

  $('#cfg-searchers').replaceChildren(...catalog.searchers.map((s) => {
    const e = (cfg.searchers[s.id] ||= { enabled: false, settings: {} });
    return h('div', { class: 'card' },
      h('header', {}, h('input', { type: 'checkbox', checked: e.enabled, onchange: (ev) => { e.enabled = ev.target.checked; markDirty(); } }),
        h('b', {}, s.name), h('span', { class: 'muted' }, s.id)),
      s.description ? h('p', {}, s.description) : null,
      h('p', {}, `busca por: ${s.accepts.join(', ')}${s.fallback ? ' · sólo si nadie más encontró' : ''}`));
  }));

  $('#cfg-settings').replaceChildren(...Object.entries(cfg.settings).map(([k, v]) => h('label', {}, k,
    h('input', { type: 'number', value: v, min: 1, onchange: (ev) => { cfg.settings[k] = Number(ev.target.value); markDirty(); } }))));
}
