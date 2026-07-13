# SSH Studio

Language: English | [中文](README.zh-CN.md)

SSH Studio is a desktop SSH workspace for working on remote machines without bouncing between a terminal, SFTP client, and editor. It combines SSH connection history, an SFTP file explorer, Monaco-based remote editing, workspace search, integrated terminals, SSH tunnels, and optional remote screen observation in one Electron app.

## Highlights

- Connect with password, private key, SSH agent, or Tailscale SSH.
- Browse Tailscale hosts when the local `tailscale` CLI is available.
- Verify hosts with a `known_hosts` file, or disable verification for trusted lab environments.
- Save recent connections with editable names and remembered remote workspaces.
- Browse remote folders over SFTP, then open any folder as the active workspace.
- Create, rename, delete, upload, and download remote files or folders.
- Edit remote files in Monaco with tabs, language detection, dirty-state markers, manual save, and autosave.
- Use remote TypeScript/JavaScript completion, hover, diagnostics, and go-to-definition when a language server is installed in the workspace or remote PATH.
- Save files through a temporary-file write plus remote rename/fallback replacement path.
- Search the workspace with remote `rg` when available, then fall back to SFTP scanning.
- Run multiple xterm.js terminals, including tabs and split terminal views.
- Keep terminal working directories aligned with the current workspace.
- Store quick commands locally and launch them in a fresh workspace terminal.
- Manage local, remote, and dynamic SSH tunnels from saved connections.
- Use Vision Mode to start a remote virtual display and observe it through a separate video window.

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
- Optional remote `typescript-language-server` and `typescript` for TypeScript/JavaScript language intelligence.
- Optional remote `Xvfb` and `ffmpeg` with X11 capture support for Vision Mode.
- Go 1.20+ for building all remote server platform assets.

## Development

```bash
npm install
npm run dev
```

Build the local Linux server asset during development with `npm run server:build`. Release packaging builds the Linux and macOS x64/arm64 assets with `npm run server:build:all`. The server uses the SSH stdio channel and does not open a remote TCP port.

## Quality Checks

```bash
npm run typecheck
npm test
npm run build
```

## Packaging

```bash
npm run package
npm run package:deb
npm run package:win
```

Build artifacts are written to `release/`.

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

Successful SSH connections are stored in the Electron user data directory. Passwords and private-key passphrases are encrypted with Electron `safeStorage` when the platform supports it; otherwise SSH Studio stores a base64 compatibility fallback, which is not equivalent to encryption. Quick commands are stored in renderer `localStorage`.

Host verification can use a `known_hosts` file. Turning host verification off is useful for disposable development hosts, but it removes SSH host identity checks.

## Search Behavior

SSH Studio first tries to run `rg` on the remote host for fast JSON search output. If ripgrep is unavailable or does not support the required output, the app scans files over SFTP instead. Result counts are capped to keep the UI responsive.

## Project Layout

```text
src/main/        Electron main process, SSH sessions, SFTP, tunnels, packaging hooks
src/preload/     Safe renderer-to-main API bridge
src/renderer/    React UI, Monaco editor, terminal panels, dialogs
src/shared/      IPC contracts shared by main, preload, and renderer
build/           Installer resources
release/         Generated packages and unpacked builds
```

## Tech Stack

- Electron and electron-vite
- React 19 and TypeScript
- Monaco Editor
- xterm.js
- `ssh2`
- `react-resizable-panels`
- lucide-react
