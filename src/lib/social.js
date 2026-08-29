import { LIBRARIES } from './media.js';

/**
 * The first `count` sentences of free text, for a review excerpt. Splits on
 * `.`/`!`/`?` followed by whitespace - good enough for prose, no need for
 * real sentence-boundary detection here.
 */
export function firstSentences(text, count = 2) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  const sentences = trimmed.match(/[^.!?]+[.!?]*/g) ?? [trimmed];
  return sentences.slice(0, count).join(' ').trim();
}

/** Whether an excerpt actually dropped text, i.e. whether "Read more" has anything to reveal. */
export function isTruncated(text, count = 2) {
  return firstSentences(text, count).length < String(text ?? '').trim().length;
}

/** How many reviews each library shows on the profile summary before "See all". */
export const TOP_REVIEWS = 3;

function scoreOf(review) {
  const score = Number(review?.overallScore);
  return Number.isFinite(score) ? score : null;
}

/** Mean of the scores that are actually numbers, or null if none are. */
function averageScore(reviews) {
  const scores = reviews.map(scoreOf).filter((score) => score !== null);
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

/**
 * Everything the profile panel draws, derived in one pass.
 *
 * Deliberately dumb about *why* a list is short: the server already applied
 * this viewer's visibility rules, so what arrives is exactly what may be
 * shown. An empty library here means "nothing shared", not "nothing owned",
 * and the panel says so rather than inventing a total it cannot know.
 *
 * Every library in LIBRARIES gets an entry even when it has no reviews, so
 * the summary keeps a stable shape (Games, Movies, TV Series always in that
 * order) instead of reflowing as sections appear and disappear.
 */
export function profileSummary(reviews) {
  const all = Array.isArray(reviews) ? reviews : [];

  const libraries = LIBRARIES.map((library) => {
    // Highest first; a tie falls back to title so the order is stable
    // between renders rather than depending on the server's row order.
    const owned = all
      .filter((review) => review.libraryKey === library.key)
      .sort(
        (a, b) =>
          (scoreOf(b) ?? -1) - (scoreOf(a) ?? -1) ||
          String(a.title ?? '').localeCompare(String(b.title ?? '')),
      );

    return {
      key: library.key,
      label: library.label,
      items: library.items,
      count: owned.length,
      average: averageScore(owned),
      top: owned.slice(0, TOP_REVIEWS),
      all: owned,
    };
  });

  return {
    total: all.length,
    average: averageScore(all),
    // The single highest-scored thing across every library - the one review
    // that best answers "what does this person actually love?".
    best: libraries.flatMap((library) => library.top).sort((a, b) => (scoreOf(b) ?? -1) - (scoreOf(a) ?? -1))[0] ?? null,
    libraries,
  };
}
