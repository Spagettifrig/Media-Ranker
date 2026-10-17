// Test-only bridge. The real preload and real library files are never loaded.
const categories = { gameplay: 90, music: 90, feel: 90, art: 90, story: 90 };
const base = { categoryScores: categories, disabledCategories: [], descriptions: { overall: 'Keep this note' },
  genres: [], modes: [], platforms: [], mainImage: null, galleryImages: [], hoursPlayed: 42,
  firstPlayed: '', addedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', releaseYear: 2007 };
let saved = { libraries: { games: [
  { ...base, id: 'existing', title: 'Existing favourite', provider: 'igdb', providerId: '71', rank: 1 },
  { ...base, id: 'manual', title: 'Manual Game', rank: 2 },
], movies: [], series: [] }, settings: { theme: 'dark', awardsSync: 1 } };
const games = [
  { steamAppId: '400', title: 'Portal', provider: 'igdb', remoteId: '71', hours: 12 },
  { steamAppId: '570', title: 'Dota 2', provider: 'igdb', remoteId: '2963', hours: 123.4 },
  { steamAppId: '100', title: 'Unplayed Game', hours: 0 },
  { steamAppId: '101', title: 'Manual Game', hours: null },
  ...Array.from({ length: 80 }, (_, i) => ({ steamAppId: String(1000 + i), title: `Library Game ${i + 1}`, hours: 0 })),
].map((game) => ({ genreNames: [], modeIds: [], year: 2013, imageUrl: null, ...game }));
const consoleGame = (store, storeId, title, hours, platforms) => ({ store, storeId, title, hours, platforms, imageUrl: null, provider: null, remoteId: null, genreNames: [], modeIds: [], year: null });
const consoleGames = {
  psn: [consoleGame('psn', '77', 'Astro Bot', 12.5, ['ps5']), consoleGame('psn', '78', 'Manual Game', 3, ['ps4'])],
  xbox: [consoleGame('xbox', '219630713', 'Halo Infinite', null, ['xboxseries', 'pc'])],
};
window.__steamTest = { getSaved: () => saved, bumpDota: () => { games[1].hours = 200; }, pushes: [], imports: [], error: null, importDelay: 0 };
window.api = {
  getCurrentUser: async () => null,
  getAppVersion: async () => 'test',
  onAuthChange: () => () => {}, onUpdateStatus: () => () => {}, onFlush: () => () => {},
  load: async () => saved,
  save: async (_account, data) => { saved = structuredClone(data); return { ok: true }; },
  catalogReleaseYears: async () => ({ ok: true, years: {} }),
  pushReview: async (...args) => { window.__steamTest.pushes.push(args); return { ok: true }; },
  imageUrl: () => '', catalogImageUrl: () => '',
  deleteImages: async () => {}, deleteReview: async () => ({}),
  loadConsoleLibrary: async (store) => ({ ok: true, store, sessionId: `console-${store}`, games: consoleGames[store] }),
  importConsoleGames: async (sessionId, ids) => ({ ok: true, entries: consoleGames[sessionId.slice(8)].filter((game) => ids.includes(game.storeId)).map((game) => ({ ...game, file: null })) }),
  steamAccounts: async () => ({ ok: true, accounts: [{ steamId: '76561198000000000', name: 'Fixture Player', mostRecent: true, timestamp: 1 }] }),
  previewSteam: async (profile, _key, local) => (window.__steamTest.lastLocal = local, profile === 'private-user')
    ? { ok: false, error: 'Steam did not share this library. Set both your profile and Game details to Public, then try again.' }
    : { ok: true, sessionId: 'fixture', steamId: '76561198000000000', games },
  matchSteam: async (_session, ids) => ({ ok: true, games: games.filter((game) => ids.includes(game.steamAppId)) }),
  importSteam: async (_session, ids) => {
    window.__steamTest.imports.push(ids);
    await new Promise((resolve) => setTimeout(resolve, window.__steamTest.importDelay));
    if (window.__steamTest.error) return { ok: false, error: window.__steamTest.error };
    return { ok: true, entries: games.filter((game) => ids.includes(game.steamAppId)).map((game) => ({ ...game, file: null })) };
  },
};
