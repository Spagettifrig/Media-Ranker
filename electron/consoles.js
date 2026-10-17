'use strict';

/**
 * PlayStation and Xbox library reads. Neither has a public library API, so
 * both sign in through the platform's own page in a throwaway in-memory
 * session and call the endpoints their companion apps use. Tokens live only
 * for the length of one import and are never saved.
 */
const { randomUUID } = require('node:crypto');

const XBOX_REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
// The Xbox app's public client, the only one Xbox Live accepts without a registered partner app.
const XBOX_AUTHORIZE = `https://login.live.com/oauth20_authorize.srf?${new URLSearchParams({
  client_id: '000000004C12AE6F', redirect_uri: XBOX_REDIRECT, response_type: 'token',
  scope: 'service::user.auth.xboxlive.com::MBI_SSL', display: 'touch',
})}`;
const PSN_SIGN_IN = 'https://my.playstation.com/';
const NPSSO = /^[A-Za-z0-9]{64}$/;
const STORE_ID = /^[A-Za-z0-9_.-]{1,40}$/;
const SIGN_IN_TIMEOUT = 10 * 60 * 1000;

const IMAGE_HOSTS = {
  psn: ['.playstation.com', '.playstation.net'],
  xbox: ['.s-microsoft.com', '.xboxlive.com'],
};
const PSN_PLATFORMS = { ps4_game: 'ps4', ps5_native_game: 'ps5' };
const XBOX_PLATFORMS = { XboxOne: 'xboxone', XboxSeries: 'xboxseries', Xbox360: 'xbox360', PC: 'pc', Win32: 'pc' };

const cleanTitle = (value) => String(value ?? '').replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);

/** Only covers from the platform's own CDN, always over https. */
function coverUrl(store, value) {
  let url;
  try { url = new URL(String(value ?? '').replace(/^http:\/\//i, 'https://')); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!IMAGE_HOSTS[store].some((suffix) => url.hostname.endsWith(suffix))) return null;
  // Xbox store art is full resolution unless a width is asked for.
  if (url.hostname.endsWith('.s-microsoft.com') && !url.searchParams.has('w')) url.searchParams.set('w', '600');
  return url.toString();
}

/** "PT228H56M33S" → 229 (hours, one decimal). */
function durationHours(value) {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(value ?? ''));
  if (!match || match[0] === 'P' || match[0] === 'PT') return null;
  const [, days = 0, hours = 0, minutes = 0, seconds = 0] = match.map((part) => Number(part ?? 0));
  return Math.round((days * 24 + hours + minutes / 60 + seconds / 3600) * 10) / 10;
}

const entry = (store, storeId, title, hours, imageUrl, platforms) => ({
  store, storeId, title, hours, imageUrl: coverUrl(store, imageUrl), platforms,
  provider: null, remoteId: null, genreNames: [], modeIds: [], year: null,
});

/** PS4 and PS5 versions of one game share a concept, so they import as one entry with summed playtime. */
function normalizePsnGames(titles) {
  const games = new Map();
  for (const title of Array.isArray(titles) ? titles : []) {
    const id = String(title?.concept?.id ?? title?.titleId ?? '');
    const name = cleanTitle(title?.name ?? title?.concept?.name);
    if (!STORE_ID.test(id) || !name) continue;
    const hours = durationHours(title.playDuration);
    const platform = PSN_PLATFORMS[title.category];
    const found = games.get(id);
    if (found) {
      if (hours !== null) found.hours = Math.round(((found.hours ?? 0) + hours) * 10) / 10;
      if (platform && !found.platforms.includes(platform)) found.platforms.push(platform);
      found.imageUrl ??= coverUrl('psn', title.imageUrl);
    } else games.set(id, entry('psn', id, name, hours, title.imageUrl, platform ? [platform] : []));
  }
  return [...games.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function normalizeXboxTitles(titles) {
  const seen = new Set();
  return (Array.isArray(titles) ? titles : []).flatMap((title) => {
    const id = String(title?.titleId ?? '');
    const name = cleanTitle(title?.name);
    if (title?.type !== 'Game' || !/^\d{1,12}$/.test(id) || !name || seen.has(id)) return [];
    seen.add(id);
    const platforms = [...new Set((title.devices ?? []).map((device) => XBOX_PLATFORMS[device]).filter(Boolean))];
    return [entry('xbox', id, name, null, title.displayImage, platforms)];
  }).sort((a, b) => a.title.localeCompare(b.title));
}

async function readJson(url, init, fetcher, failure) {
  let response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(20000) });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('The sign-in service took too long to answer. Try again.');
    throw new Error('Could not reach the sign-in service. Check your internet connection.');
  }
  const data = await response.json().catch(() => null);
  // Never reflect upstream bodies: they can echo tokens.
  if (!response.ok) {
    if (response.status === 429) throw new Error('Too many requests. Wait a minute and try again.');
    throw Object.assign(new Error(failure), { status: response.status, xerr: data?.XErr });
  }
  if (!data) throw new Error('The service returned an unreadable response. Try again.');
  return data;
}

/** Microsoft account token → Xbox Live user token → XSTS token → title history. */
async function fetchXboxLibrary(accessToken, fetcher = fetch) {
  const post = (url, body) => readJson(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-xbl-contract-version': '1' },
    body: JSON.stringify(body),
  }, fetcher, 'Xbox Live did not accept the sign-in. Try again.');
  const user = await post('https://user.auth.xboxlive.com/user/authenticate', {
    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: accessToken },
  });
  let xsts;
  try {
    xsts = await post('https://xsts.auth.xboxlive.com/xsts/authorize', {
      RelyingParty: 'http://xboxlive.com', TokenType: 'JWT',
      Properties: { UserTokens: [user.Token], SandboxId: 'RETAIL' },
    });
  } catch (error) {
    if (error.xerr === 2148916233) throw new Error('This Microsoft account has no Xbox profile yet. Sign in once at xbox.com, then try again.');
    if (error.xerr === 2148916238) throw new Error('Xbox blocks this for child accounts until a parent adds it to a family group.');
    throw error;
  }
  const claims = xsts?.DisplayClaims?.xui?.[0];
  if (!claims?.uhs || !/^\d{1,20}$/.test(String(claims.xid ?? '')) || !xsts.Token) throw new Error('Xbox Live did not return your profile. Try again.');
  const history = await readJson(
    `https://titlehub.xboxlive.com/users/xuid(${claims.xid})/titles/titlehistory/decoration/detail,image?maxItems=5000`,
    { headers: { Authorization: `XBL3.0 x=${claims.uhs};${xsts.Token}`, 'x-xbl-contract-version': '2', 'Accept-Language': 'en-US', Accept: 'application/json' } },
    fetcher, 'Xbox could not return your game history. Try again shortly.',
  );
  return { account: typeof claims.gtg === 'string' ? claims.gtg.slice(0, 40) : null, games: normalizeXboxTitles(history.titles) };
}

/** NPSSO sign-in cookie → PSN access token → every PS4/PS5 game played. */
async function fetchPsnLibrary(npsso, api = require('psn-api')) {
  const token = String(npsso ?? '').trim();
  if (!NPSSO.test(token)) throw new Error('A PlayStation sign-in code has 64 letters and numbers. Copy the "npsso" value again.');
  let accessToken;
  try {
    accessToken = (await api.exchangeAccessCodeForAuthTokens(await api.exchangeNpssoForAccessCode(token))).accessToken;
  } catch {
    throw new Error('PlayStation did not accept the sign-in. Sign in again and retry.');
  }
  const titles = [];
  try {
    for (let offset = 0, page = 0; page < 50; page++) {
      const result = await api.getUserPlayedGames({ accessToken }, 'me', { limit: 200, offset, categories: 'ps4_game,ps5_native_game' });
      titles.push(...(result?.titles ?? []));
      const next = Number(result?.nextOffset);
      if (!Number.isInteger(next) || next <= offset || titles.length >= Number(result?.totalItemCount ?? 0)) break;
      offset = next;
    }
  } catch {
    throw new Error('PlayStation could not return your game list. Try again shortly.');
  }
  return { account: null, games: normalizePsnGames(titles) };
}

/** Sign-in windows run in a fresh in-memory session that is discarded afterwards. */
function signInWindow({ BrowserWindow, session, parent, url, label, onReady }) {
  return new Promise((resolve, reject) => {
    const partition = `console-sign-in-${randomUUID()}`;
    const ses = session.fromPartition(partition);
    // Some sign-in pages refuse unknown embedded browsers; present as plain Chromium.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|game-ranker|Game Ranker)\/\S+/gi, ''));
    const win = new BrowserWindow({
      parent, modal: Boolean(parent), width: 520, height: 760, autoHideMenuBar: true, title: `Sign in to ${label}`,
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let done = false;
    let cleanup = () => {};
    const timer = setTimeout(() => finish(new Error(`${label} sign-in timed out. Try again.`)), SIGN_IN_TIMEOUT);
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      if (!win.isDestroyed()) win.destroy();
      ses.clearStorageData().catch(() => {});
      if (error) reject(error); else resolve(value);
    }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => finish(new Error(`${label} sign-in was closed before it finished.`)));
    cleanup = onReady({ win, ses, finish }) ?? cleanup;
    win.loadURL(url).catch(() => { /* an intercepted redirect aborts the load */ });
  });
}

function signInXbox(electron, parent) {
  return signInWindow({ ...electron, parent, url: XBOX_AUTHORIZE, label: 'Xbox', onReady: ({ win, finish }) => {
    const check = (event, legacyUrl) => {
      const url = String(event?.url ?? legacyUrl ?? '');
      if (!url.startsWith(XBOX_REDIRECT)) return;
      event?.preventDefault?.();
      const parsed = new URL(url);
      const params = new URLSearchParams(parsed.hash.slice(1) || parsed.search.slice(1));
      const token = params.get('access_token');
      if (token) finish(null, token);
      else finish(new Error(params.get('error') === 'access_denied' ? 'Xbox sign-in was cancelled.' : 'Microsoft did not finish the sign-in. Try again.'));
    };
    win.webContents.on('will-redirect', check);
    win.webContents.on('will-navigate', check);
    win.webContents.on('did-navigate', check);
  } });
}

function signInPlayStation(electron, parent) {
  return signInWindow({ ...electron, parent, url: PSN_SIGN_IN, label: 'PlayStation', onReady: ({ ses, finish }) => {
    // Sony sets the npsso cookie once the account is signed in.
    const poll = setInterval(async () => {
      const cookies = await ses.cookies.get({ name: 'npsso' }).catch(() => []);
      const found = cookies.find((cookie) => NPSSO.test(cookie.value) && /(^|\.)sony\.com$/.test(cookie.domain ?? ''));
      if (found) finish(null, found.value);
    }, 1000);
    return () => clearInterval(poll);
  } });
}

/** Same preview-session contract as Steam: imports only accept games a real read returned. */
function createConsoleImporter({ download }) {
  const sessions = new Map();
  return {
    preview(store, result) {
      const id = randomUUID();
      while (sessions.size >= 2) sessions.delete(sessions.keys().next().value);
      sessions.set(id, { created: Date.now(), store, games: new Map(result.games.map((game) => [game.storeId, game])) });
      return { ...result, store, sessionId: id };
    },
    async importBatch(id, ids) {
      const current = sessions.get(id);
      if (!current || Date.now() - current.created > 60 * 60 * 1000) {
        sessions.delete(id);
        throw new Error('This import expired. Sign in again.');
      }
      if (!Array.isArray(ids) || ids.length > 10) throw new Error('Import batch is too large.');
      const games = [...new Set(ids.map(String))].map((storeId) => {
        const game = current.games.get(storeId);
        if (!game) throw new Error('That game is not in this import. Sign in again.');
        return game;
      });
      const entries = [];
      for (let i = 0; i < games.length; i += 3) {
        entries.push(...await Promise.all(games.slice(i, i + 3).map(async (game) => ({
          ...game, file: game.imageUrl ? await download(game.imageUrl).catch(() => null) : null,
        }))));
      }
      return entries;
    },
  };
}

module.exports = {
  durationHours, coverUrl, normalizePsnGames, normalizeXboxTitles, fetchXboxLibrary, fetchPsnLibrary,
  signInXbox, signInPlayStation, createConsoleImporter,
};
