// Datos ("facts") que circulan entre módulos: tipo -> lista de valores.
//   { cuit: ['20123456786'], domicilio: ['Av. Corrientes 1500, CABA'] }
// Los tipos son strings libres; KNOWN es sólo para etiquetas en la UI.
// normalize() define cuándo dos valores son "el mismo dato" (deduplicación).

export const KNOWN = {
  cuit: 'CUIT/CUIL',
  dni: 'DNI',
  nombre: 'Nombre',
  domicilio: 'Domicilio',
  domicilio_normalizado: 'Domicilio normalizado',
  localidad: 'Localidad',
  provincia: 'Provincia',
  coordenadas: 'Coordenadas',
  email: 'Email',
  telefono: 'Teléfono',
  usuario_instagram: 'Usuario Instagram',
  usuario_facebook: 'Usuario Facebook',
  bcra_situacion: 'Situación BCRA',
  entidad_financiera: 'Entidad financiera',
};

const DIGITS_ONLY = new Set(['cuit', 'dni', 'telefono']);
const LOWER_ONLY = new Set(['email', 'usuario_instagram', 'usuario_facebook']);

export function normalize(kind, value) {
  let s = typeof value === 'string' ? value : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  s = s.trim();
  if (DIGITS_ONLY.has(kind)) return s.replace(/\D/g, '');
  if (LOWER_ONLY.has(kind)) return s.toLowerCase().replace(/^@/, '');
  return s
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const asList = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : v instanceof Set ? [...v] : [v]);

export function dedupe(kind, values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) continue;
    const n = normalize(kind, v);
    if (n && !seen.has(n)) { seen.add(n); out.push(v); }
  }
  return out;
}

export function clean(facts) {
  const out = {};
  for (const [k, v] of Object.entries(facts || {})) {
    const vals = dedupe(k, asList(v));
    if (vals.length) out[k] = vals;
  }
  return out;
}

export function merge(...many) {
  const out = {};
  for (const f of many) {
    for (const [k, v] of Object.entries(f || {})) out[k] = dedupe(k, [...(out[k] || []), ...asList(v)]);
  }
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return out;
}

// Infiere el tipo de identificador. Acepta prefijo explícito: "domicilio: Florida 100".
export function detect(query) {
  const q = (query || '').trim();
  const pref = q.match(/^([a-z_]+)\s*:\s*(.+)$/i);
  if (pref) return { [pref[1].toLowerCase()]: [pref[2].trim()] };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q)) return { email: [q.toLowerCase()] };
  if (/^[\d.\-\s]+$/.test(q)) {
    const d = q.replace(/\D/g, '');
    if (d.length === 11) return { cuit: [d] };
    if (d.length >= 6 && d.length <= 8) return { dni: [d] };
    if (d.length >= 9) return { telefono: [d] };
  }
  return q ? { nombre: [q] } : {};
}
