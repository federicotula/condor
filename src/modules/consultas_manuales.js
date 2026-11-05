// C, D y G: fuentes sin API pública (piden captcha, registro o sólo tienen buscador web).
// Cóndor no las automatiza: estos módulos arman la lista de links de consulta para la
// persona, con los datos a cargar, para revisarlos a mano.
//
// URLs tomadas del directorio oficial de Justicia.ar:
//   https://justicia.ar/herramientas/consulta-publica-de-causas
import { normalize } from '../core/facts.js';
import { view as v } from '../core/view.js';

const DIRECTORIO = 'https://justicia.ar/herramientas/consulta-publica-de-causas';

const PJN = { nombre: 'Poder Judicial de la Nación (incluye CSJN)', url: 'https://scw.pjn.gov.ar/scw/home.seam',
  nota: 'Consulta por parte (nombre y apellido). Causas penales y de familia tienen acceso restringido.' };

// clave normalizada de provincia -> sistema de consulta
const PROVINCIAS = {
  'buenos aires': { nombre: 'Buenos Aires (MEV)', url: 'https://mev.scba.gov.ar/registro.asp', nota: 'puede requerir registro' },
  'ciudad autonoma de buenos aires': { nombre: 'Ciudad Autónoma de Buenos Aires', url: 'https://eje.juscaba.gob.ar/iol-ui/p/inicio' },
  catamarca: { nombre: 'Catamarca', url: 'https://pcj.juscatamarca.gob.ar/iol-ui/p/inicio' },
  chaco: { nombre: 'Chaco', url: 'https://consultatramites.chaco.gob.ar/instrumentos-legales' },
  chubut: { nombre: 'Chubut', url: 'https://serconex.juschubut.gov.ar/' },
  cordoba: { nombre: 'Córdoba', url: 'https://www.justiciacordoba.gob.ar/justiciacordoba/servicios/ConsultaJuicios.aspx' },
  corrientes: { nombre: 'Corrientes', url: 'https://forumna.juscorrientes.gov.ar/com.forumna.login', nota: 'puede requerir login' },
  'entre rios': { nombre: 'Entre Ríos', url: 'https://mesavirtualpublica.jusentrerios.gov.ar/expedientes' },
  formosa: { nombre: 'Formosa', url: 'https://ejusticia.jusformosa.gob.ar/' },
  jujuy: { nombre: 'Jujuy', url: 'https://sigj.justiciajujuy.gov.ar/mentradas/index.php/consulta_web/index' },
  'la pampa': { nombre: 'La Pampa', url: 'https://civil.justicialapampa.gob.ar/Autenticacion.aspx?ReturnUrl=%2f', nota: 'puede requerir login' },
  'la rioja': { nombre: 'La Rioja', url: 'https://jusjoaquin.gob.ar/requerimientos' },
  mendoza: { nombre: 'Mendoza', url: 'https://iol.jus.mendoza.gov.ar/iol-ui/p/inicio' },
  misiones: { nombre: 'Misiones', url: 'https://www.jusmisiones.gov.ar/consultas_online/forms/expedientes/listado.php' },
  'rio negro': { nombre: 'Río Negro', url: 'https://puma.jusrionegro.gov.ar/expjud/busqueda-publica' },
  salta: { nombre: 'Salta', url: 'https://plataforma.justiciasalta.gov.ar/iol-ui/p/inicio' },
  'san juan': { nombre: 'San Juan', url: DIRECTORIO, nota: 'ver link en el directorio de Justicia.ar' },
  'san luis': { nombre: 'San Luis', url: 'https://publico.justiciasanluis.gov.ar/' },
  'santa cruz': { nombre: 'Santa Cruz', url: 'https://intranet.jussantacruz.gob.ar/consulta_publica/' },
  'santa fe': { nombre: 'Santa Fe', url: 'https://sisfe.justiciasantafe.gov.ar/login-otros', nota: 'puede requerir login' },
  'santiago del estero': { nombre: 'Santiago del Estero', url: 'https://oficinavirtual.jussantiago.gov.ar/src/expedientes/anonimo.php?ver=123456&juris=C' },
  tucuman: { nombre: 'Tucumán', url: 'https://consultaexpedientes.justucuman.gov.ar/' },
  'tierra del fuego': { nombre: 'Tierra del Fuego', url: 'https://kayen.justierradelfuego.gov.ar/' },
  neuquen: { nombre: 'Neuquén', url: DIRECTORIO, nota: 'no figura en el directorio de Justicia.ar' },
};

function provinciaKey(texto) {
  const n = normalize('provincia', texto).replace(/^provincia de /, '');
  if (/capital federal|^caba$|ciudad (autonoma )?de buenos aires/.test(n)) return 'ciudad autonoma de buenos aires';
  if (n.startsWith('tierra del fuego')) return 'tierra del fuego';
  return Object.keys(PROVINCIAS).find((k) => n === k) ?? null;
}

const datosACargar = (ctx) => [ctx.first('nombre'), ctx.first('dni') && `DNI ${ctx.first('dni')}`, ctx.first('cuit') && `CUIT ${ctx.first('cuit')}`]
  .filter(Boolean).join(' · ');

export default [
  {
    id: 'causas_judiciales',
    name: 'Causas judiciales · Nación (consulta manual)',
    description: 'Links de consulta de expedientes del PJN y directorio de poderes judiciales provinciales. No automatizado.',
    requires: ['nombre'],
    provides: [],

    async run(ctx) {
      return {
        summary: 'links para consulta manual (PJN + provincias)',
        view: [
          v.alert('Estos sistemas no tienen API pública (usan captcha o registro), así que la consulta es manual. No encontrar una causa no significa que no exista.', 'info'),
          v.kv([{ label: 'Datos para buscar', value: datosACargar(ctx) }]),
          v.list([{ text: PJN.nombre, href: PJN.url, sub: PJN.nota, tag: 'nacional', tone: 'info' }], { title: 'Justicia nacional' }),
          v.table(Object.values(PROVINCIAS).map((p) => ({ jurisdiccion: { value: p.nombre, href: p.url }, nota: p.nota || '' })),
            { title: 'Justicia provincial', columns: [{ key: 'jurisdiccion', label: 'Jurisdicción' }, { key: 'nota' }] }),
          v.links([{ label: 'Directorio oficial de consulta pública de causas (Justicia.ar)', href: DIRECTORIO }]),
        ],
      };
    },
  },
  {
    id: 'causas_provincia',
    name: 'Causas judiciales · Provincia del domicilio (consulta manual)',
    description: 'Link al sistema de consulta de causas de la provincia donde se encontró un domicilio. No automatizado.',
    requires: ['provincia'],
    provides: [],

    async run(ctx) {
      const key = provinciaKey(ctx.inputs.provincia);
      const p = key && PROVINCIAS[key];
      if (!p) return { summary: `sin sistema conocido para ${ctx.inputs.provincia}`, view: [v.links([{ label: 'Directorio de Justicia.ar', href: DIRECTORIO }])] };
      return {
        summary: `${p.nombre}: link de consulta`,
        view: [
          v.alert(`Se encontró un domicilio en ${ctx.inputs.provincia}. Consultá las causas de esa jurisdicción a mano.`, 'info'),
          v.kv([{ label: 'Datos para buscar', value: datosACargar(ctx) }, { label: 'Nota', value: p.nota }].filter((x) => x.value)),
          v.links([{ label: `Consulta de causas · ${p.nombre}`, href: p.url }, { label: 'Directorio de Justicia.ar', href: DIRECTORIO }]),
        ],
      };
    },
  },
  {
    id: 'profesionales_salud',
    name: 'Profesionales de la salud · REFEPS (consulta manual)',
    description: 'Verificación de matrícula en la Red Federal de Registros de Profesionales de la Salud (SISA). No automatizado.',
    requires: ['dni'],
    provides: [],

    async run(ctx) {
      return {
        summary: 'link para verificar matrícula en REFEPS',
        view: [
          v.alert('REFEPS no tiene API pública documentada. Se consulta en SISA → "Buscador de establecimientos y profesionales" → solapa REFEPS, por DNI o matrícula.', 'info'),
          v.kv([{ label: 'DNI', value: ctx.inputs.dni }, { label: 'Nombre', value: ctx.first('nombre') }].filter((x) => x.value)),
          v.links([
            { label: 'SISA (Sistema Integrado de Información Sanitaria)', href: 'https://sisa.msal.gov.ar/' },
            { label: 'Instructivo oficial para la búsqueda de profesionales (PDF)', href: 'https://www.argentina.gob.ar/sites/default/files/2024/06/2024-06_instructivo_busqueda_profesionales_2182024.pdf' },
          ]),
          v.text('Otros colegios profesionales (abogados, escribanos, contadores, ingenieros) tienen padrones propios según la jurisdicción.'),
        ],
      };
    },
  },
];
