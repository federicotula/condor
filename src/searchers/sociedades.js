// Busca sociedades por CUIT o razón social en la base local del Registro Nacional de Sociedades.
import fs from 'node:fs';
import { formatCuit } from '../core/ar.js';
import { DB_PATH, fmtDom, porCuit, porNombre } from '../lib/sociedades.js';

export default {
  id: 'sociedades',
  name: 'Registro Nacional de Sociedades',
  description: 'Sociedades por CUIT o razón social (base local; importar con condor import-sociedades)',
  accepts: ['cuit', 'nombre'],

  async search(ctx) {
    if (!fs.existsSync(DB_PATH)) return [];
    const rows = ctx.detected.cuit
      ? [await porCuit(ctx.detected.cuit[0])].filter(Boolean)
      : await porNombre(ctx.detected.nombre[0], ctx.settings.limit || 15);
    return rows.map((s) => ({
      label: s.razon_social,
      detail: [`CUIT ${formatCuit(s.cuit)}`, s.tipo_societario, fmtDom(s, 'fiscal'), s.registro && !s.registro.vigente ? `no figura desde ${s.registro.baja_desde}` : null].filter(Boolean).join(' · '),
      facts: { cuit: [s.cuit], nombre: [s.razon_social] },
    }));
  },
};
