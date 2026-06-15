# SSH Studio

Linux desktop SSH client MVP built with Electron, React, TypeScript, Monaco Editor, xterm.js, and `ssh2`.

## Features

- Password-based SSH connection
- SFTP file tree rooted at remote `$HOME`
- Multi-tab remote file editing with Monaco
- Atomic remote save using temporary file + rename
- Integrated interactive terminal via `ssh2.shell()`

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run package
```
