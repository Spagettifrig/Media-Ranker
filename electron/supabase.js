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

/**
 * The same shape social.sql's `profiles_username_format` check enforces.
 * Validated here too so a typo comes back as a sentence rather than as a
 * constraint-violation string from Postgres.
 */
const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

function usernameProblem(username) {
  if (username.length < 3) return 'Usernames need at least 3 characters.';
  if (username.length > 24) return 'Usernames can be at most 24 characters.';
  return 'Usernames can only use lowercase letters, numbers and underscores.';
}

/**
 * Change your own username. Lowercased on the way in rather than rejected,
 * because "Alex" and "alex" are the same name to everyone except a database
 * - and the unique index is on lower(username) for the same reason.
 */
async function updateUsername(username) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, error: 'Not signed in.' };

    const cleaned = String(username ?? '').trim().toLowerCase();
    if (!USERNAME_PATTERN.test(cleaned)) return { ok: false, error: usernameProblem(cleaned) };

    const { error } = await getClient()
      .from('profiles')
      .update({ username: cleaned, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return { ok: false, error: 'That username is taken.' };
      return { ok: false, error: error.message };
    }
    return { ok: true, username: cleaned };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Friends.
 *
 * Every one of these is a SECURITY DEFINER function in social.sql rather
 * than a table query, because each of them has to cross the profiles
 * visibility boundary by definition - you cannot search for someone you
 * have never met, or see who asked to be your friend, using only the rows
 * you were already allowed to read. The functions return nothing but
 * (id, username, display_name), so that boundary is crossed by exactly the
 * width of a profile card and no further.
 * ------------------------------------------------------------------ */

/** A search hit or list entry, in the shape the renderer speaks. */
function toPerson(row) {
  return {
    id: row.id,
    username: row.username ?? '',
    displayName: row.display_name || row.username || 'Anonymous',
  };
}

async function searchProfiles(query) {
  try {
    const session = await getSession();
    if (!session?.user?.id) return { ok: false, error: 'Not signed in.' };

    const trimmed = String(query ?? '').trim();
    // Matches the function's own guard - no point spending a round trip on
    // a query the server will refuse to run.
    if (trimmed.length < 2) return { ok: true, results: [] };

    const { data, error } = await getClient().rpc('search_profiles', { p_query: trimmed });
    if (error) return { ok: false, error: error.message };
    return {
      ok: true,
      results: (data ?? []).map((row) => ({ ...toPerson(row), friendStatus: row.friend_status })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendFriendRequest(targetId) {
  try {
    const session = await getSession();
    if (!session?.user?.id) return { ok: false, error: 'Not signed in.' };
    const { data, error } = await getClient().rpc('send_friend_request', { p_target: targetId });
    if (error) return { ok: false, error: error.message };
    return { ok: true, status: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function respondFriendRequest(requesterId, accept) {
  try {
    const session = await getSession();
    if (!session?.user?.id) return { ok: false, error: 'Not signed in.' };
    const { data, error } = await getClient().rpc('respond_friend_request', {
      p_requester: requesterId,
      p_accept: Boolean(accept),
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, status: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Unfriend, decline, or cancel a request you sent - all the same act, and
 * all covered by the "leave a friendship" delete policy, so this one is a
 * plain table write rather than an RPC. The pair is stored in one row under
 * whichever ordering it was created with, so both orderings are deleted.
 */
async function removeFriend(otherId) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, error: 'Not signed in.' };

    const { error } = await getClient()
      .from('friendships')
      .delete()
      .or(
        `and(requester_id.eq.${userId},addressee_id.eq.${otherId}),` +
          `and(requester_id.eq.${otherId},addressee_id.eq.${userId})`,
      );
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Accepted friends and both directions of pending request, in one call. */
async function fetchFriends() {
  try {
    const session = await getSession();
    if (!session?.user?.id) return { ok: false, error: 'Not signed in.' };

    const [friendsResult, requestsResult] = await Promise.all([
      getClient().rpc('list_friends'),
      getClient().rpc('list_friend_requests'),
    ]);
    if (friendsResult.error) return { ok: false, error: friendsResult.error.message };
    if (requestsResult.error) return { ok: false, error: requestsResult.error.message };

    const requests = requestsResult.data ?? [];
    return {
      ok: true,
      friends: (friendsResult.data ?? []).map(toPerson),
      incoming: requests.filter((row) => row.direction === 'incoming').map(toPerson),
      outgoing: requests.filter((row) => row.direction === 'outgoing').map(toPerson),
    };
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
/** One local item as a `reviews` row. Shared so a single push and a bulk one can never drift. */
function reviewRow(libraryKey, item, userId) {
  return {
    id: item.id,
    user_id: userId,
    library_key: libraryKey,
    provider: item.provider,
    provider_id: String(item.providerId),
    title: item.title,
    overall_score: item.overallScore,
    category_scores: item.categoryScores ?? {},
    // Needed so an N/A category cannot drag a Critics' Choice average
    // around - a score of 50 that the user explicitly disowned is not
    // an opinion about the game.
    disabled_categories: item.disabledCategories ?? [],
    notes: item.descriptions ?? {},
    genres: item.genres ?? [],
    modes: item.modes ?? [],
    hours_played: item.hoursPlayed,
    // Both of these are what awards eligibility is decided on, so they
    // have to be the same on every device and on the server. `''` is
    // the app's "no date", which Postgres wants as NULL.
    first_played: item.firstPlayed || null,
    release_year: item.releaseYear ?? null,
    cover_image_url: item.coverImageUrl ?? null,
    visibility: item.visibility ?? 'inherit',
    deleted_at: null,
    updated_at: item.updatedAt ?? new Date().toISOString(),
  };
}

async function pushReview(libraryKey, item) {
  if (!item?.provider || !item?.providerId) return { ok: false, error: 'No catalog identity.' };
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, error: 'Not signed in.' };

    const { error } = await getClient()
      .from('reviews')
      .upsert(reviewRow(libraryKey, item, userId), { onConflict: 'id' });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** How many rows go up per request. Big enough to be one round trip for most boards. */
const PUSH_CHUNK = 100;

/**
 * Push a whole library at once.
 *
 * Used for the one-time backfill after the awards upgrade: `first_played`
 * never used to leave the device, so every row already in the cloud has it
 * null - and six of the nine game categories are decided on it. Pushing one
 * item at a time would mean hundreds of parallel requests, so this is a
 * handful of bulk upserts instead.
 */
async function pushReviews(libraryKey, items) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, error: 'Not signed in.' };

    const rows = (items ?? [])
      .filter((item) => item?.provider && item?.providerId)
      .map((item) => reviewRow(libraryKey, item, userId));
    if (rows.length === 0) return { ok: true, pushed: 0 };

    for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
      const { error } = await getClient()
        .from('reviews')
        .upsert(rows.slice(i, i + PUSH_CHUNK), { onConflict: 'id' });
      if (error) return { ok: false, error: error.message };
    }
    return { ok: true, pushed: rows.length };
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
      .select(
        'id, user_id, library_key, overall_score, category_scores, disabled_categories, notes, updated_at',
      )
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
        libraryKey: r.library_key,
        overallScore: r.overall_score,
        overallNote: r.notes?.overall ?? '',
        categoryScores: r.category_scores ?? {},
        disabledCategories: r.disabled_categories ?? [],
        notes: r.notes ?? {},
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
        'id, library_key, provider, provider_id, title, overall_score, category_scores, disabled_categories, notes, genres, modes, hours_played, first_played, release_year, cover_image_url, visibility, updated_at, created_at',
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
        disabledCategories: row.disabled_categories ?? [],
        descriptions: row.notes ?? {},
        genres: row.genres ?? [],
        modes: row.modes ?? [],
        hoursPlayed: row.hours_played,
        firstPlayed: row.first_played ?? '',
        releaseYear: row.release_year,
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
      .select(
        'id, library_key, title, overall_score, category_scores, disabled_categories, notes, cover_image_url, updated_at',
      )
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false });
    if (error) return { ok: false, error: error.message };

    return {
      ok: true,
      displayName: profile?.display_name ?? profile?.username ?? 'Anonymous',
      username: profile?.username ?? '',
      reviews: (reviews ?? []).map((r) => ({
        id: r.id,
        libraryKey: r.library_key,
        title: r.title,
        overallScore: r.overall_score,
        overallNote: r.notes?.overall ?? '',
        // The per-category half of the review - what they thought of the
        // story, the gameplay, and so on. Same shape the local item uses,
        // so the breakdown renders from one component either way.
        categoryScores: r.category_scores ?? {},
        disabledCategories: r.disabled_categories ?? [],
        notes: r.notes ?? {},
        // The viewer has no local copy of someone else's cover, so this
        // stays the provider's own URL and is proxied for display (see
        // catalogImageUrl in preload.js).
        coverImageUrl: r.cover_image_url ?? null,
      })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  // Exported for awards.js, which needs the same authenticated client - a
  // second createClient() would mean a second session and a second token
  // refresh racing this one over the same auth.json.
  getClient,
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
  updateUsername,
  searchProfiles,
  sendFriendRequest,
  respondFriendRequest,
  removeFriend,
  fetchFriends,
  pushReview,
  pushReviews,
  deleteReview,
  fetchMyReviews,
  fetchPublicReviews,
  fetchProfileReviews,
};
