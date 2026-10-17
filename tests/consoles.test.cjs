const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  durationHours, coverUrl, normalizePsnGames, normalizeXboxTitles, fetchXboxLibrary, fetchPsnLibrary, createConsoleImporter,
} = require('../electron/consoles');

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const npsso = 'a'.repeat(64);

test('PlayStation durations become hours', () => {
  assert.equal(durationHours('PT228H56M33S'), 228.9);
  assert.equal(durationHours('P1DT2H'), 26);
  assert.equal(durationHours('PT0S'), 0);
  assert.equal(durationHours('PT'), null);
  assert.equal(durationHours(undefined), null);
});

test('covers only come from the platform CDN over https', () => {
  assert.equal(coverUrl('xbox', 'http://store-images.s-microsoft.com/image/apps.1'), 'https://store-images.s-microsoft.com/image/apps.1?w=600');
  assert.equal(coverUrl('psn', 'https://image.api.playstation.com/cdn/a.png'), 'https://image.api.playstation.com/cdn/a.png');
  assert.equal(coverUrl('psn', 'https://store-images.s-microsoft.com/a.png'), null);
  assert.equal(coverUrl('xbox', 'https://evil.example/s-microsoft.com.png'), null);
  assert.equal(coverUrl('xbox', 'javascript:alert(1)'), null);
});

test('PS4 and PS5 versions of one game merge into one entry with summed playtime', () => {
  const games = normalizePsnGames([
    { titleId: 'CUSA00001_00', name: 'Astro™', category: 'ps4_game', playDuration: 'PT1H30M', concept: { id: 77 }, imageUrl: 'https://image.api.playstation.com/a.png' },
    { titleId: 'PPSA00001_00', name: 'Astro™', category: 'ps5_native_game', playDuration: 'PT2H', concept: { id: 77 } },
    { titleId: 'PPSA00002_00', name: 'Bugsnax', category: 'ps5_native_game', playDuration: 'nonsense' },
    { titleId: 'bad id!', name: 'Broken' },
    { titleId: 'PPSA00003_00', name: '   ' },
  ]);
  assert.deepEqual(games.map(({ store, storeId, title, hours, platforms }) => ({ store, storeId, title, hours, platforms })), [
    { store: 'psn', storeId: '77', title: 'Astro', hours: 3.5, platforms: ['ps4', 'ps5'] },
    { store: 'psn', storeId: 'PPSA00002_00', title: 'Bugsnax', hours: null, platforms: ['ps5'] },
  ]);
  assert.equal(games[0].imageUrl, 'https://image.api.playstation.com/a.png');
});

test('Xbox history keeps games only, mapped to platform tags', () => {
  const games = normalizeXboxTitles([
    { titleId: '219630713', name: 'Halo Infinite', type: 'Game', devices: ['XboxSeries', 'PC', 'Win32'], displayImage: 'http://store-images.s-microsoft.com/x' },
    { titleId: '219630713', name: 'Halo Infinite', type: 'Game', devices: [] },
    { titleId: '1', name: 'Netflix', type: 'App', devices: ['XboxOne'] },
    { titleId: 'abc', name: 'Odd', type: 'Game' },
  ]);
  assert.equal(games.length, 1);
  assert.deepEqual(games[0].platforms, ['xboxseries', 'pc']);
  assert.equal(games[0].hours, null);
  assert.equal(games[0].storeId, '219630713');
});

test('Xbox sign-in exchanges tokens in order and reads title history', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('user.auth')) return json({ Token: 'user-token' });
    if (url.includes('xsts')) return json({ Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: 'hash', xid: '2533274800000000', gtg: 'Gamer' }] } });
    return json({ titles: [{ titleId: '5', name: 'Forza', type: 'Game', devices: ['XboxOne'] }] });
  };
  const result = await fetchXboxLibrary('ms-token', fetcher);
  assert.equal(result.account, 'Gamer');
  assert.equal(result.games[0].title, 'Forza');
  assert.equal(JSON.parse(calls[0].init.body).Properties.RpsTicket, 'ms-token');
  assert.deepEqual(JSON.parse(calls[1].init.body).Properties.UserTokens, ['user-token']);
  assert.ok(calls[2].url.includes('xuid(2533274800000000)'));
  assert.equal(calls[2].init.headers.Authorization, 'XBL3.0 x=hash;xsts-token');
});

test('Xbox explains accounts without a profile and never echoes upstream bodies', async () => {
  const noProfile = async (url) => (url.includes('xsts') ? json({ XErr: 2148916233, Message: 'secret-token' }, 401) : json({ Token: 't' }));
  await assert.rejects(fetchXboxLibrary('x', noProfile), /no Xbox profile/);
  const failing = async () => json({ error: 'secret-token' }, 500);
  await assert.rejects(fetchXboxLibrary('x', failing), (error) => !error.message.includes('secret-token'));
});

test('PlayStation reads every page of played games with the exchanged token', async () => {
  const pages = [];
  const api = {
    exchangeNpssoForAccessCode: async (token) => { assert.equal(token, npsso); return 'code'; },
    exchangeAccessCodeForAuthTokens: async (code) => { assert.equal(code, 'code'); return { accessToken: 'access' }; },
    getUserPlayedGames: async (auth, account, options) => {
      assert.deepEqual(auth, { accessToken: 'access' });
      assert.equal(account, 'me');
      pages.push(options.offset);
      return options.offset === 0
        ? { titles: [{ titleId: 'A_00', name: 'One', category: 'ps4_game' }], totalItemCount: 2, nextOffset: 1 }
        : { titles: [{ titleId: 'B_00', name: 'Two', category: 'ps5_native_game' }], totalItemCount: 2 };
    },
  };
  const result = await fetchPsnLibrary(` ${npsso} `, api);
  assert.deepEqual(pages, [0, 1]);
  assert.deepEqual(result.games.map((game) => game.title), ['One', 'Two']);
  await assert.rejects(fetchPsnLibrary('short', api), /64 letters/);
  await assert.rejects(fetchPsnLibrary(npsso, { ...api, exchangeNpssoForAccessCode: async () => { throw new Error('raw'); } }), /did not accept/);
});

test('console imports only accept games from a real read, in small batches', async () => {
  const downloads = [];
  const importer = createConsoleImporter({ download: async (url) => { downloads.push(url); return 'cover.jpg'; } });
  const games = normalizePsnGames([{ titleId: 'A_00', name: 'One', imageUrl: 'https://image.api.playstation.com/1.png' }, { titleId: 'B_00', name: 'Two' }]);
  const { sessionId } = importer.preview('psn', { games });
  const entries = await importer.importBatch(sessionId, ['A_00', 'B_00', 'A_00']);
  assert.deepEqual(entries.map((entry) => entry.file), ['cover.jpg', null]);
  assert.deepEqual(downloads, ['https://image.api.playstation.com/1.png']);
  await assert.rejects(importer.importBatch(sessionId, ['C_00']), /not in this import/);
  await assert.rejects(importer.importBatch(sessionId, Array.from({ length: 11 }, (_, i) => String(i))), /too large/);
  await assert.rejects(importer.importBatch('missing', ['A_00']), /expired/);
});
