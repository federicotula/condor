// Situación crediticia en la Central de Deudores del BCRA (último período informado).
import { view as v } from '../core/view.js';
import { bcraGet, BCRA_DEFAULTS } from '../lib/bcra.js';

// Clasificación de deudores del BCRA (cartera de consumo).
const SITUACION = {
  1: ['Normal', 'ok'],
  2: ['Riesgo bajo', 'warn'],
  3: ['Riesgo medio', 'warn'],
  4: ['Riesgo alto', 'bad'],
  5: ['Irrecuperable', 'bad'],
  6: ['Irrecuperable por disp. técnica', 'bad'],
};
const sit = (n) => SITUACION[n] || [`Situación ${n}`, 'muted'];
const periodo = (p) => (/^\d{6}$/.test(String(p)) ? `${String(p).slice(4)}/${String(p).slice(0, 4)}` : p || '—');

const FLAGS = {
  refinanciaciones: 'Refinanciada',
  recategorizacionOblig: 'Recategorización obligatoria',
  situacionJuridica: 'Situación jurídica',
  irrecDisposicionTecnica: 'Irrec. disposición técnica',
  enRevision: 'En revisión',
  procesoJud: 'Proceso judicial',
};

export default {
  id: 'bcra_deudores',
  name: 'BCRA · Central de Deudores',
  description: 'Deudas informadas por entidades financieras para un CUIT/CUIL',
  requires: ['cuit'],
  provides: ['nombre', 'bcra_situacion', 'entidad_financiera'],
  cacheTtl: 60 * 60 * 12,
  defaultSettings: { ...BCRA_DEFAULTS },

  async run(ctx) {
    const r = await bcraGet(`/Deudas/${ctx.inputs.cuit}`, { settings: ctx.settings, signal: ctx.signal });
    if (!r) {
      return { summary: 'sin registros en la central', view: [v.alert('El BCRA no tiene deudas informadas para este CUIT.', 'ok')] };
    }

    const periodos = r.periodos || [];
    const ultimo = periodos[0] || { entidades: [] };
    const entidades = ultimo.entidades || [];
    const peor = Math.max(0, ...entidades.map((e) => Number(e.situacion) || 0));
    // `monto` según la doc del BCRA viene en miles de pesos (verificar).
    const total = entidades.reduce((a, e) => a + (Number(e.monto) || 0), 0);
    const flags = entidades.flatMap((e) => Object.keys(FLAGS).filter((k) => e[k]).map((k) => `${FLAGS[k]} · ${e.entidad}`));
    ctx.log(`período ${ultimo.periodo ?? '?'}: ${entidades.length} entidades`);

    const view = [
      v.stats([
        { label: 'Peor situación', value: peor ? `${peor} · ${sit(peor)[0]}` : '—', tone: peor ? sit(peor)[1] : 'muted' },
        { label: 'Entidades', value: entidades.length, format: 'number' },
        { label: 'Deuda total (miles $)', value: total, format: 'number' },
        { label: 'Período informado', value: periodo(ultimo.periodo) },
      ]),
      flags.length ? v.alert(flags.join(' · '), 'bad', { title: 'Marcas:' }) : null,
      v.table(entidades.map((e) => ({
        entidad: e.entidad,
        situacion: { value: `${e.situacion} · ${sit(e.situacion)[0]}`, tone: sit(e.situacion)[1] },
        monto: Number(e.monto) || 0,
        atraso: Number(e.diasAtrasoPago) || 0,
      })), {
        title: 'Deudas por entidad',
        footer: { entidad: `Total (${entidades.length} entidades)`, monto: total, atraso: Math.max(0, ...entidades.map((e) => Number(e.diasAtrasoPago) || 0)) },
        columns: [
          { key: 'entidad', label: 'Entidad' },
          { key: 'situacion', label: 'Situación' },
          { key: 'monto', label: 'Monto (miles $)', format: 'number' },
          { key: 'atraso', label: 'Días de atraso', format: 'number' },
        ],
      }),
      entidades.length > 1 ? v.chart({
        kind: 'pie', title: 'Distribución de la deuda',
        labels: entidades.map((e) => e.entidad), series: [{ name: 'Monto', data: entidades.map((e) => Number(e.monto) || 0) }],
      }) : null,
      periodos.length > 1 ? v.chart({
        kind: 'line', title: 'Evolución de la deuda total (miles $)',
        labels: periodos.map((p) => periodo(p.periodo)).reverse(),
        series: [{ name: 'Total', data: periodos.map((p) => (p.entidades || []).reduce((a, e) => a + (Number(e.monto) || 0), 0)).reverse() }],
      }) : null,
    ].filter(Boolean);

    return {
      facts: {
        nombre: r.denominacion ? [r.denominacion.trim()] : [],
        bcra_situacion: entidades.length ? [String(peor)] : [],
        entidad_financiera: entidades.map((e) => e.entidad).filter(Boolean),
      },
      data: r,
      view,
      summary: entidades.length
        ? `${entidades.length} entidades · peor situación ${peor} (${sit(peor)[0]}) · total ${total}`
        : 'sin deudas en el último período',
    };
  },
};
