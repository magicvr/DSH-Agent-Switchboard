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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { resolvePaths, printPaths, resolveAsar } from './lib/paths.mjs';

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
let skipped = 0;
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
/**
 * 环境不满足、无法验证（**不是**验证失败）。
 *
 * 归档缺失等条件下必须显式记账：静默不跑会被读成「通过」，那正是本次事故的教训。
 *
 * @param {string} label - 说明。
 * @param {string} [detail] - 未能验证的原因。
 */
function skip(label, detail = '') {
  skipped++;
  console.log(`  SKIP  ${label}${detail ? ` — ${detail}` : ''}`);
}

// --- DSH 版本兼容性：与 @deepseek-ai/dsh-app-boot 的 plugin-compatibility 同规则 ----
//
// 为什么自实现而不是 import semver：仓库的检查链是零依赖的纯 ESM（docs/decisions.md D1），
// 且 semver 只作为 DSH 的传递依赖存在，不能作为本仓库的隐式依赖。
// 覆盖 DSH 清单实际会出现的范围语法：精确版本、比较运算符、^、~、x-range、连字符、||。
// 预发布参与匹配（对应 DSH 的 `{ includePrerelease: true }`）。

/** 与 `getDshRuntimeVersion()` 一致的读取位置（app-boot 自己的 package.json）。 */
const RUNTIME_MANIFEST_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json';
const DSH_SCOPE = '@deepseek-ai';
const isDshPackageName = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');

/** 只读地从 app.asar 取一个文件的文本；不落临时文件、不写归档。 */
function readArchiveEntry(archive, entry) {
  const buffer = readFileSync(archive);
  if (buffer.length < 16) throw new Error('归档文件过短，不是有效的 ASAR');
  const headerSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString('utf8'));
  const dataStart = 8 + buffer.readUInt32LE(4);
  let node = header;
  for (const part of entry.split('/')) {
    node = node?.files?.[part];
    if (node === undefined) throw new Error(`归档内不存在：${entry}`);
  }
  if (node.files !== undefined) throw new Error(`归档内是目录而非文件：${entry}`);
  const start = dataStart + Number(node.offset ?? 0);
  return buffer.subarray(start, start + (node.size ?? 0)).toString('utf8');
}

const SEMVER_IDENTIFIER = /^[0-9A-Za-z-]+$/;
const SEMVER_PART = /^(0|[1-9][0-9]*)$/;

/**
 * 解析严格 SemVer（允许前缀 `v`）；失败返回 null。
 *
 * @param {unknown} text - 版本文本。
 * @returns {{major: bigint, minor: bigint, patch: bigint, prerelease: string[]}|null} 解析结果。
 */
function parseSemverStrict(text) {
  if (typeof text !== 'string') return null;
  const match = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (match === null) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  if (prerelease.some((part) => !SEMVER_IDENTIFIER.test(part)
    || (/^[0-9]+$/.test(part) && !SEMVER_PART.test(part)))) return null;
  return { major: BigInt(match[1]), minor: BigInt(match[2]), patch: BigInt(match[3]), prerelease };
}

/**
 * 解析 range 里的一个版本片段；缺失或 `x`/`X`/`*` 位记为 null。
 *
 * @param {string} text - 片段文本。
 * @returns {{major: bigint|null, minor: bigint|null, patch: bigint|null, prerelease: string[]}|null} 解析结果。
 */
function parseSemverPartial(text) {
  const match = /^v?([0-9]+|[xX*])(?:\.([0-9]+|[xX*]))?(?:\.([0-9]+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim());
  if (match === null) return null;
  const part = (value, required) => {
    if (value === undefined) return required ? undefined : null;
    if (/^[xX*]$/.test(value)) return null;
    return SEMVER_PART.test(value) ? BigInt(value) : undefined;
  };
  const major = part(match[1], true);
  const minor = part(match[2], false);
  const patch = part(match[3], false);
  if (major === undefined || minor === undefined || patch === undefined) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  if (prerelease.some((id) => !SEMVER_IDENTIFIER.test(id)
    || (/^[0-9]+$/.test(id) && !SEMVER_PART.test(id)))) return null;
  return { major, minor, patch, prerelease };
}

/** 按 SemVer 优先级比较（build 元数据不参与）。 */
function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  const x = left.prerelease; const y = right.prerelease;
  if (x.length === 0 || y.length === 0) return x.length === y.length ? 0 : x.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    if (x[index] === undefined) return -1;
    if (y[index] === undefined) return 1;
    if (x[index] === y[index]) continue;
    const xn = /^[0-9]+$/.test(x[index]); const yn = /^[0-9]+$/.test(y[index]);
    if (xn && yn) return BigInt(x[index]) < BigInt(y[index]) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x[index] < y[index] ? -1 : 1;
  }
  return 0;
}

/** 把带缺失位的片段补成下界版本（缺位补 0）。 */
const floorVersion = (part) => ({
  major: part.major, minor: part.minor ?? 0n, patch: part.patch ?? 0n, prerelease: part.prerelease,
});

/** `-0` 上界：排在目标 release 的一切预发布之前，对应 npm 的 `<X.Y.Z-0` 写法。 */
const ceilingVersion = (major, minor) => ({ major, minor, patch: 0n, prerelease: ['0'] });

/**
 * 展开一个 range token 为比较器列表；无法解析返回 null，`*` 之类返回空列表。
 *
 * @param {string} token - 单个 token。
 * @returns {Array<{op: string, version: object}>|null} 比较器列表。
 */
function expandRangeToken(token) {
  if (token === '' || token === '*' || /^[xX]$/.test(token)) return [];
  const match = /^(~>|~|\^|>=|<=|>|<|=)?(.*)$/.exec(token);
  const operator = match[1] ?? '';
  const part = parseSemverPartial(match[2]);
  if (part === null || part.major === null) return part === null ? null : [];
  const lower = floorVersion(part);
  if (operator === '^' || operator === '~' || operator === '~>') {
    let upper;
    if (operator === '~' || operator === '~>') {
      upper = part.minor === null
        ? ceilingVersion(part.major + 1n, 0n)
        : ceilingVersion(part.major, part.minor + 1n);
    } else if (part.major > 0n || part.minor === null) {
      upper = ceilingVersion(part.major + 1n, 0n);
    } else if (part.minor > 0n || part.patch === null) {
      upper = ceilingVersion(0n, part.minor + 1n);
    } else {
      upper = { major: 0n, minor: 0n, patch: part.patch + 1n, prerelease: ['0'] };
    }
    return [{ op: '>=', version: lower }, { op: '<', version: upper }];
  }
  if (operator === '' || operator === '=') {
    if (part.minor === null) return [{ op: '>=', version: lower }, { op: '<', version: ceilingVersion(part.major + 1n, 0n) }];
    if (part.patch === null) return [{ op: '>=', version: lower }, { op: '<', version: ceilingVersion(part.major, part.minor + 1n) }];
    return [{ op: '=', version: lower }];
  }
  if (operator === '>=') return [{ op: '>=', version: lower }];
  if (operator === '>') {
    if (part.minor === null) return [{ op: '>=', version: ceilingVersion(part.major + 1n, 0n) }];
    if (part.patch === null) return [{ op: '>=', version: ceilingVersion(part.major, part.minor + 1n) }];
    return [{ op: '>', version: lower }];
  }
  if (operator === '<') {
    if (part.minor === null) return [{ op: '<', version: { major: part.major, minor: 0n, patch: 0n, prerelease: ['0'] } }];
    if (part.patch === null) return [{ op: '<', version: { major: part.major, minor: part.minor, patch: 0n, prerelease: ['0'] } }];
    return [{ op: '<', version: lower }];
  }
  if (operator === '<=') {
    if (part.minor === null) return [{ op: '<', version: ceilingVersion(part.major + 1n, 0n) }];
    if (part.patch === null) return [{ op: '<', version: ceilingVersion(part.major, part.minor + 1n) }];
    return [{ op: '<=', version: lower }];
  }
  return null;
}

/** 展开连字符范围（`A - B`）；不是连字符范围返回 null。 */
function expandHyphenRange(text) {
  const match = /^(\S+)\s+-\s+(\S+)$/.exec(text.trim());
  if (match === null) return null;
  const lower = parseSemverPartial(match[1]); const upper = parseSemverPartial(match[2]);
  if (lower === null || upper === null || lower.major === null || upper.major === null) return null;
  const comparators = [{ op: '>=', version: floorVersion(lower) }];
  if (upper.minor === null) comparators.push({ op: '<', version: ceilingVersion(upper.major + 1n, 0n) });
  else if (upper.patch === null) comparators.push({ op: '<', version: ceilingVersion(upper.major, upper.minor + 1n) });
  else comparators.push({ op: '<=', version: floorVersion(upper) });
  return comparators;
}

/** 单个比较器判定。 */
function satisfiesComparator(version, comparator) {
  const order = compareSemver(version, comparator.version);
  if (comparator.op === '=') return order === 0;
  if (comparator.op === '>') return order > 0;
  if (comparator.op === '>=') return order >= 0;
  if (comparator.op === '<') return order < 0;
  return order <= 0;
}

/**
 * `semver.satisfies(version, range, { includePrerelease: true })` 的本地等价实现。
 *
 * 空范围与无法解析的范围一律判为不满足 —— 与 DSH 的 `satisfies()` 先拒空串一致。
 *
 * @param {string} versionText - 运行时版本。
 * @param {string} rangeText - 声明范围。
 * @returns {boolean} 是否满足。
 */
function satisfiesDshRange(versionText, rangeText) {
  const version = parseSemverStrict(versionText);
  if (version === null) return false;
  if (typeof rangeText !== 'string' || rangeText.trim() === '') return false;
  return rangeText.split('||').some((alternative) => {
    const text = alternative.trim().replace(/([<>=~^]+)\s+/g, '$1');
    if (text === '') return false;
    const hyphen = expandHyphenRange(text);
    if (hyphen !== null) return hyphen.every((comparator) => satisfiesComparator(version, comparator));
    const comparators = [];
    for (const token of text.split(/\s+/)) {
      const expanded = expandRangeToken(token);
      if (expanded === null) return false;
      comparators.push(...expanded);
    }
    return comparators.every((comparator) => satisfiesComparator(version, comparator));
  });
}

/**
 * DSH `unmetRequirements()` 的等价实现：`engines.dsh` 决定一切并忽略 peers，
 * 否则 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的每个 peer 都必须满足。
 *
 * @param {object} manifest - 插件 package.json。
 * @param {string} runtimeVersion - 运行时版本。
 * @returns {Record<string, string>} 未满足项（键为 `engines.dsh` 或包名）。
 */
function unmetDshRequirements(manifest, runtimeVersion) {
  const engines = isObject(manifest.engines) ? manifest.engines : {};
  if (Object.hasOwn(engines, 'dsh')) {
    if (typeof engines.dsh !== 'string') throw new Error('engines.dsh 必须是字符串');
    return satisfiesDshRange(runtimeVersion, engines.dsh) ? {} : { 'engines.dsh': engines.dsh };
  }
  if (!Object.hasOwn(manifest, 'peerDependencies')) return {};
  if (!isObject(manifest.peerDependencies)) throw new Error('peerDependencies 必须是对象');
  const unmet = {};
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (typeof range !== 'string') throw new Error(`peerDependencies[${JSON.stringify(name)}] 必须是字符串`);
    if (!isDshPackageName(name)) continue;
    const effective = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range;
    if (!satisfiesDshRange(runtimeVersion, effective)) unmet[name] = range;
  }
  return unmet;
}

/** 描述生效的来源与范围，供日志核对。 */
function dshRequirementsOf(manifest) {
  const engines = isObject(manifest.engines) ? manifest.engines : {};
  if (Object.hasOwn(engines, 'dsh')) {
    return { source: 'engines.dsh', ranges: { 'engines.dsh': String(engines.dsh) } };
  }
  const peers = isObject(manifest.peerDependencies) ? manifest.peerDependencies : {};
  return {
    source: 'peerDependencies',
    ranges: Object.fromEntries(Object.entries(peers).filter(([name]) => isDshPackageName(name))),
  };
}

/** 扫描仓库自己的 node_modules（离线检查 import 的正是这一份）。 */
function installedDshPackages(repoRoot) {
  const scope = join(repoRoot, 'node_modules', DSH_SCOPE);
  if (!existsSync(scope)) return { packages: [], errors: [`找不到 ${scope}`] };
  const packages = []; const errors = [];
  for (const entry of readdirSync(scope, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const manifestPath = join(scope, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (error) { errors.push(`${entry.name}/package.json 无法解析：${error.message}`); continue; }
    const name = typeof manifest?.name === 'string' ? manifest.name : `${DSH_SCOPE}/${entry.name}`;
    if (!isDshPackageName(name)) continue;
    packages.push({ name, version: typeof manifest.version === 'string' ? manifest.version : '(无版本)', file: manifestPath });
  }
  return { packages, errors };
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

// --- 5) DSH 版本兼容性：仓库声明 × 安装归档里的运行时 × 仓库内实际安装 --------------
// 事故背景：0.2.0-rc.2 → 0.2.1-rc.1 升级时，离线检查 import 的 DSH 包来自仓库
// node_modules；只要那份版本与安装的运行时错位，检查就会按**错误的接口**通过，
// 而 DSH 在 profile 导入插件前会按 `engines.dsh` / DSH peers 规则拒绝加载。
// 因此这里同时锁两件事：仓库声明的要求要满足 LIVE 运行时，且仓库内安装的每个
// `@deepseek-ai/dsh*` 必须与运行时**完全同版本**。
console.log('\n=== DSH 版本兼容性（仓库 package.json × 安装归档 × 仓库 node_modules）===');
const repoPkgPath = join(paths.repoRoot, 'package.json');
let runtimeVersion;
try {
  const { archive, source } = resolveAsar();
  const runtimeManifest = JSON.parse(readArchiveEntry(archive, RUNTIME_MANIFEST_ENTRY));
  const candidate = runtimeManifest?.version;
  if (parseSemverStrict(candidate) === null) {
    throw new Error(`dsh-app-boot 版本不是合法 SemVer：${JSON.stringify(candidate)}`);
  }
  runtimeVersion = candidate;
  console.log(`  runtime = ${runtimeVersion} [${source}；${RUNTIME_MANIFEST_ENTRY}]`);
} catch (error) {
  // 读不到归档时**明说未验证**，而不是安静跳过兼容性判断。
  skip('DSH 运行时版本读取', `安装归档不可用：${error.message}`);
  console.log('        → 兼容性断言未执行：仓库声明的要求与仓库内实际安装的 DSH 版本都没有被验证。');
}
if (runtimeVersion !== undefined) {
  let repoManifest;
  try { repoManifest = JSON.parse(readFileSync(repoPkgPath, 'utf8')); }
  catch (error) { check('仓库 package.json 可解析（供 DSH 兼容性判断）', false, error.message); }
  if (repoManifest !== undefined) {
    const requirements = dshRequirementsOf(repoManifest);
    console.log(`  要求来源 = ${requirements.source}；范围 = ${JSON.stringify(requirements.ranges)}`);
    try {
      const unmet = unmetDshRequirements(repoManifest, runtimeVersion);
      check(
        `仓库 DSH 版本要求满足运行时 ${runtimeVersion}（engines.dsh 优先，否则所有 DSH peers，含预发布）`,
        Object.keys(unmet).length === 0,
        `未满足：${JSON.stringify(unmet)}；DSH 会在 profile 导入插件前以 incompatible-version 拒绝加载。`,
      );
    } catch (error) {
      check('仓库 DSH 版本要求可评估', false, error.message);
    }
  }
  const installed = installedDshPackages(paths.repoRoot);
  const mismatched = installed.packages.filter((row) => row.version !== runtimeVersion);
  console.log(`  仓库内 DSH 包 = ${installed.packages.map((row) => `${row.name}@${row.version}`).join(', ') || '(无)'}`);
  check(
    `仓库 node_modules 里每个 @deepseek-ai/dsh* 都等于运行时 ${runtimeVersion}`,
    installed.packages.length > 0 && installed.errors.length === 0 && mismatched.length === 0,
    installed.packages.length === 0
      ? `找不到 @deepseek-ai/dsh* 安装：${installed.errors.join('；') || '目录为空'}；离线检查 import 的正是这一份，缺失不能当成通过。`
      : [...installed.errors,
        `版本不一致：${mismatched.map((row) => `${row.name}@${row.version}`).join(', ')}；离线检查会按错误的接口版本通过。`].join('；'),
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped > 0 ? ` / ${skipped} 跳过` : ''}`);
if (skipped > 0) console.log(`⚠️  有 ${skipped} 项未验证（未计入通过）——见上方 SKIP 行。`);
process.exit(fail === 0 ? 0 : 1);
