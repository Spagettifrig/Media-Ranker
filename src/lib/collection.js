/**
 * Search, filter and sort for a library's board.
 *
 * The stored order *is* the ranking, so nothing in here ever mutates the
 * library: `visibleItems` returns a view. Drag-to-reorder is only offered when
 * that view still matches the underlying order (see `isReorderable`).
 */

export const SORTS = [
  { key: 'rank', label: 'My ranking' },
  { key: 'score', label: 'Score (high to low)' },
  { key: 'added', label: 'Recently added' },
  { key: 'title', label: 'A to Z' },
];

export const DEFAULT_FILTERS = {
  query: '',
  genres: [],
  modes: [],
  platforms: [],
  sort: 'rank',
};

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function matchesQuery(item, needle) {
  if (!needle) return true;
  if (item.title.toLowerCase().includes(needle)) return true;
  // Notes are searched too - it is the only way to find "the one with the
  // fishing minigame" when the title has long since fallen out of memory.
  return Object.values(item.descriptions ?? {}).some(
    (text) => typeof text === 'string' && text.toLowerCase().includes(needle),
  );
}

/** Every selected tag must be present (AND), which is what narrowing implies. */
function matchesTags(itemTags, selected) {
  if (selected.length === 0) return true;
  const owned = new Set(itemTags ?? []);
  return selected.every((key) => owned.has(key));
}

/**
 * Platforms are the one filter that ORs instead of ANDing. Picking PS2 and PC
 * asks for "the games I played on either", not "the handful I played on both" -
 * ANDing them would answer a question nobody has.
 */
function matchesAnyTag(itemTags, selected) {
  if (selected.length === 0) return true;
  const owned = new Set(itemTags ?? []);
  return selected.some((key) => owned.has(key));
}

export function filterItems(items, filters) {
  const needle = filters.query.trim().toLowerCase();
  const platforms = filters.platforms ?? [];
  if (!needle && filters.genres.length === 0 && filters.modes.length === 0 && platforms.length === 0) {
    return items;
  }
  return items.filter(
    (item) =>
      matchesQuery(item, needle) &&
      matchesTags(item.genres, filters.genres) &&
      matchesTags(item.modes, filters.modes) &&
      matchesAnyTag(item.platforms, platforms),
  );
}

export function sortItems(items, sort) {
  if (sort === 'rank') return items;
  const sorted = [...items];
  switch (sort) {
    case 'score':
      // Board order breaks ties, so equal scores keep the order you chose.
      sorted.sort((a, b) => b.overallScore - a.overallScore || a.rank - b.rank);
      break;
    case 'added':
      sorted.sort((a, b) => {
        // Items with no stamp predate the feature: park them at the bottom.
        if (a.addedAt === b.addedAt) return a.rank - b.rank;
        if (!a.addedAt) return 1;
        if (!b.addedAt) return -1;
        return b.addedAt.localeCompare(a.addedAt);
      });
      break;
    case 'title':
      sorted.sort((a, b) => collator.compare(a.title, b.title) || a.rank - b.rank);
      break;
    default:
      break;
  }
  return sorted;
}

export function visibleItems(items, filters) {
  return sortItems(filterItems(items, filters), filters.sort);
}

export function isFiltered(filters) {
  return (
    Boolean(filters.query.trim()) ||
    filters.genres.length > 0 ||
    filters.modes.length > 0 ||
    (filters.platforms ?? []).length > 0
  );
}

/**
 * Dragging may only rewrite the ranking when what you see is the whole board
 * in board order - otherwise a drop would have to guess where the hidden items
 * belong.
 */
export function isReorderable(filters) {
  return filters.sort === 'rank' && !isFiltered(filters);
}

/** Human summary of the active narrowing, for subtitles and the export image. */
export function describeFilters(config, filters) {
  const parts = [];
  if (filters.query.trim()) parts.push(`"${filters.query.trim()}"`);
  const genreLabels = config.genres.filter((g) => filters.genres.includes(g.key)).map((g) => g.label);
  if (genreLabels.length > 0) parts.push(genreLabels.join(' + '));
  const modeLabels = config.modes.filter((m) => filters.modes.includes(m.key)).map((m) => m.label);
  if (modeLabels.length > 0) parts.push(modeLabels.join(' + '));
  const platformLabels = (config.platforms ?? [])
    .filter((p) => (filters.platforms ?? []).includes(p.key))
    .map((p) => p.label);
  // " or ", not " + " - platforms are the ORed filter, and the export image
  // caption has to read the way the list actually behaves.
  if (platformLabels.length > 0) parts.push(platformLabels.join(' or '));
  return parts.join(' · ');
}
