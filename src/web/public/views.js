// Renderiza los bloques `view` que devuelven los módulos (ver src/core/view.js).
// Si un módulo no define `view`, autoView() arma una a partir de `data`.
import { h, s } from './dom.js';

const nf = new Intl.NumberFormat('es-AR');
const mf = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isScalar = (x) => x === null || ['string', 'number', 'boolean'].includes(typeof x);
const humanize = (k) => String(k).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());
const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];

// ---------------------------------------------------------------- valores
function fmt(value, format) {
  if (value === null || value === undefined || value === '') return '—';
  switch (format) {
    case 'number': return typeof value === 'number' ? nf.format(value) : String(value);
    case 'money': return typeof value === 'number' ? mf.format(value) : String(value);
    case 'percent': return typeof value === 'number' ? `${nf.format(Math.round(value * 1000) / 10)}%` : String(value);
    case 'date': {
      // "2015-03-01" se interpreta en hora local (si no, new Date lo toma como UTC y corre un día)
      const m = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('es-AR');
    }
    case 'json': return JSON.stringify(value);
    default:
      if (typeof value === 'boolean') return value ? 'sí' : 'no';
      if (typeof value === 'number') return nf.format(value);
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
  }
}

// Una celda/valor puede ser simple o { value, tone, href, hint }.
function cell(raw, format) {
  const c = isObj(raw) && 'value' in raw ? raw : { value: raw };
  const text = fmt(c.value, format);
  const href = c.href || (format === 'link' && typeof c.value === 'string' ? c.value : null);
  let node = href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : document.createTextNode(text);
  if (c.tone || format === 'badge') node = h('span', { class: `badge t-${c.tone || 'muted'}` }, node);
  if (c.hint) node = h('span', { title: c.hint }, node);
  return node;
}

const sortValue = (raw) => {
  const v = isObj(raw) && 'value' in raw ? raw.value : raw;
  return typeof v === 'number' ? v : v === null || v === undefined ? '' : String(v).toLowerCase();
};

// ---------------------------------------------------------------- bloques
const wrap = (b, ...content) => h('div', { class: `vb vb-${b.type}` }, b.title ? h('div', { class: 'vb-title' }, b.title) : null, ...content);

const R = {
  text: (b) => wrap(b, h('p', { class: 'vb-text' }, b.text)),

  alert: (b) => h('div', { class: `vb vb-alert t-${b.level || 'info'}` }, b.title ? h('b', {}, b.title, ' ') : null, b.text),

  stats: (b) => wrap(b, h('div', { class: 'stats' }, (b.items || []).map((it) => h('div', { class: `stat t-${it.tone || 'none'}` },
    h('div', { class: 'stat-value' }, fmt(it.value, it.format)),
    h('div', { class: 'stat-label' }, it.label),
    it.hint ? h('div', { class: 'stat-hint' }, it.hint) : null)))),

  kv: (b) => wrap(b, h('dl', { class: 'kv' }, (b.items || []).flatMap((it) => [
    h('dt', {}, humanize(it.label)),
    h('dd', {}, isScalar(it.value) || (isObj(it.value) && 'value' in it.value)
      ? cell(it.tone ? { value: it.value, tone: it.tone } : it.value, it.format)
      : jsonTree(it.value, false)),
  ]))),

  table: (b) => wrap(b, table(b.rows || [], b.columns, b.emptyText, b.footer)),

  list: (b) => wrap(b, h(b.ordered ? 'ol' : 'ul', { class: 'vlist' }, (b.items || []).map((it) => {
    const i = isObj(it) ? it : { text: it };
    const main = i.href ? h('a', { href: i.href, target: '_blank', rel: 'noopener noreferrer' }, i.text) : h('span', {}, i.text);
    return h('li', {}, main, i.tag ? h('span', { class: `badge t-${i.tone || 'muted'}` }, i.tag) : null,
      i.sub ? h('div', { class: 'muted small' }, i.sub) : null);
  }))),

  tags: (b) => wrap(b, h('div', { class: 'tags' }, (b.items || []).map((t) => {
    const i = isObj(t) ? t : { text: t };
    return h('span', { class: `badge t-${i.tone || 'muted'}` }, i.text);
  }))),

  links: (b) => wrap(b, h('ul', { class: 'vlist' }, (b.items || []).map((l) =>
    h('li', {}, h('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer' }, l.label || l.href))))),

  timeline: (b) => wrap(b, h('ul', { class: 'timeline' }, (b.items || []).map((it) => h('li', { class: `t-${it.tone || 'none'}` },
    h('span', { class: 'tl-date' }, fmt(it.date, /^\d{4}-\d{2}-\d{2}/.test(String(it.date)) ? 'date' : 'text')),
    h('span', { class: 'tl-title' }, it.title),
    it.text ? h('div', { class: 'muted small' }, it.text) : null)))),

  chart: (b) => wrap(b, chart(b)),

  map: (b) => {
    if (!Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return wrap(b, h('div', { class: 'muted' }, 'sin coordenadas'));
    const d = 0.004;
    const bbox = [b.lon - d, b.lat - d / 2, b.lon + d, b.lat + d / 2].join(',');
    return wrap(b,
      h('iframe', { class: 'map', loading: 'lazy', src: `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${b.lat},${b.lon}` }),
      h('a', { class: 'small', target: '_blank', rel: 'noopener noreferrer', href: `https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lon}#map=${b.zoom}/${b.lat}/${b.lon}` },
        b.label || `${b.lat}, ${b.lon}`, ' ↗'));
  },

  image: (b) => wrap(b, h('figure', {}, h('img', { src: b.src, loading: 'lazy', alt: b.caption || '' }), b.caption ? h('figcaption', { class: 'muted small' }, b.caption) : null)),

  json: (b) => wrap(b, jsonTree(b.data, b.open)),

  section: (b) => h('details', { class: 'vb vb-section', open: b.open !== false },
    h('summary', {}, b.title || 'Sección'), renderView(b.blocks || [])),
};

export function renderView(blocks) {
  return h('div', { class: 'view' }, (blocks || []).map((b) => {
    try {
      const r = R[b?.type];
      return r ? r(b) : h('div', { class: 'vb' }, h('div', { class: 'muted small' }, `bloque desconocido: ${b?.type}`), jsonTree(b, false));
    } catch (e) {
      return h('div', { class: 'vb vb-alert t-bad' }, `Error mostrando bloque ${b?.type}: ${e.message}`);
    }
  }));
}

// ---------------------------------------------------------------- tabla
function table(rows, columns, emptyText = 'sin filas', footer = null) {
  if (!rows.length) return h('div', { class: 'muted' }, emptyText);
  const cols = (columns && columns.length ? columns : inferColumns(rows))
    .map((c) => (typeof c === 'string' ? { key: c } : c));
  const PAGE = 25;
  let sortKey = null;
  let asc = true;
  let limit = PAGE;
  const box = h('div', { class: 'table-wrap' });

  const draw = () => {
    let data = rows;
    if (sortKey) {
      data = [...rows].sort((a, b) => {
        const x = sortValue(a[sortKey]);
        const y = sortValue(b[sortKey]);
        return (x > y ? 1 : x < y ? -1 : 0) * (asc ? 1 : -1);
      });
    }
    const numeric = (c) => c.align === 'right' || ['number', 'money', 'percent'].includes(c.format);
    box.replaceChildren(...[
      h('table', { class: 'vtable' },
        h('thead', {}, h('tr', {}, cols.map((c) => h('th', {
          class: numeric(c) ? 'num' : '',
          onclick: () => { asc = sortKey === c.key ? !asc : true; sortKey = c.key; draw(); },
        }, c.label || humanize(c.key), sortKey === c.key ? (asc ? ' ▲' : ' ▼') : '')))),
        h('tbody', {}, data.slice(0, limit).map((r) => h('tr', {}, cols.map((c) => h('td', { class: numeric(c) ? 'num' : '' },
          nested(r[c.key], c.format)))))),
        footer ? h('tfoot', {}, h('tr', {}, cols.map((c) => h('td', { class: numeric(c) ? 'num' : '' },
          footer[c.key] === undefined ? '' : cell(footer[c.key], c.format))))) : null),
      data.length > limit ? h('button', { class: 'ghost small', onclick: () => { limit = data.length; draw(); } },
        `ver las ${data.length} filas`) : null,
    ].filter(Boolean));
  };
  draw();
  return box;
}

// Celda con contenido anidado: lista de objetos -> sub-tabla, objeto -> ficha, resto -> JSON.
function nested(value, format) {
  if (isScalar(value) || (isObj(value) && 'value' in value)) return cell(value, format);
  if (Array.isArray(value) && value.length && value.every(isObj)) return h('div', { class: 'subtable' }, table(value));
  if (Array.isArray(value) && value.every(isScalar)) return document.createTextNode(value.map((x) => fmt(x)).join(', ') || '—');
  if (isObj(value) && Object.values(value).every(isScalar)) {
    return h('dl', { class: 'kv' }, Object.entries(value).flatMap(([k, x]) => [h('dt', {}, humanize(k)), h('dd', {}, fmt(x))]));
  }
  return jsonTree(value, false);
}

function inferColumns(rows) {
  const keys = [];
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r || {})) if (!keys.includes(k)) keys.push(k);
  return keys.map((key) => {
    const sample = rows.map((r) => r?.[key]).find((v) => v !== null && v !== undefined);
    return { key, format: typeof sample === 'number' ? 'number' : 'text' };
  });
}

// ---------------------------------------------------------------- gráficos (SVG, sin dependencias)
function chart(b) {
  const labels = b.labels || [];
  const series = (b.series || []).map((sr, i) => ({ ...sr, color: sr.color || PALETTE[i % PALETTE.length], data: (sr.data || []).map(Number) }));
  if (!series.length || !labels.length) return h('div', { class: 'muted' }, 'sin datos para graficar');
  if (b.kind === 'pie') return pie(labels, series[0], b.format);

  const W = 640;
  const H = b.height || 220;
  const P = { l: 64, r: 12, t: 12, b: 42 };
  const iw = W - P.l - P.r;
  const ih = H - P.t - P.b;
  const all = series.flatMap((x) => x.data).filter(Number.isFinite);
  // eje con marcas "redondas" (1, 2, 2.5, 5 × 10^n)
  const rawSpan = (Math.max(0, ...all) - Math.min(0, ...all)) || 1;
  const mag = 10 ** Math.floor(Math.log10(rawSpan / 4));
  const tick = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((t) => rawSpan / t <= 4) || 10 * mag;
  const max = Math.ceil(Math.max(0, ...all) / tick) * tick || tick;
  const min = Math.floor(Math.min(0, ...all) / tick) * tick;
  const span = max - min || 1;
  const y = (v) => P.t + ih - ((v - min) / span) * ih;
  const step = iw / labels.length;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });

  for (let v = min; v <= max + tick / 1000; v += tick) {
    svg.append(s('line', { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), class: 'grid' }),
      s('text', { x: P.l - 6, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, short(v, b.format)));
  }
  const every = Math.ceil(labels.length / 12);
  labels.forEach((l, i) => {
    if (i % every) return;
    svg.append(s('text', { x: P.l + step * (i + 0.5), y: H - P.b + 16, class: 'axis', 'text-anchor': 'middle' }, String(l).slice(0, 12)));
  });

  if (b.kind === 'line') {
    for (const sr of series) {
      const pts = sr.data.map((v, i) => [P.l + step * (i + 0.5), y(v)]);
      svg.append(s('polyline', { points: pts.map((p) => p.join(',')).join(' '), fill: 'none', stroke: sr.color, 'stroke-width': 2 }));
      pts.forEach(([px, py], i) => svg.append(s('circle', { cx: px, cy: py, r: 3, fill: sr.color },
        s('title', {}, `${sr.name || ''} ${labels[i]}: ${fmt(sr.data[i], b.format)}`))));
    }
  } else {
    const bw = (step * 0.8) / series.length;
    series.forEach((sr, si) => sr.data.forEach((v, i) => {
      const x = P.l + step * i + step * 0.1 + bw * si;
      svg.append(s('rect', { x, y: Math.min(y(v), y(0)), width: Math.max(1, bw - 2), height: Math.abs(y(v) - y(0)), fill: sr.color, rx: 2 },
        s('title', {}, `${sr.name || ''} ${labels[i]}: ${fmt(v, b.format)}`)));
    }));
  }
  return h('div', {}, svg, legend(series));
}

function pie(labels, sr, format) {
  const total = sr.data.reduce((a, v) => a + (v > 0 ? v : 0), 0) || 1;
  const svg = s('svg', { viewBox: '0 0 200 200', class: 'chart pie' });
  let angle = -Math.PI / 2;
  const items = labels.map((l, i) => ({ name: l, color: PALETTE[i % PALETTE.length], value: sr.data[i] }));
  items.forEach((it) => {
    const frac = Math.max(0, it.value) / total;
    if (!frac) return;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const p = (a) => `${100 + 90 * Math.cos(a)},${100 + 90 * Math.sin(a)}`;
    const d = frac >= 0.9999 ? 'M100,10 A90,90 0 1 1 99.99,10 Z' : `M100,100 L${p(angle)} A90,90 0 ${large} 1 ${p(a2)} Z`;
    svg.append(s('path', { d, fill: it.color }, s('title', {}, `${it.name}: ${fmt(it.value, format)} (${Math.round(frac * 100)}%)`)));
    angle = a2;
  });
  return h('div', { class: 'pie-wrap' }, svg, legend(items.map((it) => ({ ...it, name: `${it.name} · ${fmt(it.value, format)}` }))));
}

const legend = (items) => (items.length > 1 || items[0]?.name
  ? h('div', { class: 'legend' }, items.map((it) => h('span', {}, h('i', { style: { background: it.color } }), it.name || '')))
  : null);

function short(v, format) {
  const a = Math.abs(v);
  const n = a >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : nf.format(Math.round(v * 100) / 100);
  return format === 'money' ? `$${n}` : format === 'percent' ? `${Math.round(v * 100)}%` : n;
}

// ---------------------------------------------------------------- JSON
export function jsonTree(data, open = true) {
  if (isScalar(data)) return h('code', {}, fmt(data));
  const pre = h('pre', { class: 'json' }, JSON.stringify(data, null, 2));
  return open ? pre : h('details', { class: 'json-d' }, h('summary', {}, Array.isArray(data) ? `[${data.length} elementos]` : `{${Object.keys(data).length} campos}`), pre);
}

// ---------------------------------------------------------------- vista automática
// Intenta mostrar `data` de forma legible cuando el módulo no definió `view`.
export function autoView(data, depth = 0) {
  if (data === null || data === undefined) return [];
  if (isScalar(data)) return [{ type: 'text', text: String(data) }];
  if (Array.isArray(data)) {
    if (!data.length) return [{ type: 'text', text: 'lista vacía' }];
    if (data.every(isScalar)) return [{ type: 'list', items: data.map(String) }];
    if (data.every(isObj)) return [{ type: 'table', rows: data }];
    return [{ type: 'json', data, open: true }];
  }
  const blocks = [];
  const scalars = Object.entries(data).filter(([, v]) => isScalar(v));
  if (scalars.length) blocks.push({ type: 'kv', items: scalars.map(([label, value]) => ({ label, value })) });
  for (const [k, v] of Object.entries(data)) {
    if (isScalar(v)) continue;
    const inner = depth < 2 ? autoView(v, depth + 1) : [{ type: 'json', data: v }];
    blocks.push({ type: 'section', title: humanize(k), open: depth === 0, blocks: inner });
  }
  return blocks;
}
