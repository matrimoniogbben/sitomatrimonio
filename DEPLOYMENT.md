# Deploy Vercel + Render

## Vercel

Imposta `public` come Output Directory.

Nel file `public/config.js`, sostituisci `apiBaseUrl` con l'URL HTTPS pubblico del servizio Render, senza slash finale:

```js
window.APP_CONFIG = {
  apiBaseUrl: "https://tuo-backend.onrender.com",
};
```

Questa configurazione e necessaria: Vercel ospita le pagine statiche, mentre le chiamate API devono raggiungere Render.

## Render

Configura `npm ci` come Build Command e `npm start` come Start Command. Imposta:

- `NODE_ENV=production`
- `ADMIN_USER`
- `ADMIN_PASS`
- `CORS_ORIGIN` con il dominio Vercel
- tutte le variabili `R2_*`

Con R2 configurato, quiz (domande, ordine e tentativi), messaggi e metadati foto sono persistiti nella chiave `R2_DATA_KEY`; non vengono reinizializzati durante un deploy. Il file `DATA_FILE` e un backup locale, utile anche su un Persistent Disk (`/var/data/data.json`), e viene importato in R2 solo al primo avvio quando la chiave R2 non esiste.

## Cloudflare R2

Nel CORS del bucket, autorizza il dominio Vercel con metodi `GET`, `PUT`, `HEAD` e header `Content-Type`.
