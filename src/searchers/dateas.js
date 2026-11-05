// Búsqueda por nombre en Dateas, hecha a mano por el usuario.
// Dateas bloquea el acceso automatizado (Cloudflare), así que Cóndor no lo consulta: arma el
// link con el nombre cargado para abrirlo en el navegador. El usuario elige la persona allí
// y pega el CUIT/CUIL en Cóndor, que sigue con ese dato.
//
// `url` es una plantilla: {q} se reemplaza por el nombre. Si Dateas cambia el formato de su
// búsqueda, se ajusta desde la pestaña Módulos sin tocar código.

export default {
  id: 'dateas',
  name: 'Dateas (búsqueda manual)',
  description: 'Abre Dateas con el nombre cargado para elegir a mano el CUIT/CUIL',
  accepts: ['nombre'],
  manual: true,
  defaultSettings: { url: 'https://www.dateas.com/es/consulta_cuit_cuil?name={q}' },

  async search(ctx) {
    const nombre = ctx.detected.nombre[0];
    return [{
      manual: true,
      label: 'Buscar en Dateas',
      detail: 'Se abre en una pestaña nueva. Elegí la persona y pegá acá su CUIT/CUIL.',
      url: String(ctx.settings.url).replace('{q}', encodeURIComponent(nombre)),
      field: 'cuit',
    }];
  },
};
