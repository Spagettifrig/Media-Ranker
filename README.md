# Game Ranker

A Windows desktop app for ranking and reviewing **games, movies and TV series**.
Local-first: every screen works with no account and no connection, and the
library lives on your own disk.

Signing in adds the shared half — cloud backup of your own reviews, other
people's reviews under a game, and the annual **awards**. Catalog search works
out of the box: the IGDB and TMDB credentials live in a Supabase Edge Function
(`supabase/functions/catalog`), so nothing to sign up for and nothing to paste
in. Settings still takes your own keys if you'd rather not share the quota.

Electron + React (Vite), packaged with electron-builder into an NSIS installer.

## Running it

### Steam library import

Games → **Import Steam** reads a public Steam profile and previews the returned
games before importing. You can search, select all new games, select played games,
or select individual titles. Existing Steam IDs / IGDB identities are skipped;
similar titles are flagged and unchecked, never automatically merged. Re-importing
does not replace existing notes, ratings, images or playtime.

Imports go into **Unrated**, with playtime in hours and no overall score. Open a
game, adjust its draft category scores and choose **Finish rating** to move it to
the ranked board. Unrated entries are saved locally but excluded from score stats,
comparisons, ranking exports and review/awards sync. Existing saved items keep
their ratings. Unrated imports are not cloud backups: retain the local app data.

IGDB matches use exact Steam app IDs, never fuzzy title guesses. Missing or
ambiguous matches still import as Steam-only local entries. Steam may omit shared
games, unplayed free-to-play titles and private details. A public profile does not
necessarily expose playtime. Imports are a snapshot, not ongoing account sync.

The app owner must deploy `supabase/functions/steam` and configure the server's
`STEAM_WEB_API_KEY` once to enable keyless imports for users. See
[Steam setup](supabase/functions/steam/README.md). For development, the import
dialog also accepts a personal Steam Web API key, used once and not saved.

### Development

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

## The website

The same app also builds as a website that works in any browser, including on
a phone, and can be added to the home screen like an app.

```bash
npm run dev:web       # dev server on http://localhost:5174
npm run build:web     # static site in dist-web/
npm run preview:web   # serve dist-web/ locally to try the real build
```

`dist-web/` is plain static files with relative paths, so any static host can
serve it from a domain root or a sub-path. Nothing in it is secret: the only
key it carries is the Supabase anon key the installer already ships with.

What is different from the desktop app:

- Rankings are saved in the browser (IndexedDB) instead of `data.json`. Each
  browser has its own copy, so sign in to carry catalog-linked rankings
  between your PC and your phone, the same way two PCs sync today.
- Covers from the catalog, the cloud and Steam are shown straight from the
  provider's image host instead of being downloaded. Photos you add yourself
  are kept in the browser.
- Games always use the shared catalog. Twitch and IGDB refuse requests from
  web pages, so personal IGDB credentials (and personal Steam keys) only work
  in the desktop app. A personal TMDB token still works.
- Exporting downloads the image, or opens the share sheet on a phone.
- There are no update checks: a new deploy loads on the next visit.

The website calls the `catalog` and `steam` Supabase functions from the
browser, so both need deploying once more after this change to send CORS
headers (`npx supabase@latest functions deploy catalog --project-ref
njxypnkamladkjtxging`, and the same for `steam`).

## How it works

### Libraries

A rail down the left switches between **Games**, **Movies** and **TV Series**
(`Alt+1` / `Alt+2` / `Alt+3`). They are separate rankings that share every screen and every feature;
each one keeps its own view, search, filters and comparison, so switching back
lands you where you left off. The rail also holds the theme toggle and the
keyboard-shortcut sheet.

What differs per library is declared in one place, `src/lib/media.js`:

| | Games | Movies | TV Series |
|---|---|---|---|
| Categories | Gameplay, Music, Feel, Art, Story | Story, Acting, Music, Visuals, Pacing | Story, Acting, Music, Visuals, Pacing, Consistency |
| Genres | Horror, Shooter, Puzzle, Reading, Tabletop, Action, Adventure, Simulation, Tower Defense, Roguelike, War, Mystery, Management | Horror, Comedy, Drama, Action, Adventure, Thriller, Sci-Fi, Fantasy, Documentary, Romance, Mystery, War, Crime | Horror, Comedy, Drama, Action, Adventure, Thriller, Sci-Fi, Fantasy, Documentary, Mystery, War, Crime, Family, Reality, Western |
| Second tag | Players: Singleplayer / Multiplayer | Format: Live action / Animated | Format: Live action / Animated |
| Time field | Hours played | Runtime | Watch time |
| Date field | First played | First watched | First watched |
| Played on | PC, PlayStation, Xbox, Nintendo, Mobile | — | — |
| Catalog | IGDB | TMDB (`/movie`) | TMDB (`/tv`) |

Adding a fourth library is a matter of adding an entry to that array — plus a
row per award category in `award_category_defaults` (see `supabase/awards.sql`)
if it should run a season of its own.

**Series carry their own catalog identity.** TMDB numbers films and shows in
separate namespaces — movie `1396` and series `1396` are unrelated — so series
reviews are tagged `provider: 'tmdb_tv'`, not `'tmdb'`. Community reviews and
trophies join on `(provider, provider_id)` alone, and sharing the tag would
hang one medium's awards on the other's poster.

### Catalog credentials

IGDB and TMDB both want a key, and asking every person who installs the app to
register a Twitch developer application — two-factor and all — was the single
worst thing about setting it up. So the keys don't ship in the installer and
they aren't the user's problem: they sit as Supabase secrets behind an Edge
Function in `supabase/functions/catalog`, which the app calls with the anon key
it already carries. Supabase's own JWT check on the function is what keeps it
from being an open proxy, and TMDB paths are allowlisted so it can only ever
serve this app's four endpoints.

`electron/catalog.js` still knows how to talk to both providers directly, and
prefers to whenever Settings has credentials in it — one shared quota across
every install is fine for a small group but is the obvious thing to outgrow, so
the escape hatch stays. `missing()` is what encodes the difference: it reports
no gaps while the proxy is configured, which is what makes the fields in
Settings read as optional rather than as a wall in front of search.

Rotating a key is `supabase secrets set` and nothing else — no release, no
reinstall. The deploy walkthrough is in `supabase/functions/catalog/README.md`.

### Screens

A strip across the top carries the library title, the **Board / Stats /
Compare / Awards** switcher (← / → move between them) and the save state +
`Add` button.

**Board** — items in ranked order. Each cell shows the main image with its
position (`1st`, `2nd`, …) in the top-left corner, and a circular overall-score
badge plus its genres below. Drag any cell to re-rank; a plain click opens the
detail view. Right-click for **Open**, **Compare with…** and **Delete**.

Under the strip sits the **filter bar**: search, sort, genre/tag filters and
image export.

- **Search** matches titles *and* note text, so "the one with the fishing
  minigame" is findable.
- **Filters** narrow by genre and by Players/Format. Multiple tags are ANDed.
- **Played on** (games only) narrows to one console or several. Several are
  ORed, not ANDed — "PS2 or PC", not the handful you owned on both. The board
  renumbers whatever it shows, so filtering to PS2 *is* your PS2 ranking, in
  the order you already put those games in. There is no separate per-console
  order to maintain, and nothing to disagree with your main one.
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

**Awards** — see below.

### The awards

Once a year, everyone with an account picks the best of what they played. Each
library runs its own season with its own categories; all three share one timeline.

**Two rounds.** Round one is open — put forward one pick per category from your
own library. Round two votes on the top five that came out of it. One round
would let three people decide Game of the Year between them; two rounds make
the shortlist mean something and give the tab a reason to be opened twice.

**Two winners per category.** *Community Choice* is what people voted for.
*Critics' Choice* is what the scores already said — the highest average in that
category across everyone who logged the thing, no ballot involved. They are
often not the same game, and the computed half still works in a year when only
four people turn up.

**What is eligible** depends on the category:

| Basis | Means |
|---|---|
| `release_year` | Came out this year — Game of the Year, Movie of the Year, Series of the Year (a series is filed under the year it *premiered*, so a long run is only eligible once; Best Ongoing Series covers the rest) |
| `first_played_year` | You logged a first-played date this year, whatever its age |
| `library` | Anything you own — Best Ongoing, Best Rewatch, pure opinion |

Beyond that, one rule covers everything: **you may only put forward something
in your own library, that you have scored, that came from the catalog.** A
hand-imported photo has no shared identity to join one person's copy to
another's, so it cannot be nominated — the picker leaves it out and says why.

**Timeline**, in Europe/Berlin wall-clock time so December 1st is one instant
worldwide rather than whatever midnight means where you happen to be. Tight on
purpose — one day to nominate, one day to vote, results the same night:

```
Dec 1   00:00   nominations open (also the release-eligibility cutoff)
Dec 2   00:00   nominations close · shortlist locks · voting opens
Dec 3   00:00   voting closes
Dec 3   20:00   the ceremony, that night
```

**The tally is secret.** There is no query that returns a count before the
reveal — not for other users, not for whoever runs the database. You can read
your own ballot and nothing else. After the reveal, everything unseals at once,
including who picked what.

**Nothing is scheduled and nobody presses a button.** The shortlist and the
winners are computed by the first client to ask for them after the relevant
deadline, and stored. The reveal is a timestamp on the season row, so it
happens whether or not anyone is awake for it — and no person types a winner
in, which is the only reason anyone should believe the results. Categories
unlock one at a time from that instant, which is the ceremony.

**Ties** break on the community's average score, then on who nominated first,
then on catalog id. There is always exactly one winner.

**Trophies.** A win is stamped on the *game*, not on one person's copy of it,
so everyone who owns it sees the same mark on their own board — gold for the
voted award, grey for the computed one. Losing nominees get nothing; the
shortlist is visible during the ceremony and nowhere else. Wins accumulate
across years, and the list is cached on disk so an offline launch still shows
them. Out of season the tab is a **Hall of Fame** of every finished year.

**Setting it up.** Run `supabase/awards.sql` once in the Supabase SQL editor.
It is idempotent, adds the columns the awards need to `reviews`, and creates
the season from `award_category_defaults` the first time anyone opens the tab
in a new year — so there is no yearly chore and no release needed to change a
category or move a date. Both are rows you edit in the dashboard.

Everything above is enforced by Row Level Security and `SECURITY DEFINER`
functions, never by this app. The anon key ships inside the installer, so
anyone can query the database directly with whatever the policies allow; a rule
that lived in the renderer would not be a rule. `award_ballots` has RLS on and
no write policy at all, which denies everyone — the only way in is
`cast_ballot()`, which re-checks every condition before it writes.

### Keyboard

Press `?` anywhere for the full list.

| | |
|---|---|
| `Ctrl+F` or `/` | jump to search |
| `Alt+1` / `Alt+2` / `Alt+3` | switch library |
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

### Supporters

**Buy me a coffee**, in Settings and in Account, opens a Buy Me a Coffee page in
the real browser. Anyone who donates gets a **gold ring** on their avatar and a
small cup beside their name, wherever other people see them — friends lists,
search results, community reviews, and their profile. That is the entire
reward. No feature, no ranking weight, no extra visibility, and nothing behind
a paywall, which is the difference between a donation and a purchase.

**Why it is not a column on `profiles`.** The anon key ships inside the
installer, so "update your own profile" would mean "gild your own profile" the
first time somebody unpacked it. The flag lives in `public.supporters`, a table
with row level security on and *no policies at all* — which denies every role
the app can reach. The only writer is a Buy Me a Coffee webhook running as
`service_role`, a key that lives in Supabase's own environment.

The table is keyed by donor **email**, since a donation happens somewhere
nobody has a Game Ranker account id. That email never leaves the database:
`supporter_ids()` joins it to `auth.users` internally and hands back nothing
but a subset of the ids the caller already had, capped at 200 an call so it
cannot be turned into "list everyone who has ever donated".

**Setting it up.** Run `supabase/supporters.sql` once in the SQL editor, then
follow `supabase/functions/bmc-webhook/README.md` — register the page, deploy
the function with `--no-verify-jwt`, and store the signing secret. Until the
page URL is filled into `src/lib/support.js`, the button does not render at
all.

**When the email does not match.** The ring is matched on the address someone
paid with, so paying with a different address than they signed in with — or
donating anonymously — grants nothing. Both land in the function logs, and
`select public.grant_support('them@example.com')` fixes it by hand. There is
deliberately no in-app claim box: anyone who guessed a donor's address could
take their badge.

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
data.json          the libraries and settings (incl. the cached trophy list)
data.backup.json   previous revision, rewritten on each save
auth.json          the cloud session, with its own write queue
images/            imported images, copied in and renamed to a UUID
```

Items gained `releaseYear` and `platforms` with the awards; both load as
`null`/`[]` on files written by older builds. Because Game of the Year is
decided on `releaseYear`, the first launch after upgrading quietly backfills it
for anything with a catalog id — one batched query per 200 games on IGDB, one
request per film on TMDB. It runs once per library per session and failing
just leaves the years missing for next time.

Which console you played something on stays on this machine. `firstPlayed` no
longer does: awards eligibility is decided on it, so it has to be the same date
on every device and on the server, and the newer edit wins like any other
synced field.

Imported files are copied into `images/` on import, so moving or deleting the
originals doesn't affect the app. The renderer reaches them through a custom
`gameimg://` protocol rather than raw filesystem paths, so `contextIsolation`
stays on and web security is never disabled.

The file is **version 2**:

```json
{ "version": 2, "libraries": { "games": [], "movies": [], "series": [] }, "settings": { "theme": "dark" } }
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
src/lib/collection.js  search, tag/platform filters, sort order
src/lib/awards.js      season phases, countdowns, the reveal clock, trophies
src/lib/stats.js       everything the Stats view charts, derived on the fly
src/lib/export-image.js  the ranking drawn to a PNG/JPEG canvas
src/components/        Sidebar, TopStrip, FilterBar, BoardView, StatsView,
                       CompareView, DetailView, AwardsView, ShortcutsOverlay,
                       TagChips, TrophyBadge, ContextMenu, ScoreSlider,
                       ScoreBadge
electron/supabase.js   accounts, profiles, review sync
electron/auth-storage.js  where the desktop keeps its sign-in session
src/web/api.js         window.api for the website (IndexedDB, browser files)
src/mobile.css         the phone layout
vite.web.config.mjs    the website build, its Node shims and service worker
electron/awards.js     the awards RPCs - functions only, never tables
supabase/awards.sql    the awards schema, policies and functions
supabase/supporters.sql  who has bought a coffee, and why it cannot be a
                       column on profiles
scripts/make-icon.js   generates build/icon.ico with no image dependencies
```
