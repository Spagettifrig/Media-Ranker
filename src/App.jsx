import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AddFromCatalog from './components/AddFromCatalog.jsx';
import BoardView from './components/BoardView.jsx';
import CompareView from './components/CompareView.jsx';
import DetailView from './components/DetailView.jsx';
import FilterBar from './components/FilterBar.jsx';
import SettingsView from './components/SettingsView.jsx';
import Sidebar from './components/Sidebar.jsx';
import StatsView from './components/StatsView.jsx';
import TopStrip from './components/TopStrip.jsx';
import {
  allImagesOf,
  clampHours,
  createItem,
  normalizeDate,
  normalizeItem,
  titleFromFileName,
  toggleTag,
  withRanks,
} from './lib/model.js';
import { clampScore, computeOverall } from './lib/score.js';
import { DEFAULT_LIBRARY, LIBRARIES, libraryConfig } from './lib/media.js';
import {
  DEFAULT_FILTERS,
  describeFilters,
  isFiltered,
  isReorderable,
  visibleItems,
} from './lib/collection.js';
import { exportFileName, renderRankingImage } from './lib/export-image.js';
import { DEFAULT_COVER_ASPECT, normalizeCoverAspect } from './lib/settings.js';

const AUTOSAVE_DELAY_MS = 200;
const TOAST_MS = 6000;

/** Catalog credentials. Persisted alongside the other settings, never bundled. */
const CREDENTIAL_KEYS = ['tmdbToken', 'twitchClientId', 'twitchClientSecret'];

const emptyCredentials = () => Object.fromEntries(CREDENTIAL_KEYS.map((key) => [key, '']));

/** Credentials sit flat in `settings` next to theme and cover aspect. */
const settingsPayload = ({ theme, coverAspect, credentials }) => ({
  theme,
  coverAspect,
  ...credentials,
});

const emptyLibraries = () => Object.fromEntries(LIBRARIES.map((library) => [library.key, []]));

/** Each library remembers where you were, so switching back is not a reset. */
const emptyUiState = () =>
  Object.fromEntries(
    LIBRARIES.map((library) => [
      library.key,
      { view: 'board', openId: null, filters: { ...DEFAULT_FILTERS }, compare: [null, null] },
    ]),
  );

export default function App() {
  const [libraries, setLibraries] = useState(emptyLibraries);
  const [library, setLibrary] = useState(DEFAULT_LIBRARY);
  const [ui, setUi] = useState(emptyUiState);
  const [theme, setTheme] = useState('dark');
  const [coverAspect, setCoverAspect] = useState(DEFAULT_COVER_ASPECT);
  const [credentials, setCredentials] = useState(emptyCredentials);
  const [ready, setReady] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved
  const [showSettings, setShowSettings] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [toast, setToast] = useState(null);
  const [user, setUser] = useState(null); // null = signed out; never written to data.json

  const searchRef = useRef(null);
  const latest = useRef({ libraries, theme, coverAspect, credentials });
  latest.current = { libraries, theme, coverAspect, credentials };

  const config = libraryConfig(library);
  const items = libraries[library] ?? [];
  const state = ui[library];

  /* ---- account: loaded once, then kept live by onAuthChange ----------- */
  useEffect(() => {
    let cancelled = false;
    window.api.getCurrentUser().then((current) => {
      if (!cancelled) setUser(current);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => window.api.onAuthChange(setUser), []);

  /* ---- auto-update: a background download finished, ready to install -- */
  useEffect(() => {
    return window.api.onUpdateStatus((status) => {
      if (status?.status === 'ready') {
        setToast({
          kind: 'update',
          message: status.version ? `Game Ranker ${status.version} is ready.` : 'An update is ready.',
        });
      }
    });
  }, []);

  const signUp = useCallback(async (email, password) => {
    const response = await window.api.signUp(email, password);
    if (!response?.ok) return response?.error ?? 'Could not create your account.';
    setUser(response.user);
    return null;
  }, []);

  const signIn = useCallback(async (email, password) => {
    const response = await window.api.signIn(email, password);
    if (!response?.ok) return response?.error ?? 'Could not sign in.';
    setUser(response.user);
    return null;
  }, []);

  const signOut = useCallback(async () => {
    await window.api.signOut();
    setUser(null);
  }, []);

  /* ---- initial load -------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await window.api.load();
      if (cancelled) return;
      const loaded = emptyLibraries();
      for (const entry of LIBRARIES) {
        const raw = saved?.libraries?.[entry.key] ?? [];
        loaded[entry.key] = withRanks(
          raw
            .map((item, index) => normalizeItem(entry.key, item, index))
            .sort((a, b) => a.rank - b.rank),
        );
      }
      setLibraries(loaded);
      if (saved?.settings?.theme === 'light' || saved?.settings?.theme === 'dark') {
        setTheme(saved.settings.theme);
      }
      if (saved?.settings?.coverAspect) {
        setCoverAspect(normalizeCoverAspect(saved.settings.coverAspect));
      }
      const loadedCredentials = emptyCredentials();
      for (const key of CREDENTIAL_KEYS) {
        const value = saved?.settings?.[key];
        if (typeof value === 'string') loadedCredentials[key] = value;
      }
      setCredentials(loadedCredentials);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- theme --------------------------------------------------------- */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /* ---- cover aspect ratio --------------------------------------------- */
  useEffect(() => {
    document.documentElement.style.setProperty('--cover-aspect', coverAspect);
  }, [coverAspect]);

  /* ---- autosave: every change lands on disk, no save button ---------- */
  useEffect(() => {
    if (!ready) return undefined;
    setSaveState('saving');
    const timer = setTimeout(async () => {
      await window.api.save({
        libraries: latest.current.libraries,
        settings: settingsPayload(latest.current),
      });
      setSaveState('saved');
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [libraries, theme, coverAspect, credentials, ready]);

  // Flush if focus is lost inside the debounce window.
  useEffect(() => {
    const flush = () => {
      if (ready) {
        window.api.save({
          libraries: latest.current.libraries,
          settings: settingsPayload(latest.current),
        });
      }
    };
    window.addEventListener('blur', flush);
    return () => window.removeEventListener('blur', flush);
  }, [ready]);

  /**
   * The real close path. `beforeunload` used to fire the last save and let the
   * window go, which meant the process could exit mid-write and lose it - so
   * the window now waits for this to finish instead.
   */
  useEffect(() => {
    return window.api.onFlush(async () => {
      try {
        if (ready) {
          await window.api.save({
            libraries: latest.current.libraries,
            settings: settingsPayload(latest.current),
          });
        }
      } finally {
        window.api.flushed();
      }
    });
  }, [ready]);

  useEffect(() => {
    // An update-ready toast is actionable, not a status blip - it stays until
    // the user restarts or dismisses it, rather than vanishing on its own.
    if (!toast || toast.kind === 'update') return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  /* ---- per-library ui state ------------------------------------------ */
  const patchUi = useCallback(
    (patch) => {
      setUi((prev) => ({ ...prev, [library]: { ...prev[library], ...patch } }));
    },
    [library],
  );

  const setFilters = useCallback((filters) => patchUi({ filters }), [patchUi]);
  const setView = useCallback((view) => patchUi({ view }), [patchUi]);
  const setOpenId = useCallback((openId) => patchUi({ openId }), [patchUi]);

  /* ---- mutations ----------------------------------------------------- */
  const patchLibrary = useCallback(
    (fn) => {
      setLibraries((prev) => ({ ...prev, [library]: fn(prev[library] ?? []) }));
    },
    [library],
  );

  const patchItem = useCallback(
    (id, patch) => {
      patchLibrary((list) =>
        list.map((item) => (item.id === id ? { ...item, ...patch(item) } : item)),
      );
    },
    [patchLibrary],
  );

  const setTitle = useCallback((id, title) => patchItem(id, () => ({ title })), [patchItem]);

  const setCategoryScore = useCallback(
    (id, key, value) =>
      patchItem(id, (item) => {
        const categoryScores = { ...item.categoryScores, [key]: clampScore(value) };
        return {
          categoryScores,
          overallScore: computeOverall(categoryScores, config.categories, item.disabledCategories),
        };
      }),
    [patchItem, config],
  );

  /** Marks a category as N/A for this item (or clears that), so it drops out of the average. */
  const toggleCategoryApplicable = useCallback(
    (id, key) =>
      patchItem(id, (item) => {
        const disabledCategories = toggleTag(item.disabledCategories, key, config.categories);
        return {
          disabledCategories,
          overallScore: computeOverall(item.categoryScores, config.categories, disabledCategories),
        };
      }),
    [patchItem, config],
  );

  const setDescription = useCallback(
    (id, key, value) =>
      patchItem(id, (item) => ({ descriptions: { ...item.descriptions, [key]: value } })),
    [patchItem],
  );

  const setHoursPlayed = useCallback(
    (id, value) => patchItem(id, () => ({ hoursPlayed: clampHours(value) })),
    [patchItem],
  );

  const setFirstPlayed = useCallback(
    (id, value) => patchItem(id, () => ({ firstPlayed: normalizeDate(value) })),
    [patchItem],
  );

  const toggleGenre = useCallback(
    (id, key) => patchItem(id, (item) => ({ genres: toggleTag(item.genres, key, config.genres) })),
    [patchItem, config],
  );

  const toggleMode = useCallback(
    (id, key) => patchItem(id, (item) => ({ modes: toggleTag(item.modes, key, config.modes) })),
    [patchItem, config],
  );

  const reorder = useCallback(
    (nextOrder) => patchLibrary(() => withRanks(nextOrder)),
    [patchLibrary],
  );

  /**
   * "Add" picks one or more photos and starts a new item per photo - each
   * cover is its own game. To add several photos to *one* game instead, open
   * that game and use its own "add images" button (see `addImagesTo`).
   */
  const addItem = useCallback(async () => {
    if (importing) return;
    setImporting(true);
    try {
      const picked = await window.api.pickImages();
      if (!picked || picked.length === 0) return;
      const created = picked.map((entry) =>
        createItem(library, {
          title: titleFromFileName(entry.sourceName),
          mainImage: entry.file,
          galleryImages: [],
        }),
      );
      patchLibrary((list) => withRanks([...list, ...created]));
      // A single photo opens straight into its new item, same as before;
      // several photos land back on the board so all the new cards are visible.
      patchUi({ openId: created.length === 1 ? created[0].id : null, view: 'board' });
    } finally {
      setImporting(false);
    }
  }, [importing, library, patchLibrary, patchUi]);

  /**
   * Add one entry chosen from the online catalog. The cover is downloaded in
   * the main process first, so by the time we get here it is already a stored
   * image name indistinguishable from a hand-imported one.
   *
   * Returns an error string on failure so the search sheet can show it inline
   * and stay open on the results the user was looking at.
   */
  const addFromCatalog = useCallback(
    async (result) => {
      const response = await window.api.importFromCatalog(library, result.remoteId);
      if (!response?.ok) return response?.error ?? 'Could not add that one.';

      const { entry } = response;
      const { genres, modes } = config.catalog.tags(entry);
      const created = createItem(library, {
        title: entry.title,
        mainImage: entry.file,
        genres,
        modes,
        hoursPlayed: entry.hours,
      });

      patchLibrary((list) => withRanks([...list, created]));
      setShowCatalog(false);
      patchUi({ openId: created.id, view: 'board' });
      if (!entry.file) {
        setToast({
          kind: 'error',
          message: `Added "${entry.title}", but its cover could not be downloaded.`,
        });
      }
      return null;
    },
    [config, library, patchLibrary, patchUi],
  );

  const addImagesTo = useCallback(
    async (id) => {
      if (importing) return;
      setImporting(true);
      try {
        const picked = await window.api.pickImages();
        if (!picked || picked.length === 0) return;
        const files = picked.map((entry) => entry.file);
        patchItem(id, (item) =>
          item.mainImage
            ? { galleryImages: [...item.galleryImages, ...files] }
            : { mainImage: files[0], galleryImages: [...item.galleryImages, ...files.slice(1)] },
        );
      } finally {
        setImporting(false);
      }
    },
    [importing, patchItem],
  );

  const makeMainImage = useCallback(
    (id, file) =>
      patchItem(id, (item) => {
        if (!file || item.mainImage === file) return {};
        const gallery = item.galleryImages.filter((name) => name !== file);
        if (item.mainImage) gallery.unshift(item.mainImage);
        return { mainImage: file, galleryImages: gallery };
      }),
    [patchItem],
  );

  const removeImage = useCallback(
    (id, file) => {
      patchItem(id, (item) => {
        if (item.mainImage === file) {
          const [next, ...rest] = item.galleryImages;
          return { mainImage: next ?? null, galleryImages: rest };
        }
        return { galleryImages: item.galleryImages.filter((name) => name !== file) };
      });
      window.api.deleteImages([file]);
    },
    [patchItem],
  );

  const deleteItem = useCallback(
    (id) => {
      patchLibrary((list) => {
        const target = list.find((item) => item.id === id);
        if (target) window.api.deleteImages(allImagesOf(target));
        return withRanks(list.filter((item) => item.id !== id));
      });
      setUi((prev) => {
        const current = prev[library];
        return {
          ...prev,
          [library]: {
            ...current,
            openId: current.openId === id ? null : current.openId,
            compare: current.compare.map((value) => (value === id ? null : value)),
          },
        };
      });
    },
    [library, patchLibrary],
  );

  /* ---- derived view -------------------------------------------------- */
  const shown = useMemo(() => visibleItems(items, state.filters), [items, state.filters]);
  const reorderable = isReorderable(state.filters);
  const filtered = isFiltered(state.filters);

  const openIndex = useMemo(
    () => (state.openId ? items.findIndex((item) => item.id === state.openId) : -1),
    [items, state.openId],
  );
  const openItem = openIndex >= 0 ? items[openIndex] : null;

  // If the open item disappears (deleted), fall back to the board.
  useEffect(() => {
    if (state.openId && ready && openIndex < 0) setOpenId(null);
  }, [state.openId, openIndex, ready, setOpenId]);

  /* ---- export -------------------------------------------------------- */
  const handleExport = useCallback(
    async (format) => {
      if (exporting) return;
      setExporting(true);
      try {
        const { blob, ext } = await renderRankingImage({
          items: shown,
          config,
          format,
          theme,
          subtitle: describeFilters(config, state.filters),
        });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const result = await window.api.saveExport({
          bytes,
          ext,
          fileName: exportFileName(config, ext),
        });
        if (result?.saved) {
          setToast({ kind: 'ok', message: 'Ranking image saved.', filePath: result.filePath });
        } else if (result?.error) {
          setToast({ kind: 'error', message: `Could not save: ${result.error}` });
        }
      } catch (error) {
        setToast({ kind: 'error', message: `Export failed: ${error.message}` });
      } finally {
        setExporting(false);
      }
    },
    [config, exporting, shown, state.filters, theme],
  );

  /* ---- compare ------------------------------------------------------- */
  const startCompare = useCallback(
    (id) => {
      setUi((prev) => {
        const current = prev[library];
        const other =
          current.compare[1] && current.compare[1] !== id
            ? current.compare[1]
            : (libraries[library] ?? []).find((item) => item.id !== id)?.id ?? null;
        return { ...prev, [library]: { ...current, view: 'compare', compare: [id, other] } };
      });
    },
    [libraries, library],
  );

  const selectCompare = useCallback(
    (slot, id) => {
      setUi((prev) => {
        const current = prev[library];
        const next = [...current.compare];
        next[slot] = id;
        // Never let both sides land on the same item.
        if (next[1 - slot] === id) next[1 - slot] = current.compare[slot];
        return { ...prev, [library]: { ...current, compare: next } };
      });
    },
    [library],
  );

  const swapCompare = useCallback(() => {
    setUi((prev) => {
      const current = prev[library];
      return { ...prev, [library]: { ...current, compare: [current.compare[1], current.compare[0]] } };
    });
  }, [library]);

  /* ---- global shortcuts ---------------------------------------------- */
  useEffect(() => {
    function onKeyDown(event) {
      const tag = event.target?.tagName;
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable;

      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-9]$/.test(event.key)) {
        const target = LIBRARIES[Number(event.key) - 1];
        if (target) {
          event.preventDefault();
          setLibrary(target.key);
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setView('board');
        setOpenId(null);
        requestAnimationFrame(() => searchRef.current?.focus());
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        handleExport('png');
        return;
      }

      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === '?') {
        event.preventDefault();
        setShowSettings((value) => !value);
        return;
      }

      if (event.key === '/' && !openItem) {
        event.preventDefault();
        setView('board');
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleExport, openItem, setOpenId, setView]);

  /* ---- render -------------------------------------------------------- */
  if (!ready) {
    return (
      <div className="app-loading">
        <div className="spinner" aria-hidden="true" />
        <p>Loading your boards...</p>
      </div>
    );
  }

  const counts = Object.fromEntries(
    LIBRARIES.map((entry) => [entry.key, (libraries[entry.key] ?? []).length]),
  );

  const shell = (
    <>
      <Sidebar
        library={library}
        counts={counts}
        onLibraryChange={setLibrary}
        onOpenSettings={() => setShowSettings(true)}
        user={user}
      />
      {showSettings ? (
        <SettingsView
          theme={theme}
          onThemeChange={setTheme}
          coverAspect={coverAspect}
          onCoverAspectChange={setCoverAspect}
          credentials={credentials}
          onCredentialChange={(key, value) =>
            setCredentials((prev) => ({ ...prev, [key]: value }))
          }
          user={user}
          onSignUp={signUp}
          onSignIn={signIn}
          onSignOut={signOut}
          onClose={() => setShowSettings(false)}
        />
      ) : null}
      {showCatalog ? (
        <AddFromCatalog
          config={config}
          libraryKey={library}
          onAdd={addFromCatalog}
          onClose={() => setShowCatalog(false)}
          onOpenSettings={() => {
            setShowCatalog(false);
            setShowSettings(true);
          }}
        />
      ) : null}
      {toast ? (
        <div className={`toast toast--${toast.kind}`} role="status">
          <span>{toast.message}</span>
          {toast.filePath ? (
            <button
              type="button"
              className="toast__action"
              onClick={() => window.api.showItemInFolder(toast.filePath)}
            >
              Show in folder
            </button>
          ) : null}
          {toast.kind === 'update' ? (
            <button type="button" className="toast__action" onClick={() => window.api.installUpdate()}>
              Restart & update
            </button>
          ) : null}
          <button type="button" className="toast__close" onClick={() => setToast(null)} aria-label="Dismiss">
            &times;
          </button>
        </div>
      ) : null}
    </>
  );

  if (openItem) {
    return (
      <div className="app">
        {shell}
        <main className="app__main">
          <DetailView
            item={openItem}
            config={config}
            position={openIndex + 1}
            saveState={saveState}
            importing={importing}
            onBack={() => setOpenId(null)}
            onTitleChange={(value) => setTitle(openItem.id, value)}
            onScoreChange={(key, value) => setCategoryScore(openItem.id, key, value)}
            onToggleCategoryApplicable={(key) => toggleCategoryApplicable(openItem.id, key)}
            onDescriptionChange={(key, value) => setDescription(openItem.id, key, value)}
            onAddImages={() => addImagesTo(openItem.id)}
            onMakeMain={(file) => makeMainImage(openItem.id, file)}
            onRemoveImage={(file) => removeImage(openItem.id, file)}
            onDelete={() => deleteItem(openItem.id)}
            onHoursChange={(value) => setHoursPlayed(openItem.id, value)}
            onFirstPlayedChange={(value) => setFirstPlayed(openItem.id, value)}
            onToggleGenre={(key) => toggleGenre(openItem.id, key)}
            onToggleMode={(key) => toggleMode(openItem.id, key)}
          />
        </main>
      </div>
    );
  }

  const subtitle =
    state.view === 'stats'
      ? 'How your rankings break down'
      : state.view === 'compare'
        ? `Put two ${config.items} side by side`
        : items.length === 0
          ? 'Nothing ranked yet'
          : reorderable
            ? `${items.length} ${items.length === 1 ? config.item : config.items} ranked · drag to reorder · right-click for options`
            : `${items.length} ${items.length === 1 ? config.item : config.items} ranked · right-click for options`;

  return (
    <div className="app">
      {shell}
      <main className="app__main screen">
        <TopStrip
          config={config}
          view={state.view}
          onViewChange={setView}
          subtitle={subtitle}
          saveState={saveState}
          importing={importing}
          onAdd={addItem}
          onSearchAdd={() => setShowCatalog(true)}
        />

        {state.view === 'board' ? (
          <>
            <FilterBar
              config={config}
              filters={state.filters}
              onChange={setFilters}
              total={items.length}
              shown={shown.length}
              onExport={handleExport}
              exporting={exporting}
              searchRef={searchRef}
            />
            <BoardView
              items={shown}
              config={config}
              reorderable={reorderable}
              filtered={filtered}
              importing={importing}
              onOpen={setOpenId}
              onReorder={reorder}
              onAdd={addItem}
              onSearchAdd={() => setShowCatalog(true)}
              onDelete={deleteItem}
              onCompare={startCompare}
              onClearFilters={() => setFilters({ ...DEFAULT_FILTERS, sort: state.filters.sort })}
            />
          </>
        ) : null}

        {state.view === 'stats' ? (
          <StatsView items={items} config={config} onOpen={setOpenId} />
        ) : null}

        {state.view === 'compare' ? (
          <CompareView
            items={items}
            config={config}
            selection={state.compare}
            onSelect={selectCompare}
            onSwap={swapCompare}
            onOpen={setOpenId}
          />
        ) : null}
      </main>
    </div>
  );
}
