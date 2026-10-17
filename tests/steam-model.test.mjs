import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createItem, normalizeItem, withRanks } from '../src/lib/model.js';
import { appendSteamEntries, steamDuplicate, steamPlaytimeUpdates } from '../src/lib/steam-import.js';
import { summarize } from '../src/lib/stats.js';
import { libraryConfig } from '../src/lib/media.js';

const entry = { steamAppId: '400', title: 'Portal', hours: 1.6, provider: 'igdb', remoteId: '71', genreNames: ['Puzzle'], modeIds: [1], file: 'portal.jpg', year: 2007 };

test('old saved ratings are migrated as rated without changing scores', () => {
  const item = createItem('games', { title: 'Original' });
  delete item.unrated;
  const restored = normalizeItem('games', { ...item, categoryScores: { gameplay: 90, music: 90, feel: 90, art: 90, story: 90 } }, 0);
  assert.equal(restored.unrated, false);
  assert.equal(restored.overallScore, 90);
  assert.equal(restored.steamAppId, null);
});
test('imports have no overall score and survive a save/reload', () => {
  const [item] = appendSteamEntries([], [entry]);
  const restored = normalizeItem('games', JSON.parse(JSON.stringify(item)), 0);
  assert.equal(restored.unrated, true);
  assert.equal(restored.overallScore, null);
  assert.equal(restored.steamAppId, '400');
  assert.equal(restored.hoursPlayed, 1.6);
  assert.equal(restored.rank, 0);
  assert.equal(restored.providerId, '71');
  assert.equal(restored.releaseYear, 2007);
});
test('existing ratings, order, notes, time and image remain unchanged', () => {
  const old = withRanks([createItem('games', { title: 'First', hoursPlayed: 50 }), createItem('games', { title: 'Second' })]);
  const saved = JSON.stringify(old);
  const result = appendSteamEntries(old, [entry]);
  assert.equal(JSON.stringify(result.slice(0, 2)), saved);
  assert.equal(JSON.stringify(old), saved);
  assert.equal(result[2].rank, 0);
});
test('repeat imports and duplicate catalog identities within a batch are skipped', () => {
  const result = appendSteamEntries([], [entry, entry, { ...entry, steamAppId: '401' }]);
  assert.equal(result.length, 1);
  assert.equal(appendSteamEntries(result, [entry]).length, 1);
});
test('existing catalog entry is recognized even without a Steam ID', () => {
  const existing = createItem('games', { title: 'Custom title', provider: 'igdb', providerId: '71' });
  assert.equal(steamDuplicate(entry, [existing]).kind, 'exact');
  assert.equal(appendSteamEntries([existing], [entry]).length, 1);
});
test('title-only duplicate is a warning, not an automatic merge', () => {
  const existing = createItem('games', { title: 'Pórtal!' });
  assert.equal(steamDuplicate(entry, [existing]).kind, 'possible');
  assert.equal(appendSteamEntries([existing], [entry]).length, 2);
});
test('unrated entries contribute nothing to scored statistics', () => {
  const rated = createItem('games', { title: 'Rated', hoursPlayed: 12 });
  const result = summarize(appendSteamEntries([rated], [entry]), libraryConfig('games'));
  assert.equal(result.count, 1);
  assert.equal(result.averageScore, 50);
  assert.equal(result.totalHours, 12);
});
test('partition preserves board ranks and assigns a completed import the next rank', () => {
  const rated = createItem('games', { title: 'Ranked' });
  const imported = appendSteamEntries([], [entry])[0];
  const ordered = withRanks([imported, rated]);
  assert.equal(ordered[0].id, rated.id);
  assert.deepEqual(ordered.map((item) => item.rank), [1, 0]);
  assert.deepEqual(withRanks([rated, { ...imported, unrated: false, overallScore: 80 }]).map((item) => item.rank), [1, 2]);
});
test('playtime refresh only raises hours on items that came from Steam', () => {
  const [imported] = appendSteamEntries([], [entry]);
  const manual = createItem('games', { title: 'Portal', hoursPlayed: 1 });
  const items = [imported, manual];
  assert.deepEqual(steamPlaytimeUpdates(items, [{ ...entry, hours: 9 }]), [{ id: imported.id, hours: 9 }]);
  assert.deepEqual(steamPlaytimeUpdates(items, [{ ...entry, hours: 1 }]), []);
  assert.deepEqual(steamPlaytimeUpdates(items, [{ ...entry, hours: null }]), []);
});
