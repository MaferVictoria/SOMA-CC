# Dashboard Paid Media · Artz, Ánima y Antara

Dashboard de resultados de pauta (Meta, TikTok y Google Ads) por centro comercial.

## Estructura

```
index.html   ← el dashboard completo (una sola página, sin build)
api/         ← (siguiente paso) funciones serverless de Vercel:
               meta-data.js, tiktok-data.js, google-ads-data.js
```

## Cómo funciona la carga de datos

El dashboard intenta leer `/api/meta-data`, `/api/tiktok-data` y `/api/google-ads-data`.
Si alguno todavía no existe o falla, esa plataforma muestra **datos de ejemplo** y la
etiqueta superior lo indica. Así se puede publicar hoy y conectar cada plataforma después.

Cada endpoint debe responder `{ "rows": [ ... ] }` con este formato por fila:

- **Meta:** centro (`artz`/`anima`/`antara`), campana, objetivo, conjunto, mes (`AAAA-MM`), anuncio, gasto, alcance, impresiones, visitas_perfil, seguidores, clics_enlace
- **TikTok:** centro, cuenta, campana, grupo, mes, anuncio, gasto, alcance, impresiones, clics, vv, vv50, vv100
- **Google:** centro, campana, grupo, tipo, mes, anuncio, impresiones, clics, interacciones, vv25, vv100

## Google Sheets

El dashboard lee el Sheet "Dash | KPI's Ánima & Artz" (compartido como lector con enlace):
- TikTok: pestañas `Query_Tik Tok ARTZ`, `Query_TikTok ANIMA`, `Query_TikTok Antara`
  (columnas Month, Date, Campaign name, Ad group name, Ad name, Cost, Reach, Impressions,
  Clicks, Video views, Video views at 50%, Video views at 100%). El mes se toma de la columna Month.
- Seguidores: pestaña `Seguidores IG` (Mes, Plaza, Anuncio, Seguimientos IG). Se empata con Meta
  por nombre de anuncio.

Si se renombra una pestaña o columna, hay que actualizar `TIKTOK_TABS` / `FOLLOW_TAB` en index.html.

## Variables de entorno en Vercel

**Meta:** `META_ACCESS_TOKEN` (Secret), `META_AD_ACCOUNT_ID` (Config)

**Google Ads:** `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`,
`GOOGLE_ADS_REFRESH_TOKEN` (las cuatro Secret), `GOOGLE_ADS_CUSTOMER_ID` y, si se entra por un MCC,
`GOOGLE_ADS_LOGIN_CUSTOMER_ID` (Config, sin guiones).

Diagnóstico: agrega `&debug=1` a `/api/meta-data` o `/api/google-ads-data`.

## Seguridad

Los tokens de Meta, TikTok y Google **solo** van en *Environment Variables* de Vercel,
nunca en este repositorio ni en el HTML.
