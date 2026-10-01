// 预检：在 profile patch 里加一个 preset 声明（不改插件代码），验证机制是否可行。
//
// 要验证的三件事：
//   1. preset 声明能否被解析、条目 id 是否合法（本脚本可离线验证）
//   2. 重启后它是否出现在 agentPresets 的 roster 里（需重启）
//   3. 它是否能让插件在**选中该 preset 的会话**里生效（需重启 + 实测）
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
    `- id: ${PRESET_ID}`,
    `  insert:`,
    `    - id: preset-switchboard-decl`,
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
const already = original.includes(`id: ${PRESET_ID}`);
const block = presetBlock(PKG);
const next = `${original.replace(/\n*$/, '\n')}${already ? '' : `\n${block}\n`}`;

console.log(`patch: ${PATCH}`);
console.log(`已包含 ${PRESET_ID}: ${already}`);
console.log(`插件包名: ${PKG}`);
console.log('');

// 离线校验：用真实解析器确认合并后仍是合法 YAML，且 preset 结构正确。
const { parse } = await import('yaml');
let doc;
try {
  doc = parse(next);
  console.log(`PASS  YAML 可解析，顶层条目数 ${doc.length}`);
} catch (error) {
  console.error(`FAIL  YAML 解析失败：${error.message}`);
  process.exit(1);
}

const presetRow = doc.find((r) => r && r.id === PRESET_ID);
if (!presetRow) {
  console.error(`FAIL  找不到条目 ${PRESET_ID}`);
  process.exit(1);
}
console.log(`PASS  条目 ${PRESET_ID} 存在`);
console.log(`      name = ${presetRow.name}`);

const inserted = Array.isArray(presetRow.insert) ? presetRow.insert : [];
const decl = inserted.find((r) => r && r.config && r.config.id);
if (!decl) {
  console.error('FAIL  insert 里找不到 preset 声明');
  process.exit(1);
}
console.log(`PASS  preset 声明存在：config.id = ${JSON.stringify(decl.config.id)}`);
const plugins = Array.isArray(decl.config.plugins) ? decl.config.plugins : [];
console.log(`      plugins 数量 = ${plugins.length}`);
for (const p of plugins) console.log(`        - ${String(p.id).padEnd(22)} ${p.name}`);
const selfRef = plugins.find((p) => p.name === PKG);
console.log(
  selfRef ? `PASS  preset 引用了本包（id=${selfRef.id}）` : 'FAIL  preset 未引用本包',
);
if (!selfRef) process.exit(1);

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
