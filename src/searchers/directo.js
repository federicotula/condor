// Fallback: si ningún buscador encontró nada, ofrece el identificador tal cual
// para poder correr igual los módulos que lo usen.
import { dniFromCuit, formatCuit, isValidCuit } from '../core/ar.js';

export default {
  id: 'directo',
  name: 'Identificador directo',
  description: 'Usa el dato ingresado sin resolver la persona (sólo si nadie más encontró nada)',
  accepts: ['cuit', 'dni', 'nombre', 'email', 'telefono', 'domicilio'],
  fallback: true,

  async search(ctx) {
    const facts = structuredClone(ctx.detected);
    const [kind, [value]] = Object.entries(facts)[0];
    if (kind === 'cuit') {
      if (!isValidCuit(value)) ctx.log(`CUIT ${value} con dígito verificador inválido`);
      facts.dni = [dniFromCuit(value)];
    }
    return [{
      label: kind === 'cuit' ? `CUIT ${formatCuit(value)}` : `${kind}: ${value}`,
      detail: 'sin datos de identidad confirmados',
      facts,
    }];
  },
};
