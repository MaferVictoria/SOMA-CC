/**
 * /api/google-ads-data — Función serverless de Vercel para Google Ads.
 *
 * Uso:  /api/google-ads-data?since=AAAA-MM-DD&until=AAAA-MM-DD   (sin fechas = mes en curso)
 *       Diagnóstico: agrega &debug=1
 *
 * Devuelve:
 *   rows  → un registro por anuncio con los totales del rango.
 *   daily → gasto e impresiones por día y por campaña.
 *
 * La plaza se identifica por el nombre de la campaña (ARTZ / ANIMA / ANTARA).
 * Si una campaña no tiene desglose por anuncio (p. ej. Performance Max), su
 * diferencia contra el total de la campaña se agrega como una fila
 * "Sin desglose por anuncio" para que los totales cuadren con Google Ads.
 *
 * Variables de entorno (Vercel → Settings → Environment Variables):
 *   GOOGLE_ADS_DEVELOPER_TOKEN     (obligatoria) del Centro de API de la cuenta de administrador (MCC)
 *   GOOGLE_ADS_CLIENT_ID           (obligatoria) cliente OAuth tipo "Aplicación web"
 *   GOOGLE_ADS_CLIENT_SECRET       (obligatoria)
 *   GOOGLE_ADS_REFRESH_TOKEN       (obligatoria) generado en OAuth Playground
 *   GOOGLE_ADS_CUSTOMER_ID         (obligatoria) ID de la cuenta con las 3 plazas, sin guiones
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID   (opcional)    ID del MCC, sin guiones, si se entra por un MCC
 *   GOOGLE_ADS_API_VERSION         (opcional)    p. ej. v24. Si no se pone, prueba las versiones recientes
 *   GOOGLE_ADS_TIMEZONE            (opcional)    Default America/Mexico_City
 *
 * Notas de la API (aprendidas en proyectos anteriores):
 *   - Llamadas REST directas, sin SDK.
 *   - Nunca se manda pageSize (la API lo rechaza); se pagina con nextPageToken.
 *   - La consulta GAQL va en snake_case, pero la respuesta llega en camelCase.
 *   - Los números llegan como texto; cost_micros se divide entre 1,000,000.
 *   - El detalle útil de los errores viene en error.details[].errors[].message.
 */

const TZ = process.env.GOOGLE_ADS_TIMEZONE || 'America/Mexico_City';
const VERSION_CANDIDATES = process.env.GOOGLE_ADS_API_VERSION
  ? [process.env.GOOGLE_ADS_API_VERSION]
  : ['v25', 'v24', 'v23'];
let workingVersion = null;
let tokenCache = { accessToken: null, expiresAt: 0 };

const CENTROS = [
  { id: 'artz',   match: /ARTZ/ },
  { id: 'anima',  match: /ANIMA/ },
  { id: 'antara', match: /ANTARA/ },
];
const TIPO = { VIDEO: 'video', DEMAND_GEN: 'video', DISPLAY: 'display', SEARCH: 'search', PERFORMANCE_MAX: 'pmax' };
const TIPO_NOMBRE = { video: 'Video', display: 'Display', search: 'Búsqueda', pmax: 'Performance Max' };

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const num = v => (v == null ? 0 : parseFloat(v) || 0);
const micros = v => num(v) / 1e6;
const todayIn = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const cleanId = v => String(v || '').replace(/\D/g, '');
function centroDe(name) {
  const n = norm(name);
  const c = CENTROS.find(x => x.match.test(n));
  return c ? c.id : null;
}

function errorDetail(json, status) {
  const top = (json && json.error && json.error.message) || `HTTP ${status}`;
  const nested = ((json && json.error && json.error.details) || []).flatMap(d => d.errors || [])
    .map(e => `${e.errorCode ? JSON.stringify(e.errorCode) + ': ' : ''}${e.message}`);
  return nested.length ? `${top} — ${nested.join(' | ')}` : top;
}

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60000) return tokenCache.accessToken;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`No se pudo renovar el acceso OAuth: ${json.error_description || json.error || res.status}`);
  tokenCache = { accessToken: json.access_token, expiresAt: now + (json.expires_in || 3600) * 1000 };
  return tokenCache.accessToken;
}

async function searchWithVersion(version, query) {
  const accessToken = await getAccessToken();
  const customerId = cleanId(process.env.GOOGLE_ADS_CUSTOMER_ID);
  const url = `https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:search`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  };
  const login = cleanId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  if (login) headers['login-customer-id'] = login;

  const rows = [];
  let pageToken;
  do {
    const body = pageToken ? { query, pageToken } : { query };   // sin pageSize, a propósito
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) {
      const err = new Error(json ? errorDetail(json, res.status) : `HTTP ${res.status}`);
      err.versionMissing = res.status === 404 && !json;    // versión que ya no existe o aún no sale
      throw err;
    }
    rows.push(...(json.results || []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return rows;
}

// Usa la primera versión de la API que responda (y la recuerda).
async function gaql(query) {
  if (workingVersion) return searchWithVersion(workingVersion, query);
  let lastErr;
  for (const v of VERSION_CANDIDATES) {
    try {
      const rows = await searchWithVersion(v, query);
      workingVersion = v;
      return rows;
    } catch (e) {
      lastErr = e;
      if (!e.versionMissing) throw e;
    }
  }
  throw new Error(`Ninguna versión de la API respondió (${VERSION_CANDIDATES.join(', ')}). Último error: ${lastErr && lastErr.message}`);
}

module.exports = async function handler(req, res) {
  const required = ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) return res.status(500).json({ error: 'Faltan variables en Vercel', detail: missing.join(', ') });

  const q = req.query || {};
  const today = todayIn(TZ);
  let until = isDate(q.until) ? q.until : today;
  if (until > today) until = today;
  let since = isDate(q.since) ? q.since : today.slice(0, 8) + '01';
  if (since > until) since = until;
  const range = `segments.date BETWEEN '${since}' AND '${until}'`;

  let adRows, campRows, dailyRows;
  try {
    // Por anuncio, totales del rango.
    adRows = await gaql(`
      SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
             ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.interactions,
             metrics.video_quartile_p25_rate, metrics.video_quartile_p100_rate
      FROM ad_group_ad
      WHERE ${range} AND metrics.impressions > 0`);
    // Por campaña, totales del rango (para cuadrar campañas sin desglose por anuncio).
    campRows = await gaql(`
      SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.interactions,
             metrics.video_quartile_p25_rate, metrics.video_quartile_p100_rate
      FROM campaign
      WHERE ${range} AND metrics.impressions > 0`);
    // Por campaña y día (gráfica).
    dailyRows = await gaql(`
      SELECT segments.date, campaign.name, metrics.cost_micros, metrics.impressions
      FROM campaign
      WHERE ${range} AND metrics.impressions > 0`);
  } catch (err) {
    return res.status(502).json({ error: 'Google Ads API', detail: err.message });
  }

  const unmatched = new Set();
  const rows = [];
  const sumByCampaign = {};
  for (const r of adRows) {
    const c = r.campaign || {}, ag = r.adGroup || {}, ad = (r.adGroupAd && r.adGroupAd.ad) || {}, m = r.metrics || {};
    const centro = centroDe(c.name);
    if (!centro) { unmatched.add(c.name); continue; }
    const tipo = TIPO[c.advertisingChannelType] || 'otro';
    const imp = num(m.impressions);
    const row = {
      centro, campana: c.name, grupo: ag.name || '—', tipo,
      anuncio: ad.name || `${TIPO_NOMBRE[tipo] || 'Anuncio'} · ${ad.id}`,
      ad_id: ad.id,
      gasto: micros(m.costMicros), impresiones: imp, clics: num(m.clicks), interacciones: num(m.interactions),
      // Las cuartillas de video llegan como % de impresiones; se convierten a conteos.
      vv25: Math.round(num(m.videoQuartileP25Rate) * imp),
      vv100: Math.round(num(m.videoQuartileP100Rate) * imp),
    };
    rows.push(row);
    const s = sumByCampaign[c.id] || (sumByCampaign[c.id] = { gasto: 0, impresiones: 0, clics: 0, interacciones: 0, vv25: 0, vv100: 0 });
    ['gasto', 'impresiones', 'clics', 'interacciones', 'vv25', 'vv100'].forEach(k => { s[k] += row[k]; });
  }
  const remainders = [];
  for (const r of campRows) {
    const c = r.campaign || {}, m = r.metrics || {};
    const centro = centroDe(c.name);
    if (!centro) { unmatched.add(c.name); continue; }
    const tipo = TIPO[c.advertisingChannelType] || 'otro';
    const imp = num(m.impressions);
    const total = {
      gasto: micros(m.costMicros), impresiones: imp, clics: num(m.clicks), interacciones: num(m.interactions),
      vv25: Math.round(num(m.videoQuartileP25Rate) * imp), vv100: Math.round(num(m.videoQuartileP100Rate) * imp),
    };
    const s = sumByCampaign[c.id] || {};
    const diff = {};
    Object.keys(total).forEach(k => { diff[k] = Math.max(0, total[k] - (s[k] || 0)); });
    if (diff.impresiones >= 1 || diff.gasto >= 0.5) {
      rows.push({ centro, campana: c.name, grupo: TIPO_NOMBRE[tipo] || 'Otros', tipo, anuncio: 'Sin desglose por anuncio', ad_id: null, ...diff });
      remainders.push(`${c.name}: ${Math.round(diff.impresiones)} impresiones`);
    }
  }
  // Imágenes: imagen original de anuncios de imagen/display y miniatura real de YouTube
  // para anuncios de video. Si la consulta falla, el dashboard sigue sin imágenes.
  let imgError = null;
  try {
    const mediaRows = await gaql(`
      SELECT ad_group_ad.ad.id, ad_group_ad.ad.image_ad.image_url,
             ad_group_ad.ad.video_ad.video.asset, ad_group_ad.ad.video_responsive_ad.videos,
             ad_group_ad.ad.responsive_display_ad.marketing_images
      FROM ad_group_ad
      WHERE ${range} AND metrics.impressions > 0`);
    const assetOf = {}; const direct = {};
    for (const r of mediaRows) {
      const ad = (r.adGroupAd && r.adGroupAd.ad) || {};
      if (ad.imageAd && ad.imageAd.imageUrl) { direct[ad.id] = ad.imageAd.imageUrl; continue; }
      const a = (ad.videoAd && ad.videoAd.video && ad.videoAd.video.asset)
        || ((ad.videoResponsiveAd && ad.videoResponsiveAd.videos) || [])[0]?.asset
        || ((ad.responsiveDisplayAd && ad.responsiveDisplayAd.marketingImages) || [])[0]?.asset;
      if (a) assetOf[ad.id] = a;
    }
    const names = [...new Set(Object.values(assetOf))];
    const urlOf = {};
    for (let i = 0; i < names.length; i += 100) {
      const list = names.slice(i, i + 100).map(n => `'${n}'`).join(', ');
      const assets = await gaql(`
        SELECT asset.resource_name, asset.type, asset.youtube_video_asset.youtube_video_id, asset.image_asset.full_size.url
        FROM asset WHERE asset.resource_name IN (${list})`);
      for (const r of assets) {
        const as = r.asset || {};
        const yt = as.youtubeVideoAsset && as.youtubeVideoAsset.youtubeVideoId;
        if (yt) urlOf[as.resourceName] = { src: `https://i.ytimg.com/vi/${yt}/maxresdefault.jpg`, alt: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` };
        else if (as.imageAsset && as.imageAsset.fullSize && as.imageAsset.fullSize.url) urlOf[as.resourceName] = { src: as.imageAsset.fullSize.url, alt: null };
      }
    }
    rows.forEach(r => {
      if (!r.ad_id) return;
      const im = direct[r.ad_id] ? { src: direct[r.ad_id], alt: null } : (urlOf[assetOf[r.ad_id]] || {});
      r.imagen = im.src || null; r.imagen_alt = im.alt || null;
    });
  } catch (e) { imgError = e.message; }

  const daily = [];
  for (const r of dailyRows) {
    const centro = centroDe(r.campaign && r.campaign.name);
    if (!centro) continue;
    daily.push({ fecha: r.segments.date, centro, gasto: micros(r.metrics.costMicros), impresiones: num(r.metrics.impressions) });
  }

  if (q.debug) {
    const sumBy = k => rows.reduce((a, r) => { a[r.centro] = Math.round(((a[r.centro] || 0) + r[k]) * 100) / 100; return a; }, {});
    return res.status(200).json({
      cliente: cleanId(process.env.GOOGLE_ADS_CUSTOMER_ID),
      version_api: workingVersion,
      rango: { since, until },
      anuncios: adRows.length,
      filas_dashboard: rows.length,
      gasto_por_plaza: sumBy('gasto'),
      impresiones_por_plaza: sumBy('impresiones'),
      clics_por_plaza: sumBy('clics'),
      campanas_sin_plaza: [...unmatched].sort(),
      campanas_detectadas: [...new Set(rows.map(r => `${r.campana}  →  ${r.centro}, ${TIPO_NOMBRE[r.tipo] || r.tipo}`))].sort(),
      campanas_sin_desglose_por_anuncio: remainders,
      anuncios_con_imagen: rows.filter(r => r.imagen).length + ' de ' + rows.length,
      error_imagenes: imgError,
    });
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({ source: 'google', since, until, api_version: workingVersion, updated: new Date().toISOString(), rows, daily });
};
