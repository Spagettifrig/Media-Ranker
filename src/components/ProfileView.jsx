import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReviewBreakdown, { firstCategoryNote } from './ReviewBreakdown.jsx';
import ScoreBadge from './ScoreBadge.jsx';
import SupporterMark from './SupporterMark.jsx';
import { scoreBand } from '../lib/score.js';
import { firstSentences, profileSummary } from '../lib/social.js';

/**
 * Another user's public profile. Three depths, each replacing the last in
 * the same sheet: the summary (stats down one side, their best reviews down
 * the other), the full list, and one review's own page - where the
 * per-category scores and notes live.
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
  // Seeded from wherever the sheet was opened, so the ring does not appear a
  // beat after the name does, then confirmed by the fetch below.
  const [isSupporter, setIsSupporter] = useState(Boolean(target?.isSupporter));
  const [reviews, setReviews] = useState([]);
  /** false = the summary panel; true = the full list, in its place. */
  const [showAll, setShowAll] = useState(false);
  /** The id of the review whose own page is open, if any. */
  const [openReviewId, setOpenReviewId] = useState(null);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!target?.id) return undefined;
    setLoading(true);
    setError(null);
    setShowAll(false);
    setOpenReviewId(null);
    window.api.fetchProfileReviews(target.id).then((response) => {
      if (cancelled) return;
      setLoading(false);
      if (!response?.ok) {
        setError(response?.error ?? 'Could not load this profile.');
        return;
      }
      setDisplayName(response.displayName);
      setUsername(response.username ?? '');
      setIsSupporter(Boolean(response.isSupporter));
      setReviews(response.reviews ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [target?.id]);

  const summary = useMemo(() => profileSummary(reviews), [reviews]);
  const openReview = useMemo(
    () => (openReviewId ? (reviews.find((review) => review.id === openReviewId) ?? null) : null),
    [openReviewId, reviews],
  );

  // Escape unwinds one level at a time - review, then list, then the sheet -
  // the same path the Back button walks.
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (openReviewId) setOpenReviewId(null);
      else if (showAll) setShowAll(false);
      else onClose();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, showAll, openReviewId]);

  if (!target) return null;

  // A review opened from the full list goes back to the full list; one
  // opened from the summary goes back to the summary.
  const back = openReview
    ? { label: showAll ? 'All reviews' : 'Profile', onClick: () => setOpenReviewId(null) }
    : showAll
      ? { label: 'Profile', onClick: () => setShowAll(false) }
      : null;

  const heading = openReview
    ? openReview.title
    : showAll
      ? `All reviews — ${displayName || 'Profile'}`
      : displayName || 'Profile';

  return createPortal(
    <div className="overlay" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="sheet sheet--profile"
        role="dialog"
        aria-modal="true"
        aria-label={displayName || 'Profile'}
        tabIndex={-1}
        ref={ref}
      >
        <header className="sheet__head">
          {back ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={back.onClick}>
              <ChevronLeftIcon />
              {back.label}
            </button>
          ) : null}
          <h2>{heading}</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="settings__body">
          {loading ? <p className="settings__row-desc">Loading…</p> : null}
          {error ? <p className="field__hint field__hint--error">{error}</p> : null}

          {!loading && !error && openReview ? (
            <ReviewPage review={openReview} author={displayName} />
          ) : null}

          {!loading && !error && !openReview && showAll ? (
            <FullList summary={summary} onOpenReview={setOpenReviewId} />
          ) : null}

          {!loading && !error && !openReview && !showAll ? (
            <Summary
              displayName={displayName}
              username={username}
              isSupporter={isSupporter}
              summary={summary}
              onShowMore={() => setShowAll(true)}
              onOpenReview={setOpenReviewId}
            />
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "12 shared · 84 average", minus any half the data can't support. */
function libraryMeta(library) {
  if (library.count === 0) return 'Nothing shared';
  const shared = `${library.count} shared`;
  return library.average === null ? shared : `${shared} · ${library.average} average`;
}

function Summary({ displayName, username, isSupporter, summary, onShowMore, onOpenReview }) {
  // "Show more" only earns its place when the top-three lists are actually
  // hiding something - otherwise the summary already is the full list.
  const shown = summary.libraries.reduce((count, library) => count + library.top.length, 0);
  const hasMore = summary.total > shown;

  return (
    <>
      <div className={`profile__summary${isSupporter ? ' profile__summary--supporter' : ''}`}>
        <div className={`profile__avatar${isSupporter ? ' is-supporter' : ''}`} aria-hidden="true">
          {(displayName || '?').slice(0, 1).toUpperCase()}
        </div>
        <div className="profile__identity">
          <p className="profile__name">
            {displayName || 'Anonymous'}
            <SupporterMark isSupporter={isSupporter} size="lg" />
          </p>
          {username ? <p className="profile__username">@{username}</p> : null}
          {/* Said in words as well as in gold: the ring alone reads as
              decoration, and nobody would guess what it meant. */}
          {isSupporter ? <p className="profile__supporter">Supporter</p> : null}
        </div>
      </div>

      {summary.total === 0 ? (
        /* The server only ever hands back what this profile chose to share,
           so an empty panel is a privacy setting, not a bug - say so rather
           than letting it look broken. */
        <p className="settings__row-desc">
          {displayName || 'This user'} hasn&apos;t shared any reviews publicly.
        </p>
      ) : (
        <>
          <div className="profile__layout">
            <section className="profile__col profile__col--stats">
              <h3 className="profile__col-title">Stats</h3>

              <div className="profile__statlist">
                <Stat
                  value={summary.total}
                  label={
                    summary.activeLibraries > 1
                      ? `shared, across ${summary.activeLibraries} libraries`
                      : summary.total === 1
                        ? 'shared review'
                        : 'shared reviews'
                  }
                />
                <Stat
                  value={summary.perfect > 0 ? summary.perfect : (summary.best?.overallScore ?? '—')}
                  label={
                    summary.perfect > 0
                      ? summary.perfect === 1
                        ? 'perfect 100'
                        : 'perfect 100s'
                      : summary.best
                        ? `highest — ${summary.best.title}`
                        : 'highest'
                  }
                />
              </div>

              {/* One average per library, never one across all three - the
                  mean of a game, a film and a series answers no question. */}
              <ProfileChart title="Average by library">
                <div className="bars bars--compact">
                  {summary.libraries
                    .filter((library) => library.average !== null)
                    .map((library) => (
                      <MiniBar
                        key={library.key}
                        label={library.label}
                        value={library.average}
                        color={scoreBand(library.average).color}
                        display={String(library.average)}
                        note={`${library.count} shared`}
                      />
                    ))}
                </div>
              </ProfileChart>

              <ProfileChart title="Score spread" note="Where their scores land on the 1-100 scale.">
                <MiniColumns bands={summary.bands} />
              </ProfileChart>

              {/* The bit that actually says something about their taste. */}
              {summary.libraries
                .filter((library) => library.categories.length > 0)
                .map((library) => (
                  <ProfileChart
                    key={library.key}
                    title={`${library.label} — by category`}
                    note="How they score each part, on average."
                  >
                    <div className="bars bars--compact">
                      {library.categories.map((category) => (
                        <MiniBar
                          key={category.key}
                          label={category.label}
                          value={category.value}
                          color={scoreBand(category.value).color}
                          display={String(category.value)}
                        />
                      ))}
                    </div>
                  </ProfileChart>
                ))}

              {summary.best && summary.worst ? (
                <dl className="profile__breakdown">
                  <div className="profile__breakdown-row">
                    <dt>Highest</dt>
                    <dd>
                      {summary.best.title} · {summary.best.overallScore}
                    </dd>
                  </div>
                  <div className="profile__breakdown-row">
                    <dt>Lowest</dt>
                    <dd>
                      {summary.worst.title} · {summary.worst.overallScore}
                    </dd>
                  </div>
                </dl>
              ) : null}
            </section>

            <section className="profile__col profile__col--top">
              <h3 className="profile__col-title">Top rated</h3>

              {summary.libraries.map((library) => (
                <LibrarySection key={library.key} library={library} onOpenReview={onOpenReview} />
              ))}

              {hasMore ? (
                <button type="button" className="btn btn--ghost profile__showmore" onClick={onShowMore}>
                  Show more
                  <ChevronRightIcon />
                </button>
              ) : null}
            </section>
          </div>

          <p className="settings__row-desc">
            Only the reviews this user has chosen to share are listed here. Open one to see how
            they scored it category by category.
          </p>
        </>
      )}
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

/** A titled block in the stats column - the sheet's version of a Stats-tab chart. */
function ProfileChart({ title, note, children }) {
  return (
    <section className="profile__chart">
      <h4 className="profile__chart-title">{title}</h4>
      {note ? <p className="profile__chart-note">{note}</p> : null}
      {children}
    </section>
  );
}

/**
 * The Stats tab's horizontal bar, narrowed for the profile column. Same
 * markup and classes, so the two pages read as one app.
 */
function MiniBar({ label, value, color, display, note = null }) {
  return (
    <div className="bar bar--compact" title={`${label}: ${display}`}>
      <span className="bar__label">
        {label}
        {note ? <em className="bar__sublabel">{note}</em> : null}
      </span>
      <span className="bar__track">
        <span
          className="bar__fill"
          style={{ width: `${Math.max(1.5, value)}%`, background: color }}
        />
      </span>
      <span className="bar__value">{display}</span>
    </div>
  );
}

/** The score-distribution columns, sized for a side column. */
function MiniColumns({ bands }) {
  const max = Math.max(1, ...bands.map((band) => band.count));

  return (
    <div className="cols cols--compact">
      {bands.map((band) => (
        <div className="col" key={band.key}>
          <div className="col__plot">
            <div
              className="col__bar"
              style={{ height: `${(band.count / max) * 100}%`, background: band.color }}
              title={`${band.name} (${band.label}): ${band.count}`}
            />
          </div>
          {/* Only the ends are labelled - nine numbers in this width is a
              smear, and the shape is what the chart is for. */}
          <span className="col__label">
            {band.key === '0-19' ? '0' : band.key === '90-100' ? '100' : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

/** One library's top few reviews, as they appear in the summary column. */
function LibrarySection({ library, onOpenReview }) {
  return (
    <section className="profile__section">
      <header className="profile__section-head">
        <div>
          <h4 className="profile__section-title">{library.label}</h4>
          <p className="profile__section-meta">{libraryMeta(library)}</p>
        </div>
      </header>

      {library.top.length > 0 ? (
        <div className="profile__reviews">
          {library.top.map((review, index) => (
            <ProfileReview
              key={review.id}
              review={review}
              rank={index + 1}
              onOpen={() => onOpenReview(review.id)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Everything they've shared, in place of the summary. Kept grouped by
 * library and in the same rank order the summary uses, so the top three of
 * each are still the first three here - the page reads as an extension of
 * what was just on screen rather than a different list.
 */
function FullList({ summary, onOpenReview }) {
  const stocked = summary.libraries.filter((library) => library.count > 0);

  return (
    <>
      {stocked.map((library) => (
        <section key={library.key} className="profile__section">
          <header className="profile__section-head">
            <div>
              <h3 className="profile__section-title">{library.label}</h3>
              <p className="profile__section-meta">{libraryMeta(library)}</p>
            </div>
          </header>
          <div className="profile__reviews">
            {library.all.map((review, index) => (
              <ProfileReview
                key={review.id}
                review={review}
                rank={index + 1}
                onOpen={() => onOpenReview(review.id)}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/**
 * One review as a row in a list. The whole row is the button - there is only
 * one thing to do with it, and the note excerpt here is deliberately not
 * expandable, since opening the review shows it in full anyway.
 */
function ProfileReview({ review, rank = null, onOpen }) {
  const cover = review.coverImageUrl ? window.api.catalogImageUrl(review.coverImageUrl) : null;
  // Someone who writes per-category but leaves the overall box empty used to
  // get a blank-looking row. Borrow their first category note instead, so
  // every row that has writing behind it shows some.
  const fallback = review.overallNote ? null : firstCategoryNote(review);

  return (
    <button type="button" className="profile__review profile__review--link" onClick={onOpen}>
      <div className="profile__review-head">
        {rank ? <span className="profile__rank">{rank}</span> : null}
        {cover ? <img className="profile__review-art" src={cover} alt="" loading="lazy" /> : null}
        <ScoreBadge value={review.overallScore} size="sm" />
        <p className="profile__review-title">{review.title}</p>
        <ChevronRightIcon />
      </div>

      {review.overallNote ? (
        <p className="profile__review-note">{firstSentences(review.overallNote, 2)}</p>
      ) : fallback ? (
        <p className="profile__review-note">
          <span className="profile__note-tag">{fallback.label}</span>
          {firstSentences(fallback.text, 2)}
        </p>
      ) : null}
    </button>
  );
}

/** One review in full: what they scored it overall, and on every category. */
function ReviewPage({ review, author }) {
  const cover = review.coverImageUrl ? window.api.catalogImageUrl(review.coverImageUrl) : null;

  return (
    <>
      <div className="profile__review-hero">
        {cover ? <img className="profile__hero-art" src={cover} alt="" /> : null}
        <div className="profile__hero-text">
          <p className="profile__name">{review.title}</p>
          <p className="profile__username">
            {author || 'This user'}&apos;s review
          </p>
        </div>
        <ScoreBadge value={review.overallScore} size="lg" />
      </div>

      {review.overallNote ? (
        <section className="profile__section">
          <h3 className="profile__section-title">Overall</h3>
          <p className="profile__review-note">{review.overallNote}</p>
        </section>
      ) : null}

      <section className="profile__section">
        <h3 className="profile__section-title">Breakdown</h3>
        <ReviewBreakdown review={review} />
      </section>
    </>
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
