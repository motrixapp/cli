# 设计 — `motrix self-update`(CLI 自我更新)

- **日期:** 2026-07-16
- **状态:** 已批准(brainstorming)
- **目标版本:** `@motrix/cli` 0.3.0(新命令 → minor 升级)

## 动机

`@motrix/cli` 通过 npm 分发、全局安装。今天更新它的唯一方式是记住包名、手动
重跑安装命令。pnpm 的 `self-update` 展示了我们想要的 UX:一条显式命令,解析
目标版本,遇到无法安全更新的环境就拒绝,并且绝不留下损坏的安装。

但 pnpm 的*机制*无法照搬。pnpm 拥有自己的安装目录(`PNPM_HOME`):每个版本
并排安装,通过重指 shim 完成切换。而 npm 安装的 CLI 什么都不拥有——全局
`node_modules` 树和 bin shim 归包管理器所有,绕过它改文件会导致其元数据失步。
所以对我们而言正确的机制是 Vercel CLI 和 gemini-cli 采用的那种:**检测是哪个
包管理器安装了我们,然后委托给它**(`npm i -g @motrix/cli@<解析后版本>`)。
我们从 pnpm 取来的是防护栏设计:不确定就拒绝(corepack guard)、先解析再安装、
降级保护、失败不破坏旧版本。

## 目标

- 显式的 `motrix self-update [target]` 命令,通过安装它的包管理器更新全局
  安装的 CLI。
- pnpm 风格的 target 参数:不带参数(= `latest` dist-tag)、精确版本、
  semver range 或 dist-tag。显式指定版本即可回滚。
- 对 npm / pnpm / yarn / bun / volta 全局安装检测并执行;其余一律拒绝并
  打印正确的手动命令。
- 绝不猜测:安装源不确定就只打印指引、不动手(要规避的事故原型是
  Claude Code #28625 的双重安装)。
- 更新失败时,当前安装保持完全可用。
- 一等公民的 `--json` 输出和退出码,方便 AI agent 按结果分支。
- 前置项(同一变更内交付):`motrix --version`(目前不存在),版本源同时
  接线到 `pair.ts` 的 `clientVersion`(目前恒为 `'unknown'`)。

## 非目标

- **不做被动更新提示**(普通命令时查 registry + 打横幅)。已明确排除;
  以后可以再叠加。
- **不做后台自动更新。** 对被 AI agent 驱动的 CLI 尤其危险——代码不能在
  运行中的工作流脚下被换掉。
- **不做 Homebrew / standalone 二进制渠道。** 此包不存在这些分发;cascade
  为将来留了位置。
- **不做 Motrix app 版本协商。** MDXP 不暴露 app 版本;`client.ts` 保持
  纯文本的版本漂移提示。属于 future work。

## 命令表面

```
motrix self-update [target] [--dry-run]
```

- `target` — npm resolver 接受什么就支持什么:精确版本(`0.2.1`)、range
  (`0.2`、`^0.2.0`)、dist-tag(`latest`、`next`)。默认 `latest`。
- `--dry-run` — 跑完检测 + 解析 + guards,报告将执行什么,不做任何改动。
- 全局 `--json` 生效。`--endpoint` / `--token` 无关(不涉及 bridge);
  与 `open` 一样绕过 `ioFromGlobals()`。

## 行为

### 第 0 步 — 自身版本(新文件 `src/pkg.ts`)

`readOwnPackageJson()` 从 `import.meta.url` 向上走到最近的、`name` 为
`@motrix/cli` 的 `package.json`(有界,约 4 层)。与深度无关,因此 dev 下的
`src/**` 和打包后的 `dist/bin/motrix.js` 都成立(tsup 不内联 `package.json`,
但 `files` 让它随 `dist/` 一起发布)。喂给 `program.version()`、`self-update`
和 `pair.ts` 的 `clientVersion`。

### 第 1 步 — 安装源检测(新文件 `src/install-source.ts`)

对 `realpath(process.argv[1])` 的纯 cascade(先 realpath——POSIX 上 bin shim
是 symlink)。所有输入可注入(`argv1`、`realpath`、`env`、`platform`、
`spawn`)。首个命中即生效:

| # | 信号 | 判定 | 动作 |
|---|------|------|------|
| 1 | 路径含 `/.npm/_npx/` 或 `/npm/_npx/` | `npx` | 拒绝——一次性运行,self-update 无意义 |
| 2 | `/.pnpm/_pnpx/` 或 `/.cache/pnpm/dlx/` | `pnpm-dlx` | 拒绝 |
| 3 | `/.bun/install/cache/` | `bunx` | 拒绝 |
| 4 | 不在任何 `node_modules/` 之下 | `checkout` | 拒绝——"running from a checkout; use git pull + pnpm build" |
| 5 | `/.volta/` 或 `/Volta/` | `volta` | 执行 `volta install @motrix/cli@<v>` |
| 6 | 在 `$PNPM_HOME` 之下,或 pnpm global 路径片段(`/.local/share/pnpm/`、`/Library/pnpm/`、`/AppData/Local/pnpm/`、`/.pnpm/global/`) | `pnpm-global` | 执行 `pnpm add -g @motrix/cli@<v>` |
| 7 | `/.config/yarn/global/`(Yarn Classic 默认)、`/.yarn/global/` 或 `/Yarn/Data/global/`(Windows) | `yarn-global` | 执行 `yarn global add @motrix/cli@<v>` |
| 8 | `/.bun/install/global/` | `bun-global` | 执行 `bun add -g @motrix/cli@<v>` |
| 9 | realpath 位于 `npm root -g` 之内(spawn 后做 realpath 包含比较) | `npm-global` | 执行 `npm i -g @motrix/cli@<v>` |
| 10 | 全部未命中 | `unknown` | 拒绝——**不**把 `npm i -g` 当作解法;警告盲跑 npm 可能造成 PATH 影子副本,并让用户用当初安装的包管理器更新 |

`yarn-global` 行必须包含 `/.config/yarn/global/`:那(而非 `/.yarn/global/`)
才是 Yarn Classic 的*默认*全局目录,漏掉它会把正常 yarn 安装误判为 `unknown`
——历史上这正是"推荐 npm → 制造影子副本"的诱因,而 cascade 本就是为避免它而存在。

廉价的同步路径检查在前;唯一的子进程(`npm root -g`)是最后一个探测。
结果是纯数据对象:

```ts
type InstallSource =
  | { kind: 'npm-global' | 'pnpm-global' | 'yarn-global' | 'bun-global' | 'volta'
      installArgs: string[]        // 例 ['pnpm', 'add', '-g', '@motrix/cli@X']
      globalRoot?: string }        // npm 场景已知(来自 `npm root -g`)
  | { kind: 'npx' | 'pnpm-dlx' | 'bunx' | 'checkout' | 'unknown'
      reason: string }
// 每个变体都带 manualCommand: string
```

### 第 2 步 — 先解析后安装(反 TOCTOU)

从**用户自有的中立目录**(`os.homedir()`,见下方方框)spawn
`npm view @motrix/cli@<target> version --json`。全局操作既不能被所在项目的
`.npmrc` / lockfile 捕获(Vercel 的教训),中立目录也不能是共享临时目录。若
npm 不存在(spawn `ENOENT`)且检测源为 pnpm,退回 `pnpm view`。解析:

- 单一版本 → 字符串;range 命中多个 → 数组,用自研 ~15 行 `compareSemver`
  取最高(数值 x.y.z + 简化的 prerelease 优先级;不引入新依赖)。
- 空输出(range 无匹配时 npm 以 0 退出)→ 解析错误。
- `EINVALIDTAGNAME` 一类错误(spec 本身格式非法)→ `EXIT.USAGE (2)`,
  reason `bad-target`。
- `E404` / 网络错误 → 解析错误,`EXIT.NETWORK (3)`。

### 第 3 步 — guards(pnpm 语义)

- 解析版本 == 当前 → **"Already up to date"**,退出 `0`,`changed: false`。
- 隐式 `latest` 且解析版本 < 当前(本地版本超前 registry)→ 拒绝降级,
  退出 `0`,`changed: false`,提示用 `motrix self-update <version>` 显式降级。
- 显式 `target` 允许降级——这就是回滚路径。

### 第 4 步 — `--dry-run` 到此为止

报告 `{ from, to, method, command }`,退出 `0`。

### 第 5 步 — 委托安装

从**中立目录**(见下方方框)spawn `installArgs`,输出全部 buffer
(npm 可能在安装中途弹交互提示;半显示的管道输出看起来像卡死)。若
stderr 含 `EACCES` / `EPERM`,附上 npm 官方的 prefix 迁移指引
(docs.npmjs.com → "Resolving EACCES permissions errors")——**绝不建议
sudo**。

非零退出**并不能证明树未被改动**——包管理器可能先替换文件再失败(生命周期
脚本、磁盘、依赖解析)。因此任何非零退出后,**观测实际装出的版本**(第 6 步
的观测:npm 查绑定 root,其余查 PATH),再分支:

- 观测 == `from` → 旧版完好 → `install-failed`,`changed: false`,
  `manualCommand` = 正向安装(可安全重试)。
- 观测 == `to` → 目标版竟已生效 → **成功**,并把安装器输出作为 warning 呈现。
- 观测为其他/无法运行 → 不确定、可能部分更新 → `install-failed`,
  `changed: true`,`manualCommand` = **回滚到 `from`**。

> **中立工作目录(安全)。** 所有包管理器子进程——`npm root -g`(检测)、
> `npm/pnpm view`(解析)、安装器、验证运行——都用 `cwd = os.homedir()`,
> 而非 `os.tmpdir()`。Linux 上 `os.tmpdir()` 即 `/tmp`(全局可写);包管理器
> 会从 cwd **及其祖先目录**读配置(Yarn Classic 合并祖先 `.yarnrc` 并遵从
> `yarn-path`),因此另一个本地用户可以预置 `/tmp/.yarnrc`,让一次被识别的
> self-update 以受害者身份执行其代码。home 归用户所有、在 `/tmp` 之外、其祖先
> 由 root 拥有——无注入面——同时 `~/.npmrc`(registry/auth)无论 cwd 都被读到,
> 于是"忽略当前项目配置"的性质得以保留。

### 第 6 步 — 验证

验证必须确认更新落到了**用户实际运行的那份安装**——而不仅仅是"某处某个安装
现在有目标版本"。

- **npm**(检测时绑定 root):只有 npm 捕获了 `globalRoot`——检测已用
  realpath 包含关系证明运行入口位于 `npm root -g` 之内。故 spawn
  `node <globalRoot>/@motrix/cli/dist/bin/motrix.js --version`(绕开 PATH、
  跨平台)。不匹配/无法运行 → `SELF_UPDATE_FAILED (7)`。若匹配,再额外查
  PATH 上的 `motrix`;此处 PATH 不一致是**遮蔽而非失败** → 成功带 warning
  (我们已*证明*绑定的树在目标版本)。
- **pnpm / yarn / bun / volta**(未绑定 root):无法证明 PATH 上的包管理器写到
  了哪棵树——另一个 global root 不同的 pnpm 会让一次新鲜的 `pnpm root -g`
  检查通过、却把运行的那份安装原封不动。故验证**用户实际得到的结果**:PATH 上
  的 `motrix` 现在报什么版本。匹配 → 成功。不匹配或无法运行 →
  `SELF_UPDATE_FAILED (7)`(**不是**警告——当用户的 `motrix` 仍跑旧版时,调用方
  绝不能读到 exit 0)。唯一仅警告的情形是"PATH 上还没有 `motrix`"(如新建的
  PNPM_HOME/volta bin 目录尚未进入当前 shell):已安装,但此处无法确认。
  - 我们刻意不再在验证时调用 `pnpm root -g`(它可能指向另一个 pnpm——正是
    错误树误报成功的根源)。
- Windows 备注:安装器会中途改写正在运行的命令的 `.cmd`/`.ps1` shim。这是
  安全的——node 已把 JS 载入内存——但命令在验证后立即打印结果并退出,
  安装之后不再运行其他逻辑。

> **残留边界。** 在两个同名包管理器、global root 不同、且更新后*错误*那个恰好
> 更靠前于 PATH 的病态情形下,PATH 检查仍可能读到目标版本而误报成功。彻底封堵
> 需要为每个包管理器做 root/prefix 绑定(而 `pnpm root -g` 本身不可靠);鉴于
> npm-global 是实际主流安装且*已*绑定,我们接受此边界并记录在案,而不去堆砌
> 脆弱的逐包管理器探测。

## 退出码与错误分类

向契约(`0/2/3/4/5/6`)新增**一个**码:`src/errors.ts` 中的
`EXIT.SELF_UPDATE_FAILED = 7`。

| 情况 | 退出码 | `--json.reason` |
|------|--------|-----------------|
| 更新成功 | `0` | —(`changed: true`) |
| 已是最新 | `0` | `already-up-to-date`(`changed: false`) |
| 隐式 latest 拒绝降级 | `0` | `downgrade-refused`(`changed: false`) |
| dry run | `0` | —(`dryRun: true`) |
| target 格式非法 | `2` USAGE | `bad-target` |
| registry 解析失败 / 网络 | `3` NETWORK | `resolve-failed` |
| npx / dlx / bunx 一次性运行 | `7` | `unsupported-ephemeral` |
| 从 checkout 运行 | `7` | `unsupported-checkout` |
| 未知安装源 | `7` | `unknown-install`(无 `manualCommand`) |
| 安装器失败、旧版完好 | `7` | `install-failed`(`changed: false`,`manualCommand` = 重试) |
| 安装器失败、状态无法确认 | `7` | `install-failed`(`changed: true`,`manualCommand` = 回滚) |
| 安装后验证不匹配 | `7` | `verify-failed`(`changed: true`,`manualCommand` = 回滚) |

**`unknown-install` 不带 `manualCommand`。** agent 会把该字段当成要执行的命令;
对 pnpm/yarn/bun 安装盲跑 `npm i -g` 会造出本命令要防的 PATH 影子副本。两条
unknown 路径(安装源无法归类;自身版本不可读)都只返回建议性文字——"用你当初
安装用的包管理器重装"——不给可运行命令。

**`verify-failed` 是"已部分改动"的状态,而非 no-op。** 安装器已 exit `0`,
全局树*已*被改动——结果报 `changed: true`(尽管 `ok: false`),`manualCommand`
是经检测到的包管理器**回滚到 `from`**(如 `npm i -g @motrix/cli@0.2.1`),而非
重跑正向安装。我们刻意**不**自动回滚:验证可能在一个完好的安装上失败(如
entry 路径假设过时),静默重装 `from` 反而会把健康的 CLI 降级,并多出一次
可能失败的变更。我们如实呈现状态加上精确的恢复命令,交由操作者决定。相比之下
`install-failed` 指安装器本身非零退出,树未被触碰(`changed: false`),旧版本
仍可用。

每个 `7` 的 payload 都带 `manualCommand`;人类可读消息以
"You can run it manually: `<cmd>`" 结尾。

`3` 里有一个细微差别:"npm 本身未安装"也归入 `3`(`resolve-failed`),
但与瞬时网络错误不同,它不会因重试而痊愈——message 会明说
("install npm or update manually")。

## 输出

- **TTY** — 一行:`Updated @motrix/cli 0.2.1 → 0.3.0 (pnpm)` /
  `Already up to date (0.2.1)`。
- **`--json` / 管道** — 成功:

  ```json
  { "ok": true, "changed": true, "from": "0.2.1", "to": "0.3.0",
    "method": "pnpm-global", "command": "pnpm add -g @motrix/cli@0.3.0" }
  ```

  无操作:`{ "ok": true, "changed": false, "reason": "already-up-to-date",
  "from": "0.2.1", "to": "0.2.1" }`——单一形状;不适用的字段(`warning`、
  `method` 等)直接省略而非输出 `null`,`from`/`to` 在两个版本都已知时出现
  (解析之前就拒绝的分支两者皆无)。dry run 追加 `"dryRun": true`(安装命令
  仍走同一个 `command` 字段)。失败结果带 `reason` + `manualCommand`。

## 注意事项

- **检测是启发式的。** 包管理器的全局布局随大版本变动(pnpm 的全局目录
  已迁移过两次)。`unknown → 拒绝` 是安全网;布局变化时补充新的路径片段。
- **nvm / fnm**:npm 全局安装位于*当前* node 版本的树内。切换 node 版本会
  让旧 CLI 复活。v1 不检测;仅文档说明。
- **`npm view` 的怪癖**:range 无匹配 → 空输出且退出 0;包/标签不存在 →
  E404。两者都按解析错误处理,但消息不同。
- **pnpm ≥ 10 默认阻止依赖的 postinstall 脚本。** `@motrix/cli` 没有
  (运行时依赖仅 `commander`)——将来引入原生依赖时需复查。
- **volta 的验证只做 PATH 检查**:volta 的镜像布局是私有的;我们信任
  `volta install` 的退出码加 PATH 检查。

## 架构与文件

| 文件 | 变更 |
|------|------|
| `src/pkg.ts`(新) | `readOwnPackageJson()` / `readOwnVersion()`——向上有界查找自身 `package.json` |
| `src/install-source.ts`(新) | `detectInstallSource(ctx)`——纯 cascade;各包管理器的安装/手动命令构造 |
| `src/commands/self-update.ts`(新) | `runSelfUpdate(opts, ctx)` 编排器,返回结构化结果(参照 `open.ts`);注入 `spawn`、`realpath`、`env`、`platform`、`argv1`、`tmpdir`、PATH 查找 |
| `src/errors.ts` | `EXIT` 新增 `SELF_UPDATE_FAILED: 7` |
| `src/program.ts` | 注册 `self-update`;加 `program.version(readOwnVersion())`;向 `pair` 传 `clientVersion` |
| `src/launch.ts` | 复用可注入 spawn wrapper 模式(方便的话抽取共享;`open` 行为不变) |

## 测试(TDD)

只做单测——不碰真实进程、文件系统、网络(全部注入),对照 `open.test.ts`:

- `src/pkg.test.ts` — src 深度与 dist 深度两种布局下的版本解析。
- `src/install-source.test.ts` — cascade 每一行(1–10)、symlink 经 realpath
  的输入、`PNPM_HOME` 环境变量、`npm root -g` 包含判定的 真/假/spawn 出错。
- `src/commands/self-update.test.ts`:
  - 每个可执行安装源(npm/pnpm/yarn/bun/volta)的 happy path → 正确的
    install args、`changed: true`、退出 0
  - 拒绝路径(npx/dlx/bunx/checkout/unknown)→ 退出 7、带 `manualCommand`
  - 解析:精确 / range 取最高 / dist-tag / 空输出 / E404
  - guards:已最新;隐式 latest 拒绝降级;显式降级放行
  - `--dry-run` 不发生安装 spawn
  - 安装器非零 → 退出 7、透出 buffer 输出;EACCES → 附指引、全程无 sudo
  - 验证不匹配:npm/pnpm → 退出 7;yarn/bun/volta → 警告、退出 0
  - `--json` 的成功 / 无操作 / dry-run / 失败四种形态
- `motrix --version` 打印包版本。

## 文档更新(本变更的一部分)

- `README.md` + `README.zh-CN.md`:命令表加 `self-update`;退出码表加 `7`
  行;记录 `--version`。
- `SKILL.md`:加 `motrix self-update` 与退出码 `7`;注明 agent 应把 `7`
  当作"该环境无法 self-update——不要重试",而 `3` 是可重试的。

## 版本

新的用户可见命令 + 新退出码 → **0.3.0**(semver minor)。按常规发版
(`chore(release): v0.3.0` + tag + `pnpm publish`)。
