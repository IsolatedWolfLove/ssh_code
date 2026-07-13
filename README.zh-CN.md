# SSH Studio

语言：[English](README.md) | 中文

SSH Studio 是一个桌面端 SSH 远程工作区工具，用来把终端、SFTP 客户端和编辑器合到一个窗口里。它基于 Electron 构建，集成 SSH 连接历史、SFTP 文件树、Monaco 远程编辑、工作区搜索、内置终端、SSH 隧道，以及可选的远程画面观察能力。

## 功能亮点

- 支持密码、私钥、SSH Agent 和 Tailscale SSH 登录。
- 本机安装 `tailscale` CLI 时，可以读取并选择 Tailscale 主机。
- 可使用 `known_hosts` 文件校验主机，也可在可信实验环境中关闭校验。
- 保存最近连接，支持重命名，并记住远程工作区路径。
- 通过 SFTP 浏览远程目录，也可以把任意远程目录打开为当前工作区。
- 支持创建、重命名、删除、上传和下载远程文件或文件夹。
- Monaco 多标签远程编辑，支持语言识别、未保存状态、手动保存和自动保存。
- 工作区或远端 PATH 安装语言服务器后，支持 TypeScript/JavaScript 补全、Hover、诊断和跳转定义。
- 保存远程文件时使用临时文件写入，再远程重命名或替代写入，降低中断风险。
- 工作区搜索会优先使用远程 `rg`，不可用时自动退回 SFTP 扫描。
- 内置 xterm.js 终端，支持多个终端标签和终端分屏。
- 终端工作目录会跟随当前工作区同步。
- 本地保存快速命令，并可在新的工作区终端中运行。
- 在已保存连接中管理本地、远程和动态 SSH 隧道。
- Vision Mode 可启动远程虚拟显示，并在独立视频窗口中观察画面。

## 使用流程

1. 从已保存连接、Tailscale 主机或手动 SSH 表单开始连接。
2. 从记住的路径中选择远程工作区，或打开另一个远程文件夹。
3. 在同一窗口里编辑文件、运行终端、搜索工作区、传输文件和管理隧道。
4. 远程连接意外断开时，可以从保存的会话快速重连。

## 环境要求

- 开发环境需要 Node.js 和 npm。
- 目标机器需要可以通过 SSH/SFTP 访问。
- 可选：本机安装 `tailscale` CLI，用于 Tailscale 主机发现。
- 可选：远程机器安装 `rg`，用于更快的工作区搜索。
- 可选：远程工作区安装 `typescript-language-server` 和 `typescript`，用于 TypeScript/JavaScript 语言智能。
- 可选：远程机器安装支持 X11 捕获的 `Xvfb` 和 `ffmpeg`，用于 Vision Mode。
- 构建全部远端 server 平台产物时需要 Go 1.20 或更高版本。

## 开发

```bash
npm install
npm run dev
```

开发时使用 `npm run server:build` 构建本机 Linux server 产物。发布打包会通过 `npm run server:build:all` 构建 Linux 和 macOS 的 x64/arm64 产物。server 使用 SSH 的 stdio 通道通信，不会在远端开放 TCP 端口。

## 质量检查

```bash
npm run typecheck
npm test
npm run build
```

## 打包

```bash
npm run package
npm run package:deb
npm run package:win
```

构建产物会输出到 `release/`。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl/Cmd+S` | 保存当前编辑器标签 |
| `Ctrl/Cmd+Shift+F` | 打开全局工作区搜索 |
| `Ctrl/Cmd+Shift+P` | 打开快速命令 |
| `Ctrl/Cmd+Shift+T` | 打开 SSH 隧道 |
| 搜索框中按 `Enter` | 执行搜索 |
| 快速命令表单中按 `Ctrl/Cmd+Enter` | 添加快速命令 |
| 弹窗中按 `Escape` | 关闭当前弹窗 |

## 数据与安全

成功连接过的 SSH 配置会保存在 Electron 的用户数据目录中。密码和私钥口令会在平台支持时使用 Electron `safeStorage` 加密；如果平台不支持，会使用 base64 兼容回退，这不等同于加密。快速命令保存在渲染进程的 `localStorage` 中。

主机校验可以使用 `known_hosts` 文件。关闭主机校验适合一次性开发环境，但会移除 SSH 主机身份检查。

## 搜索行为

SSH Studio 会优先尝试在远程主机上运行 `rg`，以获得更快的 JSON 搜索结果。如果远程主机没有安装 ripgrep，或版本不支持所需输出，应用会自动改用 SFTP 扫描文件。为了保持界面响应，搜索结果数量会被限制。

## 项目结构

```text
src/main/        Electron 主进程、SSH 会话、SFTP、隧道、打包相关逻辑
src/preload/     安全的渲染进程到主进程 API 桥接
src/renderer/    React UI、Monaco 编辑器、终端面板、弹窗
src/shared/      主进程、preload 和渲染进程共享的 IPC 契约
build/           安装器资源
release/         生成的安装包和解包构建产物
```

## 技术栈

- Electron 和 electron-vite
- React 19 和 TypeScript
- Monaco Editor
- xterm.js
- `ssh2`
- `react-resizable-panels`
- lucide-react
