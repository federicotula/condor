// Proceso hijo: procesa un ZIP de IGJ y le devuelve el resultado al padre por IPC.
// Va aparte para que un crash nativo (SIGBUS, OOM) no tire abajo toda la importación.
import { procesarZip } from './igj.js';

process.once('message', async ({ archivo, file }) => {
  const log = (m) => process.send({ log: m });
  try {
    process.send({ ok: await procesarZip(archivo, log, file) });
  } catch (e) {
    process.send({ error: e.message });
  }
  process.disconnect();
});
