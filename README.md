# Magis Live – Addon Stremio (Render)

Canales en vivo de Magis con actualizacion automatica de seeds y catalogo.

## Desplegar en Render (gratis)

1. Sube esta carpeta a un repo de GitHub.
2. En https://render.com → New → Web Service.
3. Conecta el repositorio.
4. Configuracion:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance: Free
5. Create Web Service.
6. Cuando este Live, usa:
   `https://TU-SERVICIO.onrender.com/manifest.json`

## Auto-actualizacion

- Seeds: cada 30 minutos intenta descargar seeds remotos.
- Canales: cache de 5 minutos.
- Health: GET /health para keep-alive / cron.

## Keep-alive (recomendado en plan free)

En https://cron-job.org crea un job cada 10 minutos a:
`https://TU-SERVICIO.onrender.com/health`

## Nota

Magis exige cabeceras Content-Auth y Content-License.
Si el player de Nuvio/Stremio no las envia, el video puede fallar.
