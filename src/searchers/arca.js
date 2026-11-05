// Buscador por DNI vía ARCA (getIdPersonaListByDocumento) → CUITs reales del DNI.
// Requiere certificado (ver README, sección ARCA). Usa los settings del módulo arca_padron
// si no se le cargan propios.
import { formatCuit } from '../core/ar.js';
import { ARCA_DEFAULTS, asArray, cuitsPorDni, padronA13 } from '../lib/arca.js';

export default {
  id: 'arca_dni',
  name: 'ARCA (DNI → CUIT)',
  description: 'Busca las CUIT asociadas a un DNI en el padrón de ARCA. Requiere certificado.',
  accepts: ['dni', 'cuit'],
  defaultSettings: { ...ARCA_DEFAULTS },
  settingsFrom: 'arca_padron', // usa cuit_representada y certificado de arca_padron

  async search(ctx) {
    const cuits = ctx.detected.cuit ?? (await cuitsPorDni(ctx.detected.dni[0], ctx.settings, ctx.signal));
    const out = [];
    for (const cuit of cuits.slice(0, 5)) {
      const p = (await padronA13(cuit, ctx.settings, ctx.signal))?.persona;
      if (!p) continue;
      const nombre = p.razonSocial || [p.apellido, p.nombre].filter(Boolean).join(' ');
      const dom = asArray(p.domicilio)[0];
      out.push({
        label: nombre || `CUIT ${formatCuit(cuit)}`,
        detail: [`CUIT ${formatCuit(cuit)}`, p.estadoClave, dom?.localidad].filter(Boolean).join(' · '),
        facts: { cuit: [cuit], dni: p.numeroDocumento ? [String(p.numeroDocumento)] : [], nombre: nombre ? [nombre] : [] },
      });
    }
    return out;
  },
};
