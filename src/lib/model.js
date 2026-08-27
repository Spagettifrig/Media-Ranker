import { clampScore, computeOverall } from './score.js';
import { libraryConfig } from './media.js';

const DEFAULT_CATEGORY_SCORE = 50;

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Turn "the_legend-of  something.png" into "The Legend Of Something". */
export function titleFromFileName(name) {
  const cleaned = String(name || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Untitled';
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

const MAX_HOURS = 100000;

/** Hours are optional: `null` means "not tracked", never 0. */
export function clampHours(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(MAX_HOURS, Math.round(n * 10) / 10);
}

/** Dates are stored the way `<input type="date">` speaks: YYYY-MM-DD, or ''. */
export function normalizeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const roundTrips =
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  return roundTrips ? value : '';
}

/** Keep only tag keys the library actually defines, in the library's order. */
function normalizeTags(raw, allowed) {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.filter((key) => typeof key === 'string'));
  return allowed.filter((tag) => wanted.has(tag.key)).map((tag) => tag.key);
}

/** "Date added" only has to sort; an ISO timestamp is plenty. */
function normalizeAddedAt(value) {
  if (typeof value !== 'string' || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Same shape as `normalizeAddedAt`, just a different meaning: last edit, not first add. */
function normalizeUpdatedAt(value) {
  if (typeof value !== 'string' || !value) return new Date().toISOString();
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
}

/**
 * The catalog's release year, kept because Game of the Year is decided on it.
 * It used to be fetched and thrown away; backfilling it later would mean
 * re-querying IGDB for every item on every board, so it is stored on import.
 */
function normalizeReleaseYear(value) {
  const year = Number(value);
  if (!Number.isFinite(year)) return null;
  return year >= 1950 && year <= 2200 ? Math.trunc(year) : null;
}

// `tmdb_tv` is separate from `tmdb` on purpose - see the note on the `series`
// provider in electron/catalog.js. Films and shows share id numbers.
const PROVIDERS = new Set(['igdb', 'tmdb', 'tmdb_tv']);

/** Which catalog resolved this item, if any - `null` for a manual (photo) import. */
function normalizeProvider(value) {
  return PROVIDERS.has(value) ? value : null;
}

const VISIBILITIES = new Set(['inherit', 'public', 'private']);

/** Per-review visibility override; `'inherit'` defers to the profile's default. */
function normalizeVisibility(value) {
  return VISIBILITIES.has(value) ? value : 'inherit';
}

/**
 * `genres`, `modes` and `hoursPlayed` are optional because a manual import has
 * none of them - they are filled in when an item comes from the online
 * catalog, and normalised here so a provider can never widen the tag set.
 */
export function createItem(
  libraryKey,
  {
    title,
    mainImage = null,
    galleryImages = [],
    genres = [],
    modes = [],
    hoursPlayed = null,
    provider = null,
    providerId = null,
    coverImageUrl = null,
    releaseYear = null,
  } = {},
) {
  const config = libraryConfig(libraryKey);
  const categoryScores = Object.fromEntries(
    config.categories.map((c) => [c.key, DEFAULT_CATEGORY_SCORE]),
  );
  const now = new Date().toISOString();
  return {
    id: newId(),
    title: title || `Untitled ${config.Item}`,
    mainImage,
    galleryImages: [...galleryImages],
    rank: 0,
    overallScore: computeOverall(categoryScores, config.categories),
    categoryScores,
    disabledCategories: [],
    descriptions: Object.fromEntries(config.descriptionFields.map((d) => [d.key, ''])),
    hoursPlayed: clampHours(hoursPlayed),
    firstPlayed: '',
    releaseYear: normalizeReleaseYear(releaseYear),
    genres: normalizeTags(genres, config.genres),
    modes: normalizeTags(modes, config.modes),
    // Which console you played it on. Multi-select, because playing Skyrim
    // on both a 360 and a PC is the normal case, not the odd one.
    platforms: [],
    addedAt: now,
    // Set only when the item came from a catalog search - see catalog.js /
    // App.jsx's addFromCatalog. A manual (photo) import leaves these null,
    // which is what keeps it out of the social feed: there's no reliable
    // shared identity to join it to another user's copy of the same game.
    provider: normalizeProvider(provider),
    providerId: provider && providerId != null ? String(providerId) : null,
    coverImageUrl: typeof coverImageUrl === 'string' ? coverImageUrl : null,
    visibility: 'inherit',
    updatedAt: now,
  };
}

/** Defensive read of anything that came off disk. */
export function normalizeItem(libraryKey, raw, index) {
  const config = libraryConfig(libraryKey);
  const base = createItem(libraryKey, {});

  const categoryScores = { ...base.categoryScores };
  for (const cat of config.categories) {
    const value = raw?.categoryScores?.[cat.key];
    if (value !== undefined && value !== null && value !== '') {
      categoryScores[cat.key] = clampScore(value);
    }
  }

  const descriptions = { ...base.descriptions };
  for (const field of config.descriptionFields) {
    const value = raw?.descriptions?.[field.key];
    if (typeof value === 'string') descriptions[field.key] = value;
  }

  const gallery = Array.isArray(raw?.galleryImages)
    ? raw.galleryImages.filter((n) => typeof n === 'string' && n)
    : [];

  const disabledCategories = normalizeTags(raw?.disabledCategories, config.categories);

  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : base.id,
    title:
      typeof raw?.title === 'string' && raw.title.trim() ? raw.title : `Untitled ${config.Item}`,
    mainImage: typeof raw?.mainImage === 'string' && raw.mainImage ? raw.mainImage : null,
    galleryImages: gallery,
    rank: Number.isFinite(Number(raw?.rank)) ? Number(raw.rank) : index + 1,
    overallScore: computeOverall(categoryScores, config.categories, disabledCategories),
    categoryScores,
    disabledCategories,
    descriptions,
    hoursPlayed: clampHours(raw?.hoursPlayed),
    firstPlayed: normalizeDate(raw?.firstPlayed),
    releaseYear: normalizeReleaseYear(raw?.releaseYear),
    genres: normalizeTags(raw?.genres, config.genres),
    modes: normalizeTags(raw?.modes, config.modes),
    platforms: normalizeTags(raw?.platforms, config.platforms ?? []),
    // Items saved before "date added" existed keep a null stamp; sorting falls
    // back to board order for those, which is the closest honest answer.
    addedAt: normalizeAddedAt(raw?.addedAt),
    provider: normalizeProvider(raw?.provider),
    providerId:
      normalizeProvider(raw?.provider) && typeof raw?.providerId === 'string' ? raw.providerId : null,
    coverImageUrl: typeof raw?.coverImageUrl === 'string' ? raw.coverImageUrl : null,
    visibility: normalizeVisibility(raw?.visibility),
    // Items saved before edit-stamping existed fall back to when they were
    // added, so they get one stable timestamp instead of looking freshly
    // edited - and therefore newer than the cloud - on every single load.
    updatedAt: normalizeUpdatedAt(raw?.updatedAt ?? raw?.addedAt),
  };
}

/**
 * A cloud review row (already cover-downloaded by the main process) as a local
 * item. Only the fields the cloud actually stores come back: board position,
 * gallery images and which console you played it on are per-device and start
 * empty. "First played" is *not* in that list any more - awards eligibility is
 * decided on it, so it has to be the same date on every machine and on the
 * server.
 */
export function itemFromReview(libraryKey, review, index = 0) {
  return normalizeItem(
    libraryKey,
    {
      id: review.id,
      title: review.title,
      mainImage: review.file ?? null,
      galleryImages: [],
      categoryScores: review.categoryScores,
      disabledCategories: review.disabledCategories,
      descriptions: review.descriptions,
      genres: review.genres,
      modes: review.modes,
      hoursPlayed: review.hoursPlayed,
      firstPlayed: review.firstPlayed,
      releaseYear: review.releaseYear,
      addedAt: review.addedAt,
      provider: review.provider,
      providerId: review.providerId,
      coverImageUrl: review.coverImageUrl,
      visibility: review.visibility,
      updatedAt: review.updatedAt,
    },
    index,
  );
}

/** Board position is the array order; `rank` is kept in sync for the data file. */
export function withRanks(items) {
  return items.map((item, index) => (item.rank === index + 1 ? item : { ...item, rank: index + 1 }));
}

/** Every stored image file an item refers to, main first. */
export function allImagesOf(item) {
  return [item?.mainImage, ...(item?.galleryImages ?? [])].filter(Boolean);
}

/** Add or remove one tag key from an item's `genres` / `modes` array. */
export function toggleTag(current, key, allowed) {
  const has = (current ?? []).includes(key);
  const next = has ? current.filter((k) => k !== key) : [...(current ?? []), key];
  return normalizeTags(next, allowed);
}
