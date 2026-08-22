# Game Ranker

A Windows desktop app for ranking and reviewing **games and movies**. Fully
offline — no accounts, no network calls, no external services.

Electron + React (Vite), packaged with electron-builder into an NSIS installer.

## Running it

```bash
npm install
npm run dev
```

If `npm install` reports that Electron's install script was blocked (npm 11+
gates install scripts), fetch the Electron binary with:

```bash
node node_modules/electron/install.js
```

## Building the installer

```bash
npm run dist
```

Produces `release/Game-Ranker-Setup-1.0.0.exe` — a per-user NSIS installer that
adds a **Game Ranker** Start Menu entry (right-click → Pin to taskbar) and a
desktop shortcut. No admin rights needed.

## How it works

### Libraries

A rail down the left switches between **Games** and **Movies** (`Alt+1` /
`Alt+2`). They are separate rankings that share every screen and every feature;
each one keeps its own view, search, filters and comparison, so switching back
lands you where you left off. The rail also holds the theme toggle and the
keyboard-shortcut sheet.

What differs per library is declared in one place, `src/lib/media.js`:

| | Games | Movies |
|---|---|---|
| Categories | Gameplay, Music, Feel, Art, Story | Story, Acting, Music, Visuals, Pacing |
| Genres | Horror, Shooter, Puzzle, Reading, Tabletop, Action, Adventure, Simulation, Tower Defense, Roguelike, War, Mystery, Management | Horror, Comedy, Drama, Action, Adventure, Thriller, Sci-Fi, Fantasy, Documentary, Romance, Mystery, War, Crime |
| Second tag | Players: Singleplayer / Multiplayer | Format: Live action / Animated |
| Time field | Hours played | Runtime |
| Date field | First played | First watched |

Adding a third library is a matter of adding an entry to that array.

### Screens

A strip across the top carries the library title, the **Board / Stats /
Compare** switcher (← / → move between them) and the save state + `Add` button.

**Board** — items in ranked order. Each cell shows the main image with its
position (`1st`, `2nd`, …) in the top-left corner, and a circular overall-score
badge plus its genres below. Drag any cell to re-rank; a plain click opens the
detail view. Right-click for **Open**, **Compare with…** and **Delete**.

Under the strip sits the **filter bar**: search, sort, genre/tag filters and
image export.

- **Search** matches titles *and* note text, so "the one with the fishing
  minigame" is findable.
- **Filters** narrow by genre and by Players/Format. Multiple tags are ANDed.
- **Sort** by your ranking, score, recently added, or A–Z.
- Dragging is only enabled under "My ranking" with no filters active — a drop
  into a partial view has no honest meaning, so the bar says so instead.

**Stats** — read-only charts over the library: summary tiles, score distribution
across the colour bands, category averages, genre and tag breakdowns (count plus
mean score), time logged, time against score, first-played timeline, and the
full ranking as a table. Clicking a bar, dot or row opens that item. Nothing
here is stored — `src/lib/stats.js` recomputes it from the same array the board
draws.

**Compare** — two items side by side: cover, overall badge, time and date facts,
genres, every category score with the higher side marked, and the overall note.
The header names whichever is ahead and by how much.

**Detail** — the main image large with a gallery carousel (arrows, thumbnails,
swipe, or ← / →). Below it, genre and tag chips, the time/date fields, the
read-only overall score, the category sliders, and the free-text boxes.

### Keyboard

Press `?` anywhere for the full list.

| | |
|---|---|
| `Ctrl+F` or `/` | jump to search |
| `Alt+1` / `Alt+2` | switch library |
| `Ctrl+E` | export the ranking as a PNG |
| Board: arrows | move the selection; `Enter` opens, `Delete` removes |
| Detail: ↑ / ↓ | pick a category to score |
| Detail: digits | type that category's score |
| Detail: ← / → | flip through images |

Typed scores build digit by digit: `8` `5` is 85, `1` `0` `0` is 100. Each
keystroke applies live and the entry clears itself after a moment, so there is
no commit step to remember (`Enter` commits early, `Esc` cancels).

Only the category scores can be typed — the overall score is derived, so there
is nothing to set on the board itself.

### Exporting the ranking

**Export** on the filter bar writes the whole ranking as a **PNG** or **JPEG** —
a table with cover thumbnails, positions, score badges, genres, time and dates.
The image is drawn to a canvas by `src/lib/export-image.js` rather than
screenshotting the DOM, so it looks the same whatever the window size and
whatever is scrolled into view. It exports exactly what the board is showing, so
filtering first exports the filtered list, and the active search/filters are
printed under the title.

Covers are pulled through `images:read` as data URLs, not over `gameimg://`:
Chromium refuses `crossOrigin` on custom schemes, which would taint the canvas
and block encoding.

### Theme

Light and dark, toggled from the rail and remembered in the data file. Every
colour is a custom property on `:root`, so the light theme is one block of
overrides at the top of `src/styles.css` rather than a second stylesheet.

### Score colours

One scale, used by the board badges and every slider fill
(`src/lib/score.js` is the only place it's defined):

| Score | Colour | | Score | Colour |
|---|---|---|---|---|
| 90–100 | dark green | | 40–49 | red |
| 80–89 | green | | 30–39 | dark red |
| 70–79 | yellow | | 20–29 | purple |
| 60–69 | amber | | 0–19 | black |
| 50–59 | orange | | | |

The overall score is always `round(average of the category scores)` and is never
editable directly.

### Data

Everything lives under `%APPDATA%\game-ranker` (`Game Ranker` once installed):

```
data.json          the libraries and settings
data.backup.json   previous revision, rewritten on each save
images/            imported images, copied in and renamed to a UUID
```

Imported files are copied into `images/` on import, so moving or deleting the
originals doesn't affect the app. The renderer reaches them through a custom
`gameimg://` protocol rather than raw filesystem paths, so `contextIsolation`
stays on and web security is never disabled.

The file is **version 2**:

```json
{ "version": 2, "libraries": { "games": [], "movies": [] }, "settings": { "theme": "dark" } }
```

Version 1 kept a single top-level `games` array. Those files are lifted into
`libraries.games` on load and rewritten in the new shape by the next autosave —
nothing is lost, and a v1 file opened by this build keeps every game, score,
note, image and date. Records gained `genres`, `modes` and `addedAt`; older
items load with empty tags and a null stamp, which sorts them to the bottom of
"Recently added".

Autosave runs 200 ms after any change — slider, keystroke, drag, or import —
and also flushes on window blur and close. Writes go to a temp file and are
renamed into place, so an interrupted save can't corrupt the library.

## Layout

```
electron/main.js       window, IPC, persistence, image import, gameimg://
electron/preload.js    the contextBridge surface (window.api)
src/App.jsx            state, autosave, libraries, routing between the screens
src/lib/media.js       what differs per library: categories, genres, labels
src/lib/score.js       colour scale and overall-score maths
src/lib/model.js       item shape, defaults, normalisation on load
src/lib/collection.js  search, tag filters, sort order
src/lib/stats.js       everything the Stats view charts, derived on the fly
src/lib/export-image.js  the ranking drawn to a PNG/JPEG canvas
src/components/        Sidebar, TopStrip, FilterBar, BoardView, StatsView,
                       CompareView, DetailView, ShortcutsOverlay, TagChips,
                       ContextMenu, ScoreSlider, ScoreBadge
scripts/make-icon.js   generates build/icon.ico with no image dependencies
```
