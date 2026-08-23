import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ScoreBadge from './ScoreBadge.jsx';
import { LIBRARIES } from '../lib/media.js';
import { firstSentences, isTruncated } from '../lib/social.js';

/**
 * Another user's public profile: their display name and every review of
 * theirs the server is willing to hand back. There is no client-side
 * visibility filtering here on purpose - the RLS policy behind
 * `fetchProfileReviews` already decided exactly what this viewer may see,
 * including the "public for just this one game" case, which just falls out
 * as a one-item list.
 */
export default function ProfileView({ target, onClose }) {
  const ref = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [displayName, setDisplayName] = useState(target?.displayName ?? '');
  const [reviews, setReviews] = useState([]);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    if (!target?.id) return undefined;
    setLoading(true);
    setError(null);
    window.api.fetchProfileReviews(target.id).then((response) => {
      if (cancelled) return;
      setLoading(false);
      if (!response?.ok) {
        setError(response?.error ?? 'Could not load this profile.');
        return;
      }
      setDisplayName(response.displayName);
      setReviews(response.reviews ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [target?.id]);

  if (!target) return null;

  return createPortal(
    <div className="overlay" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`${displayName || 'Profile'}`}
        tabIndex={-1}
        ref={ref}
      >
        <header className="sheet__head">
          <h2>{displayName || 'Profile'}</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="settings__body">
          {loading ? <p className="settings__row-desc">Loading…</p> : null}
          {error ? <p className="field__hint field__hint--error">{error}</p> : null}

          {!loading && !error ? (
            <>
              <div className="profile__summary">
                <div className="profile__avatar" aria-hidden="true">
                  {(displayName || '?').slice(0, 1).toUpperCase()}
                </div>
                <div className="profile__stats">
                  <p className="profile__stat">
                    <strong>{reviews.length}</strong>{' '}
                    {reviews.length === 1 ? 'shared review' : 'shared reviews'}
                  </p>
                  {reviews.length > 0 ? (
                    <p className="profile__stat">
                      <strong>{averageScore(reviews)}</strong> average score
                    </p>
                  ) : null}
                </div>
              </div>

              {/* The server only ever hands back what this profile chose to
                  share, so a short list is a privacy setting, not a bug -
                  say so rather than letting it look broken. */}
              <p className="settings__row-desc">
                {reviews.length === 0
                  ? `${displayName || 'This user'} hasn't shared any reviews publicly.`
                  : 'Only the reviews this user has chosen to share are listed here.'}
              </p>

              <div className="profile__reviews">
                {reviews.map((review) => (
                  <ProfileReview key={review.id} review={review} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function averageScore(reviews) {
  const scored = reviews.filter((review) => Number.isFinite(Number(review.overallScore)));
  if (scored.length === 0) return '—';
  return Math.round(scored.reduce((sum, review) => sum + Number(review.overallScore), 0) / scored.length);
}

function ProfileReview({ review }) {
  const [expanded, setExpanded] = useState(false);
  const libraryLabel = LIBRARIES.find((entry) => entry.key === review.libraryKey)?.label ?? review.libraryKey;
  const truncated = isTruncated(review.overallNote, 2);

  return (
    <div className="profile__review">
      <div className="profile__review-head">
        <ScoreBadge value={review.overallScore} size="sm" />
        <div>
          <p className="profile__review-title">{review.title}</p>
          <p className="profile__review-library">{libraryLabel}</p>
        </div>
      </div>
      {review.overallNote ? (
        <p className="profile__review-note">
          {expanded ? review.overallNote : firstSentences(review.overallNote, 2)}
        </p>
      ) : null}
      {truncated ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      ) : null}
    </div>
  );
}
