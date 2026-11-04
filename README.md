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

## Variables de entorno en Vercel

**Meta:** `META_ACCESS_TOKEN` (Secret), `META_AD_ACCOUNT_ID` (Config)

**Google Ads:** `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`,
`GOOGLE_ADS_REFRESH_TOKEN` (las cuatro Secret), `GOOGLE_ADS_CUSTOMER_ID` y, si se entra por un MCC,
`GOOGLE_ADS_LOGIN_CUSTOMER_ID` (Config, sin guiones).

Diagnóstico: agrega `&debug=1` a `/api/meta-data` o `/api/google-ads-data`.

## Seguridad

Los tokens de Meta, TikTok y Google **solo** van en *Environment Variables* de Vercel,
nunca en este repositorio ni en el HTML.
