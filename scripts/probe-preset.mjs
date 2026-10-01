// 预检：在 profile patch 里加一个 preset 声明（不改插件代码），验证机制是否可行。
//
// 要验证的三件事：
//   1. preset 声明能否被解析、结构是否合法（本脚本可离线验证）
//   2. 重启后它是否出现在 agentPresets 的 roster 里（需重启）
//   3. 它是否能让插件在**选中该 preset 的会话**里生效（需重启 + 实测）
//
// ⚠️ 踩过的坑（第一版就是这么错的）：我最初写成
//     - id: preset-switchboard
//       insert:
//         - id: preset-switchboard-decl
// 即多包了一层带 id 的映射。结果该条目**什么都没插入**（Loader 里查不到
// 被插入的条目，条目总数未变），而且 preset 也没进 roster。
//
// 根因：profile 的 cordis.patch.yml 是**操作列表**（`insert` / 按 id 覆盖 /
// `disabled:` 等），不是「带 id 的条目」。顶层 `- id:` 的语义是「用新配置**覆盖**
// 既有条目」，不是「给这个操作起个名字」。要插入新条目必须用 `insert:` 操作，
// 被插入条目的 id 写在 `insert` 列表内部。官方
// `dsh-web-app/presets/standard.patch.yml` 顶层直接就是 `- insert:`，可对照。
//
// 用法：
//   node scripts/probe-preset.mjs --check   只校验将要注入的内容（不写盘）
//   node scripts/probe-preset.mjs --inject  写盘（自动备份）
import { readFileSync, writeFileSync } from 'node:fs';

const PATCH = process.argv.includes('--patch')
  ? process.argv[process.argv.indexOf('--patch') + 1]
  : 'C:/Users/magicvr/.dsh/profiles/desktop/cordis.patch.yml';
const PKG = '@magicvr/dsh-agent-switchboard';
const PRESET_ID = 'preset-switchboard';

/**
 * 生成 preset 声明块。
 *
 * 结构照抄官方 `dsh-web-app/presets/standard.patch.yml`：
 * 顶层是一个 patch **条目**（`- id:` 是 patch 条目的 id），
 * 其 `insert` 列表里再放真正的 preset 声明。
 *
 * ⚠️ 关键设计取舍：preset 的 `plugins` 是**完整的会话构成清单**，不是增量补丁。
 * 因此一个「最小」preset 会让会话几乎没有工具可用。这里先用**较简的一组**来验证
 * 机制本身是否通 —— 一旦确认 preset 能被识别、插件能在其作用域内生效，再决定
 * 是否复制 standard 的完整清单（或改用"根挂载 + 按 preset 判定惰性"的方案）。
 *
 * @param {string} pluginName - 插件包名。
 * @returns {string} YAML 文本（顶层数组条目）。
 */
function presetBlock(pluginName) {
  return [
    `# Switchboard 预设：只在使用该预设的会话里挂载角色工具。`,
    `- insert:`,
    `    - id: preset-switchboard`,
    `      name: '@deepseek-ai/dsh-agent-preset'`,
    `      config:`,
    `        id: switchboard`,
    `        name: Switchboard`,
    `        description: 主代理只做信息统合，把工作派给带角色的子代理（含跨 CLI）。`,
    `        order: 50`,
    `        plugins:`,
    `          # 本插件自身。选中该 preset 的会话才会挂载角色工具。`,
    `          - id: switchboard-roles`,
    `            name: '${pluginName}'`,
    `          # 会话要能干活，至少需要基础工具集。`,
    `          - id: agent-instructions`,
    `            name: '@deepseek-ai/dsh-agent-instructions'`,
    `            config:`,
    `              maxBytes: 65536`,
    `          - id: tool-pwsh`,
    `            name: '@deepseek-ai/dsh-tool-pwsh'`,
    `          - id: tool-fs`,
    `            name: '@deepseek-ai/dsh-tool-fs'`,
    `          - id: tool-fs-search`,
    `            name: '@deepseek-ai/dsh-tool-fs-search'`,
    `          - id: tool-skill`,
    `            name: '@deepseek-ai/dsh-tool-skill'`,
    `          - id: skill-filesystem`,
    `            name: '@deepseek-ai/dsh-skill-filesystem'`,
    `          - id: tool-todo`,
    `            name: '@deepseek-ai/dsh-tool-todo'`,
    `            config:`,
    `              allowParallelInProgress: true`,
    `          - id: tool-ask-user`,
    `            name: '@deepseek-ai/dsh-tool-ask-user'`,
    `          - id: persona`,
    `            name: '@deepseek-ai/dsh-persona'`,
    `            config:`,
    `              suffix: Your working directory is {{cwd}}.`,
    `              prefix: You are a coding agent powered by the {{model}} model.`,
    `          - id: tool-subagent-control`,
    `            name: '@deepseek-ai/dsh-tool-subagent-control'`,
    `          - id: tool-subagent-list-agents`,
    `            name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'`,
    `          - id: tool-subagent`,
    `            name: '@deepseek-ai/dsh-tool-subagent'`,
    `            config:`,
    `              provider: spawn`,
    `              toolName: subagent`,
    `              backgroundMode: continuable`,
    `          - id: tool-workflow`,
    `            name: '@deepseek-ai/dsh-tool-workflow'`,
    `            disabled: true`,
    `          - id: workflow-ptc`,
    `            name: '@deepseek-ai/dsh-workflow-ptc'`,
    `            config:`,
    `              provider: spawn`,
  ].join('\n');
}

const original = readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n');

/**
 * 剥离此前注入过的 Switchboard preset 块。
 *
 * 需要可重复注入：第一版的**错误结构**（多包了一层 `- id: preset-switchboard`）
 * 已经写进 profile，必须能被完整替换而不是叠加或留残。
 *
 * 实现要点：从头注释行（或那条 `- id: PRESET_ID`）开始，一直吃到下一个
 * 顶层 `- ` 为止 —— 顶层条目内部的缩进行都属于该条目。
 *
 * ⚠️ 踩过的坑：第一版只从注释行开始删、且没处理「注释缺失但 `- id:` 还在」的
 * 情况，结果删掉了内容却留下了 `- id: preset-switchboard` 那层，解析出来仍是一个
 * 残缺条目。因此下面加了「剥离后不应再提到 PRESET_ID」的断言。
 *
 * @param {string} text - patch 文本。
 * @returns {string} 剥离后的文本。
 */
function stripInjectedPreset(text) {
  const lines = text.split('\n');
  const isTopLevel = (l) => /^- /.test(l);
  const isOurs = (l) => l.includes('Switchboard 预设') || l.includes(`id: ${PRESET_ID}`);

  for (let start = 0; start < lines.length; start++) {
    if (!isOurs(lines[start])) continue;
    // 向前回退包含紧邻的我们自己的注释行。
    while (start > 0 && lines[start - 1].trimStart().startsWith('# Switchboard')) start--;
    let end = start + 1;
    while (end < lines.length && !isTopLevel(lines[end])) end++;
    const stripped = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
    return stripInjectedPreset(stripped);
  }
  return text;
}

const cleaned = stripInjectedPreset(original).replace(/\n*$/, '\n');
// 剥离必须干净：否则残缺条目会污染 patch。
if (cleaned.includes(PRESET_ID)) {
  console.error(`FAIL  剥离后仍残留 ${PRESET_ID} —— stripInjectedPreset 有误`);
  process.exit(1);
}
console.log('PASS  剥离干净（无残留）');
const already = cleaned.includes(`id: preset-switchboard`);
const block = presetBlock(PKG);
const next = `${cleaned}${already ? '' : `\n${block}\n`}`;

console.log(`patch: ${PATCH}`);
console.log(`清理后已包含 preset 声明: ${already}`);
console.log(`插件包名: ${PKG}`);
console.log('');

// 离线校验：用真实解析器确认合并后仍是合法 YAML，且 preset 结构正确。
const { parse } = await import('yaml');
let doc;
try {
  doc = parse(next);
  console.log(`PASS  YAML 可解析，顶层操作条目数 ${doc.length}`);
} catch (error) {
  console.error(`FAIL  YAML 解析失败：${error.message}`);
  process.exit(1);
}

// 正确结构：某个顶层操作是 `insert:`，其列表里含 preset 声明。
// 注意**不再**查找顶层 `- id: preset-switchboard` —— 那正是我第一版的结构错误。
let decl;
for (const op of doc) {
  const inserted = Array.isArray(op?.insert) ? op.insert : [];
  const hit = inserted.find((r) => r && r.id === PRESET_ID && r.config);
  if (hit) decl = hit;
}
if (!decl) {
  console.error(`FAIL  insert 操作里找不到条目 ${PRESET_ID}（顶层操作：${doc.map((o) => Object.keys(o ?? {}).join('/')).join(', ')}）`);
  process.exit(1);
}
console.log(`PASS  insert 操作里存在条目 ${PRESET_ID}`);
console.log(`      name = ${decl.name}`);
console.log(`PASS  preset 声明存在：config.id = ${JSON.stringify(decl.config.id)}`);

const plugins = Array.isArray(decl.config.plugins) ? decl.config.plugins : [];
console.log(`      plugins 数量 = ${plugins.length}`);
for (const p of plugins) console.log(`        - ${String(p.id).padEnd(22)} ${p.name}`);
const selfRef = plugins.find((p) => p.name === PKG);
console.log(selfRef ? `PASS  preset 引用了本包（id=${selfRef.id}）` : 'FAIL  preset 未引用本包');
if (!selfRef) process.exit(1);

// 结构不变式：每个插件行都必须有 name；顶层操作只能是 insert/覆盖类。
const noName = plugins.filter((p) => typeof p.name !== 'string' || p.name.length === 0);
if (noName.length > 0) {
  console.error(`FAIL  ${noName.length} 个插件行缺少 name`);
  process.exit(1);
}
console.log('PASS  每个插件行都有 name');

if (process.argv.includes('--inject')) {
  if (already) {
    console.log('\n已存在，未重复写入。');
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(`${PATCH}.bak-${stamp}`, readFileSync(PATCH), 'utf8');
    writeFileSync(PATCH, next, 'utf8');
    console.log(`\n已备份并写入 ${PATCH}`);
  }
} else {
  console.log('\n未写盘（加 --inject 才写入）。');
}
