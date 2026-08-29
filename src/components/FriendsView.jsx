import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const SEARCH_DEBOUNCE_MS = 300;
/** Matches search_profiles()' own guard - below this the server returns nothing. */
const MIN_QUERY = 2;

/**
 * Find people, answer the ones who found you, and see who you are already
 * friends with.
 *
 * Friendship is what lets two people see each other's whole board with
 * nothing in common, so every state change here goes through a SECURITY
 * DEFINER function in the database (see supabase/social.sql). This component
 * only ever reports what was clicked - it is never the thing that decides
 * whether a request is allowed.
 */
export default function FriendsView({ onClose, onOpenProfile, onFriendsChanged }) {
  const ref = useRef(null);
  const searchRef = useRef(null);
  // Bumped per keystroke so a slow search can never overwrite a newer one.
  const requestId = useRef(0);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const [friends, setFriends] = useState([]);
  const [incoming, setIncoming] = useState([]);
  const [outgoing, setOutgoing] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  /** The person id currently mid-request, so their row alone shows as busy. */
  const [pending, setPending] = useState(null);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    searchRef.current?.focus({ preventScroll: true });
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

  const load = useCallback(async () => {
    const response = await window.api.fetchFriends();
    setLoading(false);
    if (!response?.ok) {
      setError(response?.error ?? 'Could not load your friends.');
      return;
    }
    setError(null);
    setFriends(response.friends ?? []);
    setIncoming(response.incoming ?? []);
    setOutgoing(response.outgoing ?? []);
    onFriendsChanged?.(response);
  }, [onFriendsChanged]);

  useEffect(() => {
    load();
  }, [load]);

  /* ---- search --------------------------------------------------------- */
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) {
      setResults([]);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      const response = await window.api.searchProfiles(trimmed);
      if (id !== requestId.current) return;
      setSearching(false);
      if (!response?.ok) {
        setError(response?.error ?? 'Search failed.');
        return;
      }
      setError(null);
      setResults(response.results ?? []);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  /**
   * Every action re-reads both lists rather than patching state in place:
   * accepting a request moves someone between three lists at once, and the
   * server is the only thing that knows the real outcome (asking someone
   * who already asked you makes you friends immediately, for instance).
   */
  const act = useCallback(
    async (personId, run) => {
      if (pending) return;
      setPending(personId);
      try {
        const response = await run();
        if (!response?.ok) {
          setError(response?.error ?? 'That did not work.');
          return;
        }
        setError(null);
        await load();
        // Keep the search list honest about the button it should now show.
        if (query.trim().length >= MIN_QUERY) {
          const refreshed = await window.api.searchProfiles(query.trim());
          if (refreshed?.ok) setResults(refreshed.results ?? []);
        }
      } finally {
        setPending(null);
      }
    },
    [load, pending, query],
  );

  return createPortal(
    <div className="overlay" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Friends" tabIndex={-1} ref={ref}>
        <header className="sheet__head">
          <h2>Friends</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="settings__body">
          <section className="settings__section">
            <h3 className="keys__title">Find people</h3>
            <p className="settings__row-desc">
              Search by username. Once you are friends you can each see the other&apos;s full
              profile, even with nothing in common.
            </p>
            <div className="catalog__search">
              <SearchIcon />
              <input
                ref={searchRef}
                type="text"
                className="catalog__input"
                placeholder="Username or display name..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                spellCheck="false"
                autoComplete="off"
              />
              {query ? (
                <button
                  type="button"
                  className="catalog__clear"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                >
                  &times;
                </button>
              ) : null}
            </div>

            {error ? <p className="field__hint field__hint--error">{error}</p> : null}

            {query.trim().length >= MIN_QUERY ? (
              <div className="people">
                {searching && results.length === 0 ? (
                  <p className="settings__row-desc">Searching…</p>
                ) : null}
                {!searching && results.length === 0 ? (
                  <p className="settings__row-desc">Nobody matches “{query.trim()}”.</p>
                ) : null}
                {results.map((person) => (
                  <Person
                    key={person.id}
                    person={person}
                    busy={pending === person.id}
                    onOpenProfile={onOpenProfile}
                    action={
                      <SearchAction
                        person={person}
                        busy={pending === person.id}
                        onAdd={() => act(person.id, () => window.api.sendFriendRequest(person.id))}
                        onAccept={() =>
                          act(person.id, () => window.api.respondFriendRequest(person.id, true))
                        }
                      />
                    }
                  />
                ))}
              </div>
            ) : null}
          </section>

          {incoming.length > 0 ? (
            <section className="settings__section">
              <h3 className="keys__title">Requests</h3>
              <div className="people">
                {incoming.map((person) => (
                  <Person
                    key={person.id}
                    person={person}
                    busy={pending === person.id}
                    onOpenProfile={onOpenProfile}
                    action={
                      <div className="people__actions">
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          disabled={pending === person.id}
                          onClick={() =>
                            act(person.id, () => window.api.respondFriendRequest(person.id, true))
                          }
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={pending === person.id}
                          onClick={() =>
                            act(person.id, () => window.api.respondFriendRequest(person.id, false))
                          }
                        >
                          Decline
                        </button>
                      </div>
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}

          {outgoing.length > 0 ? (
            <section className="settings__section">
              <h3 className="keys__title">Sent</h3>
              <div className="people">
                {outgoing.map((person) => (
                  <Person
                    key={person.id}
                    person={person}
                    busy={pending === person.id}
                    onOpenProfile={onOpenProfile}
                    action={
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={pending === person.id}
                        onClick={() => act(person.id, () => window.api.removeFriend(person.id))}
                      >
                        Cancel
                      </button>
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="settings__section">
            <h3 className="keys__title">Your friends</h3>
            {loading ? <p className="settings__row-desc">Loading…</p> : null}
            {!loading && friends.length === 0 ? (
              <p className="settings__row-desc">
                No friends yet. Search for someone above — they will get a request to accept.
              </p>
            ) : null}
            <div className="people">
              {friends.map((person) => (
                <Person
                  key={person.id}
                  person={person}
                  busy={pending === person.id}
                  onOpenProfile={onOpenProfile}
                  action={
                    <button
                      type="button"
                      className="btn btn--danger-ghost btn--sm"
                      disabled={pending === person.id}
                      onClick={() => act(person.id, () => window.api.removeFriend(person.id))}
                    >
                      Remove
                    </button>
                  }
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The right-hand button for a search hit depends on where the two of you already stand. */
function SearchAction({ person, busy, onAdd, onAccept }) {
  if (person.friendStatus === 'friends') return <span className="people__note">Friends</span>;
  if (person.friendStatus === 'pending_out') return <span className="people__note">Requested</span>;
  if (person.friendStatus === 'pending_in') {
    return (
      <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={onAccept}>
        Accept
      </button>
    );
  }
  return (
    <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onAdd}>
      Add friend
    </button>
  );
}

function Person({ person, action, onOpenProfile }) {
  return (
    <div className="people__row">
      <button
        type="button"
        className="people__identity"
        onClick={() => onOpenProfile({ id: person.id, displayName: person.displayName, username: person.username })}
        title={`View ${person.displayName}'s profile`}
      >
        <span className="people__avatar" aria-hidden="true">
          {(person.displayName || '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="people__text">
          <span className="people__name">{person.displayName}</span>
          {person.username ? <span className="people__username">@{person.username}</span> : null}
        </span>
      </button>
      {action}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
