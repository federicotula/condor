import { randomUUID } from 'node:crypto';

export const Status = Object.freeze({
  WAITING: 'waiting',     // esperando que termine el módulo padre
  PENDING: 'pending',     // en cola (esperando un slot de concurrencia)
  RUNNING: 'running',
  INPUT: 'input',         // pausado, esperando que el usuario responda (ctx.ask)
  DONE: 'done',
  ERROR: 'error',
  SKIPPED: 'skipped',     // no se ejecuta: falta el dato que lo dispara
  DUPLICATE: 'duplicate', // ya se ejecutó con los mismos datos en otra rama
});

export const newId = () => randomUUID().replace(/-/g, '').slice(0, 12);
export const now = () => Date.now() / 1000;

export function candidate({ label, facts = {}, source = '', detail = '', id = newId(), sources = [] }) {
  return { id, label, facts, source, detail, sources };
}

export function node({ moduleId, moduleName, parentId, depth, status = Status.WAITING }) {
  return {
    id: newId(), module_id: moduleId, module_name: moduleName, parent_id: parentId, depth, status,
    inputs: {}, input_key: '', children: [], summary: '', data: null, view: null, facts: {}, ask: null,
    error: null, reason: null, duplicate_of: null, cached: false, logs: [],
    started_at: null, finished_at: null,
  };
}

export function run({ query, person }) {
  return { id: newId(), query, person, status: 'running', created_at: now(), finished_at: null, root_id: null, nodes: {} };
}
