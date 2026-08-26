import { trophyTitle } from '../lib/awards.js';

/**
 * The mark a winning item carries from then on.
 *
 * A win belongs to the *game*, not to one person's copy of it - the lookup is
 * by catalog identity, so everyone who owns Hollow Knight sees the same trophy
 * on their own board. Losing nominees get nothing: the shortlist is visible
 * during the ceremony and nowhere else.
 */
export default function TrophyBadge({ trophies, size = 'sm' }) {
  if (!trophies || trophies.length === 0) return null;

  // One glyph per win gets noisy fast on a board of covers, so past the third
  // it collapses to a count - the tooltip still lists every one.
  const shown = trophies.slice(0, 3);
  const extra = trophies.length - shown.length;
  const title = trophies.map(trophyTitle).join('\n');

  return (
    <span className={`trophies trophies--${size}`} title={title} aria-label={title}>
      {shown.map((trophy) => (
        <span
          key={`${trophy.year}-${trophy.categoryKey}-${trophy.kind}`}
          className={`trophy trophy--${trophy.kind}`}
        >
          <TrophyIcon />
        </span>
      ))}
      {extra > 0 ? <span className="trophy__more">+{extra}</span> : null}
    </span>
  );
}

export function TrophyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.6 2.2h6.8v4a3.4 3.4 0 0 1-6.8 0v-4Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M4.6 3.4H2.8v1.2a2.2 2.2 0 0 0 2 2.19M11.4 3.4h1.8v1.2a2.2 2.2 0 0 1-2 2.19"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path d="M8 9.6v2.4M5.6 13.8h4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
