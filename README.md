# WARDOGS Hour Calculator

Plain HTML/CSS/JS PWA + a tiny Cloudflare Worker that keeps your Steam API key off the client.

```
public/   → static PWA (host on Cloudflare Pages, Netlify, GitHub Pages, …)
worker/   → Steam API proxy (Cloudflare Worker)
```

## Setup (≈10 min)

1. **Get a Steam Web API key:** https://steamcommunity.com/dev/apikey
2. **Deploy the Worker**
   ```sh
   cd worker
   npx wrangler login
   npx wrangler secret put STEAM_API_KEY   # paste key; never commit it
   npx wrangler deploy                     # note the URL, e.g. https://wardogs-api.<you>.workers.dev
   ```
3. **Point the PWA at the Worker** — replace `https://wardogs-api.YOUR-SUBDOMAIN.workers.dev` in:
   - `public/app.js` (`API_BASE`)
   - `public/index.html` (CSP `connect-src`)
   - `public/_headers` (CSP `connect-src`)
4. **Deploy `public/`** (e.g. `npx wrangler pages deploy public`), then set `ALLOWED_ORIGINS`
   in `worker/wrangler.toml` to that exact site origin and run `npx wrangler deploy` again.

Local testing: serve `public/` on `http://localhost:8000` and temporarily add that origin to `ALLOWED_ORIGINS`.

When you change any file in `public/`, bump `CACHE` in `public/sw.js` so installed copies update.

## Security notes

- Steam key lives only as a Worker secret; upstream errors are never echoed.
- Worker: exact-origin CORS allow-list, GET only, strict input regexes, per-IP rate limit, 8 s upstream timeout, returns only `{steamid, name, minutes}`.
- PWA: strict CSP (no inline script/style, no third-party anything), all DOM writes via `textContent`, no dependencies, `credentials: 'omit'`, `no-referrer`.
- Data stored: only the last 8 search terms in `localStorage` (validated on read, clearable in the UI). The service worker never caches API responses.
- Release time is hardcoded: Sept 10, 2026 16:00 UTC (`RELEASE_MS` in `app.js`).
