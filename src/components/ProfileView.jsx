import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ScoreBadge from './ScoreBadge.jsx';
import { firstSentences, isTruncated, profileSummary } from '../lib/social.js';

/**
 * Another user's public profile: a summary panel with their headline stats
 * and their top few reviews per library, and a drill-down into the full
 * list for any one library.
 *
 * There is no client-side visibility filtering here on purpose - the RLS
 * policy behind `fetchProfileReviews` already decided exactly what this
 * viewer may see, including the "public for just this one game" case, which
 * just falls out as a one-item list.
 */
export default function ProfileView({ target, onClose }) {
  const ref = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [displayName, setDisplayName] = useState(target?.displayName ?? '');
  const [username, setUsername] = useState(target?.username ?? '');
  const [reviews, setReviews] = useState([]);
  /** null = the summary panel; a library key = that library's full list. */
  const [openLibrary, setOpenLibrary] = useState(null);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  // Escape backs out of a library list first, and only then closes the
  // sheet - the same one-step-at-a-time behaviour as the Back button.
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (openLibrary) setOpenLibrary(null);
      else onClose();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, openLibrary]);

  useEffect(() => {
    let cancelled = false;
    if (!target?.id) return undefined;
    setLoading(true);
    setError(null);
    setOpenLibrary(null);
    window.api.fetchProfileReviews(target.id).then((response) => {
      if (cancelled) return;
      setLoading(false);
      if (!response?.ok) {
        setError(response?.error ?? 'Could not load this profile.');
        return;
      }
      setDisplayName(response.displayName);
      setUsername(response.username ?? '');
      setReviews(response.reviews ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [target?.id]);

  const summary = useMemo(() => profileSummary(reviews), [reviews]);
  const library = openLibrary ? summary.libraries.find((entry) => entry.key === openLibrary) : null;

  if (!target) return null;

  return createPortal(
    <div className="overlay" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={displayName || 'Profile'}
        tabIndex={-1}
        ref={ref}
      >
        <header className="sheet__head">
          {library ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpenLibrary(null)}>
              <ChevronLeftIcon />
              Profile
            </button>
          ) : null}
          <h2>{library ? `${library.label} — ${displayName || 'Profile'}` : displayName || 'Profile'}</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="settings__body">
          {loading ? <p className="settings__row-desc">Loading…</p> : null}
          {error ? <p className="field__hint field__hint--error">{error}</p> : null}

          {!loading && !error && !library ? (
            <Summary
              displayName={displayName}
              username={username}
              summary={summary}
              onOpenLibrary={setOpenLibrary}
            />
          ) : null}

          {!loading && !error && library ? (
            <div className="profile__reviews">
              {library.all.map((review) => (
                <ProfileReview key={review.id} review={review} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Summary({ displayName, username, summary, onOpenLibrary }) {
  return (
    <>
      <div className="profile__summary">
        <div className="profile__avatar" aria-hidden="true">
          {(displayName || '?').slice(0, 1).toUpperCase()}
        </div>
        <div className="profile__identity">
          <p className="profile__name">{displayName || 'Anonymous'}</p>
          {username ? <p className="profile__username">@{username}</p> : null}
        </div>
      </div>

      <div className="profile__statgrid">
        <Stat value={summary.total} label={summary.total === 1 ? 'shared review' : 'shared reviews'} />
        <Stat value={summary.average ?? '—'} label="average score" />
        <Stat
          value={summary.best ? summary.best.overallScore : '—'}
          label={summary.best ? `highest — ${summary.best.title}` : 'highest'}
        />
      </div>

      {summary.total === 0 ? (
        /* The server only ever hands back what this profile chose to share,
           so an empty panel is a privacy setting, not a bug - say so rather
           than letting it look broken. */
        <p className="settings__row-desc">
          {displayName || 'This user'} hasn&apos;t shared any reviews publicly.
        </p>
      ) : (
        <p className="settings__row-desc">
          Only the reviews this user has chosen to share are listed here.
        </p>
      )}

      {summary.libraries.map((library) => (
        <LibrarySection key={library.key} library={library} onOpen={() => onOpenLibrary(library.key)} />
      ))}
    </>
  );
}

function Stat({ value, label }) {
  return (
    <div className="profile__stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/**
 * One library's top few reviews. The whole header is the affordance for
 * opening the full list, so there is nothing to hunt for - but it is only a
 * button when there is actually more to see.
 */
function LibrarySection({ library, onOpen }) {
  const hasMore = library.count > library.top.length;

  return (
    <section className="profile__section">
      <header className="profile__section-head">
        <div>
          <h3 className="profile__section-title">{library.label}</h3>
          <p className="profile__section-meta">
            {library.count === 0
              ? `Nothing shared`
              : `${library.count} shared · ${library.average} average`}
          </p>
        </div>
        {hasMore ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onOpen}>
            See all {library.count}
            <ChevronRightIcon />
          </button>
        ) : null}
      </header>

      {library.top.length > 0 ? (
        <div className="profile__reviews">
          {library.top.map((review, index) => (
            <ProfileReview key={review.id} review={review} rank={index + 1} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ProfileReview({ review, rank = null }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = isTruncated(review.overallNote, 2);
  const cover = review.coverImageUrl ? window.api.catalogImageUrl(review.coverImageUrl) : null;

  return (
    <div className="profile__review">
      <div className="profile__review-head">
        {rank ? <span className="profile__rank">{rank}</span> : null}
        {cover ? <img className="profile__review-art" src={cover} alt="" loading="lazy" /> : null}
        <ScoreBadge value={review.overallScore} size="sm" />
        <p className="profile__review-title">{review.title}</p>
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

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
