// 收敛：把角色配置的唯一来源定为 preset，清掉 profile 里那份重复的条目。
//
// 背景：实验阶段 profile 里留了一个 `agent-switchboard` 条目并置为 disabled: true
// （为便于回滚、也因为它曾是**唯一**携带 roles 的地方）。现在 bundle 层已声明
// 该条目为 disabled，preset 里那一份 config 才是真正生效的来源，profile 里这份
// 纯属重复 —— 两份真相必然漂移，收敛掉。
//
// ⚠️ 文本级操作，绝不用 yaml.stringify 整体重写（会把 `!!js` 表达式降级为普通
//    字符串，使 platform 条件静默失效）。
//
// 用法：
//   node scripts/consolidate-config.mjs --check
//   node scripts/consolidate-config.mjs --apply
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { parse } from 'yaml';
import { resolvePaths, printPaths } from './lib/paths.mjs';

const paths = resolvePaths({ argv: process.argv.slice(2).filter(a => !['--apply', '--check'].includes(a)) });
printPaths(paths);
const PROFILE = paths.patch;
const mode = process.argv.includes('--apply') ? 'apply' : 'check';

const original = readFileSync(PROFILE, 'utf8').replace(/\r\n/g, '\n');
const lines = original.split('\n');
const doc = parse(original);

// --- 预检：确认 preset 里那份配置是完整可用的 ---------------------------------
const preset = doc
  .find((o) => Array.isArray(o?.insert) && o.insert.some((r) => r.id === 'preset-switchboard'))
  ?.insert.find((r) => r.id === 'preset-switchboard');
const selfRow = (preset?.config?.plugins ?? []).find(
  (p) => p?.name === '@magicvr/dsh-agent-switchboard',
);
const presetRoles = selfRow?.config?.roles?.length ?? 0;
console.log(`preset 内本包条目 config.roles 数 = ${presetRoles}`);
if (presetRoles === 0) {
  console.error('FAIL  preset 里没有角色配置 —— 收敛会丢配置，中止');
  process.exit(1);
}

const globalIdx = doc.findIndex((o) => o && o.id === 'agent-switchboard');
if (globalIdx === -1) {
  console.log('profile 里已无 agent-switchboard 条目，无需收敛。');
  process.exit(0);
}
const globalEntry = doc[globalIdx];
console.log(`profile 内 agent-switchboard 条目：disabled=${JSON.stringify(globalEntry.disabled)}`);
console.log(`  其 config.roles 数 = ${(globalEntry.config?.roles ?? []).length}`);

// --- 文本定位该顶层操作 -------------------------------------------------------
/**
 * 找到第 n 个匹配的顶层操作区间。
 *
 * @param {(block: string[]) => boolean} predicate - 判定。
 * @returns {{ start: number, end: number } | undefined} 区间。
 */
function findOp(predicate) {
  for (let i = 0; i < lines.length; i++) {
    if (!/^- /.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !/^- /.test(lines[end])) end++;
    if (predicate(lines.slice(i, end))) return { start: i, end };
  }
  return undefined;
}
const op = findOp((block) => block.some((l) => /^\s*-?\s*id:\s*agent-switchboard\s*$/.test(l)));
if (!op) {
  console.error('FAIL  文本定位 agent-switchboard 操作失败');
  process.exit(1);
}
console.log(`\n将删除 profile 的顶层操作：行 ${op.start + 1}..${op.end}（共 ${op.end - op.start} 行）`);
console.log('保留：preset 操作（含本包条目与角色配置）');

if (mode === 'check') {
  console.log('\n未写盘（加 --apply 才写）。');
  process.exit(0);
}

let next = [...lines.slice(0, op.start), ...lines.slice(op.end)];
// 合并可能产生的连续空行。
const out = [];
for (const l of next) {
  if (l.trim() === '' && out.length > 0 && out[out.length - 1].trim() === '') continue;
  out.push(l);
}
next = out;

copyFileSync(PROFILE, `${PROFILE}.bak-consolidate-${Date.now()}`);
writeFileSync(PROFILE, next.join('\n'), 'utf8');

// --- 复核 --------------------------------------------------------------------
console.log('\n复核：');
const afterText = readFileSync(PROFILE, 'utf8');

/**
 * 统计**指定行区间**里的 `!!js` 表达式数量。
 *
 * ⚠️ 不能用全局总数比对：本操作**故意删除**了 profile 里的 agent-switchboard
 *    条目，而那个条目自身可能带 `!!js`（实测它带 1 条），因此全局总数必然下降 ——
 *    第一版就是这么误报的，而且它在断言前已经写盘，白白制造了一次「可能损坏」的惊吓。
 *    正确的判据是：**我们保留的部分（preset 操作）里的 `!!js` 必须一条不少**。
 *
 * @param {string} text - 文本。
 * @param {number} from - 起始行（0-based，含）。
 * @param {number} to - 结束行（0-based，不含）。
 * @returns {number} 数量。
 */
function countJsInRange(text, from, to) {
  return text
    .split('\n')
    .slice(from, to)
    .join('\n')
    .match(/!!js /g)?.length ?? 0;
}

/** 在当前文本里定位 preset 顶层操作的区间。 */
function presetRange(text) {
  const ls = text.split('\n');
  for (let i = 0; i < ls.length; i++) {
    if (!/^- /.test(ls[i])) continue;
    let end = i + 1;
    while (end < ls.length && !/^- /.test(ls[end])) end++;
    if (ls.slice(i, end).some((l) => /id:\s*preset-switchboard\s*$/.test(l))) return [i, end];
  }
  return undefined;
}

const oldRange = presetRange(original);
const newRange = presetRange(afterText);
if (!oldRange || !newRange) {
  console.error(`FAIL  定位 preset 区间失败（old=${!!oldRange} new=${!!newRange}）`);
  process.exit(1);
}
const jsBefore = countJsInRange(original, oldRange[0], oldRange[1]);
const jsAfter = countJsInRange(afterText, newRange[0], newRange[1]);
console.log(`  preset 区间内的 !!js 表达式：前 ${jsBefore} → 后 ${jsAfter}`);
if (jsBefore !== jsAfter) {
  console.error('FAIL  preset 内的 !!js 被破坏！从 .bak-consolidate-* 还原');
  process.exit(1);
}
console.log('PASS  preset 内的 !!js 表达式一条未少');
let after;
try {
  after = parse(afterText);
} catch (error) {
  console.error(`FAIL  产物无法解析：${error.message}`);
  process.exit(1);
}
console.log(`  顶层操作数 = ${after.length}（原 ${doc.length}）`);
console.log(`  仍有 agent-switchboard 顶层条目 = ${after.some((o) => o?.id === 'agent-switchboard')}`);
const afterRoles = after
  .find((o) => Array.isArray(o?.insert) && o.insert.some((r) => r.id === 'preset-switchboard'))
  ?.insert.find((r) => r.id === 'preset-switchboard')
  ?.config?.plugins?.find((p) => p?.name === '@magicvr/dsh-agent-switchboard')?.config?.roles?.length;
console.log(`  preset 内角色数 = ${afterRoles}`);
if (afterRoles !== presetRoles) {
  console.error('FAIL  角色配置数量变化');
  process.exit(1);
}
const stray = after.filter((o) => Object.prototype.hasOwnProperty.call(o, 'insert') && !(
  Array.isArray(o.insert) ? o.insert.length > 0 : Boolean(o.insert)
));
if (stray.length > 0) {
  console.error(`FAIL  出现空 insert 操作 ${stray.length} 个`);
  process.exit(1);
}
console.log('PASS  无空操作');
console.log('\n完成。角色配置唯一来源 = preset。');
console.log('注意：bundle 层（cordis.patch.yml）已把该条目声明为 disabled，');
console.log('      因此本插件默认不激活，仅在选中 Switchboard preset 的会话里生效。');
