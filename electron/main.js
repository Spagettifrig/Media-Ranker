'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const catalog = require('./catalog.js');
const supabase = require('./supabase.js');
const awards = require('./awards.js');
const { autoUpdater } = require('electron-updater');

const isDev = process.env.NODE_ENV === 'development';

/* ------------------------------------------------------------------ *
 * Paths. Everything the app owns lives under Electron's userData dir,
 * so the user never manages files or folders themselves.
 * ------------------------------------------------------------------ */
const userDataDir = app.getPath('userData');
const imagesDir = path.join(userDataDir, 'images');
const dataFile = path.join(userDataDir, 'data.json');
const tmpFile = path.join(userDataDir, 'data.json.tmp');
const backupFile = path.join(userDataDir, 'data.backup.json');

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'jfif'];

function ensureDirs() {
  fs.mkdirSync(imagesDir, { recursive: true });
  // A leftover .tmp means a previous run was killed between writing the temp
  // file and renaming it over data.json. Its contents are older than whatever
  // survived, so clearing it keeps the next write from tripping over it.
  try {
    fs.unlinkSync(tmpFile);
  } catch {}
}

/* ------------------------------------------------------------------ *
 * Custom protocol so the renderer can display imported images without
 * disabling web security or exposing absolute filesystem paths.
 * URLs look like: gameimg://img/<stored-file-name>
 * ------------------------------------------------------------------ */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'gameimg',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function resolveImageRequest(requestUrl) {
  const parsed = new URL(requestUrl);
  // Only the basename is ever honoured, which makes `../` traversal inert.
  const name = path.basename(decodeURIComponent(parsed.pathname));
  if (!name || name === '.' || name === '..') return null;
  const full = path.join(imagesDir, name);
  if (path.dirname(full) !== imagesDir) return null;
  return full;
}

/* ------------------------------------------------------------------ *
 * Persistence. Writes are atomic (tmp file + rename) and serialised,
 * so an autosave storm can never leave a half-written data file.
 * ------------------------------------------------------------------ */
const DATA_VERSION = 3;

const emptyLibraries = () => ({ games: [], movies: [], series: [] });

const emptyState = () => ({
  version: DATA_VERSION,
  libraries: emptyLibraries(),
  settings: {},
  // Which account (if any) adopted the pre-accounts local library. Set once,
  // so a second account signing in on this machine starts empty instead of
  // inheriting - and silently editing - the first account's collection.
  claimedBy: null,
});

/**
 * v1 kept a single top-level `games` array. v2 keeps one array per library, so
 * older files are lifted into `libraries.games` on the way in. v3 adds
 * `claimedBy` and moves a signed-in account's items into their own file; the
 * arrays here stay the signed-out library. The file is rewritten in the new
 * shape by the next autosave; nothing is lost either way.
 */
function migrate(parsed) {
  if (!parsed || typeof parsed !== 'object') return emptyState();

  const settings =
    parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
  const claimedBy = typeof parsed.claimedBy === 'string' ? parsed.claimedBy : null;

  if (parsed.libraries && typeof parsed.libraries === 'object') {
    const libraries = {};
    for (const [key, value] of Object.entries(parsed.libraries)) {
      if (Array.isArray(value)) libraries[key] = value;
    }
    return {
      version: DATA_VERSION,
      libraries: { ...emptyLibraries(), ...libraries },
      settings,
      claimedBy,
    };
  }

  if (Array.isArray(parsed.games)) {
    return {
      version: DATA_VERSION,
      libraries: { ...emptyLibraries(), games: parsed.games },
      settings,
      claimedBy,
    };
  }

  return emptyState();
}

/** Only the arrays live in an account file - settings stay device-wide in data.json. */
function migrateAccount(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.libraries) return null;
  const libraries = {};
  for (const [key, value] of Object.entries(parsed.libraries)) {
    if (Array.isArray(value)) libraries[key] = value;
  }
  return { ...emptyLibraries(), ...libraries };
}

/** Supabase ids are uuids; strip anything else so an id can never escape the folder. */
function accountDataFile(accountId) {
  const safe = String(accountId).replace(/[^a-zA-Z0-9-]/g, '');
  return path.join(userDataDir, `data-${safe}.json`);
}

async function readJson(file) {
  const raw = await fsp.readFile(file, 'utf8');
  // A stray byte-order mark (an editor, a hand-restored backup) would make
  // JSON.parse throw and the file look corrupt, so drop it first.
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

async function readState() {
  try {
    return migrate(await readJson(dataFile));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    // Corrupt file: keep a copy so nothing is silently destroyed.
    try {
      await fsp.copyFile(dataFile, `${dataFile}.corrupt-${Date.now()}`);
    } catch {}
    return emptyState();
  }
}

/** `null` means "this account has never been opened on this machine". */
async function readAccountLibraries(accountId) {
  const file = accountDataFile(accountId);
  try {
    return migrateAccount(await readJson(file));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    try {
      await fsp.copyFile(file, `${file}.corrupt-${Date.now()}`);
    } catch {}
    return null;
  }
}

let writeChain = Promise.resolve();

/** Everything goes through one queue, so an autosave storm can't interleave writes. */
function queueWrite(task) {
  writeChain = writeChain.then(task).catch((err) => {
    console.error('[game-ranker] failed to persist data:', err);
  });
  return writeChain;
}

async function atomicWrite(file, json) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, json, 'utf8');
  await fsp.rename(tmp, file);
}

function writeState(state) {
  return queueWrite(async () => {
    const json = JSON.stringify(state, null, 2);
    await fsp.writeFile(tmpFile, json, 'utf8');
    try {
      await fsp.copyFile(dataFile, backupFile);
    } catch {}
    await fsp.rename(tmpFile, dataFile);
  });
}

function writeAccountLibraries(accountId, libraries) {
  return queueWrite(async () => {
    await atomicWrite(
      accountDataFile(accountId),
      JSON.stringify({ version: DATA_VERSION, libraries }, null, 2),
    );
  });
}

/**
 * data.json is read once and kept here: it holds the device-wide settings that
 * every account shares, so it has to survive being rewritten while a signed-in
 * account's items live in a separate file.
 */
let localState = null;

async function loadLocalState() {
  if (!localState) localState = await readState();
  return localState;
}

function hasAnyItems(libraries) {
  return Object.values(libraries ?? {}).some((list) => Array.isArray(list) && list.length > 0);
}

/* ------------------------------------------------------------------ *
 * Image import
 * ------------------------------------------------------------------ */
async function copyIntoLibrary(sourcePaths) {
  const stored = [];
  for (const src of sourcePaths) {
    const ext = path.extname(src).toLowerCase().replace(/[^.a-z0-9]/g, '');
    const name = `${crypto.randomUUID()}${ext || '.png'}`;
    try {
      await fsp.copyFile(src, path.join(imagesDir, name));
      stored.push({ file: name, sourceName: path.basename(src, path.extname(src)) });
    } catch (err) {
      console.error('[game-ranker] could not import image:', src, err);
    }
  }
  return stored;
}

/* ------------------------------------------------------------------ *
 * Catalog credentials
 *
 * Kept in the main process and mirrored from the persisted settings, so a
 * search never has to ship the client secret across the IPC boundary.
 * ------------------------------------------------------------------ */
const CREDENTIAL_KEYS = ['tmdbToken', 'twitchClientId', 'twitchClientSecret'];

let credentials = {};

function rememberCredentials(settings) {
  const next = {};
  for (const key of CREDENTIAL_KEYS) {
    const value = settings?.[key];
    if (typeof value === 'string' && value.trim()) next[key] = value.trim();
  }
  credentials = next;
}

/* A cover straight off a provider CDN, dropped into the same images folder
 * manual imports use so nothing downstream can tell the two apart. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

async function downloadIntoLibrary(url) {
  let response;
  try {
    response = await fetch(url);
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;

  const type = response.headers.get('content-type') ?? '';
  const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg';
  const name = `${crypto.randomUUID()}${ext}`;
  try {
    await fsp.writeFile(path.join(imagesDir, name), buffer);
    return name;
  } catch (err) {
    console.error('[game-ranker] could not store downloaded cover:', err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */
let mainWindow = null;
let closing = false;

/** Never let a hung renderer keep the window open. */
const FLUSH_TIMEOUT_MS = 2500;

function flushAndClose(win) {
  let settled = false;

  const finish = async () => {
    if (settled) return;
    settled = true;
    ipcMain.removeListener('data:flushed', finish);
    // The flush only queues the write; `writeChain` is what actually resolves
    // once the rename has landed on disk. `auth.json` has its own independent
    // write queue (see supabase.js) - a sign-up right before quitting must not
    // lose the session to the same race this whole mechanism exists to avoid.
    try {
      await Promise.all([writeChain, supabase.pendingWrites()]);
    } catch {}
    if (!win.isDestroyed()) win.destroy();
  };

  ipcMain.once('data:flushed', finish);
  setTimeout(finish, FLUSH_TIMEOUT_MS);

  if (win.webContents.isDestroyed()) {
    finish();
  } else {
    win.webContents.send('data:flush');
  }
}

function createWindow() {
  // Reset per window: on macOS the app can outlive its window and open another.
  closing = false;
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e1013',
    autoHideMenuBar: true,
    title: 'Game Ranker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  /**
   * Closing the window used to race the autosave: the renderer fired a save
   * from `beforeunload`, the window went away, and the process exited between
   * writing data.json.tmp and renaming it over data.json - so the last edits
   * before quitting were the ones that vanished.
   *
   * Hold the close, let the renderer flush, wait for the write to land, and
   * only then let the window go.
   */
  mainWindow.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    flushAndClose(mainWindow);
  });

  // External links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    Menu.setApplicationMenu(null);
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

/* ------------------------------------------------------------------ *
 * Auto-update. Only meaningful for a packaged install - a dev run has no
 * app-update.yml (electron-builder only writes one when packaging), and
 * there's nowhere for it to check anyway.
 * ------------------------------------------------------------------ */
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Set only while a manual (button-triggered) check is in flight, so the
 * chatty events below - "checking", "not available", "error" - reach the
 * renderer just for that click and stay silent for the automatic checks that
 * fire on launch and every four hours. Those still log on failure; they just
 * never interrupt anyone who didn't ask.
 */
let manualCheckPending = false;

function setupAutoUpdates() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    if (manualCheckPending) mainWindow?.webContents.send('update:status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    if (manualCheckPending) {
      mainWindow?.webContents.send('update:status', {
        status: 'downloading',
        version: info?.version ?? null,
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    if (manualCheckPending) {
      mainWindow?.webContents.send('update:status', { status: 'not-available' });
      manualCheckPending = false;
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    manualCheckPending = false;
    mainWindow?.webContents.send('update:status', {
      status: 'ready',
      version: info?.version ?? null,
    });
  });

  // A failed check is a normal thing (offline, GitHub hiccup) - log it and
  // try again on the next interval rather than bothering anyone about it,
  // unless someone just pressed the button and is actually waiting on it.
  autoUpdater.on('error', (err) => {
    console.error('[game-ranker] auto-update check failed:', err);
    if (manualCheckPending) {
      mainWindow?.webContents.send('update:status', { status: 'error', message: err.message });
      manualCheckPending = false;
    }
  });

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), UPDATE_CHECK_INTERVAL_MS);
}

// Single instance: a second launch focuses the existing window instead of
// opening a rival copy that would fight over the same data file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    ensureDirs();

    protocol.handle('gameimg', async (request) => {
      const filePath = resolveImageRequest(request.url);
      if (!filePath) return new Response('Not found', { status: 404 });
      try {
        return await net.fetch(pathToFileURL(filePath).toString());
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });

    registerIpc();
    createWindow();

    // Pushes auth state (sign in, sign out, token refresh) to the renderer the
    // same way `data:flush` is pushed today - the renderer never polls for it.
    supabase.onAuthStateChange((_event, session) => {
      mainWindow?.webContents.send('auth:changed', supabase.toPublicUser(session));
      // Fire-and-forget, idempotent: covers session-restore on launch, where
      // there's no IPC call from the renderer to await this on (signUp/signIn
      // already await it directly for the interactive sign-in paths).
      if (session?.user) supabase.ensureProfile(supabase.toPublicUser(session));
    });

    setupAutoUpdates();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function registerIpc() {
  /**
   * `accountId` null means signed out - the device's own library, exactly as
   * before accounts existed. Signed in, the arrays come from that account's
   * own file so two people sharing a machine never see (or overwrite) each
   * other's rankings. Settings are device-wide either way.
   */
  ipcMain.handle('data:load', async (_event, accountId = null) => {
    const local = await loadLocalState();
    rememberCredentials(local.settings);

    if (!accountId) {
      return { version: DATA_VERSION, libraries: local.libraries, settings: local.settings };
    }

    let libraries = await readAccountLibraries(accountId);
    if (!libraries) {
      // First sign-in for this account on this machine. The pre-accounts
      // library is handed to whoever signs in first and to nobody after that.
      if (!local.claimedBy && hasAnyItems(local.libraries)) {
        libraries = local.libraries;
        local.claimedBy = accountId;
        local.libraries = emptyLibraries();
        await writeAccountLibraries(accountId, libraries);
        await writeState(local);
      } else {
        libraries = emptyLibraries();
      }
    }

    return { version: DATA_VERSION, libraries, settings: local.settings };
  });

  ipcMain.handle('data:save', async (_event, accountId, state) => {
    if (!state || !state.libraries || typeof state.libraries !== 'object') return false;
    const libraries = {};
    for (const [key, value] of Object.entries(state.libraries)) {
      if (Array.isArray(value)) libraries[key] = value;
    }

    const local = await loadLocalState();
    local.settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
    rememberCredentials(local.settings);

    if (accountId) {
      // data.json is still rewritten: it owns the settings every account shares.
      await writeAccountLibraries(accountId, libraries);
      await writeState(local);
    } else {
      local.libraries = libraries;
      await writeState(local);
    }
    return true;
  });

  ipcMain.handle('images:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose images',
      buttonLabel: 'Import',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }],
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return copyIntoLibrary(result.filePaths);
  });

  /**
   * Read a stored image back as a data: URL.
   *
   * The export draws covers into a canvas and reads the pixels out again.
   * Chromium refuses `crossOrigin` on non-http schemes, so an <img> pointed at
   * gameimg:// would taint the canvas and block toBlob(); a data: URL is
   * same-origin by definition and sidesteps the whole problem.
   */
  ipcMain.handle('images:read', async (_event, name) => {
    if (typeof name !== 'string' || !name) return null;
    const base = path.basename(name);
    const full = path.join(imagesDir, base);
    if (path.dirname(full) !== imagesDir) return null;
    try {
      const buffer = await fsp.readFile(full);
      const ext = path.extname(base).toLowerCase().slice(1);
      const mime = ext === 'jpg' || ext === 'jfif' ? 'jpeg' : ext || 'png';
      return `data:image/${mime};base64,${buffer.toString('base64')}`;
    } catch {
      return null;
    }
  });

  /* Save an exported ranking image wherever the user points the dialog. */
  ipcMain.handle('export:save', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const bytes = payload?.bytes;
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) {
      return { saved: false, error: 'Nothing to save.' };
    }
    const ext = typeof payload?.ext === 'string' && /^[a-z0-9]{2,4}$/.test(payload.ext)
      ? payload.ext
      : 'png';
    const result = await dialog.showSaveDialog(win, {
      title: 'Save ranking image',
      defaultPath: path.basename(String(payload?.fileName || `ranking.${ext}`)),
      filters: [
        ext === 'jpg'
          ? { name: 'JPEG image', extensions: ['jpg', 'jpeg'] }
          : { name: 'PNG image', extensions: ['png'] },
      ],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    try {
      await fsp.writeFile(result.filePath, Buffer.from(bytes));
      return { saved: true, filePath: result.filePath };
    } catch (err) {
      console.error('[game-ranker] could not save export:', err);
      return { saved: false, error: err.message };
    }
  });

  /* Reveal a saved export in the file manager. */
  ipcMain.handle('shell:showItem', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return false;
    shell.showItemInFolder(filePath);
    return true;
  });

  /* ---- online catalog ---------------------------------------------- *
   * These three never throw at the renderer: a failed lookup is a normal
   * thing (offline, bad key, rate limit) and the UI shows the message
   * inline rather than treating it as a crash.
   * ------------------------------------------------------------------ */
  ipcMain.handle('catalog:status', async (_event, libraryKey) => {
    return catalog.status(String(libraryKey ?? ''), credentials);
  });

  ipcMain.handle('catalog:search', async (_event, libraryKey, query) => {
    try {
      const results = await catalog.search(String(libraryKey ?? ''), query, credentials);
      return { ok: true, results };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * Fill in release years for items that predate the field. Failure is
   * deliberately quiet: without a year an item simply stays out of the
   * release-year award categories, which is not worth a toast on launch.
   */
  ipcMain.handle('catalog:releaseYears', async (_event, libraryKey, remoteIds) => {
    try {
      const years = await catalog.releaseYears(String(libraryKey ?? ''), remoteIds, credentials);
      return { ok: true, years };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('catalog:import', async (_event, libraryKey, remoteId) => {
    try {
      const entry = await catalog.detail(String(libraryKey ?? ''), remoteId, credentials);
      if (!entry) return { ok: false, error: 'That entry could not be loaded.' };
      // A missing cover is disappointing, not fatal - the item is still worth
      // adding, and the user can drop their own art on it afterwards.
      const file = entry.imageUrl ? await downloadIntoLibrary(entry.imageUrl) : null;
      return { ok: true, entry: { ...entry, file } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ---- account (Supabase auth) --------------------------------------- *
   * Same never-throw convention as the catalog handlers above: a failed
   * sign-in is a normal thing (bad password, offline), not a crash.
   * ------------------------------------------------------------------ */
  ipcMain.handle('auth:signUp', async (_event, { email, password } = {}) => {
    return supabase.signUp({ email, password });
  });

  ipcMain.handle('auth:signIn', async (_event, { email, password } = {}) => {
    return supabase.signIn({ email, password });
  });

  ipcMain.handle('auth:signOut', async () => {
    return supabase.signOut();
  });

  ipcMain.handle('auth:getUser', async () => {
    return supabase.toPublicUser(await supabase.getSession());
  });

  /* ---- profile ----------------------------------------------------------- */
  ipcMain.handle('sync:getProfile', async () => supabase.getProfile());

  ipcMain.handle('sync:updateProfile', async (_event, { defaultVisibility } = {}) =>
    supabase.updateProfile({ defaultVisibility }),
  );

  /* ---- reviews: push sync + the social feed's read queries -------------- */
  ipcMain.handle('sync:pushReview', async (_event, libraryKey, item) => {
    const result = await supabase.pushReview(libraryKey, item);
    // The renderer fires these and forgets them, so an unlogged failure is an
    // invisible one - a review that silently never reaches anyone else.
    if (!result.ok) console.error('[game-ranker] could not push review:', result.error);
    return result;
  });

  /**
   * Bulk push, for the one-time backfill after the awards upgrade. Logged
   * rather than surfaced: it runs itself in the background and a failure
   * just means the next launch tries again.
   */
  ipcMain.handle('sync:pushReviews', async (_event, libraryKey, items) => {
    const result = await supabase.pushReviews(libraryKey, items);
    if (!result.ok) console.error('[game-ranker] could not push reviews:', result.error);
    return result;
  });

  ipcMain.handle('sync:deleteReview', async (_event, id) => supabase.deleteReview(id));

  /**
   * Rebuild-from-cloud: your own reviews, with their catalog covers pulled
   * back down into the local images folder so a fresh machine shows art
   * instead of empty cards. The renderer merges these into whatever is
   * already on disk - it never blindly replaces it.
   */
  ipcMain.handle('sync:pullLibrary', async () => {
    const result = await supabase.fetchMyReviews();
    if (!result.ok) return result;

    const reviews = [];
    for (const review of result.reviews) {
      const file = review.coverImageUrl ? await downloadIntoLibrary(review.coverImageUrl) : null;
      reviews.push({ ...review, file });
    }
    return { ok: true, reviews };
  });

  ipcMain.handle('sync:fetchPublicReviews', async (_event, provider, providerId) =>
    supabase.fetchPublicReviews(provider, providerId),
  );

  ipcMain.handle('sync:fetchProfileReviews', async (_event, userId) =>
    supabase.fetchProfileReviews(userId),
  );

  /* ---- awards ---------------------------------------------------------- */
  ipcMain.handle('awards:season', async (_event, libraryKey) => awards.getSeason(libraryKey));

  ipcMain.handle('awards:eligible', async (_event, seasonId, categoryKey) =>
    awards.eligibleItems(seasonId, categoryKey),
  );

  ipcMain.handle('awards:myBallots', async (_event, seasonId) => awards.myBallots(seasonId));

  ipcMain.handle('awards:cast', async (_event, payload) => awards.castBallot(payload ?? {}));

  ipcMain.handle('awards:withdraw', async (_event, payload) => awards.withdrawBallot(payload ?? {}));

  ipcMain.handle('awards:shortlist', async (_event, seasonId) => awards.shortlist(seasonId));

  ipcMain.handle('awards:results', async (_event, seasonId) => awards.results(seasonId));

  ipcMain.handle('awards:ballotLog', async (_event, seasonId) => awards.ballotLog(seasonId));

  ipcMain.handle('awards:trophies', async () => awards.trophies());

  ipcMain.handle('awards:history', async (_event, libraryKey) => awards.history(libraryKey));

  /* ---- auto-update ----------------------------------------------------- */
  ipcMain.handle('app:version', () => app.getVersion());

  /**
   * The button in Settings. Everything else about updating already runs on
   * its own (launch + every 4 hours); this just lets someone say "now"
   * instead of waiting or relaunching. Result arrives asynchronously over
   * the same 'update:status' channel the background checks use.
   */
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) {
      return { ok: false, error: 'Updates only run in the installed app, not this dev build.' };
    }
    manualCheckPending = true;
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      manualCheckPending = false;
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('update:install', () => {
    // Triggers the normal quit path (same `close` handler, same data flush)
    // before relaunching into the new version.
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle('images:delete', async (_event, names) => {
    if (!Array.isArray(names)) return false;
    for (const raw of names) {
      if (typeof raw !== 'string') continue;
      const name = path.basename(raw);
      const full = path.join(imagesDir, name);
      if (path.dirname(full) !== imagesDir) continue;
      try {
        await fsp.unlink(full);
      } catch {}
    }
    return true;
  });
}
