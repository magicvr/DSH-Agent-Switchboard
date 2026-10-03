// 把角色从 profile patch 迁移到插件自己的配置文件（D13 的一次性迁移）。
//
// 背景：角色原先写在 profile 的 preset 声明里（`config.roles`）。D13 改为存在插件
// 自己的文件 `$DSH_HOME/agent-switchboard/roles.json`，由设置页通过 roleConfig
// 远程服务读写。**不迁移就会丢配置** —— 装载期只会读到「文件不存在」。
//
// 本脚本做两件事：
//   1. 若配置文件缺失或角色为空，用 profile 里的角色播种它；
//   2. 从 preset 声明里移除那一行插件的 `config`（角色不再由那里提供）。
//
// ⚠️ 顺序很重要：**先播种文件、再改 profile**。反过来一旦中途失败，就会既丢了
//    profile 里的角色、又没有文件。
//
// ⚠️ 文本级修改，不用 `yaml.stringify` 整体重写（它会把 `!!js` 表达式降级为普通
//    字符串，使 standard 复制来的 platform 条件静默失效）。
//
// 用法：
//   node scripts/ops/migrate-roles-to-file.mjs --check
//   node scripts/ops/migrate-roles-to-file.mjs --apply
//   node scripts/ops/migrate-roles-to-file.mjs --apply --seed-from <备份文件>
//
// ⚠️ `--seed-from` 是必需的救援路径：`node scripts/ops/probe-preset.mjs --inject` 会用生成好的 preset
//    文件**整块替换** profile 里的声明，因此如果先重新注入、再迁移，profile 里那份
//    角色就已经被替换掉了。此时只能从备份里取回角色。实测踩到过这一步。
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { readConfigFile, readConfigFileDetailed, migrateConfigFileOnDisk, writeConfigFile, initialConfig } from '../../src/config-file.js';
import { join } from 'node:path';
import { parsePathArgs, pathValue, resolvePaths, printPaths } from '../lib/paths.mjs';

const pathFlags = ['home', 'profile', 'patch', 'roles-file'];
const options = parsePathArgs(process.argv.slice(2).filter(a => !['--apply', '--check'].includes(a)), [...pathFlags, 'seed-from']);
const paths = resolvePaths({ argv: Object.entries(options).filter(([k]) => pathFlags.includes(k)).flatMap(([k, v]) => [`--${k}`, v]) });
printPaths(paths);
const PROFILE = paths.patch;
// patch 是输入：即便有备份也不能绕过缺失的显式目标。
if (!existsSync(PROFILE)) throw new Error(`找不到 patch：${PROFILE}`);
const SELF = '@magicvr/dsh-agent-switchboard';
const mode = process.argv.includes('--apply') ? 'apply' : 'check';
/** 显式指定的角色来源（用于从备份救援）。 */
const seedFrom = options['seed-from'] === undefined ? undefined : pathValue(options['seed-from'], '--seed-from', process.cwd());

/**
 * 从某个 patch 文件里取出本包的角色与默认值。
 *
 * @param {string} path - patch 文件路径。
 * @returns {{roles: object[], extra: object} | undefined} 结果；找不到返回 undefined。
 */
function readRolesFrom(path) {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const parsed = parse(text);
  const self = parsed
    .find((o) => Array.isArray(o?.insert) && o.insert.some((r) => r.id === 'preset-switchboard'))
    ?.insert.find((r) => r.id === 'preset-switchboard')
    ?.config?.plugins?.find((p) => p?.name === SELF);
  if (!Array.isArray(self?.config?.roles)) return undefined;
  const extra = {};
  if (typeof self.config.provider === 'string') extra.provider = self.config.provider;
  if (typeof self.config.cwd === 'string') extra.cwd = self.config.cwd;
  if (typeof self.config.maxDepth === 'number') extra.maxDepth = self.config.maxDepth;
  return { roles: self.config.roles, extra };
}

const configPath = paths.roles;
console.log(`配置文件目标：${configPath}`);

// --- 1) 确定角色来源 -----------------------------------------------------------
// 优先显式指定的备份；否则用当前 profile。
let source = seedFrom;
if (source === undefined) {
  const fromProfile = existsSync(PROFILE) ? readRolesFrom(PROFILE) : undefined;
  if (fromProfile !== undefined && fromProfile.roles.length > 0) {
    source = PROFILE;
  } else {
    console.log('当前 profile 里没有角色。尝试从最近的备份里取回……');
    const { readdirSync, statSync } = await import('node:fs');
    const dir = paths.profile;
    // ⚠️ 按**修改时间**倒序，不要按体积 —— 实测按体积会选中更早、更大的那份备份，
    //    从而把一个已经收敛掉的旧角色（codex-scout）又带了回来。
    const baks = readdirSync(dir)
      .filter((f) => f.startsWith('cordis.patch.yml') && f !== 'cordis.patch.yml')
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const candidate of baks) {
      const got = readRolesFrom(candidate);
      if (got === undefined || got.roles.length === 0) continue;
      source = candidate;
      console.log(`  找到含角色的最近备份：${candidate.split('/').pop()}（${got.roles.length} 个：${got.roles.map((r) => r.id).join(', ')}）`);
      break;
    }
  }
}
if (source === undefined) {
  console.error('FAIL  找不到任何含角色的来源（profile 与备份都没有）。');
  console.error('      若角色确实已不存在，请直接跑 --apply（会跳过播种、只清理 profile）。');
  process.exit(1);
}
const picked = readRolesFrom(source);
if (picked === undefined) {
  console.error(`FAIL  ${source} 里找不到 roles`);
  process.exit(1);
}
const { roles: seedRoles, extra: seedExtra } = picked;
console.log(`角色来源：${source}`);
console.log(`角色：${seedRoles.length} 个 —— ${seedRoles.map((r) => r.id).join(', ')}`);
console.log(`默认值：${JSON.stringify(seedExtra)}`);

// --- 2) 现有配置文件状态 -------------------------------------------------------
const detailed = readConfigFileDetailed(configPath);
if (['future', 'unsupported'].includes(detailed.format?.status)) {
  console.error(`FAIL  磁盘配置版本 ${JSON.stringify(detailed.format.onDiskVersion)}，支持版本 ${detailed.format.currentVersion}，拒绝写入：${detailed.error}`);
  console.error('      配置文件与 profile 均保持原状，未改动。');
  process.exit(1);
}
const existing = { ...detailed, value: detailed.config };
if (!existing.ok) {
  console.error(`FAIL  现有配置文件损坏，拒绝覆盖：${existing.error}`);
  console.error('      请先修好或删除它，再重跑本脚本。');
  process.exit(1);
}
const hasFile = existing.missing !== true;
const needsSeed = !hasFile || existing.value.roles.length === 0;
console.log(`配置文件${needsSeed ? (hasFile ? '角色为空，将播种（保留现有字段）' : '不存在，将播种') : `已存在（现有 ${existing.value.roles.length} 个角色，不会覆盖）`}`);

// --- 3) 读取当前 profile，检查 mount ------------------------------------------
const profileText = readFileSync(PROFILE, 'utf8').replace(/\r\n/g, '\n');
const doc = parse(profileText);
const presetDecl = doc
  .find((o) => Array.isArray(o?.insert) && o.insert.some((r) => r.id === 'preset-switchboard'))
  ?.insert.find((r) => r.id === 'preset-switchboard');
if (!presetDecl) {
  console.error('FAIL  profile 里找不到 preset-switchboard 声明');
  process.exit(1);
}
const selfRow = (presetDecl.config?.plugins ?? []).find((p) => p?.name === SELF);
if (!selfRow) {
  console.error(`FAIL  preset 的 plugins 里找不到 ${SELF}`);
  process.exit(1);
}
console.log(`preset 里本包 config = ${JSON.stringify(selfRow.config ?? null)}`);
if (selfRow.config?.mount !== true) {
  console.error('FAIL  preset 里本包条目没有 mount:true —— 若移除 config，角色工具将不再挂载。');
  console.error('      请先跑 `npm run gen:preset` 与 `npm run inject:preset`，让声明带上 mount。');
  process.exit(1);
}
const hasRolesInProfile = Array.isArray(selfRow.config?.roles) && selfRow.config.roles.length > 0;
console.log(`profile 里是否还有 roles：${hasRolesInProfile}`);

console.log('\n将要做的改动：');
if (detailed.format?.status === 'migrated') {
  const pending = migrateConfigFileOnDisk(configPath);
  console.log(`  格式迁移待完成：${JSON.stringify(pending.applied)}（--apply 才写盘）`);
}
if (needsSeed && seedRoles.length > 0) console.log(`  1. 播种配置文件（${seedRoles.length} 个角色）→ ${configPath}`);
else console.log('  1. 不改动配置文件');
console.log(
  hasRolesInProfile
    ? '  2. 把 preset 里该条目的 config 收窄为只剩 mount:true（角色已迁到文件）'
    : '  2. preset 已无 roles，无需改 profile',
);

if (mode === 'check') {
  console.log('\n未写盘（加 --apply 才写）。');
  process.exit(0);
}

// --- 4) 先播种文件（顺序关键：先文件、后 profile）-------------------------------
if (detailed.format?.status === 'migrated') {
  const migrated = migrateConfigFileOnDisk(configPath, { apply: true });
  if (!migrated.ok) {
    console.error(`FAIL  配置格式迁移失败：${migrated.error}`);
    console.error('      未改动 profile —— 保持原状。');
    process.exit(1);
  }
  console.log(`PASS  配置格式迁移完成并复读验证通过；备份：${migrated.backup}`);
}
if (needsSeed && seedRoles.length > 0) {
  const written = writeConfigFile(configPath, initialConfig(seedRoles, { ...seedExtra, ...existing.value, roles: seedRoles }));
  if (!written.ok) {
    console.error(`FAIL  播种配置文件失败：${written.error}`);
    console.error('      未改动 profile —— 保持原状，不制造「两边都没有」的状态。');
    process.exit(1);
  }
  console.log(`\nPASS  已播种配置文件：${configPath}`);
}

// --- 5) 再收窄 profile 里的 config --------------------------------------------
if (hasRolesInProfile) {
  const verified = readConfigFile(configPath);
  if (!verified.ok || verified.missing || verified.value.roles.length === 0
    || (needsSeed && !isDeepStrictEqual(verified.value.roles, seedRoles))) {
    console.error('FAIL  删除 profile 角色前复读配置失败、角色为空或与播种 roles 不一致');
    console.error('      未改动 profile —— 保持原状，不制造「两边都没有」的状态。');
    process.exit(1);
  }
  const lines = profileText.split('\n');
  const selfIdLine = lines.findIndex((l) => /^\s*- id:\s*switchboard-roles\s*$/.test(l));
  if (selfIdLine === -1) {
    console.error('FAIL  文本定位 switchboard-roles 条目失败');
    process.exit(1);
  }
  const idIndent = lines[selfIdLine].length - lines[selfIdLine].trimStart().length;
  const configLine = lines.findIndex(
    (l, i) => i > selfIdLine && l.length - l.trimStart().length === idIndent + 2 && /^config:\s*$/.test(l.trimStart()),
  );
  if (configLine === -1) {
    console.error('FAIL  找不到该条目的 config: 行');
    process.exit(1);
  }
  let end = configLine + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() !== '') {
      const ind = l.length - l.trimStart().length;
      if (ind <= idIndent + 2) break;
    }
    end++;
  }
  const replacement = [`${' '.repeat(idIndent + 2)}config:`, `${' '.repeat(idIndent + 4)}mount: true`];
  const next = [...lines.slice(0, configLine), ...replacement, ...lines.slice(end)];
  copyFileSync(PROFILE, `${PROFILE}.bak-migrate-roles-${Date.now()}`);
  writeFileSync(PROFILE, next.join('\n'), 'utf8');
  console.log(`PASS  已收窄 preset 里该条目的 config（行 ${configLine + 1}..${end} → mount:true）`);
} else {
  console.log('（profile 无需改动）');
}

// --- 8) 复核 ------------------------------------------------------------------
console.log('\n复核：');
const afterText = readFileSync(PROFILE, 'utf8');
let after;
try {
  after = parse(afterText);
} catch (error) {
  console.error(`FAIL  产物无法解析：${error.message}`);
  process.exit(1);
}
const afterSelf = after
  .find((o) => Array.isArray(o?.insert) && o.insert.some((r) => r.id === 'preset-switchboard'))
  ?.insert.find((r) => r.id === 'preset-switchboard')
  ?.config?.plugins?.find((p) => p?.name === SELF);
console.log(`  preset 里本包 config = ${JSON.stringify(afterSelf?.config ?? null)}`);
if (afterSelf?.config?.mount !== true) {
  console.error('FAIL  mount:true 丢失！');
  process.exit(1);
}
const jsBefore = (profileText.match(/!!js /g) ?? []).length;
const jsAfter = (afterText.match(/!!js /g) ?? []).length;
console.log(`  !!js 表达式：前 ${jsBefore} → 后 ${jsAfter}`);
if (jsBefore !== jsAfter) {
  console.error('FAIL  !!js 被破坏');
  process.exit(1);
}
const finalRead = readConfigFile(configPath);
console.log(`  配置文件读取：${finalRead.ok && !finalRead.missing ? `OK（${finalRead.value.roles.length} 个角色：${finalRead.value.roles.map((r) => r.id).join(', ')}）` : `失败：${finalRead.error ?? '文件缺失'}`}`);
if (!finalRead.ok || finalRead.missing || finalRead.value.roles.length === 0) {
  console.error('FAIL  迁移后配置文件不可用或为空');
  process.exit(1);
}
console.log('\nPASS  迁移完成。角色现在只存在于配置文件中，preset 只保留 mount:true。');
