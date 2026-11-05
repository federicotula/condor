// Personas ficticias para probar el árbol sin tocar servicios reales.
// Se activa buscando un nombre que contenga "demo" (p.ej. "demo perez").
export default {
  id: 'demo',
  name: 'Demo (datos ficticios)',
  accepts: ['nombre'],

  async search(ctx) {
    if (!/demo/i.test(ctx.query)) return [];
    return [
      { label: 'Juana Demo Pérez', detail: 'ficticia · 45 años', facts: { demo_id: ['D-001'], nombre: ['Juana Demo Pérez'] } },
      { label: 'Juan Demo Pérez', detail: 'ficticio · 71 años', facts: { demo_id: ['D-002'], nombre: ['Juan Demo Pérez'] } },
      { label: 'J. Demo Pereira', detail: 'ficticio · 33 años', facts: { demo_id: ['D-003'], nombre: ['J. Demo Pereira'] } },
    ];
  },
};
