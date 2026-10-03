// 预检：本插件是否真的会被 Loader 加载。
//
// 为什么需要：实测踩到一次 —— profile 的 `dsh.profile.bundles` 里少了本包，于是
// Loader 从不加载 `cordis.patch.yml` 那份 insert，条目 `include:agent-switchboard`
// **根本不存在**。现象是「应用正常启动，但设置页与自检工具都消失」，而**没有任何报错**：
// 启动时只加载 dsh-base + dsh-web-app 是完全自洽的。
//
// 这类「静默不存在」只能靠一条显式断言挡住，否则每次都要花一次重启去发现。
//
// 用法：node scripts/check-profile-wiring.mjs [--profile <目录>] [--patch <文件>]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { resolvePaths, printPaths } from './lib/paths.mjs';

const SELF = '@magicvr/dsh-agent-switchboard';
const repairRules = '执行 npm run gen:preset && npm run inject:preset，然后重启 DSH。';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readDocument(path, parser) {
  try { return { data: parser(readFileSync(path, 'utf8')) }; } catch (error) {
    return { error: `无法读取或解析文件：${error.message}` };
  }
}

// 结构错误保留为失败原因，不能靠空数组回退掩盖或接受单个 insert 对象。
function readPatch(path) {
  const result = readDocument(path, parse);
  if (result.error) return result;
  if (!Array.isArray(result.data)) return { error: 'patch 顶层必须是操作列表数组' };
  const entries = [];
  for (const op of result.data) {
    if (!isObject(op)) return { error: 'patch 操作必须是对象' };
    if (!Object.hasOwn(op, 'insert')) continue;
    if (!Array.isArray(op.insert)) return { error: 'patch 的 insert 必须是条目数组' };
    if (!op.insert.every(isObject)) return { error: 'insert 数组中的条目必须是对象' };
    entries.push(...op.insert);
  }
  return { entries };
}

function presetConfig(patch) {
  if (patch.error) return { error: patch.error };
  const preset = patch.entries.find(row => row.id === 'preset-switchboard');
  if (!preset) return { error: '缺少 preset-switchboard 声明' };
  if (!isObject(preset.config)) return { preset, error: 'preset-switchboard 的 config 必须是对象' };
  if (!Array.isArray(preset.config.plugins)) return { preset, error: 'preset 的 plugins 必须是数组' };
  if (!preset.config.plugins.every(isObject)) return { preset, error: 'plugins 数组中的条目必须是对象' };
  const selfRow = preset.config.plugins.find(plugin => plugin.name === SELF);
  if (!selfRow) return { preset, error: 'preset 的 plugins 缺少本包条目' };
  if (!isObject(selfRow.config)) return { preset, selfRow, error: 'preset 里本包的 config 必须是对象' };
  return { preset, selfRow, config: selfRow.config };
}

let paths;
try { paths = resolvePaths(); } catch (error) {
  console.error(`FAIL  ${error.message}`);
  process.exit(1);
}
const profileDir = paths.profile;

let pass = 0;
let fail = 0;
/**
 * 断言。
 *
 * @param {string} label - 说明。
 * @param {boolean} condition - 条件。
 * @param {string} [detail] - 失败详情；同时作为修复建议输出。
 */
function check(label, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `\n        → ${detail}` : ''}`);
  }
}

printPaths(paths);

// 本检查针对**本机已安装的 profile**，因此在别的机器/CI 上应优雅跳过，
// 而不是把 `npm run check` 弄红 —— 那些环境本来就没有这个 profile。
if (!existsSync(join(profileDir, 'package.json'))) {
  if (paths.explicitTarget) {
    console.error(`FAIL  显式目标缺少 profile package.json：${profileDir}`);
    process.exit(1);
  }
  console.log(`跳过：${profileDir} 下没有 profile（本检查只对已安装的 profile 有意义）。`);
  console.log(`\n结果：0 通过 / 0 失败（跳过）`);
  process.exit(0);
}

// --- 1) profile 的 package.json：必须把本包列进 bundles ---------------------------
console.log('=== profile package.json ===');
const pkgPath = join(profileDir, 'package.json');
if (!existsSync(pkgPath)) {
  console.error(`FAIL  找不到 ${pkgPath}`);
  process.exit(1);
}
const pkgResult = readDocument(pkgPath, JSON.parse);
const pkg = pkgResult.data;
const bundles = pkg?.dsh?.profile?.bundles ?? [];
console.log(`  bundles = ${JSON.stringify(bundles)}`);
check(
  `dsh.profile.bundles 含 ${SELF}`,
  Array.isArray(bundles) && bundles.includes(SELF),
  `${pkgResult.error ?? 'dsh.profile.bundles 必须是含本包的数组'}；把 "${SELF}" 加进 dsh.profile.bundles（仅加 dependencies 不够：Loader 只加载 bundles 里列出的包）。`,
);
check(
  'dependencies 里也有本包（供解析包体）',
  isObject(pkg?.dependencies) && Object.hasOwn(pkg.dependencies, SELF),
  `${pkgResult.error ?? 'dependencies 必须是含本包的对象'}；dsh.profile.bundles 有但 dependencies 没有时，包体解析不到。`,
);

// --- 2) 仓库里的 bundle patch：必须声明条目且启用 --------------------------------
console.log('\n=== 仓库 cordis.patch.yml（bundle 层）===');
const repoPatch = new URL('../cordis.patch.yml', import.meta.url);
if (!existsSync(repoPatch)) {
  console.error(`FAIL  找不到 ${repoPatch}`);
  process.exit(1);
}
const repoDoc = readPatch(repoPatch);
const repoSelf = repoDoc.entries?.find(e => e.name === SELF);
const bundleDetail = `${repoDoc.error ?? (repoSelf === undefined ? 'bundle patch 缺少本包条目' : '本包条目未启用')}；修正仓库 cordis.patch.yml 的操作列表与 insert 数组，确保本包条目启用。${repairRules}`;
check('bundle patch 里声明了本包条目', repoSelf !== undefined, bundleDetail);
check(
  '该条目未被 disabled（客户端模块扫描会跳过 disabled 条目）',
  repoSelf !== undefined && repoSelf.disabled !== true,
  `${bundleDetail} disabled:true 会让客户端设置页完全不出现，且没有任何报错。`,
);

// --- 3) preset 声明里必须带 mount:true 与同步的调度规则 -------------------------
console.log('\n=== profile cordis.patch.yml（preset 声明）===');
const profilePatch = paths.patch;
if (!existsSync(profilePatch)) {
  console.error(`FAIL  找不到 ${profilePatch}`);
  process.exit(1);
}
const profileDoc = readPatch(profilePatch);
const profilePreset = presetConfig(profileDoc);
const { preset, selfRow, config } = profilePreset;
const presetDetail = `${profilePreset.error ?? 'preset 配置缺失或漂移'}；${repairRules}`;
check('存在 preset-switchboard 声明', preset !== undefined, presetDetail);
check('preset 的 plugins 里含本包', selfRow !== undefined, presetDetail);
check(
  'preset 里本包声明了 mount:true（否则角色工具不会挂载）',
  config?.mount === true,
  `${presetDetail} 没有 mount:true 时插件在 preset 会话里也不挂载任何角色工具。`,
);
check(
  'preset 里本包不再携带 roles（角色已迁到配置文件）',
  config !== undefined && config.roles === undefined,
  `${presetDetail} roles 若仍在这里，会与 $DSH_HOME/agent-switchboard/roles.json 形成两份真相。`,
);

const profileRules = config?.supervisorRules;
const hasProfileRules = typeof profileRules === 'string' && profileRules.trim().length > 0;
check(
  'preset 里本包的 supervisorRules 存在且为非空字符串',
  hasProfileRules,
  `调度规则缺失、类型错误或仅含空白；${presetDetail}`,
);

const repoPresetPath = new URL('../presets/switchboard.patch.yml', import.meta.url);
const repoPreset = presetConfig(readPatch(repoPresetPath));
const repoRules = repoPreset.config?.supervisorRules;
const repoRulesError = repoPreset.error
  ? `仓库 preset 生成物：${repoPreset.error}`
  : typeof repoRules !== 'string' || !repoRules.trim()
    ? '仓库生成物的 supervisorRules 缺失或非有效字符串' : undefined;

let rulesDetail;
if (repoRulesError) {
  rulesDetail = `${repoRulesError}；${repairRules}`;
} else if (!hasProfileRules) {
  rulesDetail = `profile 未同步有效调度规则；${repairRules}`;
} else if (profileRules !== repoRules) {
  let offset = 0;
  while (offset < Math.min(profileRules.length, repoRules.length)
    && profileRules[offset] === repoRules[offset]) offset++;
  const snippet = value => JSON.stringify(value.slice(Math.max(0, offset - 12), offset + 20));
  rulesDetail = `profile 已过期，需重新注入；长度（UTF-16）：profile=${profileRules.length}，生成物=${repoRules.length}；`
    + `首个不同位置（从 0 起）=${offset}，附近 profile=${snippet(profileRules)}，生成物=${snippet(repoRules)}。${repairRules}`;
}
check(
  'profile supervisorRules 与仓库 preset 生成物逐字符一致',
  !repoRulesError && hasProfileRules && profileRules === repoRules,
  rulesDetail,
);

// --- 4) 角色配置文件 -----------------------------------------------------------
console.log('\n=== 角色配置文件 ===');
const rolesPath = paths.roles;
if (!existsSync(rolesPath)) {
  if (paths.explicitTarget) {
    console.error(`FAIL  显式目标缺少 roles 文件：${rolesPath}`);
    process.exit(1);
  }
  console.log(`  （尚无 ${rolesPath} —— 首次进入设置页保存时会创建）`);
} else {
  const result = readDocument(rolesPath, JSON.parse);
  const data = result.data;
  const hasRoles = isObject(data) && Array.isArray(data.roles) && data.roles.every(isObject);
  const ids = hasRoles ? data.roles.map(r => typeof r?.id === 'string' ? r.id : '（无有效 id）') : [];
  console.log(`  roles = ${ids.join(', ')}`);
  check('配置文件可解析且含 roles 数组', hasRoles,
    `${result.error ?? '角色配置顶层必须是对象且 roles 必须是对象条目数组'}；修正 roles 文件的 JSON 与 roles 数组，或在设置页保存有效角色配置。文件损坏时装载期会报错并拒绝挂载角色工具。`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
