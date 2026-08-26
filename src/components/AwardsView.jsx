import { useCallback, useEffect, useMemo, useState } from 'react';
import ScoreBadge from './ScoreBadge.jsx';
import { TrophyIcon } from './TrophyBadge.jsx';
import {
  PHASES,
  activeRound,
  clockOffset,
  formatCountdown,
  formatMoment,
  msToNextReveal,
  nextDeadline,
  participationBlocker,
  revealedCount,
  serverNow,
} from '../lib/awards.js';

/**
 * The awards tab: two rounds, a sealed tally, and a ceremony on a clock.
 *
 * Nothing here decides anything. The phase, the eligible items, the nominees
 * and the winners are all handed down by the server, and every write goes back
 * through an RPC that re-checks the rules. If this file were rewritten to lie
 * about what is allowed, the database would simply refuse it - which is the
 * point, because the anon key ships inside the installer.
 *
 * Cover art comes from the viewer's own library, matched on catalog identity.
 * The CSP deliberately blocks remote images, and nominees are usually things
 * the voter has played anyway; anything unowned falls back to a plain tile
 * rather than punching a hole in the policy for a picture.
 */
export default function AwardsView({ config, items, user, libraryKey }) {
  const [season, setSeason] = useState(null);
  const [ballots, setBallots] = useState({});
  const [shortlist, setShortlist] = useState({});
  const [results, setResults] = useState({});
  const [ballotLog, setBallotLog] = useState({});
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | error | signedOut
  const [error, setError] = useState(null);
  const [openCategory, setOpenCategory] = useState(null);
  const [busyCategory, setBusyCategory] = useState(null);
  const [tick, setTick] = useState(0);

  const offset = useMemo(() => clockOffset(season), [season]);
  // Recomputed every render; `tick` below is what forces those renders. Read
  // against the server's clock, not this machine's, so a user with a wrong
  // system time still sees the ceremony when everyone else does.
  const now = serverNow(offset);

  /** Local cover art by catalog identity, so nominees show the art you already have. */
  const coversById = useMemo(() => {
    const map = new Map();
    for (const item of items ?? []) {
      if (item.provider && item.providerId && item.mainImage) {
        map.set(`${item.provider}:${item.providerId}`, item.mainImage);
      }
    }
    return map;
  }, [items]);

  const load = useCallback(async () => {
    if (!user) {
      setStatus('signedOut');
      return;
    }
    setStatus('loading');
    const response = await window.api.awardSeason(libraryKey);
    if (!response?.ok) {
      setError(response?.error ?? 'Could not reach the awards.');
      setStatus('error');
      return;
    }
    const loaded = response.season;
    setSeason(loaded);

    const [mine, past] = await Promise.all([
      window.api.awardMyBallots(loaded.id),
      window.api.awardHistory(libraryKey),
    ]);
    if (mine?.ok) {
      setBallots(
        Object.fromEntries(mine.ballots.map((b) => [`${b.round}:${b.categoryKey}`, b])),
      );
    }
    if (past?.ok) setHistory(past.history);

    // The shortlist only exists from the moment voting opens, and the results
    // only from the reveal instant - asking earlier is an error, not an empty
    // list, so the phase gates the call rather than the response. Voting is
    // also the only phase that has anything to *do* with the nominees.
    if (loaded.phase === 'voting') {
      const list = await window.api.awardShortlist(loaded.id);
      if (list?.ok) setShortlist(list.shortlist);
    }
    if (loaded.phase === 'revealed') {
      const [won, log] = await Promise.all([
        window.api.awardResults(loaded.id),
        window.api.awardBallotLog(loaded.id),
      ]);
      if (won?.ok) setResults(won.results);
      if (log?.ok) setBallotLog(log.log);
    }
    setStatus('ready');
  }, [libraryKey, user]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * One timer drives every countdown on the screen. It only runs while
   * something is actually counting down, so an idle off-season tab costs
   * nothing.
   */
  useEffect(() => {
    if (status !== 'ready' || !season) return undefined;
    const deadline = nextDeadline(season);
    const staggering =
      season.phase === 'revealed' && msToNextReveal(season, serverNow(offset)) !== null;
    if (!deadline && !staggering) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [status, season, offset]);

  /**
   * Crossing a deadline while the tab is open has to change the tab. Without
   * this, someone who left it open through midnight would still be looking at
   * a nomination form the server has already closed.
   */
  useEffect(() => {
    if (status !== 'ready' || !season) return;
    const deadline = nextDeadline(season);
    if (deadline && serverNow(offset) >= Date.parse(deadline.at)) load();
  }, [tick, status, season, offset, load]);

  const round = season ? activeRound(season.phase) : null;
  const blocker = season ? participationBlocker(season) : null;
  const unlocked = season ? revealedCount(season, now) : 0;

  const pick = useCallback(
    async (categoryKey, candidate) => {
      if (!season || !round) return;
      setBusyCategory(categoryKey);
      const response = await window.api.awardCast({
        seasonId: season.id,
        round,
        categoryKey,
        provider: candidate.provider,
        providerId: candidate.providerId,
      });
      setBusyCategory(null);
      if (!response?.ok) {
        setError(response?.error ?? 'That pick was not accepted.');
        return;
      }
      setError(null);
      setBallots((prev) => ({
        ...prev,
        [`${round}:${categoryKey}`]: { round, categoryKey, ...candidate },
      }));
      setOpenCategory(null);
    },
    [season, round],
  );

  const withdraw = useCallback(
    async (categoryKey) => {
      if (!season || !round) return;
      setBusyCategory(categoryKey);
      const response = await window.api.awardWithdraw({
        seasonId: season.id,
        round,
        categoryKey,
      });
      setBusyCategory(null);
      if (!response?.ok) {
        setError(response?.error ?? 'Could not take that back.');
        return;
      }
      setError(null);
      setBallots((prev) => {
        const next = { ...prev };
        delete next[`${round}:${categoryKey}`];
        return next;
      });
    },
    [season, round],
  );

  if (status === 'signedOut') {
    return (
      <div className="screen awards">
        <EmptyPanel
          title="The awards need an account"
          body={`Sign in from Settings to take part in the ${config.label} awards. Everything else in the app keeps working offline.`}
        />
      </div>
    );
  }

  if (status === 'loading') {
    return (
      <div className="screen awards">
        <p className="awards__loading">Checking the season...</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="screen awards">
        <EmptyPanel title="Could not reach the awards" body={error} />
        <button type="button" className="btn btn--ghost" onClick={load}>
          Try again
        </button>
      </div>
    );
  }

  const deadline = nextDeadline(season);
  const phase = PHASES[season.phase] ?? PHASES.upcoming;

  return (
    <div className="screen awards">
      <header className="awards__header">
        <div className="awards__title">
          <span className="awards__crest" aria-hidden="true">
            <TrophyIcon />
          </span>
          <div>
            <h2>
              The {season.year} {config.label} Awards
            </h2>
            <p className="awards__blurb">{phase.blurb}</p>
          </div>
        </div>

        {deadline ? (
          <div className="awards__countdown">
            <span className="awards__countdown-value">
              {formatCountdown(Date.parse(deadline.at) - now)}
            </span>
            <span className="awards__countdown-label">
              {deadline.label} · {formatMoment(deadline.at)}
            </span>
          </div>
        ) : null}
      </header>

      <Timeline season={season} />

      {error ? <p className="awards__error">{error}</p> : null}

      {blocker ? <p className="awards__blocker">{blocker}</p> : null}

      {season.phase === 'shortlisting' ? (
        <EmptyPanel
          title="Nominations are closed"
          body="The nominees are being counted. They appear here the moment voting opens - nobody can see the tally before then, including whoever runs this."
        />
      ) : null}

      {season.phase === 'sealed' ? (
        <EmptyPanel
          title="The results are sealed"
          body={`Voting is over. The ceremony starts on its own at ${formatMoment(season.resultsPublishedAt)} - one category at a time.`}
        />
      ) : null}

      {season.phase === 'revealed' ? (
        <Ceremony
          season={season}
          results={results}
          ballotLog={ballotLog}
          unlocked={unlocked}
          now={now}
          coversById={coversById}
        />
      ) : null}

      {round ? (
        <div className="awards__categories">
          {season.categories.map((category) => (
            <CategoryCard
              key={category.key}
              category={category}
              season={season}
              round={round}
              config={config}
              locked={Boolean(blocker)}
              busy={busyCategory === category.key}
              ballot={ballots[`${round}:${category.key}`] ?? null}
              nominees={shortlist[category.key] ?? null}
              coversById={coversById}
              open={openCategory === category.key}
              onToggle={() =>
                setOpenCategory((current) => (current === category.key ? null : category.key))
              }
              onPick={(candidate) => pick(category.key, candidate)}
              onWithdraw={() => withdraw(category.key)}
            />
          ))}
        </div>
      ) : null}

      {season.phase === 'upcoming' ? (
        <EmptyPanel
          title={`Nominations open ${formatMoment(season.nominationsOpenAt)}`}
          body={`Anything you log a ${config.date.label.toLowerCase()} date of ${season.year} for is in the running. Keep ranking.`}
        />
      ) : null}

      {/* The season being revealed above is not also history. */}
      <HallOfFame
        history={history.filter((past) => past.year !== season.year)}
        config={config}
        coversById={coversById}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Phase timeline - the whole December at a glance
 * ------------------------------------------------------------------ */
function Timeline({ season }) {
  const steps = [
    { key: 'nominating', label: 'Nominations', at: season.nominationsOpenAt },
    { key: 'voting', label: 'Voting', at: season.votingOpenAt },
    { key: 'revealed', label: 'Ceremony', at: season.resultsPublishedAt },
  ];
  const order = ['upcoming', 'nominating', 'shortlisting', 'voting', 'sealed', 'revealed'];
  const current = order.indexOf(season.phase);

  return (
    <ol className="timeline" aria-label="Season timeline">
      {steps.map((step) => {
        const at = order.indexOf(step.key);
        const state = current > at ? 'is-done' : current === at ? 'is-now' : '';
        return (
          <li key={step.key} className={`timeline__step ${state}`}>
            <span className="timeline__dot" aria-hidden="true" />
            <span className="timeline__label">{step.label}</span>
            <span className="timeline__date">{formatMoment(step.at)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ *
 * One category, in whichever round is running
 * ------------------------------------------------------------------ */
function CategoryCard({
  category,
  season,
  round,
  config,
  locked,
  busy,
  ballot,
  nominees,
  coversById,
  open,
  onToggle,
  onPick,
  onWithdraw,
}) {
  const [eligible, setEligible] = useState(null);
  const [loading, setLoading] = useState(false);

  // Round one asks the server what this user may put forward; round two is
  // fixed to the shortlist. Either way the list is never assembled here.
  useEffect(() => {
    if (!open || round !== 'nominate' || eligible) return;
    let cancelled = false;
    setLoading(true);
    window.api.awardEligible(season.id, category.key).then((response) => {
      if (cancelled) return;
      setEligible(response?.ok ? response.items : []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, round, eligible, season.id, category.key]);

  const choices = round === 'vote' ? nominees : eligible;
  const emptyMessage =
    round === 'vote'
      ? 'Nobody nominated anything here.'
      : category.basis === 'release_year'
        ? `Nothing in your library came out in ${season.year}.`
        : category.basis === 'first_played_year'
          ? `You did not log a ${config.date.label.toLowerCase()} date of ${season.year} for anything yet.`
          : `Add something to your ${config.label.toLowerCase()} library first.`;

  return (
    <section className={`award${ballot ? ' is-picked' : ''}`}>
      <header className="award__head">
        <div>
          <h3 className="award__name">{category.label}</h3>
          {category.blurb ? <p className="award__blurb">{category.blurb}</p> : null}
        </div>
        {ballot ? (
          <span className="award__chosen">
            {round === 'vote' ? 'Voted' : 'Nominated'}
          </span>
        ) : null}
      </header>

      {ballot ? (
        <div className="award__pick">
          <Cover title={ballot.title} file={coversById.get(`${ballot.provider}:${ballot.providerId}`)} />
          <span className="award__pick-title">{ballot.title}</span>
          <div className="award__pick-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={onToggle}
              disabled={locked || busy}
            >
              Change
            </button>
            <button
              type="button"
              className="btn btn--danger-ghost btn--sm"
              onClick={onWithdraw}
              disabled={locked || busy}
            >
              Withdraw
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn--ghost award__choose"
          onClick={onToggle}
          disabled={locked || busy}
          aria-expanded={open}
        >
          {round === 'vote' ? 'Pick a winner' : `Nominate a ${config.item}`}
        </button>
      )}

      {open && !locked ? (
        <div className="award__picker">
          {loading ? (
            <p className="award__hint">Checking what you can put forward...</p>
          ) : (choices ?? []).length === 0 ? (
            <p className="award__hint">{emptyMessage}</p>
          ) : (
            <ul className="award__options">
              {choices.map((choice) => {
                const chosen =
                  ballot?.provider === choice.provider && ballot?.providerId === choice.providerId;
                return (
                  <li key={`${choice.provider}:${choice.providerId}`}>
                    <button
                      type="button"
                      className={`award__option${chosen ? ' is-on' : ''}`}
                      onClick={() => onPick(choice)}
                      disabled={busy}
                    >
                      <Cover
                        title={choice.title}
                        file={coversById.get(`${choice.provider}:${choice.providerId}`)}
                      />
                      <span className="award__option-text">
                        <span className="award__option-title">{choice.title}</span>
                        {choice.releaseYear ? (
                          <span className="award__option-meta">{choice.releaseYear}</span>
                        ) : null}
                      </span>
                      {typeof choice.overallScore === 'number' ? (
                        <ScoreBadge value={choice.overallScore} />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The ceremony
 * ------------------------------------------------------------------ */
function Ceremony({ season, results, ballotLog, unlocked, now, coversById }) {
  const waiting = msToNextReveal(season, now);

  return (
    <div className="ceremony">
      {season.categories.map((category, index) => {
        if (index >= unlocked) return null;
        const won = results[category.key] ?? {};
        return (
          <section key={category.key} className="ceremony__award">
            <h3 className="ceremony__name">{category.label}</h3>
            <div className="ceremony__winners">
              <WinnerCard
                kind="community"
                label="Community Choice"
                winner={won.community}
                coversById={coversById}
                // A category nobody turned out for is left unawarded rather
                // than handed to whoever cast the single vote.
                emptyText="Not enough votes to award this year."
              />
              {category.computed_key ? (
                <WinnerCard
                  kind="critics"
                  label="Critics' Choice"
                  winner={won.critics}
                  coversById={coversById}
                  emptyText="Not enough scored copies to compute this year."
                />
              ) : null}
            </div>
            <BallotLog entries={ballotLog[category.key] ?? []} />
          </section>
        );
      })}

      {waiting !== null ? (
        <p className="ceremony__next">
          Next award in <strong>{formatCountdown(waiting)}</strong>
        </p>
      ) : null}
    </div>
  );
}

function WinnerCard({ kind, label, winner, coversById, emptyText }) {
  return (
    <div className={`winner winner--${kind}`}>
      <span className="winner__label">
        <TrophyIcon />
        {label}
      </span>
      {winner ? (
        <>
          <Cover
            title={winner.title}
            file={coversById.get(`${winner.provider}:${winner.providerId}`)}
            size="lg"
          />
          <span className="winner__title">{winner.title}</span>
          <span className="winner__meta">
            {kind === 'community'
              ? `${winner.voteCount} vote${winner.voteCount === 1 ? '' : 's'}`
              : `${Math.round(winner.averageScore)} average across ${winner.voteCount} ${
                  winner.voteCount === 1 ? 'copy' : 'copies'
                }`}
          </span>
        </>
      ) : (
        <span className="winner__empty">{emptyText}</span>
      )}
    </div>
  );
}

/** Who put what forward. Sealed with everything else, opened with the results. */
function BallotLog({ entries }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  const votes = entries.filter((entry) => entry.round === 'vote');
  const nominations = entries.filter((entry) => entry.round === 'nominate');

  return (
    <div className="ballotlog">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? 'Hide' : 'Who picked what'}
      </button>
      {open ? (
        <div className="ballotlog__body">
          {[
            ['Votes', votes],
            ['Nominations', nominations],
          ].map(([heading, list]) =>
            list.length === 0 ? null : (
              <div key={heading} className="ballotlog__group">
                <span className="ballotlog__heading">{heading}</span>
                <ul>
                  {list.map((entry, index) => (
                    <li key={`${entry.displayName}-${entry.round}-${index}`}>
                      <strong>{entry.displayName}</strong> {entry.title}
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Hall of Fame - what the tab is for the other eleven months
 * ------------------------------------------------------------------ */
function HallOfFame({ history, config, coversById }) {
  // A year where nobody voted has no Community Choice to list, so it is left
  // out entirely rather than printed as a heading over nothing.
  const finished = (history ?? [])
    .map((season) => ({
      year: season.year,
      winners: season.winners.filter((winner) => winner.kind === 'community'),
    }))
    .filter((season) => season.winners.length > 0);
  if (finished.length === 0) return null;

  return (
    <section className="hall">
      <h3 className="hall__title">Hall of Fame</h3>
      {finished.map((season) => (
        <div key={season.year} className="hall__season">
          <span className="hall__year">{season.year}</span>
          <ul className="hall__list">
            {season.winners.map((winner) => (
              <li key={`${winner.categoryKey}-${winner.kind}`} className="hall__row">
                <Cover
                  title={winner.title}
                  file={coversById.get(`${winner.provider}:${winner.providerId}`)}
                />
                <span className="hall__label">{winner.label}</span>
                <span className="hall__winner">{winner.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="hall__note">
        Community Choice winners. Every win also shows as a trophy on the {config.item} itself.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Shared bits
 * ------------------------------------------------------------------ */

/** Local art when the viewer owns it, initials when they do not. */
function Cover({ title, file, size = 'sm' }) {
  const src = file ? window.api.imageUrl(file) : null;
  if (src) return <img className={`awardcover awardcover--${size}`} src={src} alt="" />;
  return (
    <span className={`awardcover awardcover--${size} awardcover--empty`} aria-hidden="true">
      {(title ?? '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

function EmptyPanel({ title, body }) {
  return (
    <div className="awards__panel">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
