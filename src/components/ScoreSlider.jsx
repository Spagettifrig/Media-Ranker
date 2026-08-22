import { MAX_SCORE, MIN_SCORE, clampScore, scoreBand } from '../lib/score.js';

/**
 * A 1-100 slider whose fill, thumb and value chip all take their colour from
 * the shared score scale.
 *
 * `readOnly` renders the same visuals but blocks input - used for the overall
 * score, which is always the average of the category sliders.
 * `active` marks the slider the keyboard is pointed at; `pending` shows the
 * digits typed so far while a score is being entered.
 * `notApplicable` (with `onToggleApplicable`) lets a category be excluded
 * from the overall average when it doesn't apply to this item - the slider
 * greys out and its number is replaced with "N/A".
 */
export default function ScoreSlider({
  label,
  value,
  onChange,
  onFocus,
  readOnly = false,
  variant = 'category',
  active = false,
  pending = '',
  hint,
  notApplicable = false,
  onToggleApplicable,
}) {
  const score = clampScore(value);
  const band = scoreBand(score);
  const percent = ((score - MIN_SCORE) / (MAX_SCORE - MIN_SCORE)) * 100;
  const disabled = readOnly || notApplicable;

  const className = [
    'slider',
    `slider--${variant}`,
    readOnly ? 'slider--readonly' : '',
    active ? 'is-active' : '',
    notApplicable ? 'is-na' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      style={{ '--fill': band.color, '--ink': band.ink, '--percent': `${percent}%` }}
    >
      <div className="slider__head">
        <span className="slider__label">
          {label}
          {active && !readOnly ? <span className="slider__cursor" aria-hidden="true" /> : null}
          {onToggleApplicable ? (
            <button
              type="button"
              className={`slider__na${notApplicable ? ' is-active' : ''}`}
              aria-pressed={notApplicable}
              title={
                notApplicable
                  ? 'Not applicable — click to include it in the average again'
                  : "Mark as not applicable — it won't count toward the average"
              }
              onClick={onToggleApplicable}
            >
              N/A
            </button>
          ) : null}
        </span>
        <span className="slider__value">
          {notApplicable ? 'N/A' : score}
          {pending ? <span className="slider__pending">typing {pending}</span> : null}
        </span>
      </div>

      <input
        className="slider__input"
        type="range"
        min={MIN_SCORE}
        max={MAX_SCORE}
        step={1}
        value={score}
        disabled={disabled}
        aria-label={`${label} score`}
        aria-valuetext={notApplicable ? 'Not applicable' : `${score} out of 100, ${band.name}`}
        aria-readonly={disabled || undefined}
        onFocus={onFocus}
        onPointerDown={onFocus}
        onChange={disabled ? undefined : (event) => onChange(Number(event.target.value))}
      />

      {hint ? <p className="slider__hint">{hint}</p> : null}
    </div>
  );
}
