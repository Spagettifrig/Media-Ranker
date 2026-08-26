'use strict';

/**
 * The awards half of the cloud layer.
 *
 * Every call here is an RPC, never a table query, because every awards rule
 * lives inside a SECURITY DEFINER function (see supabase/awards.sql). The
 * tables themselves are either read-only to clients or closed entirely - there
 * is no `.from('award_ballots').insert()` anywhere in this app, and there must
 * never be one, or the eligibility rules become optional.
 *
 * Same convention as catalog.js and supabase.js: never throw at the caller,
 * report failure as { ok: false, error } instead.
 */

const { getClient, getSession } = require('./supabase.js');

/** Postgres RAISE EXCEPTION text arrives as `message`; it is already user-facing. */
function fail(error) {
  return { ok: false, error: error?.message ?? 'Something went wrong.' };
}

async function requireUser() {
  const session = await getSession();
  return session?.user?.id ?? null;
}

/**
 * The season for a library, plus the phase and this user's standing against
 * the entry rules. Creates the season row on first read in a new year, so
 * nothing has to be set up by hand each December.
 */
async function getSeason(libraryKey) {
  try {
    if (!(await requireUser())) return { ok: false, error: 'Not signed in.' };
    const { data, error } = await getClient().rpc('get_award_season', {
      p_library_key: libraryKey,
    });
    if (error) return fail(error);
    return { ok: true, season: data };
  } catch (err) {
    return fail(err);
  }
}

/** What this user may put forward in one category - the picker's contents. */
async function eligibleItems(seasonId, categoryKey) {
  try {
    const { data, error } = await getClient().rpc('award_eligible_items', {
      p_season_id: seasonId,
      p_category_key: categoryKey,
    });
    if (error) return fail(error);
    return {
      ok: true,
      items: (data ?? []).map((row) => ({
        provider: row.provider,
        providerId: row.provider_id,
        title: row.title,
        coverImageUrl: row.cover_image_url,
        overallScore: row.overall_score,
        releaseYear: row.release_year,
        firstPlayed: row.first_played,
      })),
    };
  } catch (err) {
    return fail(err);
  }
}

/** This user's own ballots for a season. The only tally anyone can read before the reveal. */
async function myBallots(seasonId) {
  try {
    const userId = await requireUser();
    if (!userId) return { ok: false, error: 'Not signed in.' };
    const { data, error } = await getClient()
      .from('award_ballots')
      .select('round, category_key, provider, provider_id, title, cover_image_url')
      .eq('season_id', seasonId)
      .eq('user_id', userId);
    if (error) return fail(error);
    return {
      ok: true,
      ballots: (data ?? []).map((row) => ({
        round: row.round,
        categoryKey: row.category_key,
        provider: row.provider,
        providerId: row.provider_id,
        title: row.title,
        coverImageUrl: row.cover_image_url,
      })),
    };
  } catch (err) {
    return fail(err);
  }
}

async function castBallot({ seasonId, round, categoryKey, provider, providerId }) {
  try {
    const { data, error } = await getClient().rpc('cast_ballot', {
      p_season_id: seasonId,
      p_round: round,
      p_category_key: categoryKey,
      p_provider: provider,
      p_provider_id: String(providerId),
    });
    if (error) return fail(error);
    return { ok: true, result: data };
  } catch (err) {
    return fail(err);
  }
}

async function withdrawBallot({ seasonId, round, categoryKey }) {
  try {
    const { error } = await getClient().rpc('withdraw_ballot', {
      p_season_id: seasonId,
      p_round: round,
      p_category_key: categoryKey,
    });
    if (error) return fail(error);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** The nominees. Computed server-side on the first read after voting opens. */
async function shortlist(seasonId) {
  try {
    const { data, error } = await getClient().rpc('get_award_shortlist', {
      p_season_id: seasonId,
    });
    if (error) return fail(error);
    const byCategory = {};
    for (const row of data ?? []) {
      (byCategory[row.category_key] ??= []).push({
        provider: row.provider,
        providerId: row.provider_id,
        title: row.title,
        coverImageUrl: row.cover_image_url,
        // Deliberately not surfaced in the UI during voting: showing round
        // one's counts next to the nominees would reintroduce exactly the
        // bandwagon the sealed tally exists to prevent.
        nominationCount: row.nomination_count,
      });
    }
    return { ok: true, shortlist: byCategory };
  } catch (err) {
    return fail(err);
  }
}

/**
 * The winners. The first client to call this after the reveal instant causes
 * the server to compute and store them; everyone after reads the same rows.
 */
async function results(seasonId) {
  try {
    const { data, error } = await getClient().rpc('get_award_results', {
      p_season_id: seasonId,
    });
    if (error) return fail(error);
    const byCategory = {};
    for (const row of data ?? []) {
      (byCategory[row.category_key] ??= {})[row.kind] = {
        provider: row.provider,
        providerId: row.provider_id,
        title: row.title,
        coverImageUrl: row.cover_image_url,
        voteCount: row.vote_count,
        averageScore: row.average_score === null ? null : Number(row.average_score),
      };
    }
    return { ok: true, results: byCategory };
  } catch (err) {
    return fail(err);
  }
}

/** Who nominated and voted for what. Unsealed with the results, never before. */
async function ballotLog(seasonId) {
  try {
    const { data, error } = await getClient().rpc('get_award_ballot_log', {
      p_season_id: seasonId,
    });
    if (error) return fail(error);
    const byCategory = {};
    for (const row of data ?? []) {
      (byCategory[row.category_key] ??= []).push({
        round: row.round,
        displayName: row.display_name,
        title: row.title,
        provider: row.provider,
        providerId: row.provider_id,
      });
    }
    return { ok: true, log: byCategory };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Every win ever, flat, for stamping trophies onto boards. Cached in the local
 * data file by the renderer so an offline launch still shows them.
 */
async function trophies() {
  try {
    if (!(await requireUser())) return { ok: false, error: 'Not signed in.' };
    const { data, error } = await getClient().rpc('get_award_trophies');
    if (error) return fail(error);
    return {
      ok: true,
      trophies: (data ?? []).map((row) => ({
        provider: row.provider,
        providerId: row.provider_id,
        libraryKey: row.library_key,
        year: row.year,
        categoryKey: row.category_key,
        label: row.label,
        kind: row.kind,
      })),
    };
  } catch (err) {
    return fail(err);
  }
}

/** Every finished season, newest first. The tab's off-season content. */
async function history(libraryKey) {
  try {
    if (!(await requireUser())) return { ok: false, error: 'Not signed in.' };
    const { data, error } = await getClient().rpc('get_award_history', {
      p_library_key: libraryKey,
    });
    if (error) return fail(error);
    return { ok: true, history: data ?? [] };
  } catch (err) {
    return fail(err);
  }
}

module.exports = {
  getSeason,
  eligibleItems,
  myBallots,
  castBallot,
  withdrawBallot,
  shortlist,
  results,
  ballotLog,
  trophies,
  history,
};
