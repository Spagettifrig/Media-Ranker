'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const catalog = require('./catalog.js');
const supabase = require('./supabase.js');
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
const DATA_VERSION = 2;

const emptyState = () => ({
  version: DATA_VERSION,
  libraries: { games: [], movies: [] },
  settings: {},
});

/**
 * v1 kept a single top-level `games` array. v2 keeps one array per library, so
 * older files are lifted into `libraries.games` on the way in. The file is
 * rewritten in the new shape by the next autosave; nothing is lost either way.
 */
function migrate(parsed) {
  if (!parsed || typeof parsed !== 'object') return emptyState();

  if (parsed.libraries && typeof parsed.libraries === 'object') {
    const libraries = {};
    for (const [key, value] of Object.entries(parsed.libraries)) {
      if (Array.isArray(value)) libraries[key] = value;
    }
    return {
      version: DATA_VERSION,
      libraries: { games: [], movies: [], ...libraries },
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
    };
  }

  if (Array.isArray(parsed.games)) {
    return {
      version: DATA_VERSION,
      libraries: { games: parsed.games, movies: [] },
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
    };
  }

  return emptyState();
}

async function readState() {
  try {
    const raw = await fsp.readFile(dataFile, 'utf8');
    // A stray byte-order mark (an editor, a hand-restored backup) would make
    // JSON.parse throw and the file look corrupt, so drop it first.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return migrate(JSON.parse(text));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    // Corrupt file: keep a copy so nothing is silently destroyed.
    try {
      await fsp.copyFile(dataFile, `${dataFile}.corrupt-${Date.now()}`);
    } catch {}
    return emptyState();
  }
}

let writeChain = Promise.resolve();

function writeState(state) {
  writeChain = writeChain.then(async () => {
    const json = JSON.stringify(state, null, 2);
    await fsp.writeFile(tmpFile, json, 'utf8');
    try {
      await fsp.copyFile(dataFile, backupFile);
    } catch {}
    await fsp.rename(tmpFile, dataFile);
  }).catch((err) => {
    console.error('[game-ranker] failed to persist data:', err);
  });
  return writeChain;
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

function setupAutoUpdates() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update:status', {
      status: 'ready',
      version: info?.version ?? null,
    });
  });

  // A failed check is a normal thing (offline, GitHub hiccup) - log it and
  // try again on the next interval rather than bothering anyone about it.
  autoUpdater.on('error', (err) => {
    console.error('[game-ranker] auto-update check failed:', err);
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
  ipcMain.handle('data:load', async () => {
    const state = await readState();
    rememberCredentials(state.settings);
    return state;
  });

  ipcMain.handle('data:save', async (_event, state) => {
    if (!state || !state.libraries || typeof state.libraries !== 'object') return false;
    const libraries = {};
    for (const [key, value] of Object.entries(state.libraries)) {
      if (Array.isArray(value)) libraries[key] = value;
    }
    rememberCredentials(state.settings);
    await writeState({
      version: DATA_VERSION,
      libraries,
      settings: state.settings && typeof state.settings === 'object' ? state.settings : {},
    });
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

  /* ---- auto-update ----------------------------------------------------- */
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
