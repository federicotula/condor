// Plantillas sin implementar (deshabilitadas en config/modules.json).
// Antes de implementarlas revisá términos de uso de cada plataforma y la Ley 25.326.
const pending = (ctx) => { throw new Error(`${ctx.moduleId}: módulo sin implementar`); };

export default [
  {
    id: 'instagram',
    name: 'Instagram',
    requires: ['nombre'],
    provides: ['usuario_instagram'],
    run: pending,
  },
  {
    id: 'facebook',
    name: 'Facebook',
    requires: ['nombre'],
    provides: ['usuario_facebook'],
    run: pending,
  },
  {
    id: 'email_lookup',
    name: 'Email',
    requires: ['email'],
    provides: ['nombre', 'usuario_instagram'],
    run: pending,
  },
];
