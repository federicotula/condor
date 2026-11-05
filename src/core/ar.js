// Helpers específicos de Argentina (CUIT/CUIL).
const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
const digits = (v) => String(v ?? '').replace(/\D/g, '');

// Dígito verificador (0-9) o 10 si la combinación no es válida.
export function cuitCheckDigit(first10) {
  const total = [...first10].reduce((acc, d, i) => acc + Number(d) * WEIGHTS[i], 0);
  const r = 11 - (total % 11);
  return r === 11 ? 0 : r;
}

export function isValidCuit(v) {
  const c = digits(v);
  return c.length === 11 && cuitCheckDigit(c.slice(0, 10)) === Number(c[10]);
}

export function formatCuit(v) {
  const c = digits(v);
  return c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : v;
}

export function dniFromCuit(v) {
  const c = digits(v);
  return c.length === 11 ? c.slice(2, 10).replace(/^0+/, '') : null;
}

// Separa un domicilio argentino en calle, altura y el resto (localidad, provincia).
// Tolera comas dentro del nombre de la calle ("PERON, JUAN TTE.GRAL. 430, piso 6, CABA")
// y calles con números ("25 de Mayo 100", "Calle 7 1234"): la altura es el número que
// viene seguido de coma, fin de texto, guion o piso/dto.
export function splitDireccion(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const re = /(\d{1,6})(?=\s*(?:,|$| - |\bpiso\b|\bp\.|\bdto\b|\bdpto\b|\bdepto\b|\bdep\b))/gi;
  const m = re.exec(s);
  if (!m) return null;
  const calle = s.slice(0, m.index).replace(/[,\s]+$/, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!calle) return null;
  const resto = s.slice(m.index + m[0].length).split(/,| - /).map((x) => x.trim())
    .filter((x) => x && !/^(piso|p\.|dto|dpto|depto|dep)\b/i.test(x));
  return {
    calle, numero: Number(m[1]),
    localidad: resto.length > 1 ? resto.at(-2) : null,
    provincia: resto.length ? resto.at(-1) : null,
  };
}

// CUIT/CUIL posibles para un DNI (prefijos 20, 27, 23, 24).
export function cuitsFromDni(dni) {
  const d = digits(dni).padStart(8, '0');
  if (d.length !== 8) return [];
  const out = [];
  for (const prefix of ['20', '27', '23', '24']) {
    const dv = cuitCheckDigit(prefix + d);
    if (dv === 10) {
      // Regla AFIP: si da 10, prefijo 23 con DV 9 (masc.) o 4 (fem.)
      if (prefix === '20' || prefix === '27') {
        const alt = `23${d}${prefix === '20' ? '9' : '4'}`;
        if (isValidCuit(alt)) out.push(alt);
      }
      continue;
    }
    out.push(prefix + d + dv);
  }
  return [...new Set(out)];
}
