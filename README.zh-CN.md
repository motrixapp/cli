# @motrix/cli

[English](./README.md) · **简体中文**

`motrix` 是 [Motrix](https://motrix.app) 下载管理器的命令行客户端，同时面向人类用户与
AI agent。它通过 unary `POST /mdxp` 传输，用 **MDXP**（Motrix Download eXchange
Protocol —— 基于 JSON-RPC 2.0）与一个**正在运行的** Motrix 通信；既可以对接本地桌面端
（自动发现），也可以对接远程 / 无头（headless）的 Motrix server（一次性配对后使用）。

CLI 是**客户端，而非下载引擎**——它自己不下载任何东西。每条命令都是向正在运行的 Motrix
发起的请求，真正的下载由 Motrix 完成。

## 环境要求

- **Node.js ≥ 20**
- 一个可访问的、正在运行的 **Motrix** 实例（桌面端 app 或 server）。

## 安装

```bash
npm i -g @motrix/cli   # 全局安装 `motrix` 命令
motrix --help
```

发布产物是自包含的：构建时已把 `@motrix/mdxp` inline 进产物，因此全局安装**不会引入任何
`@motrix/*` 运行时依赖**——只有一个 `commander`。

> 如果你已经在用 Motrix 桌面端，推荐直接用 **Settings → Command-line tools →
> Install**：它会替你执行同样的 `npm i -g @motrix/cli`，并检查 `PATH` 是否就绪。

## 快速上手

```bash
motrix list                                            # 列出当前任务
motrix add https://example.com/f.zip --save-dir ~/Downloads
motrix watch --stats                                   # 持续输出实时进度，直到 Ctrl-C
```

## 命令

| 命令 | 用途 |
|------|------|
| `motrix list [--status <s>] [--limit <n>] [--offset <n>]` | 列出下载任务 |
| `motrix stats` | 聚合速度与任务计数 |
| `motrix add <url...> --save-dir <dir> [--filename <name>] [--header "K: V"] [--connections <n>] [--proxy <url>]` | 添加 HTTP(S) / FTP 下载 |
| `motrix add --magnet <uri> --save-dir <dir> [--select 0,2]` | 添加 magnet 链接 |
| `motrix add --torrent <file.torrent> --save-dir <dir>` | 添加 `.torrent` 文件 |
| `motrix pause <taskId>` | 暂停任务 |
| `motrix resume <taskId>` | 恢复任务 |
| `motrix remove <taskId> [--delete-files]` | 移除任务 |
| `motrix watch [--task <id>] [--stats]` | 以 NDJSON 流式输出进度，直到中断 |
| `motrix pair [--name <label>]` | 通过 device code 与 bridge 配对 |
| `motrix describe` | 打印 MDXP 工具目录 |
| `motrix skill path \| install [dir]` | 定位 / 安装内置 agent skill |

所有命令还接受全局 flag：`--endpoint <url>`、`--token <token>`、`--json`。

## 连接 Motrix

### 本地桌面端（零配置）

默认情况下，CLI 会读取 `<userData>/bridge/endpoint.json`（macOS 上为
`~/Library/Application Support/Motrix/bridge/endpoint.json`）来自动发现正在运行的桌面端
Motrix，该文件携带 bridge 端口与一个 machine-owner token。无需任何额外配置。

### 远程 / 无头 server

先运行一次 `motrix pair`。它会通过 REST `/mdxp/pair/*` 路由完成 device-code 交换，并打印一个
验证码；在 Motrix UI 中批准该验证码即可。签发的 token 会以 endpoint 为键，存入
`~/.config/motrix/credentials.json`（权限 `0600`），后续命令自动复用。

### 显式覆盖

- `--endpoint <url>`——例如 `http://nas.local:16801`
- `--token <token>`——或使用环境变量 `MOTRIX_BRIDGE_TOKEN`

## 输出与退出码

CLI 会根据调用方自动调整输出：

- **交互式 TTY** → 人类可读的表格 / 摘要。
- **`--json`，或被管道 / 非 TTY 的 stdout** → 单个 JSON 值，便于解析。

脚本与 agent 应基于**退出码**分支：

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `2` | 用法错误（flag / 参数有误） |
| `3` | 网络——bridge 未启动或不可达 |
| `4` | 认证——token 缺失或被拒（重新运行 `motrix pair`） |
| `5` | 服务端——bridge 返回了 JSON-RPC error |

**版本漂移。** 如果目标 Motrix 不认识本 CLI 发送的某个方法（JSON-RPC `-32601`），或根本
没有暴露 `/mdxp` bridge（HTTP 404），命令会以退出码 `5` 失败，并给出清晰的"请升级 Motrix
或 CLI"提示，而不是抛出原始协议错误。在 `--json` 模式下，原始 JSON-RPC `code` 会保留在
`data` 中，供调用方以编程方式分支。

## AI agent 集成

`motrix` 从设计上就适合被自主 agent 安全驱动。

- **`motrix describe --json`** 输出权威的 MDXP 工具目录——每个 agent 可调用的方法及其
  JSON-Schema（draft 2020-12）`inputSchema` 与 `outputSchema`。它是静态的（不发起 bridge
  调用），且始终反映 CLI 构建时所针对的协议版本，因此不会与命令实际发送的内容产生漂移。
  用它来获取精确的参数结构，而不是靠猜。
- **`motrix skill install [dir]`** 安装内置的 `SKILL.md` agent skill（默认
  `~/.claude/skills`，归置于 `motrix/` 命名空间下）；**`motrix skill path`** 打印其路径。

agent 面向的使用契约详见 [`SKILL.md`](./SKILL.md)。

## 开发

本仓库是独立的（从 Motrix app monorepo 抽出）。它从 npm 依赖 `@motrix/mdxp` 与
`commander`，不再有 sibling-path link。

```bash
pnpm install
pnpm build       # tsup → dist/bin/motrix.js（mdxp inline，commander external）
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check .
node dist/bin/motrix.js --help
```

`tsup` 的 `noExternal: [/^@motrix\//]` 会把 `@motrix/mdxp` inline 进单文件产物，因此产物无需
`node_modules/@motrix/mdxp` 即可运行。`commander` 保持为普通运行时依赖，由 npm 在
`npm i -g @motrix/cli` 时安装。

## 许可证

[MIT](./LICENSE) © Motrix
