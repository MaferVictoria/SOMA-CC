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

## Seguridad

Los tokens de Meta, TikTok y Google **solo** van en *Environment Variables* de Vercel,
nunca en este repositorio ni en el HTML.
