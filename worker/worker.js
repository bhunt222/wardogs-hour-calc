/**
 * WARDOGS Hour Calculator — Steam API proxy (Cloudflare Worker).
 *
 * GET /playtime?steamid=7656119XXXXXXXXXX
 * GET /playtime?vanity=someusername
 *  -> 200 { steamid, name, minutes }
 *  -> 4xx/5xx { error: "bad_input" | "not_found" | "private" | "not_owned" | "rate_limited" | "upstream" | ... }
 *
 * Secrets / vars (never commit the key):
 *   STEAM_API_KEY    secret  — `npx wrangler secret put STEAM_API_KEY`
 *   ALLOWED_ORIGINS  var     — comma-separated exact origins, e.g. "https://wardogs-hours.pages.dev"
 *   RATE_LIMITER     binding — optional Workers Rate Limiting binding (see wrangler.toml)
 *
 * Stores nothing about users. Responses are cached at the edge for 5 minutes
 * (keyed by SteamID only) to stay well under Steam's API limits.
 */

const WARDOGS_APP_ID = 1867240;
const ID64_RE = /^7656119\d{10}$/;
const VANITY_RE = /^[A-Za-z0-9_-]{2,32}$/;
const STEAM = 'https://api.steampowered.com';
const EDGE_TTL = 300;
const UPSTREAM_TIMEOUT_MS = 8000;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const originOk = allowed.includes(origin);

    const url = new URL(request.url);

    if (url.pathname !== '/playtime') return json({ error: 'not_found_route' }, 404, originOk ? origin : null);

    if (request.method === 'OPTIONS') {
      if (!originOk) return new Response(null, { status: 403, headers: baseHeaders(null) });
      return new Response(null, {
        status: 204,
        headers: {
          ...baseHeaders(origin),
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, originOk ? origin : null, { Allow: 'GET, OPTIONS' });
    if (!originOk) return json({ error: 'forbidden' }, 403, null);

    if (!env.STEAM_API_KEY) return json({ error: 'upstream' }, 500, origin);

    // Per-IP rate limit (optional binding).
    if (env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) return json({ error: 'rate_limited' }, 429, origin, { 'Retry-After': '60' });
      } catch {
        /* fail open on limiter errors */
      }
    }

    // Validate input: exactly one of steamid / vanity.
    const steamidParam = url.searchParams.get('steamid');
    const vanityParam = url.searchParams.get('vanity');
    if ((steamidParam === null) === (vanityParam === null)) return json({ error: 'bad_input' }, 400, origin);
    if (steamidParam !== null && !ID64_RE.test(steamidParam)) return json({ error: 'bad_input' }, 400, origin);
    if (vanityParam !== null && !VANITY_RE.test(vanityParam)) return json({ error: 'bad_input' }, 400, origin);

    try {
      const key = env.STEAM_API_KEY;
      let steamid = steamidParam;

      if (vanityParam !== null) {
        const r = await steamGet('/ISteamUser/ResolveVanityURL/v1/', { key, vanityurl: vanityParam });
        const resp = r && r.response;
        if (!resp || resp.success !== 1 || !ID64_RE.test(String(resp.steamid || ''))) {
          return json({ error: 'not_found' }, 404, origin);
        }
        steamid = String(resp.steamid);
      }

      // Edge cache, keyed only by SteamID (never includes the API key).
      const cache = caches.default;
      const cacheKey = new Request(`https://cache.internal/playtime/${steamid}`);
      const hit = await cache.match(cacheKey);
      if (hit) {
        const body = await hit.json();
        return json(body.payload, body.status, origin);
      }

      const [summary, owned] = await Promise.all([
        steamGet('/ISteamUser/GetPlayerSummaries/v2/', { key, steamids: steamid }),
        steamGet('/IPlayerService/GetOwnedGames/v1/', {
          key,
          steamid,
          include_played_free_games: '1',
          include_appinfo: '0',
          'appids_filter[0]': String(WARDOGS_APP_ID),
        }),
      ]);

      const player = summary && summary.response && Array.isArray(summary.response.players) ? summary.response.players[0] : null;

      let status;
      let payload;
      if (!player) {
        status = 404;
        payload = { error: 'not_found' };
      } else {
        const name = typeof player.personaname === 'string' ? player.personaname.slice(0, 64) : '';
        const resp = owned && owned.response;
        if (!resp || typeof resp !== 'object' || (resp.game_count === undefined && !Array.isArray(resp.games))) {
          status = 403;
          payload = { error: 'private' };
        } else {
          const game = Array.isArray(resp.games) ? resp.games.find((g) => g && g.appid === WARDOGS_APP_ID) : null;
          if (!game) {
            status = 404;
            payload = { error: 'not_owned' };
          } else {
            const minutes = Number(game.playtime_forever);
            status = 200;
            payload = { steamid, name, minutes: Number.isFinite(minutes) && minutes >= 0 ? Math.floor(minutes) : 0 };
          }
        }
      }

      // Cache successes only, so fixing privacy settings takes effect immediately.
      if (status === 200) {
        ctx.waitUntil(
          cache.put(
            cacheKey,
            new Response(JSON.stringify({ status, payload }), {
              headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${EDGE_TTL}` },
            })
          )
        );
      }

      return json(payload, status, origin);
    } catch {
      // Never echo upstream errors (could contain request URLs with the key).
      return json({ error: 'upstream' }, 502, origin);
    }
  },
};

async function steamGet(path, params) {
  const u = new URL(STEAM + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (res.status === 429) throw new Error('steam_rate_limited');
  if (!res.ok) throw new Error('steam_error');
  return res.json();
}

function baseHeaders(origin) {
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    Vary: 'Origin',
  };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(obj, status, origin, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...baseHeaders(origin), ...extra } });
}
