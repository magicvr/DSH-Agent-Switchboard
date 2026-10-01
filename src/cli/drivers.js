// 已知外部 CLI 的调用形态（「预设驱动」）。
//
// ## 为什么需要它
//
// 早先 UI 只给一个笼统的「外部 CLI」后端：用户选中的是**机制**，而不是**具体哪个 CLI**。
// 但真正要选的是「用 Codex 还是 Claude 还是 Grok」，而且这三个的参数形态**互不相同**
// （见 `docs/cli-backends.md`），让用户手填 `cliCommand` / `cliArgs` 既难用又易错。
//
// ## 设计取舍
//
// 驱动产出一组 `cli*` 字段的**具体默认值**，由 UI 在用户选择驱动（或切换只读）时写进
// 角色配置。也就是说 `cliCommand` / `cliPrefixArgs` / `cliArgs` / `cliPromptDelivery`
// 仍然是**权威数据**，可见、可改、可审计；驱动只是「一键填好这些字段」。
//
// 这样做的理由：
//   - 不引入「预设 vs 手工覆盖」两套真相，避免「到底哪个生效」的歧义；
//   - 保留全部高级用例（用户可改成 `custom` 后随便填）；
//   - 装载期校验仍然只认 `cli*` 字段，不需要额外分支；
//   - **只读状态被解析成各家的具体参数**，因此 `argv.js` 的占位符契约不必扩张
//     （仍只有 `{prompt}` / `{cwd}` / `{model}` / `{effort}`），不破坏
//     `AGENTS.md` 硬规则 4「模型只能填充受限占位符」。
//
// ## 这些值只能是「实测过的」
//
// `cli-backends.md` §1 已证明「命令存在 ≠ 能被 spawn」：本机 codex 的三个入口里只有
// `node codex.js` 可用（`.ps1` → ENOENT，`.cmd` → EINVAL，后者是 Node ≥19 对
// CVE-2024-27980 的缓解）。因此本表里的每一条都必须由真机探针跑过：
//   - `scripts/probe-cli-run.mjs`（第一轮：入口可 spawn 性 + codex 端到端）
//   - `scripts/probe-cli-run2.mjs`（第二轮：claude / grok 用各自真实模型）
//
// ## ⚠️ 每个 CLI 有自己的模型命名空间
//
// 第一轮实测暴露了这个坑：把插件可用的 LLM 路由名（如 `gpt-6-luna`）填给 claude 会得到
// `"gpt-6-luna" isn't described by this version's model catalog`，填给 grok 会得到
// `unknown model id`，两者都退出 1。**不要把「可用 LLM 路由」当成「所有 CLI 的模型名」。**
//
// 用占位符而不是硬编码绝对路径：`{node}` 与 `{npmRoot}` 在装载期解析，
// 这样预设不必把本机用户名写进仓库（`AGENTS.md` 硬规则 5）。

/**
 * 提示词传递方式。
 *
 * @typedef {'stdin' | 'argv'} PromptDelivery
 */

/**
 * 一个 CLI 驱动的定义。
 *
 * @typedef {object} CliDriver
 * @property {string} id - 稳定标识，写进 `role.cliDriver`。
 * @property {string} label - 界面上显示的名字。
 * @property {string} description - 一句话说明，用于界面提示。
 * @property {string} command - `cliCommand` 的默认值；可用 `{node}`。
 * @property {string[]} prefixArgs - `cliPrefixArgs` 的默认值；可用 `{npmRoot}`。
 * @property {PromptDelivery} promptDelivery - 提示词传递方式。
 * @property {string} modelPlaceholder - 该 CLI 的模型取值示例（**属于该 CLI 自己的命名空间**）。
 * @property {string[]} effortValues - 该 CLI 实际接受的强度取值。
 * @property {(readOnly: boolean) => string[]} args - 产出 `cliArgs`：只读状态**在此解析成具体参数**。
 */

/** `{node}` / `{npmRoot}` 的解析规则。 */
export const DRIVER_PLACEHOLDERS = {
  /** Node 可执行文件自身；codex 必须以 `node codex.js` 形式调用。 */
  node: () => process.execPath,
  /** npm 全局包根目录。 */
  npmRoot: () => `${process.env.APPDATA ?? ''}\\npm\\node_modules`,
};

/**
 * 已知驱动。
 *
 * @type {CliDriver[]}
 */
export const CLI_DRIVERS = [
  {
    id: 'codex',
    label: 'Codex CLI',
    description: 'OpenAI Codex。非交互走 `codex exec`，提示词走 stdin。只读由 `-s read-only` 实现。',
    // ⚠️ 必须是 `node <codex.js>`：`codex.ps1` 与 `codex.cmd` 都无法在 shell:false 下 spawn。
    command: '{node}',
    prefixArgs: ['{npmRoot}\\@openai\\codex\\bin\\codex.js'],
    promptDelivery: 'stdin',
    modelPlaceholder: 'gpt-6-luna',
    // 实测：codex 的强度参数在 --help 里完全未出现，取值随模型变化（D12）。
    effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
    args: (readOnly) => [
      'exec',
      '-s',
      readOnly ? 'read-only' : 'workspace-write',
      '--skip-git-repo-check',
      '-m',
      '{model}',
      '-c',
      'model_reasoning_effort={effort}',
      '-',
    ],
  },
  // 说明：**不再提供 Claude Code 预设。**
  //
  // 事实上曾实测过它的调用形态（入口可直接 spawn、`-p` + stdin 可用、`--model` 确实生效），
  // 但本机端到端始终不可用：claude 用它**内置的模型目录**校验 `--model`，网关模型名会被拒
  // （`[claude-code:unrecognized_model]`），而本机已经很久不用它了。用户明确要求排除。
  //
  // 取证记录**保留**在 `docs/cli-backends.md` §3.0 —— 那证明「已排查过」，删掉等于丢失证据。
  // 用户若日后想用回它，选「自定义命令」填 `claude` 即可，或按 §3.0 恢复一个预设。
  {
    id: 'grok',
    label: 'Grok CLI',
    description: 'xAI Grok。非交互走 `-p/--single`，提示词是**参数**而非 stdin。只读用 `--permission-mode plan`。',
    command: 'grok',
    prefixArgs: [],
    // ⚠️ grok 的 `-p/--single <PROMPT>` 需要提示词作为参数，因此 `{prompt}` 必须出现在 args 里。
    promptDelivery: 'argv',
    // 实测 `grok models`：grok-4.7（默认）/ grok-4.7-build-fast / grok-4.6 / grok-4.5
    modelPlaceholder: 'grok-4.7',
    effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
    args: (readOnly) => [
      '-p',
      '{prompt}',
      '-m',
      '{model}',
      '--reasoning-effort',
      '{effort}',
      '--permission-mode',
      readOnly ? 'plan' : 'acceptEdits',
    ],
  },
  {
    id: 'custom',
    label: '自定义命令',
    description: '自行填写命令与参数。适用于本表未收录的 CLI。',
    command: '',
    prefixArgs: [],
    promptDelivery: 'stdin',
    modelPlaceholder: '',
    effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
    args: (readOnly) => [],
  },
];

/** 驱动 id 列表（含 None 之外的全部）。 */
export const CLI_DRIVER_IDS = CLI_DRIVERS.map((d) => d.id);

/**
 * 按 id 取驱动。
 *
 * @param {string|undefined} id - 驱动 id。
 * @returns {CliDriver|undefined} 驱动定义。
 */
export function cliDriverFor(id) {
  return CLI_DRIVERS.find((d) => d.id === id);
}

/**
 * 产出一个驱动对应的完整 `cli*` 字段。
 *
 * UI 用它来「一键填好」；探针与测试也用它，保证「界面填的」与「测试验的」是同一份数据。
 *
 * @param {string} id - 驱动 id。
 * @param {boolean} readOnly - 角色是否只读。
 * @returns {{cliCommand: string, cliPrefixArgs: string[], cliArgs: string[], cliPromptDelivery: PromptDelivery}|undefined} 字段值。
 */
export function cliFieldsFor(id, readOnly) {
  const d = cliDriverFor(id);
  if (d === undefined || d.id === 'custom') return undefined;
  return {
    cliCommand: d.command,
    cliPrefixArgs: [...d.prefixArgs],
    cliArgs: d.args(readOnly),
    cliPromptDelivery: d.promptDelivery,
  };
}

/**
 * 判断角色当前「恰好等于某个驱动」。
 *
 * 用途：UI 反推下拉框该选中哪一项。只读状态会影响 `cliArgs`，因此对两种只读状态都试。
 * 若用户手工改过 `cli*` 字段导致与任何驱动都不一致，返回 `'custom'`，
 * 避免界面把用户的自定义配置**显示**成某个预设（那会误导）。
 *
 * ⚠️ **必须同时接受「模板」与「已解析」两种形态**。
 *
 * 界面拿到的 `cliCommand` / `cliPrefixArgs` 可能已经被解析过（不再是字面量 `{node}` /
 * `{npmRoot}`），取决于值经过哪一层投影。若只按模板比对，一旦拿到解析后的值就会**永远
 * 匹配不上**，下拉框表现为「锁死在自定义命令」—— 这正是实测遇到的故障。
 * 两种形态都试一遍，问题就不依赖「值到底经过哪一层」这个不确定前提。
 *
 * @param {object} role - 角色（含 `cli*` 字段）。
 * @returns {string} 驱动 id。
 */
export function inferCliDriver(role) {
  for (const d of CLI_DRIVERS) {
    if (d.id === 'custom') continue;
    // 命令与前缀参数：模板形态与解析后形态都算匹配。
    if (!matchesCommandText(role?.cliCommand, d.command)) continue;
    if (!matchesList(role?.cliPrefixArgs, d.prefixArgs)) continue;
    if ((role?.cliPromptDelivery ?? 'stdin') !== d.promptDelivery) continue;
    const args = role?.cliArgs ?? [];
    for (const readOnly of [true, false]) {
      if (JSON.stringify(args) === JSON.stringify(d.args(readOnly))) return d.id;
    }
  }
  return 'custom';
}

/**
 * 单个命令文本是否匹配（模板或其解析结果）。
 *
 * @param {unknown} actual - 角色里的值。
 * @param {string} expected - 驱动定义里的模板。
 * @returns {boolean} 是否匹配。
 */
function matchesCommandText(actual, expected) {
  if (typeof actual !== 'string') return false;
  return actual === expected || actual === resolveDriverPlaceholders(expected);
}

/**
 * 字符串数组是否匹配（逐项按模板或其解析结果比对）。
 *
 * @param {unknown} actual - 角色里的数组。
 * @param {string[]} expected - 驱动定义里的模板数组。
 * @returns {boolean} 是否匹配。
 */
function matchesList(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((v, i) => matchesCommandText(v, expected[i]));
}

/**
 * 把一条命令模板里的 `{node}` / `{npmRoot}` 解析成实际值。
 *
 * ⚠️ 必须对非字符串输入返回原样：本函数会被 `normalizeRole` 对**用户配置的任意值**调用，
 * 而配置可能是 `undefined` / 数字 / 对象（配置错误在别处报）。若在这里抛错，一个配置
 * 错误就会升级成「装载失败」，违反「插件失败不该影响应用」的原则。实测踩到过。
 *
 * @param {unknown} text - 含占位符的文本。
 * @returns {string} 解析后的文本；输入不是字符串时返回空串。
 */
export function resolveDriverPlaceholders(text) {
  if (typeof text !== 'string') return '';
  let out = text;
  for (const [key, fn] of Object.entries(DRIVER_PLACEHOLDERS)) {
    out = out.split(`{${key}}`).join(fn());
  }
  return out;
}
