// Ejemplo de módulo que usa el LLM local (Ollama): separa un domicilio en partes.
import { view as v } from '../core/view.js';

export default {
  id: 'llm_domicilio',
  name: 'LLM · Desarmar domicilio',
  requires: ['domicilio'],
  provides: ['localidad', 'provincia'],
  cacheTtl: 60 * 60 * 24 * 30,
  timeout: 180,

  async run(ctx) {
    const parts = await ctx.llm.ask(
      `Domicilio: "${ctx.inputs.domicilio}"\n` +
      'Devolvé JSON con las claves calle, altura, piso, depto, localidad, provincia, codigo_postal. ' +
      'Usá null si no está. No inventes datos.',
      { system: 'Sos un parser de domicilios argentinos. Respondés sólo JSON.', json: true, signal: ctx.signal },
    );
    return {
      facts: { localidad: parts.localidad ? [parts.localidad] : [], provincia: parts.provincia ? [parts.provincia] : [] },
      data: parts,
      view: [v.kv(parts, { title: 'Partes detectadas por el LLM' }), v.text(`Modelo: ${ctx.llm.model}`)],
      summary: [parts.calle, parts.altura, parts.localidad, parts.provincia].filter(Boolean).join(' · ') || 'sin partes',
    };
  },
};
