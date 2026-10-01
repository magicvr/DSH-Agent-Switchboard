// 开启跨 CLI 派发（allowCrossCli），用于 Phase 3 真实派发验证。
//
// 为什么写成显式声明而不是让用户在面板里拨开关：
//   `allowCrossCli` 是 volatile 字段，面板拨动只影响运行中的实例，不落盘。
//   写成 preset config 的一部分后，实验状态**可复现**，也能直接被 git 审阅。
//
// ⚠️ 文本级补丁，绝不用 yaml.stringify 整体重写（会把 `!!js` 表达式降级为普通
//    字符串，使 standard 复制来的 platform 条件静默失效）。
//
// 用法：
//   node scripts/toggle-cross-cli.mjs --check
//   node scripts/toggle-cross-cli.mjs --on
//   node scripts/toggle-cross-cli.mjs --off
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { parse } from 'yaml';

const PROFILE = 'C:/Users/magicvr/.dsh/profiles/desktop/cordis.patch.yml';
const SELF = '@magicvr/dsh-agent-switchboard';
const want = process.argv.includes('--on')
  ? true
  : process.argv.includes('--off')
    ? false
    : undefined;

const original = readFileSync(PROFILE, 'utf8').replace(/\r\n/g, '\n');
const lines = original.split('\n');
const doc = parse(original);

// --- 预检 ---------------------------------------------------------------------
const preset = doc
  .find((o) => Array.isArray(o?.insert) && o.insert.some((r) => r.id === 'preset-switchboard'))
  ?.insert.find((r) => r.id === 'preset-switchboard');
const selfRow = (preset?.config?.plugins ?? []).find((p) => p?.name === SELF);
if (!selfRow) {
  console.error(`FAIL  preset 里找不到本包条目 ${SELF}`);
  process.exit(1);
}
const roles = selfRow.config?.roles ?? [];
const cliRoles = roles.filter((r) => r.backend === 'cli');
console.log(`preset 内角色数 = ${roles.length}，其中 CLI 后端 ${cliRoles.length} 个`);
for (const r of cliRoles) console.log(`  - ${r.id}（model=${r.model} effort=${r.effort}）`);
const current = selfRow.config?.volatile?.allowCrossCli;
console.log(`当前 volatile.allowCrossCli = ${JSON.stringify(current)}`);

if (want === undefined) {
  console.log('\n未指定动作（--on / --off / --check）。');
  process.exit(0);
}
// ⚠️ 「必须存在 CLI 角色」只应拦住**开启**。
//    早先这个守卫对任何动作都生效，于是当配置里一个 CLI 角色都没有时**无法关闭**该开关 ——
//    而「没有 CLI 角色时把总开关关掉」恰恰是最该允许、也最安全的操作。
if (want === true && cliRoles.length === 0) {
  console.error('FAIL  没有任何 CLI 后端角色，开启该开关没有意义。');
  console.error('      请先把某个角色的 backend 改为 "cli"（见 docs/cli-backends.md 与 decisions.md D13）。');
  process.exit(1);
}
if (current === want) {
  console.log(`\n已是目标值 ${want}，无需改动。`);
  process.exit(0);
}

// --- 文本定位本包条目行 -------------------------------------------------------
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
  console.error('FAIL  定位 preset 顶层操作失败');
  process.exit(1);
}
const selfLine = lines.findIndex(
  (l, i) =>
    i >= presetOp.start &&
    i < presetOp.end &&
    /^\s*- id:\s*switchboard-roles\s*$/.test(l),
);
if (selfLine === -1) {
  console.error('FAIL  在 preset 内找不到本包条目行（- id: switchboard-roles）');
  process.exit(1);
}
const selfIndent = lines[selfLine].length - lines[selfLine].trimStart().length;
console.log(`\n本包条目在第 ${selfLine + 1} 行，缩进 ${selfIndent}`);

// 找该条目的 `config:` 行，并取其**子键缩进**。
//
// ⚠️ 不能按 `selfIndent + 2` 推算子键缩进：`config:` 本身是列表项 `- id:` 的子键，
//    实测其缩进为 selfIndent + 2，而 config 的**子键**又在 configIndent + 2 上。
//    第一版按 selfIndent + 2 插 `volatile:`，结果它与 `config:` 同级，把 roles 套进了
//    `config.volatile` 里 —— 必须直接测量 `config:` 与其子键的实际缩进。
let configLine = -1;
for (let i = selfLine + 1; i < presetOp.end; i++) {
  const l = lines[i];
  if (/^\s*- /.test(l)) break;
  if (/^\s*config:\s*$/.test(l)) {
    configLine = i;
    break;
  }
}
if (configLine === -1) {
  console.error('FAIL  该条目没有 config: 行，无法插入 volatile');
  process.exit(1);
}
const configIndent = lines[configLine].length - lines[configLine].trimStart().length;
// 取 config 下第一行的缩进作为子键缩进基准。
let childIndent = configIndent + 2;
for (let i = configLine + 1; i < presetOp.end; i++) {
  const l = lines[i];
  if (l.trim() === '') continue;
  if (/^\s*- /.test(l)) break;
  const ind = l.length - l.trimStart().length;
  if (ind <= configIndent) break;
  childIndent = ind;
  break;
}
console.log(`config: 在第 ${configLine + 1} 行，缩进 ${configIndent}；子键缩进 ${childIndent}`);

let volatileLine = -1;
for (let i = configLine + 1; i < presetOp.end; i++) {
  const l = lines[i];
  if (l.trim() === '') continue;
  const ind = l.length - l.trimStart().length;
  if (ind < childIndent) break;
  if (ind === childIndent && /^volatile:\s*$/.test(l.trimStart())) volatileLine = i;
}
console.log(`volatile: 行 = ${volatileLine === -1 ? '（无）' : volatileLine + 1}`);

// --- 在内存中构造候选结果 ------------------------------------------------------
let next = [...lines];
if (volatileLine === -1) {
  const ins = [`${' '.repeat(childIndent)}volatile:`, `${' '.repeat(childIndent + 2)}allowCrossCli: ${want}`];
  next = [...next.slice(0, configLine + 1), ...ins, ...next.slice(configLine + 1)];
} else {
  const keyIndent = ' '.repeat(childIndent + 2);
  let keyLine = -1;
  for (let i = volatileLine + 1; i < presetOp.end; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    const ind = l.length - l.trimStart().length;
    if (ind <= childIndent) break;
    if (/^allowCrossCli:/.test(l.trimStart())) keyLine = i;
  }
  next =
    keyLine !== -1
      ? [...next.slice(0, keyLine), `${keyIndent}allowCrossCli: ${want}`, ...next.slice(keyLine + 1)]
      : [...next.slice(0, volatileLine + 1), `${keyIndent}allowCrossCli: ${want}`, ...next.slice(volatileLine + 1)];
}

// --- 先在内存里验证，**通过后才写盘** ----------------------------------------
// ⚠️ 顺序很重要：此前两个脚本都是「先写盘、再断言」，失败时留下已被修改的文件，
//    只能靠备份恢复（实测发生过两次）。这里改为候选文本先过全部断言。
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

let parsed;
try {
  parsed = parse(candidate);
} catch (error) {
  console.error(`\nFAIL  候选结果无法解析：${error.message}`);
  console.error('      未写盘，profile 保持原样。');
  process.exit(1);
}
const checkSelf = parsed
  .find((o) => Array.isArray(o?.insert) && o.insert.some((r) => r.id === 'preset-switchboard'))
  ?.insert.find((r) => r.id === 'preset-switchboard')
  ?.config?.plugins?.find((p) => p?.name === SELF);
const problems = [];
if (checkSelf?.config?.volatile?.allowCrossCli !== want) {
  problems.push(`allowCrossCli 未落到预期值（实际 ${JSON.stringify(checkSelf?.config?.volatile?.allowCrossCli)}）`);
}
if ((checkSelf?.config?.roles ?? []).length !== roles.length) {
  problems.push(`roles 数变为 ${(checkSelf?.config?.roles ?? []).length}（期望 ${roles.length}）`);
}
for (const key of ['provider', 'maxDepth', 'cwd']) {
  if (checkSelf?.config?.[key] === undefined) problems.push(`顶层配置键 ${key} 丢失`);
}
const rBefore = presetRange(original);
const rAfter = presetRange(candidate);
if (!rAfter) {
  problems.push('候选结果里找不到 preset 操作');
} else {
  const jsBefore = countJs(original.split('\n').slice(rBefore[0], rBefore[1]).join('\n'));
  const jsAfter = countJs(candidate.split('\n').slice(rAfter[0], rAfter[1]).join('\n'));
  console.log(`  preset 内 !!js：前 ${jsBefore} → 后 ${jsAfter}`);
  if (jsBefore !== jsAfter) problems.push('preset 内的 !!js 被破坏');
}

if (problems.length > 0) {
  console.error('\nFAIL  候选结果未通过校验，**未写盘**：');
  for (const p of problems) console.error(`      - ${p}`);
  process.exit(1);
}

console.log('\n复核通过：');
console.log(`  volatile.allowCrossCli = ${JSON.stringify(checkSelf.config.volatile.allowCrossCli)}`);
console.log(`  roles 数 = ${checkSelf.config.roles.length}（未变）`);
console.log(`  顶层键 = ${Object.keys(checkSelf.config).join(', ')}`);

copyFileSync(PROFILE, `${PROFILE}.bak-crosscli-${Date.now()}`);
writeFileSync(PROFILE, candidate, 'utf8');
console.log(`\nPASS  allowCrossCli = ${want}（已写盘）`);
