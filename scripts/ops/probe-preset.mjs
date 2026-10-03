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
//   node scripts/ops/probe-preset.mjs --check   只校验将要注入的内容（不写盘）
//   node scripts/ops/probe-preset.mjs --inject  写盘（自动备份）
import { readFileSync, writeFileSync } from 'node:fs';
import { stripInjectedPreset, assertNoStrayOperations, findPresetDeclaration, pluginsWithoutName } from '../lib/preset-patch.mjs';
import { resolvePaths, printPaths } from '../lib/paths.mjs';

const paths = resolvePaths({ argv: process.argv.slice(2).filter(a => !['--check', '--inject'].includes(a)) });
printPaths(paths);
const PATCH = paths.patch;
const PKG = '@magicvr/dsh-agent-switchboard';
const PRESET_ID = 'preset-switchboard';

/**
 * 读取生成好的 preset 声明文件。
 *
 * ⚠️ 这里**不再内联**一份硬编码的插件清单：那会让 preset 出现两份真相
 * （脚本里一份、presets/switchboard.patch.yml 一份），必然漂移。清单由
 * scripts/gen-preset.mjs 从当前 standard 复制生成，本脚本只负责注入。
 */
const presetBlockText = readFileSync(new URL('../../presets/switchboard.patch.yml', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\n*$/, '\n');

const original = readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n');

const cleaned = stripInjectedPreset(original).replace(/\n*$/, '\n');
const { parse } = await import('yaml');

if (!assertNoStrayOperations(cleaned, '剥离后')) process.exit(1);
const already = cleaned.includes(`id: ${PRESET_ID}`);
const block = presetBlockText;
const next = `${cleaned}${already ? '' : `\n${block}\n`}`;

console.log(`patch: ${PATCH}`);
console.log(`清理后已包含 preset 声明: ${already}`);
console.log(`插件包名: ${PKG}`);
console.log('');

// 离线校验：用真实解析器确认合并后仍是合法 YAML，且 preset 结构正确。
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
const decl = findPresetDeclaration(doc, PRESET_ID);
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
const noName = pluginsWithoutName(plugins);
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
