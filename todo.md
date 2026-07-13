# SSH Studio Server 完整实施计划

> 本文是 `ssh-studio-server` 的产品、架构和工程实施清单。任务状态使用：`[ ]` 未开始、`[-]` 进行中、`[x]` 已完成、`[!]` 阻塞。

## 1. 项目目标

将 SSH Studio 从“主要依赖 SFTP 和远端 shell 命令的桌面客户端”升级为“桌面端 + 按需部署的远端能力层”。远端 server 负责靠近数据执行文件、搜索、任务、Git、LSP、端口、容器和系统信息操作，桌面端负责连接、安全授权、状态管理和 UI。

最终用户体验：

- 用户只需要有可用的 SSH 连接，不需要手工安装 `rg`、语言服务器或 SSH Studio 专用依赖。
- SSH Studio 自动识别远端平台，从应用安装包选择正确的 server，通过现有 SSH/SFTP 上传并启动。
- server 不修改远端项目依赖，不写入项目的 `package.json`，默认不使用 root，不开放 TCP 端口。
- 同一版本只部署一次；后续连接只进行版本、哈希和能力检查。
- server 不可用时，核心 SSH、SFTP 和终端能力仍可降级运行。

## 2. 已确定的架构决策

### 2.1 基础 server

- [ ] 使用 Go 实现单文件 `ssh-studio-server`，优先采用纯 Go 和静态构建，避免要求远端安装运行时。
- [ ] server 采用 session 模式启动：`ssh-studio-server session --stdio --workspace <path>`。
- [ ] 默认通过当前 SSH exec Channel 的 stdin/stdout 通信，不监听网络端口。
- [ ] stdout 只能输出协议帧；日志、崩溃信息和诊断只能写 stderr。
- [ ] 默认随 SSH 会话退出，不安装 systemd 服务，不加入开机启动。
- [ ] 需要断线继续运行的任务由独立 supervisor 模式管理，supervisor 仅监听当前用户目录下的 Unix Socket。
- [ ] Windows 远端支持不进入第一阶段；首批支持 Linux 和 macOS 远端。

### 2.2 部署方式

- [ ] server 二进制随 SSH Studio 桌面安装包发布。
- [ ] 桌面端通过 SFTP 上传二进制，不要求远端访问 GitHub、npm 或其他公网服务。
- [ ] server 安装目录固定为 `~/.cache/ssh-studio/server/<version>/<platform>/ssh-studio-server`。
- [ ] 上传过程使用临时文件、SHA-256 校验、`chmod 700` 和原子 rename。
- [ ] 同一主机上的并发窗口使用部署锁，避免重复上传和互相覆盖。
- [ ] 保留当前版本和上一个可用版本；新版本握手失败时自动回滚。
- [ ] 清理超过保留期限且不再使用的旧版本、临时文件和崩溃残留。

### 2.3 可选工具包

- [ ] 语言服务器、Node Runtime 等大体积内容不放入基础 server，使用版本化 Tool Pack。
- [ ] Tool Pack 路径为 `~/.cache/ssh-studio/packs/<pack-name>/<version-hash>/`。
- [ ] TypeScript Pack 包含 `typescript-language-server`、`typescript` 和必要依赖。
- [ ] 第一版 TypeScript Pack 允许依赖远端 `node`；第二版评估随 Pack 提供 Node Runtime。
- [ ] 只有用户打开对应语言的项目时才部署 Pack。
- [ ] 每个 Pack 必须包含 manifest、协议版本、文件哈希和支持平台信息。

### 2.4 兼容和降级

- [ ] server 部署失败时继续允许 SFTP 文件树、传统终端和现有隧道功能运行。
- [ ] 新功能必须通过 capability negotiation 判断是否可用，不使用版本字符串猜测能力。
- [ ] server 和桌面端协议至少支持一个小版本的前后兼容窗口。
- [ ] 协议不兼容时给出清晰错误和升级建议，不能静默失败。

## 3. 目标系统结构

```text
SSH Studio Desktop
├── Renderer
│   ├── Explorer / Editor / Terminal
│   ├── Problems / Tasks / Git / Ports
│   └── Server capability UI
├── Preload typed API
└── Electron Main
    ├── SSH connection manager
    ├── Server bootstrapper
    ├── Server RPC client
    ├── SFTP fallback
    └── Tool Pack manager
            │ SSH exec stdio
            ▼
ssh-studio-server
├── core/session
├── filesystem/watch
├── search/index
├── process/pty/task
├── ports
├── git/worktree
├── lsp/tool-packs
├── container
├── sync/transfer
└── system/diagnostics
```

建议新增仓库结构：

```text
server/
├── cmd/ssh-studio-server/
├── internal/protocol/
├── internal/session/
├── internal/filesystem/
├── internal/search/
├── internal/task/
├── internal/pty/
├── internal/ports/
├── internal/git/
├── internal/lsp/
├── internal/container/
├── internal/sync/
├── internal/system/
└── go.mod

src/main/server/
├── bootstrap.ts
├── platform-detection.ts
├── rpc-client.ts
├── session.ts
├── capabilities.ts
├── pack-manager.ts
└── fallback.ts

src/shared/server-contracts.ts
src/renderer/src/server/
```

## 4. 协议设计

### 4.1 传输与消息

- [ ] 使用 JSON-RPC 2.0 语义，请求包含稳定 request ID。
- [ ] stdio 使用 `Content-Length` 分帧，不能依赖换行分隔 JSON。
- [ ] 定义 request、response、notification、stream chunk 和 error 的统一 envelope。
- [ ] 支持 `$/cancelRequest`，长时间搜索、扫描、哈希和 Git 操作必须可取消。
- [ ] 流式事件必须包含 streamId、递增 seq、结束状态和可选总大小。
- [ ] 实现写入队列和 backpressure，防止日志或搜索结果耗尽内存。
- [ ] 单帧默认上限 8 MiB；大文件和大 Diff 使用分块流。
- [ ] 对未知 method 返回标准 `MethodNotFound`，不能导致进程退出。
- [ ] 所有业务错误使用稳定错误码，不让桌面端解析英文错误文本。

### 4.2 握手

- [ ] `system/hello` 请求携带桌面端版本、协议版本、connectionId 和 workspace 授权范围。
- [ ] server 返回 server 版本、协议版本、OS、架构、能力、限制和 instanceId。
- [ ] 协商最大消息大小、压缩、增量同步和可选功能。
- [ ] 桌面端保存本次 capability snapshot，UI 只展示真正可用的功能。
- [ ] 握手完成前禁止调用文件、任务、Git 和 LSP 方法。

### 4.3 基础方法

- [ ] `system/hello`
- [ ] `system/ping`
- [ ] `system/health`
- [ ] `system/capabilities`
- [ ] `system/shutdown`
- [ ] `system/logLevel`
- [ ] `system/diagnosticBundle`
- [ ] `$/cancelRequest`

### 4.4 事件规则

- [ ] 所有事件带 server instanceId，重连后丢弃旧实例事件。
- [ ] 文件、任务、端口、LSP、Git 事件分别使用独立 event type。
- [ ] 事件必须允许桌面端重新拉取完整 snapshot，不能只依赖增量事件恢复状态。
- [ ] 定义事件乱序、重复和断流后的恢复策略。

## 5. 阶段 0：设计冻结和技术验证

- [ ] 编写 ADR：为什么引入远端 server，以及不选择“本地 LSP + SFTP 虚拟文件系统”的原因。
- [ ] 编写 ADR：Go、Rust、Node SEA 三种实现的对比，确认 Go 方案。
- [ ] 确定协议版本规则，例如 `major.minor`。
- [ ] 确定支持矩阵：Linux x64、Linux arm64、macOS x64、macOS arm64。
- [ ] 验证 Linux 静态二进制在 Ubuntu、Debian、Alpine 和无 shell 完整环境中的兼容性。
- [ ] 验证现有密码、私钥、Agent、Tailscale SSH 和跳板机连接都能启动 stdio server。
- [ ] 建立威胁模型，覆盖伪造二进制、路径逃逸、恶意仓库、消息洪水和子进程泄漏。
- [ ] 明确 server MVP 和延后范围，避免首版同时实现所有模块。

验收标准：

- [ ] ADR、协议草案、支持矩阵和威胁模型通过评审。
- [ ] 一个最小 Go 程序可通过现有 SSH Channel 完成 hello/ping/shutdown。

## 6. 阶段 1：Server 骨架和构建系统

### 6.1 Go 工程

- [ ] 创建 `server/go.mod` 和入口程序。
- [ ] 实现 stdin/stdout 生命周期和 stderr 结构化日志。
- [ ] 实现优雅退出、信号处理和父 SSH Channel 关闭检测。
- [ ] 实现 panic recovery，输出可诊断错误后退出。
- [ ] 实现 session instanceId 和启动时间记录。
- [ ] 实现版本、commit hash、build time 注入。

### 6.2 构建产物

- [ ] 增加本地 `npm run server:build`。
- [ ] 增加 Linux x64/arm64 和 macOS x64/arm64 构建矩阵。
- [ ] 产出 `manifest.json`，包含文件名、平台、版本、大小和 SHA-256。
- [ ] 对 release manifest 和二进制生成签名。
- [ ] Electron 开发模式能找到本地构建产物。
- [ ] electron-builder 将 server 产物作为 `extraResources` 打进安装包。
- [ ] 安装包缺少目标平台产物时，在连接前给出明确提示。

### 6.3 CI

- [ ] Go format、vet、unit test 和 race test。
- [ ] TypeScript typecheck、Vitest 和 Electron build。
- [ ] 每个平台验证二进制可以运行 `--version` 和 `self-test`。
- [ ] release workflow 同时上传桌面安装包、server manifest 和校验文件。

验收标准：

- [ ] 四个平台产物可重复构建，manifest 中哈希与实际文件一致。
- [ ] SSH Studio 的开发版和打包版都能定位正确 server asset。

## 7. 阶段 2：远端探测、部署、升级与回滚

### 7.1 平台探测

- [ ] 通过最少 shell 命令检测 OS 和架构。
- [ ] 规范化 `x86_64/amd64`、`aarch64/arm64` 等别名。
- [ ] 检测远端 home 和可写 cache 目录。
- [ ] 识别 `noexec` 文件系统，并提供替代缓存位置。
- [ ] 检测可用磁盘空间。
- [ ] 缓存主机探测结果，但连接变化后允许重新探测。

### 7.2 部署

- [ ] 查询远端当前 server 的版本和哈希。
- [ ] 缓存命中时不上传二进制。
- [ ] 使用 SFTP 上传到唯一临时路径。
- [ ] 上传过程显示字节进度并支持取消。
- [ ] 远端计算 SHA-256；无法使用系统工具时由已有 server 或 Go bootstrap 验证。
- [ ] 校验失败立即删除临时文件。
- [ ] 设置目录 `0700`、二进制 `0700`。
- [ ] 原子切换到版本目录。
- [ ] 并发窗口使用 lock file 和过期锁恢复。
- [ ] 部署日志不得包含密码、私钥、Agent 信息或敏感环境变量。

### 7.3 启动和恢复

- [ ] 启动后在固定超时内完成 hello。
- [ ] hello 失败时收集 stderr 尾部作为诊断信息。
- [ ] 当前版本失败时尝试上一个已知可用版本。
- [ ] 两个版本都失败时进入无 server 降级模式。
- [ ] UI 显示 Installing、Starting、Ready、Degraded、Error 状态。
- [ ] 提供“重新安装远端组件”和“打开诊断”操作。

### 7.4 清理

- [ ] 删除超过保留数量的 server 版本。
- [ ] 清理超过 24 小时的 `.tmp` 文件和过期锁。
- [ ] 不删除正在运行实例对应的版本。
- [ ] 提供“从远端卸载 SSH Studio 组件”操作。

验收标准：

- [ ] 新主机首次连接自动完成上传和启动。
- [ ] 第二次连接不重复上传。
- [ ] 断网远端仍能通过桌面端上传完成部署。
- [ ] 损坏上传、磁盘满、无执行权限和协议不兼容都有可恢复错误。

## 8. 阶段 3：RPC Client 和 Electron 集成

- [ ] 在主进程实现单独的 `ServerRpcClient`，不要继续扩展巨型 `ssh-session.ts`。
- [ ] 每个 Electron 窗口拥有独立 server session 和事件订阅。
- [ ] 实现请求超时、取消、pending request 清理和 Channel 关闭处理。
- [ ] 实现 notification 路由和 stream registry。
- [ ] 实现主进程到 preload 的最小权限 API。
- [ ] renderer 不直接发送任意 RPC method，只能调用共享契约中允许的方法。
- [ ] 断线时拒绝所有 pending request，清理 marker、任务流和 watcher。
- [ ] 重连时重新握手并恢复可恢复模块。
- [ ] 提供 capability store 和 React hook。
- [ ] 状态栏展示 server 版本、状态和降级原因。
- [ ] 增加协议录制测试工具，但默认关闭且自动脱敏。

验收标准：

- [ ] 100 个并发请求可以正确匹配响应。
- [ ] 任意 chunk 边界、消息合并和拆分均能正确解析。
- [ ] 远端进程强制退出后 UI 不挂死、不泄漏 pending Promise。

## 9. 阶段 4：文件系统核心能力

### 9.1 文件元数据

- [ ] `fs/stat`：类型、大小、mtime、mode、uid、gid、revision。
- [ ] `fs/lstat`：不跟随符号链接。
- [ ] `fs/list`：分页或流式目录列表。
- [ ] `fs/tree`：受深度、数量和 ignore 规则限制的递归树。
- [ ] `fs/realpath`：解析真实路径并执行授权检查。
- [ ] `fs/hash`：SHA-256，可取消并返回进度。
- [ ] `fs/capabilities`：权限、文件监听和原子 rename 支持情况。

### 9.2 读取和写入

- [ ] `fs/read`：支持完整读取和 byte range。
- [ ] 检测二进制文件、编码、BOM 和过大文件。
- [ ] `fs/writeAtomic`：临时文件、fsync、rename 和失败清理。
- [ ] 写入前校验 expectedRevision，冲突时返回专用错误。
- [ ] 保存时保留原文件 mode；可行时保留 owner、group 和扩展属性。
- [ ] `fs/createFile`、`fs/createDirectory`。
- [ ] `fs/rename`、`fs/move`、`fs/copy`、`fs/delete`。
- [ ] `fs/chmod`、`fs/symlink`、`fs/readlink`。
- [ ] 删除默认支持移入用户级回收目录，并提供永久删除选项。
- [ ] 所有批量操作支持进度、取消、冲突策略和部分失败结果。

### 9.3 文件监听

- [ ] `fs/watchStart`、`fs/watchStop`、`fs/watchSnapshot`。
- [ ] 使用平台原生 watcher，并处理 watch 数量限制。
- [ ] 合并短时间内重复事件，保留 create/change/delete/rename 语义。
- [ ] watcher overflow 后通知桌面端重新扫描。
- [ ] 监听事件携带新的 revision 和文件类型。
- [ ] 编辑器无本地改动时自动刷新外部变化。
- [ ] 编辑器有本地改动时显示本地/远端 Diff 和冲突操作。
- [ ] 文件树实时反映创建、删除、重命名和 Git 产生的变化。

### 9.4 路径安全

- [ ] 每次文件操作都经过 workspace allowlist 检查。
- [ ] 防止 `..`、大小写差异和符号链接逃逸授权根目录。
- [ ] 用户明确打开工作区外文件时，增加临时授权根而不是关闭检查。
- [ ] 对 socket、device、FIFO 等特殊文件默认只读或拒绝。

验收标准：

- [ ] 两个客户端同时编辑同一文件时不会静默覆盖。
- [ ] 保存可执行脚本后执行位保持不变。
- [ ] 10 万文件工作区的初始树不会阻塞 UI 或耗尽内存。
- [ ] watcher overflow、文件被删除和目录被重命名均可恢复。

## 10. 阶段 5：搜索、索引和问题列表

### 10.1 搜索

- [ ] `search/start`、`search/cancel`、`search/progress`。
- [ ] 支持固定字符串、正则、大小写、全词匹配。
- [ ] 支持 include/exclude glob。
- [ ] 支持 `.gitignore`、自定义 ignore 和搜索隐藏文件选项。
- [ ] 搜索结果流式返回，包含 path、line、column、preview 和 match ranges。
- [ ] 结果数量、单文件大小和总扫描字节均有限制。
- [ ] 二进制、无权限和变化中的文件返回统计而不是中断整个搜索。
- [ ] 搜索历史保存在桌面端。
- [ ] 搜索替换必须先生成 preview，再批量写入并支持冲突检测。

### 10.2 文件和符号索引

- [ ] 建立轻量文件名索引，支持快速文件打开。
- [ ] 根据 watcher 增量更新索引。
- [ ] 评估 Tree-sitter 符号索引，首版不替代 LSP。
- [ ] 提供 workspace symbol 的统一 UI，优先使用 LSP，缺失时使用轻量索引。
- [ ] 限制索引内存并提供状态和重建操作。

### 10.3 问题列表

- [ ] 统一展示 LSP、任务编译、测试和搜索产生的问题。
- [ ] 每个问题包含来源、严重级别、文件、位置和关联任务。
- [ ] 点击问题可打开远端文件并定位。
- [ ] 支持按来源、严重级别和文件过滤。
- [ ] 工作区或 server 重连后清理过期问题。

验收标准：

- [ ] 远端不安装 `rg` 也能完成完整搜索。
- [ ] 取消搜索后 server 在短时间内停止磁盘扫描。
- [ ] 文件变化后文件名索引能增量同步。

## 11. 阶段 6：任务、PTY、日志和端口

### 11.1 任务模型

- [ ] `task/start`、`task/list`、`task/status`、`task/stop`、`task/restart`。
- [ ] 任务包含 taskId、命令、cwd、环境变量白名单、状态、PID、退出码和时间。
- [ ] 支持普通 pipe 任务和 PTY 交互任务。
- [ ] 支持向任务写 stdin、发送 resize 和发送信号。
- [ ] stdout/stderr 使用有序流事件，包含 seq 和时间戳。
- [ ] server 保留有限日志 ring buffer，重新附着时可以回放。
- [ ] 支持优雅停止超时后强制结束进程组。
- [ ] 清理孤儿子进程，不能只杀父 shell。
- [ ] 限制并发任务数、日志速率和最大缓存。

### 11.2 项目任务发现

- [ ] 识别 `package.json` scripts。
- [ ] 识别 Makefile targets。
- [ ] 识别 Python、Cargo、Go 和 Docker Compose 常用任务。
- [ ] 将发现结果展示为可运行命令，不自动执行项目代码。
- [ ] 允许用户为工作区保存自定义 task 配置。
- [ ] 快速命令迁移到任务模型并支持参数占位符。

### 11.3 持久任务

- [ ] 区分 session task 和 persistent task。
- [ ] persistent supervisor 使用当前用户 Unix Socket 和随机认证 token。
- [ ] supervisor 按需启动并有 idle timeout。
- [ ] SSH 重连后重新发现和附着任务。
- [ ] 提供明确的“关闭窗口后继续运行”开关。
- [ ] 应用退出前列出仍在运行的持久任务。

### 11.4 端口发现和预览

- [ ] `ports/list` 和 `ports/changed`。
- [ ] 关联监听端口与 taskId/PID。
- [ ] 新端口出现时显示非侵入式提示。
- [ ] 一键创建本地 SSH 隧道并选择空闲本地端口。
- [ ] 一键在本地浏览器打开 HTTP/HTTPS 服务。
- [ ] 任务停止后可按策略关闭自动创建的隧道。
- [ ] 对 `0.0.0.0`、IPv6 和容器端口做正确展示。

验收标准：

- [ ] 启动 `npm run dev` 后能看到实时日志和检测到的端口。
- [ ] SSH 断线后持久任务继续运行，重连后日志可回放。
- [ ] 结束任务不会遗留子进程或占用端口。

## 12. 阶段 7：LSP 和 Tool Pack

### 12.1 Pack 制作和部署

- [ ] 定义 Tool Pack manifest schema。
- [ ] 构建 TypeScript Pack。
- [ ] Pack 构建过程固定依赖版本并生成 SBOM。
- [ ] Pack 压缩、签名并作为 Electron extraResource 发布。
- [ ] 桌面端只在需要时上传 Pack。
- [ ] server 负责校验、解压、锁定、版本切换和清理。
- [ ] Pack 目录不可被工作区写入。
- [ ] Pack 部署失败时保持旧 Pack 可用。

### 12.2 LSP 生命周期

- [ ] `lsp/detect`：根据文件和项目配置识别语言。
- [ ] `lsp/start`、`lsp/stop`、`lsp/status`、`lsp/restart`。
- [ ] `lsp/message` 转发双向 LSP JSON-RPC。
- [ ] 每个 workspace + language 只启动一个实例。
- [ ] stdout 只走 LSP，stderr 作为受限日志流。
- [ ] server 监控语言服务器退出并返回稳定错误码。
- [ ] 限制单个语言服务器内存、日志和重启频率。
- [ ] workspace 切换或连接关闭时完成 shutdown/exit。

### 12.3 Monaco 能力

- [x] 已有 TypeScript/JavaScript 直连 LSP 原型：补全、Hover、诊断、跳转定义。
- [x] 已有 Monaco `ssh://` 和远端 `file://` URI 映射。
- [x] 已有 didOpen/didChange/didSave/didClose 增量同步。
- [ ] 将当前 `language-server-manager.ts` 的远端直接启动改为 server 的 `lsp/*` RPC。
- [ ] 保留直连实现作为迁移期 fallback，稳定后删除重复逻辑。
- [ ] 支持 references、document symbols、workspace symbols。
- [ ] 支持 formatting 和 code actions。
- [ ] 支持 rename preview 和多文件 WorkspaceEdit。
- [ ] WorkspaceEdit 必须结合 revision 检查和批量 Diff。
- [ ] 支持 semantic tokens、inlay hints 和 signature help。
- [ ] 增加 Problems 面板和 LSP 日志面板。

### 12.4 后续语言

- [ ] Python Pack：Pyright。
- [ ] Go Pack：gopls。
- [ ] Rust Pack：rust-analyzer。
- [ ] C/C++ Pack：clangd。
- [ ] 每种语言先完成独立兼容性、资源和安全测试，再进入默认安装包。
- [ ] 允许用户禁用某种语言或选择系统已有 server。

验收标准：

- [ ] 远端项目不执行 npm install 也能获得 TypeScript LSP。
- [ ] 首次 Pack 部署和后续缓存命中都有清晰状态。
- [ ] 补全前保证 didOpen/didChange 队列已同步。
- [ ] LSP 崩溃不会影响文件、终端或 server 主进程。

## 13. 阶段 8：Git 和 Worktree

### 13.1 Git 基础

- [ ] `git/discover`、`git/status`、`git/diff`、`git/log`。
- [ ] 状态返回结构化 staged/unstaged/untracked/conflicted 信息。
- [ ] 文件树展示 Git 状态，但不因状态刷新阻塞浏览。
- [ ] 支持分支列表、当前分支、ahead/behind 和 upstream。
- [ ] 支持 stage、unstage、discard，危险操作必须确认。
- [ ] 支持 commit，提交信息在桌面端编辑。
- [ ] 支持 fetch/pull/push，但凭据完全交给远端 Git 配置和 Agent。
- [ ] Git 操作支持进度、取消和 stderr 诊断。

### 13.2 Diff

- [ ] 使用 Monaco Diff 查看工作区、暂存区和 commit Diff。
- [ ] 支持单文件、整仓库和指定 commit。
- [ ] 处理二进制文件、重命名、删除和大 Diff。
- [ ] 支持按 hunk stage/unstage，必须验证 patch 应用结果。

### 13.3 Worktree

- [ ] `git/worktreeList`、`git/worktreeCreate`、`git/worktreeRemove`。
- [ ] 创建任务时可自动创建 branch + worktree。
- [ ] 每个 worktree 拥有独立任务、LSP、端口和 Agent 上下文。
- [ ] 删除前检查未提交内容、运行任务和打开标签。
- [ ] 支持合并、rebase、cherry-pick 或保留分支。
- [ ] 不自动解决冲突，提供冲突文件列表和 Diff。

验收标准：

- [ ] 10 万文件仓库的状态刷新可取消且不阻塞其他 RPC。
- [ ] Worktree 删除不会误删主工作区或含未提交内容的目录。

## 14. 阶段 9：容器工作区

- [ ] `container/list`：Docker/Podman 容器和 Compose 服务。
- [ ] 显示容器状态、镜像、工作目录、端口和健康状态。
- [ ] `container/exec`：在容器内启动任务和 PTY。
- [ ] `container/logs`：流式日志、历史和取消。
- [ ] 打开容器内目录作为工作区。
- [ ] 明确宿主机路径和容器路径映射。
- [ ] LSP 可选择运行在宿主机、容器内或 Tool Pack Runtime。
- [ ] 容器重建后检测 instance 变化并重新附着。
- [ ] 支持 Compose start/stop/restart，危险操作确认。
- [ ] Kubernetes 支持单独设计，不混入 Docker MVP。

验收标准：

- [ ] 能打开运行中容器的项目目录、终端、日志和端口。
- [ ] 容器退出后所有相关 UI 状态正确失效。

## 15. 阶段 10：传输、缓存和双向同步

### 15.1 可靠传输

- [ ] 上传和下载支持 chunk、SHA-256、断点续传和取消。
- [ ] 小文件批量操作使用归档流减少往返。
- [ ] 可选压缩，并根据文件类型和 CPU 情况决定是否启用。
- [ ] 传输完成后验证大小和哈希。
- [ ] 支持覆盖、跳过、重命名和逐项询问冲突策略。
- [ ] 应用重启后可以恢复可恢复传输。

### 15.2 本地镜像

- [ ] 为工作区建立可选本地缓存，不默认缓存敏感项目。
- [ ] manifest 保存 path、revision、hash 和本地状态。
- [ ] watcher 驱动远端到本地增量更新。
- [ ] 本地编辑形成待上传队列。
- [ ] 双向变化产生三方冲突，不采用最后写入获胜。
- [ ] 提供缓存大小限制、忽略规则和一键清理。
- [ ] 本地缓存内容需要明确的隐私提示和可选加密。
- [ ] 离线模式只允许编辑已有缓存，恢复连接后预览同步计划。

### 15.3 Delta Sync

- [ ] 对大文件评估 block hash 和增量传输。
- [ ] 只有收益超过阈值时启用 delta，避免小文件计算成本。
- [ ] delta 失败自动退回完整传输。

验收标准：

- [ ] 大文件中断后可续传且最终哈希一致。
- [ ] 本地和远端同时修改时不会静默丢失任一版本。

## 16. 阶段 11：系统、进程和服务观察

- [ ] `system/info`：OS、内核、架构、hostname 和 uptime。
- [ ] `system/metrics`：CPU、内存、负载和磁盘。
- [ ] `process/list`、`process/detail`、受控 signal 操作。
- [ ] 显示与当前工作区、任务和端口相关的进程，而不是默认展示整个系统噪音。
- [ ] 支持 systemd 用户/系统服务的状态和日志；需要权限时明确提示。
- [ ] 支持 Docker 服务状态和资源使用。
- [ ] 磁盘不足、OOM 风险和任务异常退出产生通知。
- [ ] 默认不采集或上传遥测；诊断数据只保存在本地或用户明确导出。
- [ ] 诊断包自动脱敏主机、用户名、路径、命令参数和环境变量。

验收标准：

- [ ] 指标采集开销低且可关闭。
- [ ] 无权限时返回 capability/permission 错误，不反复弹窗或重试。

## 17. 阶段 12：工作区和会话恢复

### 17.1 恢复状态模型

- [ ] 定义稳定 workspace identity：savedConnectionId + 远端 realpath + 可选 containerId/worktreeId。
- [ ] 为恢复快照定义 versioned schema 和迁移策略。
- [ ] 区分桌面 UI 状态、远端资源状态、敏感草稿和不可恢复状态。
- [ ] 桌面 UI 快照保存在 Electron userData，不依赖远端 server 存活。
- [ ] server 只返回任务、端口、watcher、LSP、transfer 和 supervisor 等资源快照。
- [ ] 快照不保存密码、私钥口令、Agent token、模型密钥或完整环境变量。
- [ ] 每个窗口和工作区使用独立 snapshotId，避免多窗口互相覆盖。
- [ ] 快照写入使用临时文件和原子 rename，防止应用崩溃留下半份 JSON。
- [ ] 保存 `lastOpenedAt`、`lastCleanShutdown` 和 snapshot schema version。
- [ ] 为每个工作区提供“恢复上次会话”“始终恢复”“不恢复”策略。

### 17.2 编辑器和 UI 恢复

- [ ] 恢复上次连接配置和远端工作区路径，但连接仍需经过正常认证与主机校验。
- [ ] 恢复已打开标签、标签顺序、活动标签和 pinned 状态。
- [ ] 恢复每个文件的光标、选择区、滚动位置、折叠区域和 Monaco view state。
- [ ] 恢复文件树展开节点、选中路径、侧栏宽度和终端面板高度。
- [ ] 恢复终端标签名称、分屏关系和活动面板，但不伪造已经消失的普通 shell。
- [ ] 恢复搜索条件、Problems 过滤器、Git 视图和任务面板选择。
- [ ] 恢复 Auto Save、字体、主题等工作区级偏好。
- [ ] 文件已经移动或删除时保留清晰的 missing 状态，不自动创建空文件。
- [ ] 工作区路径不可访问时返回连接页，并保留稍后重试入口。
- [ ] 大量标签恢复采用懒加载，只先读取活动文件。

### 17.3 未保存草稿

- [ ] 脏标签内容可以保存为本地恢复草稿，默认使用 Electron `safeStorage` 加密。
- [ ] `safeStorage` 不可用时默认只保存标签元数据，保存明文草稿必须用户明确允许。
- [ ] 草稿记录 base revision、远端路径、编码、换行符和更新时间。
- [ ] 设置单文件、单工作区和全局草稿容量上限。
- [ ] 草稿超限时提示用户，不静默丢弃最近修改。
- [ ] 正常保存成功后删除对应恢复草稿。
- [ ] 正常关闭脏标签前仍需确认，恢复功能不能代替数据丢失提示。
- [ ] 应用崩溃重启后优先展示恢复摘要，而不是直接覆盖远端文件。
- [ ] 恢复草稿前通过 server 获取当前 revision。
- [ ] base revision 不一致时打开本地草稿/远端内容 Diff，提供保留草稿、采用远端和另存为。
- [ ] 提供查看、导出和清空本地恢复草稿的设置页面。

### 17.4 SSH 断线恢复

- [ ] SSH 意外断开时保留所有标签、草稿、布局和任务元数据。
- [ ] 断线标签进入 stale/read-only 状态，避免误以为保存成功。
- [ ] 对保存连接执行可取消的指数退避自动重连，手动断开不自动重连。
- [ ] 重连必须使用相同 savedConnectionId；主机身份变化时停止自动恢复。
- [ ] server 重连后比较 instanceId，区分原实例恢复和新实例重建。
- [ ] 重新订阅 watcher、文件树、Git、端口和系统事件。
- [ ] 重新启动 session-scoped LSP，并对所有打开文档重发 didOpen。
- [ ] 查询 persistent supervisor，重新附着仍在运行的 task、PTY、Agent 和日志流。
- [ ] 普通非持久 shell 已结束时明确标记 exited，并提供“在原 cwd 新建终端”。
- [ ] 对配置为 auto-start 的隧道重新启动；其他隧道保持 stopped。
- [ ] 恢复可续传文件操作，并对不可续传操作显示失败原因。
- [ ] 逐个校验打开文件 revision；外部变化进入刷新或冲突流程。
- [ ] 恢复完成后生成摘要：已恢复、已重建、已结束和需要处理的项目数量。

### 17.5 应用重启和崩溃恢复

- [ ] UI 关键状态变化使用 debounce 写入快照，避免每次键入都写磁盘。
- [ ] 脏草稿变化使用独立、更短的持久化周期。
- [ ] 正常退出前 flush 所有 snapshot，并记录 clean shutdown。
- [ ] 崩溃或强制退出后下次启动显示“恢复上次工作区”入口。
- [ ] 支持一次恢复多个窗口，但限制并发 SSH 连接和 server 部署。
- [ ] 恢复过程中允许跳过单个连接或工作区。
- [ ] 恢复失败不删除快照，用户确认放弃后再清理。
- [ ] 超过保留期限的无草稿快照自动清理。
- [ ] 包含脏草稿或持久任务引用的快照不得自动过期删除。
- [ ] schema 迁移失败时保留原始快照并提供导出诊断。

### 17.6 Server 恢复接口

- [ ] `session/snapshot`：返回当前 instance、工作区和可恢复资源摘要。
- [ ] `session/resources`：列出 task、PTY、Agent、LSP、watcher、port、transfer 和 tunnel 关联资源。
- [ ] `session/reattach`：按 resourceId 重新订阅状态和数据流。
- [ ] `session/reconcile`：桌面端提交期望资源列表，server 返回 restore/recreate/missing 决策。
- [ ] `session/cleanup`：显式清理不再需要的持久资源。
- [ ] 每种资源定义稳定 identity，不能用短生命周期 PID 作为唯一 ID。
- [ ] 资源 snapshot 带 revision 和 createdAt，防止附着到同名但不同实例的任务。
- [ ] server 重启后从 supervisor Unix Socket 恢复 persistent resource 列表。
- [ ] session 模式退出时清理非持久资源，不能让恢复机制制造孤儿进程。

### 17.7 恢复 UI

- [ ] 启动页展示最近工作区、最后连接时间、脏草稿数和持久任务数。
- [ ] 恢复前允许展开查看将要连接的主机和工作区。
- [ ] 恢复过程中展示 Connecting、Deploying Server、Reattaching、Checking Files 等阶段。
- [ ] 单项失败不阻塞其他工作区恢复。
- [ ] 状态栏提供恢复进度和取消入口。
- [ ] 完成后只对冲突、认证失败和资源丢失等需要用户处理的项目弹出摘要。
- [ ] 提供“关闭工作区并忘记恢复状态”，但与删除远端文件严格分离。

验收标准：

- [ ] 编辑三个未保存文件后强制结束应用，重启可恢复内容、光标和布局。
- [ ] 草稿对应远端文件被外部修改时必须进入 Diff，不能自动覆盖。
- [ ] SSH 断线后 persistent task 继续运行，重连后日志顺序和状态可恢复。
- [ ] 非持久终端断线后明确显示已退出，并可在原 cwd 重新创建。
- [ ] 多窗口恢复不会串用连接、草稿、server event 或 task resource。
- [ ] 恢复被取消或部分失败后应用仍可正常手动连接和打开文件。

## 18. 阶段 13：Coding Agent 控制台

- [ ] 定义 Agent adapter 接口，不把某个 CLI 写死在核心协议。
- [ ] 发现远端可用 Agent CLI 和版本。
- [ ] 从选定 worktree、分支和 cwd 创建 Agent task。
- [ ] Agent 运行复用 persistent task、PTY、日志和通知机制。
- [ ] 展示 Running、Waiting Approval、Completed、Failed 状态。
- [ ] 需要确认时发送桌面系统通知。
- [ ] 将 Agent 产生的 Git Diff 与任务关联。
- [ ] 支持测试命令和完成条件。
- [ ] 支持并发上限、队列、暂停和取消。
- [ ] Agent 不能绕过 workspace 文件授权和命令确认策略。
- [ ] 凭据由远端 Agent 自己管理，SSH Studio 不读取或上传模型密钥。
- [ ] 完成后提供合并、保留 worktree 或删除任务的流程。

验收标准：

- [ ] SSH 断线后持久 Agent 继续运行，重连后状态、日志和 Diff 可恢复。
- [ ] Agent 权限请求不会被自动批准。

## 19. 安全加固清单

### 19.1 供应链

- [ ] server 和 Pack 使用固定版本、lockfile、SBOM 和许可证清单。
- [ ] 桌面端内置可信公钥并验证 manifest 签名。
- [ ] 二进制和 Pack 每次部署前后都验证 SHA-256。
- [ ] CI release 使用受保护环境和最小权限 token。
- [ ] 发布内容可重现或至少可追溯到 commit。

### 19.2 运行时

- [ ] server 拒绝 root 启动，除非未来提供明确且隔离的高级模式。
- [ ] 所有文件和 Git 路径参数在 server 端重新验证。
- [ ] 所有命令使用 argv，不通过字符串拼接 shell；确需 shell 时标记并确认。
- [ ] 限制环境变量继承，过滤 secrets 和危险 loader 变量。
- [ ] 子进程使用独立进程组并有资源限制。
- [ ] 协议输入做 schema、长度、数量和 UTF-8 验证。
- [ ] 防止 zip/tar 路径穿越和解压炸弹。
- [ ] Unix Socket 权限设为 `0600`，token 不写日志。
- [ ] persistent supervisor 有 idle timeout 和显式卸载。

### 19.3 SSH 安全

- [ ] 目标主机和跳板机都支持独立 host key verification。
- [ ] 不能因为使用跳板机而硬编码关闭 `known_hosts` 验证。
- [ ] server bootstrap 只能在 SSH ready 和主机验证成功后执行。
- [ ] 多窗口共享缓存但不共享未授权的 session token。

### 19.4 用户确认

- [ ] 首次部署 server 时显示说明和目标路径，可在设置中记住授权。
- [ ] 永久删除、discard、强制 kill、容器删除等操作必须确认。
- [ ] 项目任务、LSP 和 Agent 首次执行远端代码时明确说明风险。
- [ ] 提供“本次连接禁用远端 server”和全局禁用选项。

## 20. 性能和资源目标

- [ ] 已缓存 server 从 exec 到 hello ready：目标小于 500 ms，慢速主机小于 2 s。
- [ ] 首次部署只上传实际平台产物，显示准确进度。
- [ ] 空闲基础 server 内存目标小于 30 MiB。
- [ ] 空闲 CPU 接近 0，不使用高频轮询。
- [ ] 10 万文件树采用流式/分页，不一次性发送巨型 JSON。
- [ ] 搜索、哈希、Git 和索引有并发限制和取消响应时间目标。
- [ ] 日志 ring buffer 有按任务和全局上限。
- [ ] watcher 数量不足时自动降级为分层监听或低频扫描，并告知用户。
- [ ] 对每个 RPC 收集耗时和错误码，但默认只保存在本地调试日志。

## 21. 测试计划

### 21.1 单元测试

- [ ] 协议分帧：拆包、粘包、非法长度、超大消息和无效 JSON。
- [ ] 路径授权和符号链接逃逸。
- [ ] revision、hash 和原子写入。
- [ ] watcher 事件合并和 overflow。
- [ ] 任务状态机和进程组清理。
- [ ] Tool Pack manifest、签名和路径安全。
- [ ] 平台探测和产物选择。
- [ ] capability negotiation 和协议兼容。

### 21.2 集成测试

- [ ] 使用本地 SSH 容器启动 server，完成 hello 到 shutdown。
- [ ] SFTP 上传、缓存命中、版本升级、损坏恢复和回滚。
- [ ] 文件读写、冲突、监听、目录重命名和删除。
- [ ] 搜索取消和大结果流。
- [ ] PTY 输入、resize、断线、重连和持久任务。
- [ ] TypeScript Pack 部署、LSP 初始化、补全、诊断和跳转。
- [ ] Git status/diff/worktree 生命周期。
- [ ] Docker 容器工作区。

### 21.3 兼容测试

- [ ] Ubuntu LTS x64/arm64。
- [ ] Debian x64/arm64。
- [ ] Alpine Linux musl。
- [ ] macOS Intel/Apple Silicon。
- [ ] 无 `bash`、无 `rg`、无 npm、只读 home、`noexec` cache 等受限环境。
- [ ] 高延迟、低带宽、丢包、SSH 强制断开。
- [ ] 跳板机、Tailscale SSH、SSH Agent 和私钥认证。

### 21.4 UI/E2E

- [ ] 首次安装、启动、失败、降级和重新安装流程。
- [ ] server 状态和 capability UI 不跳动、不重叠。
- [ ] 文件冲突 Diff 和保存决策。
- [ ] 搜索、任务日志、端口预览、Problems 和 Git Diff。
- [ ] 窗口关闭时持久任务提示。
- [ ] 多窗口连接同一主机的部署锁和状态隔离。

## 22. 文档和运维

- [ ] 更新中英文 README，解释远端组件、安装路径和隐私边界。
- [ ] 编写协议文档和 method schema。
- [ ] 编写 server 开发、构建和调试指南。
- [ ] 编写 Tool Pack 创建指南。
- [ ] 编写远端卸载和缓存清理说明。
- [ ] 编写受限环境和企业网络部署说明。
- [ ] 建立兼容性表和已知问题列表。
- [ ] 建立 server/Pack CVE 更新流程。
- [ ] 发布说明区分桌面端、server 和 Pack 版本变化。

## 23. 推荐里程碑和发布顺序

### Milestone A：可部署的基础 server

- [ ] 完成阶段 0-3。
- [ ] 支持 hello、health、shutdown、自动上传、缓存、升级和降级。
- [ ] 发布为实验功能，默认只对开发构建开启。

### Milestone B：文件可靠性与工作区恢复

- [ ] 完成文件 stat/revision、原子保存、权限保持和 watcher。
- [ ] 编辑器接入外部变更和冲突 Diff。
- [ ] 完成 UI 快照、加密草稿、崩溃恢复和 SSH 断线重连。
- [ ] persistent task 可以重新附着，普通终端明确降级为重新创建。
- [ ] server 稳定后替换部分 SFTP/shell 文件操作。

### Milestone C：搜索和任务工作台

- [ ] 完成内置搜索、任务、日志和端口发现。
- [ ] 删除远端 `rg` 必需性。
- [ ] 实现一键运行项目和打开本地预览。

### Milestone D：零安装 LSP

- [ ] 完成 TypeScript Tool Pack 自动部署。
- [ ] 将现有直连 LSP 迁移到 server。
- [ ] 发布补全、Hover、诊断、定义、引用和重命名预览。

### Milestone E：Git/Worktree

- [ ] 完成结构化 Git、Diff 和隔离工作区。
- [ ] 将任务、LSP 和端口绑定到 worktree。

### Milestone F：容器、同步和 Agent

- [ ] 依次交付容器工作区、可靠传输/缓存和 Coding Agent 控制台。
- [ ] 每一项独立灰度，不作为基础 server 稳定版的阻塞条件。

## 24. 全局完成定义

任何功能只有同时满足以下条件才可标记完成：

- [ ] 主流程和失败流程均有明确 UI 状态。
- [ ] server 端和桌面端都有类型/schema 校验。
- [ ] 支持取消、超时、断线和资源清理。
- [ ] 不扩大未声明的文件、命令或凭据权限。
- [ ] 有单元测试，跨进程功能有集成测试。
- [ ] `npm run typecheck`、`npm test`、`npm run build` 和 Go 检查全部通过。
- [ ] 中英文用户文档已更新。
- [ ] 降级路径经过验证，server 失败不会破坏基本 SSH 使用。
- [ ] 性能、日志和磁盘占用满足已定义上限。
- [ ] release 包包含正确产物、manifest、签名、SBOM 和许可证信息。

## 25. 当前下一步

按顺序执行，不要直接从 LSP Pack 或 Agent 开始：

1. [x] 创建 `server/` Go 骨架，实现 `--version`、`self-test`、hello、ping 和 shutdown。
2. [x] 定义 `src/shared/server-contracts.ts` 和协议版本。
3. [x] 完成 Linux x64 开发构建和 manifest 生成。
4. [ ] 实现桌面端 platform detection、SFTP 上传、哈希校验和启动。
5. [ ] 用本地 SSH 容器完成第一次端到端握手测试。
6. [ ] 实现文件 stat/revision/watch，优先解决远端编辑冲突和权限保持。
7. [ ] 实现工作区 UI 快照、加密草稿和 server resource reconciliation。
8. [ ] 实现搜索和 task/port，形成第一个完整的用户工作流。
9. [ ] 制作 TypeScript Tool Pack，并迁移当前 LSP 原型。
