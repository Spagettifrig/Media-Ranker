import { test } from 'node:test';
import assert from 'node:assert/strict';

let handler;
let secret = 'a'.repeat(32);
globalThis.Deno = { env: { get: () => secret }, serve: (fn) => { handler = fn; } };
await import('../supabase/functions/steam/index.ts');
let ip = 0;
const request = (body) => new Request('https://example.test/steam', {
  method: 'POST', headers: { 'x-forwarded-for': `test-${ip++}` }, body: JSON.stringify(body),
});

test('server requires configuration and never returns the key', async () => {
  secret = '';
  const response = await handler(request({ steamId: '76561198000000000' }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'not_configured' });
  secret = 'a'.repeat(32);
});
test('server rejects other methods and oversized request bodies', async () => {
  assert.equal((await handler(new Request('https://example.test/steam'))).status, 405);
  assert.equal((await handler(request({ vanity: 'x'.repeat(1000) }))).status, 413);
  assert.equal((await handler(request({ steamId: '../bad' }))).status, 400);
});
test('server fetches only official read-only endpoints', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(new URL(url));
    return new Response(JSON.stringify({ response: urls.length === 1
      ? { success: 1, steamid: '76561198000000000' }
      : { game_count: 0 } }));
  });
  const response = await handler(request({ vanity: 'sample-user' }));
  assert.equal(response.status, 200);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.hostname === 'api.steampowered.com'));
  assert.equal(urls[1].searchParams.get('include_appinfo'), 'true');
  const data = await response.json();
  assert.equal(data.response.game_count, 0);
  assert.ok(!JSON.stringify(data).includes(secret));
});
test('server sanitizes upstream exceptions', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(`secret URL ${secret}`); });
  const response = await handler(request({ steamId: '76561198000000000' }));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'steam_unavailable' });
});
