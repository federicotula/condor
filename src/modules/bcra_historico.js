// B. BCRA: historial de deudas de los últimos 24 meses (Central de Deudores).
import { view as v } from '../core/view.js';
import { bcraGet, BCRA_DEFAULTS } from '../lib/bcra.js';

const periodo = (p) => (/^\d{6}$/.test(String(p)) ? `${String(p).slice(4)}/${String(p).slice(0, 4)}` : String(p ?? '—'));
const TONE = { 1: 'ok', 2: 'warn', 3: 'warn', 4: 'bad', 5: 'bad', 6: 'bad' };

export default {
  id: 'bcra_historico',
  name: 'BCRA · Historial 24 meses',
  description: 'Evolución de la deuda y la situación por entidad en los últimos 24 meses',
  requires: ['cuit'],
  provides: [],
  cacheTtl: 60 * 60 * 12,
  defaultSettings: { ...BCRA_DEFAULTS },

  async run(ctx) {
    const r = await bcraGet(`/Deudas/Historicas/${ctx.inputs.cuit}`, { settings: ctx.settings, signal: ctx.signal });
    const periodos = [...(r?.periodos || [])].sort((a, b) => String(a.periodo).localeCompare(String(b.periodo)));
    if (!periodos.length) {
      return { data: r, summary: 'sin historial', view: [v.alert('Sin historial en la Central de Deudores.', 'ok')] };
    }

    const labels = periodos.map((p) => periodo(p.periodo));
    const totales = periodos.map((p) => (p.entidades || []).reduce((a, e) => a + (Number(e.monto) || 0), 0));
    const peores = periodos.map((p) => Math.max(0, ...(p.entidades || []).map((e) => Number(e.situacion) || 0)));
    const entidades = [...new Set(periodos.flatMap((p) => (p.entidades || []).map((e) => e.entidad)))];

    // Matriz entidad × período con la situación de cada mes (últimos 12 para que entre en pantalla).
    const ult = periodos.slice(-12);
    const matriz = entidades.map((ent) => {
      const row = { entidad: ent };
      for (const p of ult) {
        const e = (p.entidades || []).find((x) => x.entidad === ent);
        row[p.periodo] = e ? { value: Number(e.situacion), tone: TONE[e.situacion] || 'muted', hint: `monto ${e.monto}` } : null;
      }
      return row;
    });

    const peorHistorica = Math.max(...peores);
    const mesesIrregulares = peores.filter((s) => s > 1).length;
    const variacion = totales.length > 1 && totales[0] ? (totales.at(-1) - totales[0]) / totales[0] : null;

    return {
      data: r,
      summary: `${periodos.length} meses · peor situación ${peorHistorica} · ${mesesIrregulares} meses irregulares`,
      view: [
        v.stats([
          { label: 'Peor situación (24m)', value: peorHistorica, tone: TONE[peorHistorica] || 'muted' },
          { label: 'Meses en situación > 1', value: mesesIrregulares, tone: mesesIrregulares ? 'warn' : 'ok' },
          { label: 'Entidades distintas', value: entidades.length },
          { label: 'Variación de la deuda', value: variacion, format: 'percent', tone: variacion > 0.2 ? 'warn' : undefined,
            hint: `${labels[0]} → ${labels.at(-1)}` },
        ]),
        v.chart({ kind: 'line', title: 'Deuda total por mes (miles $)', labels, series: [{ name: 'Total', data: totales }] }),
        v.chart({ kind: 'bar', title: 'Peor situación por mes', labels, series: [{ name: 'Situación', data: peores }] }),
        v.table(matriz, {
          title: 'Situación por entidad (últimos 12 meses)',
          columns: [{ key: 'entidad', label: 'Entidad' }, ...ult.map((p) => ({ key: String(p.periodo), label: periodo(p.periodo), format: 'number' }))],
        }),
      ],
    };
  },
};
