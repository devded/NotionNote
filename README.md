# Monolog

A small, fast, offline-capable desktop note-taking app backed by **Notion**.
Built with **Tauri 2 + React + TypeScript + Tailwind CSS + shadcn/ui**.

Notes are saved locally first (instant), then synchronized to a Notion
database named `random_notes_desktop` in the background. Works fully offline;
everything syncs automatically when connectivity returns.

```
┌───────────────────────────────────────────────────────┐
│ NOTES          ✓ Synced just now     + New Note   ⚙   │
├────────────────┬──────────────────────────────────────┤
│ 🔍 Search      │  Meeting Notes                       │
│                │  Updated today                       │
│ Today          │                                      │
│   Meeting      │  Today we discussed the project…     │
│   Project      │                                      │
│ Yesterday      │                                      │
│   Research     │                        ✓ Synced      │
└────────────────┴──────────────────────────────────────┘
```

## Features

- Create / edit / delete notes (delete archives the page in Notion)
- Instant local persistence — typing is never blocked by the network
- Background sync to Notion with per-note status (`✓ Synced`, `⚠ Saved locally`, `↻ Syncing`, `✕ Sync failed`)
- Offline mode with automatic catch-up sync when back online
- Local search over titles and content (no network involved)
- Light / Dark / System theme
- Keyboard shortcuts:
  - `Cmd/Ctrl + N` — new note
  - `Cmd/Ctrl + S` — flush save
  - `Cmd/Ctrl + F` — focus search
  - `Cmd/Ctrl + W` — close window
  - `Esc` — close dialogs
- Resizable sidebar, native window behaviour, minimal dependencies

## Creating a Release

Releases are fully automated via GitHub Actions (`.github/workflows/release.yml`).

```sh
git checkout main
git pull

git tag v0.1.0
git push origin v0.1.0
```

The tag **must match** `version` in `src-tauri/tauri.conf.json` — the release job
verifies this and fails otherwise.

Pushing a `v*` tag automatically builds in parallel and publishes to
**GitHub → Releases**:

```text
Linux   x86_64  → Monolog-linux-x86_64.AppImage, Monolog-linux-x86_64.deb
macOS   ARM64   → Monolog-macos-arm64.dmg
macOS   Intel   → Monolog-macos-x86_64.dmg
Windows x86_64  → Monolog-windows-x86_64.msi, Monolog-windows-x86_64.exe
```

If any platform build or artifact validation fails, no release is created.
CI (`.github/workflows/ci.yml`) runs typecheck, frontend build and Rust check
on every push and pull request.

### macOS Security Notice

The current macOS builds are unsigned and not notarized because
Apple Developer signing credentials are not currently configured.

macOS Gatekeeper may display a security warning when opening
the application for the first time.

Apple code signing and notarization can be added in a future release.

### Windows Security Notice

The current Windows builds are not code-signed.

Windows SmartScreen may display a warning when the application
is launched for the first time.

This is expected for the current unsigned release.

Code signing can be added in a future release.

## Requirements

- **Node.js** ≥ 20 and npm
- **Rust** (stable) via [rustup](https://rustup.rs)
- **Linux:** `webkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev librsvg2-dev patchelf`
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)

## Installation

```sh
npm install
```

## Development

```sh
npm run tauri dev
```

## Notion Setup

1. Go to <https://www.notion.so/profile/integrations> and create an **internal integration**.
2. Copy the API key (starts with `ntn_`). Keep it secret — see *Security* below.
3. In Notion, open (or create) a page that should contain your notes database,
   click **••• → Connections**, and connect your integration. Without this step
   the app cannot find a parent page and will explain what's missing.
4. Start the app. On first launch you'll see a connect screen:
   - Paste the **API key**
   - Leave **Database** as `random_notes_desktop`
   - Click **Connect**

The app then:

1. Verifies the key against the Notion API.
2. Searches your workspace for a data source named `random_notes_desktop`.
   - **Found** → reuses it (never creates a duplicate).
   - **Not found** → creates it automatically under an accessible page
     (prefers a page named "Notes"), with properties:
     | Property    | Type        |
     |-------------|-------------|
     | Title       | `title`     |
     | Content     | `rich_text` |
     | Created At  | `date`      |
     | Updated At  | `date`      |
3. Caches the database/data-source IDs locally so later launches skip discovery.
4. Loads your notes and opens the editor.

## Build

```sh
npm run tauri build
```

Artifacts:

- **Linux:** `src-tauri/target/release/bundle/`
  - `appimg/…AppImage` (recommended)
  - `deb/…deb`
- **macOS:** `src-tauri/target/release/bundle/macos/…app`
  and a `.dmg` in `bundle/dmg/`

> Cross-platform builds (macOS ARM64/Intel, Windows) are produced by the
> GitHub Actions release workflow; see *Creating a Release* above.

## Architecture

```
React UI (src/)            Tauri backend (src-tauri/)         Notion API
┌─────────────────┐        ┌──────────────────────┐
│ store/notes.tsx │ ─────▶ │ notion_request()     │ ───▶ api.notion.com
│ services/notion │ invoke │ (injects key from    │      (version
│ components/*    │        │  OS keychain)        │       2025-09-03)
└─────────────────┘        │ load/save notes.json │
                           │ load/save config.json│
                           └──────────────────────┘
```

- **All Notion requests happen in Rust.** The API key never enters the web
  view or the JS bundle. It is stored in the OS credential store
  (macOS Keychain / Linux Secret Service) with an optional `0600` file fallback.
- **Local-first:** every edit is written to `notes.json` in the app data dir
  within ~400 ms. Sync runs in the background and retries automatically.
- **Readable in Notion:** note content is written to the **page body** as real
  blocks — paragraphs plus light Markdown (`#`/`##`/`###` headings, `- `
  bullets, `1.` numbered items, `>` quotes). The `Content` property keeps only
  a short preview/fallback so older notes still open correctly.
- **Sync strategy:** local unsynced changes always win — remote edits never
  silently overwrite them. If both sides changed since the last sync the local
  version is kept and a warning is logged. Deletions made offline are queued
  and archived remotely once online.
- **Search is local-only**, so it works offline and costs zero network calls.

## Security

- The Notion API key is stored in the system keychain (Keychain / Secret
  Service) via the `keyring` crate, never in source code, config files that get
  committed, logs, or the frontend bundle.
- For development you can supply a key through the app's connect screen or
  Settings; if you use a `.env` file it is ignored by Git (see `.gitignore`).
- If you ever leak a key, **revoke it** at
  <https://www.notion.so/profile/integrations> immediately.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "No accessible parent page was found" | Share a page with your integration: page ••• menu → Connections → your integration. |
| Notes stopped syncing | Open Settings → **Test Connection**. |
| Wrong database being used | Settings → update database name → paste API key → **Reconnect**. |
| App shows stale data | Settings → **Clear Local Cache**, then restart. |
