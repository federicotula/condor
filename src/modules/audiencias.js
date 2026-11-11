// Registro Único de Audiencias de Gestión de Intereses (Ministerio del Interior / Jefatura de Gabinete).
// Audiencias de funcionarios públicos con particulares: quién pidió la reunión, a quién representaba,
// con qué funcionario y para qué.
//
// Consulta la copia local (data/audiencias.db). Importar / actualizar antes:
//   make audiencias-actualizar      (o: condor audiencias-actualizar)
// Ver src/lib/audiencias.js para cómo se baja de la API del sitio.
import { normalize } from '../core/facts.js';
import { view as v } from '../core/view.js';
import { BASE, porDocumento } from '../lib/audiencias.js';

const ROLES = {
  funcionario: ['Funcionario (sujeto obligado)', 'info'],
  solicitante: ['Solicitante', 'warn'],
  representado: ['Representado', 'warn'],
  participante: ['Participante', 'muted'],
};
const ORDEN = Object.keys(ROLES);

const contar = (vals) => Object.entries(vals.filter(Boolean).reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);

export default {
  id: 'audiencias',
  name: 'Registro Único de Audiencias (gestión de intereses)',
  description: 'Audiencias con funcionarios nacionales donde el DNI figura como funcionario, solicitante, representado o participante (base local)',
  requires: ['dni'],
  provides: ['nombre', 'entidad_representada'],
  cacheTtl: 0,

  async run(ctx) {
    const { documento: dni, audiencias, ultimaSync } = await porDocumento(ctx.inputs.dni);
    const publicUrl = `${BASE}/?search=${dni}`;
    const actualizada = ultimaSync ? `Base local actualizada el ${ultimaSync.slice(0, 10)}.` : 'Base local sin fecha de actualización.';
    ctx.log(`${audiencias.length} audiencias (base del ${ultimaSync?.slice(0, 10) ?? '?'})`);

    if (!audiencias.length) {
      return {
        summary: 'sin audiencias registradas',
        view: [v.alert(`El DNI no figura en ninguna audiencia publicada. ${actualizada}`, 'ok'), v.links([{ label: 'Ver en el registro', href: publicUrl }])],
      };
    }

    const rows = audiencias.map((a) => {
      const roles = ORDEN.filter((r) => a.personas.some((p) => p.rol === r && p.documento === dni));
      const de = (rol) => a.personas.filter((p) => p.rol === rol);
      const funcionario = de('funcionario')[0];
      const solicitante = de('solicitante')[0];
      return {
        fecha: a.fecha,
        rol: { value: roles.map((r) => ROLES[r][0]).join(' + '), tone: ROLES[roles[0]]?.[1] ?? 'muted' },
        roles,
        funcionario: [funcionario?.nombre, a.cargo_funcionario].filter(Boolean).join(' · '),
        dependencia: a.dependencia ?? '',
        solicitante: solicitante?.nombre ?? '',
        representa: a.representa_nombre
          ? `${a.representa_nombre}${a.representa_cuit ? ` (${a.representa_cuit})` : ''}`
          : (a.representacion === 'PARTICULAR' ? 'Particular' : a.representacion ?? ''),
        entidad: a.representa_nombre,
        motivo: a.motivo ?? a.sintesis ?? '',
        tipo: a.tipo ?? '',
        lugar: a.lugar ?? '',
        participantes: de('participante').map((p) => p.nombre).filter(Boolean).join(', '),
      };
    });

    const porRol = Object.fromEntries(ORDEN.map((r) => [r, rows.filter((x) => x.roles.includes(r)).length]));
    const fechas = rows.map((r) => r.fecha).filter(Boolean).sort();
    // nombre más frecuente con el que figura ese documento
    const nombre = contar(audiencias.flatMap((a) => a.personas.filter((p) => p.documento === dni).map((p) => p.nombre)))[0]?.[0];
    const entidades = contar(rows.filter((r) => r.roles.includes('solicitante')).map((r) => r.entidad));
    const dependencias = contar(rows.map((r) => r.dependencia)).slice(0, 10);
    const porAnio = contar(rows.map((r) => String(r.fecha).slice(0, 4))).sort((a, b) => a[0].localeCompare(b[0]));

    const view = [
      v.stats([
        { label: 'Audiencias', value: rows.length, format: 'number' },
        { label: 'Como funcionario', value: porRol.funcionario, format: 'number', tone: porRol.funcionario ? 'info' : 'muted' },
        { label: 'Como solicitante', value: porRol.solicitante, format: 'number', tone: porRol.solicitante ? 'warn' : 'muted' },
        { label: 'Como participante', value: porRol.participante, format: 'number' },
        porRol.representado ? { label: 'Representado', value: porRol.representado, format: 'number', tone: 'warn' } : null,
        { label: 'Período', value: fechas.length ? `${fechas[0]} → ${fechas.at(-1)}` : '—' },
      ].filter(Boolean)),
      nombre ? v.kv([{ label: 'Nombre en el registro', value: nombre }]) : null,
      entidades.length ? v.table(entidades.map(([entidad, n]) => ({ entidad, n })), {
        title: 'Entidades que representó como solicitante',
        columns: [{ key: 'entidad', label: 'Entidad' }, { key: 'n', label: 'Audiencias', format: 'number' }],
      }) : null,
      v.table(rows, {
        title: 'Audiencias',
        columns: [
          { key: 'fecha', label: 'Fecha', format: 'date' },
          { key: 'rol', label: 'Rol del DNI' },
          { key: 'funcionario', label: 'Funcionario' },
          { key: 'dependencia', label: 'Dependencia' },
          { key: 'solicitante', label: 'Solicitante' },
          { key: 'representa', label: 'Representa a' },
          { key: 'motivo', label: 'Motivo' },
          { key: 'tipo', label: 'Tipo' },
          { key: 'participantes', label: 'Otros participantes' },
        ],
      }),
      porAnio.length > 1 ? v.chart({ kind: 'bar', title: 'Audiencias por año', labels: porAnio.map(([y]) => y), series: [{ name: 'Audiencias', data: porAnio.map(([, n]) => n) }] }) : null,
      dependencias.length > 1 ? v.chart({ kind: 'pie', title: 'Dependencias', labels: dependencias.map(([d]) => d), series: [{ name: 'Audiencias', data: dependencias.map(([, n]) => n) }] }) : null,
      v.text(actualizada),
      v.links([{ label: 'Ver en el registro', href: publicUrl }]),
    ].filter(Boolean);

    const partes = ORDEN.filter((r) => porRol[r]).map((r) => `${porRol[r]} como ${r}`);
    return {
      facts: {
        nombre: nombre ? [nombre] : [],
        // sólo las entidades que la persona representó (no las de otros solicitantes)
        entidad_representada: entidades.map(([e]) => e),
      },
      data: { audiencias },
      view,
      summary: `${rows.length} audiencias · ${partes.join(' · ')}`,
    };
  },
  // misma persona = mismo DNI (con o sin ceros a la izquierda)
  dedupKey: (inputs) => normalize('dni', inputs.dni).replace(/^0+/, ''),
};
