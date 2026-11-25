/**
 * Magis Live – Stremio Addon (Render-ready)
 * - Auto-actualiza seeds desde URL remota
 * - Auto-actualiza catálogo de canales (caché 5 min)
 * - Optimizado para plan free de Render
 */
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 7001;
const DES_KEY = Buffer.from('e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8', 'hex');
const HOSTS = (process.env.MAGIS_HOSTS || 'sqacjy.s5lm5aydc.xyz,osuhk.m3x8o50te.com,oogoy.f30c96w8.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const SEEDS_URL = process.env.SEEDS_URL ||
  'https://raw.githubusercontent.com/xuper-plugin/kino-plugin-xuper/seeds/seeds.enc.json';
const SEEDS_FILE = path.join(__dirname, 'seeds.json');
const SEEDS_REFRESH_MS = 30 * 60 * 1000; // 30 min
const CHANNELS_CACHE_MS = 5 * 60 * 1000;

const CFG = {
  scheme: 'https',
  appId: 'com.android.msandroid',
  apkVersion: '49902',
  apiVersion: '43404',
  portalCode: 'masnew',
  liveRoot: 'masnew_live',
  defaultLiveColumnId: 76182,
};

let seeds = [];
let session = null;
let preferredHost = null;
const usedTokens = new Set();
let channelsCache = null;
let channelsCacheAt = 0;
let seedsRefreshedAt = 0;

function loadLocalSeeds() {
  try {
    const raw = fs.readFileSync(SEEDS_FILE, 'utf8');
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : (data.seeds || []);
    seeds = list.filter(s => s && s.userToken && s.sn);
    console.log('[seeds] locales:', seeds.length);
  } catch (e) {
    console.warn('[seeds] no local:', e.message);
    seeds = [];
  }
}

async function refreshSeeds() {
  const now = Date.now();
  if (now - seedsRefreshedAt < SEEDS_REFRESH_MS && seeds.length) return;
  try {
    const res = await fetch(SEEDS_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    // Formato plano o caja cifrada (sin seedKey no se abre la caja)
    let list = [];
    if (Array.isArray(json)) list = json;
    else if (json && Array.isArray(json.seeds)) list = json.seeds;
    else if (json && json.v === 1 && json.iv && json.data) {
      console.log('[seeds] remoto cifrado (seeds.enc.json); se mantiene local');
      seedsRefreshedAt = now;
      return;
    }
    list = list.filter(s => s && s.userToken && s.sn);
    if (list.length) {
      seeds = list;
      try {
        fs.writeFileSync(SEEDS_FILE, JSON.stringify(list));
      } catch (_) {}
      console.log('[seeds] actualizadas desde remoto:', list.length);
    }
  } catch (e) {
    console.warn('[seeds] refresh falló:', e.message);
  }
  seedsRefreshedAt = now;
}

function encryptBody(obj) {
  const json = JSON.stringify(obj);
  let pad = 8 - (json.length % 8);
  if (pad === 0) pad = 8;
  const padded = Buffer.concat([Buffer.from(json, 'utf8'), Buffer.alloc(pad, pad)]);
  const cipher = crypto.createCipheriv('des-ede3', DES_KEY, null);
  cipher.setAutoPadding(false);
  const enc = Buffer.concat([cipher.update(padded), cipher.final()]);
  return Buffer.from(enc.toString('base64')).toString('hex');
}

function decryptBlob(wire) {
  let raw;
  try {
    const b64 = Buffer.from(wire, 'hex').toString('utf8');
    raw = Buffer.from(b64, 'base64');
  } catch {
    raw = Buffer.from(wire, 'base64');
  }
  const decipher = crypto.createDecipheriv('des-ede3', DES_KEY, null);
  decipher.setAutoPadding(false);
  let plain = Buffer.concat([decipher.update(raw), decipher.final()]);
  const pad = plain[plain.length - 1];
  if (pad >= 1 && pad <= 8) plain = plain.slice(0, plain.length - pad);
  return plain.toString('utf8');
}

function liveDigestHex(bytes) {
  const K = [3614090360,3905402710,606105819,3250441966,4118548399,1200080426,2821735955,4249261313,1770035416,2336552879,4294925233,2304563134,1804603682,4254626195,2792965006,1236535329,4129170786,3225465664,643717713,3921069994,3593408605,38016083,3634488961,3889429448,568446438,3275163606,4107603335,1163531501,2850285829,4243563512,1735328473,2368359562,4294588738,2272392833,1839030562,4259657740,2763975236,1272893353,4139469664,3200236656,681279174,3936430074,3564056709,76029189,3654602809,3871185381,530742520,3299628645,4096336452,1126891415,2878612391,4237533241,1700485571,2399980690,4293706877,2240044497,1873313359,4264355552,2734768916,1309151649,4149444226,3174756917,765973179,3951481745];
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const ROUND1 = [10,11,12,13,14,15,6,7,8,9,0,1,2,3,4,5];
  const G = [];
  for (let i = 0; i < 64; i++) {
    G.push(i < 16 ? ROUND1[i] : i < 32 ? (5 * i + 1) % 16 : i < 48 ? (3 * i + 5) % 16 : (7 * i) % 16);
  }
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  let a = Array.from(bytes instanceof Buffer ? bytes : Buffer.from(bytes));
  const bitLen = a.length * 8;
  a.push(0x80);
  while (a.length % 64 !== 56) a.push(0);
  for (let i = 0; i < 8; i++) a.push((bitLen >>> (8 * i)) & 255);
  let state = [1732584193, 4023233417, 2562383102, 271733878];
  for (let u = 0; u < a.length; u += 64) {
    const n = [];
    for (let ai = 0; ai < 16; ai++) {
      const i = u + 4 * ai;
      n[ai] = (a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24)) >>> 0;
    }
    let o = state[0], s = state[1], uu = state[2], l = state[3];
    for (let c = 0; c < 64; c++) {
      let f;
      if (c < 16) f = (s & uu) | ((~s) & l);
      else if (c < 32) f = (l & s) | ((~l) & uu);
      else if (c < 48) f = s ^ uu ^ l;
      else f = uu ^ (s | (~l));
      f = f >>> 0;
      const d = (f + o + K[c] + n[G[c]]) >>> 0;
      o = l; l = uu; uu = s;
      s = (s + rotl(d, S[c])) >>> 0;
    }
    state[0] = (state[0] + o) >>> 0;
    state[1] = (state[1] + s) >>> 0;
    state[2] = (state[2] + uu) >>> 0;
    state[3] = (state[3] + l) >>> 0;
  }
  let hex = '';
  for (let c = 0; c < 4; c++) {
    for (let d = 0; d < 4; d++) hex += ((state[c] >>> (8 * d)) & 255).toString(16).padStart(2, '0');
  }
  return hex;
}

function signO3(token, startMoment) {
  const msg = `token=${token}&sign2_method=sign_o3&instance=0&start_moment=${startMoment}`;
  const salt = Buffer.from('73616c74333333333d34980d0a1532c9c3821708c0', 'hex');
  return liveDigestHex(Buffer.concat([Buffer.from(msg, 'utf8'), salt]));
}

function pickSeed() {
  const now = Math.floor(Date.now() / 1000);
  const valid = seeds.filter(s => s.userToken && s.sn && (!s.exp || s.exp > now + 60) && !usedTokens.has(s.userToken));
  const pool = valid.length ? valid : seeds.filter(s => s.userToken && !usedTokens.has(s.userToken));
  if (!pool.length) return seeds.length ? seeds[Math.floor(Math.random() * seeds.length)] : null;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function portal(apiPath, bean = {}) {
  await refreshSeeds();
  if (!session || !session.userToken) {
    const seed = pickSeed();
    if (!seed) throw new Error('Sin seeds disponibles');
    if (seed.userToken) usedTokens.add(seed.userToken);
    session = {
      sn: String(seed.sn || ''),
      userId: String(seed.userId || ''),
      userToken: String(seed.userToken || ''),
    };
  }

  const body = {
    path: apiPath,
    bean: {
      ...bean,
      userId: session.userId,
      userToken: session.userToken,
      sn: session.sn,
      appId: CFG.appId,
      apkVersion: CFG.apkVersion,
      apiVersion: CFG.apiVersion,
      portalCode: CFG.portalCode,
    },
  };

  const wire = encryptBody(body);
  const hosts = preferredHost
    ? [preferredHost, ...HOSTS.filter(h => h !== preferredHost)]
    : HOSTS;

  let lastErr;
  for (const host of hosts) {
    try {
      const url = `${CFG.scheme}://${host}/api`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Ranger/4.9.4-17294ac0',
          App: CFG.appId,
          'App-Version': CFG.apkVersion,
        },
        body: JSON.stringify({ data: wire }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { throw new Error('respuesta no JSON de ' + host); }

      const dataWire = json.data || json.result || text;
      let plain;
      try {
        plain = typeof dataWire === 'string' && /^[0-9a-fA-F]+$/.test(dataWire)
          ? decryptBlob(dataWire)
          : (typeof dataWire === 'string' ? dataWire : JSON.stringify(dataWire));
      } catch {
        plain = typeof dataWire === 'string' ? dataWire : JSON.stringify(dataWire);
      }

      let parsed;
      try { parsed = JSON.parse(plain); } catch { parsed = json; }

      const msg = String(parsed.msg || parsed.message || parsed.error || '');
      if (/otro dispositivo|expir|login|过期|重新登录/i.test(msg)) {
        usedTokens.add(session.userToken);
        session = null;
        throw new Error(msg || 'sesión inválida');
      }

      preferredHost = host;
      return parsed.data || parsed;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('portal falló');
}

async function api(apiPath, bean = {}) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      return await portal(apiPath, bean);
    } catch (e) {
      last = e;
      session = null;
    }
  }
  throw last;
}

async function getAllChannels() {
  const now = Date.now();
  if (channelsCache && now - channelsCacheAt < CHANNELS_CACHE_MS) return channelsCache;

  let categories = [];
  try {
    const data = await api('getNextColumns', {
      columnCode: CFG.liveRoot,
      pageNum: 1,
      pageSize: 50,
      version: '',
    });
    for (const o of data.recommendList || []) {
      if (o && o.columnId) {
        categories.push({ id: String(o.columnId), name: o.name || o.title || o.alias || 'Categoría' });
      }
    }
  } catch (e) {
    console.warn('[cats]', e.message);
  }
  if (!categories.length) {
    categories = [{ id: String(CFG.defaultLiveColumnId), name: 'Canales en vivo' }];
  }

  const channels = [];
  const seen = new Set();
  for (const cat of categories.slice(0, 12)) {
    try {
      const data = await api('v6/getLiveData', {
        columnId: Number(cat.id) || cat.id,
        pageNum: 1,
        pageSize: 80,
      });
      for (const u of data.channelList || []) {
        if (!u || !u.channelCode) continue;
        const code = String(u.channelCode);
        if (seen.has(code)) continue;
        seen.add(code);
        channels.push({
          id: 'magis:' + code,
          channelCode: code,
          name: u.name || u.channelName || u.title || code,
          poster: u.icon || u.logo || u.image || null,
          category: cat.name,
        });
      }
    } catch (e) {
      console.warn('[ch]', cat.id, e.message);
    }
  }

  channelsCache = channels;
  channelsCacheAt = Date.now();
  console.log('[channels]', channels.length);
  return channels;
}

async function getStream(channelCode) {
  const play = await api('v4/startPlayLive', {
    channelCode,
    columnId: 0,
    type: '1',
  });
  const list = play.liveAddressList || [];
  const chosen = list.find(a => a && a.playCode && a.license) || list[0];
  if (!chosen || !chosen.license) throw new Error('sin licencia');

  const playCode = chosen.playCode || channelCode;
  const license = chosen.license;

  const slb = await api('v14/getSlbInfo', {
    hasPay: '0',
    userIdentity: '1',
    type: 'merge',
    appVer: CFG.apkVersion,
    lang: 'es',
    encMediaSupported: 1,
    liveCodeList: [channelCode],
    appParams: '',
    reserve1: '02:00:00:00:00:00',
    pipFlag: '0',
  });

  let cflHost = '';
  let authBase = '';
  for (const c of slb.cdn_list || []) {
    if ((c.tag || '') !== 'live') continue;
    for (const u of c.url_list || []) {
      const p = String(u.url || '');
      if ((u.sign_type || '') === 'cfl' || p.includes('cfl')) {
        const addr = String(c.main_addr || '').replace(/^https?:\/\//, '');
        cflHost = addr.split('/')[0];
        authBase = p;
        break;
      }
    }
    if (cflHost) break;
  }
  if (!cflHost || !authBase) throw new Error('sin CDN live');

  const tokenMatch = authBase.match(/token=([0-9a-fA-F]{32})/);
  const token = tokenMatch ? tokenMatch[1] : '';
  const startMoment = String(Date.now());
  const sign2 = signO3(token, startMoment);
  const url = `http://${cflHost}/live/${playCode}.m3u8`;
  const contentAuth = `${authBase}&sign2_method=sign_o3&instance=0&start_moment=${startMoment}&sign2=${sign2}`;

  return {
    name: 'Magis Live',
    title: (play.name || channelCode) + ' – En vivo',
    url,
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: {
        request: {
          'Content-Auth': contentAuth,
          'Content-License': license,
          'User-Agent': 'Ranger/4.9.4-17294ac0',
          App: CFG.appId,
          'App-Version': CFG.apkVersion,
          'X-Buffer': '0',
        },
      },
    },
  };
}

// ─── Stremio ───────────────────────────────────────────────
const manifest = {
  id: 'com.magis.live',
  version: '1.1.0',
  name: 'Magis Live',
  description: 'Canales en vivo Magis. Seeds y catálogo se actualizan solos.',
  logo: 'https://via.placeholder.com/256x256.png?text=Magis',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  catalogs: [{
    type: 'tv',
    id: 'magis_live',
    name: 'Magis Live',
    extra: [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false },
    ],
  }],
  idPrefixes: ['magis:'],
  behaviorHints: { adult: false, configurable: false },
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, extra }) => {
  if (type !== 'tv') return { metas: [] };
  let channels = await getAllChannels();
  if (extra && extra.search) {
    const q = String(extra.search).toLowerCase();
    channels = channels.filter(c => c.name.toLowerCase().includes(q));
  }
  const skip = parseInt(extra && extra.skip, 10) || 0;
  return {
    metas: channels.slice(skip, skip + 100).map(c => ({
      id: c.id,
      type: 'tv',
      name: c.name,
      poster: c.poster || undefined,
      genres: c.category ? [c.category] : undefined,
      posterShape: 'square',
    })),
  };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'tv') return { meta: null };
  const channels = await getAllChannels();
  const c = channels.find(ch => ch.id === id);
  if (!c) return { meta: null };
  return {
    meta: {
      id: c.id,
      type: 'tv',
      name: c.name,
      poster: c.poster || undefined,
      description: c.name + ' – Magis Live',
      genres: c.category ? [c.category] : undefined,
    },
  };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'tv' || !String(id).startsWith('magis:')) return { streams: [] };
  const code = String(id).slice(6);
  try {
    const stream = await getStream(code);
    return { streams: [stream] };
  } catch (e) {
    console.error('[stream]', code, e.message);
    return { streams: [] };
  }
});

const app = express();
app.use(getRouter(builder.getInterface()));

// Keep-alive para Render free (evita que duerma si algo hace ping)
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    seeds: seeds.length,
    channels: channelsCache ? channelsCache.length : 0,
    uptime: process.uptime(),
  });
});

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0b0b0f;color:#eee;padding:32px">
    <h1>Magis Live</h1>
    <p>Seeds: <b>${seeds.length}</b> · Canales en caché: <b>${channelsCache ? channelsCache.length : 0}</b></p>
    <p>Manifest: <code>${req.protocol}://${req.get('host')}/manifest.json</code></p>
    <p style="color:#aaa;font-size:14px">Los streams requieren cabeceras Content-Auth. Si Nuvio no las envía, el vídeo puede fallar.</p>
  </body></html>`);
});

loadLocalSeeds();
refreshSeeds().catch(() => {});

// refresco periódico de seeds
setInterval(() => refreshSeeds().catch(() => {}), SEEDS_REFRESH_MS);

app.listen(PORT, () => {
  console.log(`Magis Live → http://localhost:${PORT}/manifest.json`);
  console.log(`Seeds: ${seeds.length}`);
});
