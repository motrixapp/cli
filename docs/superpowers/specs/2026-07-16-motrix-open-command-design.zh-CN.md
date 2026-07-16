# 设计 — `motrix open`(启动桌面 app）

- **日期：** 2026-07-16
- **状态：** 已批准（brainstorming）
- **目标版本：** `@motrix/cli` 0.2.0（新命令 → minor bump）

## 动机

CLI 是一个*正在运行的* Motrix 的**客户端**。目前当桌面 app 没在跑时，每条命令都会以
`EXIT.NETWORK (3)` fail-fast——这是刻意设计，让调用方直接暴露问题而非盲目重试。但这留下一个
真实缺口：在终端里（或对 AI agent 而言），没有一等的方式在发命令前**把 Motrix 拉起来**。
`motrix open` 正是填这个缺口。

## 目标

- 一个显式的 `motrix open` 命令：启动本地桌面 Motrix，并且只有在其 bridge 就绪、可接受命令后
  才返回成功。
- Idempotent：若 Motrix 已在运行，则聚焦其窗口并立即成功。
- 跨平台（macOS / Windows / Linux）。
- 对人类和 agent 都能区分「app 未安装」与「已启动但超时」。

## 非目标

- **不对其它命令做自动拉起**，也**不加 `--launch` flag**。`list`、`add` 等保持各自的 fail-fast
  行为（bridge 没跑就 `EXIT.NETWORK`）。`open` 是唯一、显式的入口。
- **不启动远程 server。** `open` 仅限本地桌面端；远程 `--endpoint` 无法被拉起。

## 命令面

```
motrix open [--timeout <ms>]
```

外加全局 flag `--json`（以及 `--endpoint` / `--token`，见下）。

- `--timeout <ms>`——启动后等待 bridge 的时长，默认 `15000`。

## 行为

1. **拒绝远程 endpoint。** 若给了 `--endpoint <url>`（或解析出的 endpoint 不是本地桌面端），以
   `EXIT.USAGE (2)`、reason `remote_endpoint` 退出——远程 app 无法拉起。
2. **先检查就绪。** 探测本地 bridge（见下文*就绪检测*）。若已在跑，置 `alreadyRunning = true`。
3. **触发 opener。** 对裸 `motrix://` URL 调用平台 opener（见*拉起机制*）。桌面 app 注册了
   `motrix` scheme，且已把裸 `motrix://` 处理为「显示 / 聚焦窗口」，因此同一次调用既能冷启动一个
   停止的 app，也能聚焦一个运行中的实例。
   - 若 `alreadyRunning`，opener 为**尽力聚焦**：其失败被忽略（我们已有存活的 bridge）。
   - 否则，**opener 非零退出意味着 scheme 无 handler → app 未安装** → 以
     `EXIT.NOT_INSTALLED (6)`、reason `not_installed` 退出。
4. **等待就绪**（若 `alreadyRunning` 则跳过）。轮询直到 bridge 就绪或 `--timeout` 到时。
   - 就绪 → 成功。
   - 超时 → 以 `EXIT.NETWORK (3)`、reason `launch_timeout` 退出。

### 拉起机制

通过已注册的 `motrix://` URL scheme + 平台 opener——与安装路径无关、跨平台统一，且 app 的
`protocol-manager` 已对裸 URL 做了正确处理：

| 平台 | opener 命令 |
|------|-------------|
| macOS（`darwin`） | `open motrix://` |
| Windows（`win32`） | `cmd /c start "" motrix://` |
| Linux（其它） | `xdg-open motrix://` |

opener 解析器（`openerFor(platform)` → `{ cmd, args }`）是纯函数，测试中可注入。spawn 封装同样
可注入（单测中无真实进程）。

### 就绪检测

复用 `discovery.ts`。bridge「就绪」当且仅当**同时**满足：

1. `<userData>/bridge/endpoint.json` 存在且可解析（app 在 `server.start()` *之后*写它），
2. 其 `pid` 存活（`process.kill(pid, 0)`，即 `isPidAlive`），
3. 到 `127.0.0.1:<port>` 的 TCP 连接成功。

轮询间隔约 250 ms，直到就绪或超时。endpoint 读取、`pidAlive`、TCP connector、`sleep`、时钟全部
可注入——单测不碰真实文件系统、socket 或 wall-clock。

## 退出码与错误分类

本命令在既有契约（`0/2/3/4/5`）上**只新增一个**码：

| 情况 | exit | `--json.reason` | 文案要点 |
|------|------|-----------------|----------|
| 就绪（冷启动或已在跑） | `0` | — | `Motrix is ready (http://127.0.0.1:PORT)` / `Motrix already running` |
| 给了远程 `--endpoint` | `2` USAGE | `remote_endpoint` | `open only launches the local desktop app; a remote --endpoint cannot be launched` |
| app 未安装（opener 非零） | `6` NOT_INSTALLED | `not_installed` | `Motrix desktop app not found — install it from https://motrix.app, or use --endpoint for a remote server` |
| 已启动但 bridge 未按时就绪 | `3` NETWORK | `launch_timeout` | `Motrix was launched but its bridge did not come up within Ns. Try --timeout <ms>; if Motrix isn't installed, get it at https://motrix.app` |
| 无可用 opener（如无 `xdg-open`） | `3` NETWORK | `opener_missing` | `could not open a URL on this system — start Motrix manually` |

`EXIT.NOT_INSTALLED = 6` 加入 `src/errors.ts`。

## 输出

- **TTY**——一行人类可读摘要（`Motrix is ready …` / `already running`）。
- **`--json` / 管道**——成功时：

  ```json
  { "ok": true, "alreadyRunning": false, "launched": true,
    "endpoint": "http://127.0.0.1:16800", "waitedMs": 1234 }
  ```

  失败时输出标准 CLI 错误 JSON，携带 `reason`（退出码即进程退出码）。

## Caveats（注意事项）

- **`motrix://` scheme 只由已安装（打包）的 app 注册。** dev / unpacked 构建无法这样拉起——会表现为
  `not_installed`。
- **Windows 无法总是区分未安装与超时。** `cmd /c start motrix://` 对未注册 scheme 不保证返回非零，
  因此 Windows 上未安装的 app 可能落到 `launch_timeout (3)` 而非 `not_installed (6)`。故超时文案
  同时提示安装。exit `6` 在 macOS 与 Linux 上可靠产出。
- **Linux 可执行文件也叫 `motrix`。** 打包 app 的二进制名为 `motrix`（electron-builder
  `executableName`），与本 CLI 的 bin 同名。二者通常不冲突（app 通过 `.desktop` 启动，不在 `PATH`
  上），而经 URL scheme 拉起本就绕开了这个问题。

## 架构与文件

| 文件 | 改动 |
|------|------|
| `src/launch.ts`（新） | `openerFor(platform)` → `{ cmd, args }`；一个可注入的 spawn 薄封装，返回 opener 退出码 |
| `src/commands/open.ts`（新） | orchestrator：拒绝远程 → 探测 → 触发 opener → 等待；纯函数，注入 `opener`、`readEndpointFile`、`pidAlive`、`tcpConnect`、`sleep`、`now` |
| `src/errors.ts` | 给 `EXIT` 加 `NOT_INSTALLED: 6` |
| `src/program.ts` | 注册 `open` 命令 |
| `src/discovery.ts` | 复用现有 helper；如方便可抽出一个小的 `isBridgeUp(...)`（不改现有调用方行为） |

## 测试（TDD）

仅单测——无真实进程、socket、文件系统或 wall-clock（全部注入），沿用 `client.test.ts`
（`fetchImpl`）与 `discovery`（`pidAlive`）的风格：

- `src/launch.test.ts`——`openerFor` 对 `darwin` / `win32` / linux 返回正确的 `{cmd,args}`。
- `src/commands/open.test.ts`：
  - 已在跑 → `alreadyRunning:true`、不等待、opener 尽力触发、exit 0
  - 冷启动 → 触发 opener、轮询 N 次后就绪、`launched:true`、exit 0
  - opener 非零 → `not_installed`、exit 6
  - opener 成功 + 轮询始终不就绪 → `launch_timeout`、exit 3、遵守 `--timeout`
  - opener spawn ENOENT → `opener_missing`、exit 3
  - 远程 `--endpoint` → `remote_endpoint`、exit 2
  - 成功时的 `--json` 结构

## 文档更新（属本次改动）

- `README.md` + `README.zh-CN.md`：命令表加 `open`；退出码表加 `6` 行；说明拉起行为。
- `SKILL.md`：命令列表加 `motrix open`；退出码行加 `6`；在 *When to use* 里注明——若 Motrix 没在跑，
  agent 可先跑 `motrix open`，而不是只暴露 exit 3。

## 版本

新的用户可见命令 → **0.2.0**（semver minor）。按常规发布（`npm publish` + `v0.2.0` tag）。
