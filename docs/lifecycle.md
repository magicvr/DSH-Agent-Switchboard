# 插件生命周期与版本管理

## 1. 机制与职责边界

生命周期机制采用「检测 + 指令 + 收敛派生制品 + 验证」（D31），不是第二个安装器。`scripts/ops/plugin-lifecycle.mjs` 不修改 profile 的 `dependencies` 或 bundle 登记，不执行 `pnpm`，也不自动创建 `compatibility.json`。它读取实际状态、提示 DSH 人工步骤，同步或剥离本插件的内联 preset，处理角色文件并复验。

这是受 DSH 契约约束的分工：实测 `dsh plugin --profile desktop ...` 硬拒绝，报 `error: profile "desktop" is managed exclusively by the Electron application`；desktop 包管理只能走 Electron GUI Plugins 页。非 desktop 的 CLI 必须指定 `--profile <name>`，缺省实测报 `error: required option '--profile <name>' not specified`。依据 CLI 自述与源码，它把参数转交给 profile 目录内的 `pnpm`；本文的 `add <spec>` / `remove <name>` 形式未实测。遵循 [`architecture.md` §3](./architecture.md#3-dsh-插件契约已核实)，不要手写 profile 安装登记或手动运行 pnpm；本工具的定向 preset 收敛是派生制品维护，不代替 DSH 安装。

| 责任方 | 负责内容 |
| --- | --- |
| DSH | 包安装与移除、`dependencies` 和 `dsh.profile.bundles` 登记、兼容性门禁、模块加载 |
| 本仓库工具 | 漂移的仓库 preset 再生成、剥离 profile 里残留的内联 `preset-switchboard`（权威副本在仓库，由 `dsh.bundle.patch` 投递）、`roles.json` 播种和格式迁移、状态采集与验证、仓库版本收口 |
| 使用者 | 完成人工包步骤和必要的兼容性确认、配置角色、完全退出并重启 DSH |

本地目录以 `link:` 依赖安装。profile `package.json` 中必须同时有包依赖与 `dsh.profile.bundles` 成员；只有依赖会静默不加载。`status` 分别报告依赖 spec、bundle 成员资格和磁盘 `node_modules/<包名>/package.json` 的可解析性，三者不能互相替代。

## 2. 命令参考

在仓库根运行；npm 参数使用独立的 `--` 分隔。下表的五个生命周期别名均已运行 `--help` 确认；版本 `show` 与不写盘的 `bump major|minor|patch|0.0.2`、`bump minor --pre rc` 已实际运行成功。写入参数与 `--finalize` 已对照源码及离线检查，本文未在真实环境执行，实际运维效果仍未验证。

| 命令 | 参数与行为 |
| --- | --- |
| `npm run plugin:status -- [路径参数] [--json]` | 只读快照；漂移也返回 `0`，不是严格验收 |
| `npm run plugin:verify -- [路径参数] [--json]` | 只读验证；存在验证问题返回 `1` |
| `npm run plugin:install -- [路径参数] [--json] [--apply]` | 包登记齐备后同步 preset；缺角色文件时播种当前格式的 `roles: []`，旧格式可迁移时迁移 |
| `npm run plugin:upgrade -- [路径参数] [--json] [--apply]` | 同步 preset 和可迁移格式，报告 manifest 变化、DSH peers 与版本差异；保留当前格式用户文件的原始字节 |
| `npm run plugin:uninstall -- [路径参数] [--json] [--apply] [--purge-roles]` | 先剥离并验证 preset，再提示移除包；默认保留角色文件 |
| `npm run version:show` | 只读列出插件、manifest、配置格式、lock、CHANGELOG 与 DSH peers；检查插件版本一致性 |
| `npm run version:bump -- <major\|minor\|patch\|X.Y.Z> [--pre <tag>\|--finalize] [--apply]` | 默认只展示计划；显式版本必须是合法 SemVer 且严格高于当前版本 |

两个工具均支持 `--help`：直接运行 `node scripts/ops/plugin-lifecycle.mjs --help` 或 `node scripts/ops/plugin-version.mjs --help`，均在路径或制品读取前输出用法并退出 `0`（本轮实测）。生命周期帮助列出五个子命令、全部运维及路径参数和退出码；版本帮助列出 show、bump、预发布参数约束及不创建备份、不自动 commit/tag 的边界。版本工具不支持 `--json` 或路径参数，`show` 不接受额外参数。

### 2.1 路径与输出

五个生命周期命令共用以下带值参数；相对路径以启动工作目录解析，输出显示路径来源：

| 参数 | 缺省值与作用 |
| --- | --- |
| `--home <path>` | 优先于 `DSH_HOME`，否则使用用户 home 下 `.dsh` |
| `--profile <path>` | 缺省为 home 下 `profiles/desktop`；这里是目录路径，区别于 DSH CLI 的 profile 名称 |
| `--patch <path>` | 缺省为 profile 下 `cordis.patch.yml` |
| `--roles-file <path>` | 缺省为 home 下 `agent-switchboard/roles.json` |
| `--cwd <path>` | 缺省为仓库根；显示工作目录，不改变本工具的仓库根或安装 spec |

共享路径解析器还接受 `--cli-config <path>`，但生命周期不读取该配置，帮助文本也未列出；不要依赖它改变生命周期行为。路径参数已对照代码，合成 profile 用例验证了路径隔离，未在本轮针对真实目标逐个运行。

`--json` 输出单份 JSON 快照；收敛命令附带 `operation.command`、`apply`、`events` 和 `exitCode`。`status` / `verify` 不接受 `--apply`；`--purge-roles` 仅适用于 `uninstall`。

### 2.2 预演、写入与退出码

`install` / `upgrade` / `uninstall` 默认 dry-run，**没有 `--dry-run` flag**。省略 `--apply` 不写目标、不创建目录或备份；只有显式 `--apply` 才写，包括 git 跟踪的 `presets/switchboard.patch.yml` 与 `presets/standard-plugins.json`（生成器现在同时产出这两份：preset 声明 + 角色 preset 的行模板）。发生变更时先做结构、格式与权限预检；profile patch 与角色文件生成独立时间戳备份，写后复读验证。仓库 preset 通过既有生成器写入，不另写 `.bak`，并复读检查字节改变及生成物达到 `current`；当前制品一致时不重复写入。反复运行是安全的，并会报告剩余步骤；人工包步骤仍必须由 DSH 完成。

| 退出码 | 生命周期含义 |
| --- | --- |
| `0` | 收敛目标一致；`status` 正常采集即为 `0`，`verify` 跳过未安装插件或不存在的默认 profile 也为 `0` |
| `1` | 失败或仍有未修复问题，包括 dry-run 仍有待写入变更；显式目标缺失时 `verify` 失败 |
| `3` | 人工包安装、更新、移除或兼容豁免步骤待完成；也可能尚未写盘，不能据此推断已发生写入 |

这是面向 CI 的约定：预演发现待办可以非零，不等于工具崩溃；`0` 也不证明新模块已被运行进程加载，或所有归档判据都已验证。

版本工具另有退出码语义：`show` 一致或 `bump` 计划合法返回 `0`，错误返回 `1`，没有 `3`；bump dry-run 即使有计划变更也返回 `0`。`--pre <tag>` 生成或递增预发布版本；`--finalize` 仅用于把当前预发布版收为正式版，两者互斥，均不能与显式版本混用。`--apply` 更新 `package.json.version`、lock 根与 `packages[""].version`，将 `[Unreleased]` 正文移入带日期的新版本段，留下空 `[Unreleased]`。它不改 manifest 或配置格式版本、不操作 git、不安装包、不重启；三个文件逐个原子替换和复读，没有跨文件事务，也不另写 `.bak`。

## 3. 安装与升级场景

以下是操作顺序，含 `--apply` 的真实写入流程未在本轮执行；合成 profile 检查覆盖收敛，真实 dry-run 证据见 §6。

### 3.1 首次安装：desktop

1. 运行 `npm run plugin:status`，再用 `npm run plugin:install` 预演。包未登记或不可解析时，工具给人工安装步骤并返回 `3`，不写派生制品；profile 本身不存在或无效则拒绝收敛。
2. 在 Electron DSH 的 Plugins 页安装本仓库目录对应的 `link:<仓库绝对路径>` 并启用插件。GUI 的确切按钮文案（例如「添加插件」「安装」「立即启用」）**未验证**，不要把工具提示当作已核实 UI 文案。包管理与登记由 DSH 完成。
3. 再运行 `npm run plugin:status`，确认依赖、bundles 与磁盘包体三项齐备。运行 `npm run plugin:install` 查看剩余差异，审阅后运行 `npm run plugin:install -- --apply`（本轮真实写入未验证）。缺失角色文件只播种空列表，不猜用户角色；随后在设置页配置角色。
4. 运行 `npm run plugin:verify`，处理兼容性等剩余项，完全退出并重启 DSH，再用 `switchboard_selftest` 验收运行时。离线 verify 不等于运行时自检。

### 3.2 首次安装：cli-managed

对已存在的非 desktop profile，使用 `--profile <profile目录>` 明确选择目标，重复上述检测、预演、收敛与复验步骤。人工包步骤候选形式为 `dsh plugin --profile <name> add <spec>`，其中 spec 为 `link:<仓库绝对路径>`：**依据 CLI 自述与源码，未实测**。安装后必须再次确认 `dependencies`、`dsh.profile.bundles` 和包体；不因 CLI 调用成功就假设 bundle 已登记。

**不要用 `dsh plugin --profile <name> --help` 作只读探针。** 已实测它不会短路，首次使用会初始化 profile，曾尝试写入 profile 的 `package.json.lock`。

### 3.3 版本 bump 后升级

1. 用 `npm run version:show` 检查基线，运行 `npm run version:bump -- patch` 或选定类型预演。审阅后才使用 `--apply`（本轮真实写入未验证），再用 `version:show` 复核三个文件。
2. 运行 `npm run plugin:upgrade`。preset 由 bundle 投递、不依赖 profile 内联副本；profile 里若还留着历史注入的副本，同步会剥离它；预演报告仓库生成物漂移及待再生成步骤，不写盘。DSH 归档可读且生成物判定为 `drifted` 时，`install` / `upgrade --apply` 自动调用既有 `scripts/gen-preset.mjs`，无需先手工生成；不要手改生成 YAML。
3. 审阅后运行 `npm run plugin:upgrade -- --apply`（本轮真实写入未验证）。版本不匹配时按 DSH 官方通道更新包；若 `link:` 已直接解析到新版本，可能无需重装包。兼容性不通过时由使用者确认豁免，工具不代写。反复运行升级直到制品一致，并运行 `plugin:verify`。
4. **版本变化或任何插件 JavaScript 变化都要完全退出并重启 DSH。** Node 模块缓存不能驱逐，reload、开关插件或再次安装不能代替进程重启。重启后再核对自检版本与格式门禁。

再生成通过 `captureSync(process.execPath, [<仓库根>/scripts/gen-preset.mjs], { cwd: <仓库根>, env, ... })` 执行，使用 `shell: false` 与临时文件描述符捕获输出，避免受限 Windows 管道派生的 `EPERM`。工具逐步报告生成器输出、再生成后复读验证、注入和写后验证。生成器非零退出或产物未改变、未达到预期 `current` 均返回 `1`，不得继续注入。归档不可用或读取失败时明确报告「未验证」及原因，提示手工回退 `npm run gen:preset`，继续同步已有且有效的制品；不能据此声称生成物已验证。`status` / `verify` 始终只报告，不再生成。

`status` 的 `nextStep` 目前还可能提示底层生成 / 注入命令；支持的收敛入口是本节的 `plugin:install` / `plugin:upgrade`，单独生成只作为手工回退。

## 4. 配置格式与兼容性门禁

`package.json.version` 是插件版本事实来源；`dsh.manifestVersion` 与 `CONFIG_FORMAT_VERSION` 分别演进。角色文件的有序纯函数迁移链目前含 `0 → 1`，缺失文件与格式不支持不能混为一谈。

| 格式判定 | 写入语义 |
| --- | --- |
| `current` | 当前格式；生命周期无迁移需求时保留原始字节 |
| `migrated` | 较旧且可迁移；写入时自动迁移，先做时间戳备份，再写盘并复读验证 |
| `future` | 较新或未知格式；硬拒绝写入，不生成备份 |
| `unsupported` | 无法迁移的格式；硬拒绝写入，不生成备份 |

`status` / `verify` 只报告，不自动迁移磁盘文件。安装和升级遇到不可安全迁移的文件，会在 preset 写入前拒绝。运行时写入门禁也已实现，但重启后的真实行为尚未验收。**已知客户端限制：** `future` / `unsupported` 被硬拒绝时，GUI 设置页可能仍提示保存已接受；文件实际未写入，Host diagnostics 报告错误并把插件标为不健康，客户端尚未接入该错误展示。

兼容性判定只评估 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peers，镜像 DSH 门禁，不把 `engines.*` 当作已执行约束。范围判断仅支持完整精确版本、`~`、`^`，采用包含预发布版本的边界比较；其它语法给出 `unknown` / `unsupported-range`，不猜测。运行时版本来自 Electron 安装归档的 `dsh/package.json`，**不证明当前进程已运行该版本，也不使用另装 CLI 的版本代替**。

> ⚠️ **两侧语义必须分清（`0.2.1-rc.1` 已核实）：** DSH 自己的门禁（`dsh-app-boot.unmetRequirements()`）是「manifest 声明了 `engines.dsh`（字符串）则**它单独决定并忽略全部 peers**，否则逐条校验 DSH peers」。本仓库工具与 `check-profile-wiring.mjs` 复刻的是**后一条分支**，因为本插件的 `package.json` **刻意不写 `engines.dsh`**——peer 精确 pin 是唯一真源，写了会静默覆盖 peers。旧说法「`engines.*` 不被当作已执行约束」只对 `0.2.0-rc.2` 成立（那个版本从不读 `engines`）。**当前本插件四个 dsh peers 精确 pin 到 `0.2.1-rc.2`，每次 DSH 升级都必须手工重 pin**：范围会让仓库 `node_modules` 解析到与运行时不同的构建，离线检查按错误接口版本通过（见 D32）。

**DSH 升级后的固定仪式（每次都照做，不要跳步）：**

1. `node scripts/ops/plugin-lifecycle.mjs verify` —— 看裁决。`DSH peers：incompatible` 就是被门禁拒载了（症状：设置页静默消失，只写 stderr）。
2. **判断是「只改版本坐标」还是「接口真的变了」：`npm run dsh:delta`。** 它把 pin 的版本与本机运行时版本都从 registry 取下来，对**契约面 12 个包**逐文件做 sha256 比对（代码与资产/配置分开判定），并单独报告上游 `presets/standard.patch.yml` 是否变化。退出码：`0` = 只改版本坐标，可以放心重 pin；`1` = 有接口/实现文件变化，必须先进代码核对；`2` = **无法判定**（归档不可用、registry 取不到、或某包在该版本尚未发布）——`2` **不等于安全**，只是没比对上。命令只读，不改任何仓库文件；它刻意不替你改 pin。
   - 手动等价做法（命令不可用时）：用 `npm pack @deepseek-ai/<pkg>@<旧版>` 与本机运行时版本分别取包，对每个包的非 `package.json` 文件做哈希比对。
   - 已实测：`0.2.1-rc.1 → rc.2` 报 `0`（12 个包除版本坐标外逐字节相同；唯一差异是 `dsh-web-app` 的 `cordis.patch.yml` 这个本插件不消费的资产文件），而 `0.2.0-rc.2 → rc.2` 报 `1` 并列出真实变化的代码文件。
3. 改 `package.json` 的四个 dsh peer pin（`cordis` / `schemastery` 若归档里也变了则一并改），然后 `npm install` 重生成 lock 与 `node_modules`。
4. `npm run check` 全链；`node scripts/check-profile-wiring.mjs` 会断言仓库 peers 满足归档运行时、且 `node_modules` 每个 `@deepseek-ai/dsh*` 与运行时同版本。
5. `node scripts/ops/plugin-lifecycle.mjs verify` 应回到 `consistent`。**profile 不需要内联 preset**（声明由 `dsh.bundle.patch` 投递；仓库生成物变了只需 `gen:preset`）；若上游 `standard.patch.yml` 变了，`check:preset` 会报漂移，先 `npm run gen:preset` 再 `upgrade --apply`。
6. 完全退出并重启 DSH，再跑 `plugin:verify` 与 `switchboard_selftest`。

> **刻意不提供「按运行时版本自动改写 pin」的命令**：那种命令会在没有核对接口差异的前提下让插件加载到可能已破坏 API 的运行时上，正是本项目一直在防的静默失效。`npm run dsh:delta` 只做**判定**（只读、可自动化），改 pin 仍由人看过结论后手动改——摩擦降在判定上，不降在把关强度上。

`compatibility.json` 豁免按精确 `package@version` 查找，值为允许的 DSH 版本字符串数组。插件版本改变后旧键在 DSH 中静默失效，工具会报告 `expired`；当前运行时不在数组中也会失败。工具只提示人工处理，GUI 豁免按钮和流程、CLI 豁免子命令均未验证。

## 5. 安全卸载与排障

卸载顺序不能颠倒：先运行 `npm run plugin:uninstall` 预演，再运行 `npm run plugin:uninstall -- --apply` 剥离并复读验证内联 preset（真实写入未验证）。剥离后扫描移包后仍保留的 profile 配置：profile patch（`s.paths.patch`，默认 `cordis.patch.yml`）及 `<profile>/cordis.yml`（若存在）的所有深度包引用，含其它 id、等价字段和 YAML alias。仓库自身 bundle patch 随包分发、随包移除，不会留下悬空引用，因此明确排除。残留引用按文件、行号与 enclosing id 报告，说明条目位于 profile、移包将留下悬空引用，退出 `1`，不输出移包步骤、不允许 purge。工具刻意不删除用户编写的内容；使用者须自行解决或移除所列条目后重新运行。不能将仅 preset id 消失视为可移包的证明；profile 引用确已消失后才提示 DSH 移除包。

再由 desktop GUI 移除包（按钮文案未验证），或采用非 desktop 的候选 `dsh plugin --profile <name> remove <包名>`（依据 CLI 自述与源码，未实测）；重新运行卸载命令确认剩余步骤。`roles.json` 是用户数据，默认保留。仅在包已从 dependencies 与 bundles 都移除后，才可审阅并运行 `npm run plugin:uninstall -- --purge-roles --apply` 删除它（本轮真实写入未验证）；包仍登记时 `--purge-roles` 被硬拒绝，须先不带该参数完成安全剥离。

收敛写入携带规划时的原始字节，备份前及替换前复读比较；变化时拒绝覆盖并要求重新运行。再生成前后也复核 profile 与角色快照，生成器接收规划快照摘要并在 rename 前再次比较。角色格式迁移与运行时保存同样在 rename 前比较检查时的内容，失败清理临时文件；purge 紧邻删除时重读 profile `package.json`，读取失败或重新登记均拒绝删除。此复读检查不是文件系统级 compare-and-swap，不保证阻止复读与 rename 之间极短窗口内的编辑。

- **有依赖却不加载：** 查看 `registration` 三项，尤其 `dsh.profile.bundles`；通过 DSH 官方通道补齐登记，不手写 package.json。
- **归档不可用：** 设置指向可读取归档的 `DSH_ASAR` 后重跑 verify。Windows 默认安装位置由 `LOCALAPPDATA` 或用户 home 推导，非 Windows 必须显式设置。归档缺失或解析失败时生成物 / 运行时判据降级为「未验证」，不伪造一致性；verify 可能仍返回 `0`，须同时看 unknown 与原因。
- **改动未生效：** 完全退出并重启 DSH；preset 已同步、verify 成功或 reload 都不能证明新 JavaScript 已加载。

## 6. 验证状态（2026-10-03）

### 6.1 离线已验证

卸载扫描范围修复后，实际运行 `node scripts/check-lifecycle.mjs`：**169 通过 / 0 失败**，`npm run check` 全链退出 `0`。合成 profile 验证只有注入 preset 引用时剥离后可达人工移包步骤（退出 `3`），包内 bundle 自引用不阻塞；profile patch 与可选 `cordis.yml` 的残留引用仍拒绝移包和 purge，保留用户内容。手工将仓库 bundle patch 重新加入扫描列表，新增可达性断言失败：**168 通过 / 1 失败**；手工恢复后 **169 通过 / 0 失败**。所有写入都在 `node:os` 的 `tmpdir()` 夹具内，不等于真实 profile 写入验收。

此前实施阶段记录的 `node scripts/check-lifecycle.mjs`：**144 通过 / 0 失败**；`node scripts/check-version.mjs`：**107 通过 / 0 失败**。`npm run check` 全链退出 `0`，包含 `check:lifecycle` / `check:version` 对应检查。合成 profile 验证路径隔离、零写入预演、幂等收敛、备份和写后复验、卸载顺序屏障、格式拒绝和有界兼容性范围；新增 tmpdir 仓库、ASAR 与真实生成器夹具验证再生成后重新注入、第二次零写入、生成器失败及假成功的拒绝屏障、归档不可用降级与两个帮助入口。手工将再生成调用替换为不写文件的假成功，检查为 **137 通过 / 7 失败**；手工恢复后回到 **144 通过 / 0 失败**。这些不等于真实 profile 写入验收。

独立 `npm run check:preset`（即 `node scripts/gen-preset.mjs --check`）比对**两个**生成物：`presets/switchboard.patch.yml` 的**逐字节**内容（含两个 preset 的名称、说明、`supervisorRules`、`compositionKey` 与 `excludedRoles`）与 `presets/standard-plugins.json` 的逐字节内容（后者是角色 preset 的行模板，供 Host 在运行期按角色裁剪）。本机实测（2026-10-23 加入自办调度台后，默认归档路径）：归档可读，输出 `standard 插件数: 22` / `preset 数: 2，每个 23 行` / `!!js 表达式 2 → 4`，两个产物均报无漂移，`--check：一致。`（退出 `0`）。同一批运行中 `node scripts/check-lifecycle.mjs` 为 **231 通过 / 0 失败**，`npm run check` 全链退出 `0`。**该检查在 `0.2.1-rc.1` 升级落地时还不在 `npm run check` 主链内**，这是上游 standard 漂移（新增 `dsh-time-context` / `dsh-tool-schedule` / `dsh-plugin-market/tools`，移除 `tool-subagent-codex` / `tool-subagent-claude-code` / `tool-ralph`）长期未被发现的原因；现已作为 `check` 链的最后一步。归档不可用时生成器失败并退出 `1`，属于「未验证」，不能读成一致。

### 6.2 真机已验证

本次机制实施阶段已提供的 desktop 验收证据：`status`、`verify`、install 预演、upgrade 预演均退出 `0`，uninstall 预演退出 `1`；运行前后 profile `cordis.patch.yml` 的 SHA-256 完全相同，新增备份文件数为 **0**，证明预演无写入。这里的预演指省略 `--apply`，不是不存在的 `--dry-run` flag。

卸载扫描范围修复后重新只读运行 `node scripts/ops/plugin-lifecycle.mjs uninstall`，退出 `1`，提示「未写盘：必须先 --apply 剥离并验证 preset，之后才可移除包」。profile patch 字节与备份列表未变。只在内存中规划剥离后扫描，仍发现 profile `cordis.patch.yml:115 id=agent-switchboard` 的包引用；该条目在移包后保留，故 `--apply` 路径拒绝移包指令是正确结果。profile `cordis.yml` 本轮未发现包引用。真实 `--apply` 未执行；读取时出现既有 `!!js` 未解析标签警告，不视为运行时验收。

desktop CLI 硬拒绝、CLI 必须带 profile 及带 profile 的 `--help` 会初始化的证据来自本次实施阶段的直接调用；`link:` 安装还有 [`plan.md`](./plan.md) Phase 1 的历史真机记录。CLI `add` / `remove` 没有真实安装或移除验收。

### 6.3 仍未验证

`0.2.1-rc.1` 迁移已通过一次**真实重启**验收（见 §6.4）：插件正常装载、`plugin:verify` 报 consistent、角色 preset 在运行期注册成功。**自办调度台（`switchboard-solo`）的 2026-10-23 完全重启验收：** 根实例 `switchboard_selftest` 的 roster 同时出现 `switchboard`、`switchboard-solo`、`switchboard-role-scout`、`switchboard-role-worker`、`switchboard-solo-role-scout`，`preset 异常行：（无异常行）`；双 preset 声明与角色 preset 命名空间隔离已真机通过。**仍未验收：** 选中自办会话后实际只挂载 3 个角色工具（无 `delegate_to_worker`）并完成一次真实派发。⚠️ **D33 之后 preset 数量是「spawn 角色数」而非角色总数**：CLI 角色直派后台任务，不再产出 preset —— 真机自检的 `preset roster` 已印证（`worker` 这个 `cli` 角色不在其中，其余三个 spawn 角色在）。**「实际挂载 + 一次真实派发」已于 2026-10-18 补齐**：在选中 Switchboard preset 的会话里对 `worker`（`cli(codex)`）派发真实任务，工具**立即**返回 `{status:'accepted', jobId}`，随后收到独立完成通知（jobId 一致），`job_output` 读到有界输出；并用「让 CLI 回报 `sha256(src/roles.js)` 与 HEAD、取证方在仓库侧独立重算」的手法排除了自述水分 —— 两项逐字一致（详见 [`architecture.md`](./architecture.md) §6 真机取证）。**仍未验收**：GUI 取消/停止沿 `exec.signal` 的传播、客户端任务面板的视觉表现（折叠与失败自动展开）。**嵌套 spawn 派发已于 2026-10-18 验收通过**（`cliDispatchFor` 那条嵌套 CLI 路已随 D34 删除、无对象）：主代理 → worker（spawn）→ scout 三级观测显示，depth=2 子代理结束后运行时把通知推给**直接父级**并**唤醒**它，父级再把结论转报主代理 ⇒ 结果逐级冒泡 ✓（详见 [`architecture.md`](./architecture.md) §6 与 D34）。`fork` 后端移除后的角色校验属该批；`cliToolFor` 子作用域注册已随 D33 删除。客户端半边**仅静态核实 + 一节的真实渲染断言**，未做完整 GUI 往返（split 旋钮表单的「取消/保存」启用与取消行为已由离线真渲染断言覆盖，界面按钮位置已由用户真机确认）。GUI 安装、启用、卸载及兼容豁免按钮的确切文案未验证；本轮未执行包安装 / 移除或版本写入。客户端拒绝保存的错误展示仍是已知限制。

### 6.4 当前本机状态（真机实测）

**profile 重新注入：** 运行 `node scripts/ops/plugin-lifecycle.mjs upgrade --apply`，输出 `DSH peers：compatible`、`PASS 写后复读验证`，原文件备份为 `cordis.patch.yml.bak-lifecycle-2026-10-17T09-03-32-369Z-226b6e831bdd`；注入前 `check-profile-wiring` 曾报 `12 通过 / 1 失败`（profile 内联着 `0.2.0-rc.2` 时代的旧 preset 正文），注入后为 **13 通过 / 0 失败**。

**重启后真机结果（2026-10-17，DSH `0.2.1-rc.1`）：**
- `node scripts/ops/plugin-lifecycle.mjs verify` → `验证：consistent`、`下一步：已就绪`；Electron DSH runtime `0.2.1-rc.1`；`DSH peers：compatible`；精确豁免 `absent`（不需要豁免）。
- 主代理调用 `switchboard_selftest`（根实例）→ `健康：健康`、无 fatal；配置 4 个角色；`roleConfig` 读取 4 个并与文件一致。
- **四个角色 preset 在运行期注册成功**：preset roster =
  `standard ptc minimal cordis switchboard switchboard-role-architect switchboard-role-reviewer switchboard-role-scout switchboard-role-worker`，
  `preset 异常行：（无异常行）`。这验证了 `agentPresets.register()` 接受本插件组装的角色 preset，且行组合通过真实注册表校验——是本轮移植最关键的一条真机证据。

**再次升级到 `0.2.1-rc.2`（同日）：** DSH 随后升到 `0.2.1-rc.2`，四个精确 pin 再次不匹配、插件再次被门禁拒载（这正是精确 pin 的已知代价）。逐包 SHA-256 对比确认 `rc.1 → rc.2` **只改版本坐标**：所有相关包的代码树逐字节相同，上游 `standard.patch.yml` 也相同，因此**零代码改动**，只把四个 peer pin 改成 `0.2.1-rc.2`。重装依赖后 `npm run check` 全链退出 `0`、`plugin:verify` 报 `DSH peers：compatible / 验证：consistent / 下一步：已就绪`，**profile 无需重新注入**（preset 正文未变）。
- 该会话使用 `standard` preset，根实例自检据此如实报告「本作用域不挂载角色工具；配置中有 4 个角色」。

**仍待完成：** **完全退出并重启 DSH**，然后跑 `plugin:verify` 与 `switchboard_selftest`。重启之前不能宣称已真机验收——角色 preset 的实际注册、`agentPreset` 装载期校验、子代理拿到的工具可见性与只读裁剪都还只有离线证据。
