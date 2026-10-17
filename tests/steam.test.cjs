const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseProfile, normalizeLibrary, fetchLibrary, createImporter, parseLoginUsers, detectAccounts, parseAppInfo, readLocalLibrary } = require('../electron/steam');

const steamId = '76561198000000000';
const key = 'a'.repeat(32);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const owned = { game_count: 2, games: [{ appid: 400, name: 'Portal', playtime_forever: 95 }, { appid: 570, name: 'Dota 2' }] };


const path = require('node:path');

/** Builds a minimal format-29 appinfo.vdf: entries with appinfo.common.{name,type}, then the string table. */
function appInfoFixture(apps) {
  const strings = ['appinfo', 'common', 'name', 'type'];
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const str = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
  for (const [id, name, type] of apps) {
    const kv = Buffer.concat([
      Buffer.from([0]), u32(0), Buffer.from([0]), u32(1),
      Buffer.from([1]), u32(2), str(name), Buffer.from([1]), u32(3), str(type),
      Buffer.from([8, 8, 8]),
    ]);
    const body = Buffer.concat([Buffer.alloc(60), kv]);
    parts.push(u32(id), u32(body.length), body);
  }
  parts.push(u32(0));
  const entries = Buffer.concat(parts);
  const table = Buffer.concat([u32(strings.length), ...strings.map(str)]);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(0x07564429, 0);
  header.writeUInt32LE(1, 4);
  header.writeBigInt64LE(BigInt(16 + entries.length), 8);
  return Buffer.concat([header, entries, table]);
}

test('parses SteamID64 without converting it to a lossy number', () => {
  assert.deepEqual(parseProfile(` ${steamId} `), { steamId });
  assert.deepEqual(parseProfile(`https://steamcommunity.com/profiles/${steamId}/?x=1`), { steamId });
});
test('accepts vanity name and profile URL with or without scheme', () => {
  assert.deepEqual(parseProfile('https://steamcommunity.com/id/test_name/'), { vanity: 'test_name' });
  assert.deepEqual(parseProfile('steamcommunity.com/id/test-name'), { vanity: 'test-name' });
  assert.deepEqual(parseProfile('test-name'), { vanity: 'test-name' });
});
test('rejects arbitrary URLs, path traversal, credentials, malformed IDs and empty input', () => {
  for (const value of ['', '1234', 'STEAM_0:1:123', 'https://evil.test/id/user',
    'https://steamcommunity.com.evil.test/id/user', 'https://steamcommunity.com@evil.test/id/user',
    'https://steamcommunity.com/id/a/b', 'http://steamcommunity.com:8080/id/user']) {
    assert.throws(() => parseProfile(value));
  }
});
test('normalizes minutes to hours and keeps unavailable time distinct from zero', () => {
  const games = normalizeLibrary({ ...owned, games: [...owned.games, { appid: 10, name: 'Counter-Strike', playtime_forever: 0 }] });
  assert.equal(games.find((game) => game.steamAppId === '400').hours, 1.6);
  assert.equal(games.find((game) => game.steamAppId === '570').hours, null);
  assert.equal(games.find((game) => game.steamAppId === '10').hours, 0);
});
test('malformed/duplicate app IDs never become import entries', () => {
  assert.equal(normalizeLibrary({ game_count: 6, games: [...owned.games, owned.games[0], { appid: -1 }, { appid: '../x' }, {}] }).length, 2);
});
test('empty and private libraries are different outcomes', () => {
  assert.deepEqual(normalizeLibrary({ game_count: 0 }), []);
  for (const value of [null, {}, { game_count: 1 }]) assert.throws(() => normalizeLibrary(value));
});
test('personal key stays on the official Steam API path and resolves vanity', async () => {
  const urls = [];
  const result = await fetchLibrary('test-user', key, async (url) => {
    urls.push(new URL(url));
    return json({ response: urls.length === 1 ? { success: 1, steamid: steamId } : owned });
  });
  assert.equal(result.games.length, 2);
  assert.equal(result.steamId, steamId);
  assert.equal(urls[0].hostname, 'api.steampowered.com');
  assert.equal(urls[0].searchParams.get('vanityurl'), 'test-user');
  assert.equal(urls[1].searchParams.get('steamid'), steamId);
  assert.equal(urls[1].searchParams.get('include_played_free_games'), 'true');
  assert.ok(!JSON.stringify(result).includes(key));
});
test('shared path sends no personal key and returns the same normalized shape', async () => {
  const result = await fetchLibrary(steamId, '', async (url, init) => {
    assert.ok(url.endsWith('/functions/v1/steam'));
    assert.deepEqual(JSON.parse(init.body), { steamId });
    return json({ steamId, response: owned });
  });
  assert.equal(result.games[0].steamAppId, '570');
});
test('shared function not deployed/configured gives an actionable error', async () => {
  await assert.rejects(fetchLibrary(steamId, '', async () => json({}, 404)), /app owner must enable/);
});
test('missing vanity profile does not request owned games', async () => {
  let calls = 0;
  await assert.rejects(fetchLibrary('missing-user', key, async () => { calls++; return json({ response: { success: 42 } }); }), /not found/);
  assert.equal(calls, 1);
});
test('invalid key fails before networking', async () => {
  await assert.rejects(fetchLibrary(steamId, 'wrong', async () => { throw new Error('must not fetch'); }), /32 hexadecimal/);
});
test('upstream errors never reflect key-bearing error bodies', async () => {
  await assert.rejects(fetchLibrary(steamId, key, async () => json({ error: key }, 500)), (error) => !error.message.includes(key));
  await assert.rejects(fetchLibrary(steamId, key, async () => json({}, 429)), /Wait a minute/);
  await assert.rejects(fetchLibrary(steamId, key, async () => { throw new TypeError(`bad fetch ${key}`); }), /internet/);
});
test('preview sessions constrain imports, preserve playtime and allow unmatched covers', async () => {
  const importer = createImporter({
    fetcher: async () => json({ steamId, response: owned }),
    matchGames: async () => ({ '400': { provider: 'igdb', remoteId: '71', title: 'Portal', hours: null, imageUrl: null } }),
    download: async () => { throw new Error('offline'); },
  });
  const preview = await importer.preview(steamId);
  const matched = await importer.match(preview.sessionId, ['400'], {});
  assert.equal(matched[0].hours, 1.6);
  assert.ok(matched[0].imageUrl.includes('/400/'));
  assert.equal(matched[0].remoteId, '71');
  assert.equal((await importer.importBatch(preview.sessionId, ['400']))[0].file, null);
  await assert.rejects(importer.importBatch(preview.sessionId, ['999']), /not in this Steam preview/);
  await assert.rejects(importer.importBatch(preview.sessionId, Array(11).fill('400')), /too large/);
  await assert.rejects(importer.importBatch('missing', ['400']), /expired/);
});
test('cover downloads have bounded concurrency', async () => {
  let active = 0, peak = 0;
  const importer = createImporter({
    fetcher: async () => json({ steamId, response: { game_count: 10, games: Array.from({ length: 10 }, (_, i) => ({ appid: i + 1 })) } }),
    matchGames: async () => ({}),
    download: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return 'cover.jpg'; },
  });
  const preview = await importer.preview(steamId);
  const entries = await importer.importBatch(preview.sessionId, preview.games.map((game) => game.steamAppId));
  assert.equal(entries.length, 10);
  assert.equal(peak, 3);
});
test('unrated reviews are rejected before any cloud access', async () => {
  const filename = require.resolve('../electron/supabase');
  const source = require('node:fs').readFileSync(filename, 'utf8');
  const actualRequire = require('node:module').createRequire(filename);
  const module = { exports: {} };
  const isolatedRequire = (name) => {
    if (name === 'electron') return { app: { getPath: () => require('node:os').tmpdir() } };
    if (name === '@supabase/supabase-js') return { createClient: () => { throw new Error('Must not access cloud'); } };
    return actualRequire(name);
  };
  require('node:vm').runInNewContext(`(function(require, module, exports) { ${source}\n})`)(isolatedRequire, module, module.exports);
  const { pushReview } = module.exports;
  const result = await pushReview('games', { unrated: true, provider: 'igdb', providerId: '71' });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});

test('IGDB matching checks Steam source and refuses ambiguous identities', async (t) => {
  const game = (id, uid, source = 'Steam') => ({ id, name: `Game ${id}`, external_games: [{ uid, external_game_source: { name: source } }] });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { body } = JSON.parse(init.body);
    assert.ok(body.includes('external_games.external_game_source.name'));
    assert.ok(body.length <= 2000);
    return json([game(71, '400'), game(81, '570'), game(82, '570'), game(83, '730', 'GOG')]);
  });
  const matches = await require('../electron/catalog').steamMatches(['400', '570', '730'], {});
  assert.equal(matches['400'].remoteId, '71');
  assert.equal(matches['570'], undefined);
  assert.equal(matches['730'], undefined);
});
test('a truncated IGDB candidate list is not treated as an unambiguous match', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json(Array.from({ length: 500 }, (_, id) => ({ id, name: 'Game' }))));
  assert.deepEqual(await require('../electron/catalog').steamMatches(['400'], {}), {});
});

test('detected Steam accounts come from loginusers.vdf, most recent first, with invalid IDs dropped', async () => {
  const vdf = `"users"\n{\n\t"76561198000000001"\n\t{\n\t\t"AccountName"\t\t"josh"\n\t\t"PersonaName"\t\t"Jo \\"sh\\""\n\t\t"MostRecent"\t\t"0"\n\t\t"Timestamp"\t\t"5"\n\t}\n\t"76561198000000002"\n\t{\n\t\t"AccountName"\t\t"alt"\n\t\t"MostRecent"\t\t"1"\n\t}\n\t"123"\n\t{\n\t}\n}`;
  assert.deepEqual(parseLoginUsers(vdf).map(({ steamId, name }) => [steamId, name]),
    [['76561198000000002', 'alt'], ['76561198000000001', 'Jo "sh"']]);
  const reads = [];
  const accounts = await detectAccounts({ steamPath: async () => '/steam', readFile: async (file) => {
    reads.push(file);
    if (file.startsWith('/steam')) return vdf;
    throw new Error('missing');
  } });
  assert.equal(accounts.length, 2);
  assert.ok(reads[0].endsWith('loginusers.vdf'));
  assert.deepEqual(await detectAccounts({ steamPath: async () => null, readFile: async () => { throw new Error('missing'); } }), []);
  assert.deepEqual(parseLoginUsers('not a vdf {'), []);
});

test('appinfo.vdf (format 29) yields app names and types', () => {
  const buffer = appInfoFixture([[440, 'Team Fortress 2', 'Game'], [228980, 'Steamworks Common Redistributables', 'Config'], [570, 'Dota 2', 'game']]);
  const apps = parseAppInfo(buffer);
  assert.deepEqual(apps.get('440'), { name: 'Team Fortress 2', type: 'game' });
  assert.equal(apps.get('228980').type, 'config');
  assert.equal(apps.size, 3);
  assert.equal(parseAppInfo(Buffer.from('nope, not appinfo')).size, 0);
  assert.equal(parseAppInfo(buffer.subarray(0, 40)).size, 0);
});

test('a detected account library is read from Steam on this PC without a key', async () => {
  const files = {
    [path.join('/steam', 'config', 'loginusers.vdf')]: `"users" { "76561199384249694" { "PersonaName" "Spagetti" "MostRecent" "1" } }`,
    [path.join('/steam', 'appcache', 'appinfo.vdf')]: appInfoFixture([[440, 'Team Fortress 2', 'Game'], [228980, 'Redist', 'Config'], [570, 'Dota 2', 'game'], [620, 'Portal 2', 'Game']]),
    [path.join('/steam', 'userdata', '1423983966', 'config', 'localconfig.vdf')]:
      `"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "440" { "playtime" "95" } "228980" { "playtime" "3" } "570" { "LastPlayed" "1" } } } } } }`,
  };
  const options = {
    steamPath: async () => '/steam',
    readFile: async (file) => { if (file in files) return files[file]; throw new Error('missing'); },
    readdir: async () => ['620', '440', 'not-an-app'],
  };
  const result = await readLocalLibrary('76561199384249694', options);
  assert.deepEqual(result.games.map((game) => [game.steamAppId, game.title, game.hours]),
    [['570', 'Dota 2', null], ['620', 'Portal 2', null], ['440', 'Team Fortress 2', 1.6]]);
  await assert.rejects(readLocalLibrary('76561198000000000', options), /not signed in on this PC/);
  await assert.rejects(readLocalLibrary('76561199384249694', { ...options, readFile: async (file) => {
    if (file.endsWith('loginusers.vdf')) return files[file];
    throw new Error('missing');
  } }), /Open Steam once/);
});
