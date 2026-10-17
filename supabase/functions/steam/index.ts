/** Public-library read only. Deploy with JWT verification enabled (the default).
 * STEAM_WEB_API_KEY is a server secret, never an installer setting. */
// CORS so the website can call this from a browser; see catalog/index.ts for why `*` is safe.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Max-Age': '86400',
};
const headers = { ...cors, 'Content-Type': 'application/json' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const recent = new Map<string, { count: number; until: number }>();

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  // Best-effort per-instance throttling; production abuse protection also belongs at the gateway.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown';
  const now = Date.now();
  for (const [key, value] of recent) if (value.until < now) recent.delete(key);
  const bucket = recent.get(ip) ?? { count: 0, until: now + 60000 };
  if (++bucket.count > 10 || recent.size > 10000) return json({ error: 'rate_limited' }, 429);
  recent.set(ip, bucket);
  const key = Deno.env.get('STEAM_WEB_API_KEY');
  if (!key) return json({ error: 'not_configured' }, 503);
  try {
    // Bound the request while reading, including chunked bodies without Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'invalid_profile' }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512) { await reader.cancel(); return json({ error: 'too_large' }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const input = JSON.parse(new TextDecoder().decode(bytes));
    const call = async (endpoint: string, params: Record<string, string>) => {
      const url = `https://api.steampowered.com/${endpoint}/v0001/?${new URLSearchParams({ key, ...params })}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('upstream');
      return response.json();
    };
    let steamId = input?.steamId;
    if (!steamId && /^[a-zA-Z0-9_-]{2,64}$/.test(input?.vanity ?? '')) {
      const data = await call('ISteamUser/ResolveVanityURL', { vanityurl: input.vanity });
      if (data?.response?.success !== 1) return json({ error: 'profile_not_found' });
      steamId = data.response.steamid;
    }
    if (typeof steamId !== 'string' || !/^[1-9]\d{16}$/.test(steamId)) return json({ error: 'invalid_profile' }, 400);
    const data = await call('IPlayerService/GetOwnedGames', {
      steamid: steamId, include_appinfo: 'true', include_played_free_games: 'true',
    });
    return json({ steamId, response: data.response });
  } catch {
    // Never log/return fetch errors: Steam URLs contain the secret.
    return json({ error: 'steam_unavailable' }, 502);
  }
});
