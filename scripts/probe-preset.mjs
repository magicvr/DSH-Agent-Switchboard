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
import { resolvePaths, printPaths } from './lib/paths.mjs';

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
const presetBlockText = readFileSync(new URL('../presets/switchboard.patch.yml', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\n*$/, '\n');

const original = readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n');

/**
 * 判断某行是否属于「我们自己注入的 preset 块」。
 *
 * ⚠️ 这里有一个会造成**数据丢失**的陷阱，务必保持严格：
 *   配置值里也含 "Switchboard" —— 例如 `agent-switchboard` 条目的
 *   `cwd: "C:\Users\...\Code\DSH-Agent-Switchboard"`。若用宽泛的
 *   `l.includes('Switchboard')`，剥离区间会从那一行一直吃到文件末尾的
 *   preset 块，**删掉近 900 行**（含全部角色配置）。实测确实发生过，只是
 *   被写盘前的断言拦下了。
 *
 * 因此只认两种情况：
 *   1. 生成器写的**注释行**，且必须是 `#` 开头的行首形式；
 *   2. preset 声明的 id 行（`- id: preset-switchboard`）。
 *
 * @param {string} line - 单行文本。
 * @returns {boolean} 是否属于我们的块。
 */
function isOurBlockLine(line) {
  const trimmed = line.trimStart();
  // 注释行：必须是 `#` 开头，且形如生成器写的块头注释。
  if (trimmed.startsWith('# Switchboard')) return true;
  // 声明行：`- id: preset-switchboard`（可能带缩进）。
  return /^-?\s*id:\s*preset-switchboard\s*$/.test(trimmed);
}

/**
 * 剥离此前注入过的 Switchboard preset 块，并顺带清理**空操作**。
 *
 * 需要可重复注入：早期版本的错误结构已写进过 profile，必须能被完整替换而不是
 * 叠加或留残。
 *
 * ⚠️ 为什么还要清理空操作：真实文件的形态是
 *     - insert:                      ← 独立一行
 *     # Switchboard 的 Agent preset 声明。
 *     - insert:                      ← 我们的块
 *         - id: preset-switchboard
 * 剥离只删「注释 + 我们的行」，于是第一个 `- insert:` 变成**没有内容的空操作**，
 * 解析出 `insert: null`。这不只是难看：空 insert 会让 Loader 的 patch 树多一个
 * 无意义节点。因此把「删除空 insert 操作」并入剥离流程，任何残留形态都能自愈，
 * 而不是逐个个案特判。
 *
 * @param {string} text - patch 文本。
 * @returns {string} 剥离并清理后的文本。
 */
function stripInjectedPreset(text) {
  const lines = text.split('\n');
  const isTopLevel = (l) => /^- /.test(l);

  // 1) 删除我们自己的块。
  for (let start = 0; start < lines.length; start++) {
    if (!isOurBlockLine(lines[start])) continue;
    while (start > 0 && lines[start - 1].trimStart().startsWith('# Switchboard')) start--;
    let end = start + 1;
    while (end < lines.length && !isTopLevel(lines[end])) end++;
    const stripped = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
    return stripInjectedPreset(stripped);
  }

  // 2) 删除空操作（例如只剩一个 `- insert:` 而没有列表项）。
  for (let start = 0; start < lines.length; start++) {
    if (!/^- insert:\s*$/.test(lines[start])) continue;
    let end = start + 1;
    while (end < lines.length && !isTopLevel(lines[end])) end++;
    const meaningful = lines
      .slice(start + 1, end)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    if (meaningful.length === 0) {
      // 连同其前面的空白行一起删，避免留下连续空行。
      let from = start;
      while (from > 0 && lines[from - 1].trim() === '') from--;
      const next = [...lines.slice(0, from), ...lines.slice(end)].join('\n');
      return stripInjectedPreset(next);
    }
  }

  return text;
}

const cleaned = stripInjectedPreset(original).replace(/\n*$/, '\n');
const { parse } = await import('yaml');

/**
 * 结构化残留检查。
 *
 * ⚠️ 为什么不能只做字符串检查：我第一版的「剥离干净」断言只查文本里是否还提到
 * PRESET_ID，而残留可能是一个**孤立的 `- insert:`**（不含任何 id 文本）。
 * 它解析出来是一个空 insert 操作 —— 字符串断言看不见，实测因此漏过一次。
 * 结构问题必须用解析来判断。
 *
 * @param {string} text - 待检查的 patch 文本。
 * @param {string} label - 报告用的标签。
 * @returns {boolean} 是否干净。
 */
function assertNoStrayOperations(text, label) {
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    console.error(`FAIL  ${label} 无法解析：${error.message}`);
    return false;
  }
  const stray = [];
  doc.forEach((op, index) => {
    if (!op || typeof op !== 'object') {
      stray.push(`[${index}] 非对象操作`);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(op, 'insert')) {
      // ⚠️ YAML 会把**只有一项**的序列解析成单个对象而不是数组。若只处理
      //     `Array.isArray` 分支，单项的 insert 会被静默当成「非数组」跳过 ——
      //     那正是一次真实漏检（孤立的 `- insert:` 因此没被发现）。
      const list = Array.isArray(op.insert) ? op.insert : [op.insert];
      if (list.length === 0 || list[0] === null || list[0] === undefined) {
        stray.push(`[${index}] 空 insert 操作`);
      }
    }
    const keys = Object.keys(op);
    if (keys.length === 0) stray.push(`[${index}] 空操作`);
    if (keys.length === 1 && keys[0] === 'insert') {
      const list = Array.isArray(op.insert) ? op.insert : [op.insert];
      if (list.length === 1 && list[0] && typeof list[0] === 'object') {
        // 单项且含 id 的 insert 是正常的 plugin insert；只有缺 id 才可疑。
        if (typeof list[0].id !== 'string') stray.push(`[${index}] insert 项缺少 id`);
      }
    }
  });
  if (stray.length > 0) {
    console.error(`FAIL  ${label} 含残留操作：${stray.join('; ')}`);
    return false;
  }
  console.log(`PASS  ${label} 无空/残留操作（顶层 ${doc.length} 项）`);
  return true;
}

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
