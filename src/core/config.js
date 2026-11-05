// Árbol de módulos persistido en JSON (config/modules.json).
//
// {
//   "settings":  { "max_concurrency": 8, "max_depth": 8, "default_timeout": 60, "max_combinations": 10 },
//   "searchers": { "<id>": { "enabled": true, "settings": {} } },
//   "roots":     ["<module_id>", ...],     // se disparan con la persona seleccionada
//   "modules":   { "<id>": { "enabled": true, "triggers": ["<module_id>"], "settings": {}, "timeout": 30 } }
// }
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = { max_concurrency: 8, max_depth: 8, default_timeout: 60, max_combinations: 10 };

export class ConfigError extends Error {}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const uniq = (arr) => [...new Set((arr || []).map(String))];

function moduleEntry(d) {
  d = isObj(d) ? d : {};
  const out = { enabled: !!d.enabled, triggers: uniq(d.triggers), settings: isObj(d.settings) ? d.settings : {} };
  if (d.timeout !== undefined && d.timeout !== null && d.timeout !== '') out.timeout = Number(d.timeout);
  return out;
}

export function normalizeConfig(data) {
  data = structuredClone(data || {});
  return {
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    searchers: Object.fromEntries(Object.entries(data.searchers || {}).map(([k, v]) => [k, {
      enabled: !!v?.enabled, settings: isObj(v?.settings) ? v.settings : {},
    }])),
    roots: uniq(data.roots),
    modules: Object.fromEntries(Object.entries(data.modules || {}).map(([k, v]) => [k, moduleEntry(v)])),
  };
}

export function validateConfig(data) {
  if (!isObj(data)) throw new ConfigError('La configuración debe ser un objeto JSON');
  for (const [key, check, name] of [['settings', isObj, 'objeto'], ['searchers', isObj, 'objeto'],
    ['roots', Array.isArray, 'lista'], ['modules', isObj, 'objeto']]) {
    if (key in data && !check(data[key])) throw new ConfigError(`'${key}' debe ser ${name}`);
  }
  for (const [mid, m] of Object.entries(data.modules || {})) {
    if (!isObj(m)) throw new ConfigError(`modules.${mid} debe ser un objeto`);
    if ('triggers' in m && !Array.isArray(m.triggers)) throw new ConfigError(`modules.${mid}.triggers debe ser una lista`);
    if ('settings' in m && !isObj(m.settings)) throw new ConfigError(`modules.${mid}.settings debe ser un objeto`);
  }
  return data;
}

export function configWarnings(cfg, moduleIds) {
  const known = new Set(moduleIds);
  const out = cfg.roots.filter((r) => !known.has(r)).map((r) => `raíz '${r}' no existe como módulo`);
  for (const [mid, m] of Object.entries(cfg.modules)) {
    if (!known.has(mid)) out.push(`'${mid}' está en el JSON pero no hay código para ese módulo`);
    for (const t of m.triggers) if (!known.has(t)) out.push(`'${mid}' dispara '${t}', que no existe`);
  }
  return out;
}

export class ConfigStore {
  constructor(file) { this.file = path.resolve(file); }

  // Se relee en cada corrida: los cambios a mano en el JSON aplican sin reiniciar.
  load() {
    if (!fs.existsSync(this.file)) return normalizeConfig({});
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { throw new ConfigError(`${this.file}: JSON inválido (${e.message})`); }
    return normalizeConfig(validateConfig(data));
  }

  save(data) {
    const cfg = normalizeConfig(validateConfig(data));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = path.join(path.dirname(this.file), `.modules.${process.pid}.${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    fs.renameSync(tmp, this.file); // escritura atómica
    return cfg;
  }

  // Agrega (deshabilitados) los módulos/buscadores nuevos que no estén en el JSON.
  sync(moduleIds, searcherIds) {
    const cfg = this.load();
    let changed = false;
    for (const id of moduleIds) if (!cfg.modules[id]) { cfg.modules[id] = moduleEntry({}); changed = true; }
    for (const id of searcherIds) if (!cfg.searchers[id]) { cfg.searchers[id] = { enabled: false, settings: {} }; changed = true; }
    if (changed || !fs.existsSync(this.file)) this.save(cfg);
    return changed;
  }
}
