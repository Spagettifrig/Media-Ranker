'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { app } = require('electron');
const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./supabase-config.js');

/* ------------------------------------------------------------------ *
 * Session storage.
 *
 * Kept in its own file (auth.json) with its own write queue, separate from
 * data.json entirely: a slow library-data write must never delay a token
 * refresh, and session tokens must never get swept into the library file's
 * autosave/backup behaviour.
 * ------------------------------------------------------------------ */
const authFile = path.join(app.getPath('userData'), 'auth.json');
const authTmpFile = path.join(app.getPath('userData'), 'auth.json.tmp');

let store = null; // in-memory cache, loaded once; avoids read-modify-write races
let authWriteChain = Promise.resolve();

async function loadStore() {
  if (store) return store;
  try {
    store = JSON.parse(await fsp.readFile(authFile, 'utf8'));
  } catch {
    store = {};
  }
  return store;
}

function persistStore() {
  const snapshot = JSON.stringify(store);
  authWriteChain = authWriteChain
    .then(async () => {
      await fsp.writeFile(authTmpFile, snapshot, 'utf8');
      await fsp.rename(authTmpFile, authFile);
    })
    .catch((err) => {
      console.error('[game-ranker] failed to persist auth session:', err);
    });
  return authWriteChain;
}

/** Supabase's async storage interface, backed by auth.json - there is no `window.localStorage` in the main process. */
const fileStorageAdapter = {
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

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */
let client = null;

function getClient() {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: fileStorageAdapter,
      },
    });
  }
  return client;
}

/** Strip a session down to what the renderer is allowed to see - never the tokens. */
function toPublicUser(session) {
  const user = session?.user;
  return user ? { id: user.id, email: user.email } : null;
}

/* ------------------------------------------------------------------ *
 * Auth. Every call follows the same convention as catalog.js: never throw
 * at the caller, report failure as { ok: false, error } instead.
 * ------------------------------------------------------------------ */
async function signUp({ email, password }) {
  try {
    const { data, error } = await getClient().auth.signUp({ email, password });
    if (error) return { ok: false, error: error.message };
    return { ok: true, user: toPublicUser(data.session) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function signIn({ email, password }) {
  try {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    return { ok: true, user: toPublicUser(data.session) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function signOut() {
  try {
    const { error } = await getClient().auth.signOut();
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getSession() {
  try {
    const { data } = await getClient().auth.getSession();
    return data?.session ?? null;
  } catch {
    return null;
  }
}

/** Pushes every auth change (sign in, sign out, token refresh) to `callback(event, session)`. Returns an unsubscribe function. */
function onAuthStateChange(callback) {
  const { data } = getClient().auth.onAuthStateChange(callback);
  return () => data?.subscription?.unsubscribe();
}

/** The in-flight (or already-settled) auth-file write, so shutdown can wait on it. */
function pendingWrites() {
  return authWriteChain;
}

module.exports = {
  signUp,
  signIn,
  signOut,
  getSession,
  onAuthStateChange,
  toPublicUser,
  pendingWrites,
};
