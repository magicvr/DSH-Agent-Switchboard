# 贡献指南

## 当前阶段

项目处于早期设计阶段，**尚无可用实现**。此刻最有价值的贡献是设计与决策讨论，而不是提交实现代码——关键决策（见 [`docs/architecture.md`](./docs/architecture.md) 第 3 节）尚未定型，过早写实现大概率要重写。

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
