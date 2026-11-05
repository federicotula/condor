// A. ARCA (ex AFIP): padrón y constancia de inscripción vía web services oficiales.
// Requiere certificado digital propio (ver README, sección ARCA). Deshabilitados por defecto.
import { view as v } from '../core/view.js';
import { ARCA_DEFAULTS, arcaCheck, asArray, constancia, formatDomicilio, padronA13 } from '../lib/arca.js';

const nombreDe = (p) => p.razonSocial || [p.apellido, p.nombre].filter(Boolean).join(' ').trim() || null;

export default [
  {
    id: 'arca_padron',
    name: 'ARCA · Padrón (datos generales)',
    description: 'Nombre, estado de la CUIT, domicilios y datos generales (ws_sr_padron_a13). Requiere certificado.',
    requires: ['cuit'],
    provides: ['nombre', 'dni', 'domicilio'],
    cacheTtl: 60 * 60 * 24,
    defaultSettings: { ...ARCA_DEFAULTS },
    check: arcaCheck,

    async run(ctx) {
      const r = await padronA13(ctx.inputs.cuit, ctx.settings, ctx.signal);
      const p = r?.persona;
      if (!p) return { data: r, summary: 'sin datos en el padrón', view: [v.alert('ARCA no devolvió datos para esta CUIT.', 'warn')] };

      const domicilios = asArray(p.domicilio);
      const nombre = nombreDe(p);
      const activa = String(p.estadoClave || '').toUpperCase() === 'ACTIVO';
      return {
        facts: {
          nombre: nombre ? [nombre] : [],
          dni: p.numeroDocumento ? [String(p.numeroDocumento)] : [],
          domicilio: domicilios.map(formatDomicilio).filter(Boolean),
        },
        data: r,
        summary: [nombre, p.estadoClave, `${domicilios.length} domicilios`].filter(Boolean).join(' · '),
        view: [
          v.stats([
            { label: 'Estado de la CUIT', value: p.estadoClave || '—', tone: activa ? 'ok' : 'warn' },
            { label: 'Tipo de persona', value: p.tipoPersona || '—' },
            { label: 'Domicilios', value: domicilios.length },
          ]),
          v.kv([
            { label: 'Nombre / razón social', value: nombre },
            { label: 'Tipo de clave', value: p.tipoClave },
            { label: 'Documento', value: p.numeroDocumento ? `${p.tipoDocumento || ''} ${p.numeroDocumento}`.trim() : null },
            { label: 'Fecha de nacimiento', value: p.fechaNacimiento, format: 'date' },
            { label: 'Fecha de fallecimiento', value: p.fechaFallecimiento, format: 'date', tone: p.fechaFallecimiento ? 'bad' : undefined },
            { label: 'Actividad principal', value: p.descripcionActividadPrincipal },
            { label: 'Mes de cierre', value: p.mesCierre },
          ].filter((x) => x.value !== undefined && x.value !== null && x.value !== '')),
          v.table(domicilios.map((d) => ({
            tipo: d.tipoDomicilio, direccion: d.direccion, localidad: d.localidad, provincia: d.descripcionProvincia,
            cp: d.codigoPostal, estado: d.estadoDomicilio,
          })), { title: 'Domicilios', emptyText: 'sin domicilios informados' }),
        ],
      };
    },
  },
  {
    id: 'arca_constancia',
    name: 'ARCA · Constancia de inscripción',
    description: 'Impuestos, actividades y categoría de monotributo (ws_sr_constancia_inscripcion). Requiere certificado.',
    requires: ['cuit'],
    provides: ['domicilio', 'actividad'],
    cacheTtl: 60 * 60 * 24,
    defaultSettings: { ...ARCA_DEFAULTS },
    check: arcaCheck,
    settingsFrom: 'arca_padron', // usa cuit_representada y certificado de arca_padron

    async run(ctx) {
      const r = await constancia(ctx.inputs.cuit, ctx.settings, ctx.signal);
      if (!r) return { summary: 'sin constancia', view: [v.alert('ARCA no devolvió constancia para esta CUIT.', 'warn')] };
      const gen = r.datosGenerales || {};
      const mono = r.datosMonotributo || {};
      const reg = r.datosRegimenGeneral || {};
      const errores = [...asArray(r.errorConstancia?.error), ...asArray(r.errorRegimenGeneral?.error), ...asArray(r.errorMonotributo?.error)];
      const actividades = [...asArray(mono.actividadMonotributista), ...asArray(reg.actividad)];
      const impuestos = [...asArray(mono.impuesto), ...asArray(reg.impuesto)];
      const dom = formatDomicilio(gen.domicilioFiscal);
      const categoria = mono.categoriaMonotributo?.descripcionCategoria;

      return {
        facts: {
          domicilio: dom ? [dom] : [],
          actividad: actividades.map((a) => a.descripcionActividad).filter(Boolean),
        },
        data: r,
        summary: [categoria ? `Monotributo ${categoria}` : impuestos.length ? 'Régimen general' : null,
          `${actividades.length} actividades`].filter(Boolean).join(' · '),
        view: [
          errores.length ? v.alert(errores.join(' · '), 'warn', { title: 'ARCA informa:' }) : null,
          v.stats([
            { label: 'Régimen', value: categoria ? 'Monotributo' : impuestos.length ? 'General' : '—' },
            { label: 'Categoría', value: categoria || '—' },
            { label: 'Actividades', value: actividades.length },
            { label: 'Impuestos', value: impuestos.length },
          ]),
          v.kv([
            { label: 'Nombre / razón social', value: nombreDe(gen) },
            { label: 'Estado de la CUIT', value: gen.estadoClave },
            { label: 'Domicilio fiscal', value: dom },
          ].filter((x) => x.value)),
          v.table(actividades.map((a) => ({ codigo: a.idActividad, actividad: a.descripcionActividad, orden: a.orden, periodo: a.periodo })),
            { title: 'Actividades', emptyText: 'sin actividades' }),
          v.table(impuestos.map((i) => ({ impuesto: i.descripcionImpuesto, id: i.idImpuesto, estado: i.estadoImpuesto, periodo: i.periodo })),
            { title: 'Impuestos', emptyText: 'sin impuestos' }),
        ].filter(Boolean),
      };
    },
  },
];
