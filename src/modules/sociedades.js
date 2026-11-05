// E. Registro Nacional de Sociedades (base local importada desde datos abiertos).
// Importar antes:  condor import-sociedades 2026   (o: make import-sociedades)
import { formatCuit } from '../core/ar.js';
import { view as v } from '../core/view.js';
import { fmtDom, fmtRegistro, porCuit, porDomicilio, vistaSociedad } from '../lib/sociedades.js';

const resumenFila = (s) => ({
  razon_social: s.razon_social,
  cuit: formatCuit(s.cuit),
  tipo: s.tipo_societario,
  domicilio_fiscal: fmtDom(s, 'fiscal'),
  constitucion: s.fecha_contrato?.slice(0, 10),
  registro: s.registro ? { value: fmtRegistro(s.registro), tone: s.registro.vigente ? 'ok' : 'warn' } : '—',
});

export default [
  {
    id: 'sociedades_cuit',
    name: 'Registro Nacional de Sociedades · por CUIT',
    description: 'Si la CUIT es de una sociedad: razón social, tipo, constitución, domicilios y actividades',
    requires: ['cuit'],
    provides: ['nombre', 'domicilio', 'actividad'],
    cacheTtl: 0,

    async run(ctx) {
      const s = await porCuit(ctx.inputs.cuit);
      if (!s) return { summary: 'no figura como sociedad', view: [v.alert('Esta CUIT no figura en el Registro Nacional de Sociedades (puede ser una persona humana).', 'info')] };
      const fiscal = fmtDom(s, 'fiscal');
      const legal = fmtDom(s, 'legal');
      const activas = s.actividades.filter((a) => a.estado !== 'BD');
      return {
        facts: {
          nombre: [s.razon_social].filter(Boolean),
          domicilio: [fiscal, legal].filter(Boolean),
          actividad: activas.map((a) => a.descripcion).filter(Boolean),
        },
        data: s,
        summary: [s.razon_social, s.tipo_societario, s.registro && !s.registro.vigente ? `no figura desde ${s.registro.baja_desde}` : null].filter(Boolean).join(' · '),
        view: vistaSociedad(s),
      };
    },
  },
  {
    id: 'sociedades_domicilio',
    name: 'Registro Nacional de Sociedades · por domicilio',
    description: 'Sociedades con domicilio fiscal o legal en la misma calle y altura',
    requires: ['domicilio'],
    provides: ['sociedad_vinculada'],
    cacheTtl: 0,

    async run(ctx) {
      const { parsed, rows } = await porDomicilio(ctx.inputs.domicilio);
      if (!parsed) return { summary: 'domicilio sin altura', view: [v.alert('No se pudo separar calle y altura del domicilio.', 'warn')] };
      ctx.log(`buscando calle "${parsed.key}" altura ${parsed.numero}`);
      const porTipo = rows.reduce((acc, s) => ({ ...acc, [s.tipo_societario || 'sin tipo']: (acc[s.tipo_societario || 'sin tipo'] || 0) + 1 }), {});
      return {
        facts: { sociedad_vinculada: rows.map((s) => `${s.razon_social} (${formatCuit(s.cuit)})`) },
        data: { parsed, rows },
        summary: rows.length ? `${rows.length} sociedades en ${parsed.calle} ${parsed.numero}` : 'ninguna sociedad en ese domicilio',
        view: rows.length ? [
          v.text(`Sociedades registradas en ${parsed.calle} ${parsed.numero}. La coincidencia es por calle y altura: puede incluir otros pisos, departamentos o localidades con la misma calle.`),
          v.table(rows.map((s) => ({
            ...resumenFila(s),
            coincide: s.fiscal_numero === parsed.numero && s.legal_numero === parsed.numero ? 'fiscal y legal'
              : s.fiscal_numero === parsed.numero ? 'fiscal' : 'legal',
          })), { title: 'Sociedades en el domicilio' }),
          Object.keys(porTipo).length > 1 ? v.chart({ kind: 'pie', title: 'Por tipo societario', labels: Object.keys(porTipo), series: [{ data: Object.values(porTipo) }] }) : null,
        ].filter(Boolean) : [v.alert(`No hay sociedades registradas en ${parsed.calle} ${parsed.numero}.`, 'ok')],
      };
    },
  },
];
