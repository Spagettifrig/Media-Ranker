import { useCallback, useEffect, useState } from 'react';

/**
 * The Settings summary: everything you have hidden, from anyone, in one list.
 *
 * The per-item control in DetailView is the gesture; this is the audit. It
 * exists because a block is invisible by design - there is no cue anywhere
 * else in the app that a title is hidden from someone, so without this the
 * only way to find one would be to open every game in turn.
 *
 * Grouped by person rather than by title: "what can Sam not see" is the
 * question people actually ask, and it is the one that catches a block you
 * set months ago and forgot.
 */
export default function HiddenTitles({ user }) {
  const [blocks, setBlocks] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!user) {
      setBlocks([]);
      setLoaded(true);
      return;
    }
    const response = await window.api.fetchReviewBlocks();
    if (response?.ok) setBlocks(response.blocks ?? []);
    else setError(response?.error ?? '');
    setLoaded(true);
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  async function unhide(block) {
    const key = `${block.blockedId}:${block.provider}:${block.providerId}`;
    setBusy(key);
    setError('');
    const response = await window.api.unhideReviewFrom(
      block.blockedId,
      block.provider,
      block.providerId,
    );
    setBusy('');
    if (!response?.ok) {
      setError(response?.error ?? 'That did not save. Try again.');
      return;
    }
    setBlocks((current) =>
      current.filter(
        (row) =>
          !(
            row.blockedId === block.blockedId &&
            row.provider === block.provider &&
            row.providerId === block.providerId
          ),
      ),
    );
  }

  if (!user) return null;

  // Group by person, preserving the username order the RPC already sorted on.
  const people = [];
  const byId = new Map();
  for (const block of blocks) {
    let entry = byId.get(block.blockedId);
    if (!entry) {
      entry = { id: block.blockedId, username: block.username, displayName: block.displayName, items: [] };
      byId.set(block.blockedId, entry);
      people.push(entry);
    }
    entry.items.push(block);
  }

  return (
    <section className="settings__section">
      <h3 className="keys__title">Hidden titles</h3>
      <p className="settings__row-desc">
        Reviews you've hidden from specific people. They can't see the title on your board, your
        score, or your notes — to them it simply isn't there. Set this on any game from its own
        page, under Sharing.
      </p>

      {!loaded ? (
        <p className="hidden-from__note">Loading…</p>
      ) : people.length === 0 ? (
        <p className="hidden-from__note">You haven't hidden anything from anyone.</p>
      ) : (
        <div className="hidden-titles">
          {people.map((person) => (
            <div key={person.id} className="hidden-titles__group">
              <p className="hidden-titles__who">
                <span className="hidden-from__name">{person.displayName || person.username}</span>
                <span className="hidden-from__handle">@{person.username}</span>
                <span className="hidden-titles__count">
                  {person.items.length} hidden
                </span>
              </p>
              <ul className="hidden-titles__list">
                {person.items.map((block) => {
                  const key = `${block.blockedId}:${block.provider}:${block.providerId}`;
                  return (
                    <li key={key} className="hidden-titles__row">
                      <span className="hidden-titles__title">{block.title}</span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busy === key}
                        onClick={() => unhide(block)}
                      >
                        {busy === key ? '…' : 'Unhide'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {error ? <p className="hidden-from__error">{error}</p> : null}
    </section>
  );
}
