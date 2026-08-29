import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const DEBOUNCE_MS = 350;
const MIN_QUERY = 2;

/**
 * Search the library's online catalog and add an entry straight to the board,
 * cover art and all.
 *
 * Every lookup goes through the main process, so this component never sees a
 * credential or a provider URL - it only knows how to render results and
 * report which one was picked.
 */
export default function AddFromCatalog({ config, libraryKey, onAdd, onClose, onOpenSettings }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(null);
  const [active, setActive] = useState(0);

  const inputRef = useRef(null);
  const listRef = useRef(null);
  // Bumped on every keystroke so a slow response can never overwrite a newer one.
  const requestId = useRef(0);

  const catalog = config.catalog;
  const ready = status?.ready ?? true;

  /* ---- credential check ---------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    window.api.catalogStatus(libraryKey).then((value) => {
      if (!cancelled) setStatus(value);
    });
    return () => {
      cancelled = true;
    };
  }, [libraryKey]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /* ---- debounced search ----------------------------------------------- */
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY || !ready) {
      setResults([]);
      setError(null);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      const response = await window.api.searchCatalog(libraryKey, trimmed);
      if (id !== requestId.current) return;
      if (response?.ok) {
        setResults(response.results ?? []);
        setError(null);
      } else {
        setResults([]);
        setError(response?.error ?? 'Search failed.');
      }
      setActive(0);
      setLoading(false);
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, libraryKey, ready]);

  /* ---- add ------------------------------------------------------------ */
  const add = useCallback(
    async (result) => {
      if (adding) return;
      setAdding(result.remoteId);
      try {
        const failure = await onAdd(result);
        if (failure) setError(failure);
        // On success the parent closes this sheet, so there is nothing to reset.
      } finally {
        setAdding(null);
      }
    },
    [adding, onAdd],
  );

  /* ---- keyboard ------------------------------------------------------- */
  const move = useCallback(
    (delta) => {
      setActive((current) => {
        if (results.length === 0) return 0;
        return (current + delta + results.length) % results.length;
      });
    },
    [results.length],
  );

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
        return;
      }
      if (event.key === 'Enter' && results[active]) {
        event.preventDefault();
        add(results[active]);
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active, add, move, onClose, results]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const body = useMemo(() => {
    if (status && !status.supported) {
      return <p className="catalog__note">This library has no online catalog.</p>;
    }

    if (status && !status.ready) {
      return (
        <div className="catalog__note">
          <p>
            Add your {catalog.provider} credentials in Settings to search {config.items} online.
          </p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      );
    }

    if (error) return <p className="catalog__note catalog__note--error">{error}</p>;

    if (query.trim().length < MIN_QUERY) {
      return (
        <p className="catalog__note">
          Start typing to search {catalog.provider}. Pick a result and it lands on your board with
          its cover already attached.
        </p>
      );
    }

    if (loading) {
      return (
        <div className="catalog__note">
          <div className="spinner" aria-hidden="true" />
          <p>Searching {catalog.provider}...</p>
        </div>
      );
    }

    if (results.length === 0) {
      return <p className="catalog__note">Nothing found for "{query.trim()}".</p>;
    }

    return (
      <ul className="catalog__results" ref={listRef} role="listbox" aria-label={`${catalog.provider} results`}>
        {results.map((result, index) => (
          <li key={result.remoteId}>
            <button
              type="button"
              role="option"
              aria-selected={index === active}
              className={`catalog__result${index === active ? ' is-active' : ''}`}
              onPointerEnter={() => setActive(index)}
              onClick={() => add(result)}
              disabled={Boolean(adding)}
            >
              <img
                className="catalog__art"
                src={window.api.catalogImageUrl(result.thumbUrl)}
                alt=""
                loading="lazy"
              />
              <span className="catalog__meta">
                <span className="catalog__title">
                  {result.title}
                  {result.year ? <span className="catalog__year">{result.year}</span> : null}
                </span>
                {result.summary ? <span className="catalog__summary">{result.summary}</span> : null}
              </span>
              {adding === result.remoteId ? (
                <span className="spinner spinner--sm" aria-label="Adding" />
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    );
  }, [active, add, adding, catalog, config.items, error, loading, onOpenSettings, query, results, status]);

  return createPortal(
    <div
      className="overlay"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="sheet sheet--catalog"
        role="dialog"
        aria-modal="true"
        aria-label={`Add ${config.item} from ${catalog.provider}`}
        tabIndex={-1}
      >
        <header className="sheet__head">
          <h2>Add {config.item}</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="catalog__search">
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            className="catalog__input"
            placeholder={catalog.placeholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={!ready}
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

        <div className="catalog__body">{body}</div>

        <p className="sheet__foot">
          {catalog.credit} Scores and reviews stay yours - nothing is filled in but the title,
          cover, tags{catalog.fillsHours ? ` and ${config.hours.label.toLowerCase()}` : ''}.
        </p>
      </div>
    </div>,
    document.body,
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
