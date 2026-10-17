import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { steamDuplicate } from '../lib/steam-import.js';

export default function SteamImport({ items, onImport, onClose }) {
  const [profile, setProfile] = useState('');
  const [key, setKey] = useState('');
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [query, setQuery] = useState('');
  const [playedOnly, setPlayedOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [page, setPage] = useState(0);
  const alive = useRef(true);
  const stop = useRef(false);
  const dialog = useRef(null);
  const input = useRef(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement;
    input.current?.focus();
    return () => { alive.current = false; stop.current = true; previous?.focus?.(); };
  }, []);
  useEffect(() => {
    const handle = (event) => {
      // Keep app-wide ranking shortcuts out of this modal.
      if (event.key === 'Escape') { event.preventDefault(); if (!busyRef.current) onClose(); }
      if (event.key === 'Tab') {
        const controls = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')]
          .filter((node) => node.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      event.stopPropagation();
    };
    // Bubble on the portal: input's own React handlers still work, window shortcuts do not.
    const element = dialog.current;
    element.addEventListener('keydown', handle);
    return () => element.removeEventListener('keydown', handle);
  }, [onClose]);

  const rows = useMemo(() => (preview?.games ?? []).map((game) => ({
    ...game, duplicate: steamDuplicate(game, items),
  })), [preview, items]);
  const filtered = rows.filter((game) => (!playedOnly || game.hours > 0) && game.title.toLowerCase().includes(query.toLowerCase()));
  const selectable = filtered.filter((game) => !game.duplicate);
  const chosen = rows.filter((game) => selected.has(game.steamAppId) && game.duplicate?.kind !== 'exact');
  const maxPage = Math.max(0, Math.ceil(filtered.length / 75) - 1);
  const currentPage = Math.min(page, maxPage);

  async function load(event) {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(''); setWarning(''); setProgress('Reading your Steam library…');
    stop.current = false;
    setPreview(null); setSelected(new Set());
    try {
      const result = await window.api.previewSteam(profile, key);
      setKey(''); // Personal keys live only in this request, never in saved settings.
      if (!alive.current) return;
      if (!result?.ok) throw new Error(result?.error ?? 'Could not load Steam.');
      const games = [...result.games];
      for (let i = 0; i < games.length && !stop.current; i += 50) {
        setProgress(`Matching catalog entries ${i + 1}–${Math.min(i + 50, games.length)} of ${games.length}…`);
        const response = await window.api.matchSteam(result.sessionId, games.slice(i, i + 50).map((game) => game.steamAppId));
        if (!alive.current) return;
        if (!response?.ok) {
          setWarning('Catalog matching is unavailable. You can still import Steam titles and playtime; unmatched games stay local and do not join community reviews. Similar titles are flagged for review.');
          break;
        }
        games.splice(i, response.games.length, ...response.games);
        // IGDB allows four requests/second; leave headroom for other catalog traffic.
        if (i + 50 < games.length) await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (stop.current) setWarning('Catalog matching stopped early. Remaining games will import without catalog links.');
      setPreview({ ...result, games });
      setSelected(new Set(games.filter((game) => !steamDuplicate(game, items)).map((game) => game.steamAppId)));
      setPage(0); setProgress('');
    } catch (failure) {
      if (alive.current) { setError(failure.message); setProgress(''); }
    } finally { if (alive.current) { setKey(''); setBusy(false); busyRef.current = false; } }
  }

  async function importChosen() {
    if (busyRef.current || !chosen.length) return;
    busyRef.current = true;
    setBusy(true); setError(''); stop.current = false;
    let added = 0;
    let coversMissing = 0;
    try {
      for (let i = 0; i < chosen.length && !stop.current; i += 10) {
        setProgress(`Importing ${i + 1}–${Math.min(i + 10, chosen.length)} of ${chosen.length}…`);
        const result = await window.api.importSteam(preview.sessionId, chosen.slice(i, i + 10).map((game) => game.steamAppId));
        if (!alive.current) return;
        if (!result?.ok) throw new Error(result?.error ?? 'Import failed.');
        // Each completed batch is saved through the normal app autosave path.
        added += onImport(result.entries);
        coversMissing += result.entries.filter((entry) => !entry.file).length;
        setSelected((current) => {
          const next = new Set(current);
          result.entries.forEach((entry) => next.delete(entry.steamAppId));
          return next;
        });
      }
      setProgress(`${added} ${added === 1 ? 'game' : 'games'} added to Unrated.${stop.current ? ' Stopped; completed imports are kept.' : ''}${coversMissing ? ` ${coversMissing} covers could not be downloaded; you can add artwork in game details.` : ''}`);
    } catch (failure) {
      if (alive.current) { setError(`${failure.message} Completed imports are kept; retry skips duplicates.`); setProgress(`${added} games added to Unrated.`); }
    } finally { if (alive.current) { setBusy(false); busyRef.current = false; } }
  }

  return createPortal(
    <div className="overlay" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialog} className="sheet steam-import" role="dialog" aria-modal="true" aria-labelledby="steam-title" aria-describedby="steam-description">
        <header className="steam-import__heading">
          <div><h2 id="steam-title">Import from Steam</h2><p id="steam-description">Your library, ready to rank. Existing ratings and notes stay untouched.</p></div>
          <button className="btn btn--ghost" disabled={busy} onClick={onClose} aria-label="Close Steam import">×</button>
        </header>
        <form className="steam-import__form" onSubmit={load}>
          <label className="field"><span className="field__label">Steam profile URL or SteamID64</span>
            <input ref={input} className="steam-import__input" value={profile} onChange={(event) => setProfile(event.target.value)} placeholder="steamcommunity.com/id/yourname" required maxLength={200} disabled={busy} />
          </label>
          <p className="steam-import__help">In Steam → Edit Profile → Privacy Settings, set My profile and Game details to Public. Playtime may be hidden separately. No Steam password is needed.</p>
          <details><summary>Advanced: use a personal Steam Web API key</summary>
            <label className="field"><span className="field__label">Optional key (used once, not saved)</span>
              <input className="steam-import__input" type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} maxLength={32} disabled={busy} />
            </label>
          </details>
          <button className="btn btn--primary" disabled={busy || !profile.trim()} type="submit">{preview ? 'Reload library' : 'Load library'}</button>
        </form>
        {error ? <p className="steam-import__error" role="alert">{error}</p> : null}
        {warning ? <p className="steam-import__help">{warning}</p> : null}
        {progress ? <p role="status" aria-live="polite">{progress}</p> : null}
        {busy ? <button className="btn btn--ghost" onClick={() => { stop.current = true; setProgress('Stopping after the current request…'); }}>Stop after current batch</button> : null}
        {preview ? <>
          <p className="steam-import__help">{rows.length} games returned by Steam · {rows.filter((game) => game.duplicate?.kind === 'exact').length} already in your library. Imports stay unrated and local until you finish a rating. Steam may omit shared games and unplayed free-to-play titles.</p>
          <div className="steam-import__toolbar">
            <input className="steam-import__input" aria-label="Search Steam games" placeholder="Find a game…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
            <label><input type="checkbox" checked={playedOnly} onChange={(event) => { setPlayedOnly(event.target.checked); setPage(0); }} /> Show played only</label>
            <button className="btn btn--ghost" disabled={busy} onClick={() => setSelected(new Set(selectable.map((game) => game.steamAppId)))}>Select shown ({selectable.length})</button>
            <button className="btn btn--ghost" disabled={busy} onClick={() => setSelected(new Set())}>Clear selection</button>
          </div>
          <div className="steam-import__list" aria-label="Steam library">
            {filtered.slice(currentPage * 75, (currentPage + 1) * 75).map((game) => <label className={`steam-import__row${game.duplicate?.kind === 'exact' ? ' is-duplicate' : ''}`} key={game.steamAppId}>
              <input type="checkbox" disabled={busy || game.duplicate?.kind === 'exact'} checked={selected.has(game.steamAppId) && game.duplicate?.kind !== 'exact'} onChange={(event) => setSelected((current) => {
                const next = new Set(current); if (event.target.checked) next.add(game.steamAppId); else next.delete(game.steamAppId); return next;
              })} />
              <span><strong>{game.title}</strong><small>{game.duplicate?.kind === 'exact' ? 'Already imported — will be skipped' : game.duplicate ? `Similar title already exists: ${game.duplicate.item.title}. Select only if this is a different game.` : game.provider ? 'Catalog linked' : 'Steam only — no unambiguous catalog match'}</small></span>
              <span className="steam-import__hours">{game.hours === null ? 'Time unavailable' : `${game.hours.toLocaleString()} h`}</span>
            </label>)}
            {!filtered.length ? <p>{rows.length ? 'No games match these filters.' : 'Steam returned an empty library. Check that you chose the right profile.'}</p> : null}
          </div>
          {maxPage > 0 ? <div className="steam-import__toolbar"><button className="btn btn--ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} of {maxPage + 1}</span><button className="btn btn--ghost" disabled={currentPage === maxPage} onClick={() => setPage(currentPage + 1)}>Next</button></div> : null}
          <footer className="steam-import__footer"><span>{chosen.length} selected across all pages and filters · no ratings assigned</span><button className="btn btn--primary" disabled={busy || !chosen.length} onClick={importChosen}>Import {chosen.length} games</button></footer>
        </> : null}
      </section>
    </div>, document.body,
  );
}
