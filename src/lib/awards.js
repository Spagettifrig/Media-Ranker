/**
 * Client-side awards logic.
 *
 * Everything in here is presentation: which phase to draw, how long until the
 * next one, which categories have been unlocked by the ceremony clock. Not one
 * rule is enforced here, because nothing enforced in a renderer is enforced at
 * all - the anon key ships in the installer, so the database is the only place
 * a rule can actually live (see supabase/awards.sql).
 *
 * The one thing this file *does* own is the clock offset. The server reports
 * its own `now()` with every season read, and every countdown below is drawn
 * against that rather than the machine's clock, so a user with a wrong system
 * time sees the same ceremony as everyone else.
 */

export const PHASES = {
  upcoming: {
    label: 'Not open yet',
    blurb: 'Nominations have not opened.',
  },
  nominating: {
    label: 'Round 1 · Nominations',
    blurb: 'Put forward one pick per category. Change your mind any time before the deadline.',
  },
  shortlisting: {
    label: 'Counting nominations',
    blurb: 'Nominations are closed. The nominees appear when voting opens.',
  },
  voting: {
    label: 'Round 2 · Voting',
    blurb: 'Pick a winner from the nominees. Nobody can see the tally, including you.',
  },
  sealed: {
    label: 'Sealed',
    blurb: 'Voting is over and the results are sealed until the ceremony.',
  },
  revealed: {
    label: 'Results',
    blurb: 'The envelopes are open.',
  },
};

/** The round a phase accepts ballots for, or null when it accepts none. */
export function activeRound(phase) {
  if (phase === 'nominating') return 'nominate';
  if (phase === 'voting') return 'vote';
  return null;
}

/**
 * Milliseconds to add to `Date.now()` to get the server's clock. Computed once
 * per season fetch; a few hundred ms of network latency is irrelevant against
 * deadlines measured in days.
 */
export function clockOffset(season) {
  if (!season?.serverTime) return 0;
  const server = Date.parse(season.serverTime);
  return Number.isFinite(server) ? server - Date.now() : 0;
}

export function serverNow(offset) {
  return Date.now() + (offset ?? 0);
}

/** The deadline the current phase is counting down to, and what it leads to. */
export function nextDeadline(season) {
  if (!season) return null;
  switch (season.phase) {
    case 'upcoming':
      return { at: season.nominationsOpenAt, label: 'Nominations open' };
    case 'nominating':
      return { at: season.nominationsCloseAt, label: 'Nominations close' };
    case 'shortlisting':
      return { at: season.votingOpenAt, label: 'Nominees revealed' };
    case 'voting':
      return { at: season.votingCloseAt, label: 'Voting closes' };
    case 'sealed':
      return { at: season.resultsPublishedAt, label: 'The ceremony begins' };
    default:
      return null;
  }
}

/**
 * "2 days 4 hrs", "18 min 30 sec". Coarse when far away, precise when close -
 * a countdown that ticks seconds a week out is just noise.
 */
export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'any moment';
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

const DATE_FORMAT = {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
};

export function formatMoment(iso) {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleString(undefined, DATE_FORMAT);
}

/**
 * The ceremony. Categories unlock one at a time from the reveal instant, so
 * the results arrive as an event rather than a table that was suddenly there.
 * Pure arithmetic over a clock everyone already agrees on - no server push, no
 * socket, and a user who opens the app an hour late simply sees all of them.
 */
export function revealedCount(season, now) {
  if (!season || season.phase !== 'revealed') return 0;
  const start = Date.parse(season.resultsPublishedAt);
  if (!Number.isFinite(start)) return season.categories?.length ?? 0;
  const stagger = Math.max(0, Number(season.revealStaggerSeconds) || 0) * 1000;
  if (stagger === 0) return season.categories?.length ?? 0;
  const elapsed = now - start;
  if (elapsed < 0) return 0;
  return Math.min(season.categories?.length ?? 0, Math.floor(elapsed / stagger) + 1);
}

/** Milliseconds until the next category opens, or null once they all have. */
export function msToNextReveal(season, now) {
  if (!season || season.phase !== 'revealed') return null;
  const total = season.categories?.length ?? 0;
  const shown = revealedCount(season, now);
  if (shown >= total) return null;
  const start = Date.parse(season.resultsPublishedAt);
  const stagger = (Number(season.revealStaggerSeconds) || 0) * 1000;
  if (!Number.isFinite(start) || stagger === 0) return null;
  return start + shown * stagger - now;
}

/**
 * Why this user cannot take part, as a sentence, or null when they can.
 * The same two rules the database enforces - stated, rather than left as a
 * greyed-out button nobody can explain.
 */
export function participationBlocker(season) {
  const rules = season?.eligibility;
  if (!rules) return null;
  if (!rules.accountOldEnough) {
    return `Only accounts that existed before the ${season.year} season opened can take part. Yours is in for next year.`;
  }
  if (!rules.libraryBigEnough) {
    const need = season.minLibrarySize - rules.librarySize;
    return `Rank ${need} more item${need === 1 ? '' : 's'} in this library to take part (${rules.librarySize} of ${season.minLibrarySize}).`;
  }
  return null;
}

/** Group a flat trophy list by `provider:providerId`, for board lookups. */
export function trophyIndex(trophies) {
  const index = new Map();
  for (const trophy of trophies ?? []) {
    const key = `${trophy.provider}:${trophy.providerId}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(trophy);
  }
  // Newest first, and a community win outranks a computed one when a game
  // took both in the same category - the voted award is the headline.
  for (const list of index.values()) {
    list.sort((a, b) => b.year - a.year || (a.kind === 'community' ? -1 : 1));
  }
  return index;
}

export function trophiesFor(index, item) {
  if (!index || !item?.provider || !item?.providerId) return [];
  return index.get(`${item.provider}:${item.providerId}`) ?? [];
}

export function trophyTitle(trophy) {
  const kind = trophy.kind === 'critics' ? "Critics' Choice" : 'Community Choice';
  return `${trophy.label} ${trophy.year} · ${kind}`;
}
