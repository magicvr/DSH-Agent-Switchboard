// 收敛：删除 A/B 测试造成的角色 fork。
//
// 背景：为了让「同一语义角色走不同机制」这件事**可见**，我曾把侦察角色复制成两个条目：
//     scout        backend=spawn
//     codex-scout  backend=cli
// 但 `backend` 本来就是**每个角色自己的字段**（D13），同一角色换机制只需改这一个字段，
// 不需要复制角色。那个 fork 会让「角色是语义实体、机制是它的属性」这一设计看起来不成立。
//
// 本脚本删除纯属测试脚手架的角色，让配置回到「一个语义角色一个条目」。
//
// ⚠️ 顺序很重要：候选结果**先在内存里过完全部断言，通过后才写盘**。
//    此前多次「先写盘、再断言」在失败时留下被改坏的文件，只能靠备份恢复。
//
// 用法：
//   node scripts/ops/collapse-role-fork.mjs --check [--drop <id>]
//   node scripts/ops/collapse-role-fork.mjs --apply [--drop <id>]
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { parsePathArgs, resolvePaths, printPaths } from '../lib/paths.mjs';

const pathFlags = ['home', 'profile', 'patch', 'roles-file'];
const options = parsePathArgs(process.argv.slice(2).filter(a => !['--apply', '--check'].includes(a)), [...pathFlags, 'drop']);
const paths = resolvePaths({ argv: Object.entries(options).filter(([k]) => pathFlags.includes(k)).flatMap(([k, v]) => [`--${k}`, v]) });
printPaths(paths);
const PROFILE = paths.patch;
const SELF = '@magicvr/dsh-agent-switchboard';
const mode = process.argv.includes('--apply') ? 'apply' : 'check';
const dropId = options.drop ?? 'codex-scout';

if (!existsSync(PROFILE)) {
  console.error(`FAIL  找不到 ${PROFILE}`);
  process.exit(1);
}

const original = readFileSync(PROFILE, 'utf8').replace(/\r\n/g, '\n');
const lines = original.split('\n');
const doc = parse(original);

// --- 定位 preset 与其本包条目 -------------------------------------------------
const presetOp = (() => {
  for (let i = 0; i < lines.length; i++) {
    if (!/^- /.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !/^- /.test(lines[end])) end++;
    if (lines.slice(i, end).some((l) => /id:\s*preset-switchboard\s*$/.test(l))) return { start: i, end };
  }
  return undefined;
})();
if (!presetOp) {
  console.error('FAIL  找不到 preset-switchboard 的顶层操作');
  process.exit(1);
}
const selfRow = doc
  .find((o) => Array.isArray(o?.insert) && o.insert.some((r) => r.id === 'preset-switchboard'))
  ?.insert.find((r) => r.id === 'preset-switchboard')
  ?.config?.plugins?.find((p) => p?.name === SELF);
if (!selfRow) {
  console.error(`FAIL  preset 里找不到本包条目 ${SELF}`);
  process.exit(1);
}
const roles = selfRow.config?.roles ?? [];
console.log(`当前角色（${roles.length} 个）：`);
for (const r of roles) {
  console.log(`  ${String(r.id).padEnd(14)} backend=${String(r.backend).padEnd(6)} model=${r.model}`);
}

const target = roles.find((r) => r.id === dropId);
if (!target) {
  console.log(`\n没有名为 "${dropId}" 的角色，无需收敛。`);
  process.exit(0);
}
const remaining = roles.filter((r) => r.id !== dropId);
console.log(`\n将删除角色 "${dropId}"（backend=${target.backend}），剩余 ${remaining.length} 个。`);
if (remaining.length === 0) {
  console.error('FAIL  删除后一个角色都不剩，中止');
  process.exit(1);
}
// 至少要留下一个 builtin 角色，否则主代理的内置委派能力会整体消失。
const builtinLeft = remaining.filter((r) => (r.backend ?? 'spawn') !== 'cli');
console.log(`删除后 builtin 后端角色 ${builtinLeft.length} 个：${builtinLeft.map((r) => r.id).join(', ') || '（无）'}`);
if (builtinLeft.length === 0) {
  console.error('FAIL  删除后没有任何 builtin 角色，这会改变默认能力，请显式确认；中止');
  process.exit(1);
}

// --- 文本级删除该角色块 -------------------------------------------------------
// 角色项形如 `      - id: "scout"` 后跟更深的缩进行，直到下一个同缩进的 `- `。
const roleItemIndentRe = /^(\s*)- id:\s*"?codex-scout"?\s*$/;
let start = -1;
for (let i = presetOp.start; i < presetOp.end; i++) {
  const m = roleItemIndentRe.exec(lines[i]);
  if (m) {
    start = i;
    break;
  }
}
if (start === -1) {
  // 用 yaml 解析能定位到，但文本没匹配上 —— 说明引号/缩进形态与预期不同，必须报错而不是猜。
  console.error(`FAIL  解析里存在 "${dropId}"，但文本定位失败（引号或缩进形态不符预期）。`);
  console.error('      拒绝继续：宁可不改，也不要写坏配置。');
  process.exit(1);
}
const indent = lines[start].length - lines[start].trimStart().length;
let end = start + 1;
while (end < lines.length) {
  const l = lines[end];
  if (l.trim() === '') {
    end++;
    continue;
  }
  const ind = l.length - l.trimStart().length;
  if (ind < indent) break;
  if (ind === indent && /^\s*- /.test(l)) break;
  end++;
}
console.log(`文本定位：第 ${start + 1}..${end} 行（缩进 ${indent}）`);

let next = [...lines.slice(0, start), ...lines.slice(end)];

// --- 候选结果先在内存里校验 ---------------------------------------------------
const candidate = next.join('\n');

/** 统计指定文本里非注释行的 !!js 数量。 */
function countJs(text) {
  return (
    text
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
      .match(/!!js /g)?.length ?? 0
  );
}
/** 定位 preset 顶层操作区间。 */
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

const problems = [];
let parsed;
try {
  parsed = parse(candidate);
} catch (error) {
  problems.push(`候选结果无法解析：${error.message}`);
}
let afterRoles;
if (parsed) {
  afterRoles = parsed
    .find((o) => Array.isArray(o?.insert) && o.insert.some((r) => r.id === 'preset-switchboard'))
    ?.insert.find((r) => r.id === 'preset-switchboard')
    ?.config?.plugins?.find((p) => p?.name === SELF)?.config?.roles;
  if (!Array.isArray(afterRoles)) problems.push('候选结果里找不到 roles 数组');
  else {
    if (afterRoles.some((r) => r.id === dropId)) problems.push(`"${dropId}" 仍然存在`);
    if (afterRoles.length !== remaining.length) {
      problems.push(`roles 数变为 ${afterRoles.length}，期望 ${remaining.length}`);
    }
    // 其余角色的关键字段必须一字未动。
    for (const before of remaining) {
      const after = afterRoles.find((r) => r.id === before.id);
      if (!after) {
        problems.push(`角色 "${before.id}" 丢失`);
        continue;
      }
      for (const key of ['backend', 'model', 'effort', 'readOnly', 'allowNestedDispatch']) {
        if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
          problems.push(`角色 "${before.id}" 的 ${key} 被改动：${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`);
        }
      }
    }
  }
  // preset 里的 !!js（standard 复制来的 platform 条件）必须一条不少。
  const rBefore = presetRange(original);
  const rAfter = presetRange(candidate);
  const jsBefore = countJs(original.split('\n').slice(rBefore[0], rBefore[1]).join('\n'));
  const jsAfter = rAfter ? countJs(candidate.split('\n').slice(rAfter[0], rAfter[1]).join('\n')) : -1;
  console.log(`preset 内 !!js：前 ${jsBefore} → 后 ${jsAfter}`);
  if (jsBefore !== jsAfter) problems.push('preset 内的 !!js 被破坏');
}

if (problems.length > 0) {
  console.error('\nFAIL  候选结果未通过校验，**未写盘**：');
  for (const p of problems) console.error(`      - ${p}`);
  process.exit(1);
}
console.log('PASS  候选结果通过全部校验');
console.log(`      roles = ${afterRoles.map((r) => `${r.id}(${r.backend ?? 'spawn'})`).join(', ')}`);

if (mode === 'check') {
  console.log('\n未写盘（加 --apply 才写）。');
  process.exit(0);
}

copyFileSync(PROFILE, `${PROFILE}.bak-collapse-${Date.now()}`);
writeFileSync(PROFILE, candidate, 'utf8');
console.log(`\nPASS  已删除角色 "${dropId}" 并写盘。`);
console.log('提示：cli 后端代码仍完整保留，切换任一角色到 cli 只需把它的 backend 改为 "cli"');
console.log('      并填 cliCommand / cliArgs / cliPromptDelivery / cliCwd（见 docs/cli-backends.md）。');
