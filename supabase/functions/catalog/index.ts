/**
 * Shared catalog proxy - so nobody has to register a Twitch app to use the app.
 *
 * The IGDB and TMDB credentials live here as Supabase secrets and never ship
 * inside the installer. The desktop app calls this function with the Supabase
 * anon key it already carries; the platform's own JWT check rejects anyone who
 * doesn't have it, which is the same bar as talking to the database.
 *
 * Deploying it (see supabase/functions/catalog/README.md for the full walk):
 *
 *   supabase secrets set --project-ref njxypnkamladkjtxging \
 *     TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... TMDB_TOKEN=...
 *   supabase functions deploy catalog --project-ref njxypnkamladkjtxging
 *
 * Rotating a key is a `secrets set` away - no new release, no reinstall.
 */

const TIMEOUT_MS = 12_000;

/** Apicalypse queries are small; anything larger is not this app talking. */
const MAX_IGDB_BODY = 2_000;

/**
 * The only TMDB endpoints the desktop app uses. An allowlist keeps this from
 * being a general-purpose proxy for someone else's TMDB traffic on our quota.
 */
const TMDB_PATHS = /^\/(?:search\/(?:movie|tv)|(?:movie|tv)\/\d+)$/;

/** Query params worth forwarding. Everything else is dropped, not rejected. */
const TMDB_PARAMS = new Set(['query', 'include_adult', 'page', 'language']);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set on this project.`);
  return value;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function fetchUpstream(url: string, init: RequestInit, provider: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const reason = (err as Error).name === 'AbortError' ? 'took too long to answer' : 'is unreachable';
    throw new HttpError(504, `${provider} ${reason}.`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // A rejected key is our problem, not the user's - it must never surface in
    // the app as "check your credentials in Settings", because there are none
    // to check. Rate limits pass through as themselves so the app can say so.
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(503, `${provider} search is temporarily unavailable.`);
    }
    throw new HttpError(response.status === 429 ? 429 : 502, `${provider} returned an error.`);
  }
  return response;
}

/* ------------------------------------------------------------------ *
 * IGDB - authenticated through Twitch
 * ------------------------------------------------------------------ */

/**
 * App access tokens last ~60 days. An edge instance is reused across requests
 * for as long as it stays warm, so caching here saves a Twitch round trip on
 * most calls; a cold start just fetches a fresh one.
 */
let tokenCache: { value: string; expiresAt: number } = { value: '', expiresAt: 0 };

async function igdbToken(): Promise<string> {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  const params = new URLSearchParams({
    client_id: env('TWITCH_CLIENT_ID'),
    client_secret: env('TWITCH_CLIENT_SECRET'),
    grant_type: 'client_credentials',
  });
  const response = await fetchUpstream(
    `https://id.twitch.tv/oauth2/token?${params}`,
    { method: 'POST' },
    'Twitch',
  );
  const data = await response.json();
  if (!data?.access_token) throw new HttpError(503, 'Twitch did not return an access token.');

  tokenCache = {
    value: data.access_token,
    // Expire a minute early so a long request can never race the real expiry.
    expiresAt: Date.now() + Math.max(60, (Number(data.expires_in) || 3600) - 60) * 1000,
  };
  return tokenCache.value;
}

async function igdb(payload: Record<string, unknown>) {
  const body = payload?.body;
  if (typeof body !== 'string' || !body.trim()) {
    throw new HttpError(400, 'An IGDB query body is required.');
  }
  if (body.length > MAX_IGDB_BODY) throw new HttpError(400, 'That IGDB query is too long.');

  const response = await fetchUpstream(
    'https://api.igdb.com/v4/games',
    {
      method: 'POST',
      headers: {
        'Client-ID': env('TWITCH_CLIENT_ID'),
        Authorization: `Bearer ${await igdbToken()}`,
        Accept: 'application/json',
      },
      body,
    },
    'IGDB',
  );
  return response.json();
}

/* ------------------------------------------------------------------ *
 * TMDB
 * ------------------------------------------------------------------ */
async function tmdb(payload: Record<string, unknown>) {
  const path = typeof payload?.path === 'string' ? payload.path : '';
  if (!TMDB_PATHS.test(path)) throw new HttpError(400, 'That TMDB path is not allowed.');

  const url = new URL(`https://api.themoviedb.org/3${path}`);
  const params = (payload?.params ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(params)) {
    if (TMDB_PARAMS.has(key) && value != null) url.searchParams.set(key, String(value));
  }

  const response = await fetchUpstream(
    url.toString(),
    { headers: { Authorization: `Bearer ${env('TMDB_TOKEN')}`, Accept: 'application/json' } },
    'TMDB',
  );
  return response.json();
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */
Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'POST only.' }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  try {
    switch (String(payload?.provider)) {
      case 'igdb':
        return json(await igdb(payload));
      case 'tmdb':
        return json(await tmdb(payload));
      default:
        return json({ error: 'Unknown provider.' }, 400);
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    // A missing secret lands here. Say so in the logs, stay vague to the caller.
    console.error('[catalog]', err);
    return json({ error: 'The catalog service is misconfigured.' }, 503);
  }
});
