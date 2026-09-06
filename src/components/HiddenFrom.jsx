import { useCallback, useEffect, useState } from 'react';

/**
 * "Hidden from" for one title.
 *
 * Only friends are listed, because only a friend can see the review in the
 * first place - hiding it from anyone else would be a row that does nothing,
 * and hide_review_from() rejects it anyway.
 *
 * The list this draws is advisory. What actually stops the review being
 * returned is the restrictive policy in supabase/blocks.sql, so a stale or
 * wrong render here cannot leak anything.
 */
export default function HiddenFrom({ item }) {
  const [open, setOpen] = useState(false);
  const [friends, setFriends] = useState([]);
  const [hidden, setHidden] = useState(new Set());
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const provider = item.provider;
  const providerId = item.providerId;

  const load = useCallback(async () => {
    const [friendsResult, blocksResult] = await Promise.all([
      window.api.fetchFriends(),
      window.api.fetchReviewBlocks(),
    ]);
    if (friendsResult?.ok) setFriends(friendsResult.friends ?? []);
    if (blocksResult?.ok) {
      // One call returns every block this user owns; this control only cares
      // about the ones aimed at the title currently open.
      setHidden(
        new Set(
          (blocksResult.blocks ?? [])
            .filter(
              (block) =>
                block.provider === provider && block.providerId === String(providerId),
            )
            .map((block) => block.blockedId),
        ),
      );
    }
    setLoaded(true);
  }, [provider, providerId]);

  useEffect(() => {
    setLoaded(false);
    load();
  }, [load]);

  async function toggle(friend) {
    const isHidden = hidden.has(friend.id);
    setBusy(friend.id);
    setError('');
    const response = isHidden
      ? await window.api.unhideReviewFrom(friend.id, provider, providerId)
      : await window.api.hideReviewFrom(friend.id, provider, providerId);
    setBusy(null);

    if (!response?.ok) {
      setError(response?.error ?? 'That did not save. Try again.');
      return;
    }
    setHidden((current) => {
      const next = new Set(current);
      if (isHidden) next.delete(friend.id);
      else next.add(friend.id);
      return next;
    });
  }

  const count = hidden.size;

  return (
    <div className="hidden-from">
      <div className="settings__row">
        <div>
          <p className="settings__row-title">Hidden from</p>
          <p className="settings__row-desc">
            {count === 0
              ? 'Everyone who can see your reviews can see this one.'
              : `${count} ${count === 1 ? 'person' : 'people'} can't see this title at all — it doesn't appear on your board for them, and nor does your score.`}
          </p>
        </div>
        <button
          type="button"
          className={`btn btn--ghost btn--sm${open ? ' is-on' : ''}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {count === 0 ? 'Hide from…' : `${count} hidden`}
        </button>
      </div>

      {open ? (
        <div className="hidden-from__panel">
          {!loaded ? (
            <p className="hidden-from__note">Loading your friends…</p>
          ) : friends.length === 0 ? (
            <p className="hidden-from__note">
              You have no friends added yet, so there is nobody who can see this review.
            </p>
          ) : (
            <ul className="hidden-from__list">
              {friends.map((friend) => {
                const isHidden = hidden.has(friend.id);
                return (
                  <li key={friend.id}>
                    <button
                      type="button"
                      className={`hidden-from__person${isHidden ? ' is-hidden' : ''}`}
                      aria-pressed={isHidden}
                      disabled={busy === friend.id}
                      onClick={() => toggle(friend)}
                    >
                      <span className="hidden-from__who">
                        <span className="hidden-from__name">
                          {friend.displayName || friend.username}
                        </span>
                        <span className="hidden-from__handle">@{friend.username}</span>
                      </span>
                      <span className="hidden-from__state">
                        {busy === friend.id ? '…' : isHidden ? 'Hidden' : 'Can see'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {error ? <p className="hidden-from__error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
