// Descubrimiento automático: cada .js en src/modules (o src/searchers) que no empiece
// con "_" se importa; su export default (objeto o array de objetos con `id`) queda registrado.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function discover(dir, kind) {
  const found = new Map();
  const errors = [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort();
  for (const f of files) {
    try {
      const full = path.join(dir, f);
      // hash del código: si cambia el archivo, se invalida la caché de sus resultados
      const hash = createHash('sha1').update(fs.readFileSync(full)).digest('hex').slice(0, 10);
      const mod = await import(pathToFileURL(full).href);
      const items = [mod.default].flat().filter(Boolean);
      if (!items.length) errors.push({ file: f, error: 'no tiene export default' });
      for (const item of items) {
        if (!item.id) { errors.push({ file: f, error: `${kind} sin id` }); continue; }
        const fn = kind === 'módulo' ? item.run : item.search;
        if (typeof fn !== 'function') { errors.push({ file: f, error: `'${item.id}' no define ${kind === 'módulo' ? 'run' : 'search'}()` }); continue; }
        if (found.has(item.id)) { errors.push({ file: f, error: `id duplicado: '${item.id}'` }); continue; }
        found.set(item.id, { ...item, _file: f, _hash: hash });
      }
    } catch (e) {
      // un módulo roto no tira abajo al resto
      errors.push({ file: f, error: `${e.name}: ${e.message}`, trace: e.stack });
    }
  }
  return { items: found, errors };
}

export const discoverModules = (dir = path.join(SRC, 'modules')) => discover(dir, 'módulo');
export const discoverSearchers = (dir = path.join(SRC, 'searchers')) => discover(dir, 'buscador');
