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
  'fields name,cover.image_id,first_release_date,genres.name,themes.name,game_modes.id,summary,' +
  'total_rating_count;';

/**
 * App access tokens last ~60 days, so one is cached for the life of the
 * process. The credential pair is part of the cache key: pasting a new client
 * secret in Settings has to invalidate the old token, not keep using it.
 */
let tokenCache = { value: null, key: '', expiresAt: 0 };

/**
 * Deliberately larger than the number of results actually shown
 * (SEARCH_DISPLAY_LIMIT): plenty of IGDB rows have no cover and get filtered
 * out, so asking for exactly what we want to show would leave a short list.
 * IGDB's own ceiling is 500.
 */
const IGDB_SEARCH_LIMIT = 100;

/**
 * The rows that are a game somebody would put on a board, rather than another
 * way of buying one they already have. `version_parent` catches the editions
 * ("Gold Edition", "The Final Cut Bundle"); `game_type` catches the rest -
 * keeping main games (0), standalone expansions (4), remakes (8), remasters
 * (9) and expanded editions (10), and dropping DLC, bundles, packs, season
 * passes, mods, episodes, ports and updates. Without it a search for Disco
 * Elysium returns six rows for what is really two games.
 *
 * `cover != null` is the same rule the results are filtered by anyway (see
 * search below), applied server-side so the row budget is not spent on
 * entries that could never be shown.
 */
const IGDB_REAL_GAMES = 'version_parent = null & game_type = (0,4,8,9,10) & cover != null';

/**
 * A name-contains clause for when IGDB's own search comes up short, which is
 * what happens to a misspelling: "Ninecraft" and "World Box" both return
 * nothing useful, because the search index matches words, not near-words.
 *
 * The needles are cheap guesses at what the user meant to type - the query
 * with its spaces closed up ("worldbox" finds WorldBox), and with the first
 * or last character dropped, so a typo at either end still leaves a long
 * enough run to match on ("inecraft" finds Minecraft). The five-character
 * prefix covers a typo in the middle; it matches broadly on purpose, and
 * ranking is what sorts the result out afterwards.
 *
 * Returns null when the query is too short for any of this to be anything but
 * noise. Needles are normalised to [a-z0-9], so they need no escaping.
 */
function igdbSpellingClause(query) {
  const compact = compactTitle(normaliseTitle(query));
  if (compact.length < 4) return null;

  const needles = new Set([compact]);
  if (compact.length >= 5) {
    needles.add(compact.slice(1));
    needles.add(compact.slice(0, -1));
  }
  if (compact.length >= 7) needles.add(compact.slice(0, 5));

  return [...needles].map((needle) => `name ~ *"${needle}"*`).join(' | ');
}

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
    // How many people rated it, used only to break ranking ties - see rank().
    popularity: Number(game.total_rating_count) || 0,
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
    popularity: Number(movie.vote_count) || 0,
    // Unlike playtime, a runtime *is* a fact about the film, so fill it in.
    hours: Number.isFinite(runtime) && runtime > 0 ? Math.round((runtime / 60) * 10) / 10 : null,
  };
}

/**
 * TMDB's television payload is the same idea under different field names -
 * `name` not `title`, `first_air_date` not `release_date` - so it needs its
 * own mapper rather than a few `??`s bolted onto `fromTmdb`.
 */
function fromTmdbTv(show) {
  const firstAir = typeof show.first_air_date === 'string' ? show.first_air_date : '';
  // A show has no single runtime; what is actually comparable between shows is
  // how long the whole thing takes to watch. Episode runtimes vary (specials,
  // double-length finales), so this averages them - and both fields are absent
  // from search results, which is why it stays null until the detail fetch.
  const runtimes = (show.episode_run_time ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const episodes = Number(show.number_of_episodes);
  const avgRuntime = runtimes.length > 0 ? runtimes.reduce((a, b) => a + b, 0) / runtimes.length : 0;
  const totalHours =
    avgRuntime > 0 && Number.isFinite(episodes) && episodes > 0
      ? Math.round(((episodes * avgRuntime) / 60) * 10) / 10
      : null;

  return {
    remoteId: String(show.id),
    title: show.name || show.original_name || 'Untitled',
    // The year it *started*, which is what a series is filed under and what
    // Series of the Year has to be decided on - a ten-year run cannot be
    // eligible in all ten.
    year: /^\d{4}/.test(firstAir) ? Number(firstAir.slice(0, 4)) : null,
    thumbUrl: tmdbImage(show.poster_path, 'w185'),
    imageUrl: tmdbImage(show.poster_path, 'w500'),
    summary: typeof show.overview === 'string' ? show.overview : '',
    genreIds: Array.isArray(show.genre_ids)
      ? show.genre_ids
      : (show.genres ?? []).map((genre) => genre?.id).filter(Number.isFinite),
    popularity: Number(show.vote_count) || 0,
    hours: totalHours,
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
 * Relevance ranking
 *
 * Providers rank by their own idea of relevance, which is good but not
 * title-aware enough: an exact title can land below a sequel, and a typo
 * ("Ninecraft") can bury the game the user obviously meant. So results are
 * re-ordered here, on the title alone, before the UI ever sees them.
 * ------------------------------------------------------------------ */

/** How many results the UI is shown. */
const SEARCH_DISPLAY_LIMIT = 50;

/**
 * The score at or above which a result is the thing the user typed, rather
 * than something that merely resembles it - an exact title, or one spaced
 * differently. Providers that can search twice use it to decide whether the
 * second search is worth making.
 */
const STRONG_MATCH = 900;

/**
 * Titles are compared with punctuation, case and accents flattened away, so
 * "Marvel's Spider-Man" and "marvel spider man" are the same string.
 */
function normaliseTitle(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Word breaks dropped entirely, so "World Box" and "WorldBox" match. */
const compactTitle = (value) => value.replace(/ /g, '');

/**
 * Edit distance, counting a swap of two neighbouring letters as one mistake
 * rather than two - "Minecarft" is one slip away from "Minecraft", and plain
 * Levenshtein would score it as far off as a genuinely different word.
 * Titles are short, so the full matrix is cheap.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let beforePrevious = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      let best = Math.min(
        previous[j] + 1, // deletion
        current[j - 1] + 1, // insertion
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, beforePrevious[j - 2] + 1); // transposition
      }
      current[j] = best;
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

/** 0 (nothing in common) to 1 (identical). */
function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 0 : 1 - editDistance(a, b) / longest;
}

/**
 * Capped at 90 so it only ever breaks ties *within* a tier - a shorter title
 * wins over a longer one that matched the same way ("Minecraft" over
 * "Minecraft Dungeons"), but never jumps a tier boundary.
 */
function lengthPenalty(query, title) {
  return Math.min(90, Math.max(0, title.length - query.length));
}

/**
 * Score one title against the query. The tiers are deliberately far apart:
 * an exact match must beat every prefix match, a prefix match must beat every
 * whole-word match, and anything only reachable by fuzzy matching sits below
 * all of them - a typo is a last resort, not a reason to outrank a real match.
 */
function relevance(query, title) {
  const q = normaliseTitle(query);
  const t = normaliseTitle(title);
  if (!q || !t) return 0;

  const qc = compactTitle(q);
  const tc = compactTitle(t);
  const penalty = lengthPenalty(qc, tc);

  if (t === q) return 1000;
  // The same title, spaced differently: "World Box" vs "WorldBox".
  if (tc === qc) return 900;
  if (t.startsWith(`${q} `) || tc.startsWith(qc)) return 800 - penalty;
  // The query as a whole word (or run of words) inside a longer title.
  if (t.includes(` ${q} `) || t.endsWith(` ${q}`)) return 700 - penalty;
  if (tc.includes(qc)) return 600 - penalty;

  // Every word of the query present, in some other order or spread out:
  // "Box World" for "World Box". Still a real match, just a weaker one than
  // the same words in the same order.
  const queryWords = q.split(' ');
  const titleWords = new Set(t.split(' '));
  if (queryWords.length > 1 && queryWords.every((word) => titleWords.has(word))) {
    return 550 - penalty;
  }

  // Nothing matched literally, so fall back to how close the spelling is:
  // "ninecraft" is one edit away from "minecraft". Individual words are
  // compared too, slightly discounted, so a typo still finds the game when
  // its real title carries a subtitle.
  let best = similarity(qc, tc);
  for (const word of t.split(' ')) {
    best = Math.max(best, similarity(qc, word) * 0.95);
  }
  // Below this it is not a misspelling, it is a different word - score it
  // zero and let the provider's own ordering decide where it lands.
  return best >= 0.6 ? Math.round(best * 500) : 0;
}

/** The best score anything in this batch manages against the query. */
function bestRelevance(query, results) {
  return results.reduce((best, result) => Math.max(best, relevance(query, result.title)), 0);
}

/**
 * Re-order by title relevance. Titles that match equally well are separated by
 * how many people have rated them, which is what decides between the game the
 * user meant and a shovelware title with a similar name - "Minecarft" is as
 * close to "MineCart" as it is to "Minecraft", and only one of those is the
 * game anybody was looking for. The provider's own order breaks any remaining
 * tie, so nothing is reshuffled without a reason.
 */
function rank(query, results) {
  return results
    .map((result, index) => ({ result, index, score: relevance(query, result.title) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.result.popularity ?? 0) - (a.result.popularity ?? 0) ||
        a.index - b.index,
    )
    .map((entry) => entry.result);
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

      const primary = (
        await igdbQuery(
          credentials,
          `search "${safe}"; ${IGDB_FIELDS} where ${IGDB_REAL_GAMES}; limit ${IGDB_SEARCH_LIMIT};`,
        )
      ).map(fromIgdb);

      // A title that matches outright is the answer; asking twice would only
      // cost a request and a round trip. Anything less - a near miss, or
      // nothing at all - is worth a second look for a misspelling.
      const clause = bestRelevance(safe, primary) >= STRONG_MATCH ? null : igdbSpellingClause(safe);
      if (!clause) return primary;

      // No `search` clause here, so this one can be sorted: most-rated first,
      // which is what makes the intended game surface out of the hundreds of
      // titles a loose spelling guess can match.
      const fuzzy = (
        await igdbQuery(
          credentials,
          `${IGDB_FIELDS} where ${IGDB_REAL_GAMES} & (${clause}); ` +
            `sort total_rating_count desc; limit ${IGDB_SEARCH_LIMIT};`,
        )
      ).map(fromIgdb);

      const seen = new Set(primary.map((result) => result.remoteId));
      return [...primary, ...fuzzy.filter((result) => !seen.has(result.remoteId))];
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

  series: {
    // Deliberately *not* 'tmdb'. Films and shows are separate id namespaces at
    // TMDB - movie 1399 and series 1399 are unrelated things - and the social
    // feed joins other users' reviews on (provider, provider_id) alone. Sharing
    // the tag would cross-match a film with a show that happened to draw the
    // same number, and hang its trophies on the wrong poster.
    id: 'tmdb_tv',
    label: 'TMDB',
    requires: ['tmdbToken'],
    async search(credentials, query) {
      const data = await tmdbGet(credentials, '/search/tv', {
        query,
        include_adult: 'false',
      });
      return (data?.results ?? []).map(fromTmdbTv);
    },
    async detail(credentials, remoteId) {
      const id = Number(remoteId);
      if (!Number.isInteger(id) || id <= 0) return null;
      // Search carries neither the episode count nor the per-episode runtime,
      // so the watch-time total genuinely needs this second call.
      return fromTmdbTv(await tmdbGet(credentials, `/tv/${id}`, {}));
    },
    async years(credentials, remoteIds) {
      const found = {};
      for (const chunk of chunked(remoteIds, TMDB_YEAR_CONCURRENCY)) {
        const settled = await Promise.allSettled(
          chunk.map((id) => tmdbGet(credentials, `/tv/${id}`, {})),
        );
        settled.forEach((outcome, index) => {
          if (outcome.status !== 'fulfilled') return;
          const firstAir = outcome.value?.first_air_date;
          if (typeof firstAir === 'string' && /^\d{4}/.test(firstAir)) {
            found[String(chunk[index])] = Number(firstAir.slice(0, 4));
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
  // Filter, then rank, then cut - so what gets shown is the best
  // SEARCH_DISPLAY_LIMIT of everything that survived, rather than whatever
  // happened to survive out of the first SEARCH_DISPLAY_LIMIT.
  const usable = results.filter((result) => result.thumbUrl);
  return rank(trimmed, usable).slice(0, SEARCH_DISPLAY_LIMIT);
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
