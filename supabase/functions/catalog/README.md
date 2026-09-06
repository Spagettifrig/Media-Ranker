# Catalog proxy

Holds the IGDB and TMDB credentials so nobody installing Game Ranker has to
register a Twitch app of their own. The desktop app calls this function with
the Supabase anon key it already ships with; Supabase's own JWT check on the
function rejects anyone who doesn't have that key.

Nothing secret goes into the installer, and rotating a key is one command — no
new release, no reinstall.

## One-time setup

You need the Supabase CLI. On Windows the reliable way to reach it is `npx`,
which downloads it on first use and needs no install:

```bash
npx supabase@latest login
```

That opens a browser to sign in. Every `supabase` command below is written as
`npx supabase@latest` for the same reason — if you'd rather have it permanently,
`scoop install supabase` works too, and then you can drop the `npx` prefix.

### 1. Get the two sets of credentials — once, ever

**TMDB** — themoviedb.org → Settings → API → request a key, pick "Developer".
Copy the long **API Read Access Token**, not the shorter v3 key.

**Twitch/IGDB** — dev.twitch.tv/console (needs 2FA on the account) → Register
Your Application. OAuth Redirect URL `http://localhost`, category "Application
Integration". Copy the Client ID, then click "New Secret" and copy that too.

### 2. Store them as project secrets

```bash
npx supabase@latest secrets set --project-ref njxypnkamladkjtxging TWITCH_CLIENT_ID=xxx TWITCH_CLIENT_SECRET=xxx TMDB_TOKEN=xxx
```

### 3. Deploy

Run from the repo root:

```bash
npx supabase@latest functions deploy catalog --project-ref njxypnkamladkjtxging
```

That's it. Every existing install picks it up on the next search — the function
URL is derived from the Supabase config already baked into the app.

## Checking it works

```bash
curl -s -X POST "https://njxypnkamladkjtxging.supabase.co/functions/v1/catalog" -H "Authorization: Bearer YOUR_ANON_KEY" -H "Content-Type: application/json" -d "{\"provider\":\"tmdb\",\"path\":\"/search/movie\",\"params\":{\"query\":\"arrival\"}}"
```

The anon key is the one in `electron/supabase-config.js`. A JSON payload of
results means it's live; `{"error":"..."}` says what went wrong, and the full
detail is in the function logs in the Supabase dashboard.

## Rotating a key

```bash
npx supabase@latest secrets set --project-ref njxypnkamladkjtxging TMDB_TOKEN=new-token
```

Takes effect on the next cold start. No redeploy needed, and no user has to do
anything.

## If the shared quota gets busy

IGDB allows roughly 4 requests a second across everything using one client ID,
and every install now shares this one. That is plenty for a group of friends,
but if search starts erroring under load, anyone can paste their own
credentials into Settings → Online catalog and their copy of the app talks to
the provider directly, bypassing this function entirely.
