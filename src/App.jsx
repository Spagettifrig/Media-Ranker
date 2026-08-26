import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AddFromCatalog from './components/AddFromCatalog.jsx';
import AwardsView from './components/AwardsView.jsx';
import BoardView from './components/BoardView.jsx';
import CompareView from './components/CompareView.jsx';
import DetailView from './components/DetailView.jsx';
import FilterBar from './components/FilterBar.jsx';
import ProfileView from './components/ProfileView.jsx';
import SettingsView from './components/SettingsView.jsx';
import Sidebar from './components/Sidebar.jsx';
import StatsView from './components/StatsView.jsx';
import TopStrip from './components/TopStrip.jsx';
import {
  allImagesOf,
  clampHours,
  createItem,
  itemFromReview,
  normalizeDate,
  normalizeItem,
  titleFromFileName,
  toggleTag,
  withRanks,
} from './lib/model.js';
import { clampScore, computeOverall } from './lib/score.js';
import { trophyIndex } from './lib/awards.js';
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
const REVIEW_PUSH_DELAY_MS = 600;
const TOAST_MS = 6000;

/**
 * Bumped whenever a new `reviews` column needs the existing cloud rows
 * rewritten. Stored in settings; a lower stamp triggers one bulk re-push.
 */
const AWARDS_SYNC_VERSION = 1;

/** Catalog credentials. Persisted alongside the other settings, never bundled. */
const CREDENTIAL_KEYS = ['tmdbToken', 'twitchClientId', 'twitchClientSecret'];

const emptyCredentials = () => Object.fromEntries(CREDENTIAL_KEYS.map((key) => [key, '']));

/** Credentials sit flat in `settings` next to theme and cover aspect. */
const settingsPayload = ({ theme, coverAspect, credentials, trophies, awardsSync }) => ({
  theme,
  coverAspect,
  awardsSync,
  // Cached so a board still shows its trophies on an offline launch. Awards
  // results never change once published, so a stale cache is only ever
  // missing the newest season, never wrong about an old one.
  trophies,
  ...credentials,
});

const emptyLibraries = () => Object.fromEntries(LIBRARIES.map((library) => [library.key, []]));

/**
 * Fold this account's cloud reviews into what's already on this machine.
 * Local wins ties, and keeps the things the cloud has no opinion about -
 * imported images, gallery order, board position - so a pull can never wipe
 * artwork off a board it didn't put there.
 *
 * `firstPlayed` used to be in that list of per-device fields. It isn't any
 * more: awards eligibility is decided on that date, so it has to be one date
 * per item per account, the same everywhere, and the newer edit has to win
 * like every other synced field. Which console you played it on takes its
 * place as the local-only one - that genuinely is per-device.
 */
function mergeCloudItems(localItems, cloudItems) {
  const cloudById = new Map(cloudItems.map((item) => [item.id, item]));
  const merged = localItems.map((item) => {
    const cloud = cloudById.get(item.id);
    if (!cloud) return item;
    cloudById.delete(item.id);
    if (Date.parse(cloud.updatedAt) <= Date.parse(item.updatedAt)) return item;
    return {
      ...cloud,
      mainImage: item.mainImage ?? cloud.mainImage,
      galleryImages: item.galleryImages,
      platforms: item.platforms,
      rank: item.rank,
    };
  });
  // Anything left is only in the cloud - a different machine ranked it.
  return withRanks([...merged, ...cloudById.values()]);
}

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
  const [trophies, setTrophies] = useState([]);
  const [awardsSync, setAwardsSync] = useState(AWARDS_SYNC_VERSION);
  const [ready, setReady] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved
  const [showSettings, setShowSettings] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [toast, setToast] = useState(null);
  const [user, setUser] = useState(null); // null = signed out; never written to data.json
  const [authResolved, setAuthResolved] = useState(false);
  const [profile, setProfile] = useState(null); // {username, displayName, defaultVisibility} or null
  const [profileTarget, setProfileTarget] = useState(null); // {id, displayName} or null - opens ProfileView

  const pendingReviewPushes = useRef(new Set());

  const searchRef = useRef(null);
  const latest = useRef({ libraries, theme, coverAspect, credentials, trophies, awardsSync });
  latest.current = { libraries, theme, coverAspect, credentials, trophies, awardsSync };

  /** Whose library is currently in `libraries` - every save has to name it. */
  const accountId = user?.id ?? null;
  const loadedAccount = useRef(null);
  const readyRef = useRef(false);
  readyRef.current = ready;

  const config = libraryConfig(library);
  const items = libraries[library] ?? [];
  const state = ui[library];

  /* ---- account: loaded once, then kept live by onAuthChange ----------- */
  useEffect(() => {
    let cancelled = false;
    window.api.getCurrentUser().then((current) => {
      if (cancelled) return;
      setUser(current);
      // Gates the first load, so a signed-in launch reads the account's own
      // library straight away instead of flashing the signed-out one first.
      setAuthResolved(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => window.api.onAuthChange(setUser), []);

  /* ---- auto-update ------------------------------------------------------
   * `updateStatus` is what the Settings button reads back - checking,
   * downloading, up to date, or an error, all scoped to a manual check the
   * main process only reports because someone actually clicked the button.
   * A "ready" download still also raises the toast below regardless of how
   * it was found, since that one is worth surfacing unprompted.
   * ------------------------------------------------------------------- */
  const [appVersion, setAppVersion] = useState(null);
  const [updateStatus, setUpdateStatus] = useState({ status: 'idle' });

  useEffect(() => {
    window.api.getAppVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    return window.api.onUpdateStatus((status) => {
      setUpdateStatus(status ?? { status: 'idle' });
      if (status?.status === 'ready') {
        setToast({
          kind: 'update',
          message: status.version ? `Game Ranker ${status.version} is ready.` : 'An update is ready.',
        });
      }
    });
  }, []);

  const checkForUpdates = useCallback(async () => {
    setUpdateStatus({ status: 'checking' });
    const response = await window.api.checkForUpdates();
    // A rejection here means the request never reached the updater at all
    // (dev build, no feed) - the main process's own events cover every
    // outcome once it does, so there is nothing to set on success.
    if (!response?.ok) {
      setUpdateStatus({ status: 'error', message: response?.error ?? 'Could not check for updates.' });
    }
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

  /* ---- profile: the public identity behind everything in the social feed */
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setProfile(null);
      return undefined;
    }
    window.api.getProfile().then((response) => {
      if (!cancelled && response?.ok) setProfile(response.profile);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  /**
   * One-time full re-push after the awards upgrade.
   *
   * `first_played` never used to leave the device, so every row already in
   * the cloud has it null - and six of the nine game categories are decided
   * on it. Pushes only ever happen when an item is *edited*, so without this
   * an untouched library would be almost entirely un-nominatable, and the
   * awards tab would look broken rather than empty.
   *
   * Guarded by a stamp in settings so it runs once per account and never
   * again. Bump `AWARDS_SYNC_VERSION` if a future column needs the same
   * treatment.
   */
  const rePushed = useRef(new Set());
  useEffect(() => {
    if (!ready || !user) return;
    if (awardsSync >= AWARDS_SYNC_VERSION) return;
    const key = accountId ?? 'local';
    if (rePushed.current.has(key)) return;
    rePushed.current.add(key);

    (async () => {
      for (const entry of LIBRARIES) {
        const items = latest.current.libraries[entry.key] ?? [];
        const catalogued = items.filter((item) => item.provider && item.providerId);
        if (catalogued.length === 0) continue;
        const response = await window.api.pushReviews(entry.key, catalogued);
        // Leave the stamp unset on failure so the next launch tries again.
        if (!response?.ok) return;
      }
      setAwardsSync(AWARDS_SYNC_VERSION);
    })();
  }, [ready, user, accountId, awardsSync]);

  /**
   * Backfill release years, once per library per session.
   *
   * Release year only started being stored when the awards needed it, so
   * everything added before that has none - and Game of the Year is decided
   * on it. Without this pass the category would simply be empty for every
   * item anyone already owns.
   *
   * Quiet by design: no toast, no spinner, and a failure just leaves the
   * years missing so the next launch can try again. It also skips items with
   * no catalog identity, which can never have a year to look up.
   */
  const backfilledYears = useRef(new Set());
  useEffect(() => {
    if (!ready) return;
    const key = `${accountId ?? 'local'}:${library}`;
    if (backfilledYears.current.has(key)) return;

    const pending = (latest.current.libraries[library] ?? []).filter(
      (item) => item.provider && item.providerId && item.releaseYear === null,
    );
    if (pending.length === 0) return;
    backfilledYears.current.add(key);

    (async () => {
      const response = await window.api.catalogReleaseYears(
        library,
        pending.map((item) => item.providerId),
      );
      if (!response?.ok) return;
      const years = response.years ?? {};
      if (Object.keys(years).length === 0) return;
      setLibraries((prev) => ({
        ...prev,
        [library]: (prev[library] ?? []).map((item) => {
          const year = item.providerId ? years[String(item.providerId)] : undefined;
          if (item.releaseYear !== null || year === undefined) return item;
          // Stamped as an edit so the push sync carries the year up to the
          // cloud, where eligibility is actually checked.
          pendingReviewPushes.current.add(item.id);
          return { ...item, releaseYear: year, updatedAt: new Date().toISOString() };
        }),
      }));
    })();
  }, [ready, library, accountId]);

  /**
   * Trophies are a community fact, not a personal one, so they are fetched
   * whole and matched onto the board by catalog identity - everyone who owns
   * a winner sees the same mark on it. Refreshed on sign-in and left cached
   * on disk in between, because an offline launch should still show them.
   */
  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    window.api.awardTrophies().then((response) => {
      if (!cancelled && response?.ok) setTrophies(response.trophies);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const trophiesByItem = useMemo(() => trophyIndex(trophies), [trophies]);

  const updateDefaultVisibility = useCallback(async (value) => {
    setProfile((prev) => (prev ? { ...prev, defaultVisibility: value } : prev));
    const response = await window.api.updateProfile(value);
    if (!response?.ok) {
      setToast({ kind: 'error', message: response?.error ?? 'Could not update default visibility.' });
    }
  }, []);

  /* ---- load: once auth is known, and again whenever the account changes */
  useEffect(() => {
    if (!authResolved) return undefined;
    let cancelled = false;
    (async () => {
      // Hand what's on screen back to the account it belongs to before
      // switching, or the last few edits would land in the wrong file.
      if (readyRef.current) {
        await window.api.save(loadedAccount.current, {
          libraries: latest.current.libraries,
          settings: settingsPayload(latest.current),
        });
      }
      setReady(false);

      const saved = await window.api.load(accountId);
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

      // Signed in: fold in anything ranked on another machine. Failure here is
      // not fatal - an offline launch just works from what's already on disk.
      if (accountId) {
        const pulled = await window.api.pullLibrary();
        if (cancelled) return;
        if (pulled?.ok) {
          for (const entry of LIBRARIES) {
            const cloudItems = pulled.reviews
              .filter((review) => review.libraryKey === entry.key)
              .map((review, index) => itemFromReview(entry.key, review, index));
            loaded[entry.key] = mergeCloudItems(loaded[entry.key], cloudItems);
          }
        }
      }
      if (cancelled) return;

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
      setTrophies(Array.isArray(saved?.settings?.trophies) ? saved.settings.trophies : []);
      // Absent on any file written before the awards existed, which is
      // exactly the case that needs the one-time re-push.
      setAwardsSync(Number(saved?.settings?.awardsSync) || 0);

      loadedAccount.current = accountId;
      setLibraries(loaded);
      setUi(emptyUiState());
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [authResolved, accountId]);

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
      await window.api.save(loadedAccount.current, {
        libraries: latest.current.libraries,
        settings: settingsPayload(latest.current),
      });
      setSaveState('saved');
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [libraries, theme, coverAspect, credentials, trophies, awardsSync, ready]);

  // Flush if focus is lost inside the debounce window.
  useEffect(() => {
    const flush = () => {
      if (ready) {
        window.api.save(loadedAccount.current, {
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
          await window.api.save(loadedAccount.current, {
            libraries: latest.current.libraries,
            settings: settingsPayload(latest.current),
          });
        }
      } finally {
        window.api.flushed();
      }
    });
  }, [ready]);

  /**
   * One-directional push sync: whatever changed locally on a catalog-linked
   * item goes up to Supabase, debounced like autosave. Nothing ever pulls
   * another device's (or another user's) data back into `libraries` - the
   * social feed queries live instead (see CommunityReviews/ProfileView).
   */
  useEffect(() => {
    if (!ready || !user) return undefined;
    const timer = setTimeout(() => {
      const ids = [...pendingReviewPushes.current];
      pendingReviewPushes.current.clear();
      for (const id of ids) {
        for (const entry of LIBRARIES) {
          const item = latest.current.libraries[entry.key]?.find((candidate) => candidate.id === id);
          if (!item) continue;
          if (item.provider && item.providerId) window.api.pushReview(entry.key, item);
          break;
        }
      }
    }, REVIEW_PUSH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [libraries, user, ready]);

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
        list.map((item) => {
          if (item.id !== id) return item;
          const next = { ...item, ...patch(item), updatedAt: new Date().toISOString() };
          if (next.provider && next.providerId) pendingReviewPushes.current.add(id);
          return next;
        }),
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

  const togglePlatform = useCallback(
    (id, key) =>
      patchItem(id, (item) => ({
        platforms: toggleTag(item.platforms, key, config.platforms ?? []),
      })),
    [patchItem, config],
  );

  const setVisibility = useCallback(
    (id, value) => patchItem(id, () => ({ visibility: value })),
    [patchItem],
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
        provider: entry.provider,
        providerId: entry.remoteId,
        coverImageUrl: entry.imageUrl,
        // Game of the Year is decided on this, so it is stored at import time.
        // Fetching it later would mean re-querying the catalog for every item
        // on every board, which is why it is captured on the one pass that
        // already has it in hand.
        releaseYear: entry.year,
      });

      patchLibrary((list) => withRanks([...list, created]));
      if (created.provider && created.providerId) pendingReviewPushes.current.add(created.id);
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
        if (target) {
          window.api.deleteImages(allImagesOf(target));
          if (user && target.provider && target.providerId) window.api.deleteReview(id);
        }
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
    [library, patchLibrary, user],
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
          profile={profile}
          onDefaultVisibilityChange={updateDefaultVisibility}
          appVersion={appVersion}
          updateStatus={updateStatus}
          onCheckForUpdates={checkForUpdates}
          onInstallUpdate={() => window.api.installUpdate()}
          onClose={() => setShowSettings(false)}
        />
      ) : null}
      {profileTarget ? (
        <ProfileView target={profileTarget} onClose={() => setProfileTarget(null)} />
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
            onTogglePlatform={(key) => togglePlatform(openItem.id, key)}
            trophies={trophiesByItem}
            user={user}
            onVisibilityChange={(value) => setVisibility(openItem.id, value)}
            onOpenProfile={setProfileTarget}
          />
        </main>
      </div>
    );
  }

  const counted = `${items.length} ${items.length === 1 ? config.item : config.items} ranked`;
  const subtitle =
    state.view === 'stats'
      ? 'How your rankings break down'
      : state.view === 'awards'
        ? 'Nominate, vote, and see what won'
        : state.view === 'compare'
          ? `Put two ${config.items} side by side`
          : items.length === 0
            ? 'Nothing ranked yet'
            : reorderable
              ? `${counted} · drag to reorder · right-click for options`
              : `${counted} · right-click for options`;

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
              trophies={trophiesByItem}
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

        {state.view === 'awards' ? (
          <AwardsView config={config} items={items} user={user} libraryKey={library} />
        ) : null}
      </main>
    </div>
  );
}
