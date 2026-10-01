# 贡献指南

## 当前阶段

Host、Client 角色设置页、CLI provider 与角色委派已实现并完成真机验收。贡献可以围绕功能修复、针对性检查与文档校准展开；保持纯 ESM JavaScript、零构建及现有目录布局。改动前核对 [`docs/architecture.md`](./docs/architecture.md) 的契约与当前代码，按需运行 `npm run check`。主代理写工具限制、统一结构化结果契约、并发与预算上限等仍是开放的设计与实现议题，不能当作现有能力。

## 提交信息

采用 [Conventional Commits](https://www.conventionalcommits.org/)，标题用中文或英文均可：

```
<type>(<scope>): <subject>
```

常用 `type`：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`build`、`ci`。

示例：

```
docs(readme): 说明跨 CLI 派发的安全边界
chore(repo): 忽略 raw/ 临时目录
feat(config): 增加角色配置的 schema 校验
```

## 分支

- `main` 保持可用。
- 功能分支建议命名为 `feat/<简短描述>`，修复为 `fix/<简短描述>`。

## 提交前自查

- 确认没有把 `raw/` 下的临时内容加进暂存区：`git status` 不应列出任何 `raw/` 路径。
- 确认没有提交密钥、令牌或本地绝对路径。
- 文档中的命令示例必须是你**实际验证过**的；未验证的写清楚「未验证」。

## 约定

- 文本文件以 LF 入库，由 `.gitattributes` 保证。
- 文档用中文书写，代码标识符与提交类型用英文。
- 不提交构建产物、依赖目录与编辑器私有配置。
