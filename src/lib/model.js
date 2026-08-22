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

/**
 * `genres`, `modes` and `hoursPlayed` are optional because a manual import has
 * none of them - they are filled in when an item comes from the online
 * catalog, and normalised here so a provider can never widen the tag set.
 */
export function createItem(
  libraryKey,
  { title, mainImage = null, galleryImages = [], genres = [], modes = [], hoursPlayed = null } = {},
) {
  const config = libraryConfig(libraryKey);
  const categoryScores = Object.fromEntries(
    config.categories.map((c) => [c.key, DEFAULT_CATEGORY_SCORE]),
  );
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
    genres: normalizeTags(genres, config.genres),
    modes: normalizeTags(modes, config.modes),
    addedAt: new Date().toISOString(),
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
    genres: normalizeTags(raw?.genres, config.genres),
    modes: normalizeTags(raw?.modes, config.modes),
    // Items saved before "date added" existed keep a null stamp; sorting falls
    // back to board order for those, which is the closest honest answer.
    addedAt: normalizeAddedAt(raw?.addedAt),
  };
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
