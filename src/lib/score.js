/**
 * The single source of truth for the score colour scale.
 * Used by the board badges and by every slider in the detail view, so a
 * given number always looks the same everywhere in the app.
 */
export const SCORE_BANDS = [
  { min: 90, max: 100, name: 'Dark green', color: '#157F3C', ink: '#EAF7EE' },
  { min: 80, max: 89, name: 'Green', color: '#2FB457', ink: '#07220F' },
  { min: 70, max: 79, name: 'Yellow', color: '#E4C10A', ink: '#241E00' },
  { min: 60, max: 69, name: 'Amber', color: '#F0A020', ink: '#2A1700' },
  { min: 50, max: 59, name: 'Orange', color: '#EE7420', ink: '#2A1000' },
  { min: 40, max: 49, name: 'Red', color: '#E23B3B', ink: '#2A0505' },
  { min: 30, max: 39, name: 'Dark red', color: '#992020', ink: '#FBE9E9' },
  { min: 20, max: 29, name: 'Purple', color: '#7C3AED', ink: '#F2ECFE' },
  { min: 0, max: 19, name: 'Black', color: '#0B0B0D', ink: '#E8EAED' },
];

export const MIN_SCORE = 1;
export const MAX_SCORE = 100;

export function clampScore(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return MIN_SCORE;
  return Math.min(MAX_SCORE, Math.max(MIN_SCORE, n));
}

/** Returns the band descriptor { color, ink, name } for a score. */
export function scoreBand(value) {
  const n = clampScore(value);
  return SCORE_BANDS.find((band) => n >= band.min && n <= band.max) ?? SCORE_BANDS[SCORE_BANDS.length - 1];
}

/** Convenience: just the fill colour for a score. */
export function scoreColor(value) {
  return scoreBand(value).color;
}

/**
 * Overall score is the average of a library's categories, minus whichever
 * ones don't apply to this item (e.g. no "story" in a puzzle game). The
 * category list is passed in because each library scores different things
 * (see `lib/media.js`).
 */
export function computeOverall(categoryScores, categories, disabledKeys = []) {
  if (!categories || categories.length === 0) return MIN_SCORE;
  const disabled = disabledKeys instanceof Set ? disabledKeys : new Set(disabledKeys);
  const active = categories.filter((cat) => !disabled.has(cat.key));
  if (active.length === 0) return MIN_SCORE;
  const total = active.reduce((sum, cat) => sum + clampScore(categoryScores?.[cat.key]), 0);
  return clampScore(total / active.length);
}

/** 1 -> "1st", 2 -> "2nd", 13 -> "13th", 22 -> "22nd" */
export function ordinal(position) {
  const n = Math.max(1, Math.round(Number(position) || 1));
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
