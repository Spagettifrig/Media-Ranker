import { useRef, useState } from 'react';
import { steamDuplicate } from '../lib/steam-import.js';

const PLATFORMS = {
  psn: {
    name: 'PlayStation',
    help: 'Imports every PS4 and PS5 game you have played, with playtime. PS3 and Vita games are not listed by Sony.',
  },
  xbox: {
    name: 'Xbox',
    help: 'Imports every game in your Xbox history, from Xbox 360 to Series X|S and PC. Xbox does not share playtime.',
  },
};

/**
 * One-step console import. The sign-in window belongs to Sony or Microsoft;
 * the main process keeps the token for this one read and then drops it.
 */
export default function ConsoleImport({ store, items, onImport, onRefreshPlaytime, onBusyChange, stop }) {
  const platform = PLATFORMS[store];
  const [code, setCode] = useState('');
  const [busy, setBusyState] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const setBusy = (value) => { busyRef.current = value; setBusyState(value); onBusyChange(value); };

  async function signInAndImport(npsso) {
    if (busyRef.current) return;
    setBusy(true); setError(''); stop.current = false;
    setProgress(npsso ? `Reading your ${platform.name} games…` : `Sign in to ${platform.name} in the window that opened. It closes by itself when you are done.`);
    let added = 0;
    try {
      const result = await window.api.loadConsoleLibrary(store, npsso);
      setCode('');
      if (!result?.ok) throw new Error(result?.error ?? `Could not read your ${platform.name} games.`);
      const refreshed = onRefreshPlaytime(result.games);
      const fresh = result.games.filter((game) => !steamDuplicate(game, items));
      const similar = result.games.filter((game) => steamDuplicate(game, items)?.kind === 'possible').length;
      let coversMissing = 0;
      for (let i = 0; i < fresh.length && !stop.current; i += 10) {
        setProgress(`Importing ${i + 1}–${Math.min(i + 10, fresh.length)} of ${fresh.length}…`);
        const batch = await window.api.importConsoleGames(result.sessionId, fresh.slice(i, i + 10).map((game) => game.storeId));
        if (!batch?.ok) throw new Error(batch?.error ?? 'Import failed.');
        added += onImport(batch.entries);
        coversMissing += batch.entries.filter((entry) => entry.imageUrl && !entry.file).length;
      }
      setProgress([
        fresh.length ? `${added} ${added === 1 ? 'game' : 'games'} added to Unrated.` : `Your library is up to date: no new ${platform.name} games to add.`,
        stop.current ? 'Stopped; completed imports are kept.' : '',
        refreshed ? `Playtime updated for ${refreshed} ${refreshed === 1 ? 'game' : 'games'} already in your library.` : '',
        similar ? `${similar} ${similar === 1 ? 'game was' : 'games were'} skipped because a game with the same title is already in your library.` : '',
        coversMissing ? `${coversMissing} covers could not be downloaded; you can add artwork in game details.` : '',
      ].filter(Boolean).join(' '));
    } catch (failure) {
      setError(added ? `${failure.message} ${added} games were added before this; retry skips them.` : failure.message);
      setProgress('');
    } finally { setBusy(false); }
  }

  return <>
    <div className="steam-import__form">
      <p className="steam-import__help">{platform.help} You sign in on {platform.name}&apos;s own page, so Game Ranker never sees your password, and the sign-in is discarded after the import. This uses the same private connection as {platform.name}&apos;s phone app, so it can stop working if {platform.name} changes it.</p>
      <div className="steam-import__actions">
        <button className="btn btn--primary" disabled={busy} onClick={() => signInAndImport()}>Sign in and import all</button>
      </div>
      {store === 'psn' ? <details><summary>Sign-in window not working? Use a sign-in code instead</summary>
        <p className="steam-import__help">Sign in at playstation.com in your browser, then open ca.account.sony.com/api/v1/ssocookie and copy the value after &quot;npsso&quot;. Treat it like a password: it is used once and not saved.</p>
        <form className="steam-import__actions" onSubmit={(event) => { event.preventDefault(); signInAndImport(code.trim()); }}>
          <input className="steam-import__input" type="password" autoComplete="off" aria-label="PlayStation sign-in code" placeholder="64-character npsso code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={64} disabled={busy} />
          <button className="btn btn--ghost" type="submit" disabled={busy || !code.trim()}>Import with code</button>
        </form>
      </details> : null}
    </div>
    {error ? <p className="steam-import__error" role="alert">{error}</p> : null}
    {progress ? <p role="status" aria-live="polite">{progress}</p> : null}
  </>;
}
