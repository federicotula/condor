// Busca por CUIT o DNI en la Central de Deudores del BCRA para obtener la denominación.
// Con DNI prueba los CUIT/CUIL posibles (20/27/23/24). Sólo encuentra personas que
// tengan registros en la central (quien nunca tuvo crédito puede no aparecer).
import { cuitsFromDni, dniFromCuit, formatCuit } from '../core/ar.js';
import { bcraGet, BCRA_DEFAULTS } from '../lib/bcra.js';

export default {
  id: 'bcra_cuit',
  name: 'BCRA (CUIT/DNI → nombre)',
  description: 'Resuelve nombre a partir de CUIT o DNI usando la Central de Deudores',
  accepts: ['cuit', 'dni'],
  defaultSettings: { ...BCRA_DEFAULTS },

  async search(ctx) {
    const cuits = ctx.detected.cuit ?? cuitsFromDni(ctx.detected.dni?.[0]);
    const found = await Promise.all(cuits.map(async (cuit) => {
      const r = await bcraGet(`/Deudas/${cuit}`, { settings: ctx.settings, signal: ctx.signal });
      if (!r?.denominacion) return null;
      return {
        label: r.denominacion.trim(),
        detail: `CUIT ${formatCuit(cuit)}`,
        facts: { cuit: [cuit], dni: [dniFromCuit(cuit)], nombre: [r.denominacion.trim()] },
      };
    }));
    return found.filter(Boolean);
  },
};
