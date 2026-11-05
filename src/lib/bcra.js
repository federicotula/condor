// Cliente para la API pública de Central de Deudores del BCRA.
// Doc: https://www.bcra.gob.ar/BCRAyVos/catalogo-de-APIs-banco-central.asp
// OJO: la forma exacta de las respuestas está escrita según la documentación pública y
// no fue verificada contra la API real al armar este proyecto. Revisá `data` en la web.
import { httpGetJson } from '../core/module.js';

export const BCRA_DEFAULTS = {
  base_url: 'https://api.bcra.gob.ar/CentralDeDeudores/v1.0',
  // Si falla con error de certificado, poné "insecure": true en settings del módulo.
  insecure: false,
};

export async function bcraGet(path, { settings = {}, signal } = {}) {
  const s = { ...BCRA_DEFAULTS, ...settings };
  const { status, data } = await httpGetJson(`${s.base_url}${path}`, { insecure: !!s.insecure, signal });
  if (status === 404) return null; // sin registros para esa identificación
  if (status >= 400) {
    const msg = data?.errorMessages?.join?.('; ') || JSON.stringify(data)?.slice(0, 200);
    throw new Error(`BCRA ${status}: ${msg}`);
  }
  return data?.results ?? data;
}
