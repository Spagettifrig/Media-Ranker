import { LIBRARIES } from '../lib/media.js';
import { clampScore, scoreBand } from '../lib/score.js';

/**
 * The per-category half of someone else's review - what they made of the
 * story, the gameplay, the music - with whatever they wrote about each.
 *
 * Read-only by design: this is the same data the owner edits with sliders in
 * the detail view, but seen from outside, so it renders as bars rather than
 * controls. The category list comes from the library the review belongs to,
 * so a movie shows Acting and a game shows Gameplay without this component
 * knowing anything about either.
 */
/**
 * Whether there is a breakdown behind this review at all.
 *
 * A row pushed before the app stored category scores - or one whose owner
 * never filled any in - has an overall score and nothing behind it. Callers
 * use this to decide whether to offer a way in; the component itself uses it
 * to explain the emptiness rather than drawing a rack of blank bars.
 */
export function hasBreakdown(review, libraryKey = null) {
  const config = LIBRARIES.find((library) => library.key === (libraryKey ?? review?.libraryKey));
  if (!config) return false;
  const scores = review?.categoryScores ?? {};
  const notes = review?.notes ?? {};
  return config.categories.some(
    (category) => Number.isFinite(Number(scores[category.key])) || notes[category.key],
  );
}

/**
 * The first thing they actually wrote about a category, with the category's
 * own label - for showing a hint of the writing where there is only room for
 * one line. Returns null if they wrote nothing anywhere.
 */
export function firstCategoryNote(review, libraryKey = null) {
  const config = LIBRARIES.find((library) => library.key === (libraryKey ?? review?.libraryKey));
  if (!config) return null;
  const notes = review?.notes ?? {};
  for (const category of config.categories) {
    const text = String(notes[category.key] ?? '').trim();
    if (text) return { label: category.label, text };
  }
  return null;
}

export default function ReviewBreakdown({ review, libraryKey = null }) {
  const config = LIBRARIES.find((library) => library.key === (libraryKey ?? review?.libraryKey));
  if (!config) return null;

  const scores = review?.categoryScores ?? {};
  const notes = review?.notes ?? {};
  const disabled = new Set(review?.disabledCategories ?? []);

  if (!hasBreakdown(review, libraryKey)) {
    return (
      <p className="settings__row-desc">
        This review doesn&apos;t have a category breakdown — just the overall score.
      </p>
    );
  }

  // Only worth saying "nothing written here" when they wrote about some of
  // the categories - then the gap is a real absence rather than just how
  // this person reviews things.
  const anyNotes = config.categories.some((category) => notes[category.key]);

  return (
    <div className="breakdown">
      {config.categories.map((category) => (
        <CategoryRow
          key={category.key}
          label={category.label}
          score={scores[category.key]}
          note={notes[category.key] ?? ''}
          notApplicable={disabled.has(category.key)}
          markSilence={anyNotes}
        />
      ))}
    </div>
  );
}

function CategoryRow({ label, score, note, notApplicable, markSilence }) {
  const raw = Number(score);
  const rated = !notApplicable && Number.isFinite(raw);
  const value = rated ? clampScore(raw) : null;
  const band = rated ? scoreBand(value) : null;
  const text = String(note ?? '').trim();

  return (
    <div className={`breakdown__row${notApplicable ? ' breakdown__row--na' : ''}`}>
      <div className="breakdown__head">
        <span className="breakdown__label">{label}</span>
        <span className="breakdown__value">{notApplicable ? 'N/A' : (value ?? '—')}</span>
      </div>

      {/* The N/A case keeps the empty track: the row still says "they
          considered this and it doesn't apply", which is not the same as a
          category they simply scored low. */}
      <div className="breakdown__track">
        {rated ? (
          <span
            className="breakdown__fill"
            style={{ width: `${value}%`, background: band.color }}
          />
        ) : null}
      </div>

      {/* What they wrote is the point of the row - the bar above is just how
          hard they felt it. So it gets body-copy treatment, not a caption's. */}
      {text ? (
        <p className="breakdown__note">{text}</p>
      ) : markSilence ? (
        <p className="breakdown__note breakdown__note--empty">Nothing written for this one.</p>
      ) : null}
    </div>
  );
}
