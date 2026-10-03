# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。变更按 Added / Changed / Fixed 分组记录。

## [Unreleased]

### Added

- 增加插件版本查看、默认 dry-run 的 bump、CHANGELOG 收口及离线一致性检查工具。
- 增加配置格式版本迁移链与磁盘迁移入口：`inspectConfigFormat` 判定 `current` / `migrated` / `future` / `unsupported`，`migrateConfigFileOnDisk` 默认 dry-run，写入前生成时间戳备份并在写后复读校验。
- `switchboard_selftest` 上报插件版本、manifest 版本、配置格式版本与格式状态。

### Changed

- 以 `package.json.version` 为插件版本唯一事实来源，按 SemVer 2.0.0 管理正式版与预发布版；manifest 与配置格式各自独立演进。
- 版本 bump 永不自动 commit 或 tag；显式 `--apply` 才写入，使用原子替换与写后复读校验。
- 配置写入门禁：较新或未知格式（`future` / `unsupported`）硬拒绝且不生成备份；较旧但可迁移（`migrated`）在写入时自动备份并迁移，避免拒绝写入而静默丢弃用户的设置修改。

### Fixed

- 修复读取器进入封锁状态后，损坏 JSON 会清除封锁并复活过期缓存配置的问题。
- 修复 `fix-cli-models.mjs` 绕过格式门禁直接覆写配置、可在未知格式下清空角色数据的问题。
- 修复磁盘迁移期间文件被并发修改时静默覆写的问题。
- 修复迁移备份文件名可碰撞、后续运行覆盖既有备份的问题。

### Known limitations

- 配置格式为 `future` / `unsupported` 时，Host 会拒绝写入并在诊断与自检中标为不健康，但 GUI 设置页尚未接入该错误，可能仍提示保存已接受。

## [0.0.1]

### Added

- 记录当前插件基线版本；此前实现与真机验收记录见项目文档。
