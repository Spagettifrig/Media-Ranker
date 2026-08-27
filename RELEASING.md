# Releasing a new version

## One-time setup (per machine)

1. **Install Node.js** (the app expects v24.x). Run the installer with defaults:
   ```powershell
   Start-Process "C:\Users\Josh\Documents\Game ranking app\node-v24.19.0-x64.msi" -Wait
   ```
   Close and reopen PowerShell, then confirm: `node -v; npm -v`

2. **Store your GitHub token** (Personal Access Token with `repo` scope), so
   `electron-builder` can upload releases without you pasting it each time:
   ```powershell
   [Environment]::SetEnvironmentVariable('GH_TOKEN', 'ghp_your_token', 'User')
   ```
   Reopen PowerShell so it takes effect. Rotate this token if it ever leaks.

## Every release

The steps don't change — only the version number and commit message.

1. **Bump `version` in `package.json`** following semver:
   - `1.5.0 -> 1.5.1` for bug fixes
   - `1.5.0 -> 1.6.0` for new features

2. **Commit and push:**
   ```powershell
   cd "C:\Users\Josh\Documents\game-ranker"
   git add -A
   git commit -m "Describe what changed"
   git push
   ```

3. **Build and publish:**
   ```powershell
   npm run release
   ```
   Runs: make icon -> vite build -> `npm run tag` -> `electron-builder --win nsis
   --publish always`.
   Output: `release\Game-Ranker-Setup-<version>.exe` (+ `latest.yml`), published
   to the GitHub releases of `Spagettifrig/Media-Ranker`.

   `npm run tag` creates and pushes `v<version>` before the upload. That tag is
   load-bearing - see "Why the tag matters" below. It refuses to run on a dirty
   working tree, or when the tag already exists somewhere other than `HEAD`
   (which means you forgot to bump the version).

4. **Verify** at https://github.com/Spagettifrig/Media-Ranker/releases that the
   release is **not a draft** and has the `.exe`, `.exe.blockmap` and
   `latest.yml` attached. `latest.yml` is what installed apps read to detect the
   update. A quick check that it is really live:
   ```powershell
   (New-Object System.Net.WebClient).DownloadString("https://github.com/Spagettifrig/Media-Ranker/releases/latest/download/latest.yml")
   ```
   It should print the version you just shipped.

## Why the tag matters

GitHub rejects an already-published release unless a matching tag exists, so
this project used to publish **drafts** instead. That cost us twice:

- **Drafts are invisible to the updater.** v1.2.1, v1.4.0 and v1.5.0 were all
  cut and then left sitting as unpublished drafts. Every installed copy stayed
  pinned to v1.2.0 for months and nothing failed loudly.
- **Drafts have no tag, so GitHub cannot deduplicate them.** electron-builder
  runs its publisher twice; with drafts, both calls saw "release doesn't exist"
  and each made its own, splitting the installer and `latest.yml` across two
  half-releases.

Tagging first fixes both. Do not remove `releaseType: "release"` from the
`build.publish` block in `package.json` without putting the tagging step back.

## How users receive it

- Each installed app calls `autoUpdater.checkForUpdates()` on launch and every 4h.
- `autoDownload` is on: a newer version downloads silently in the background.
- If the app is open when the download finishes, an in-app "Restart & update"
  toast appears. Otherwise `autoInstallOnAppQuit` applies it on next quit+reopen.
- Auto-update only runs in packaged builds, never in `npm run dev`.

## Troubleshooting

- **`'npm' is not recognized`** inside the release script: Node isn't on PATH.
  Do the one-time Node install above (a bare `node.exe` sitting in a folder is
  not enough — the scripts call `npm`/`node` by name).
- **`GitHub Personal Access Token is not set`**: `GH_TOKEN` missing from the
  environment. Set it as shown above and reopen the shell.
- **Release uploaded but users don't update**: check `latest.yml` is attached to
  the GitHub release and the version in it is higher than what they have. Then
  check the release is **published, not a draft** - the updater cannot see
  drafts, and this is what silently stranded everyone on v1.2.0.

- **`Working tree has uncommitted changes`** from `npm run tag`: commit or stash
  first. A release must be reproducible from the tag, and tagging a dirty tree
  would make the tag point at code that was never built.

- **`Tag vX.Y.Z already exists but points at ...`**: you did not bump `version`
  in `package.json`, so the release script tried to re-tag a version that has
  already shipped. Bump it and re-run.

- **Two releases appear for one version**: only possible if the tagging step was
  skipped - see "Why the tag matters". Keep the one holding `latest.yml`, move
  any other assets onto it, and delete the empty one.

- **Anyone still on v1.0**: that build predates the auto-updater entirely (it
  arrived in v1.2.0), so it will never update itself no matter what is
  published. Send those users the `.exe` directly; they auto-update from then on.
