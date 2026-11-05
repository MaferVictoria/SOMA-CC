/**
 * /api/meta-data — Función serverless de Vercel para Meta Ads.
 *
 * Uso:  /api/meta-data?since=AAAA-MM-DD&until=AAAA-MM-DD
 *       (sin fechas = mes en curso)
 *
 * Devuelve:
 *   rows  → un registro por anuncio con los totales del rango (para tablas, KPIs y top).
 *   daily → gasto e impresiones por día y por campaña (para la gráfica diaria).
 *
 * El gasto se asigna por FECHA REAL en que ocurrió, no por el nombre del
 * conjunto: si un conjunto "OCTUBRE" sigue corriendo en noviembre, ese gasto
 * cuenta en noviembre.
 *
 * Nomenclatura de la cuenta:
 *   Campaña:   PLAZA + objetivo   (ARTZ / ANIMA / ANTARA + Alcance, Interacción,
 *                                  Tráfico a página o Tráfico a web)
 *   Conjunto:  objetivo + mes de pauta
 *   Anuncio:   concepto de contenido
 *
 * Variables de entorno (Vercel → Settings → Environment Variables):
 *   META_ACCESS_TOKEN   (obligatoria) token de usuario del sistema con ads_read
 *   META_AD_ACCOUNT_ID  (obligatoria) ID de la cuenta, con o sin "act_"
 *   META_API_VERSION    (opcional)    Default v24.0
 *   META_TIMEZONE       (opcional)    Default America/Mexico_City
 *
 * Diagnóstico: agrega &debug=1
 */

const API_VERSION = process.env.META_API_VERSION || 'v24.0';
const TZ = process.env.META_TIMEZONE || 'America/Mexico_City';

const CENTROS = [
  { id: 'artz',   match: /ARTZ/ },
  { id: 'anima',  match: /ANIMA/ },
  { id: 'antara', match: /ANTARA/ },
];
// Campañas que no llevan el nombre de la plaza pero pertenecen a una.
// Se revisan solo si el nombre no trae ARTZ, ANIMA ni ANTARA.
const CENTRO_EXCEPCIONES = [
  { id: 'artz', match: /CAMPANA INSTITUCIONAL/ },
];
// "WEB" va antes que "PAGINA" para que "página web" cuente como web.
const OBJETIVO_POR_NOMBRE = [
  { obj: 'Tráfico a web',    match: /\bWEB\b|SITIO|LANDING|WEBSITE/ },
  { obj: 'Tráfico a página', match: /PAGINA|PERFIL|PROFILE/ },
  { obj: 'Interacción',      match: /INTERACC|INTERACTION|ENGAGEMENT/ },
  { obj: 'Alcance',          match: /ALCANCE|REACH|RECONOCIMIENTO|AWARENESS/ },
];
const OBJETIVO_POR_API = { OUTCOME_AWARENESS: 'Alcance', OUTCOME_ENGAGEMENT: 'Interacción' };

const AD_FIELDS = ['campaign_name', 'adset_name', 'ad_name', 'ad_id', 'objective',
  'spend', 'reach', 'impressions', 'inline_link_clicks', 'unique_ctr', 'actions'];
const PROFILE_FIELD = 'instagram_profile_visits';
// "Seguimientos de Instagram" de Ads Manager. Meta no documenta aún el nombre
// del campo en la API, así que se prueban estos nombres y se usa el primero
// que la API acepte. Si ninguno existe, se buscan acciones tipo "follow".
const FOLLOW_CANDIDATES = ['instagram_follows', 'instagram_profile_follows', 'ig_follows', 'instagram_follow'];
let followFieldCache; // undefined = sin probar, null = ninguno funciona
const DAILY_FIELDS = ['campaign_name', 'objective', 'spend', 'impressions'];

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const num = v => {
  if (v == null) return 0;
  if (Array.isArray(v)) return v.reduce((a, x) => a + (Number(x && x.value) || 0), 0);
  return Number(v) || 0;
};
const todayIn = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function centroDe(campaignName) {
  const n = norm(campaignName);
  const c = CENTROS.find(x => x.match.test(n)) || CENTRO_EXCEPCIONES.find(x => x.match.test(n));
  return c ? c.id : null;
}
function objetivoDe(campaignName, adsetName, apiObjective) {
  for (const name of [campaignName, adsetName]) {
    const hit = OBJETIVO_POR_NOMBRE.find(x => x.match.test(norm(name)));
    if (hit) return hit.obj;
  }
  return OBJETIVO_POR_API[apiObjective] || 'Sin objetivo en el nombre';
}
// Valor mayor entre los tipos de acción que coinciden (evita contar doble).
function maxAction(actions, test) {
  let best = 0;
  (actions || []).forEach(a => { if (test(a.action_type || '')) best = Math.max(best, Number(a.value) || 0); });
  return best;
}

async function fetchAll(token, accountId, { level, fields, since, until, increment }) {
  const params = new URLSearchParams({
    level,
    time_increment: increment,
    time_range: JSON.stringify({ since, until }),
    fields: fields.join(','),
    limit: '500',
    access_token: token,
  });
  let url = `https://graph.facebook.com/${API_VERSION}/${accountId}/insights?${params}`;
  const out = [];
  let pages = 0;
  while (url && pages < 60) {
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok || json.error) {
      const e = json.error || {};
      const err = new Error(e.message || `HTTP ${res.status}`);
      err.meta = { code: e.code, subcode: e.error_subcode, type: e.type, fbtrace_id: e.fbtrace_id };
      throw err;
    }
    out.push(...(json.data || []));
    url = json.paging && json.paging.next;
    pages++;
  }
  return out;
}

async function graphGet(token, path, params) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${path}?${qs}`);
  const json = await res.json();
  if (!res.ok || json.error) {
    const err = new Error((json.error && json.error.message) || `HTTP ${res.status}`);
    err.meta = json.error;
    throw err;
  }
  return json;
}

// Encuentra qué campo de "seguimientos de Instagram" acepta la API.
async function detectFollowField(token, accountId, since, until) {
  if (followFieldCache !== undefined) return followFieldCache;
  const tried = [];
  for (const f of FOLLOW_CANDIDATES) {
    try {
      await graphGet(token, `${accountId}/insights`, {
        level: 'account', fields: f, time_range: JSON.stringify({ since, until }), limit: '1',
      });
      followFieldCache = f;
      return f;
    } catch (e) { tried.push(f); }
  }
  followFieldCache = null;
  return null;
}

// Imagen de cada anuncio: anuncio → creativo → image_url o miniatura grande.
async function fetchImages(token, adIds) {
  const out = {};
  const errors = [];
  const chunk = (arr, n) => arr.reduce((a, x, i) => (i % n ? a[a.length - 1].push(x) : a.push([x]), a), []);
  const creativeOf = {};
  for (const ids of chunk(adIds, 50)) {
    try {
      const j = await graphGet(token, '', { ids: ids.join(','), fields: 'creative{id}' });
      Object.entries(j).forEach(([adId, v]) => { if (v && v.creative) creativeOf[adId] = v.creative.id; });
    } catch (e) { errors.push(e.message); }
  }
  const creativeIds = [...new Set(Object.values(creativeOf))];
  const imgOf = {};
  for (const ids of chunk(creativeIds, 50)) {
    try {
      const j = await graphGet(token, '', {
        ids: ids.join(','), fields: 'image_url,thumbnail_url',
        thumbnail_width: '1080', thumbnail_height: '1080',
      });
      // image_url = imagen original (anuncios de imagen); thumbnail_url = miniatura más grande disponible.
      Object.entries(j).forEach(([cid, v]) => { imgOf[cid] = v ? { src: v.image_url || v.thumbnail_url || null, alt: v.image_url ? (v.thumbnail_url || null) : null } : null; });
    } catch (e) { errors.push(e.message); }
  }
  adIds.forEach(id => { out[id] = imgOf[creativeOf[id]] || { src: null, alt: null }; });
  return { images: out, errors };
}

module.exports = async function handler(req, res) {
  const token = process.env.META_ACCESS_TOKEN;
  let accountId = (process.env.META_AD_ACCOUNT_ID || '').trim();
  if (!token || !accountId) {
    return res.status(500).json({ error: 'Faltan META_ACCESS_TOKEN o META_AD_ACCOUNT_ID en Vercel.' });
  }
  if (!accountId.startsWith('act_')) accountId = 'act_' + accountId;

  const q = req.query || {};
  const today = todayIn(TZ);
  let until = isDate(q.until) ? q.until : today;
  if (until > today) until = today;
  let since = isDate(q.since) ? q.since : today.slice(0, 8) + '01';
  if (since > until) since = until;

  let adRaw, dailyRaw, profileFieldOk = true, followField = null;
  try {
    followField = await detectFollowField(token, accountId, since, until);
    const adFields = [...AD_FIELDS, ...(followField ? [followField] : [])];
    const dailyPromise = fetchAll(token, accountId, { level: 'campaign', fields: DAILY_FIELDS, since, until, increment: '1' });
    try {
      adRaw = await fetchAll(token, accountId, { level: 'ad', fields: [...adFields, PROFILE_FIELD], since, until, increment: 'all_days' });
    } catch (err) {
      // Si la versión de la API no reconoce el campo, reintenta y lo toma de "actions".
      if (/instagram_profile_visits/i.test(err.message)) {
        profileFieldOk = false;
        adRaw = await fetchAll(token, accountId, { level: 'ad', fields: adFields, since, until, increment: 'all_days' });
      } else throw err;
    }
    dailyRaw = await dailyPromise;
  } catch (err) {
    return res.status(502).json({ error: 'Meta API', detail: err.message, meta: err.meta });
  }

  const unmatched = new Set();
  const actionTypes = new Set();
  const rows = [];
  for (const r of adRaw) {
    (r.actions || []).forEach(a => actionTypes.add(a.action_type));
    const centro = centroDe(r.campaign_name);
    if (!centro) { unmatched.add(r.campaign_name); continue; }
    rows.push({
      centro,
      campana: r.campaign_name,
      objetivo: objetivoDe(r.campaign_name, r.adset_name, r.objective),
      conjunto: r.adset_name,
      anuncio: r.ad_name,
      ad_id: r.ad_id,
      gasto: num(r.spend),
      alcance: num(r.reach),
      impresiones: num(r.impressions),
      visitas_perfil: profileFieldOk && r[PROFILE_FIELD] != null
        ? num(r[PROFILE_FIELD])
        : maxAction(r.actions, t => /profile_visit/i.test(t)),
      seguidores: followField && r[followField] != null
        ? num(r[followField])
        : maxAction(r.actions, t => /follow/i.test(t) && !/unfollow/i.test(t)),
      clics_enlace: num(r.inline_link_clicks),
      // CTR único de Meta llega en porcentaje (1.5 = 1.5 %); se guarda como fracción.
      ctr_unico: r.unique_ctr == null ? null : num(r.unique_ctr) / 100,
    });
  }
  // Imágenes de los anuncios (si falla, el dashboard sigue sin imágenes).
  let imgErrors = [];
  try {
    const ids = [...new Set(rows.map(r => r.ad_id).filter(Boolean))];
    const { images, errors } = await fetchImages(token, ids);
    imgErrors = errors;
    rows.forEach(r => { const im = images[r.ad_id] || {}; r.imagen = im.src || null; r.imagen_alt = im.alt || null; });
  } catch (e) { imgErrors.push(e.message); }

  const daily = [];
  for (const r of dailyRaw) {
    const centro = centroDe(r.campaign_name);
    if (!centro) continue;
    daily.push({
      fecha: r.date_start,
      centro,
      objetivo: objetivoDe(r.campaign_name, '', r.objective),
      gasto: num(r.spend),
      impresiones: num(r.impressions),
    });
  }

  if (q.debug) {
    return res.status(200).json({
      cuenta: accountId,
      rango: { since, until },
      anuncios_api: adRaw.length,
      anuncios_dashboard: rows.length,
      gasto_total_dashboard: Math.round(rows.reduce((a, r) => a + r.gasto, 0) * 100) / 100,
      gasto_por_plaza: rows.reduce((a, r) => { a[r.centro] = Math.round(((a[r.centro] || 0) + r.gasto) * 100) / 100; return a; }, {}),
      campo_visitas_perfil: profileFieldOk ? PROFILE_FIELD : 'tomado de actions',
      campo_seguidores: followField || 'ninguno de: ' + FOLLOW_CANDIDATES.join(', '),
      seguidores_total: rows.reduce((a, r) => a + r.seguidores, 0),
      anuncios_con_imagen: rows.filter(r => r.imagen).length + ' de ' + rows.length,
      errores_imagenes: imgErrors.slice(0, 3),
      tipos_de_accion: [...actionTypes].sort(),
      campanas_sin_plaza: [...unmatched].sort(),
      campanas_detectadas: [...new Set(rows.map(r => `${r.campana}  →  ${r.centro}, ${r.objetivo}`))].sort(),
    });
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({ source: 'meta', since, until, updated: new Date().toISOString(), rows, daily });
};
