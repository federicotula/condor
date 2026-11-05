// F. Boletín Oficial de la República Argentina: búsqueda de avisos que mencionan un nombre.
// Usa el endpoint de búsqueda avanzada del sitio (no es una API documentada; si cambia el
// HTML hay que ajustar parseAvisos). Secciones: 1 = legislación y avisos oficiales
// (designaciones, resoluciones), 2 = sociedades y avisos judiciales (edictos, constituciones,
// concursos y quiebras), 3 = contrataciones.
import { normalize } from '../core/facts.js';
import { view as v } from '../core/view.js';

const BASE = 'https://www.boletinoficial.gob.ar';
const SECCIONES = { 1: 'primera', 2: 'segunda', 3: 'tercera' };
const NOMBRE_SECCION = { primera: '1ª · Legislación y avisos oficiales', segunda: '2ª · Sociedades y avisos judiciales', tercera: '3ª · Contrataciones' };

const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const strip = (html) => html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();

// Extrae avisos del HTML de resultados, siguiendo sección (h2) y rubro (h5).
export function parseAvisos(html) {
  const out = [];
  const re = /<small>(Primera|Segunda|Tercera) secci[oó]n<\/small>|<h5 class="seccion-rubro[^"]*">([\s\S]*?)<\/h5>|<a href="(\/detalleAviso\/(\w+)\/(\d+)\/(\d{8})[^"]*)"[\s\S]*?<div class="linea-aviso">([\s\S]*?)<\/div>\s*<\/a>/gi;
  let rubro = '';
  for (const m of html.matchAll(re)) {
    if (m[2] !== undefined) { rubro = strip(m[2]); continue; }
    if (!m[3]) continue;
    const ps = [...m[7].matchAll(/<p class="item(?:-detalle)?"[^>]*>([\s\S]*?)<\/p>/g)].map((x) => strip(x[1]));
    const [titulo, ...detalles] = ps;
    const fecha = m[6];
    out.push({
      seccion: m[4], id: m[5], fecha: `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6)}`, rubro, titulo,
      norma: detalles.find((d) => !/^Fecha de Publicaci/.test(d) && d.length < 80) || '',
      extracto: detalles.filter((d) => !/^Fecha de Publicaci/.test(d)).slice(-1)[0] || '',
      url: `${BASE}${m[3].replace(/\?busqueda=1$/, '')}`,
    });
  }
  return out;
}

async function buscar(ctx, texto, desde, hasta, secciones, pagina, prev) {
  const params = {
    busquedaRubro: false, hayMasResultadosBusqueda: true, ejecutandoLlamadaAsincronicaBusqueda: false,
    ultimaSeccion: prev?.ult_seccion ?? '', filtroPorRubrosSeccion: false, filtroPorRubroBusqueda: false,
    filtroPorSeccionBusqueda: false, busquedaOriginal: pagina === 1, ordenamientoSegunda: false,
    seccionesOriginales: secciones, ultimoItemExterno: null, ultimoItemInterno: null, texto, rubros: [],
    nroNorma: '', anioNorma: '', denominacion: '', tipoContratacion: '', anioContratacion: '', nroContratacion: '',
    fechaDesde: ddmmyyyy(desde), fechaHasta: ddmmyyyy(hasta), todasLasPalabras: true, comienzaDenominacion: true,
    seccion: secciones, tipoBusqueda: 'Avanzada', numeroPagina: pagina, ultimoRubro: prev?.ult_rubro ?? '',
  };
  const resp = await ctx.fetch(`${BASE}/busquedaAvanzada/realizarBusqueda`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
    body: new URLSearchParams({ params: JSON.stringify(params), array_volver: '[]' }).toString(),
  });
  if (!resp.ok) throw new Error(`Boletín Oficial HTTP ${resp.status}`);
  const j = await resp.json();
  if (j.error) throw new Error(`Boletín Oficial: error ${j.error}`);
  return j.content || {};
}

export default {
  id: 'boletin_oficial',
  name: 'Boletín Oficial · Menciones',
  description: 'Avisos del Boletín Oficial que mencionan el nombre (designaciones, sociedades, edictos, quiebras)',
  requires: ['nombre'],
  provides: [],
  cacheTtl: 60 * 60 * 24,
  timeout: 90,
  defaultSettings: { anios: 5, secciones: [1, 2], max_paginas: 1, solo_frase_exacta: true },

  async run(ctx) {
    const nombre = String(ctx.inputs.nombre).trim();
    if (nombre.split(/\s+/).length < 2) {
      return { summary: 'nombre muy corto para buscar', view: [v.alert('Se necesita al menos nombre y apellido para buscar en el Boletín Oficial.', 'warn')] };
    }
    const hasta = new Date();
    const desde = new Date(hasta);
    desde.setFullYear(hasta.getFullYear() - Number(ctx.settings.anios || 5));
    const secciones = ctx.settings.secciones;

    let avisos = [];
    let prev = null;
    let totales = {};
    for (let pagina = 1; pagina <= Number(ctx.settings.max_paginas || 1); pagina++) {
      const c = await buscar(ctx, nombre, desde, hasta, secciones, pagina, prev);
      if (pagina === 1) totales = c.cantidad_result_seccion || {};
      const nuevos = parseAvisos(c.html || '');
      avisos.push(...nuevos);
      ctx.log(`página ${pagina}: ${nuevos.length} avisos`);
      if (!nuevos.length || !c.sig_pag) break;
      prev = c;
    }
    const encontrados = avisos.length;

    // "todas las palabras" del BO también trae avisos donde las palabras aparecen separadas.
    // Si solo_frase_exacta, se marcan los que muestran el nombre junto en el extracto.
    const frase = normalize('nombre', nombre);
    const palabras = frase.split(' ');
    const aparece = (a) => {
      const t = normalize('nombre', `${a.titulo} ${a.extracto}`);
      return t.includes(frase) || t.includes([...palabras].reverse().join(' '));
    };
    avisos = avisos.map((a) => ({ ...a, exacto: aparece(a) }));
    if (ctx.settings.solo_frase_exacta) avisos.sort((a, b) => b.exacto - a.exacto);
    const exactos = avisos.filter((a) => a.exacto).length;

    const porAnio = {};
    for (const a of avisos) porAnio[a.fecha.slice(0, 4)] = (porAnio[a.fecha.slice(0, 4)] || 0) + 1;
    const anios = Object.keys(porAnio).sort();
    const porRubro = {};
    for (const a of avisos) porRubro[a.rubro || 'otros'] = (porRubro[a.rubro || 'otros'] || 0) + 1;
    const totalBO = Object.values(totales).reduce((x, y) => x + Number(y), 0);

    return {
      data: { busqueda: { nombre, desde: ddmmyyyy(desde), hasta: ddmmyyyy(hasta), secciones }, totales, avisos },
      summary: encontrados ? `${totalBO || encontrados} avisos (${exactos} con el nombre exacto en el extracto)` : 'sin menciones',
      view: encontrados ? [
        v.stats([
          { label: 'Avisos encontrados', value: totalBO || encontrados, hint: totalBO > encontrados ? `se muestran ${encontrados}` : undefined },
          { label: 'Con el nombre exacto', value: exactos, tone: exactos ? 'info' : 'muted', hint: 'en título o extracto' },
          ...Object.entries(totales).map(([s, n]) => ({ label: NOMBRE_SECCION[SECCIONES[s]] || `Sección ${s}`, value: Number(n) })),
        ]),
        v.alert('El buscador del Boletín encuentra avisos con todas las palabras, aunque no estén juntas. Revisá los marcados como "posible" antes de sacar conclusiones; un nombre común puede ser otra persona.', 'warn'),
        anios.length > 1 ? v.chart({ kind: 'bar', title: 'Avisos por año', labels: anios, series: [{ name: 'Avisos', data: anios.map((y) => porAnio[y]) }] }) : null,
        v.table(avisos.map((a) => ({
          fecha: a.fecha,
          seccion: NOMBRE_SECCION[a.seccion]?.split(' · ')[0] || a.seccion,
          rubro: a.rubro,
          titulo: { value: a.titulo, href: a.url },
          extracto: a.extracto,
          coincidencia: { value: a.exacto ? 'exacta' : 'posible', tone: a.exacto ? 'ok' : 'muted' },
        })), {
          title: 'Avisos',
          columns: [{ key: 'fecha', format: 'date' }, { key: 'seccion', label: 'Secc.' }, { key: 'rubro' }, { key: 'titulo', label: 'Aviso' },
            { key: 'extracto' }, { key: 'coincidencia' }],
        }),
        Object.keys(porRubro).length > 1 ? v.chart({ kind: 'pie', title: 'Por rubro', labels: Object.keys(porRubro), series: [{ data: Object.values(porRubro) }] }) : null,
      ].filter(Boolean) : [v.alert(`Sin avisos que mencionen "${nombre}" entre ${ddmmyyyy(desde)} y ${ddmmyyyy(hasta)}.`, 'ok')],
    };
  },
};
