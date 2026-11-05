# Cóndor

Busca una persona a partir de un identificador (nombre, DNI, CUIT, email…) y dispara en paralelo un árbol
de **módulos** que consultan distintas fuentes. Lo que encuentra cada módulo (un domicilio, un email…)
puede disparar otros módulos, y así sucesivamente.

```
Persona (CUIT 20-…)
├─ ✔ BCRA · Central de Deudores
├─ ✔ Padrón ─────────────── domicilio=Av. Corrientes 1500
│  ├─ ✔ Georef domicilio
│  └─ ✔ Redes por email ──── domicilio=AV CORRIENTES 1500 | Florida 100
│     ├─ ≡ Georef (duplicado: mismo domicilio que arriba, no se repite)
│     └─ ✔ Georef domicilio=Florida 100
└─ ⊘ Teléfono (no se ejecuta: no se encontró teléfono)
```

## Levantar

```bash
cp .env.example .env
make up            # docker compose: app + redis + ollama (+ descarga del modelo)
open http://localhost:8000
```

CLI (dentro del contenedor):

```bash
make search q="20-12345678-6"
docker compose exec app condor search demo perez --pick 1 --details --json /tmp/out.json
docker compose exec app condor modules     # árbol configurado
docker compose exec app condor runs        # historial (guardado en Redis)
docker compose exec app condor show <id>
```

Sin Docker (Node ≥ 20): `npm install && node src/cli.js search demo perez` o `npm run dev` para la web.
Si no hay Redis disponible usa memoria (no persiste historial ni caché).

**Ollama en Mac:** dentro de Docker corre sin GPU y es lento. Si tenés Ollama instalado nativo, poné
`OLLAMA_URL=http://host.docker.internal:11434` en `.env`.

Probá `demo perez` para ver el árbol funcionando con datos ficticios (incluye un domicilio
duplicado y un error simulado).

## Cómo funciona

1. **Búsqueda**: el texto se clasifica (`cuit`, `dni`, `email`, `telefono`, `nombre`, o `tipo: valor`
   explícito) y se consulta a los **buscadores** (`src/searchers/`). Si hay varios candidatos, la web
   muestra un popup para elegir; la CLI pregunta.
2. **Ejecución**: la persona elegida es la raíz. Sus datos disparan los módulos de `roots`.
3. **Disparo de hijos**: cuando un módulo termina, se evalúan sus `triggers`. Un hijo corre si:
   - tiene disponibles en la rama todos sus `requires` (persona + ancestros), y
   - el padre aportó al menos uno de esos datos.
   Corre una vez por cada valor distinto (dos domicilios → dos ejecuciones).
4. **Deduplicación**: `módulo + datos de entrada normalizados` se ejecuta una sola vez por corrida, aunque lo
   disparen ramas distintas. `"Av. Corrientes 1500, CABA"` y `"AV CORRIENTES 1500 - caba"` son el mismo dato.
   Si un módulo necesita otra comparación, definí `dedupKey(inputs)`.
5. **Estados** en la web/CLI: esperando · en cola · ejecutando · ok · error · no se ejecuta (falta el dato) ·
   duplicado. Los módulos deshabilitados no aparecen.

Los ciclos (A dispara B que dispara A) están permitidos: se cortan solos por deduplicación y por `max_depth`.

## Escribir un módulo

Copiá `src/modules/_plantilla.js` a `src/modules/<nombre>.js`, completalo y reiniciá (`make restart`).
Aparece automáticamente en la web y en el JSON (deshabilitado).

```js
export default {
  id: 'mi_modulo',
  name: 'Mi módulo',
  requires: ['domicilio'],          // qué datos lo disparan
  provides: ['telefono'],           // informativo, la web lo usa para sugerir hijos (★)
  cacheTtl: 3600,                   // caché del resultado en Redis por (módulo + datos + settings)
  defaultSettings: { api_key: '' }, // se pisan desde la web o el JSON
  async run(ctx) {
    const { data } = await ctx.getJson('https://...', { params: { q: ctx.inputs.domicilio } });
    const extra = await ctx.llm.ask(`Extraé teléfonos de: ${JSON.stringify(data)}`, { json: true });
    ctx.log('listo');
    return { facts: { telefono: extra.telefonos }, data, summary: `${extra.telefonos.length} teléfonos` };
  },
};
```

### Cómo se muestra el resultado (`view`)

Cada módulo decide cómo explicar lo que encontró devolviendo `view`, una lista de bloques que la web
dibuja en el panel de detalle cuando hacés click en el nodo. Los helpers están en `src/core/view.js`:

```js
import { view as v } from '../core/view.js';

return {
  facts, data, summary,
  view: [
    v.stats([{ label: 'Peor situación', value: '3 · Riesgo medio', tone: 'warn' }, { label: 'Entidades', value: 4 }]),
    v.table(rows, { title: 'Deudas', columns: [{ key: 'entidad' }, { key: 'monto', label: 'Monto', format: 'money' }] }),
    v.chart({ kind: 'line', labels: ['ene', 'feb'], series: [{ name: 'Total', data: [10, 14] }] }),
    v.alert('Tiene un proceso judicial', 'bad'),
  ],
};
```

| bloque | para qué |
|---|---|
| `stats(items)` | números grandes con color (`tone`: ok, warn, bad, info) |
| `kv(obj \| items)` | ficha de clave → valor |
| `table(rows, {columns})` | tabla ordenable (click en encabezado), pagina a 25 filas |
| `list(items)` / `tags(items)` / `links(items)` | listas, etiquetas, links |
| `chart({kind: bar \| line \| pie, labels, series})` | gráficos (SVG, sin dependencias) |
| `timeline(items)` | eventos con fecha |
| `map({lat, lon})` | mapa OpenStreetMap |
| `alert(text, level)` / `text(text)` | avisos y texto |
| `image(src)` / `json(data)` / `section(title, blocks)` | imagen, JSON plegable, agrupar bloques |

Formatos de columna o valor: `number`, `money`, `percent`, `date`, `link`, `badge`. Una celda puede ser
`{ value, tone, href, hint }`. Si un módulo no devuelve `view`, la web arma una vista automática desde
`data` (los arrays de objetos se muestran como tabla y los objetos como ficha). La respuesta cruda
siempre queda disponible abajo.

Un archivo puede exportar un array de módulos. Si un módulo tira error, sólo ese nodo queda en error y
sus hijos quedan como "no se ejecuta".

| `ctx.` | |
|---|---|
| `inputs` | valores que dispararon esta ejecución (`{ domicilio: '...' }`) |
| `facts` | todo lo conocido en la rama, arrays por tipo |
| `person` | persona seleccionada |
| `settings` | `defaultSettings` + `settings` del JSON |
| `getJson(url, {params, headers, insecure})` | → `{ ok, status, data }` |
| `fetch(url, opts)` | `Response` crudo (HTML, scraping) |
| `llm.ask(prompt, {system, json})` | LLM local vía Ollama |
| `log(msg)` | se ve en el detalle del nodo |
| `signal` | `AbortSignal` del timeout del módulo |

Los buscadores (`src/searchers/`) son similares: `{ id, accepts: ['dni'], fallback?, async search(ctx) }`
y devuelven `[{ label, detail, facts }]`.

## Árbol de módulos (`config/modules.json`)

```json
{
  "settings":  { "max_concurrency": 8, "max_depth": 8, "default_timeout": 60, "max_combinations": 10 },
  "searchers": { "bcra_cuit": { "enabled": true, "settings": {} } },
  "roots":     ["bcra_deudores", "demo_padron"],
  "modules":   { "demo_padron": { "enabled": true, "triggers": ["georef_domicilio"], "settings": {}, "timeout": 30 } }
}
```

Se relee en cada corrida, así que los cambios a mano aplican sin reiniciar. Desde la pestaña **Módulos**
de la web se puede habilitar/deshabilitar, agregar/quitar hijos y editar settings; guarda en el mismo archivo.

## Módulos incluidos

| fuente | módulos | cómo | estado |
|---|---|---|---|
| **BCRA** Central de Deudores | `bcra_deudores`, `bcra_historico` (24 meses), `bcra_cheques_rechazados`, buscador `bcra_cuit` | API pública | habilitados, probados contra la API real |
| **ARCA** (ex AFIP) | `arca_padron`, `arca_constancia`, buscador `arca_dni` (DNI → CUIT) | web services oficiales con certificado | **deshabilitados** hasta configurar el certificado |
| **Registro Nacional de Sociedades** | `sociedades_cuit`, `sociedades_domicilio` (sociedades en el mismo domicilio), buscador `sociedades` | datos abiertos importados a SQLite local | habilitados; requieren importar |
| **Boletín Oficial** | `boletin_oficial` | buscador del sitio (endpoint no documentado) | habilitado |
| **Poder Judicial de la Nación + provincias** | `causas_judiciales`, `causas_provincia` | links de consulta manual (captcha / registro) | habilitados |
| **REFEPS** (profesionales de salud) | `profesionales_salud` | link de consulta manual (sin API pública) | habilitado |
| Georef | `georef_domicilio` | API pública | habilitado |
| Ollama | `llm_domicilio` | LLM local | habilitado |
| Demo | `demo_*`, buscador `demo` | ficticio, sólo para personas "demo" | habilitados |
| Redes | `instagram`, `facebook`, `email_lookup` | plantillas sin implementar | deshabilitados |

Si la API del BCRA falla por certificado SSL, poné `"insecure": true` en los settings de esos módulos.

### ARCA sin certificado: constancia pública con captcha (`arca_constancia_web`)

Usa la consulta pública de constancia de inscripción de ARCA. Cuando llega a ese módulo, Cóndor
trae el captcha y **te lo muestra para que lo resuelvas vos**: en la web se abre el panel del nodo
con la imagen ("tu respuesta" en el árbol); en la CLI se guarda la imagen (en Mac se abre sola)
y te pregunta el código en la terminal. Podés pedir otra imagen o saltear. Si el código es
incorrecto te pide otro (hasta 3 intentos). Tenés 5 minutos para responder.

El resultado queda en caché una semana por CUIT, para no pedirte el captcha de nuevo. Si salteás, no
se guarda en caché. Si ARCA devuelve un PDF, se guarda en `data/files/` y queda el link en el
panel.

El paso de enviar el código y leer la constancia no se pudo probar contra ARCA real (requiere resolver
un captcha). Si en la primera consulta los datos no salen bien, el texto completo queda en
"Texto de la constancia" y "Respuesta cruda" para ajustar el parseo.

Cualquier módulo puede pedir datos así: `const r = await ctx.ask({ title, text, image, fields: [{ name, label, help }], actions: ['refresh'] })`
devuelve `{ name: valor }`, `{ __action: 'refresh' }` o `null` (salteado).

### Historial y caché

En la pestaña Módulos están **Borrar historial** (todas las corridas guardadas, salvo las que estén
en curso) y **Borrar caché**. Por CLI: `condor runs-clear` y `condor cache-clear [modulo]`.

### ARCA: configurar el certificado

Los módulos de ARCA usan los web services oficiales, que requieren un certificado digital propio:

1. Generá clave y pedido de certificado: `make arca-csr cuit=20XXXXXXXXX nombre="Tu Nombre"`.
   Deja `secrets/arca.key` (no la compartas) y `secrets/arca.csr`.
2. En ARCA con clave fiscal, servicio "Administración de Certificados Digitales": agregá un alias
   (p.ej. `condor`), subí `secrets/arca.csr` y descargá el certificado como `secrets/arca.crt`.
3. En "Administrador de Relaciones de Clave Fiscal" → Nueva relación, autorizá ese alias para **cada**
   servicio: `ws_sr_padron_a13` y `ws_sr_constancia_inscripcion`.
4. En la web (pestaña Módulos), en `arca_padron` → settings: `{ "cuit_representada": "20XXXXXXXXX" }`
   y habilitalo. `arca_constancia` y el buscador `arca_dni` toman esos mismos settings; habilitalos
   si los querés. Para probar contra homologación: `"env": "homo"`.

Mientras falte algo, la web muestra en rojo qué falta junto al módulo (CUIT, clave, certificado,
vencimiento o clave que no coincide con el certificado).

Esto quedó probado contra un servidor SOAP simulado, no contra ARCA. Los endpoints, namespaces y
nombres de campos salen de documentación de terceros, porque el manual oficial no estuvo accesible.
Si algo no coincide, se ajusta en `src/lib/arca.js` (las URLs también se pueden cambiar por settings).

### Registro Nacional de Sociedades: importar

No tiene API de consulta: se descarga el dataset de datos abiertos y se indexa localmente en `./data/`.

```bash
make import-sociedades a="2026"                 # o: 2019..2026, asociaciones, muestra, una URL o un .zip
docker compose exec app condor import-sociedades 2025 2026 asociaciones
```

Se puede importar varios años; si una CUIT aparece en varios, queda la versión más actualizada. El
dataset no trae socios ni autoridades, sólo datos de la sociedad. Por eso sirve para resolver CUIT de
empresas y para encontrar sociedades registradas en un domicilio de la persona.

### Boletín Oficial

Busca avisos de los últimos 5 años en la 1ª sección (designaciones, resoluciones) y en la 2ª
(sociedades, edictos, concursos y quiebras). El buscador del Boletín encuentra avisos que tienen todas
las palabras aunque no estén juntas, así que marca como "exacta" la coincidencia cuando el nombre
aparece junto en el extracto. Por ahora trae la primera página de resultados (~70 avisos) y muestra
el total. Settings: `anios`, `secciones`, `solo_frase_exacta`.

## Cuidado con los datos

Esto junta datos personales. Tené en cuenta la Ley 25.326 de Protección de Datos Personales y los términos
de uso de cada plataforma antes de implementar módulos de redes o scraping. El historial queda en Redis
(30 días por defecto).

## Tests

```bash
npm test
```
