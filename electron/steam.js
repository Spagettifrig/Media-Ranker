'use strict';

const { randomUUID } = require('node:crypto');
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./supabase-config');

const STEAM_ID = /^[1-9]\d{16}$/;
const APP_ID = /^[1-9]\d{0,9}$/;

/** Only identifiers are accepted, never arbitrary upstream URLs. Keep IDs as strings. */
function parseProfile(input) {
  const value = String(input ?? '').trim();
  if (STEAM_ID.test(value)) return { steamId: value };
  if (/^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\//i.test(value)) {
    let url;
    try { url = new URL(value.includes('://') ? value : `https://${value}`); } catch { /* below */ }
    if (url && !url.username && !url.password && !url.port) {
      const match = url.pathname.match(/^\/(profiles|id)\/([^/]+)\/?$/);
      if (match?.[1] === 'profiles' && STEAM_ID.test(match[2])) return { steamId: match[2] };
      if (match?.[1] === 'id' && /^[a-zA-Z0-9_-]{2,64}$/.test(match[2])) return { vanity: match[2] };
    }
    throw new Error('Use your Steam profile URL, for example steamcommunity.com/id/yourname.');
  }
  if (/^[a-zA-Z0-9_-]{2,64}$/.test(value) && !/^\d+$/.test(value)) return { vanity: value };
  throw new Error('Enter a Steam profile URL, custom profile name, or 17-digit SteamID64.');
}

function normalizeLibrary(response) {
  if (!response || !Number.isInteger(response.game_count) || response.game_count < 0) {
    throw new Error('Steam did not share this library. Set both your profile and Game details to Public, then try again.');
  }
  if (response.game_count > 0 && !Array.isArray(response.games)) {
    throw new Error('Steam returned an incomplete library. Try again shortly.');
  }
  const seen = new Set();
  return (response.games ?? []).flatMap((game) => {
    const steamAppId = String(game?.appid ?? '');
    if (!APP_ID.test(steamAppId) || seen.has(steamAppId)) return [];
    seen.add(steamAppId);
    const minutes = game.playtime_forever;
    return [{
      steamAppId,
      title: typeof game.name === 'string' && game.name.trim() ? game.name.trim() : `Steam game ${steamAppId}`,
      hours: typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0
        ? Math.round(minutes / 6) / 10 : null,
      imageUrl: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_600x900.jpg`,
      provider: null, remoteId: null, genreNames: [], modeIds: [], year: null,
    }];
  }).sort((a, b) => a.title.localeCompare(b.title));
}

async function readJson(url, init = {}, fetcher = fetch) {
  try {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(20000) });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 429) throw new Error('Steam import is busy. Wait a minute and try again.');
      if (response.status === 401 || response.status === 403) throw new Error('Steam rejected the API key. Check the key and try again.');
      // Do not reflect arbitrary upstream errors: URLs may contain a key.
      throw new Error(init.method === 'POST'
        ? 'Shared Steam import is not available yet. The app owner must enable it, or you can use a personal Steam Web API key below.'
        : 'Steam could not return this library. Try again shortly.');
    }
    if (!data) throw new Error('Steam returned an unreadable response. Try again.');
    return data;
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('Steam took too long to answer. Try again.');
    if (error instanceof TypeError) throw new Error('Could not reach Steam. Check your internet connection.');
    throw error;
  }
}

async function fetchLibrary(input, personalKey = '', fetcher = fetch) {
  const profile = parseProfile(input);
  const key = String(personalKey ?? '').trim();
  if (key && !/^[a-f0-9]{32}$/i.test(key)) throw new Error('A Steam Web API key should contain 32 hexadecimal characters.');
  if (!key) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Shared Steam import is not configured. Use a personal Steam Web API key.');
    const data = await readJson(`${SUPABASE_URL}/functions/v1/steam`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify(profile),
    }, fetcher);
    if (data.error === 'profile_not_found') throw new Error('That Steam profile was not found. Check your profile URL.');
    return { steamId: data.steamId, games: normalizeLibrary(data.response) };
  }
  const call = async (endpoint, params) => readJson(
    `https://api.steampowered.com/${endpoint}/v0001/?${new URLSearchParams({ key, ...params })}`, {}, fetcher,
  );
  let steamId = profile.steamId;
  if (!steamId) {
    const data = await call('ISteamUser/ResolveVanityURL', { vanityurl: profile.vanity });
    steamId = data?.response?.steamid;
    if (data?.response?.success !== 1 || !STEAM_ID.test(steamId)) throw new Error('That Steam profile was not found. Check your profile URL.');
  }
  const data = await call('IPlayerService/GetOwnedGames', {
    steamid: steamId, include_appinfo: 'true', include_played_free_games: 'true',
  });
  return { steamId, games: normalizeLibrary(data?.response) };
}

/** Preview sessions bind import IDs/metadata to a library actually returned by Steam. */
function createImporter({ matchGames, download, fetcher = fetch }) {
  const sessions = new Map();
  function session(id) {
    const found = sessions.get(id);
    if (!found || Date.now() - found.created > 60 * 60 * 1000) {
      sessions.delete(id);
      throw new Error('This Steam preview expired. Load your library again.');
    }
    return found;
  }
  function selected(id, ids, max) {
    const current = session(id);
    if (!Array.isArray(ids) || ids.length > max) throw new Error('Steam import batch is too large.');
    return [...new Set(ids)].map((appId) => {
      const game = current.games.get(String(appId));
      if (!game) throw new Error('That game is not in this Steam preview. Load the library again.');
      return game;
    });
  }
  return {
    async preview(profile, key) {
      const result = await fetchLibrary(profile, key, fetcher);
      const id = randomUUID();
      while (sessions.size >= 2) sessions.delete(sessions.keys().next().value);
      sessions.set(id, { created: Date.now(), games: new Map(result.games.map((game) => [game.steamAppId, game])) });
      return { ...result, sessionId: id };
    },
    async match(id, ids, credentials) {
      const games = selected(id, ids, 50);
      const matches = await matchGames(games.map((game) => game.steamAppId), credentials);
      for (const game of games) {
        const match = matches[game.steamAppId];
        if (match) Object.assign(game, match, { hours: game.hours, steamAppId: game.steamAppId, imageUrl: match.imageUrl || game.imageUrl });
      }
      return games;
    },
    async importBatch(id, ids) {
      const games = selected(id, ids, 10);
      const entries = [];
      // Three concurrent downloads; each completes or times out before the next chunk.
      for (let i = 0; i < games.length; i += 3) {
        entries.push(...await Promise.all(games.slice(i, i + 3).map(async (game) => ({
          ...game, file: await download(game.imageUrl).catch(() => null),
        }))));
      }
      return entries;
    },
  };
}

module.exports = { parseProfile, normalizeLibrary, fetchLibrary, createImporter };
