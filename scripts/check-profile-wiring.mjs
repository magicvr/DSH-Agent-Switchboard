// 预检：本插件是否真的会被 Loader 加载。
//
// 为什么需要：实测踩到一次 —— profile 的 `dsh.profile.bundles` 里少了本包，于是
// Loader 从不加载 `cordis.patch.yml` 那份 insert，条目 `include:agent-switchboard`
// **根本不存在**。现象是「应用正常启动，但设置页与自检工具都消失」，而**没有任何报错**：
// 启动时只加载 dsh-base + dsh-web-app 是完全自洽的。
//
// 这类「静默不存在」只能靠一条显式断言挡住，否则每次都要花一次重启去发现。
//
// 用法：node scripts/check-profile-wiring.mjs [--profile <目录>]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const SELF = '@magicvr/dsh-agent-switchboard';

const idx = process.argv.indexOf('--profile');
const profileDir =
  idx === -1 ? 'C:/Users/magicvr/.dsh/profiles/desktop' : process.argv[idx + 1];

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

console.log(`profile: ${profileDir}\n`);

// 本检查针对**本机已安装的 profile**，因此在别的机器/CI 上应优雅跳过，
// 而不是把 `npm run check` 弄红 —— 那些环境本来就没有这个 profile。
if (!existsSync(join(profileDir, 'package.json'))) {
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
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const bundles = pkg?.dsh?.profile?.bundles ?? [];
console.log(`  bundles = ${JSON.stringify(bundles)}`);
check(
  `dsh.profile.bundles 含 ${SELF}`,
  bundles.includes(SELF),
  `把 "${SELF}" 加进 dsh.profile.bundles（仅加 dependencies 不够：Loader 只加载 bundles 里列出的包）。`,
);
check(
  'dependencies 里也有本包（供解析包体）',
  Object.keys(pkg.dependencies ?? {}).includes(SELF),
  `dsh.profile.bundles 有但 dependencies 没有时，包体解析不到。`,
);

// --- 2) 仓库里的 bundle patch：必须声明条目且启用 --------------------------------
console.log('\n=== 仓库 cordis.patch.yml（bundle 层）===');
const repoPatch = 'cordis.patch.yml';
if (!existsSync(repoPatch)) {
  console.error(`FAIL  找不到 ${repoPatch}`);
  process.exit(1);
}
const repoDoc = parse(readFileSync(repoPatch, 'utf8'));
const repoEntries = (Array.isArray(repoDoc) ? repoDoc : []).flatMap((op) => op?.insert ?? []);
const repoSelf = repoEntries.find((e) => e?.name === SELF);
check('bundle patch 里声明了本包条目', repoSelf !== undefined);
check(
  '该条目未被 disabled（客户端模块扫描会跳过 disabled 条目）',
  repoSelf !== undefined && repoSelf.disabled !== true,
  'disabled:true 会让客户端设置页完全不出现，且没有任何报错。',
);

// --- 3) preset 声明里必须带 mount:true -----------------------------------------
console.log('\n=== profile cordis.patch.yml（preset 声明）===');
const profilePatch = join(profileDir, 'cordis.patch.yml');
if (!existsSync(profilePatch)) {
  console.error(`FAIL  找不到 ${profilePatch}`);
  process.exit(1);
}
const profileDoc = parse(readFileSync(profilePatch, 'utf8'));
const preset = profileDoc
  .find((o) => Array.isArray(o?.insert) && o.insert.some((r) => r.id === 'preset-switchboard'))
  ?.insert.find((r) => r.id === 'preset-switchboard');
check('存在 preset-switchboard 声明', preset !== undefined);
const selfRow = (preset?.config?.plugins ?? []).find((p) => p?.name === SELF);
check('preset 的 plugins 里含本包', selfRow !== undefined);
check(
  'preset 里本包声明了 mount:true（否则角色工具不会挂载）',
  selfRow?.config?.mount === true,
  '没有 mount:true 时插件在 preset 会话里也不挂载任何角色工具。',
);
check(
  'preset 里本包不再携带 roles（角色已迁到配置文件）',
  selfRow?.config?.roles === undefined,
  'roles 若仍在这里，会与 $DSH_HOME/agent-switchboard/roles.json 形成两份真相。',
);

// --- 4) 角色配置文件 -----------------------------------------------------------
console.log('\n=== 角色配置文件 ===');
const rolesPath = 'C:/Users/magicvr/.dsh/agent-switchboard/roles.json';
if (!existsSync(rolesPath)) {
  console.log(`  （尚无 ${rolesPath} —— 首次进入设置页保存时会创建）`);
} else {
  const data = JSON.parse(readFileSync(rolesPath, 'utf8'));
  const ids = (data.roles ?? []).map((r) => r.id);
  console.log(`  roles = ${ids.join(', ')}`);
  check('配置文件可解析且含 roles 数组', Array.isArray(data.roles), '文件损坏时装载期会报错并拒绝挂载角色工具。');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
