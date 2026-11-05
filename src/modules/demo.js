// Módulos ficticios para ver el árbol, el paralelismo, la deduplicación y las vistas funcionando.
// Sólo actúan sobre las personas del buscador "demo" (requieren `demo_id`).
import { view as v } from '../core/view.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 600 + Math.random() * 1400;

export default [
  {
    id: 'demo_padron',
    name: 'Demo · Padrón',
    requires: ['demo_id'],
    provides: ['domicilio', 'email', 'telefono'],
    async run(ctx) {
      await sleep(jitter());
      ctx.log(`consultando padrón ficticio para ${ctx.inputs.demo_id}`);
      const data = {
        id: ctx.inputs.demo_id, categoria: 'Monotributo D', actividad: 'Servicios profesionales',
        alta: '2015-03-01', estado: 'Activo',
        historial: [
          { fecha: '2015-03-01', categoria: 'B' }, { fecha: '2018-07-01', categoria: 'C' },
          { fecha: '2021-02-01', categoria: 'D' }, { fecha: '2024-01-15', categoria: 'D' },
        ],
      };
      return {
        facts: { domicilio: ['Av. Corrientes 1500, CABA'], email: ['juana.demo@example.com'], telefono: ['1155550000'] },
        data,
        summary: '1 domicilio, 1 email, 1 teléfono',
        view: [
          v.alert('Datos ficticios de ejemplo.', 'info'),
          v.kv([
            { label: 'Estado', value: data.estado, tone: 'ok' },
            { label: 'Categoría', value: data.categoria },
            { label: 'Actividad', value: data.actividad },
            { label: 'Alta', value: data.alta, format: 'date' },
          ], { title: 'Inscripción' }),
          v.timeline(data.historial.map((h, i) => ({
            date: h.fecha, title: `Categoría ${h.categoria}`, text: i === 0 ? 'alta' : 'recategorización',
            tone: i === data.historial.length - 1 ? 'ok' : undefined,
          })), { title: 'Historial' }),
          v.list([
            { text: 'Av. Corrientes 1500, CABA', tag: 'domicilio fiscal', tone: 'info' },
            { text: 'juana.demo@example.com', tag: 'email' },
            { text: '11 5555-0000', tag: 'teléfono' },
          ], { title: 'Contacto declarado' }),
        ],
      };
    },
  },
  {
    id: 'demo_redes',
    name: 'Demo · Redes por email',
    requires: ['email'],
    provides: ['domicilio', 'usuario_instagram'],
    async run(ctx) {
      await sleep(jitter());
      const perfiles = [
        { red: 'Instagram', usuario: '@juana.demo', seguidores: 1240, publicaciones: 318, url: 'https://example.com/juana' },
        { red: 'LinkedIn', usuario: 'juana-demo', seguidores: 530, publicaciones: 12, url: 'https://example.com/in/juana' },
        { red: 'X', usuario: '@jdemo', seguidores: 87, publicaciones: 1022, url: 'https://example.com/jdemo' },
      ];
      // El primer domicilio es el mismo que el del padrón con otro formato -> se deduplica.
      return {
        facts: { domicilio: ['AV CORRIENTES 1500 - CABA', 'Florida 100, CABA'], usuario_instagram: ['@juana.demo'] },
        data: { perfiles },
        summary: '3 perfiles, 2 domicilios (1 repetido)',
        view: [
          v.stats([
            { label: 'Perfiles', value: perfiles.length },
            { label: 'Seguidores totales', value: perfiles.reduce((a, p) => a + p.seguidores, 0), format: 'number' },
            { label: 'Coincidencia', value: 0.82, format: 'percent', tone: 'ok', hint: 'confianza de que sean la misma persona' },
          ]),
          v.table(perfiles.map((p) => ({ ...p, usuario: { value: p.usuario, href: p.url } })), {
            title: 'Perfiles encontrados',
            columns: [
              { key: 'red', label: 'Red' }, { key: 'usuario', label: 'Usuario' },
              { key: 'seguidores', format: 'number' }, { key: 'publicaciones', format: 'number' },
            ],
          }),
          v.chart({
            kind: 'bar', title: 'Actividad por red',
            labels: perfiles.map((p) => p.red),
            series: [
              { name: 'Seguidores', data: perfiles.map((p) => p.seguidores) },
              { name: 'Publicaciones', data: perfiles.map((p) => p.publicaciones) },
            ],
          }),
          v.tags(['viajes', 'fotografía', 'running', { text: 'menciona domicilio', tone: 'warn' }], { title: 'Temas frecuentes' }),
        ],
      };
    },
  },
  {
    id: 'demo_vecinos',
    name: 'Demo · Vecinos',
    requires: ['domicilio'],
    async run(ctx) {
      await sleep(jitter());
      if (/florida/i.test(ctx.inputs.domicilio)) throw new Error('servicio demo caído (error simulado)');
      const meses = ['jun', 'jul', 'ago', 'sep', 'oct', 'nov'];
      return {
        data: { vecinos: 3 },
        summary: '3 vecinos registrados (ficticio)',
        view: [
          v.chart({ kind: 'line', title: 'Personas registradas en el domicilio', labels: meses,
            series: [{ name: 'Registros', data: [1, 1, 2, 2, 3, 3] }] }),
          v.chart({ kind: 'pie', title: 'Tipo de registro', labels: ['Titular', 'Familiar', 'Comercial'],
            series: [{ name: 'Cantidad', data: [1, 1, 1] }] }),
        ],
      };
    },
  },
];
