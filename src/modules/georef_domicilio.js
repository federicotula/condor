// Normaliza y geolocaliza un domicilio con la API Georef (datos.gob.ar, pública).
// Doc: https://datosgobar.github.io/georef-ar-api/
import { splitDireccion } from '../core/ar.js';
import { normalize } from '../core/facts.js';
import { view as v } from '../core/view.js';

export default {
  id: 'georef_domicilio',
  name: 'Georef · Normalizar domicilio',
  requires: ['domicilio'],
  provides: ['domicilio_normalizado', 'localidad', 'provincia', 'coordenadas'],
  cacheTtl: 60 * 60 * 24 * 7,
  defaultSettings: { base_url: 'https://apis.datos.gob.ar/georef/api' },

  async run(ctx) {
    // Georef espera "calle altura"; la provincia (si viene) se usa como filtro.
    const p = splitDireccion(ctx.inputs.domicilio);
    const direccion = p ? `${p.calle} ${p.numero}` : String(ctx.inputs.domicilio).split(',')[0].trim();
    let provincia = p?.provincia || '';
    if (/^(caba|capital federal|c\.?a\.?b\.?a\.?|ciudad autonoma (de )?buenos aires)$/i.test(normalize('provincia', provincia))) {
      provincia = 'Ciudad Autónoma de Buenos Aires';
    }

    const query = async (params) => {
      const { ok, status, data } = await ctx.getJson(`${ctx.settings.base_url}/direcciones`, {
        params: { direccion, max: 1, ...params },
      });
      if (!ok) throw new Error(`Georef ${status}`);
      return data;
    };
    let data = provincia ? await query({ provincia }) : null;
    if (!data?.direcciones?.length) {
      if (provincia) ctx.log(`sin resultados con provincia="${provincia}", reintento sin filtro`);
      data = await query({});
    }
    // Último intento: sólo la palabra más significativa de la calle ("PERON, JUAN TTE.GRAL." -> "PERON").
    if (!data?.direcciones?.length && p) {
      const TIPOS = /^(avenida|avda|boulevard|bulevar|calle|pasaje|diagonal|camino|ruta|general|gral|presidente|doctor|ingeniero|teniente|coronel|santa|santo|san)$/;
      const palabra = normalize('domicilio', p.calle).split(' ').filter((w) => w.length > 3 && !/^\d+$/.test(w) && !TIPOS.test(w))
        .sort((a, b) => b.length - a.length)[0];
      if (palabra) {
        ctx.log(`reintento con "${palabra} ${p.numero}"`);
        const { ok, data: d2 } = await ctx.getJson(`${ctx.settings.base_url}/direcciones`, {
          params: { direccion: `${palabra} ${p.numero}`, max: 1, ...(provincia ? { provincia } : {}) },
        });
        if (ok && d2?.direcciones?.length) data = d2;
      }
    }
    const d = data?.direcciones?.[0];
    if (!d) return { summary: 'no se pudo normalizar', data };

    const loc = d.localidad_censal?.nombre || d.departamento?.nombre;
    const prov = d.provincia?.nombre;
    const { lat, lon } = d.ubicacion || {};
    const view = [
      v.kv([
        { label: 'Ingresado', value: ctx.inputs.domicilio },
        { label: 'Normalizado', value: d.nomenclatura },
        { label: 'Calle', value: d.calle?.nombre },
        { label: 'Altura', value: d.altura?.valor },
        { label: 'Localidad', value: loc },
        { label: 'Departamento', value: d.departamento?.nombre },
        { label: 'Provincia', value: prov },
      ]),
      lat != null && lon != null ? v.map({ lat, lon, label: d.nomenclatura, title: 'Ubicación' }) : null,
    ].filter(Boolean);
    return {
      view,
      facts: {
        domicilio_normalizado: d.nomenclatura ? [d.nomenclatura] : [],
        localidad: loc ? [loc] : [],
        provincia: prov ? [prov] : [],
        coordenadas: lat != null && lon != null ? [`${lat},${lon}`] : [],
      },
      data: d,
      summary: d.nomenclatura || 'normalizado',
    };
  },
};
