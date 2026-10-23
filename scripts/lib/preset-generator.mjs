// Pure text generation shared with gen-preset; no archive I/O or writes.
import { parse } from 'yaml';

/** `!!js` 只用于读取插件清单的形状；表达式原文保留为字符串，绝不求值。 */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: value => value };
const parseYaml = text => parse(text, { customTags: [JS_TAG] });

/**
 * 把 `!!js` 平台条件翻译成**可 JSON 化**的声明式标记。
 *
 * ⚠️ 为什么必须翻译而不是保留原文：角色 preset 要在**运行期**由 Host 组装，
 *    而 `!!js` 是 Loader 的 YAML 标签，JSON 里没有对应物。把表达式原文塞进
 *    JSON 再在运行期 `eval` 是安全敏感面，绝不可取。
 *
 * 因此这里只接受**已知的**平台判断表达式；一旦上游写出别的条件就抛错，
 * 让生成期失败（`check:preset` 会红），而不是在运行期静默猜错。
 *
 * @param {unknown} disabled - 解析后的 `disabled` 值。
 * @param {string} rowId - 行 id，仅用于报错定位。
 * @returns {{disabled: boolean}|{platform: 'win32'|'posix'}|undefined} 声明式标记。
 */
function encodeDisabled(disabled, rowId) {
  if (disabled === undefined) return undefined;
  if (typeof disabled === 'boolean') return { disabled };
  if (typeof disabled === 'string') {
    const normalized = disabled.replace(/\s+/g, ' ').trim();
    // `disabled: process.platform === 'win32'` ⇒ 只在 win32 上关闭 ⇒ 仅 posix 启用。
    if (normalized === "process.platform === 'win32'") return { platform: 'posix' };
    if (normalized === "process.platform !== 'win32'") return { platform: 'win32' };
  }
  throw new Error(`无法翻译第 ${JSON.stringify(rowId)} 行的 disabled 表达式：${JSON.stringify(disabled)}；` +
    '请在此处补一条明确的声明式映射，不要在运行期 eval');
}

/**
 * 把标准清单的一行转成角色 preset 可用的 JSON 行。
 *
 * @param {object} row - 解析后的标准行。
 * @returns {object} JSON 行。
 */
function encodeRow(row) {
  const out = {};
  if (row.id !== undefined) out.id = row.id;
  if (row.name !== undefined) out.name = row.name;
  if (row.group === true) out.group = true;
  if (row.isolate !== undefined) out.isolate = row.isolate;
  const disabled = encodeDisabled(row.disabled, row.id);
  if (disabled !== undefined) Object.assign(out, disabled);
  if (Array.isArray(row.config)) out.config = row.config.map(encodeRow);
  else if (row.config !== undefined) out.config = row.config;
  return out;
}

/**
 * 由标准清单生成「角色 preset 的行模板」。
 *
 * 角色子代理靠一个**独立 preset** 拿到自己的 persona 与工具构成（0.2.1-rc.1 起
 * `dsh-tool-subagent` 的 `persona` / `toolFilter` 已删除，见 docs/decisions.md）。
 * ⚠️ 只有**内置 spawn 角色**需要它：外部 CLI 角色直派后台任务，没有东西会 spawn 它，
 * 因此不产出 preset（见 D33）。
 * 那个 preset 必须自带完整工具清单，所以这里把上游 standard 的行作为**数据**导出，
 * 运行期再按角色裁剪；这样它随 DSH 升级自动同步，而不是在本插件里手抄一份。
 *
 * @param {object[]} standardPlugins - `generatePreset` 解析出的标准插件行。
 * @returns {object[]} JSON 行数组。
 */
export function roleRowsTemplate(standardPlugins) {
  return standardPlugins.map(encodeRow);
}

export function generatePreset(standardText, SELF_PACKAGE) {
const PRESET_ID = 'preset-switchboard';
const PRESET_KEY = 'switchboard';
// 第二个 preset：与第一个共用 standard 插件清单，只把 worker 排除出组合，
// 由主代理承担实现职责。角色 preset 需要独立命名空间，否则两个常驻 preset
// 会同时注册 `switchboard-role-*`，撞上 agentPresets 的重复 id 硬报错。
const SOLO_PRESET_ID = 'preset-switchboard-solo';
const SOLO_PRESET_KEY = 'switchboard-solo';
const SOLO_COMPOSITION_LABEL = '自办调度台';
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

const parsedStandard = parseYaml(standardText);
const standardPlugins = parsedStandard[0].insert[0].config.plugins;

if (entries.length !== standardPlugins.length) {
  throw new Error("standard entry count mismatch");
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
  `    compositionKey: ${PRESET_KEY}`,
  '    compositionLabel: 分工调度台',
  '    supervisorRules: |',
  ...`主代理调度规则（Supervisor / Role-based Subagent）
你是信息流统合器：理解目标，维护状态与约束，选择角色，汇总证据并推动验收。

四问路由：
- 我要知道事实吗？→ scout（搜索、宽读、调用链、测试与影响范围取证）。
- 我已经知道怎么做，只需要执行吗？→ worker（明确方向的实现、修复、测试与文档）。
- 我需要决定到底应该怎么做吗？→ architect（架构、方法、接口边界与高返工成本的取舍）。
- 我需要独立判断当前结果是否正确吗？→ reviewer（独立验证实现、设计、方法与验收）。

通过当前可用的 delegate_to_* 工具选择对应角色。**每个角色只有一个入口**：内置角色的 delegate_to_<角色> 走 DSH 子代理；外部 CLI 角色的同名 delegate_to_<角色> 由插件**直派为后台任务**（受理即返回任务句柄，不经过任何转交子代理）。不存在绕过委派直接调外部命令的入口。角色由插件配置解析，模型与推理强度由角色配置决定；主代理不得自行挑选或覆盖。任务明显超出角色通常难度时，先检查是否选错角色，再考虑改由更高角色承担，不临时提高强度。readOnly 是工具层权限过滤；CLI 权限边界还取决于其配置，不能把声明当成额外隔离保证。

何时委派与自己做：宽而重的读取必须交给 scout，宽而重的实现必须交给 worker；任何阶段都应考虑委派以隔离上下文、执行明确任务或获得独立视角。主代理只可直接处理已知位置的小文件、少量代码、单一事实确认、极小局部修改、状态维护、结果汇总、简单验证与明确的下一步判断。直接处理须保持局部且成本明显低于派发，不能以“顺手”吞下宽重工作，也不为委派制造无价值子任务。

主代理必须自己理解目标、架构与方法基础、已接受设计、交接信息、验收标准和核心约束；scout 可定位并提取辅助证据，不能替代主代理对决策依据的理解。主线上下文保留目标、状态、已确认事实、已接受决策、阻塞、风险、下一步和验收状态；大量搜索、日志、无关代码、探索过程与失败尝试由子代理隔离，返回可追溯的结论与必要证据。

任务包提供最小充分上下文：目标、必要背景、范围、已知事实、关键约束、禁止事项、预期结果和验收条件。简单任务保持简洁，复杂任务必须自包含；不重复复制角色完整规则，只描述本次工作。子代理是边界清晰、输入明确、可独立完成、输出可验证的一次性专业工作单元，不长期接管整个目标；高级角色尤其要聚焦。互不依赖的任务放在同一条消息里并行发起，存在依赖或共享写入冲突时顺序执行，不为并行拆出无价值任务。

派发生命周期：两种后端的受理形态不同，但都**不阻塞等待结果**。内置角色返回子代理 id 的受理确认，结果由完成通知送达；CLI 角色返回后台任务句柄，CLI 进程由 Jobs 托管，完成后同样由完成通知送达，届时用 job_output 读它的有界输出（不要用别的方式去捞原始日志）。受理后继续推进有用的工作，不要轮询、空转或重复派发同一任务，也不要为催进度打断子代理；只有下一步确实依赖该结果时才停下手上的事等它。相互独立的委派放在同一条消息里一起发起；存在依赖或共享写入冲突时顺序执行。取消只用于用户明确要求、紧急纠偏或已确认安全风险。失败或取消后先检查部分文件与副作用，不把部分结果宣称为完整交付；不得盲目自动重试，先按失败性质补事实、拆分或改派。

结果与失败路由：核对结果是否回答任务、证据是否充分、是否矛盾以及是否需要下一角色。缺事实→scout；方向不明或原设计不可行→architect；方向明确的实现失败→worker 拆解或有依据地重试；正确性存疑→reviewer；reviewer 发现设计问题→architect。低风险结果可由主代理轻量验证，高风险或复杂实现、重构、架构与方法变更、目标完成验收应考虑独立 reviewer。reviewer 可以质疑主代理假设、architect 方案、worker 实现、测试有效性与验收满足程度，不能只做确认器。

提交纪律：主代理把 git 提交当作状态维护统一执行，在可独立验收的增量或批次收口后及时提交，避免改动失去追溯；派发 worker 时在任务包写明「不要自行提交」，并要求返回改动范围与验证证据，不为提交打断派发。提交前核对目标仓库、分支、已有改动与暂存差异，只暂存并提交本次范围；归属不清或暂存区混有他人改动时暂缓。通过目标仓库要求的检查与测试后再提交；失败或取消后先检查副作用，只提交独立验收通过的部分并说明未完成项；确实无法验证时仅在用户明确要求下留检查点，并如实注明未验证与未完成项。绝不提交临时区、忽略目录、密钥令牌、本机绝对路径或构建产物，也不用 git add -f 绕过忽略规则。用户禁止提交、任务只读或仓库不属本次改动范围时不得提交。提交信息遵守目标仓库规范，无规范时用 Conventional Commits，写清改动与原因；提交后记录提交标识与验证结果，不擅自推送或改写既有历史。

成本纪律：高频宽读与资料取证交给 scout，明确执行交给 worker，高认知密度的方向判断和独立验证才交给 architect / reviewer；状态维护由主代理处理，高级角色只拿经过筛选的最小充分上下文。不因一次失败就由主代理接管全部工作，不靠换更贵模型解决角色选错的问题。目标流程按实际需要在事实、设计、执行、审查之间切换，不强制固定流水线；主代理负责汇总、更新状态并持续收敛，报告证据建立的结论，不堆原始过程。`.split('\n').map(line => `      ${line}`),
];

// 自办调度台：与完整分工版的唯一产品差异是「不使用 worker，主代理自己实现」。
// 提示词里的其余约束（scout / architect / reviewer 的职责、任务包、异步受理、
// 提交纪律）刻意保持同构，只改写与 worker 相关的那几段。
const SOLO_RULES = `主代理调度规则（Supervisor / Role-based Subagent · 主代理自办执行）
你是信息流统合器，同时承担实现：理解目标，维护状态与约束，选择角色，亲自完成方向明确的实现，汇总证据并推动验收。本 preset 不设 worker；实现、修复、测试与文档由你亲自完成。

三问路由：
- 我要知道事实吗？→ scout（搜索、宽读、调用链、测试与影响范围取证）。
- 我需要决定到底应该怎么做吗？→ architect（架构、方法、接口边界与高返工成本的取舍）。
- 我需要独立判断当前结果是否正确吗？→ reviewer（独立验证实现、设计、方法与验收）。

通过当前可用的 delegate_to_* 工具选择对应角色。**每个角色只有一个入口**：内置角色的 delegate_to_<角色> 走 DSH 子代理；外部 CLI 角色的同名 delegate_to_<角色> 由插件**直派为后台任务**（受理即返回任务句柄，不经过任何转交子代理）。不存在绕过委派直接调外部命令的入口。角色由插件配置解析，模型与推理强度由角色配置决定；主代理不得自行挑选或覆盖。任务明显超出角色通常难度时，先检查是否选错角色，再考虑改由更高角色承担，不临时提高强度。readOnly 是工具层权限过滤；CLI 权限边界还取决于其配置，不能把声明当成额外隔离保证。

何时委派与自己做：宽而重的读取必须交给 scout；宽而重的实现由你亲自完成，但必须先收窄范围、分批推进，避免把探索性阅读和大段原始输出堆进主线上下文。方向不明、接口边界未定或返工成本高时，先交给 architect；实现完成且风险不低时，考虑交给 reviewer 独立验证。主代理只可直接处理已知位置的小文件、少量代码、单一事实确认、极小局部修改、状态维护、结果汇总、简单验证与明确的下一步判断。直接处理须保持局部且成本明显低于派发，不能以“顺手”吞下宽重工作，也不为委派制造无价值子任务。

主代理必须自己理解目标、架构与方法基础、已接受设计、交接信息、验收标准和核心约束；scout 可定位并提取辅助证据，不能替代主代理对决策依据的理解。主线上下文保留目标、状态、已确认事实、已接受决策、阻塞、风险、下一步和验收状态；大量搜索、日志、无关代码、探索过程与失败尝试由子代理隔离，返回可追溯的结论与必要证据。实现过程中产生的临时文件、脚手架和一次性验证脚本要及时清理，不把过程垃圾留在仓库里。

任务包提供最小充分上下文：目标、必要背景、范围、已知事实、关键约束、禁止事项、预期结果和验收条件。简单任务保持简洁，复杂任务必须自包含；不重复复制角色完整规则，只描述本次工作。子代理是边界清晰、输入明确、可独立完成、输出可验证的一次性专业工作单元，不长期接管整个目标；高级角色尤其要聚焦。互不依赖的任务放在同一条消息里并行发起，存在依赖或共享写入冲突时顺序执行，不为并行拆出无价值任务。

派发生命周期：两种后端的受理形态不同，但都**不阻塞等待结果**。内置角色返回子代理 id 的受理确认，结果由完成通知送达；CLI 角色返回后台任务句柄，CLI 进程由 Jobs 托管，完成后同样由完成通知送达，届时用 job_output 读它的有界输出（不要用别的方式去捞原始日志）。受理后继续推进有用的工作，不要轮询、空转或重复派发同一任务，也不要为催进度打断子代理；只有下一步确实依赖该结果时才停下手上的事等它。相互独立的委派放在同一条消息里一起发起；存在依赖或共享写入冲突时顺序执行。取消只用于用户明确要求、紧急纠偏或已确认安全风险。失败或取消后先检查部分文件与副作用，不把部分结果宣称为完整交付；不得盲目自动重试，先按失败性质补事实、拆分或调整实现。

结果与失败路由：核对结果是否回答任务、证据是否充分、是否矛盾以及是否需要下一角色。缺事实→scout；方向不明或原设计不可行→architect；实现失败由你先定位原因，再决定补事实、拆分、调整方案或有依据地重试；正确性存疑→reviewer；reviewer 发现设计问题→architect。低风险结果可由你轻量验证，高风险或复杂实现、重构、架构与方法变更、目标完成验收应考虑独立 reviewer。reviewer 可以质疑你的假设、architect 的方案、你的实现、测试有效性与验收满足程度，不能只做确认器。

提交纪律：你把 git 提交当作状态维护统一执行，在可独立验收的增量或批次收口后及时提交，避免改动失去追溯。提交前核对目标仓库、分支、已有改动与暂存差异，只暂存并提交本次范围；归属不清或暂存区混有他人改动时暂缓。通过目标仓库要求的检查与测试后再提交；失败或取消后先检查副作用，只提交独立验收通过的部分并说明未完成项；确实无法验证时仅在用户明确要求下留检查点，并如实注明未验证与未完成项。绝不提交临时区、忽略目录、密钥令牌、本机绝对路径或构建产物，也不用 git add -f 绕过忽略规则。用户禁止提交、任务只读或仓库不属本次改动范围时不得提交。提交信息遵守目标仓库规范，无规范时用 Conventional Commits，写清改动与原因；提交后记录提交标识与验证结果，不擅自推送或改写既有历史。

成本纪律：高频宽读与资料取证交给 scout，方向判断和独立验证交给 architect / reviewer；实现由你亲自承担，状态维护也由你处理。高级角色只拿经过筛选的最小充分上下文，不把 architect 当作实现者，也不因一次失败就把判断工作一并吞下。不靠换更贵模型解决角色选错的问题。目标流程按实际需要在事实、设计、执行、审查之间切换，不强制固定流水线；你负责汇总、更新状态并持续收敛，报告证据建立的结论，不堆原始过程。`;

// 第二个 preset 的本插件条目：同一份 standard 清单，只改组合键、排除 worker、
// 换一套自办执行的调度规则。
const soloEntry = [
  '- id: switchboard-roles',
  `  name: '${SELF_PACKAGE}'`,
  '  config:',
  '    mount: true',
  `    compositionKey: ${SOLO_PRESET_KEY}`,
  `    compositionLabel: ${SOLO_COMPOSITION_LABEL}`,
  '    excludedRoles:',
  '      - worker',
  '    supervisorRules: |',
  ...SOLO_RULES.split('\n').map(line => `      ${line}`),
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

/** 一个 preset 行的文本块；插件清单由调用方给出。 */
function presetBlockLines({ id, key, name, description, order }, pluginLines) {
  return [
    `    - id: ${id}`,
    `      name: '@deepseek-ai/dsh-agent-preset'`,
    '      config:',
    `        id: ${key}`,
    `        name: ${name}`,
    `        description: ${description}`,
    `        order: ${order}`,
    '        plugins:',
    ...pluginLines,
  ];
}

const fullPluginLines = [
  ...reindent(selfEntry, 0, TARGET_INDENT),
  ...copiedLines,
];
const soloPluginLines = [
  ...reindent(soloEntry, 0, TARGET_INDENT),
  ...copiedLines,
];

// 两个 preset 的展示信息是用户可见的中文名称与说明；改它们只需重新生成 YAML，
// 不需要改 Host 代码。
const presets = [
  { id: PRESET_ID, key: PRESET_KEY, name: '分工调度台',
    description: '主代理只做统合与验收，把实现交给「实现者」，事实、设计与独立审查分别交给「侦察员」「架构师」「审查员」。',
    order: 50, compositionKey: PRESET_KEY, compositionLabel: '分工调度台', excludedRoles: [] },
  { id: SOLO_PRESET_ID, key: SOLO_PRESET_KEY, name: '自办调度台',
    description: '主代理自己承担实现，不设「实现者」；事实、设计与独立审查仍分别交给「侦察员」「架构师」「审查员」。',
    order: 51, compositionKey: SOLO_PRESET_KEY, compositionLabel: SOLO_COMPOSITION_LABEL, excludedRoles: ['worker'] },
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
  '#',
  '# 本文件声明两个 preset：分工调度台（四角色完整分工）与自办调度台',
  '# （不组合 worker，由主代理承担实现）。两者共用同一份 standard 插件清单。',
  '- insert:',
  ...presetBlockLines(presets[0], fullPluginLines),
  ...presetBlockLines(presets[1], soloPluginLines),
  '',
].join('\n');
return { body, standardPlugins, patchedIds, presets };
}
