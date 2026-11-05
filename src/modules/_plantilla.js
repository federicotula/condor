// Plantilla: copiá este archivo a src/modules/<nombre>.js (sin el "_" adelante) y completalo.
// Al reiniciar aparece en la web (deshabilitado) y en config/modules.json.
//
// ctx.inputs     -> valores que dispararon esta ejecución, p.ej. { domicilio: '...' }
// ctx.facts      -> todo lo conocido en esta rama (persona + ancestros), arrays por tipo
// ctx.person     -> persona seleccionada { label, facts, ... }
// ctx.settings   -> defaultSettings + "settings" del JSON (editable desde la web)
// ctx.getJson(url, { params, headers, insecure }) -> { ok, status, data }
// ctx.fetch(url, opts)                              -> Response (para HTML/scraping)
// ctx.llm.ask(prompt, { system, json: true })       -> LLM local (Ollama)
// ctx.log('mensaje')                                -> se ve en el detalle del nodo
// ctx.signal                                        -> AbortSignal (timeout del módulo)
//
// Devolvé { facts, data, view, summary }:
//   facts   -> cada tipo puede disparar otros módulos
//   data    -> respuesta cruda (se ve en "Respuesta cruda")
//   view    -> cómo mostrarlo en la web (bloques de src/core/view.js). Si no lo ponés,
//              la web arma una vista automática a partir de `data`.
//   summary -> una línea para el árbol
import { view as v } from '../core/view.js';

export default {
  id: 'mi_modulo',
  name: 'Mi módulo',
  description: '',
  requires: ['domicilio'],
  provides: ['telefono'],
  cacheTtl: 0,
  // timeout: 60,
  defaultSettings: {},
  // dedupKey: (inputs) => ...,   // opcional: otra noción de "mismo dato"

  async run(ctx) {
    const { data } = await ctx.getJson('https://example.com/api', { params: { q: ctx.inputs.domicilio } });
    const telefonos = data?.telefonos ?? [];
    return {
      facts: { telefono: telefonos },
      data,
      summary: `${telefonos.length} teléfonos`,
      view: [
        v.stats([{ label: 'Teléfonos', value: telefonos.length }]),
        v.list(telefonos, { title: 'Encontrados' }),
        // v.table(rows, { columns: [{ key: 'x', label: 'X', format: 'money' }] }),
        // v.chart({ kind: 'bar', labels: [...], series: [{ name: 'Serie', data: [...] }] }),
        // v.kv({ clave: 'valor' }), v.map({ lat, lon }), v.timeline([...]), v.tags([...]), v.alert('...', 'warn')
      ],
    };
  },
};
