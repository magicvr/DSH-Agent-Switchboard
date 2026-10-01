# CLI 探针本地配置

复制同目录的 `cli-probes.example.json` 为 `cli-probes.local`，替换虚构入口、脚本路径、模型与工作目录，再显式运行：

```text
node scripts/probes/probe-cli-help.mjs --cli-config scripts/cli-probes.local
node scripts/probes/probe-cli-run.mjs --cli-config scripts/cli-probes.local
node scripts/probes/probe-cli-run2.mjs --cli-config scripts/cli-probes.local
node scripts/probes/probe-codex.mjs --cli-config scripts/cli-probes.local --out-dir raw/codex-probe
```

也可设置 `SWITCHBOARD_CLI_CONFIG`；显式参数优先。没有配置会失败，不扫描安装位置，不读取 `.env`。样例不能直接用于真实 CLI：入口和模型均为虚构值，参数只是实验候选，**未验证适用于你的 CLI 版本**。真实入口建议填写绝对路径；Node 脚本入口的 Node 可执行文件填入 `command`，脚本路径单独填入 `prefixArgs`。

`cases` 是非空用例对象。四个脚本分别只执行名称以 `help.`、`run.`、`run2.`、`codex.` 开头的用例，按配置顺序执行。删除不需要的用例即可选择实验。第一轮可以比较共用模型；第二轮保留各 CLI 独立模型及有/无 effort 对照；Codex 样例保留原八种实验意图。修改用例参数可能导致非零退出，探针仍记录输出，最终也非零退出（包括预期的反证实验）。

每个用例字段：

| 字段 | 校验与含义 |
| --- | --- |
| `command` | 非空字符串，无 NUL/CR/LF，无花括号；由用户指定的入口。可继承旧格式顶层 `command`。 |
| `prefixArgs` | 字符串数组，无 NUL/CR/LF；可继承顶层 `prefixArgs`。替换后与 `args` 保持独立 argv 元素。 |
| `args` | 必填字符串数组，无 NUL/CR/LF。只有 `{prompt}`、`{cwd}`、`{model}`、`{effort}` 四个占位符。 |
| `promptDelivery` | 必填 `stdin` / `argv` / `promptFile`。`stdin` 禁止在合并模板中含 `{prompt}`；另两种必须含 `{prompt}`。 |
| `cwd` | 可选非空路径，无 NUL/CR/LF；相对路径锚定脚本启动目录。`--cwd` 优先，否则用本字段，最后用模块 URL 确定的仓库根。 |
| `model`、`effort` | 可选非空字符串，无 NUL/CR/LF，作为同名占位符值；不含这些占位符时可以直接在 `args` 填写字面量。 |

白名单与 `src/cli/argv.js` 共用，无新增占位符；缺失的模型/强度值按其既有语义替换为空，空 argv 元素会被删除，因此使用这些占位符时应配置对应值。`promptFile` 复用 `{prompt}` 表示临时文件路径，文件在调用后删除；`stdin` 的提示词走标准输入，其余方式的 stdin 是 EOF。`help.*` 的提示词为空。

所有入口均以 `spawn(command, argv, { shell: false })` 执行。执行前打印 command、分离 argv、解析路径和提示词传递方式，常见 token/API key 参数值会隐藏。不要在配置中保存密钥。

Codex 报告目录默认为仓库 `raw/codex-probe`，`--out-dir` 可覆盖（相对启动目录解析），保存 `summary.json` 及每次调用的 stdout/stderr。CLI 的 `-o` / `--output-last-message` 参数只来自配置，其相对路径按执行 cwd 解析，报告仍观察其文件和路由事实；`--out-dir` 不改写 CLI 输出参数，若需要改变该文件位置也需修改配置。不要复用旧 `-o` 文件判断本轮输出，以免把旧文件当作成功证据。

`.gitignore` 的 `*.local` 规则忽略本地配置，`raw/` 忽略实验产物；样例无个人路径、用户名或密钥。
