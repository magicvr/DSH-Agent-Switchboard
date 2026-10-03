// 生成 Switchboard 的 Agent preset 声明文件。
//
// 方案 A：复制 `standard` 的**完整**插件清单，再叠加本插件。
//
// 为什么用「文本行复制」而不是 YAML 序列化：
//   `standard.patch.yml` 里有 `disabled: !!js process.platform === 'win32'` 这类表达式。
//   `yaml` 库解析后会把 `!!js` 变成**普通字符串**，再序列化就得到
//   `disabled: process.platform === 'win32'` —— 一个非空字符串在 YAML 里是真值，
//   于是「Windows 上禁用 bash、非 Windows 上禁用 pwsh」这条规则会**静默反转**。
//   为保住标签，这里逐行搬运原文并只调整缩进。
//
// 用法：
//   node scripts/gen-preset.mjs            写入 presets/switchboard.patch.yml
//   node scripts/gen-preset.mjs --check     只比对漂移，不写盘
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { captureSync } from './lib/capture.mjs';

const ROOT = process.cwd();
// 用裸说明符由 Node 自行解析入口（`yaml` 的入口不是 index.js）。
const { parse } = await import('yaml');

const STANDARD_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml';
const PRESET_ID = 'preset-switchboard';
const PRESET_KEY = 'switchboard';
const SELF_PACKAGE = '@magicvr/dsh-agent-switchboard';
const OUT_FILE = join(ROOT, 'presets', 'switchboard.patch.yml');

/**
 * 读取归档内某个文件的文本（复用只读探针 dsh-cat.mjs）。
 *
 * @param {string} asarPath - 归档内路径。
 * @returns {string} 文件文本。
 */
function cat(asarPath) {
  const result = captureSync(process.execPath, [join(ROOT, 'scripts', 'dsh-cat.mjs'), asarPath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? Object.assign(new Error(`dsh-cat 失败：退出码 ${result.status}，信号 ${result.signal ?? '-'}\n${result.stderr}`), result);
  }
  return result.stdout;
}

/** standard preset 的原始文本。 */
const standardText = cat(STANDARD_ENTRY);

/**
 * 从一段「plugins:」列表中抽出每个**顶层列表项**的原始文本行。
 *
 * 顶层项以 `- ` 起始，属于它的后续行缩进更深。这样能完整保留 `config:`、
 * `disabled: !!js ...`、`group:` 等嵌套结构，而不经过任何序列化。
 *
 * @param {string} text - 含 plugins 列表的 YAML 文本。
 * @returns {{ header: string[], entries: string[][] }} 列表前导行与各项行数组。
 */
function extractPluginEntries(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*plugins:\s*$/.test(l));
  if (start === -1) throw new Error('在 standard patch 里找不到 plugins: 列表');

  // plugins: 之后、第一个 `- ` 之前的行（可能为空）
  let first = start + 1;
  while (first < lines.length && !/^\s*- /.test(lines[first])) first++;
  const header = lines.slice(start + 1, first).filter((l) => l.trim().length > 0);

  const baseIndent = /^(\s*)- /.exec(lines[first])[1].length;
  const entries = [];
  let current = null;
  for (let i = first; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {
      if (current) current.push('');
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const isNew = /^\s*- /.test(line) && indent === baseIndent;
    if (isNew) {
      if (current) entries.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      // 已是下一个顶层键（不在任何列表项内）
      break;
    }
  }
  if (current) entries.push(current);
  return { header, entries, baseIndent };
}

/**
 * 把一个条目的行重新缩进到目标层级。
 *
 * @param {string[]} entryLines - 原始行。
 * @param {number} fromIndent - 原始顶层缩进。
 * @param {number} toIndent - 目标顶层缩进。
 * @returns {string[]} 重新缩进后的行。
 */
function reindent(entryLines, fromIndent, toIndent) {
  const shift = toIndent - fromIndent;
  return entryLines.map((line) => {
    if (line.trim().length === 0) return '';
    const indent = line.length - line.trimStart().length;
    const next = Math.max(0, indent + shift);
    return ' '.repeat(next) + line.trimStart();
  });
}

const { header, entries, baseIndent } = extractPluginEntries(standardText);

// 目标缩进：preset 文件里 plugins 项的 `- ` 位于第 10 列（与官方 preset 同构）。
const TARGET_INDENT = 10;

const rawEntries = entries.map((e) => e.join('\n')).join('\n');
const parsedStandard = parse(standardText);
const standardPlugins = parsedStandard[0].insert[0].config.plugins;

if (entries.length !== standardPlugins.length) {
  console.error(
    `FAIL  文本抽取的条目数(${entries.length}) 与解析出的插件数(${standardPlugins.length}) 不一致`,
  );
  process.exit(1);
}

// 本插件自身的条目：放在最前，便于阅读。
//
// ⚠️ `mount: true` 是**必需**的，它是「工具不外溢」的开关（见 decisions.md D13）：
//    根条目（bundle 的 insert）不带这个标记，因此只提供 roleConfig 配置服务、
//    不注册任何角色工具；只有这里声明了，选中本 preset 的会话才挂载角色工具。
//
// 角色列表**不在这里**：它存在插件自己的文件
// `$DSH_HOME/agent-switchboard/roles.json`，由设置页通过 roleConfig 远程服务读写。
// 原因（实测）：`settings.describe()` 按 ns 去重、只报告根条目，因此写在这里的角色
// 设置页读不到；而把角色移到根条目又会让工具全局可见、污染其他 preset 的会话。
const selfEntry = [
  '- id: switchboard-roles',
  `  name: '${SELF_PACKAGE}'`,
  '  config:',
  '    mount: true',
  '    supervisorRules: |',
  ...`主代理调度规则（Supervisor / Role-based Subagent）
你是信息流统合器：理解目标，维护状态与约束，选择角色，汇总证据并推动验收。

四问路由：
- 我要知道事实吗？→ scout（搜索、宽读、调用链、测试与影响范围取证）。
- 我已经知道怎么做，只需要执行吗？→ worker（明确方向的实现、修复、测试与文档）。
- 我需要决定到底应该怎么做吗？→ architect（架构、方法、接口边界与高返工成本的取舍）。
- 我需要独立判断当前结果是否正确吗？→ reviewer（独立验证实现、设计、方法与验收）。

通过当前可用的 delegate_to_* 工具选择对应角色；CLI 线路由插件适配，switchboard_cli_run_* 是对应角色包裹的专属执行工具，不是主代理绕过委派的入口。角色由插件配置解析，模型与推理强度由角色配置和派发适配层决定；主代理不得自行挑选或覆盖。任务明显超出角色通常难度时，先检查是否选错角色，再考虑改由更高角色承担，不临时提高强度。readOnly 是工具层权限过滤；CLI 权限边界还取决于其配置，不能把声明当成额外隔离保证。

何时委派与自己做：宽而重的读取必须交给 scout，宽而重的实现必须交给 worker；任何阶段都应考虑委派以隔离上下文、执行明确任务或获得独立视角。主代理只可直接处理已知位置的小文件、少量代码、单一事实确认、极小局部修改、状态维护、结果汇总、简单验证与明确的下一步判断。直接处理须保持局部且成本明显低于派发，不能以“顺手”吞下宽重工作，也不为委派制造无价值子任务。

主代理必须自己理解目标、架构与方法基础、已接受设计、交接信息、验收标准和核心约束；scout 可定位并提取辅助证据，不能替代主代理对决策依据的理解。主线上下文保留目标、状态、已确认事实、已接受决策、阻塞、风险、下一步和验收状态；大量搜索、日志、无关代码、探索过程与失败尝试由子代理隔离，返回可追溯的结论与必要证据。

任务包提供最小充分上下文：目标、必要背景、范围、已知事实、关键约束、禁止事项、预期结果和验收条件。简单任务保持简洁，复杂任务必须自包含；不重复复制角色完整规则，只描述本次工作。子代理是边界清晰、输入明确、可独立完成、输出可验证的一次性专业工作单元，不长期接管整个目标；高级角色尤其要聚焦。独立任务仅在工具支持时并行，存在依赖或共享写入冲突时顺序执行，不为并行拆出无价值任务。

派发生命周期：delegate_to_* 阻塞等待结果，让当前任务自然完成；不要重复派发同一任务，不为催进度而打断。取消只用于用户明确要求、紧急纠偏或已确认安全风险。失败或取消后先检查部分文件与副作用，不把部分结果宣称为完整交付；不得盲目自动重试，先按失败性质补事实、拆分或改派。

结果与失败路由：核对结果是否回答任务、证据是否充分、是否矛盾以及是否需要下一角色。缺事实→scout；方向不明或原设计不可行→architect；方向明确的实现失败→worker 拆解或有依据地重试；正确性存疑→reviewer；reviewer 发现设计问题→architect。低风险结果可由主代理轻量验证，高风险或复杂实现、重构、架构与方法变更、目标完成验收应考虑独立 reviewer。reviewer 可以质疑主代理假设、architect 方案、worker 实现、测试有效性与验收满足程度，不能只做确认器。

提交纪律：主代理把 git 提交当作状态维护统一执行，在可独立验收的增量或批次收口后及时提交，避免改动失去追溯；派发 worker 时在任务包写明「不要自行提交」，并要求返回改动范围与验证证据，不为提交打断派发。提交前核对目标仓库、分支、已有改动与暂存差异，只暂存并提交本次范围；归属不清或暂存区混有他人改动时暂缓。通过目标仓库要求的检查与测试后再提交；失败或取消后先检查副作用，只提交独立验收通过的部分并说明未完成项；确实无法验证时仅在用户明确要求下留检查点，并如实注明未验证与未完成项。绝不提交临时区、忽略目录、密钥令牌、本机绝对路径或构建产物，也不用 git add -f 绕过忽略规则。用户禁止提交、任务只读或仓库不属本次改动范围时不得提交。提交信息遵守目标仓库规范，无规范时用 Conventional Commits，写清改动与原因；提交后记录提交标识与验证结果，不擅自推送或改写既有历史。

成本纪律：高频宽读与资料取证交给 scout，明确执行交给 worker，高认知密度的方向判断和独立验证才交给 architect / reviewer；状态维护由主代理处理，高级角色只拿经过筛选的最小充分上下文。不因一次失败就由主代理接管全部工作，不靠换更贵模型解决角色选错的问题。目标流程按实际需要在事实、设计、执行、审查之间切换，不强制固定流水线；主代理负责汇总、更新状态并持续收敛，报告证据建立的结论，不堆原始过程。`.split('\n').map(line => `      ${line}`),
];

/**
 * 对复制来的标准清单行做**定点修改**。
 *
 * 只做必要的一处：禁用 standard 的通用委派工具 `tool-subagent` / `tool-subagent-fork`。
 *
 * 理由：本插件的设计意图是「主代理只通过角色工具派发」。若同时提供 standard 的
 * 通用 `subagent` / `subagent_fork`，主代理面对多个角色工具 + 通用工具时很可能
 * 选通用那个（它描述更笼统、看起来更灵活），角色分工就被架空了。
 * 保留 `tool-subagent-control` 与 `list-agents`：它们提供 send_message /
 * interrupt_agent / list_agents，对管理已派发的子代理仍然必要。
 *
 * ⚠️ 必须对**行**操作而不是对「顶层条目」操作：这两个插件嵌在 `delegation` 组的
 * `config:` 内部，不属于顶层条目 —— 按顶层条目遍历会一个都匹配不到（第一版就是
 * 这样静默失效的，`改动：（无）` 就是线索）。
 *
 * 其余条目一律照搬，避免在本插件里重复表述 standard 的策略。
 *
 * @param {string[]} lines - 已重新缩进的标准清单行。
 * @returns {{ lines: string[], patched: string[] }} 修改后的行与被禁用的 id。
 */
function disableGenericDelegationTools(lines) {
  const targetIds = new Set(['tool-subagent', 'tool-subagent-fork']);
  const patched = [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const m = /^(\s*)- id:\s*(\S+)\s*$/.exec(line);
    if (!m || !targetIds.has(m[2])) continue;
    // 该条目的后续行里若已有 disabled，则不动它（可能带 !!js 条件）。
    let hasDisabled = false;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (next.trim().length === 0) continue;
      const indent = next.length - next.trimStart().length;
      if (indent < m[1].length) break;
      if (new RegExp(`^\\s{${m[1].length}}disabled:`).test(next)) {
        hasDisabled = true;
        break;
      }
    }
    if (!hasDisabled) {
      patched.push(m[2]);
      // ⚠️ 缩进必须与同项的其它**映射键**对齐，即 `- ` 之后再加 2 列。
      // 用 `- ` 自身的缩进会让该键落在序列标记那一列，YAML 报
      // "All mapping items must start at the same column"。
      out.push(`${' '.repeat(m[1].length + 2)}disabled: true`);
    }
  }
  return { lines: out, patched };
}

const { lines: copiedLines, patched: patchedIds } = disableGenericDelegationTools(
  entries.flatMap((e) => reindent(e, baseIndent, TARGET_INDENT)),
);

const pluginLines = [
  ...reindent(selfEntry, 0, TARGET_INDENT),
  ...copiedLines,
];

const body = [
  '# Switchboard 的 Agent preset 声明。',
  '#',
  '# ⚠️ 本文件由 scripts/gen-preset.mjs **生成**，不要手工编辑：',
  '#   插件清单整体复制自 @deepseek-ai/dsh-web-app/presets/standard.patch.yml，',
  '#   以便随 DSH 升级保持一致；`npm run check:preset` 会比对漂移。',
  '#',
  '# 逐行搬运而非 YAML 序列化，是为了保住 `disabled: !!js ...` 表达式标签 ——',
  '# 序列化会把标签降级成普通字符串，使 `disabled` 恒为真。',
  '- insert:',
  `    - id: ${PRESET_ID}`,
  `      name: '@deepseek-ai/dsh-agent-preset'`,
  '      config:',
  `        id: ${PRESET_KEY}`,
  '        name: Switchboard',
  '        description: 主代理只做信息统合，把工作派给带角色的子代理（含跨 CLI）。',
  '        order: 50',
  '        plugins:',
  ...pluginLines,
  '',
].join('\n');

// 断言：原文里的 !!js 表达式必须一字不少地带过来。
// ⚠️ 只统计**非注释行** —— 文件头注释里提到了 `!!js`，全文计数会把它算进来，
// 造成假失败（第一版就是这样）。
const countJsTags = (text) =>
  text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
    .match(/!!js /g)?.length ?? 0;

const jsTagsIn = countJsTags(standardText);
const jsTagsOut = countJsTags(body);
console.log(`standard 插件数: ${standardPlugins.length}`);
console.log(`本插件条目: 1，合计 ${standardPlugins.length + 1}`);
console.log(`!!js 表达式（非注释行）: 原文 ${jsTagsIn} 个 → 产物 ${jsTagsOut} 个`);
if (jsTagsIn !== jsTagsOut) {
  console.error('FAIL  !!js 表达式数量不一致 —— 标签可能被破坏');
  process.exit(1);
}
console.log('PASS  !!js 表达式全部保留');

// 产物必须仍能被解析，且插件数与预期一致。
let produced;
try {
  produced = parse(body);
} catch (error) {
  console.error(`FAIL  产物无法解析：${error.message}`);
  process.exit(1);
}
const producedPlugins = produced[0].insert[0].config.plugins;
if (producedPlugins.length !== standardPlugins.length + 1) {
  console.error(`FAIL  产物插件数 ${producedPlugins.length} 不符（期望 ${standardPlugins.length + 1}）`);
  process.exit(1);
}
if (!producedPlugins.some((p) => p.name === SELF_PACKAGE)) {
  console.error('FAIL  产物未引用本包');
  process.exit(1);
}
console.log('PASS  产物可解析、插件数正确、含本包');
console.log(
  patchedIds.length > 0
    ? `改动：禁用 standard 的通用委派工具 ${patchedIds.join(', ')}（避免架空角色分工）`
    : '改动：（无）',
);

// 漂移检测：与已落盘的产物比对插件名序列。
let drift = false;
if (existsSync(OUT_FILE)) {
  const existing = parse(readFileSync(OUT_FILE, 'utf8'));
  const existingNames = existing[0].insert[0].config.plugins.map((p) => p.name);
  const producedNames = producedPlugins.map((p) => p.name);
  if (JSON.stringify(existingNames) !== JSON.stringify(producedNames)) {
    drift = true;
    console.warn('\n⚠️  已落盘的 presets/switchboard.patch.yml 与当前 standard 清单**不一致**：');
    console.warn(`    落盘 ${existingNames.length} 项，当前 standard ${producedNames.length} 项`);
    const missing = producedNames.filter((n) => !existingNames.includes(n));
    const extra = existingNames.filter((n) => !producedNames.includes(n));
    if (missing.length) console.warn(`    应新增：${missing.join(', ')}`);
    if (extra.length) console.warn(`    已移除：${extra.join(', ')}`);
  } else {
    console.log('\nPASS  无漂移（与当前 standard 清单一致）');
  }
} else {
  console.log('\n（尚无落盘文件）');
}

if (process.argv.includes('--check')) {
  console.log(drift ? '\n--check：存在漂移，需要重新生成。' : '\n--check：一致。');
  process.exit(drift ? 1 : 0);
}

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, body, 'utf8');
console.log(`\n已写入 ${OUT_FILE}`);
