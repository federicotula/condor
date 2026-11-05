// A. ARCA · Constancia de inscripción pública (web), con captcha resuelto por el usuario.
//
// Usa la misma consulta que https://seti.afip.gob.ar/padron-puc-constancia-internet/ConsultaConstanciaAction.do
// Cóndor trae el captcha y te lo muestra (web o CLI); vos escribís el código y el módulo
// envía la consulta y procesa la constancia. No necesita certificado.
//
// Verificado (nov-2026): sesión + restCaptchaCode (imagen base64 + token). A VERIFICAR con la
// primera consulta real: la respuesta de ConstanciaAction.do y el formato de la constancia
// (HTML o PDF). El módulo guarda el texto crudo en "Respuesta cruda" para ajustar el parseo.
import fs from 'node:fs';
import path from 'node:path';
import { formatCuit } from '../core/ar.js';
import { view as v } from '../core/view.js';

const BASE = 'https://seti.afip.gob.ar/padron-puc-constancia-internet';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export const FILES_DIR = path.resolve(process.env.CONDOR_DATA ?? 'data', 'files');

// Sesión HTTP mínima con cookies (el captcha queda atado a la sesión).
function session(ctx, base) {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, val]) => `${k}=${val}`).join('; ');
  return async (url, opts = {}) => {
    const resp = await ctx.fetch(url, {
      ...opts,
      headers: { 'user-agent': UA, referer: `${base}/jsp/Constancia.jsp`, ...(jar.size ? { cookie: cookie() } : {}), ...opts.headers },
    });
    for (const c of resp.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return resp;
  };
}

const decodeEntities = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í').replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú')
  .replace(/&ntilde;/g, 'ñ').replace(/&Ntilde;/g, 'Ñ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

function htmlToLines(html) {
  return decodeEntities(html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|tr|li|h\d|table|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ''))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').replace(/(\s*\|\s*)+$/, '').trim()).filter(Boolean);
}

const parseFecha = (s) => {
  const m = String(s).match(/(\d{2})-(\d{2})-(\d{4})/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
};

// "FLORIDA 100 Piso:3 Dpto:B - BARRIO : SAN NICOLAS" + "1005-CIUDAD AUTONOMA BUENOS AIRES"
export function parseDomicilio(tipo, partes) {
  const d = { tipo, calle: null, piso: null, dpto: null, barrio: null, cp: null, localidad: null, extra: [] };
  for (const raw of partes) {
    const l = raw.replace(/\s+/g, ' ').trim();
    const cpLoc = l.match(/^([A-Z]?\d{4}[A-Z]{0,3})\s*-\s*(.+)$/i);
    if (cpLoc && !d.cp) { d.cp = cpLoc[1]; d.localidad = cpLoc[2].trim(); continue; }
    if (!d.calle) {
      let rest = l;
      const barrio = rest.match(/\s+-\s*BARRIO\s*:\s*(.+)$/i);
      if (barrio) { d.barrio = barrio[1].trim(); rest = rest.slice(0, barrio.index); }
      const dpto = rest.match(/\s+(?:Dpto|Depto|Dto)\.?\s*:\s*(\S+)/i);
      if (dpto) { d.dpto = dpto[1]; rest = rest.replace(dpto[0], ''); }
      const piso = rest.match(/\s+Piso\s*:\s*(\S+)/i);
      if (piso) { d.piso = piso[1]; rest = rest.replace(piso[0], ''); }
      d.calle = rest.replace(/\s+-\s*$/, '').trim();
      continue;
    }
    d.extra.push(l);
  }
  // Texto para disparar otros módulos: "CALLE 123, piso 1 dto H, BARRIO, LOCALIDAD"
  const pisoDto = [d.piso && `piso ${d.piso}`, d.dpto && `dto ${d.dpto}`].filter(Boolean).join(' ');
  d.texto = [d.calle, pisoDto, d.barrio, ...d.extra, d.localidad].filter(Boolean).join(', ');
  return d;
}

// La constancia viene por secciones: un título en mayúsculas y los datos en las líneas siguientes.
export function parseConstancia(lines) {
  const out = { nombre: null, cuit: null, impuestos: [], sinImpuestos: false, actividades: [], domicilios: [], vigencia: null, hora: null, verificador: null, notas: [] };
  const HEAD = [
    ['impuestos', /^IMPUESTOS\s*\/\s*REG[IÍ]MENES/i],
    ['actividades', /^ACTIVIDAD(ES)?\b/i],
    ['domicilio', /^DOMICILIO\b/i],
    ['vigencia', /^Vigencia de la/i],
    ['hora', /^Hora$/i],
    ['verificador', /^Verificador$/i],
    ['notas', /^(Contribuyente no amparado|Esta constancia no da cuenta)/i],
    ['fin', /^Los datos contenidos en/i],
    ['sep', /^\*{5,}/],
  ];
  let sec = 'cabecera';
  let domActual = null;
  const flushDom = () => { if (domActual) out.domicilios.push(parseDomicilio(domActual.tipo, domActual.partes)); domActual = null; };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const head = HEAD.find(([, re]) => re.test(l));
    if (head) {
      flushDom();
      sec = head[0];
      if (sec === 'domicilio') domActual = { tipo: l.replace(/\s+/g, ' '), partes: [] };
      if (sec === 'notas') out.notas.push(l);
      if (sec === 'vigencia') {
        const resto = lines.slice(i, i + 3).join(' ');
        const f = resto.match(/(\d{2}-\d{2}-\d{4})\s*a\s*(\d{2}-\d{2}-\d{4})/);
        if (f) out.vigencia = { desde: f[1], hasta: f[2] };
      }
      continue;
    }
    switch (sec) {
      case 'cabecera':
        if (/^CUIT:?$/i.test(l)) { out.cuit = lines[i + 1]?.trim() || null; i++; break; }
        if (/^CONSTANCIA DE INSCRIPCI[OÓ]N$/i.test(lines[i - 1]?.trim() || '') && !out.nombre) out.nombre = l;
        break;
      case 'impuestos': {
        if (/^no registra/i.test(l)) { out.sinImpuestos = true; break; }
        if (/^impuestos activos$/i.test(l)) break;
        const m = l.match(/^(.*?)\s+(?:Fecha\s+de\s+alta:?\s*)?(\d{2}[-/]\d{4}|\d{2}[-/]\d{2}[-/]\d{4})$/i);
        out.impuestos.push(m ? { impuesto: m[1].trim(), alta: m[2] } : { impuesto: l, alta: null });
        break;
      }
      case 'actividades':
        if (!/^(no registra|\(?ver nota)/i.test(l)) out.actividades.push(l.replace(/\s+/g, ' '));
        break;
      case 'domicilio':
        domActual?.partes.push(l);
        break;
      case 'hora':
        out.hora ??= l;
        break;
      case 'verificador':
        out.verificador ??= l;
        break;
      case 'notas':
        if (/^-\s/.test(l)) out.notas.push(l.slice(2));
        else if (out.notas.length) out.notas[out.notas.length - 1] += ` ${l}`;
        break;
      default:
        break;
    }
  }
  flushDom();
  return out;
}

async function obtenerCaptcha(http, base) {
  const r = await http(`${base}/restCaptchaCode?type=&systemId=constanciaPadron`, { headers: { 'x-requested-with': 'XMLHttpRequest' } });
  const j = await r.json().catch(() => null);
  if (!j?.imagenBase64Html || !j?.token) throw new Error('ARCA no devolvió el captcha (¿cambió la página?)');
  return j;
}

export default {
  id: 'arca_constancia_web',
  name: 'ARCA · Constancia pública (con captcha)',
  description: 'Constancia de inscripción desde la consulta pública de ARCA. Te pide resolver el captcha; no necesita certificado.',
  requires: ['cuit'],
  provides: ['nombre', 'domicilio', 'actividad'],
  cacheTtl: 60 * 60 * 24 * 7,       // una semana: evita pedirte el captcha de nuevo por la misma CUIT
  timeout: 900,                      // incluye el tiempo que tardás en responder
  defaultSettings: { intentos: 3, segundos_para_responder: 300 },

  async run(ctx) {
    const cuit = String(ctx.inputs.cuit).replace(/\D/g, '');
    const base = ctx.settings.base_url || BASE;
    const http = session(ctx, base);
    await http(`${base}/ConsultaConstanciaAction.do`);
    const form = await (await http(`${base}/jsp/Constancia.jsp`)).text();
    const bar = form.match(/name="bar"[^>]*value="([^"]*)"/i)?.[1] ?? '';

    let result = null;
    let error = null;
    for (let intento = 1; intento <= Number(ctx.settings.intentos || 3) && !result; intento++) {
      const cap = await obtenerCaptcha(http, base);
      const answer = await ctx.ask({
        title: `Captcha de ARCA para la CUIT ${formatCuit(cuit)}`,
        text: [error && `⚠ ${error}.`, intento > 1 && `Intento ${intento} de ${ctx.settings.intentos}.`].filter(Boolean).join(' ') || 'Escribí los caracteres de la imagen.',
        image: cap.imagenBase64Html,
        fields: [{ name: 'codigo', label: cap.ariaLabel || 'Código', help: cap.txtAyuda }],
        actions: ['refresh'],
        timeoutSec: ctx.settings.segundos_para_responder,
      });
      if (answer === null) {
        return { noCache: true, summary: 'salteado por el usuario', view: [v.alert('Consulta salteada: no se resolvió el captcha.', 'info')] };
      }
      if (answer.__action === 'refresh') { intento--; error = null; continue; }

      const payload = { cuit, txtSolucion: String(answer.codigo || '').trim(), txtToken: cap.token, systemId: 'constanciaPadron' };
      const resp = await http(`${base}/ConstanciaAction.do?bar=${encodeURIComponent(bar)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        body: JSON.stringify({ data: JSON.stringify(payload) }),
      });
      const txt = await resp.text();
      let j = null;
      try { j = JSON.parse(txt); } catch { /* no es JSON */ }
      ctx.log(`intento ${intento}: HTTP ${resp.status} ${j ? `json ${Object.keys(j).join(',')}` : `texto ${txt.slice(0, 80)}`}`);
      if (j?.redirect) result = j.redirect;
      else error = j?.mensaje || j?.error || j?.message || 'código incorrecto o vencido';
    }
    if (!result) throw new Error(`no se pudo consultar: ${error}`);

    // Descarga de la constancia (HTML o PDF). El redirect es relativo a la página del formulario
    // (/jsp/Constancia.jsp), igual que lo resuelve el navegador con window.location.href.
    ctx.log(`redirect: ${String(result).slice(0, 120)}`);
    const url = new URL(result, `${base}/jsp/Constancia.jsp`).href;
    const resp = await http(url);
    const type = resp.headers.get('content-type') || '';
    ctx.log(`constancia: HTTP ${resp.status} ${type} desde ${url.replace(/\?.*/, '?…')}`);
    if (!resp.ok) throw new Error(`ARCA devolvió HTTP ${resp.status} al pedir la constancia (${url.replace(/\?.*/, '')})`);

    if (/pdf/i.test(type)) {
      fs.mkdirSync(FILES_DIR, { recursive: true });
      const file = `constancia-${cuit}-${new Date().toISOString().slice(0, 10)}.pdf`;
      fs.writeFileSync(path.join(FILES_DIR, file), Buffer.from(await resp.arrayBuffer()));
      return {
        data: { formato: 'pdf', archivo: file },
        summary: 'constancia descargada (PDF)',
        view: [
          v.alert('ARCA devolvió la constancia en PDF. Se guardó localmente.', 'ok'),
          v.links([{ label: `Abrir ${file}`, href: `/files/${file}` }]),
        ],
      };
    }

    // ARCA responde en ISO-8859-1: decodificar según el charset para no romper los acentos.
    const charset = (type.match(/charset=([\w-]+)/i)?.[1] || 'utf-8').toLowerCase();
    const buf = Buffer.from(await resp.arrayBuffer());
    const html = new TextDecoder(/8859-1|latin1|windows-1252/.test(charset) ? 'windows-1252' : 'utf-8').decode(buf);
    const lines = htmlToLines(html);
    const plano = lines.join(' ');
    if (/consulta ha expirado|vuelva a pedir la constancia/i.test(plano)) {
      throw new Error('ARCA dice que la consulta expiró (se perdió la sesión entre el captcha y la constancia). Reintentá.');
    }
    if (/error report|not available|no se encontr|cuit inexistente/i.test(plano) && lines.length < 15) {
      throw new Error(`ARCA no devolvió la constancia: ${plano.slice(0, 200)}`);
    }
    const c = parseConstancia(lines);
    const domicilios = c.domicilios.map((d) => d.texto);
    const reconocido = Boolean(c.nombre || domicilios.length || c.impuestos.length);
    const hoy = new Date();
    const vence = c.vigencia?.hasta ? parseFecha(c.vigencia.hasta) : null;

    return {
      facts: {
        nombre: c.nombre ? [c.nombre] : [],
        domicilio: domicilios,
        actividad: c.actividades,
      },
      data: { formato: type, url_constancia: url.replace(/\?.*/, ''), constancia: c, texto: lines.join('\n').slice(0, 20000) },
      summary: [c.nombre, domicilios[0], c.sinImpuestos ? 'sin impuestos activos' : c.impuestos.length ? `${c.impuestos.length} impuestos` : null]
        .filter(Boolean).join(' · ') || 'constancia leída',
      view: [
        reconocido ? null : v.alert('No se reconocieron datos en la constancia. Revisá el texto abajo y avisá para ajustar el parseo.', 'warn'),
        v.stats([
          { label: 'Impuestos activos', value: c.sinImpuestos ? 0 : c.impuestos.length, tone: c.sinImpuestos ? 'warn' : 'ok',
            hint: c.sinImpuestos ? 'no registra impuestos activos' : undefined },
          { label: 'Actividades', value: c.actividades.length },
          { label: 'Vigencia', value: c.vigencia ? `${c.vigencia.desde} → ${c.vigencia.hasta}` : '—',
            tone: vence && vence < hoy ? 'bad' : undefined },
        ]),
        v.kv([
          { label: 'Nombre / razón social', value: c.nombre },
          { label: 'CUIT', value: c.cuit || formatCuit(cuit) },
          { label: 'Verificador', value: c.verificador },
          { label: 'Emitida', value: c.hora ? `${c.vigencia?.desde || ''} ${c.hora}`.trim() : null },
        ].filter((x) => x.value)),
        ...c.domicilios.map((d) => v.kv([
          { label: 'Calle y altura', value: d.calle },
          { label: 'Piso', value: d.piso },
          { label: 'Departamento', value: d.dpto },
          { label: 'Barrio', value: d.barrio },
          { label: 'Código postal', value: d.cp },
          { label: 'Localidad / provincia', value: d.localidad },
        ].filter((x) => x.value), { title: d.tipo })),
        c.sinImpuestos
          ? v.alert('ARCA informa que no registra impuestos activos.', 'warn', { title: 'Impuestos:' })
          : c.impuestos.length ? v.table(c.impuestos, {
            title: 'Impuestos / regímenes registrados',
            columns: [{ key: 'impuesto', label: 'Impuesto / régimen' }, { key: 'alta', label: 'Fecha de alta' }],
          }) : null,
        c.actividades.length ? v.list(c.actividades, { title: 'Actividades' }) : null,
        c.notas.length ? v.section('Leyendas de la constancia', [v.list(c.notas)], { open: false }) : null,
        v.section('Texto completo de la constancia', [v.text(lines.join('\n').slice(0, 6000))], { open: !reconocido }),
      ].filter(Boolean),
    };
  },
};
