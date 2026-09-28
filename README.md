# SSH Studio

Language: English | [中文](README.zh-CN.md)

SSH Studio is a desktop SSH workspace for working on remote machines without bouncing between a terminal, SFTP client, and editor. It combines SSH connection history, an SFTP file explorer, Monaco-based remote editing, workspace search, integrated terminals, SSH tunnels, and optional remote screen observation in a Go/Wails desktop app.

## Highlights

- Connect with password, private key, SSH agent, or Tailscale SSH.
- Browse Tailscale hosts when the local `tailscale` CLI is available.
- Verify hosts with a `known_hosts` file, or disable verification for trusted lab environments.
- Save recent connections with editable names and remembered remote workspaces.
- Browse remote folders over SFTP, then open any folder as the active workspace.
- Create, rename, delete, upload, and download remote files or folders.
- Transfer large files with a live progress bar (percent, throughput, ETA), a cancel button, and automatic byte-level resume: an interrupted upload or download picks up from where it stopped instead of restarting, using a temporary `.sshstudio-part` file that is swapped into place only once complete.
- Edit remote files in Monaco with tabs, language detection, dirty-state markers, manual save, and autosave.
- Use remote TypeScript/JavaScript completion, hover, diagnostics, and go-to-definition when a language server is installed in the workspace or remote PATH.
- Save files through a temporary-file write plus remote rename/fallback replacement path.
- Search the workspace with remote `rg` when available, then fall back to SFTP scanning.
- Run multiple xterm.js terminals, including tabs and split terminal views.
- Keep long jobs alive across disconnects by running terminals inside remote tmux (or screen) sessions, and re-attach to sessions that are still running.
- Watch remote host resources in the status bar: per-GPU utilization, memory, temperature and power, which processes own each GPU, plus load average, RAM and free space on the workspace filesystem.
- Preview remote images (result plots, sample frames) in a zoomable tab, with optional auto refresh to follow output as a job writes it.
- Keep terminal working directories aligned with the current workspace.
- Store quick commands locally and launch them in a fresh workspace terminal.
- Manage local, remote, and dynamic SSH tunnels from saved connections.
- Use Vision Mode to start a remote virtual display and observe it through a video panel.

## Workflow

1. Start from a saved connection, a Tailscale host, or a manual SSH form.
2. Pick a remote workspace from the remembered paths or open another folder.
3. Edit files, run terminals, search the workspace, transfer files, and manage tunnels from the same window.
4. Reconnect to saved sessions when the remote connection drops unexpectedly.

## Requirements

- Node.js and npm for development.
- A remote host reachable by SSH/SFTP.
- Optional local `tailscale` CLI for Tailscale host discovery.
- Optional remote `rg` for faster workspace search.
- Optional remote `tmux` (or `screen`) so terminals survive a dropped connection.
- Optional remote `nvidia-smi` for GPU metrics; CPU, memory and disk are read from `/proc` and `df`.
- Optional remote `typescript-language-server` and `typescript` for TypeScript/JavaScript language intelligence.
- Optional remote `Xvfb` and `ffmpeg` with X11 capture support for Vision Mode.
- Go 1.26.6+ for the desktop backend. Linux builds need `libgtk-3-dev` and `libwebkit2gtk-4.1-dev`; Windows uses WebView2; macOS needs Xcode command line tools.

## Development

```bash
npm install
npm run dev
```

`npm run dev` starts Wails; `npm run build` creates `server/build/bin/ssh-studio` (`.exe` on Windows, `.app` on macOS). Scripts run a pinned Wails CLI without a separate installation. Set `GO=/path/to/go` to select Go. React/TypeScript remains the frontend; SSH and the desktop backend run in Go. Legacy Electron code is retained for regression comparison via `dev:electron` / `build:electron`; default builds and releases use Wails.

## Quality Checks

```bash
npm run typecheck
npm test
npm run server:test
npm run build
```

## Packaging

```bash
npm run package
npm run package:deb
npm run package:mac
npm run package:win
```

Installers are written to `release/`. Package on the target OS: Linux creates deb, macOS creates dmg/zip, and Windows creates an NSIS installer.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+S` | Save the active editor tab |
| `Ctrl/Cmd+Shift+F` | Open global workspace search |
| `Ctrl/Cmd+Shift+P` | Open quick commands |
| `Ctrl/Cmd+Shift+T` | Open SSH tunnels |
| `Enter` in search | Run search |
| `Ctrl/Cmd+Enter` in quick command form | Add quick command |
| `Escape` in dialogs | Close the active dialog |

## Data and Security

Connections are stored under `ssh-studio` in the system configuration directory. Passwords and passphrases use AES-GCM with a local `store.key` (Unix mode 0600). First launch attempts to import legacy Electron connections; passwords encrypted by Electron `safeStorage` must be entered again. Quick commands remain in renderer `localStorage`; legacy Electron renderer preferences are not automatically migrated.

Host verification can use a `known_hosts` file. Turning host verification off is useful for disposable development hosts, but it removes SSH host identity checks.

## Search Behavior

SSH Studio first tries to run `rg` on the remote host for fast JSON search output. If ripgrep is unavailable or does not support the required output, the app scans files over SFTP instead. Result counts are capped to keep the UI responsive.

## Project Layout

```text
server/app/       Wails API and connection lifecycle
server/internal/  Go SSH, filesystem, tunnels, terminal, LSP and media modules
server/main.go    Native desktop entry point
src/renderer/     React UI, Monaco, xterm.js and Wails bridge
src/shared/       TypeScript API contracts
src/main/         Legacy Electron implementation and regression tests
scripts/          Native build and packaging commands
release/          Generated installers
```

## Tech Stack

- Go and Wails v2
- React 19 and TypeScript
- Monaco Editor
- xterm.js
- `golang.org/x/crypto/ssh` and `github.com/pkg/sftp`
- `react-resizable-panels`
- lucide-react
