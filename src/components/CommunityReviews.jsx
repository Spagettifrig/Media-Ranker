import { useEffect, useState } from 'react';
import ReviewBreakdown, { firstCategoryNote, hasBreakdown } from './ReviewBreakdown.jsx';
import ScoreBadge from './ScoreBadge.jsx';
import { firstSentences, isTruncated } from '../lib/social.js';

/**
 * Other signed-in users' reviews of this same catalog item. Renders nothing
 * for a manual (non-catalog) item - there's no reliable shared identity to
 * look anyone else's copy up by - or while signed out, since there is
 * nothing to fetch on someone else's behalf without an account.
 */
export default function CommunityReviews({ item, user, config, onOpenProfile }) {
  const eligible = Boolean(user) && Boolean(item.provider) && Boolean(item.providerId);
  const [loading, setLoading] = useState(eligible);
  const [error, setError] = useState(null);
  const [reviews, setReviews] = useState([]);

  useEffect(() => {
    let cancelled = false;
    if (!eligible) {
      setReviews([]);
      return undefined;
    }
    setLoading(true);
    setError(null);
    window.api.fetchPublicReviews(item.provider, item.providerId).then((response) => {
      if (cancelled) return;
      setLoading(false);
      if (!response?.ok) {
        setError(response?.error ?? 'Could not load community reviews.');
        return;
      }
      setReviews(response.reviews ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [item.id, eligible]);

  if (!eligible) return null;

  return (
    <section className="community" aria-label="Community reviews">
      <h3 className="keys__title">Community reviews</h3>

      {loading ? <p className="settings__row-desc">Loading…</p> : null}
      {error ? <p className="field__hint field__hint--error">{error}</p> : null}
      {!loading && !error && reviews.length === 0 ? (
        <p className="settings__row-desc">
          No one else has shared a review of this yet.
        </p>
      ) : null}

      <div className="community__list">
        {reviews.map((review) => (
          <CommunityCard
            key={review.id}
            review={review}
            libraryKey={config?.key ?? null}
            onOpenProfile={onOpenProfile}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * One person's review of this item. Collapsed it is a score and the first
 * couple of sentences; opened it is the whole note plus how they scored
 * every category - the same breakdown their profile shows, in place.
 *
 * The card stays a `div` rather than becoming one big button: the reviewer's
 * name is already a button of its own (it opens their profile), and a button
 * inside a button is not a thing.
 */
function CommunityCard({ review, libraryKey, onOpenProfile }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = isTruncated(review.overallNote, 2);
  const detailed = hasBreakdown(review, libraryKey);
  // Nothing hidden means no toggle - a button that expands a card into the
  // same card is worse than no button.
  const expandable = truncated || detailed;
  const fallback = review.overallNote ? null : firstCategoryNote(review, libraryKey);

  return (
    <div className="community__card">
      <div className="community__card-head">
        <button
          type="button"
          className="community__reviewer"
          onClick={() => onOpenProfile({ id: review.userId, displayName: review.displayName })}
        >
          {review.displayName}
        </button>
        <ScoreBadge value={review.overallScore} size="sm" />
      </div>
      {review.overallNote ? (
        <p className="community__note">
          {expanded ? review.overallNote : firstSentences(review.overallNote, 2)}
        </p>
      ) : !expanded && fallback ? (
        /* No overall note, but they wrote about the categories - show a
           taste of that rather than a card with nothing but a number. */
        <p className="community__note">
          <span className="profile__note-tag">{fallback.label}</span>
          {firstSentences(fallback.text, 2)}
        </p>
      ) : null}

      {expanded && detailed ? <ReviewBreakdown review={review} libraryKey={libraryKey} /> : null}

      {expandable ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : detailed ? 'Show breakdown' : 'Read more'}
        </button>
      ) : null}
    </div>
  );
}
