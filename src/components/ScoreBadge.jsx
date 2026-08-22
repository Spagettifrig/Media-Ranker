import { clampScore, scoreBand } from '../lib/score.js';

/**
 * The circular score badge used on the board. Colour comes from the shared
 * score scale so it always matches the sliders in the detail view.
 */
export default function ScoreBadge({ value, size = 'md' }) {
  const score = clampScore(value);
  const band = scoreBand(score);

  return (
    <div
      className={`score-badge score-badge--${size}`}
      style={{ '--badge-fill': band.color, '--badge-ink': band.ink }}
      title={`${score} / 100 — ${band.name}`}
    >
      <span>{score}</span>
    </div>
  );
}
