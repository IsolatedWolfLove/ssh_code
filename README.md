# SSH Studio

SSH Studio is a Linux desktop SSH workspace client built with Electron, React, TypeScript, Monaco Editor, xterm.js, and `ssh2`. It combines connection history, SFTP file management, remote code editing, workspace search, and interactive terminals in one focused app.

## Features

- SSH authentication with password, private key, or SSH agent.
- Optional host verification with a `known_hosts` file.
- Recent connection list with editable display names and remembered remote workspaces.
- SFTP workspace explorer rooted at the remote home directory by default.
- Open any remote folder as the current workspace.
- Create, rename, delete, upload, and download remote files or folders.
- Multi-tab Monaco editor with language detection, dirty-state indicators, manual save, and optional autosave.
- Safer remote writes using temporary-file save plus remote rename/fallback replacement.
- Global workspace search with case-sensitive mode, result previews, and jump-to-line opening.
- Integrated xterm.js terminal sessions over SSH.
- Multiple terminal tabs and split terminal views.
- Terminal working directory synchronization with the current workspace.
- Local quick commands that can be saved, deleted, and run in a new workspace terminal.
- Responsive UI font scaling for different window sizes.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+S` | Save the active editor tab |
| `Ctrl/Cmd+Shift+F` | Open global workspace search |
| `Ctrl/Cmd+Shift+P` | Open quick commands |
| `Enter` in search | Run search |
| `Ctrl/Cmd+Enter` in quick command form | Add quick command |
| `Escape` in dialogs | Close the active dialog |

## Search Notes

SSH Studio tries to use `rg` (ripgrep) on the remote host for fast searching. If remote ripgrep is not available or does not support the required JSON output, the app falls back to scanning files through SFTP. Search results are capped to keep the UI responsive.

## Saved Data

Successful connections are stored locally in the Electron user data directory. Passwords and private-key passphrases are protected with Electron `safeStorage` when encryption is available; otherwise they are base64-encoded as a compatibility fallback. Quick commands are stored in renderer `localStorage`.

## Development

```bash
npm install
npm run dev
```

## Quality Checks

```bash
npm run typecheck
npm run build
```

## Packaging

```bash
npm run package
npm run package:deb
```

Build artifacts are written to `release/`.

## Tech Stack

- Electron and electron-vite
- React 19 and TypeScript
- Monaco Editor
- xterm.js
- `ssh2`
- `react-resizable-panels`
- lucide-react

---

# SSH Studio 中文说明

SSH Studio 是一个面向 Linux 桌面的 SSH 远程工作区客户端，基于 Electron、React、TypeScript、Monaco Editor、xterm.js 和 `ssh2` 构建。它把连接历史、SFTP 文件管理、远程代码编辑、工作区搜索和交互式终端整合在一个专注的应用里。

## 功能特性

- 支持密码、私钥和 SSH Agent 三种登录方式。
- 可选使用 `known_hosts` 文件进行主机校验。
- 最近连接列表支持重命名，并记住每个连接最近打开过的远程工作区。
- SFTP 工作区文件树默认从远程用户家目录开始。
- 可以打开任意远程目录作为当前工作区。
- 支持创建、重命名、删除、上传和下载远程文件或文件夹。
- Monaco 多标签编辑器，支持语言识别、未保存状态提示、手动保存和可选自动保存。
- 保存远程文件时使用临时文件加重命名，并带有替代写入策略，降低写入中断风险。
- 全局工作区搜索支持大小写敏感、结果预览和点击跳转到对应行列。
- 集成基于 xterm.js 的 SSH 交互式终端。
- 支持多个终端标签和终端分屏。
- 终端会跟随当前工作区同步工作目录。
- 本地快速命令支持保存、删除，并可在新的工作区终端中运行。
- UI 字号会根据窗口大小自适应缩放。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl/Cmd+S` | 保存当前编辑器标签 |
| `Ctrl/Cmd+Shift+F` | 打开全局工作区搜索 |
| `Ctrl/Cmd+Shift+P` | 打开快速命令 |
| 搜索框中按 `Enter` | 执行搜索 |
| 快速命令表单中按 `Ctrl/Cmd+Enter` | 添加快速命令 |
| 弹窗中按 `Escape` | 关闭当前弹窗 |

## 搜索说明

SSH Studio 会优先尝试在远程主机上使用 `rg`（ripgrep）执行快速搜索。如果远程主机没有安装 ripgrep，或者版本不支持所需的 JSON 输出，应用会自动退回到通过 SFTP 扫描文件。为了保持界面响应，搜索结果数量会被限制。

## 本地保存的数据

成功连接过的 SSH 配置会保存在 Electron 的用户数据目录中。密码和私钥口令会在可用时使用 Electron `safeStorage` 加密保护；如果当前系统不支持加密，则会使用 base64 编码作为兼容方案。快速命令保存在渲染进程的 `localStorage` 中。

## 开发

```bash
npm install
npm run dev
```

## 质量检查

```bash
npm run typecheck
npm run build
```

## 打包

```bash
npm run package
npm run package:deb
```

构建产物会输出到 `release/`。

## 技术栈

- Electron 和 electron-vite
- React 19 和 TypeScript
- Monaco Editor
- xterm.js
- `ssh2`
- `react-resizable-panels`
- lucide-react
