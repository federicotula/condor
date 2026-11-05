// Bloques de presentación que un módulo puede devolver en `view` para que la web
// muestre el resultado bien explicado. Son objetos JSON simples; estos helpers sólo
// ayudan a armarlos. Ejemplo:
//
//   import { view as v } from '../core/view.js';
//   return {
//     facts, data,
//     view: [
//       v.stats([{ label: 'Entidades', value: 3 }, { label: 'Peor situación', value: 2, tone: 'warn' }]),
//       v.table(rows, { title: 'Deudas', columns: [{ key: 'entidad', label: 'Entidad' }, { key: 'monto', format: 'money' }] }),
//       v.chart({ kind: 'line', labels: ['2024-01', '2024-02'], series: [{ name: 'Monto', data: [10, 12] }] }),
//     ],
//   };
//
// Tonos (tone): 'ok' | 'warn' | 'bad' | 'info' | 'muted'
// Formatos de columna/valor (format): 'text' | 'number' | 'money' | 'percent' | 'date' | 'link' | 'badge' | 'json'
// Una celda puede ser un valor simple o { value, tone, href, hint }.

const toItems = (obj) => (Array.isArray(obj) ? obj : Object.entries(obj || {}).map(([label, value]) => ({ label, value })));

export const view = {
  /** Párrafo de texto (admite saltos de línea). */
  text: (text, { title } = {}) => ({ type: 'text', title, text }),

  /** Aviso destacado. level: info | ok | warn | bad */
  alert: (text, level = 'info', { title } = {}) => ({ type: 'alert', level, title, text }),

  /** Indicadores grandes: [{ label, value, hint?, tone?, format? }] */
  stats: (items, { title } = {}) => ({ type: 'stats', title, items }),

  /** Clave/valor: objeto plano o [{ label, value, format?, tone? }] */
  kv: (items, { title } = {}) => ({ type: 'kv', title, items: toItems(items) }),

  /** Tabla: rows = [{...}], columns = [{ key, label?, format?, align? }] (si no, se infieren).
   *  footer: fila fija al pie, p.ej. { entidad: 'Total', monto: 1234 } */
  table: (rows, { title, columns, emptyText, footer } = {}) => ({ type: 'table', title, rows: rows || [], columns, emptyText, footer }),

  /** Lista: strings o { text, sub?, href?, tag?, tone? } */
  list: (items, { title, ordered = false } = {}) => ({ type: 'list', title, ordered, items: items || [] }),

  /** Gráfico: kind bar | line | pie; series = [{ name, data: [números] }] alineadas con labels. */
  chart: ({ kind = 'bar', labels = [], series = [], title, format, height } = {}) =>
    ({ type: 'chart', kind, title, labels, series, format, height }),

  /** Línea de tiempo: [{ date, title, text?, tone? }] */
  timeline: (items, { title } = {}) => ({ type: 'timeline', title, items: items || [] }),

  /** Etiquetas cortas: strings o { text, tone } */
  tags: (items, { title } = {}) => ({ type: 'tags', title, items: items || [] }),

  /** Links externos: [{ label, href }] */
  links: (items, { title } = {}) => ({ type: 'links', title, items: items || [] }),

  /** Mapa con un punto (OpenStreetMap embebido). */
  map: ({ lat, lon, label, title, zoom = 16 }) => ({ type: 'map', title, lat: Number(lat), lon: Number(lon), label, zoom }),

  /** Imagen (URL o data: URI). */
  image: (src, { title, caption } = {}) => ({ type: 'image', title, src, caption }),

  /** JSON colapsable (para lo que no tenga mejor forma). */
  json: (data, { title, open = false } = {}) => ({ type: 'json', title, data, open }),

  /** Agrupa bloques bajo un título plegable. */
  section: (title, blocks, { open = true } = {}) => ({ type: 'section', title, open, blocks: [blocks].flat().filter(Boolean) }),
};
