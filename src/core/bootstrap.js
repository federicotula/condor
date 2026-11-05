import { ConfigStore } from './config.js';
import { Engine } from './engine.js';
import { LLM } from './llm.js';
import { discoverModules, discoverSearchers } from './registry.js';
import { makeStore } from './store.js';

export function settingsFromEnv() {
  return {
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL ?? 'llama3.2:3b',
    configPath: process.env.CONDOR_CONFIG ?? 'config/modules.json',
  };
}

export async function buildEngine(settings = settingsFromEnv(), logger = console) {
  const store = await makeStore(settings.redisUrl, logger);
  const llm = new LLM(settings.ollamaUrl, settings.ollamaModel);
  const mods = await discoverModules();
  const srch = await discoverSearchers();
  for (const e of [...mods.errors, ...srch.errors]) logger.warn(`[condor] ${e.file}: ${e.error}`);
  const engine = new Engine({
    store, llm, logger,
    config: new ConfigStore(settings.configPath),
    modules: mods.items,
    searchers: srch.items,
    loadErrors: [...mods.errors, ...srch.errors],
  });
  engine.close = () => store.close();
  return engine;
}
