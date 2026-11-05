// Cliente para los web services de padrón de ARCA (ex AFIP).
//
// Requiere un certificado digital emitido por ARCA para tu CUIT y autorizado para cada
// servicio (ws_sr_padron_a13 y/o ws_sr_constancia_inscripcion) desde "Administrador de
// relaciones de clave fiscal". Sin certificado estos módulos no pueden funcionar.
//
// A VERIFICAR: endpoints, namespaces y nombres de campos están escritos según documentación
// de terceros (el manual oficial no estuvo accesible al armar esto). Todo es configurable
// por settings y la respuesta cruda se ve en la web para ajustar.
import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import forge from 'node-forge';
import { httpFetch } from '../core/module.js';

const SECRETS = process.env.CONDOR_SECRETS ?? 'secrets';

export const ARCA_DEFAULTS = {
  env: 'prod',                 // 'prod' | 'homo'
  cert_path: `${SECRETS}/arca.crt`,
  key_path: `${SECRETS}/arca.key`,
  cuit_representada: '',       // tu CUIT (el del certificado)
  wsaa_url: { prod: 'https://wsaa.afip.gov.ar/ws/services/LoginCms', homo: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms' },
  padron_a13_url: {
    prod: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13',
    homo: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA13',
  },
  constancia_url: {
    prod: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5',
    homo: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5',
  },
};

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true });
const tickets = new Map(); // `${env}|${service}|${cuit}` -> { token, sign, exp }

const pick = (s, k) => (typeof s[k] === 'object' ? s[k][s.env] : s[k]);

function settingsOf(raw) {
  const s = { ...ARCA_DEFAULTS, ...raw };
  if (!s.cuit_representada) throw new Error('ARCA: falta settings.cuit_representada (tu CUIT, el del certificado)');
  for (const k of ['cert_path', 'key_path']) {
    if (!fs.existsSync(s[k])) throw new Error(`ARCA: no existe ${k}=${s[k]}. Ver README, sección ARCA`);
  }
  return s;
}

function signTra(service, certPem, keyPem) {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const tra = '<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header>'
    + `<uniqueId>${Math.floor(now / 1000)}</uniqueId><generationTime>${iso(now - 600_000)}</generationTime>`
    + `<expirationTime>${iso(now + 600_000)}</expirationTime></header><service>${service}</service></loginTicketRequest>`;
  const cert = forge.pki.certificateFromPem(certPem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(keyPem),
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

async function soap(url, body, signal) {
  const resp = await httpFetch(url, {
    method: 'POST', signal, timeoutMs: 30_000,
    headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '' },
    body: `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`,
  });
  const xml = await resp.text();
  const doc = parser.parse(xml);
  const bodyNode = doc?.Envelope?.Body ?? {};
  if (bodyNode.Fault) throw new Error(`ARCA: ${bodyNode.Fault.faultstring || JSON.stringify(bodyNode.Fault)}`);
  if (!resp.ok) throw new Error(`ARCA HTTP ${resp.status}: ${xml.slice(0, 200)}`);
  return bodyNode;
}

// Ticket de acceso (token + sign). Dura ~12 h; se reutiliza en memoria.
export async function login(service, rawSettings, signal) {
  const s = settingsOf(rawSettings);
  const key = `${s.env}|${service}|${s.cuit_representada}`;
  const cached = tickets.get(key);
  if (cached && cached.exp > Date.now() + 60_000) return { ...cached, s };

  const cms = signTra(service, fs.readFileSync(s.cert_path, 'utf8'), fs.readFileSync(s.key_path, 'utf8'));
  const body = await soap(pick(s, 'wsaa_url'),
    `<wsaa:loginCms xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms>`, signal);
  const ticketXml = body?.loginCmsResponse?.loginCmsReturn;
  if (!ticketXml) throw new Error('ARCA WSAA: respuesta sin loginCmsReturn');
  const t = parser.parse(ticketXml)?.loginTicketResponse;
  const ticket = { token: t.credentials.token, sign: t.credentials.sign, exp: Date.parse(t.header.expirationTime) || Date.now() + 11 * 3600_000 };
  tickets.set(key, ticket);
  return { ...ticket, s };
}

const auth = (t) => `<token>${t.token}</token><sign>${t.sign}</sign><cuitRepresentada>${t.s.cuit_representada}</cuitRepresentada>`;

// Padrón alcance 13: datos generales de una persona por CUIT.
export async function padronA13(cuit, settings, signal) {
  const t = await login('ws_sr_padron_a13', settings, signal);
  const body = await soap(pick(t.s, 'padron_a13_url'),
    `<a13:getPersona xmlns:a13="http://a13.soap.ws.server.puc.sr/">${auth(t)}<idPersona>${cuit}</idPersona></a13:getPersona>`, signal);
  return body?.getPersonaResponse?.personaReturn ?? null;
}

// Padrón alcance 13: CUIT(s) asociadas a un DNI.
export async function cuitsPorDni(dni, settings, signal) {
  const t = await login('ws_sr_padron_a13', settings, signal);
  const body = await soap(pick(t.s, 'padron_a13_url'),
    `<a13:getIdPersonaListByDocumento xmlns:a13="http://a13.soap.ws.server.puc.sr/">${auth(t)}<documento>${dni}</documento></a13:getIdPersonaListByDocumento>`, signal);
  const ids = body?.getIdPersonaListByDocumentoResponse?.idPersonaListReturn?.idPersona;
  return [ids].flat().filter(Boolean).map(String);
}

// Constancia de inscripción (impuestos, actividades, monotributo).
export async function constancia(cuit, settings, signal) {
  const t = await login('ws_sr_constancia_inscripcion', settings, signal);
  const body = await soap(pick(t.s, 'constancia_url'),
    `<a5:getPersona_v2 xmlns:a5="http://a5.soap.ws.server.puc.sr/">${auth(t)}<idPersona>${cuit}</idPersona></a5:getPersona_v2>`, signal);
  return body?.getPersona_v2Response?.personaReturn ?? null;
}

// Diagnóstico de configuración: devuelve la lista de lo que falta (vacía = listo para usar).
export function arcaCheck(raw) {
  const s = { ...ARCA_DEFAULTS, ...raw };
  const out = [];
  const cuit = String(s.cuit_representada || '').replace(/\D/g, '');
  if (!cuit) out.push('falta cuit_representada en settings (tu CUIT)');
  else if (cuit.length !== 11) out.push(`cuit_representada inválida: ${s.cuit_representada}`);
  const hasKey = fs.existsSync(s.key_path);
  if (!hasKey) out.push(`falta la clave privada (${s.key_path}): generala con "condor arca-csr <tu CUIT>"`);
  if (!fs.existsSync(s.cert_path)) {
    out.push(`falta el certificado (${s.cert_path}): bajalo de ARCA con el .csr generado`);
    return out;
  }
  try {
    const cert = forge.pki.certificateFromPem(fs.readFileSync(s.cert_path, 'utf8'));
    if (cert.validity.notAfter < new Date()) out.push(`el certificado venció el ${cert.validity.notAfter.toLocaleDateString('es-AR')}`);
    if (hasKey) {
      const key = forge.pki.privateKeyFromPem(fs.readFileSync(s.key_path, 'utf8'));
      if (key.n.compareTo(cert.publicKey.n) !== 0) out.push('la clave privada no corresponde a ese certificado');
    }
  } catch (e) {
    out.push(`no se pudo leer el certificado/clave: ${e.message}`);
  }
  return out;
}

// Genera clave privada + pedido de certificado (CSR) para subir a ARCA.
export function generarCsr({ cuit, nombre, dir = SECRETS, force = false }) {
  const c = String(cuit).replace(/\D/g, '');
  if (c.length !== 11) throw new Error('CUIT inválida (11 dígitos)');
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = `${dir}/arca.key`;
  const csrPath = `${dir}/arca.csr`;
  if (fs.existsSync(keyPath) && !force) throw new Error(`ya existe ${keyPath} (usá --force para reemplazarla)`);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { name: 'countryName', value: 'AR' },
    { name: 'organizationName', value: nombre || 'condor' },
    { name: 'commonName', value: 'condor' },
    { name: 'serialNumber', value: `CUIT ${c}` },
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  fs.writeFileSync(csrPath, forge.pki.certificationRequestToPem(csr));
  return { keyPath, csrPath };
}

// Arma "calle altura, localidad, provincia" a partir de un domicilio de ARCA.
export function formatDomicilio(d) {
  if (!d) return null;
  const partes = [d.direccion, d.localidad, d.descripcionProvincia].filter(Boolean);
  return partes.length ? partes.join(', ') : null;
}

export const asArray = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
