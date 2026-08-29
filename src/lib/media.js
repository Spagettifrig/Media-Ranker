/**
 * Everything that differs between the libraries lives here.
 *
 * A "library" is one ranked collection - games, movies, and anything added
 * later. The rest of the app is written against this shape, so the board,
 * detail page, stats, compare and export screens are shared code and can
 * never drift apart between libraries.
 */

const GAME_CATEGORIES = [
  { key: 'gameplay', label: 'Gameplay' },
  { key: 'music', label: 'Music' },
  { key: 'feel', label: 'Feel' },
  { key: 'art', label: 'Art' },
  { key: 'story', label: 'Story' },
];

const MOVIE_CATEGORIES = [
  { key: 'story', label: 'Story' },
  { key: 'acting', label: 'Acting' },
  { key: 'music', label: 'Music' },
  { key: 'visuals', label: 'Visuals' },
  { key: 'pacing', label: 'Pacing' },
  { key: 'feel', label: 'Feel' },
];

/**
 * Same six axes a film is judged on, plus the one thing only a series can
 * get wrong: holding its quality across a run of episodes.
 */
const SERIES_CATEGORIES = [
  { key: 'story', label: 'Story' },
  { key: 'acting', label: 'Acting' },
  { key: 'music', label: 'Music' },
  { key: 'visuals', label: 'Visuals' },
  { key: 'pacing', label: 'Pacing' },
  { key: 'feel', label: 'Feel' },
  { key: 'consistency', label: 'Consistency' },
];

function genres(...labels) {
  return labels.map((label) => ({
    key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label,
  }));
}

/**
 * Where you played it, which is a fact about *you* and not about the game -
 * IGDB knows a game shipped on five platforms, it cannot know which one you
 * put the hours into. So this is hand-picked, multi-select, and grouped only
 * for the sake of the picker.
 */
const GAME_PLATFORMS = [
  { key: 'pc', label: 'PC', group: 'PC' },
  { key: 'ps1', label: 'PlayStation', group: 'PlayStation' },
  { key: 'ps2', label: 'PlayStation 2', group: 'PlayStation' },
  { key: 'ps3', label: 'PlayStation 3', group: 'PlayStation' },
  { key: 'ps4', label: 'PlayStation 4', group: 'PlayStation' },
  { key: 'ps5', label: 'PlayStation 5', group: 'PlayStation' },
  { key: 'psp', label: 'PSP / Vita', group: 'PlayStation' },
  { key: 'xbox', label: 'Xbox', group: 'Xbox' },
  { key: 'xbox360', label: 'Xbox 360', group: 'Xbox' },
  { key: 'xboxone', label: 'Xbox One', group: 'Xbox' },
  { key: 'xboxseries', label: 'Xbox Series X|S', group: 'Xbox' },
  { key: 'n64', label: 'Nintendo 64', group: 'Nintendo' },
  { key: 'gamecube', label: 'GameCube', group: 'Nintendo' },
  { key: 'wii', label: 'Wii', group: 'Nintendo' },
  { key: 'wiiu', label: 'Wii U', group: 'Nintendo' },
  { key: 'switch', label: 'Switch', group: 'Nintendo' },
  { key: 'switch2', label: 'Switch 2', group: 'Nintendo' },
  { key: 'ds', label: 'DS / 3DS', group: 'Nintendo' },
  { key: 'gameboy', label: 'Game Boy', group: 'Nintendo' },
  { key: 'mobile', label: 'Mobile', group: 'Other' },
  { key: 'other', label: 'Other', group: 'Other' },
];

/* ------------------------------------------------------------------ *
 * Online catalog vocabulary
 *
 * The providers speak their own genre languages, so each library owns the
 * translation into its own tags. Anything unmapped is simply dropped - a
 * rough-but-right set of tags beats inventing categories the user never
 * chose, and they can always adjust them on the detail page.
 * ------------------------------------------------------------------ */

/** IGDB genre *and* theme names, lowercased. Themes are where Horror lives. */
const IGDB_TAGS = {
  shooter: 'shooter',
  puzzle: 'puzzle',
  adventure: 'adventure',
  'point-and-click': 'adventure',
  simulator: 'simulation',
  'card & board game': 'tabletop',
  'visual novel': 'reading',
  strategy: 'management',
  'real time strategy (rts)': 'management',
  'turn-based strategy (tbs)': 'management',
  tactical: 'war',
  fighting: 'action',
  arcade: 'action',
  platform: 'action',
  "hack and slash/beat 'em up": 'action',
  // themes
  action: 'action',
  horror: 'horror',
  warfare: 'war',
  mystery: 'mystery',
};

/** IGDB game_mode ids. Everything that is not strictly solo counts as multi. */
const IGDB_MODES = {
  1: 'singleplayer',
  2: 'multiplayer',
  3: 'multiplayer',
  4: 'multiplayer',
  5: 'multiplayer',
  6: 'multiplayer',
};

/** TMDB genre ids. */
const TMDB_TAGS = {
  28: 'action',
  12: 'adventure',
  35: 'comedy',
  80: 'crime',
  99: 'documentary',
  18: 'drama',
  14: 'fantasy',
  27: 'horror',
  9648: 'mystery',
  10749: 'romance',
  878: 'sci-fi',
  53: 'thriller',
  10752: 'war',
};

/**
 * TMDB keeps a *separate* genre list for television, and the ids do not line
 * up with the film ones - 16 is Animation in both, but 10759 (Action &
 * Adventure) and 10765 (Sci-Fi & Fantasy) are pairs that have no film
 * equivalent at all. Hence a second table, and array values so one broad TV
 * genre can land as the two tags it actually means.
 */
const TMDB_TV_TAGS = {
  10759: ['action', 'adventure'],
  35: ['comedy'],
  80: ['crime'],
  99: ['documentary'],
  18: ['drama'],
  10751: ['family'],
  10762: ['family'],
  9648: ['mystery'],
  10764: ['reality'],
  10765: ['sci-fi', 'fantasy'],
  10768: ['war'],
  37: ['western'],
};

const TMDB_ANIMATION = 16;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export const LIBRARIES = [
  {
    key: 'games',
    label: 'Games',
    item: 'game',
    Item: 'Game',
    items: 'games',
    title: 'Game Ranker',
    categories: GAME_CATEGORIES,
    descriptionFields: [
      { key: 'overall', label: 'Overall', placeholder: 'A short thought on the whole thing...' },
      { key: 'gameplay', label: 'Gameplay', placeholder: 'How it plays - systems, controls, pacing...' },
      { key: 'music', label: 'Music', placeholder: 'Soundtrack, sound design, how it sits with the rest...' },
      { key: 'feel', label: 'Feel', placeholder: 'Moment-to-moment feedback, weight, responsiveness...' },
      { key: 'art', label: 'Art', placeholder: 'Direction, style, how well it holds up...' },
      { key: 'story', label: 'Story', placeholder: 'Writing, characters, structure...' },
    ],
    genres: genres(
      'Horror',
      'Shooter',
      'Puzzle',
      'Reading',
      'Tabletop',
      'Action',
      'Adventure',
      'Simulation',
      'Tower Defense',
      'Roguelike',
      'War',
      'Mystery',
      'Management',
    ),
    modes: [
      { key: 'singleplayer', label: 'Singleplayer' },
      { key: 'multiplayer', label: 'Multiplayer' },
    ],
    modesLabel: 'Players',
    platforms: GAME_PLATFORMS,
    platformsLabel: 'Played on',
    hours: {
      label: 'Hours played',
      unit: 'hours',
      untracked: 'Not tracked yet',
      logged: 'logged',
      chartTitle: 'Hours played',
      chartNote: 'Longest first. Add hours on a game\'s detail page.',
      totalLabel: 'Hours logged',
      longestLabel: 'Longest play',
      scatterTitle: 'Hours against score',
    },
    date: {
      label: 'First played',
      empty: 'No date set',
      chartTitle: 'Games first played',
      chartNote: 'By the year you first picked each one up.',
    },
    catalog: {
      provider: 'IGDB',
      placeholder: 'Search IGDB for a game...',
      credit: 'Game data and cover art from IGDB.',
      tags: (result) => ({
        genres: unique((result.genreNames ?? []).map((name) => IGDB_TAGS[name.toLowerCase()])),
        modes: unique((result.modeIds ?? []).map((id) => IGDB_MODES[id])),
      }),
    },
  },
  {
    key: 'movies',
    label: 'Movies',
    item: 'movie',
    Item: 'Movie',
    items: 'movies',
    title: 'Movie Ranker',
    categories: MOVIE_CATEGORIES,
    descriptionFields: [
      { key: 'overall', label: 'Overall', placeholder: 'A short thought on the whole thing...' },
      { key: 'story', label: 'Story', placeholder: 'Writing, structure, how it lands...' },
      { key: 'acting', label: 'Acting', placeholder: 'Performances, casting, chemistry...' },
      { key: 'music', label: 'Music', placeholder: 'Score, songs, sound design...' },
      { key: 'visuals', label: 'Visuals', placeholder: 'Cinematography, effects, production design...' },
      { key: 'pacing', label: 'Pacing', placeholder: 'Runtime, momentum, where it drags...' },
      { key: 'feel', label: 'Feel', placeholder: 'Tone, atmosphere, how it sat with you...' },
    ],
    genres: genres(
      'Horror',
      'Comedy',
      'Drama',
      'Action',
      'Adventure',
      'Thriller',
      'Sci-Fi',
      'Fantasy',
      'Documentary',
      'Romance',
      'Mystery',
      'War',
      'Crime',
    ),
    modes: [
      { key: 'live-action', label: 'Live action' },
      { key: 'animated', label: 'Animated' },
    ],
    modesLabel: 'Format',
    // "Which console" has no sensible answer for a film, so every platform
    // control in the app keys off this being empty and simply disappears.
    platforms: [],
    platformsLabel: 'Watched on',
    hours: {
      label: 'Runtime',
      unit: 'hours',
      untracked: 'Not tracked yet',
      logged: 'runtime',
      chartTitle: 'Longest runtimes',
      chartNote: 'Longest first. Add a runtime on a movie\'s detail page.',
      totalLabel: 'Hours watched',
      longestLabel: 'Longest film',
      scatterTitle: 'Runtime against score',
    },
    date: {
      label: 'First watched',
      empty: 'No date set',
      chartTitle: 'Movies first watched',
      chartNote: 'By the year you first saw each one.',
    },
    catalog: {
      provider: 'TMDB',
      placeholder: 'Search TMDB for a movie...',
      credit:
        'This product uses the TMDB API but is not endorsed or certified by TMDB.',
      // A runtime is a fact about the film, so the import fills it in - unlike
      // hours played, which is the user's own log. The catalog sheet says so.
      fillsHours: true,
      tags: (result) => {
        const ids = result.genreIds ?? [];
        return {
          genres: unique(ids.map((id) => TMDB_TAGS[id])),
          // TMDB has no "live action" genre - it only marks Animation, so the
          // absence of that tag is what tells us the rest.
          modes: [ids.includes(TMDB_ANIMATION) ? 'animated' : 'live-action'],
        };
      },
    },
  },
  {
    key: 'series',
    label: 'TV Series',
    item: 'series',
    Item: 'Series',
    items: 'series',
    title: 'Series Ranker',
    categories: SERIES_CATEGORIES,
    descriptionFields: [
      { key: 'overall', label: 'Overall', placeholder: 'A short thought on the whole thing...' },
      { key: 'story', label: 'Story', placeholder: 'Writing, arcs, how the run lands...' },
      { key: 'acting', label: 'Acting', placeholder: 'Performances, casting, chemistry...' },
      { key: 'music', label: 'Music', placeholder: 'Score, theme, sound design...' },
      { key: 'visuals', label: 'Visuals', placeholder: 'Cinematography, effects, production design...' },
      { key: 'pacing', label: 'Pacing', placeholder: 'Episode length, momentum, where it drags...' },
      { key: 'feel', label: 'Feel', placeholder: 'Tone, atmosphere, how it sat with you...' },
      {
        key: 'consistency',
        label: 'Consistency',
        placeholder: 'Does it hold up season to season, or fall off...',
      },
    ],
    genres: genres(
      'Horror',
      'Comedy',
      'Drama',
      'Action',
      'Adventure',
      'Thriller',
      'Sci-Fi',
      'Fantasy',
      'Documentary',
      'Mystery',
      'War',
      'Crime',
      'Family',
      'Reality',
      'Western',
    ),
    modes: [
      { key: 'live-action', label: 'Live action' },
      { key: 'animated', label: 'Animated' },
    ],
    modesLabel: 'Format',
    // Same reasoning as movies: "which console" has no answer for a show, so
    // every platform control keys off this being empty and disappears.
    platforms: [],
    platformsLabel: 'Watched on',
    hours: {
      label: 'Watch time',
      unit: 'hours',
      untracked: 'Not tracked yet',
      logged: 'watch time',
      chartTitle: 'Longest series',
      chartNote: 'Longest first. Add a watch time on a series\' detail page.',
      totalLabel: 'Hours watched',
      longestLabel: 'Longest series',
      scatterTitle: 'Watch time against score',
    },
    date: {
      label: 'First watched',
      empty: 'No date set',
      chartTitle: 'Series first watched',
      chartNote: 'By the year you first started each one.',
    },
    catalog: {
      provider: 'TMDB',
      placeholder: 'Search TMDB for a TV series...',
      credit: 'This product uses the TMDB API but is not endorsed or certified by TMDB.',
      fillsHours: true,
      tags: (result) => {
        const ids = result.genreIds ?? [];
        return {
          genres: unique(ids.flatMap((id) => TMDB_TV_TAGS[id] ?? [])),
          // As with movies, TMDB only marks Animation - the absence of that
          // tag is what tells us the rest.
          modes: [ids.includes(TMDB_ANIMATION) ? 'animated' : 'live-action'],
        };
      },
    },
  },
];

export const DEFAULT_LIBRARY = LIBRARIES[0].key;

const BY_KEY = new Map(LIBRARIES.map((library) => [library.key, library]));

/** Never returns undefined: an unknown key falls back to the first library. */
export function libraryConfig(key) {
  return BY_KEY.get(key) ?? LIBRARIES[0];
}

export function isLibraryKey(key) {
  return BY_KEY.has(key);
}

/** Label lookups used by chips, filters and the export image. */
export function genreLabels(config, keys) {
  const labels = new Map(config.genres.map((genre) => [genre.key, genre.label]));
  return (keys ?? []).map((key) => labels.get(key)).filter(Boolean);
}

export function modeLabels(config, keys) {
  const labels = new Map(config.modes.map((mode) => [mode.key, mode.label]));
  return (keys ?? []).map((key) => labels.get(key)).filter(Boolean);
}

export function platformLabels(config, keys) {
  const labels = new Map((config.platforms ?? []).map((p) => [p.key, p.label]));
  return (keys ?? []).map((key) => labels.get(key)).filter(Boolean);
}

/** Whether this library has platforms at all - false for movies. */
export function hasPlatforms(config) {
  return (config.platforms ?? []).length > 0;
}

/** The picker groups by console family; this keeps that order stable. */
export function platformGroups(config) {
  const groups = new Map();
  for (const platform of config.platforms ?? []) {
    if (!groups.has(platform.group)) groups.set(platform.group, []);
    groups.get(platform.group).push(platform);
  }
  return [...groups].map(([label, platforms]) => ({ label, platforms }));
}
