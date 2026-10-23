# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。变更按 Added / Changed / Fixed 分组记录。

## [Unreleased]

### Added

- 增加 `plugin:status` / `plugin:verify` 只读快照与验证，以及默认预演、显式 `--apply` 的 `plugin:install` / `plugin:upgrade` / `plugin:uninstall` 收敛命令，支持路径覆盖与 `--json`；生命周期与版本检查均纳入 `npm run check`。
- 增加 DSH peers 有界兼容性判定：仅评估 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`，支持精确版本、`~`、`^`；其它范围明确报告 `unsupported-range`，并检查精确 `package@version` 豁免及其失效状态。
- 增加插件生命周期运维手册 `docs/lifecycle.md`，同步 README 入口与实施记录，区分离线检查、真机预演与待重启验收。
- 增加插件版本查看、默认 dry-run 的 bump、CHANGELOG 收口及离线一致性检查工具。
- 增加配置格式版本迁移链与磁盘迁移入口：`inspectConfigFormat` 判定 `current` / `migrated` / `future` / `unsupported`，`migrateConfigFileOnDisk` 默认 dry-run，写入前生成时间戳备份并在写后复读校验。
- `switchboard_selftest` 上报插件版本、manifest 版本、配置格式版本与格式状态。
- 新增「自办调度台」Agent preset（`switchboard-solo`）：与「分工调度台」共用 standard 插件清单，但通过 `excludedRoles: [worker]` 不组合 worker，由主代理承担实现；角色 preset id 按 `compositionKey` 分命名空间（`switchboard-role-*` / `switchboard-solo-role-*`），避免两个常驻 preset 撞上 `Duplicate agent preset`。现有预设同步启用中文名称「分工调度台」与中文说明。

### Changed

- 按 D31 将包安装与 bundle 登记留给 DSH 官方通道；仓库工具不改 `dependencies`、不执行 pnpm、不自动创建兼容豁免，仅维护本插件派生制品并报告人工步骤。当前格式的用户角色文件保持原始字节；缺失时优先用根条目 legacy `roles` 播种，纯 split（`roleSettings`）模式拒绝播种空文件并退出 `3`。
- 安全卸载先剥离并复读验证内联 preset，再提示移除包，避免悬空引用破坏 profile 启动；默认保留 `roles.json`，包仍登记时拒绝 `--purge-roles`。
- 以 `package.json.version` 为插件版本唯一事实来源，按 SemVer 2.0.0 管理正式版与预发布版；manifest 与配置格式各自独立演进。
- 版本 bump 永不自动 commit 或 tag；显式 `--apply` 才写入，使用原子替换与写后复读校验。
- 配置写入门禁：较新或未知格式（`future` / `unsupported`）硬拒绝且不生成备份；较旧但可迁移（`migrated`）在写入时自动备份并迁移，避免拒绝写入而静默丢弃用户的设置修改。

### Fixed

- 修复 `plugin:verify` 把“没验证”当成通过的问题：runtime / peers / 生成物判据未知时状态改为 `unverified` 并退出 `1`，显式 `--allow-unknown` 才接受；CLI-managed profile 不再拿 Electron 归档版本冒充运行时，新增 `--runtime-version`。
- 修复 split 模式（设置层只有 `roleSettings`）缺 `roles.json` 时播种空文件并返回 `0`、运行期角色全部失效的问题：拒绝空播种，`verify` 增加 `roles.definitions`；legacy 完整 `roles` 可直接播种并在同一次 install 内裁成 `roleSettings`。
- 修复 `--purge-roles` 删除 home 级共享 `roles.json` 时只看当前 profile、会破坏其它仍登记本包 profile 的问题；现在拒绝发生在任何写入之前。
- 修复卸载扫描漏掉 home 级 `$DSH_HOME/cordis.patch.yml` 的问题，并把未登记但残留 profile preset 的情况从 `skipped` 改为 `inconsistent`。
- 修复兼容豁免键使用仓库版本而不是已安装版本的问题；卸载时提示 `compatibility.json` 中的残留授权，不自动删除。
- 修复缺失 `cordis.patch.yml` 时 install/upgrade/uninstall 以 ENOENT 失败的问题：缺失按空用户层处理。
- 退役 `inject:preset`：`probe-preset.mjs --inject` 现在硬拒绝，自检提示改为“确认 bundle 登记 + plugin:verify + 重启”，避免重新制造重复 preset 声明。
- 修复外部 CLI 角色的回流区把**过程与工具轨迹当成正文**平铺的问题：一次性子会话的 CLI 观察席改为
  **按通道分区** —— 正文区只显示 stdout（CLI 的最终消息，流式贴底），stderr 归入默认折叠的
  「过程与诊断」（失败且用户未手动干预时自动展开并改用错误色），并把它自己上报的路由事实
  （`model` / `sandbox` / `reasoning effort` 等）单独显示在折叠区之外，避免折叠后丢失
  「配置真的生效」这条证据。判据是通道而非文本猜测：codex 非 `--json` 模式下过程轨迹全在
  stderr（`docs/cli-backends.md` §2.4）。chunks 仍原样保留，有界与 gap 语义不变。
- 修复设置面板把旧 Windows 形态的 codex 预设（`{npmRoot}\@openai\codex\bin\codex.js`）判为
  「需重选预设」的问题：客户端镜像的驱动反推补齐 Host 已有的分隔符归一与「缺省即空数组」语义，
  否则 Host 接受的角色在界面里被标成配置错误，且保存闸门检查整份列表会拦下任何一次保存。
- 修复读取器进入封锁状态后，损坏 JSON 会清除封锁并复活过期缓存配置的问题。
- 修复 `fix-cli-models.mjs` 绕过格式门禁直接覆写配置、可在未知格式下清空角色数据的问题。
- 修复磁盘迁移期间文件被并发修改时静默覆写的问题。
- 修复迁移备份文件名可碰撞、后续运行覆盖既有备份的问题。

### Known limitations

- 新增运行时自检版本字段与格式门禁尚待 DSH 完整重启后真机验收；desktop 真机预演已验证零写入，真实生命周期写入、CLI 包安装 / 移除和 GUI 按钮文案仍未验证。代码或版本升级需完全退出并重启，reload 不能应用模块升级。
- 配置格式为 `future` / `unsupported` 时，Host 会拒绝写入并在诊断与自检中标为不健康，但 GUI 设置页尚未接入该错误，可能仍提示保存已接受。

## [0.0.1]

### Added

- 记录当前插件基线版本；此前实现与真机验收记录见项目文档。
