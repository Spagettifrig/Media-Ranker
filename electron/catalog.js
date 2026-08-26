'use strict';

/**
 * Online catalog lookup: IGDB for games, TMDB for movies.
 *
 * All of it runs in the main process on purpose. The renderer never sees the
 * credentials, never makes a cross-origin request, and only ever receives a
 * normalised result shape - so the two providers stay interchangeable and the
 * UI has no idea which one it is talking to.
 *
 * Provider genre vocabulary is passed through *raw*. Mapping it onto a
 * library's own tags is a library concern, and those live in src/lib/media.js.
 */

const TIMEOUT_MS = 12000;

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */
function httpMessage(status, provider) {
  if (status === 401 || status === 403) {
    return `${provider} rejected the credentials - check them in Settings.`;
  }
  if (status === 404) return `${provider} has no entry for that.`;
  if (status === 429) return `${provider} is rate limiting. Wait a moment and try again.`;
  if (status >= 500) return `${provider} is having server trouble. Try again shortly.`;
  return `${provider} returned an error (${status}).`;
}

async function request(url, { method = 'GET', headers, body, provider }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (err) {
    // An offline app should say so plainly rather than leak a fetch stack.
    if (err.name === 'AbortError') throw new Error(`${provider} took too long to answer.`);
    throw new Error(`Could not reach ${provider}. Are you online?`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(httpMessage(response.status, provider));
  return response;
}

/* ------------------------------------------------------------------ *
 * IGDB (games) - authenticated through Twitch
 * ------------------------------------------------------------------ */
const IGDB_FIELDS =
  'fields name,cover.image_id,first_release_date,genres.name,themes.name,game_modes.id,summary;';

/**
 * App access tokens last ~60 days, so one is cached for the life of the
 * process. The credential pair is part of the cache key: pasting a new client
 * secret in Settings has to invalidate the old token, not keep using it.
 */
let tokenCache = { value: null, key: '', expiresAt: 0 };

async function igdbToken({ twitchClientId, twitchClientSecret }) {
  const key = `${twitchClientId}:${twitchClientSecret}`;
  if (tokenCache.value && tokenCache.key === key && Date.now() < tokenCache.expiresAt) {
    return tokenCache.value;
  }

  const params = new URLSearchParams({
    client_id: twitchClientId,
    client_secret: twitchClientSecret,
    grant_type: 'client_credentials',
  });
  const response = await request(`https://id.twitch.tv/oauth2/token?${params}`, {
    method: 'POST',
    provider: 'Twitch',
  });
  const data = await response.json();
  if (!data?.access_token) throw new Error('Twitch did not return an access token.');

  tokenCache = {
    value: data.access_token,
    key,
    // Expire a minute early so a long request can never race the real expiry.
    expiresAt: Date.now() + Math.max(60, (Number(data.expires_in) || 3600) - 60) * 1000,
  };
  return tokenCache.value;
}

async function igdbQuery(credentials, body) {
  const token = await igdbToken(credentials);
  const response = await request('https://api.igdb.com/v4/games', {
    method: 'POST',
    headers: {
      'Client-ID': credentials.twitchClientId,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    body,
    provider: 'IGDB',
  });
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function igdbImage(imageId, size) {
  return imageId ? `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg` : null;
}

function fromIgdb(game) {
  const imageId = game?.cover?.image_id ?? null;
  const released = Number(game?.first_release_date);
  return {
    remoteId: String(game.id),
    title: game.name || 'Untitled',
    year: Number.isFinite(released) ? new Date(released * 1000).getUTCFullYear() : null,
    thumbUrl: igdbImage(imageId, 'cover_small'),
    imageUrl: igdbImage(imageId, 'cover_big_2x'),
    summary: typeof game.summary === 'string' ? game.summary : '',
    // Themes carry Horror / Warfare / Mystery, which genres alone would miss.
    genreNames: [
      ...(game.genres ?? []).map((genre) => genre?.name),
      ...(game.themes ?? []).map((theme) => theme?.name),
    ].filter(Boolean),
    modeIds: (game.game_modes ?? []).map((mode) => mode?.id).filter(Number.isFinite),
    // Deliberately null: "hours played" is the user's own log, not a fact
    // about the game, so the database has no business filling it in.
    hours: null,
  };
}

/* ------------------------------------------------------------------ *
 * TMDB (movies)
 * ------------------------------------------------------------------ */
async function tmdbGet(credentials, pathname, params) {
  const url = new URL(`https://api.themoviedb.org/3${pathname}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await request(url, {
    headers: { Authorization: `Bearer ${credentials.tmdbToken}`, Accept: 'application/json' },
    provider: 'TMDB',
  });
  return response.json();
}

function tmdbImage(posterPath, size) {
  return posterPath ? `https://image.tmdb.org/t/p/${size}${posterPath}` : null;
}

function fromTmdb(movie) {
  const release = typeof movie.release_date === 'string' ? movie.release_date : '';
  const runtime = Number(movie.runtime);
  return {
    remoteId: String(movie.id),
    title: movie.title || movie.original_title || 'Untitled',
    year: /^\d{4}/.test(release) ? Number(release.slice(0, 4)) : null,
    thumbUrl: tmdbImage(movie.poster_path, 'w185'),
    imageUrl: tmdbImage(movie.poster_path, 'w500'),
    summary: typeof movie.overview === 'string' ? movie.overview : '',
    // Search results carry `genre_ids`; the detail payload carries `genres`.
    genreIds: Array.isArray(movie.genre_ids)
      ? movie.genre_ids
      : (movie.genres ?? []).map((genre) => genre?.id).filter(Number.isFinite),
    // Unlike playtime, a runtime *is* a fact about the film, so fill it in.
    hours: Number.isFinite(runtime) && runtime > 0 ? Math.round((runtime / 60) * 10) / 10 : null,
  };
}

/* ------------------------------------------------------------------ *
 * Release-year backfill
 *
 * Release year only started being stored when the awards needed it, so every
 * item added before that has none - and Game of the Year is decided on it.
 * These fill the gap in bulk for things that already carry a catalog id.
 * ------------------------------------------------------------------ */

/** IGDB's own ceiling on `limit` is 500; 200 keeps the query string sane. */
const IGDB_YEAR_CHUNK = 200;
/** TMDB is one request per film, so this is a politeness limit, not a batch size. */
const TMDB_YEAR_CONCURRENCY = 4;
/** Nothing is backfilled beyond this in one pass, so a huge board cannot stall a launch. */
const YEAR_BACKFILL_CAP = 400;

function chunked(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ *
 * Providers, keyed by library
 * ------------------------------------------------------------------ */
const PROVIDERS = {
  games: {
    id: 'igdb',
    label: 'IGDB',
    // Field names as they are stored in settings, in the order Settings shows them.
    requires: ['twitchClientId', 'twitchClientSecret'],
    async search(credentials, query) {
      // Apicalypse has no escape syntax for the search string; dropping quotes
      // and backslashes is enough to keep the clause well-formed.
      const safe = query.replace(/["\\]/g, ' ').trim();
      if (!safe) return [];
      return (await igdbQuery(credentials, `search "${safe}"; ${IGDB_FIELDS} limit 24;`)).map(fromIgdb);
    },
    async detail(credentials, remoteId) {
      const id = Number(remoteId);
      if (!Number.isInteger(id) || id <= 0) return null;
      const [game] = await igdbQuery(credentials, `where id = ${id}; ${IGDB_FIELDS} limit 1;`);
      return game ? fromIgdb(game) : null;
    },
    // Apicalypse takes an id list, so a whole board's worth of missing years
    // costs a handful of requests rather than one per game.
    async years(credentials, remoteIds) {
      const found = {};
      for (const chunk of chunked(remoteIds, IGDB_YEAR_CHUNK)) {
        const rows = await igdbQuery(
          credentials,
          `fields id,first_release_date; where id = (${chunk.join(',')}); limit ${IGDB_YEAR_CHUNK};`,
        );
        for (const row of rows) {
          const released = Number(row?.first_release_date);
          if (Number.isFinite(released)) {
            found[String(row.id)] = new Date(released * 1000).getUTCFullYear();
          }
        }
      }
      return found;
    },
  },

  movies: {
    id: 'tmdb',
    label: 'TMDB',
    requires: ['tmdbToken'],
    async search(credentials, query) {
      const data = await tmdbGet(credentials, '/search/movie', {
        query,
        include_adult: 'false',
      });
      return (data?.results ?? []).map(fromTmdb);
    },
    async detail(credentials, remoteId) {
      const id = Number(remoteId);
      if (!Number.isInteger(id) || id <= 0) return null;
      // The search payload has no runtime, so the detail endpoint is a real
      // second call rather than something we could have cached from the list.
      return fromTmdb(await tmdbGet(credentials, `/movie/${id}`, {}));
    },
    // TMDB has no batch endpoint, so this really is one request per film -
    // run a few at a time and let a single failure drop that one film rather
    // than the whole backfill.
    async years(credentials, remoteIds) {
      const found = {};
      for (const chunk of chunked(remoteIds, TMDB_YEAR_CONCURRENCY)) {
        const settled = await Promise.allSettled(
          chunk.map((id) => tmdbGet(credentials, `/movie/${id}`, {})),
        );
        settled.forEach((outcome, index) => {
          if (outcome.status !== 'fulfilled') return;
          const release = outcome.value?.release_date;
          if (typeof release === 'string' && /^\d{4}/.test(release)) {
            found[String(chunk[index])] = Number(release.slice(0, 4));
          }
        });
      }
      return found;
    },
  },
};

/** Which required credentials are still blank for this library. */
function missing(libraryKey, credentials) {
  const provider = PROVIDERS[libraryKey];
  if (!provider) return [];
  return provider.requires.filter((key) => !credentials?.[key]);
}

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */
function status(libraryKey, credentials) {
  const provider = PROVIDERS[libraryKey];
  if (!provider) return { supported: false, provider: null, missing: [] };
  const gaps = missing(libraryKey, credentials);
  return { supported: true, provider: provider.label, ready: gaps.length === 0, missing: gaps };
}

async function search(libraryKey, query, credentials) {
  const provider = PROVIDERS[libraryKey];
  if (!provider) throw new Error('This library has no online catalog.');
  const gaps = missing(libraryKey, credentials);
  if (gaps.length > 0) throw new Error(`Add your ${provider.label} credentials in Settings first.`);

  const trimmed = String(query ?? '').trim();
  if (trimmed.length < 2) return [];

  const results = await provider.search(credentials, trimmed);
  // An entry with no art is nearly useless on a board of covers, and the
  // providers return plenty of those (demos, betas, regional duplicates).
  return results.filter((result) => result.thumbUrl);
}

async function detail(libraryKey, remoteId, credentials) {
  const provider = PROVIDERS[libraryKey];
  if (!provider) throw new Error('This library has no online catalog.');
  const gaps = missing(libraryKey, credentials);
  if (gaps.length > 0) throw new Error(`Add your ${provider.label} credentials in Settings first.`);
  const entry = await provider.detail(credentials, remoteId);
  // Tags the entry with which provider resolved it, so it can be pushed to
  // the social feed under a stable, cross-user identity (see model.js).
  return entry ? { ...entry, provider: provider.id } : entry;
}

/**
 * Release years for a batch of catalog ids, as { remoteId: year }. Anything
 * the provider has no answer for is simply absent - a missing year is not an
 * error, it just means that item stays out of the release-year categories.
 */
async function releaseYears(libraryKey, remoteIds, credentials) {
  const provider = PROVIDERS[libraryKey];
  if (!provider?.years) return {};
  if (missing(libraryKey, credentials).length > 0) return {};

  const ids = [...new Set((remoteIds ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    .slice(0, YEAR_BACKFILL_CAP);
  if (ids.length === 0) return {};

  return provider.years(credentials, ids);
}

module.exports = { search, detail, status, releaseYears };
