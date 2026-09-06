import { LIBRARIES } from './media.js';
import { SCORE_BANDS, clampScore } from './score.js';

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
 * How this person scores each category of one library - the mean of every
 * review that didn't mark the category N/A.
 *
 * This is the interesting half of a profile: two people can both average 82
 * and be nothing alike, one marking Story down and Gameplay up while the
 * other does the reverse.
 */
function categoryAverages(reviews, library) {
  return library.categories
    .map((category) => {
      const values = reviews
        .filter((review) => !(review.disabledCategories ?? []).includes(category.key))
        .map((review) => Number(review.categoryScores?.[category.key]))
        .filter((value) => Number.isFinite(value))
        .map(clampScore);

      return {
        key: category.key,
        label: category.label,
        value: values.length === 0 ? null : Math.round(values.reduce((sum, v) => sum + v, 0) / values.length),
        count: values.length,
      };
    })
    .filter((category) => category.value !== null);
}

/** Score spread across everything they've shared, low band to high. */
function distribution(reviews) {
  const scores = reviews.map((review) => scoreOf(review)).filter((score) => score !== null);
  return [...SCORE_BANDS].reverse().map((band) => ({
    key: `${band.min}-${band.max}`,
    label: band.min === 0 ? '0-19' : `${band.min}-${band.max}`,
    name: band.name,
    color: band.color,
    count: scores.filter((score) => score >= band.min && score <= band.max).length,
  }));
}

/**
 * Everything the profile panel draws, derived in one pass.
 *
 * There is deliberately no single average across every library: the mean of
 * a game, a film and a series answers no question anyone has. Averages live
 * per library instead, where they can be compared to something.
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
      categories: categoryAverages(owned, library),
      top: owned.slice(0, TOP_REVIEWS),
      all: owned,
    };
  });

  const ranked = all
    .filter((review) => scoreOf(review) !== null)
    .sort((a, b) => scoreOf(b) - scoreOf(a));

  return {
    total: all.length,
    // The single highest-scored thing across every library - the one review
    // that best answers "what does this person actually love?".
    best: ranked[0] ?? null,
    worst: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    perfect: all.filter((review) => scoreOf(review) === 100).length,
    // How many of the three libraries they actually share anything from -
    // "3 shared reviews" reads very differently spread across all three.
    activeLibraries: libraries.filter((library) => library.count > 0).length,
    bands: distribution(all),
    libraries,
  };
}
