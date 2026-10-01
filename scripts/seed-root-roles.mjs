// 给 profile 里的根条目补一段 config（角色列表），并确保 dsh.profile.bundles 含本包。
//
// 为什么角色要放这里：
//   - 客户端唯一可写通道是 `settings.mutate(ns, …)`，`ns` 只能是**根条目** id
//     （`configEditor.entries()` 只取 `parent.tree.ctx.fiber.entry?.id === "include"`
//     的条目）。因此「UI 可编辑」要求角色落在根条目的 Cordis 配置里。
//   - 根条目**不挂载**角色工具（`mount` 保持 false），工具只在 preset 会话挂载。
//
// 这样 UI（设置页）↔ 配置 ↔ 文件三方一致：UI 写配置，Host 侧把配置同步到文件，
// preset 会话读文件。
//
// 用法：
//   node scripts/seed-root-roles.mjs --check
//   node scripts/seed-root-roles.mjs --apply
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { join } from 'node:path';
import { resolvePaths, printPaths } from './lib/paths.mjs';

const paths = resolvePaths({ argv: process.argv.slice(2).filter(a => !['--apply', '--check'].includes(a)) });
printPaths(paths);
const PATCH = paths.patch;
const PKG = join(paths.profile, 'package.json');
const SELF = '@magicvr/dsh-agent-switchboard';
const ROLES_FILE = paths.roles;
const mode = process.argv.includes('--apply') ? 'apply' : 'check';

let pass = 0;
let fail = 0;
/**
 * 断言。
 *
 * @param {string} label - 说明。
 * @param {boolean} c - 条件。
 * @param {string} [d] - 详情。
 */
function check(label, c, d = '') {
  if (c) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${d ? ` — ${d}` : ''}`);
  }
}

// --- 读现状 -------------------------------------------------------------------
const patchText = readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n');
const doc = parse(patchText);
if (!Array.isArray(doc)) {
  console.error('FAIL  profile patch 顶层不是数组');
  process.exit(1);
}

if (paths.explicitTarget && !existsSync(ROLES_FILE)) throw new Error(`FAIL  找不到显式目标 roles 文件：${ROLES_FILE}`);
const roles = existsSync(ROLES_FILE) ? JSON.parse(readFileSync(ROLES_FILE, 'utf8')).roles : [];
// package 也是输入；缺失或旧结构不符必须在写 patch 前失败。
const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
if (!Array.isArray(pkg?.dsh?.profile?.bundles)) throw new Error('FAIL  package 缺少 dsh.profile.bundles 数组');
console.log(`来源角色（${ROLES_FILE}）：${roles.length} 个 —— ${roles.map((r) => r.id).join(', ') || '（无）'}`);

const existing = doc.find((op) => op?.id === 'agent-switchboard');
console.log(`profile 里已有根条目操作：${existing === undefined ? '无' : JSON.stringify(existing)}`);

// --- 目标形状 -----------------------------------------------------------------
// 根条目：显式给出 mount:false（根不挂载角色工具，只承载配置）与 roles。
const desired = {
  id: 'agent-switchboard',
  name: SELF,
  config: {
    mount: false,
    provider: 'self',
    maxDepth: 3,
    roles,
  },
};

console.log('\n将要写入的根条目操作：');
console.log(stringify(desired).trim());

if (mode === 'check') {
  console.log('\n未写盘（加 --apply 才写）。');
  process.exit(0);
}

// --- 写 patch -----------------------------------------------------------------
// 替换已有操作或追加。追加时放在 preset insert 之前（配置先于引用更易读）。
const next = doc.filter((op) => op?.id !== 'agent-switchboard');
const insertIdx = next.findIndex((op) => Array.isArray(op?.insert) && op.insert.some((r) => r.id === 'preset-switchboard'));
if (insertIdx === -1) next.push(desired);
else next.splice(insertIdx, 0, desired);

// ⚠️ 不能用 yaml.stringify 整体重写：它会把 !!js 表达式降级成普通字符串，
//    使 standard 复制来的 platform 条件静默失效（实测踩过）。
//    因此只在文本层插入/替换这一段，其余原样保留。
//
// ⚠️ 另一个必须处理的细节：`stringify` 产出的是**顶层映射**，而 profile patch 的顶层是
//    **数组**。直接拼接会得到「映射后跟数组项」的坏 YAML（实测报
//    `Unexpected scalar at node end`）。必须把首行接在 `- ` 之后、其余行统一缩进 2 格，
//    使其成为合法的数组项。
const mapYaml = stringify(desired).trimEnd().split('\n');
const desiredYaml = [`- ${mapYaml[0]}`, ...mapYaml.slice(1).map((l) => (l.length > 0 ? `  ${l}` : l))].join('\n');
let outText;
if (existing !== undefined) {
  // 用其 id 行定位整段并替换。
  const lines = patchText.split('\n');
  const idLine = lines.findIndex((l) => /^\s*-\s*id:\s*agent-switchboard\s*$/.test(l));
  if (idLine === -1) {
    console.error('FAIL  文本定位 agent-switchboard 操作失败');
    process.exit(1);
  }
  let end = idLine + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() !== '' && /^\s*-\s/.test(l)) break;
    end++;
  }
  outText = [...lines.slice(0, idLine), desiredYaml, ...lines.slice(end)].join('\n');
} else {
  // 在 preset insert 之前插入。
  const lines = patchText.split('\n');
  const insLine = lines.findIndex((l) => /^\s*-\s*insert:\s*$/.test(l));
  const at = insLine === -1 ? lines.length : insLine;
  outText = [...lines.slice(0, at), desiredYaml, ...lines.slice(at)].join('\n');
}

copyFileSync(PATCH, `${PATCH}.bak-seed-root-${Date.now()}`);
writeFileSync(PATCH, outText, 'utf8');
console.log(`\n已写入 ${PATCH}`);

// --- 写 package.json 的 bundles ------------------------------------------------
if (!pkg.dsh.profile.bundles.includes(SELF)) {
  pkg.dsh.profile.bundles.push(SELF);
  copyFileSync(PKG, `${PKG}.bak-seed-root`);
  writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`已把 ${SELF} 加进 dsh.profile.bundles`);
}

// --- 复核 ---------------------------------------------------------------------
console.log('\n复核：');
const afterText = readFileSync(PATCH, 'utf8');
let after;
try {
  after = parse(afterText);
} catch (error) {
  console.error(`FAIL  产物无法解析：${error.message}`);
  process.exit(1);
}
check('顶层仍是数组', Array.isArray(after));
const jsBefore = (patchText.match(/!!js /g) ?? []).length;
const jsAfter = (afterText.match(/!!js /g) ?? []).length;
check(`!!js 表达式数量不变（${jsBefore} → ${jsAfter}）`, jsBefore === jsAfter);
const rootAfter = after.find((op) => op?.id === 'agent-switchboard');
check('根条目操作存在', rootAfter !== undefined);
check('根条目带 mount:false（不挂载角色工具）', rootAfter?.config?.mount === false, JSON.stringify(rootAfter?.config?.mount));
check(
  `根条目带 ${roles.length} 个角色`,
  Array.isArray(rootAfter?.config?.roles) && rootAfter.config.roles.length === roles.length,
  String(rootAfter?.config?.roles?.length),
);
const presetAfter = after
  .find((op) => Array.isArray(op?.insert) && op.insert.some((r) => r.id === 'preset-switchboard'))
  ?.insert.find((r) => r.id === 'preset-switchboard');
check('preset 声明仍在', presetAfter !== undefined);
const selfRow = (presetAfter?.config?.plugins ?? []).find((p) => p?.name === SELF);
check('preset 里本包仍带 mount:true', selfRow?.config?.mount === true, JSON.stringify(selfRow?.config));
const pkgAfter = JSON.parse(readFileSync(PKG, 'utf8'));
check('dsh.profile.bundles 含本包', pkgAfter.dsh.profile.bundles.includes(SELF), JSON.stringify(pkgAfter.dsh.profile.bundles));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
