/**
 * `window.api` for the browser.
 *
 * The desktop app talks to its Electron main process through the bridge in
 * electron/preload.js. The website has no main process, so this file is that
 * bridge's twin: the same method names, the same `{ ok, ... }` result shapes,
 * backed by browser equivalents instead of the file system. The React app in
 * src/ cannot tell which one it is talking to, apart from `platform`.
 *
 * The cloud and catalog code is not duplicated - supabase.js, awards.js,
 * catalog.js and steam.js are imported straight out of electron/ (see the
 * aliases in vite.web.config.mjs for the two places they touch Node).
 *
 * What changes on the web:
 *   - Library data lives in IndexedDB instead of data.json.
 *   - Catalog and cloud covers are shown from the provider's own image host
 *     instead of being downloaded into an images folder, so `item.mainImage`
 *     can be an https URL as well as a stored file name.
 *   - Photos you add yourself are kept as Blobs in IndexedDB.
 *   - Exports download (or open the share sheet on a phone) instead of
 *     going through a save dialog.
 *   - There is no auto-updater: a new deploy is picked up on the next visit.
 */

import catalog from '../../electron/catalog.js';
import steam from '../../electron/steam.js';
import supabase from '../../electron/supabase.js';
import awards from '../../electron/awards.js';
import { IMAGES, STATE, idbDelete, idbGet, idbKeys, idbPut } from './idb.js';
import { version } from '../../package.json';

/* ------------------------------------------------------------------ *
 * Remote images
 * ------------------------------------------------------------------ */

/**
 * The only hosts a remote cover may be shown from - catalog art, plus the
 * Steam store art a Steam import falls back to. Same idea as
 * CATALOG_IMAGE_HOSTS in main.js: cover URLs can come from other people's
 * reviews, and this keeps them from being a way to load anything else.
 */
const REMOTE_IMAGE_HOSTS = new Set([
  'images.igdb.com',
  'image.tmdb.org',
  'shared.fastly.steamstatic.com',
]);

const EXTERNAL_HOSTS = new Set(['buymeacoffee.com', 'www.buymeacoffee.com']);

function remoteImage(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  try {
    const parsed = new URL(url);
    return REMOTE_IMAGE_HOSTS.has(parsed.hostname) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Stored image name -> object URL, filled from IndexedDB on the first load. */
const objectUrls = new Map();
let imagesHydrated = null;

function hydrateImages() {
  if (!imagesHydrated) {
    imagesHydrated = (async () => {
      try {
        const names = await idbKeys(IMAGES);
        await Promise.all(
          names.map(async (name) => {
            const blob = await idbGet(IMAGES, name);
            if (blob) objectUrls.set(name, URL.createObjectURL(blob));
          }),
        );
      } catch (err) {
        console.error('[game-ranker] could not read stored images:', err);
      }
    })();
  }
  return imagesHydrated;
}

/* ------------------------------------------------------------------ *
 * Adding your own photos
 * ------------------------------------------------------------------ */

/**
 * Phone cameras produce 4000px, 5 MB photos. A cover is never drawn larger
 * than a few hundred pixels, so anything bigger is scaled down once on the way
 * in - it keeps the board fast and IndexedDB small.
 */
const MAX_IMAGE_EDGE = 1600;

async function shrink(file) {
  if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
      bitmap.close?.();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    return blob ?? file;
  } catch {
    // A format the browser cannot decode (HEIC on desktop Chrome) is kept as
    // it is; it may still display on the device that took it.
    return file;
  }
}

function extensionFor(type) {
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  if (type.includes('gif')) return '.gif';
  return '.jpg';
}

function chooseFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

async function pickImages() {
  const files = await chooseFiles();
  const stored = [];
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const blob = await shrink(file);
    const name = `${crypto.randomUUID()}${extensionFor(blob.type || file.type)}`;
    try {
      await idbPut(IMAGES, name, blob);
      objectUrls.set(name, URL.createObjectURL(blob));
      stored.push({ file: name, sourceName: file.name.replace(/\.[^.]+$/, '') });
    } catch (err) {
      console.error('[game-ranker] could not store image:', file.name, err);
    }
  }
  return stored;
}

async function deleteImages(names) {
  if (!Array.isArray(names)) return false;
  for (const name of names) {
    if (typeof name !== 'string' || !objectUrls.has(name)) continue;
    URL.revokeObjectURL(objectUrls.get(name));
    objectUrls.delete(name);
    try {
      await idbDelete(IMAGES, name);
    } catch {}
  }
  return true;
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/** For the ranking export, which needs pixels it is allowed to read back. */
async function readImage(name) {
  if (typeof name !== 'string' || !name) return null;
  try {
    const local = await idbGet(IMAGES, name);
    if (local) return blobToDataUrl(local);
    const remote = remoteImage(name);
    if (!remote) return null;
    // Only works where the image host sends CORS headers. Where it does not,
    // the export draws that card without its cover rather than failing.
    const response = await fetch(remote, { mode: 'cors' });
    if (!response.ok) return null;
    return blobToDataUrl(await response.blob());
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Library data - the same rules as data:load / data:save in main.js
 * ------------------------------------------------------------------ */
const DATA_VERSION = 3;
const LOCAL_KEY = 'local';
const accountKey = (accountId) => `account:${String(accountId).replace(/[^a-zA-Z0-9-]/g, '')}`;
const emptyLibraries = () => ({ games: [], movies: [], series: [] });

function arraysOnly(libraries) {
  const out = {};
  for (const [key, value] of Object.entries(libraries ?? {})) {
    if (Array.isArray(value)) out[key] = value;
  }
  return { ...emptyLibraries(), ...out };
}

function hasAnyItems(libraries) {
  return Object.values(libraries ?? {}).some((list) => Array.isArray(list) && list.length > 0);
}

let localState = null;

async function loadLocalState() {
  if (localState) return localState;
  let saved = null;
  try {
    saved = await idbGet(STATE, LOCAL_KEY);
  } catch (err) {
    console.error('[game-ranker] could not read saved data:', err);
  }
  localState = {
    version: DATA_VERSION,
    libraries: arraysOnly(saved?.libraries),
    settings: saved?.settings && typeof saved.settings === 'object' ? saved.settings : {},
    claimedBy: typeof saved?.claimedBy === 'string' ? saved.claimedBy : null,
  };
  return localState;
}

/** Writes go through one queue, so a burst of autosaves lands in order. */
let writeChain = Promise.resolve();

function queueWrite(task) {
  writeChain = writeChain.then(task).catch((err) => {
    console.error('[game-ranker] failed to persist data:', err);
  });
  return writeChain;
}

/**
 * Personal Twitch credentials cannot be used from a web page - Twitch and
 * IGDB refuse cross-origin requests - so games always go through the shared
 * catalog function here. A personal TMDB token still works.
 */
function credentialsFrom(settings) {
  const token = settings?.tmdbToken;
  return typeof token === 'string' && token.trim() ? { tmdbToken: token.trim() } : {};
}

let credentials = {};

async function load(accountId = null) {
  await hydrateImages();
  const local = await loadLocalState();
  credentials = credentialsFrom(local.settings);
  if (!accountId) {
    return { version: DATA_VERSION, libraries: local.libraries, settings: local.settings };
  }

  let libraries = null;
  try {
    const saved = await idbGet(STATE, accountKey(accountId));
    if (saved?.libraries) libraries = arraysOnly(saved.libraries);
  } catch {}
  if (!libraries) {
    // First sign-in in this browser: the signed-out library goes to whoever
    // signs in first and to nobody after that, exactly as on the desktop.
    if (!local.claimedBy && hasAnyItems(local.libraries)) {
      libraries = local.libraries;
      local.claimedBy = accountId;
      local.libraries = emptyLibraries();
      await queueWrite(async () => {
        await idbPut(STATE, accountKey(accountId), { version: DATA_VERSION, libraries });
        await idbPut(STATE, LOCAL_KEY, local);
      });
    } else {
      libraries = emptyLibraries();
    }
  }
  return { version: DATA_VERSION, libraries, settings: local.settings };
}

async function save(accountId, state) {
  if (!state || !state.libraries || typeof state.libraries !== 'object') return false;
  const libraries = arraysOnly(state.libraries);
  const local = await loadLocalState();
  local.settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
  credentials = credentialsFrom(local.settings);
  if (!accountId) local.libraries = libraries;
  // Structured clone, not JSON: IndexedDB copies the value as it is written,
  // so later edits in React can never reach back into a queued save.
  const snapshot = { ...local };
  await queueWrite(async () => {
    if (accountId) await idbPut(STATE, accountKey(accountId), { version: DATA_VERSION, libraries });
    await idbPut(STATE, LOCAL_KEY, snapshot);
  });
  return true;
}

/* ------------------------------------------------------------------ *
 * Steam
 * ------------------------------------------------------------------ */

/** Covers stay on Steam's / IGDB's servers, so "downloading" one is just keeping its URL. */
const keepUrl = async (url) => remoteImage(url);

const steamImporter = steam.createImporter({ matchGames: catalog.steamMatches, download: keepUrl });

async function steamResult(task) {
  try {
    return { ok: true, ...(await task()) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */
async function saveExport(payload) {
  const bytes = payload?.bytes;
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) {
    return { saved: false, error: 'Nothing to save.' };
  }
  const ext = payload?.ext === 'jpg' ? 'jpg' : 'png';
  const type = ext === 'jpg' ? 'image/jpeg' : 'image/png';
  const fileName = String(payload?.fileName || `ranking.${ext}`).replace(/[\\/]/g, '_');
  const blob = new Blob([bytes], { type });

  // On a phone, the share sheet is where "Save image" lives. It needs a
  // recent tap, which a slow render can outlast - so any failure other than
  // the user closing the sheet falls through to a plain download.
  const file = typeof File === 'function' ? new File([blob], fileName, { type }) : null;
  if (file && navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file] });
      return { saved: true };
    } catch (err) {
      if (err?.name === 'AbortError') return { saved: false };
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { saved: true };
}

/* ------------------------------------------------------------------ *
 * The bridge
 * ------------------------------------------------------------------ */
const noop = () => {};

const api = {
  platform: 'web',

  load,
  save,

  /**
   * A tab can be closed or a phone can freeze it at any moment, and there is
   * no window to hold open while a save lands. The best a page gets is
   * `pagehide` / going hidden, so the final save is fired from both.
   */
  onFlush: (callback) => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') callback();
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', callback);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', callback);
    };
  },
  flushed: noop,

  pickImages,
  deleteImages,
  readImage,
  saveExport,
  showItemInFolder: async () => false,

  openExternal: async (url) => {
    if (typeof url !== 'string' || url.length > 2000) return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:' || !EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase())) {
      return false;
    }
    window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    return true;
  },

  catalogStatus: async (libraryKey) => catalog.status(String(libraryKey ?? ''), credentials),

  previewSteam: (profile, key) =>
    steamResult(async () => {
      if (String(key ?? '').trim()) {
        throw new Error(
          'Personal Steam keys only work in the desktop app. Leave the key empty to use the shared Steam import.',
        );
      }
      return steamImporter.preview(profile, '');
    }),
  matchSteam: (sessionId, ids) =>
    steamResult(async () => ({ games: await steamImporter.match(sessionId, ids, credentials) })),
  importSteam: (sessionId, ids) =>
    steamResult(async () => ({ entries: await steamImporter.importBatch(sessionId, ids) })),

  searchCatalog: async (libraryKey, query) => {
    try {
      return { ok: true, results: await catalog.search(String(libraryKey ?? ''), query, credentials) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  importFromCatalog: async (libraryKey, remoteId) => {
    try {
      const entry = await catalog.detail(String(libraryKey ?? ''), remoteId, credentials);
      if (!entry) return { ok: false, error: 'That entry could not be loaded.' };
      return { ok: true, entry: { ...entry, file: remoteImage(entry.imageUrl) } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  catalogReleaseYears: async (libraryKey, remoteIds) => {
    try {
      return {
        ok: true,
        years: await catalog.releaseYears(String(libraryKey ?? ''), remoteIds, credentials),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  imageUrl: (name) => (name ? (objectUrls.get(name) ?? remoteImage(name)) : null),
  catalogImageUrl: (url) => remoteImage(url),

  signUp: (email, password) => supabase.signUp({ email, password }),
  signIn: (email, password) => supabase.signIn({ email, password }),
  signOut: () => supabase.signOut(),
  getCurrentUser: async () => supabase.toPublicUser(await supabase.getSession()),

  onAuthChange: (callback) =>
    supabase.onAuthStateChange((_event, session) => {
      const user = supabase.toPublicUser(session);
      callback(user);
      if (user) supabase.ensureProfile(user);
    }),

  getProfile: () => supabase.getProfile(),
  updateProfile: (defaultVisibility) => supabase.updateProfile({ defaultVisibility }),
  pushReview: async (libraryKey, item) => {
    const result = await supabase.pushReview(libraryKey, item);
    if (!result.ok) console.error('[game-ranker] could not push review:', result.error);
    return result;
  },
  pushReviews: async (libraryKey, items) => {
    const result = await supabase.pushReviews(libraryKey, items);
    if (!result.ok) console.error('[game-ranker] could not push reviews:', result.error);
    return result;
  },
  deleteReview: (id) => supabase.deleteReview(id),

  pullLibrary: async () => {
    const result = await supabase.fetchMyReviews();
    if (!result.ok) return result;
    return {
      ok: true,
      reviews: result.reviews.map((review) => ({ ...review, file: remoteImage(review.coverImageUrl) })),
    };
  },

  fetchPublicReviews: (provider, providerId) => supabase.fetchPublicReviews(provider, providerId),
  fetchProfileReviews: (userId) => supabase.fetchProfileReviews(userId),

  updateUsername: (username) => supabase.updateUsername(username),
  searchProfiles: (query) => supabase.searchProfiles(query),
  sendFriendRequest: (targetId) => supabase.sendFriendRequest(targetId),
  respondFriendRequest: (requesterId, accept) => supabase.respondFriendRequest(requesterId, accept),
  removeFriend: (otherId) => supabase.removeFriend(otherId),
  fetchFriends: () => supabase.fetchFriends(),

  hideReviewFrom: (blockedId, provider, providerId) =>
    supabase.hideReviewFrom(blockedId, provider, providerId),
  unhideReviewFrom: (blockedId, provider, providerId) =>
    supabase.unhideReviewFrom(blockedId, provider, providerId),
  fetchReviewBlocks: () => supabase.fetchReviewBlocks(),

  awardSeason: (libraryKey) => awards.getSeason(libraryKey),
  awardEligible: (seasonId, categoryKey) => awards.eligibleItems(seasonId, categoryKey),
  awardMyBallots: (seasonId) => awards.myBallots(seasonId),
  awardCast: (payload) => awards.castBallot(payload ?? {}),
  awardWithdraw: (payload) => awards.withdrawBallot(payload ?? {}),
  awardShortlist: (seasonId) => awards.shortlist(seasonId),
  awardResults: (seasonId) => awards.results(seasonId),
  awardBallotLog: (seasonId) => awards.ballotLog(seasonId),
  awardTrophies: () => awards.trophies(),
  awardHistory: (libraryKey) => awards.history(libraryKey),

  getAppVersion: async () => version,

  // The site is updated by deploying it; there is nothing to check or install.
  checkForUpdates: async () => ({ ok: false, error: 'The website is always the latest version.' }),
  onUpdateStatus: () => noop,
  installUpdate: async () => window.location.reload(),
};

window.api = api;
