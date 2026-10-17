'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { app } = require('electron');

/* ------------------------------------------------------------------ *
 * Session storage.
 *
 * Kept in its own file (auth.json) with its own write queue, separate from
 * data.json entirely: a slow library-data write must never delay a token
 * refresh, and session tokens must never get swept into the library file's
 * autosave/backup behaviour.
 *
 * Its own module so the web build can swap in a localStorage-backed one
 * (src/web/auth-storage.js) and reuse supabase.js unchanged.
 * ------------------------------------------------------------------ */
// Resolved on first use rather than at require time, so loading supabase.js
// (as the tests do) never needs a running Electron app.
const authFile = () => path.join(app.getPath('userData'), 'auth.json');
const authTmpFile = () => path.join(app.getPath('userData'), 'auth.json.tmp');

let store = null; // in-memory cache, loaded once; avoids read-modify-write races
let authWriteChain = Promise.resolve();

async function loadStore() {
  if (store) return store;
  try {
    store = JSON.parse(await fsp.readFile(authFile(), 'utf8'));
  } catch {
    store = {};
  }
  return store;
}

function persistStore() {
  const snapshot = JSON.stringify(store);
  authWriteChain = authWriteChain
    .then(async () => {
      await fsp.writeFile(authTmpFile(), snapshot, 'utf8');
      await fsp.rename(authTmpFile(), authFile());
    })
    .catch((err) => {
      console.error('[game-ranker] failed to persist auth session:', err);
    });
  return authWriteChain;
}

/** Supabase's async storage interface, backed by auth.json - there is no `window.localStorage` in the main process. */
const storage = {
  async getItem(key) {
    const current = await loadStore();
    return current[key] ?? null;
  },
  async setItem(key, value) {
    const current = await loadStore();
    current[key] = value;
    await persistStore();
  },
  async removeItem(key) {
    const current = await loadStore();
    delete current[key];
    await persistStore();
  },
};

/** The in-flight (or already-settled) auth-file write, so shutdown can wait on it. */
function pendingWrites() {
  return authWriteChain;
}

module.exports = { storage, pendingWrites };
