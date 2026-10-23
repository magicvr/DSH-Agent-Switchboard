// 生命周期只读快照；所有路径和归档读取均可注入，缺失制品不抛异常。
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { captureSync } from './capture.mjs';
import { resolvePaths, resolveAsar, REPO_ROOT } from './paths.mjs';
import { readPatch, presetConfig, findPatchEntry } from './preset-patch.mjs';
import { generatePreset } from './preset-generator.mjs';
import { CONFIG_FORMAT_VERSION, readConfigFileDetailed } from '../../src/config-file.js';
import { parseVersion, compareVersions, formatVersion } from './version.mjs';

// 有界范围判断，匹配 DSH includePrerelease:true 且 range 先 trim；未知语法绝不猜测。
export function satisfiesDshRange(version, range) {
  const runtime = parseVersion(version);
  if (!runtime) return { status: 'unknown', reason: 'invalid-runtime-version' };
  if (typeof range !== 'string') return { status: 'unknown', reason: 'unsupported-range' };
  const trimmed = range.trim();
  // 真实 gate `satisfies`：`range.trim() !== "" && semver.satisfies(...)`；trim 后为空必定 unmet。
  if (trimmed === '') return { status: 'incompatible', reason: '空范围在 DSH 中一律不满足' };
  const operator = /^[~^]/.test(trimmed) ? trimmed[0] : '';
  const base = parseVersion(operator ? trimmed.slice(1).trim() : trimmed);
  if (!base) return { status: 'unknown', reason: 'unsupported-range' };
  let accepts = compareVersions(runtime, base) === 0;
  if (operator) {
    const major = BigInt(base.major), minor = BigInt(base.minor), patch = BigInt(base.patch);
    const upper = operator === '~' ? `${major}.${minor + 1n}.0-0`
      : major > 0n ? `${major + 1n}.0.0-0`
        : minor > 0n ? `0.${minor + 1n}.0-0` : `0.0.${patch + 1n}-0`;
    accepts = compareVersions(runtime, base) >= 0 && compareVersions(runtime, upper) < 0;
  }
  return { status: accepts ? 'compatible' : 'incompatible', accepts };
}

const isDshPeerName = name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');
// 真实 gate 只对 peerDependencies 把这三个协议值解释为「当前运行时」。
const WORKSPACE_PEER_RANGES = new Set(['workspace:^', 'workspace:~', 'workspace:*']);

function requirementRow(version, name, range, workspaceIsCurrent) {
  // 真实 gate：workspace:^/~/* 仅对 peers 视为当前运行时；同一批值出现在 engines.dsh 中必定 unmet。
  if (WORKSPACE_PEER_RANGES.has(range))
    return workspaceIsCurrent ? { name, range, ...satisfiesDshRange(version, version) }
      : { name, range, status: 'incompatible', reason: `engines.dsh 不接受 ${range} 协议值` };
  return { name, range, ...satisfiesDshRange(version, range) };
}

/** 镜像真实 gate `unmetRequirements`：manifest 自己的 engines.dsh 单独决定并完全忽略 peers，否则检查全部 dsh peers。 */
export function evaluateDshRequirements(version, manifest) {
  const fields = object(manifest) ? manifest : {};
  // 真实 gate 对畸形 engines/peerDependencies 直接抛错；镜像不猜测判定，给出 unknown 原因。
  if (Object.hasOwn(fields, 'engines') && !object(fields.engines))
    return { source: 'engines', status: 'unknown', ranges: [], reason: '未验证：engines 必须是对象' };
  const engines = object(fields.engines) ? fields.engines : null;
  if (engines && Object.hasOwn(engines, 'dsh')) {
    const range = engines.dsh;
    if (typeof range !== 'string')
      return { source: 'engines.dsh', status: 'unknown', ranges: [], reason: '未验证：engines.dsh 必须是字符串' };
    const row = requirementRow(version, 'engines.dsh', range, false);
    return { source: 'engines.dsh', status: row.status, ranges: [row],
      reason: row.status === 'compatible' ? null : `${row.name}: ${row.reason ?? `${version} 不满足 ${range}`}` };
  }
  if (Object.hasOwn(fields, 'peerDependencies') && !object(fields.peerDependencies))
    return { source: 'peerDependencies', status: 'unknown', ranges: [], reason: '未验证：peerDependencies 必须是对象' };
  const peers = object(fields.peerDependencies) ? fields.peerDependencies : {};
  const ranges = Object.entries(peers).filter(([name]) => isDshPeerName(name)).map(([name, range]) => typeof range === 'string'
    ? requirementRow(version, name, range, true)
    : { name, range, status: 'unknown', reason: '未验证：peerDependencies 的范围必须是字符串' });
  const status = ranges.some(row => row.status === 'incompatible') ? 'incompatible'
    : ranges.some(row => row.status === 'unknown') ? 'unknown' : 'compatible';
  return { source: 'peerDependencies', status, ranges, reason: ranges.filter(row => row.status !== 'compatible')
    .map(row => `${row.name}: ${row.reason ?? `${version} 不满足 ${row.range}`}`).join('; ') || null };
}

/** 仅 peerDependencies 分支的便捷入口；完整判定（含 engines.dsh 优先级）走 evaluateDshRequirements。 */
export function evaluateDshPeers(version, peers) {
  return evaluateDshRequirements(version, { peerDependencies: peers });
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 镜像真实 gate 的豁免记录校验：键必须是精确 package@version，值必须是精确规范 SemVer 列表；
// 其余记录被 DSH 静默忽略，绝不改变判定。
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** 镜像真实 gate `isExactPluginVersion`：拒绝范围、前缀、空白与畸形版本。 */
export function isExactDshVersion(value) {
  const parsed = parseVersion(value);
  return parsed !== null && value === formatVersion(parsed);
}

/** 镜像真实 gate `isVersionList`。 */
export function isExactDshVersionList(value) {
  return Array.isArray(value) && value.every(version => isExactDshVersion(version));
}

/** 镜像真实 gate 对 compatibility.json 键的校验（精确 package@version）。 */
export function isExactDshExemptionKey(key) {
  const separator = typeof key === 'string' ? key.lastIndexOf('@') : -1;
  return separator > 0 && PACKAGE_NAME.test(key.slice(0, separator)) && isExactDshVersion(key.slice(separator + 1));
}

function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!object(value)) throw new Error('顶层必须是对象');
    return { exists: true, value };
  } catch (error) { return { exists: error.code !== 'ENOENT', error: error.message }; }
}
function directory(path) { try { return statSync(path).isDirectory(); } catch { return false; } }
const unknown = reason => ({ status: 'unknown', reason: `未验证：${reason}` });

/** 用普通 Node 的只读 dsh-cat 读取归档，禁止将 app.asar 当作目录读取。 */
export function archiveReader({ env = process.env } = {}) {
  const { archive, source } = resolveAsar({ env });
  return { archive, source, read(entry) {
    const result = captureSync(process.execPath, [join(REPO_ROOT, 'scripts', 'dsh-cat.mjs'), entry],
      { env: { ...env, DSH_ASAR: archive }, timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
    // ASAR 路径诊断写入 stderr；成功只由退出码及后续解析判定。
    if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr.trim() || `dsh-cat 退出 ${result.status}`);
    return result.stdout;
  } };
}

/** 不写任何文件；readArchive 注入时可完全离线（传 null 表示无归档）。 */
export function collectLifecycle({ paths = resolvePaths(), repoRoot = paths.repoRoot ?? REPO_ROOT,
  env = process.env, readArchive, runtimeVersion } = {}) {
  const pkg = readJson(join(repoRoot, 'package.json'));
  if (!pkg.value?.name || !pkg.value.version) throw new Error(`仓库 package.json 无效：${pkg.error ?? '缺少 name/version'}`);
  const name = pkg.value.name;
  const engines = object(pkg.value.engines) ? pkg.value.engines : null;
  const repo = { name, version: pkg.value.version, manifestVersion: pkg.value.dsh?.manifestVersion ?? null,
    peerDependencies: Object.fromEntries(Object.entries(pkg.value.peerDependencies ?? {}).filter(([key]) => isDshPeerName(key))),
    // 仅记录 manifest 自己声明的 engines.dsh（非字符串也原样报告，判定层会给出 unknown 原因）。
    enginesDsh: engines && Object.hasOwn(engines, 'dsh') ? engines.dsh : null,
    configFormatVersion: CONFIG_FORMAT_VERSION };
  const profilePackage = readJson(join(paths.profile, 'package.json'));
  // DSH 以 profile 目录 basename（大小写不敏感）desktop 拒绝 CLI 管理；不从路径其他片段猜测。
  const profile = { exists: directory(paths.profile), packageExists: profilePackage.exists,
    name: basename(paths.profile), kind: basename(paths.profile).toLowerCase() === 'desktop' ? 'desktop' : 'cli-managed',
    error: profilePackage.error ?? null };
  const dependencies = profilePackage.value?.dependencies;
  const dependencyPresent = object(dependencies) && Object.hasOwn(dependencies, name);
  const bundles = profilePackage.value?.dsh?.profile?.bundles;
  const inBundles = Array.isArray(bundles) && bundles.includes(name);
  const resolved = readJson(join(paths.profile, 'node_modules', name, 'package.json'));
  const registration = { dependencyPresent, dependencySpec: dependencyPresent ? dependencies[name] : null, inBundles,
    resolved: Boolean(resolved.value?.name === name && typeof resolved.value.version === 'string'),
    resolvedVersion: resolved.value?.version ?? null, resolvedManifestVersion: resolved.value?.dsh?.manifestVersion ?? null, resolutionError: resolved.error ?? null,
    silentFailureTrap: dependencyPresent && !inBundles };
  // ⚠️ preset 声明的**权威副本在仓库** `presets/switchboard.patch.yml`：它由本包
  //    `package.json` 的 `dsh.bundle.patch` 投递，bundle 层与 profile 的覆盖层一起被
  //    app-boot 合成。profile patch 里**不应**再有注入的副本——顶层 `insert` 是纯追加、
  //    不按 id 去重，而 `dsh-agent-preset` 注册重复 id 会**硬抛**，于是那份副本既是多余的
  //    又会装载失败。历史实现把 preset 内联进 profile，这里改为以仓库那份为准，
  //    并把「profile / home 里是否还留着多余注入」单列出来。
  // 同一个文件声明两个 preset：完整分工版与自办版（不组合 worker）。
  const repoPresetPatch = readPatch(join(repoRoot, 'presets', 'switchboard.patch.yml'));
  const generated = presetConfig(repoPresetPatch, name);
  const generatedSolo = presetConfig(repoPresetPatch, name, 'preset-switchboard-solo');
  // 「profile 里没有这份声明」是**期望状态**，不是解析错误——所以按条目直接判定，
  // 而不是复用 presetConfig 的「缺少声明」错误串（那会把正常状态报成无法解析）。
  const patchPath = paths.patch;
  const patchExists = existsSync(patchPath);
  let profilePatchText = '';
  if (patchExists) {
    try { profilePatchText = readFileSync(patchPath, 'utf8'); }
    catch { profilePatchText = ''; /* readPatch 会把不可读原因写进 injectedError */ }
  }
  const injectedPatch = patchExists ? readPatch(patchPath) : { entries: [] };
  const homePatchPath = join(paths.home, 'cordis.patch.yml');
  const homePatchExists = existsSync(homePatchPath);
  const homePatch = homePatchExists ? readPatch(homePatchPath) : { entries: [] };
  const presetRowIds = ['preset-switchboard', 'preset-switchboard-solo'];
  const entriesOf = patch => Array.isArray(patch.entries) ? patch.entries : [];
  const hasPresetRow = patch => patch.error === undefined
    && entriesOf(patch).some(row => presetRowIds.includes(row?.id));
  const injectedPresent = hasPresetRow(injectedPatch);
  const homeInjectedPresent = hasPresetRow(homePatch);
  // 声明本身以仓库 preset 为准。
  const bundlePatches = pkg.value?.dsh?.bundle?.patch;
  const preset = {
    // 声明本身以仓库 preset 为准。
    present: Boolean(generated.preset),
    mount: generated.config?.mount === true,
    hasRoles: generated.config !== undefined && Object.hasOwn(generated.config, 'roles'),
    error: generated.error ?? null,
    rules: typeof generated.config?.supervisorRules === 'string' && generated.config.supervisorRules.trim()
      ? { status: 'current' }
      : { status: 'invalid', reason: '仓库 preset 的 supervisorRules 缺失、类型错误或仅含空白' },
    // 投递路径是否正确：bundle 必须声明这个 patch 文件，profile 必须把本包登记为 bundle。
    bundleDeclaresPreset: Array.isArray(bundlePatches)
      && bundlePatches.some(entry => String(entry).replace(/^\.\//, '') === 'presets/switchboard.patch.yml'),
    bundleDeclaresError: pkg.error ?? null,
    // 清理前的历史状态：profile / home 里还留着注入的副本（应当为 false）。
    patchExists,
    injectedInProfile: injectedPresent,
    injectedInHome: homeInjectedPresent,
    injectedError: injectedPatch.error ?? null,
    homePatchPath,
    homePatchExists,
    homePatchError: homePatch.error ?? null,
    generatedError: generated.error ?? null, generatedDrift: unknown('尚未读取 DSH standard preset') };
  const presetSolo = {
    present: Boolean(generatedSolo.preset),
    mount: generatedSolo.config?.mount === true,
    hasRoles: generatedSolo.config !== undefined && Object.hasOwn(generatedSolo.config, 'roles'),
    error: generatedSolo.error ?? null,
    compositionKey: generatedSolo.config?.compositionKey ?? null,
    excludedRoles: Array.isArray(generatedSolo.config?.excludedRoles) ? generatedSolo.config.excludedRoles : null,
    rules: typeof generatedSolo.config?.supervisorRules === 'string' && generatedSolo.config.supervisorRules.trim()
      ? { status: 'current' }
      : { status: 'invalid', reason: '自办 preset 的 supervisorRules 缺失、类型错误或仅含空白' },
    generatedError: generatedSolo.error ?? null };
  let runtime = unknown('尚未读取 Electron 安装归档');
  let archive = null;
  let archiveError = null;
  try {
    if (readArchive === null) throw new Error('DSH 归档不可用');
    if (readArchive === undefined) { const reader = archiveReader({ env }); readArchive = reader.read; archive = { path: reader.archive, source: reader.source }; }
  } catch (error) { readArchive = null; archiveError = error.message; preset.generatedDrift = unknown(error.message); }
  let archiveRuntimeVersion = null;
  if (readArchive) {
    try {
      const runtimePackage = JSON.parse(readArchive('dsh/package.json'));
      if (!parseVersion(runtimePackage.version)) throw new Error('dsh/package.json 无有效严格 SemVer 版本');
      archiveRuntimeVersion = runtimePackage.version;
    } catch (error) { archiveError ??= error.message; }
    // standard preset 只可信于 desktop；CLI-managed 只有显式版本与归档同版本时才可复用。
    const driftTrusted = profile.kind === 'desktop'
      || (runtimeVersion !== undefined && archiveRuntimeVersion !== null && runtimeVersion === archiveRuntimeVersion);
    if (driftTrusted) {
      try {
        const expected = generatePreset(readArchive('dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), name).body;
        const existing = readFileSync(join(repoRoot, 'presets', 'switchboard.patch.yml'));
        preset.generatedDrift = { status: existing.equals(Buffer.from(expected)) ? 'current' : 'drifted',
          reason: existing.equals(Buffer.from(expected)) ? null : '仓库 preset 与生成器当前产物字节不一致' };
      } catch (error) { preset.generatedDrift = unknown(error.message); }
    } else {
      preset.generatedDrift = unknown('CLI-managed profile：Electron 归档的 standard 不能代表该 CLI 的运行时；'
        + '请用 --runtime-version 指定同版本，或手工运行 npm run gen:preset');
    }
  }
  if (runtimeVersion !== undefined) {
    runtime = parseVersion(runtimeVersion)
      ? { status: 'known', version: runtimeVersion, source: '--runtime-version（显式提供；未确认当前运行进程）' }
      : unknown(`--runtime-version 不是合法 SemVer：${JSON.stringify(runtimeVersion)}`);
  } else if (profile.kind === 'cli-managed') {
    runtime = unknown('CLI-managed profile：Electron 归档版本不是它的运行时；请用 --runtime-version <加载它的 dsh 版本>');
  } else if (readArchive) {
    runtime = archiveRuntimeVersion === null
      ? unknown(archiveError ?? 'dsh/package.json 无有效严格 SemVer 版本')
      : { status: 'known', version: archiveRuntimeVersion, source: 'Electron app.asar 内 dsh/package.json（安装运行时；未确认当前运行进程）' };
  } else {
    runtime = unknown(archiveError ?? 'DSH 归档不可用');
  }
  const rolesRead = readConfigFileDetailed(paths.roles);
  // 即使格式未来/不支持，仍只读报告磁盘上的角色数和 wrapper，不尝试迁移写回。
  const config = rolesRead.config ?? readJson(paths.roles).value;
  const wrapperKeys = [];
  for (const [scope, value] of [['', config], ['volatile.', config?.volatile]]) {
    if (object(value)) for (const key of Object.keys(value)) if (/^wrapper/i.test(key)) wrapperKeys.push(scope + key);
  }
  const rootRow = profilePatchText ? findPatchEntry(profilePatchText, 'agent-switchboard') : undefined;
  const rootConfig = object(rootRow?.config) ? rootRow.config : null;
  const settingsRolesPresent = Boolean(rootConfig && Object.hasOwn(rootConfig, 'roles'));
  const settingsRoleSettingsPresent = Boolean(rootConfig && Object.hasOwn(rootConfig, 'roleSettings'));
  const definitionIds = Array.isArray(config?.roles)
    ? config.roles.map(role => role?.id).filter(id => typeof id === 'string') : [];
  const roles = { exists: !rolesRead.missing, verdict: rolesRead.missing ? 'missing' : rolesRead.format?.status ?? 'unreadable',
    format: rolesRead.format, ok: rolesRead.ok, error: rolesRead.error ?? null,
    count: Array.isArray(config?.roles) ? config.roles.length : null, wrapperPresent: wrapperKeys.length > 0, wrapperKeys,
    // 设置层的两种形态：split（roleSettings 旋钮）与 legacy（完整 roles）。
    settingsRolesPresent,
    settingsRoles: settingsRolesPresent && Array.isArray(rootConfig.roles) ? rootConfig.roles : null,
    settingsRoleSettingsPresent,
    settingsRoleSettings: settingsRoleSettingsPresent ? rootConfig.roleSettings : undefined,
    definitionIds };
  const compat = readJson(join(paths.profile, 'compatibility.json'));
  // DSH 的兼容性门禁读取的是**已安装包**的 manifest；版本不同时不能用仓库 manifest 冒充。
  const installedManifest = registration.resolved ? resolved.value : null;
  const usesInstalledManifest = installedManifest !== null && installedManifest.version !== repo.version;
  const compatibilityManifest = usesInstalledManifest ? installedManifest : pkg.value;
  const compatibilityVersion = usesInstalledManifest ? installedManifest.version : repo.version;
  const key = `${name}@${compatibilityVersion}`;
  const keyValid = isExactDshExemptionKey(key);
  const recordPresent = object(compat.value) && Object.hasOwn(compat.value, key);
  const values = recordPresent ? compat.value[key] : null;
  // 真实 gate 只把「合法键 + 精确规范 SemVer 列表」记为豁免；非法记录被静默忽略。
  const exemptionAccepted = keyValid && isExactDshVersionList(values);
  const olderKeys = Object.keys(compat.value ?? {}).filter(entry => entry.startsWith(`${name}@`) && entry !== key);
  // `peers` 保存真实 gate 的最终判定：engines.dsh 存在时 peers 被完全忽略（字段名沿用既有调用方）。
  const requirements = runtime.status === 'known'
    ? evaluateDshRequirements(runtime.version, compatibilityManifest) : { status: 'unknown', reason: runtime.reason };
  const compatibility = { runtime, fileExists: compat.exists, error: compat.exists ? compat.error ?? null : null,
    key, keyValid, exemptionPresent: recordPresent, values, olderKeys,
    installedVersion: installedManifest?.version ?? null, targetVersion: repo.version, targetKey: `${name}@${repo.version}`,
    manifestSource: usesInstalledManifest ? 'installed' : 'repo',
    exemption: recordPresent ? (exemptionAccepted ? 'exempt' : 'invalid') : olderKeys.length ? 'expired' : 'absent',
    runtimeExempt: runtime.status === 'known' ? exemptionAccepted && values.includes(runtime.version) : null,
    enginesDsh: repo.enginesDsh, peers: requirements };
  const snapshot = { paths, archive, repo, profile, registration, preset, presetSolo, roles, compatibility,
    restart: { requiredForModuleChange: true, reason: '插件模块改动必须完全退出并重启 DSH 进程；Node 模块缓存不能驱逐，reload 不能应用代码升级。' } };
  snapshot.verification = verifyLifecycle(snapshot);
  snapshot.nextStep = nextStep(snapshot);
  return snapshot;
}

export function verifyLifecycle(s) {
  const issues = [];
  const unverified = [];
  const add = (code, reason) => issues.push({ code, reason });
  const addUnverified = (code, reason) => unverified.push({ code, reason });
  if (!s.profile.packageExists) {
    if (s.paths.explicitTarget) add('profile.missing', `显式目标缺少 profile package.json：${s.paths.profile}`);
    return { status: issues.length ? 'inconsistent' : 'skipped', issues, unverified: [] };
  }
  if (s.profile.error) add('profile.invalid', s.profile.error);
  // 卸载后的残留制品必须先于「未登记就跳过」检查：否则先移除包再 verify 会把
  // 残留的 preset 副本报成 skipped，正好漏掉最需要发现的悬空配置。
  if (s.preset.injectedError) add('preset.injectedInProfile', `profile patch 无法解析：${s.preset.injectedError}`);
  else if (s.preset.injectedInProfile) add('preset.injectedInProfile', 'profile patch 里还留着注入的 preset 副本（与 bundle 投递的声明重复）；运行同步即可剥离');
  if (s.preset.homePatchError) add('preset.homePatch', `home patch 无法解析：${s.preset.homePatchError}`);
  else if (s.preset.injectedInHome) add('preset.injectedInHome', 'home patch（$DSH_HOME/cordis.patch.yml）里还留着注入的 preset 副本；工具不自动修改 home 层，请手动移除该块');
  // 完全未注册时无需断言插件自身制品；但上面的残留检查已经执行，部分注册不得跳过。
  if (!s.profile.error && !s.registration.dependencyPresent && !s.registration.inBundles && !s.registration.resolved)
    return { status: issues.length ? 'inconsistent' : 'skipped', issues, unverified: [] };
  if (!s.registration.dependencyPresent) add('registration.dependencies', 'dependencies 缺少插件包');
  if (!s.registration.inBundles) add('registration.bundles', s.registration.silentFailureTrap ? '静默不加载陷阱：dependencies 有本包，但 dsh.profile.bundles 缺少本包' : 'dsh.profile.bundles 缺少插件包');
  if (!s.registration.resolved) add('registration.resolution', `登记后包体无法解析：node_modules/<包名>/package.json；${s.registration.resolutionError ?? '包名或版本无效'}`);
  else if (s.registration.resolvedVersion !== s.repo.version) add('registration.version', `磁盘包版本 ${s.registration.resolvedVersion} 与仓库 ${s.repo.version} 不一致`);
  if (s.preset.error) add('preset.structure', s.preset.error);
  if (!s.preset.mount) add('preset.mount', 'preset 本包 config 缺少 mount: true');
  if (s.preset.hasRoles) add('preset.roles', 'preset 携带禁止的 roles 字段；角色只能存放在 roles.json');
  if (s.preset.generatedError) add('preset.generated', s.preset.generatedError);
  if (s.preset.rules.status !== 'current') add('preset.rules', s.preset.rules.reason);
  // 第二个 preset（自办版）必须与完整分工版一起可用：它不组合 worker，且使用
  // 独立的角色 preset 命名空间，否则两个常驻声明会撞上重复 id。
  const solo = s.presetSolo;
  if (solo !== undefined) {
    if (solo.error) add('preset.solo.structure', solo.error);
    if (!solo.mount) add('preset.solo.mount', '自办 preset 的本包 config 缺少 mount: true');
    if (solo.hasRoles) add('preset.solo.roles', '自办 preset 携带禁止的 roles 字段；角色只能存放在 roles.json');
    if (solo.rules.status !== 'current') add('preset.solo.rules', solo.rules.reason);
    if (!solo.error && !(Array.isArray(solo.excludedRoles) && solo.excludedRoles.includes('worker')))
      add('preset.solo.exclusion', '自办 preset 必须用 excludedRoles 排除 worker');
    if (!solo.error && (solo.compositionKey === null || solo.compositionKey === 'switchboard'))
      add('preset.solo.compositionKey', '自办 preset 必须使用独立的 compositionKey（不能与完整分工版都是 switchboard）');
  }
  // preset 由 bundle 投递：这两条是「声明真的会被合成」的前提。
  if (s.preset.bundleDeclaresError) add('preset.bundleDeclaration', `无法读取仓库 package.json：${s.preset.bundleDeclaresError}`);
  else if (!s.preset.bundleDeclaresPreset) add('preset.bundleDeclaration', 'package.json 的 dsh.bundle.patch 未声明 presets/switchboard.patch.yml，bundle 不会投递该 preset');
  if (s.preset.generatedDrift.status === 'drifted') add('preset.generatedDrift', s.preset.generatedDrift.reason);
  if (s.roles.verdict !== 'current' || !s.roles.ok) add('roles.format', `roles.json：${s.roles.verdict}；${s.roles.error ?? s.roles.format?.reason ?? '需要当前格式的角色文件'}`);
  // split 模式：设置层只保留旋钮，定义必须住在文件里；文件缺失就是运行期错误，
  // 不能因为「文件格式 future/missing」之外没有别的 issue 就判 consistent。
  if (s.roles.settingsRoleSettingsPresent) {
    if (!Array.isArray(s.roles.settingsRoleSettings)) {
      add('roles.roleSettings', '设置层 roleSettings 必须是数组；运行时会拒绝该配置');
    } else {
      const requiredIds = s.roles.settingsRoleSettings.map(role => role?.id).filter(id => typeof id === 'string');
      const missing = requiredIds.filter(id => !s.roles.definitionIds.includes(id));
      if (s.roles.definitionIds.length === 0)
        add('roles.definitions', '设置层已使用 roleSettings，但 roles.json 没有角色定义；preset 会话将没有可派发角色');
      else if (missing.length > 0)
        add('roles.definitions', `roleSettings 引用的角色在 roles.json 缺失：${missing.join(', ')}`);
    }
  } else if (s.roles.settingsRolesPresent) {
    if (!Array.isArray(s.roles.settingsRoles)) add('roles.settings', '根条目 roles 必须是数组；运行时会拒绝该配置');
    else if (s.roles.settingsRoles.length > 0 && s.roles.definitionIds.length === 0)
      add('roles.legacy', '根条目仍用完整 roles，但 roles.json 没有定义；安装会从设置播种，重启前 preset 会话没有角色');
  }
  if (s.compatibility.error) add('compatibility.file', s.compatibility.error);
  if (!s.compatibility.keyValid) add('compatibility.key', `当前插件版本不是规范 SemVer，DSH 会忽略该精确豁免键：${s.compatibility.key}`);
  if (s.compatibility.exemption === 'invalid') add('compatibility.exemption', '豁免值必须是精确规范 SemVer 字符串数组（范围、v 前缀、空白与畸形版本都会被 DSH 忽略）');
  if (s.compatibility.exemption === 'expired') add('compatibility.expired', `精确版本豁免已失效：只有 ${s.compatibility.olderKeys.join(', ')}，缺少 ${s.compatibility.key}`);
  if (s.compatibility.exemptionPresent && s.compatibility.runtimeExempt === false) add('compatibility.runtime', '当前运行时版本不在当前插件版本豁免值中');
  if (s.compatibility.peers.status === 'incompatible' && s.compatibility.runtimeExempt !== true)
    add('compatibility.peers', s.compatibility.peers.reason);
  // 未知不是通过：这些判据没做时 status 必须是 unverified，而不是 consistent。
  if (s.compatibility.runtime.status === 'unknown') addUnverified('compatibility.runtime', s.compatibility.runtime.reason);
  if (s.compatibility.peers.status === 'unknown') addUnverified('compatibility.peers', s.compatibility.peers.reason);
  if (s.preset.generatedDrift.status === 'unknown') addUnverified('preset.generatedDrift', s.preset.generatedDrift.reason);
  const status = issues.length ? 'inconsistent' : unverified.length ? 'unverified' : 'consistent';
  return { status, issues, unverified };
}

function nextStep(s) {
  // 供当前平台终端复制；JSON 转义会把 Windows 路径的反斜线加倍，不能用于指令。
  const quote = value => process.platform === 'win32' ? `'${String(value).replaceAll("'", "''")}'`
    : `'${String(value).replaceAll("'", "'\\''")}'`;
  const registered = s.registration.dependencyPresent || s.registration.inBundles || s.registration.resolved;
  // 残留制品必须先于“未安装 → 去安装”的提示：先移包再 verify 时，安装提示会把用户
  // 引回重复 preset，而不是清掉残留。
  if (s.preset.injectedInHome)
    return `home patch 里仍有 preset 副本：手动移除 ${quote(s.preset.homePatchPath)} 中的 preset-switchboard / preset-switchboard-solo 块（工具不自动修改 home 层），然后重新运行 verify。`;
  if (s.preset.homePatchError)
    return `home patch 无法解析：先修复 ${quote(s.preset.homePatchPath)}（或删除该层），再重新运行 verify。`;
  if (s.preset.injectedError)
    return `profile patch 无法解析：先修复 ${quote(s.paths.patch)}，再重新运行 verify。`;
  if (s.preset.injectedInProfile) {
    return registered
      ? `profile patch 里仍有注入的 preset 副本：运行 node scripts/ops/plugin-lifecycle.mjs install --apply --home ${quote(s.paths.home)} --profile ${quote(s.paths.profile)} 剥离，然后完全重启 DSH。`
      : `包已移除但 profile patch 里仍有 preset 副本：运行 node scripts/ops/plugin-lifecycle.mjs uninstall --apply --home ${quote(s.paths.home)} --profile ${quote(s.paths.profile)} 剥离，然后完全重启 DSH。`;
  }
  if (!registered) {
    const spec = `link:${s.paths.repoRoot}`;
    return s.profile.kind === 'desktop'
      ? `打开 Electron DSH → 设置 → Plugins → 安装本地目录 ${s.paths.repoRoot}；确认 dependencies 与 dsh.profile.bundles 均登记 ${s.repo.name}，完全退出并重启 DSH。`
      : `dsh plugin --profile ${quote(s.profile.name)} add ${quote(spec)}`;
  }
  // preset 由 bundle 投递，profile 里只应**剥离**残留的注入副本；home 层工具不改，必须人工处理。
  if (s.verification.issues.some(i => i.code.startsWith('preset.')))
    return `node scripts/gen-preset.mjs && node scripts/ops/plugin-lifecycle.mjs install --apply --home ${quote(s.paths.home)} --profile ${quote(s.paths.profile)} --patch ${quote(s.paths.patch)}；然后完全退出并重启 DSH。`;
  if (s.verification.issues.some(i => i.code === 'roles.definitions' || i.code === 'roles.roleSettings'))
    return `设置层已使用 roleSettings，但 roles.json 没有可用定义：先在 DSH → 设置 → 角色与派发保存角色定义，或把定义写入 ${quote(s.paths.roles)}；然后重新运行 install/upgrade --apply 与 verify。`;
  if (s.verification.issues.some(i => i.code === 'roles.legacy'))
    return `根条目仍带完整 roles：运行 node scripts/ops/plugin-lifecycle.mjs install --apply --home ${quote(s.paths.home)} --profile ${quote(s.paths.profile)} 从设置播种 roles.json，然后 verify。`;
  if (s.verification.issues.some(i => i.code.startsWith('roles.')))
    return '打开 DSH → 设置 → 角色与派发 → 保存角色配置；然后重新运行 verify。';
  if (s.verification.issues.length) return `打开 DSH → 设置 → Plugins → 检查 ${s.repo.name}@${s.repo.version} 的安装版本和兼容性提示；处理后完全退出并重启 DSH，再运行 verify。`;
  if (s.verification.status === 'unverified') {
    const codes = (s.verification.unverified ?? []).map(item => item.code).join(', ');
    return `未验证：${codes}；补齐 DSH_ASAR 或用 --runtime-version 指定运行时后重新运行 verify（确认接受未知时用 --allow-unknown）。`;
  }
  return '已就绪';
}
