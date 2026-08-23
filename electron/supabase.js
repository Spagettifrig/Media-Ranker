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
 * Profiles.
 *
 * A public.profiles row is what makes a user visible to anyone else at
 * all - the reviews RLS policy's "inherit" case joins against it. Nothing
 * creates one automatically on sign-up, so this does it explicitly.
 * `display_name` is derived from the email, never the email itself: other
 * users should never see a reviewer's raw address.
 * ------------------------------------------------------------------ */
function usernameFromEmail(email) {
  const local = String(email || '').split('@')[0].toLowerCase();
  const cleaned = local.replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '');
  return (cleaned || 'player').slice(0, 24);
}

function randomSuffix() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/** Postgres' unique_violation code - what a username collision looks like. */
const UNIQUE_VIOLATION = '23505';

/** Idempotent: safe to call on every sign-in, not just the first one. */
async function ensureProfile(user) {
  if (!user) return { ok: false, error: 'Not signed in.' };
  try {
    const client = getClient();
    const { data: existing, error: selectError } = await client
      .from('profiles')
      .select('id')
      .eq('id', user.id)
      .maybeSingle();
    if (selectError) return { ok: false, error: selectError.message };
    if (existing) return { ok: true };

    const base = usernameFromEmail(user.email);
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = attempt === 0 ? base : `${base}${randomSuffix()}`;
      const { error } = await client.from('profiles').insert({
        id: user.id,
        username: candidate,
        display_name: candidate,
        default_visibility: 'private',
      });
      if (!error) return { ok: true };
      if (error.code !== UNIQUE_VIOLATION) return { ok: false, error: error.message };
    }
    return { ok: false, error: 'Could not generate a unique username.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getProfile() {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, error: 'Not signed in.' };
    const { data, error } = await getClient()
      .from('profiles')
      .select('username, display_name, default_visibility')
      .eq('id', userId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: 'Profile not ready yet.' };
    return {
      ok: true,
      profile: {
        username: data.username,
        displayName: data.display_name,
        defaultVisibility: data.default_visibility,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function updateProfile({ defaultVisibility }) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, error: 'Not signed in.' };
    const { error } = await getClient()
      .from('profiles')
      .update({ default_visibility: defaultVisibility, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Auth. Every call follows the same convention as catalog.js: never throw
 * at the caller, report failure as { ok: false, error } instead.
 * ------------------------------------------------------------------ */
async function signUp({ email, password }) {
  try {
    const { data, error } = await getClient().auth.signUp({ email, password });
    if (error) return { ok: false, error: error.message };
    const user = toPublicUser(data.session);
    if (user) await ensureProfile(user);
    return { ok: true, user };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function signIn({ email, password }) {
  try {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    const user = toPublicUser(data.session);
    if (user) await ensureProfile(user);
    return { ok: true, user };
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

/* ------------------------------------------------------------------ *
 * Reviews: one-directional push sync (local -> cloud) plus the two read
 * queries the social feed needs. Nothing here pulls another device's data
 * back into this app - only items with a catalog identity ever go up, and
 * only what RLS already allows ever comes back down.
 * ------------------------------------------------------------------ */
async function pushReview(libraryKey, item) {
  if (!item?.provider || !item?.providerId) return { ok: false, error: 'No catalog identity.' };
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, error: 'Not signed in.' };

    const { error } = await getClient()
      .from('reviews')
      .upsert(
        {
          id: item.id,
          user_id: userId,
          library_key: libraryKey,
          provider: item.provider,
          provider_id: String(item.providerId),
          title: item.title,
          overall_score: item.overallScore,
          category_scores: item.categoryScores ?? {},
          notes: item.descriptions ?? {},
          genres: item.genres ?? [],
          modes: item.modes ?? [],
          hours_played: item.hoursPlayed,
          cover_image_url: item.coverImageUrl ?? null,
          visibility: item.visibility ?? 'inherit',
          deleted_at: null,
          updated_at: item.updatedAt ?? new Date().toISOString(),
        },
        { onConflict: 'id' },
      );
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Soft delete - matches the `deleted_at is null` clause every read query relies on. */
async function deleteReview(id) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, error: 'Not signed in.' };
    const { error } = await getClient()
      .from('reviews')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Other users' reviews of one specific game. `reviews.user_id` and
 * `profiles.id` both reference `auth.users(id)` independently - there's no
 * FK between them, so PostgREST can't embed the join. Two queries, merged
 * here instead.
 */
async function fetchPublicReviews(provider, providerId) {
  try {
    const session = await getSession();
    const userId = session?.user?.id ?? null;

    let query = getClient()
      .from('reviews')
      .select('id, user_id, overall_score, notes, updated_at')
      .eq('provider', provider)
      .eq('provider_id', String(providerId))
      .is('deleted_at', null)
      .order('updated_at', { ascending: false });
    if (userId) query = query.neq('user_id', userId);

    const { data: reviews, error } = await query;
    if (error) return { ok: false, error: error.message };
    if (!reviews || reviews.length === 0) return { ok: true, reviews: [] };

    const userIds = [...new Set(reviews.map((r) => r.user_id))];
    const { data: profiles, error: profilesError } = await getClient()
      .from('profiles')
      .select('id, display_name, username')
      .in('id', userIds);
    if (profilesError) return { ok: false, error: profilesError.message };

    const byId = new Map((profiles ?? []).map((p) => [p.id, p]));
    return {
      ok: true,
      reviews: reviews.map((r) => ({
        id: r.id,
        userId: r.user_id,
        displayName: byId.get(r.user_id)?.display_name ?? byId.get(r.user_id)?.username ?? 'Anonymous',
        overallScore: r.overall_score,
        overallNote: r.notes?.overall ?? '',
      })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * The signed-in user's own reviews, for rebuilding a library on a new machine.
 *
 * The `user_id` filter is not optional: the SELECT policy also exposes other
 * people's public rows, so without it a pull would drag half the community
 * into your own board.
 */
async function fetchMyReviews() {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, error: 'Not signed in.' };

    const { data, error } = await getClient()
      .from('reviews')
      .select(
        'id, library_key, provider, provider_id, title, overall_score, category_scores, notes, genres, modes, hours_played, cover_image_url, visibility, updated_at, created_at',
      )
      .eq('user_id', userId)
      .is('deleted_at', null);
    if (error) return { ok: false, error: error.message };

    return {
      ok: true,
      reviews: (data ?? []).map((row) => ({
        id: row.id,
        libraryKey: row.library_key,
        provider: row.provider,
        providerId: row.provider_id,
        title: row.title,
        overallScore: row.overall_score,
        categoryScores: row.category_scores ?? {},
        descriptions: row.notes ?? {},
        genres: row.genres ?? [],
        modes: row.modes ?? [],
        hoursPlayed: row.hours_played,
        coverImageUrl: row.cover_image_url,
        visibility: row.visibility,
        updatedAt: row.updated_at,
        addedAt: row.created_at,
      })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Every review by one user that RLS lets the current viewer see - including a private profile's one public exception. */
async function fetchProfileReviews(userId) {
  try {
    const { data: profile, error: profileError } = await getClient()
      .from('profiles')
      .select('id, display_name, username')
      .eq('id', userId)
      .maybeSingle();
    if (profileError) return { ok: false, error: profileError.message };

    const { data: reviews, error } = await getClient()
      .from('reviews')
      .select('id, library_key, title, overall_score, notes, updated_at')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false });
    if (error) return { ok: false, error: error.message };

    return {
      ok: true,
      displayName: profile?.display_name ?? profile?.username ?? 'Anonymous',
      reviews: (reviews ?? []).map((r) => ({
        id: r.id,
        libraryKey: r.library_key,
        title: r.title,
        overallScore: r.overall_score,
        overallNote: r.notes?.overall ?? '',
      })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  signUp,
  signIn,
  signOut,
  getSession,
  onAuthStateChange,
  toPublicUser,
  pendingWrites,
  ensureProfile,
  getProfile,
  updateProfile,
  pushReview,
  deleteReview,
  fetchMyReviews,
  fetchPublicReviews,
  fetchProfileReviews,
};
