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
   Runs: make icon -> vite build -> `electron-builder --win nsis --publish always`.
   Output: `release\Game-Ranker-Setup-<version>.exe` (+ `latest.yml`), uploaded to
   the GitHub releases of `Spagettifrig/Media-Ranker`.

4. **Verify** at https://github.com/Spagettifrig/Media-Ranker/releases that the
   release has both the `.exe` and `latest.yml` attached. `latest.yml` is what
   installed apps read to detect the update.

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
  the GitHub release and the version in it is higher than what they have.
