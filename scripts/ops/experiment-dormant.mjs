// 实验：让插件**只**通过 preset 生效（去掉全局挂载），把角色配置随之迁移。
//
// 目的：验证一个此前未能验证的机制 —— 把包列在 preset 的 plugins 里，能否让它在
// 该 preset 的作用域内被实例化。上一轮验证会话给出的答案是「不能」，但那次是
// **全局挂载同时存在**，很可能 Loader 按包名去重，preset 那次根本没执行。
// 本实验去掉全局挂载，才是方案 A 的完整形态。
//
// ⚠️ 全程**文本级补丁**，绝不用 `yaml.stringify()` 整体重写：
//   该库会把 `!!js process.platform === 'win32'` 降级成普通字符串，使 platform
//   条件静默失效（与 scripts/gen-preset.mjs 避开的是同一个坑）。
//
// 用法：
//   node scripts/ops/experiment-dormant.mjs --check    只预检（不写盘）
//   node scripts/ops/experiment-dormant.mjs --apply     写盘（自动备份）
//   node scripts/ops/experiment-dormant.mjs --restore   用存档还原
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { resolvePaths, printPaths } from '../lib/paths.mjs';

const paths = resolvePaths({ argv: process.argv.slice(2).filter(a => !['--apply', '--check', '--restore'].includes(a)) });
printPaths(paths);
const PROFILE = paths.patch;
const ARCHIVE = `${PROFILE}.before-dormant-experiment`;
const SELF = '@magicvr/dsh-agent-switchboard';
const mode = process.argv.includes('--apply')
  ? 'apply'
  : process.argv.includes('--restore')
    ? 'restore'
    : 'check';

if (mode === 'restore') {
  if (!existsSync(ARCHIVE)) {
    console.error(`FAIL  找不到存档 ${ARCHIVE}`);
    process.exit(1);
  }
  copyFileSync(ARCHIVE, PROFILE);
  console.log(`已用存档还原 ${PROFILE}`);
  process.exit(0);
}

const original = readFileSync(PROFILE, 'utf8').replace(/\r\n/g, '\n');
const lines = original.split('\n');
const doc = parse(original);

// --- 定位与预检 -----------------------------------------------------------
const globalEntry = doc.find((o) => o && o.id === 'agent-switchboard');
if (!globalEntry) {
  console.error('FAIL  profile 里找不到 agent-switchboard 条目');
  process.exit(1);
}
const presetDecl = doc
  .find((o) => Array.isArray(o?.insert) && o.insert.some((r) => r.id === 'preset-switchboard'))
  ?.insert.find((r) => r.id === 'preset-switchboard');
if (!presetDecl) {
  console.error('FAIL  找不到 preset 声明');
  process.exit(1);
}

const rolesConfig = globalEntry.config ?? {};
const roleCount = Array.isArray(rolesConfig.roles) ? rolesConfig.roles.length : 0;
console.log(`全局条目 disabled = ${JSON.stringify(globalEntry.disabled)}`);
console.log(`全局条目 config 字段 = ${Object.keys(rolesConfig).join(', ')}`);
console.log(`roles 数量 = ${roleCount}`);
if (roleCount === 0) {
  console.error('FAIL  全局条目没有 roles —— 迁移会丢配置，中止');
  process.exit(1);
}

const plugins = Array.isArray(presetDecl.config?.plugins) ? presetDecl.config.plugins : [];
const selfRows = plugins.filter((p) => p?.name === SELF);
console.log(`preset 插件总数 = ${plugins.length}；本包条目 = ${selfRows.length} 个`);
for (const row of selfRows) {
  console.log(`  id=${row.id} 现有 config 字段=${Object.keys(row.config ?? {}).join(',') || '(无)'}`);
}
if (selfRows.length !== 1) {
  console.error(`FAIL  期望 preset 里恰好 1 个本包条目，实际 ${selfRows.length} 个`);
  process.exit(1);
}
const selfId = selfRows[0].id;

// --- 文本定位 -------------------------------------------------------------
/**
 * 找到某个顶层 `- ` 操作的起止行下标（0-based）。
 *
 * @param {(block: string[]) => boolean} predicate - 判定该操作是否为目标。
 * @returns {{ start: number, end: number } | undefined} 区间。
 */
function findTopLevelOpStart(predicate) {
  for (let i = 0; i < lines.length; i++) {
    if (!/^- /.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !/^- /.test(lines[end])) end++;
    if (predicate(lines.slice(i, end))) return { start: i, end };
  }
  return undefined;
}

const globalOp = findTopLevelOpStart((block) =>
  block.some((l) => /^\s*-?\s*id:\s*agent-switchboard\s*$/.test(l)),
);
const presetOp = findTopLevelOpStart((block) => block.some((l) => /id:\s*preset-switchboard\s*$/.test(l)));
if (!globalOp || !presetOp) {
  console.error(`FAIL  文本定位失败（global=${!!globalOp} preset=${!!presetOp}）`);
  process.exit(1);
}
console.log(`\n全局条目的顶层操作：行 ${globalOp.start + 1}..${globalOp.end}`);
console.log(`preset 的顶层操作：行 ${presetOp.start + 1}..${presetOp.end}`);

const selfRowLine = lines.findIndex(
  (l, i) => i >= presetOp.start && i < presetOp.end && new RegExp(`^\\s*- id:\\s*${selfId}\\s*$`).test(l),
);
if (selfRowLine === -1) {
  console.error(`FAIL  在 preset 操作里找不到本包条目行（- id: ${selfId}）`);
  process.exit(1);
}
const selfRowIndent = lines[selfRowLine].length - lines[selfRowLine].trimStart().length;
console.log(`本包条目在第 ${selfRowLine + 1} 行，缩进 ${selfRowIndent}`);

/**
 * 把 provider/maxDepth/cwd/roles 渲染为 YAML 行。
 *
 * 只序列化**我们自己的角色配置**，不触碰 standard 复制来的任何行，因此不会影响
 * 那些 `!!js` 表达式。
 *
 * @param {object} config - 角色配置。
 * @param {number} indent - `config:` 的缩进。
 * @returns {string[]} YAML 行。
 */
function renderConfig(config, indent) {
  const pad = ' '.repeat(indent);
  const q = (s) => JSON.stringify(s);
  const out = [`${pad}config:`];
  if (typeof config.provider === 'string') out.push(`${pad}  provider: ${q(config.provider)}`);
  if (typeof config.maxDepth === 'number') out.push(`${pad}  maxDepth: ${config.maxDepth}`);
  if (typeof config.cwd === 'string') out.push(`${pad}  cwd: ${q(config.cwd)}`);
  out.push(`${pad}  roles:`);
  for (const r of config.roles ?? []) {
    out.push(`${pad}    - id: ${q(r.id)}`);
    for (const [k, v] of Object.entries(r)) {
      if (k === 'id') continue;
      if (typeof v === 'string') {
        if (v.includes('\n')) {
          out.push(`${pad}      ${k}: |`);
          for (const l of v.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n')) {
            out.push(l.length > 0 ? `${pad}        ${l}` : '');
          }
        } else {
          out.push(`${pad}      ${k}: ${q(v)}`);
        }
      } else if (typeof v === 'boolean' || typeof v === 'number') {
        out.push(`${pad}      ${k}: ${v}`);
      } else if (Array.isArray(v)) {
        out.push(`${pad}      ${k}: [${v.map((x) => q(String(x))).join(', ')}]`);
      }
    }
  }
  return out;
}

console.log('\n将要做的改动：');
console.log('  1. 全局 agent-switchboard 顶层操作内加一行 disabled: true（保留配置便于回滚）');
console.log(`  2. 在 preset 的本包条目（第 ${selfRowLine + 1} 行）下插入 config: 子树，含 ${roleCount} 个角色`);

if (mode === 'check') {
  console.log('\n未写盘（加 --apply 才写）。');
  process.exit(0);
}

// --- 应用 ----------------------------------------------------------------
let next = [...lines];
const configLines = renderConfig(rolesConfig, selfRowIndent + 2);
next = [...next.slice(0, selfRowLine + 1), ...configLines, ...next.slice(selfRowLine + 1)];

const globalOp2 = findTopLevelOpStart((block) =>
  block.some((l) => /^\s*-?\s*id:\s*agent-switchboard\s*$/.test(l)),
);
if (!globalOp2) {
  console.error('FAIL  插入后重新定位全局条目失败');
  process.exit(1);
}
// ⚠️ 必须**替换**已有的 disabled 行，不能追加：
//    同一映射里出现两个 `disabled` 键会让 YAML 解析失败
//    （"Map keys must be unique"）。第一版就是这么错的。
const disabledIdx = next.findIndex(
  (l, i) => i >= globalOp2.start && i < globalOp2.end && /^\s*disabled:/.test(l),
);
if (disabledIdx === -1) {
  next = [...next.slice(0, globalOp2.start + 1), '  disabled: true', ...next.slice(globalOp2.start + 1)];
} else {
  const indent = next[disabledIdx].length - next[disabledIdx].trimStart().length;
  next = [
    ...next.slice(0, disabledIdx),
    `${' '.repeat(indent)}disabled: true`,
    ...next.slice(disabledIdx + 1),
  ];
}

const serialized = next.join('\n');
copyFileSync(PROFILE, `${PROFILE}.bak-dormant-${Date.now()}`);
writeFileSync(PROFILE, serialized, 'utf8');

// --- 复核 -----------------------------------------------------------------
console.log('\n复核：');
const afterText = readFileSync(PROFILE, 'utf8');
const jsBefore = (original.match(/!!js /g) ?? []).length;
const jsAfter = (afterText.match(/!!js /g) ?? []).length;
console.log(`  !!js 表达式：改写前 ${jsBefore} → 改写后 ${jsAfter}`);
if (jsBefore !== jsAfter) {
  console.error('FAIL  !!js 被破坏！立即还原：node scripts/ops/experiment-dormant.mjs --restore');
  process.exit(1);
}

let after;
try {
  after = parse(afterText);
} catch (error) {
  console.error(`FAIL  产物无法解析：${error.message}`);
  console.error('      还原：node scripts/ops/experiment-dormant.mjs --restore');
  process.exit(1);
}
const afterGlobal = after.find((o) => o && o.id === 'agent-switchboard');
const afterSelf = after
  .find((o) => Array.isArray(o?.insert) && o.insert.some((r) => r.id === 'preset-switchboard'))
  ?.insert.find((r) => r.id === 'preset-switchboard')
  ?.config?.plugins?.find((p) => p?.name === SELF);
console.log(`  全局 disabled = ${JSON.stringify(afterGlobal?.disabled)}`);
console.log(`  preset 内本包 config.roles 数 = ${afterSelf?.config?.roles?.length ?? '缺失'}`);
console.log(`  顶层操作数 = ${after.length}`);
if (afterGlobal?.disabled !== true) {
  console.error('FAIL  全局条目未被禁用');
  process.exit(1);
}
if ((afterSelf?.config?.roles?.length ?? 0) !== roleCount) {
  console.error('FAIL  角色配置未正确迁移');
  process.exit(1);
}
console.log('\nPASS  实验配置就位。若需回滚：node scripts/ops/experiment-dormant.mjs --restore');
