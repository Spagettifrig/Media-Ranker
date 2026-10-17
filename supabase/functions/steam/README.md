# Enable shared Steam imports

The desktop code alone cannot supply Steam's API credential. The key must remain
on the server, not in `supabase-config.js`, a Vite variable, Git or an installer.

1. Obtain a Steam Web API key from https://steamcommunity.com/dev/apikey and review
   Valve's API terms for your application: https://steamcommunity.com/dev/apiterms.
2. In the Supabase dashboard for this app's project, add an Edge Function secret
   named `STEAM_WEB_API_KEY` with the key as its value. Do not paste the key into
   chat or commit it to the repository.
3. Deploy from the repository root with your authenticated Supabase CLI:

   ```sh
   supabase functions deploy steam --project-ref njxypnkamladkjtxging
   ```

   Keep JWT verification enabled. No database migration is needed. This function
   follows the existing catalog proxy's public anon-JWT convention. An anon key is
   not private authorization: add persistent gateway rate limits/abuse monitoring
   before a large public rollout. The included per-instance throttle is only
   best-effort, resets on cold starts and must not be treated as a global quota.
4. Restart the development app (main-process/preload changes require a restart).
   Go to Games → Import Steam. Test a public library without the advanced key.

The shared path calls only ResolveVanityURL and GetOwnedGames on Steam's public
API. It does not log in to Steam, bypass profile privacy or request a password.
Users must make their profile and Game details public; playtime can remain hidden.
Unknown/private libraries produce an actionable error, while a genuinely empty
library produces an empty preview. Free titles are included when played; shared
libraries and every entitlement are not guaranteed by this API.

For a local test without deployment, enter your own key under the import dialog's
Advanced option. It is sent to the Electron main process, then directly to Steam,
and is not stored in settings. The shared server key never reaches the renderer.

Catalog matching uses the existing `catalog` function and IGDB `games` endpoint,
so no change to the deployed catalog proxy is necessary. Unmatched entries stay
local even after rating because they have no verified community catalog identity.

## Checks

```sh
npm test
npm run build
npm run test:steam-ui
```

Unit tests mock network responses; the UI smoke test uses a hidden, isolated
Electron window with fixture data and blocked external network access. Neither
requires a key or modifies the real user library. A real Steam import still needs
a configured key and a consenting public test profile.
