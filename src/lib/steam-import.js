import { createItem, withRanks } from './model.js';
import { libraryConfig } from './media.js';

const titleKey = (value) => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

/** Name matches are only a warning, never permission to merge or overwrite. */
export function steamDuplicate(game, items) {
  const exact = items.find((item) =>
    (item.steamAppId && item.steamAppId === game.steamAppId) ||
    (game.provider && game.remoteId && item.provider === game.provider && item.providerId === game.remoteId));
  if (exact) return { kind: 'exact', item: exact };
  const title = titleKey(game.title);
  const possible = title && items.find((item) => titleKey(item.title) === title);
  return possible ? { kind: 'possible', item: possible } : null;
}

/** Recheck identities on commit, including duplicates within the same batch. */
export function appendSteamEntries(items, entries) {
  const next = [...items];
  for (const entry of entries) {
    if (steamDuplicate(entry, next)?.kind === 'exact') continue;
    const { genres, modes } = libraryConfig('games').catalog.tags(entry);
    next.push(createItem('games', {
      title: entry.title, mainImage: entry.file, genres, modes,
      hoursPlayed: entry.hours, provider: entry.provider, providerId: entry.remoteId,
      coverImageUrl: entry.imageUrl, releaseYear: entry.year,
      steamAppId: entry.steamAppId, unrated: true,
    }));
  }
  return withRanks(next);
}

/**
 * Playtime only ever goes up from a fresh Steam read, and only on items that
 * came from Steam, so a manual correction to a non-Steam entry is never touched.
 */
export function steamPlaytimeUpdates(items, games) {
  const hours = new Map(games.filter((game) => typeof game.hours === 'number').map((game) => [game.steamAppId, game.hours]));
  return items.flatMap((item) => {
    const next = item.steamAppId ? hours.get(item.steamAppId) : undefined;
    return next !== undefined && next > (item.hoursPlayed ?? 0) ? [{ id: item.id, hours: next }] : [];
  });
}
