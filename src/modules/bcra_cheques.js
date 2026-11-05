// Cheques rechazados informados al BCRA.
import { view as v } from '../core/view.js';
import { bcraGet, BCRA_DEFAULTS } from '../lib/bcra.js';

// Recorre la respuesta y junta cada objeto que tenga nroCheque, arrastrando los
// campos simples de sus ancestros (causal, entidad…). No depende de la forma exacta.
function flatten(x, ctx = {}, out = []) {
  if (Array.isArray(x)) { x.forEach((i) => flatten(i, ctx, out)); return out; }
  if (!x || typeof x !== 'object') return out;
  const scalars = Object.fromEntries(Object.entries(x).filter(([, val]) => val === null || typeof val !== 'object'));
  const merged = { ...ctx, ...scalars };
  if ('nroCheque' in x) out.push(merged);
  for (const val of Object.values(x)) if (val && typeof val === 'object') flatten(val, merged, out);
  return out;
}

export default {
  id: 'bcra_cheques_rechazados',
  name: 'BCRA · Cheques rechazados',
  requires: ['cuit'],
  provides: [],
  cacheTtl: 60 * 60 * 12,
  defaultSettings: { ...BCRA_DEFAULTS, path: '/Deudas/ChequesRechazados/' },

  async run(ctx) {
    const r = await bcraGet(`${ctx.settings.path}${ctx.inputs.cuit}`, { settings: ctx.settings, signal: ctx.signal });
    const rows = flatten(r).map(({ identificacion, denominacion, ...rest }) => rest);
    if (!rows.length) {
      return { data: r, summary: 'sin cheques rechazados', view: [v.alert('No hay cheques rechazados informados.', 'ok')] };
    }
    const monto = rows.reduce((a, c) => a + (Number(c.monto) || 0), 0);
    const pagados = rows.filter((c) => c.fechaPago).length;
    return {
      data: r,
      summary: `${rows.length} cheques rechazados`,
      view: [
        v.stats([
          { label: 'Cheques rechazados', value: rows.length, tone: 'bad' },
          { label: 'Monto total', value: monto, format: 'money' },
          { label: 'Pagados luego', value: pagados, tone: pagados === rows.length ? 'ok' : 'warn' },
        ]),
        v.table(rows, { title: 'Detalle' }),
      ],
    };
  },
};
