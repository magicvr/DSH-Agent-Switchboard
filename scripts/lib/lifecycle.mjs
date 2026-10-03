// 生命周期只读快照；所有路径和归档读取均可注入，缺失制品不抛异常。
import { readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { captureSync } from './capture.mjs';
import { resolvePaths, resolveAsar, REPO_ROOT } from './paths.mjs';
import { readPatch, presetConfig, compareRules } from './preset-patch.mjs';
import { generatePreset } from './preset-generator.mjs';
import { CONFIG_FORMAT_VERSION, readConfigFileDetailed } from '../../src/config-file.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
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
  env = process.env, readArchive } = {}) {
  const pkg = readJson(join(repoRoot, 'package.json'));
  if (!pkg.value?.name || !pkg.value.version) throw new Error(`仓库 package.json 无效：${pkg.error ?? '缺少 name/version'}`);
  const name = pkg.value.name;
  const repo = { name, version: pkg.value.version, manifestVersion: pkg.value.dsh?.manifestVersion ?? null,
    peerDependencies: Object.fromEntries(Object.entries(pkg.value.peerDependencies ?? {}).filter(([key]) => key.startsWith('@deepseek-ai/dsh'))),
    configFormatVersion: CONFIG_FORMAT_VERSION };
  const profilePackage = readJson(join(paths.profile, 'package.json'));
  // DSH 以 profile 目录 basename desktop 拒绝 CLI 管理；不从路径其他片段猜测。
  const profile = { exists: directory(paths.profile), packageExists: profilePackage.exists,
    name: basename(paths.profile), kind: basename(paths.profile) === 'desktop' ? 'desktop' : 'cli-managed',
    error: profilePackage.error ?? null };
  const dependencies = profilePackage.value?.dependencies;
  const dependencyPresent = object(dependencies) && Object.hasOwn(dependencies, name);
  const bundles = profilePackage.value?.dsh?.profile?.bundles;
  const inBundles = Array.isArray(bundles) && bundles.includes(name);
  const resolved = readJson(join(paths.profile, 'node_modules', name, 'package.json'));
  const registration = { dependencyPresent, dependencySpec: dependencyPresent ? dependencies[name] : null, inBundles,
    resolved: Boolean(resolved.value?.name === name && typeof resolved.value.version === 'string'),
    resolvedVersion: resolved.value?.version ?? null, resolutionError: resolved.error ?? null,
    silentFailureTrap: dependencyPresent && !inBundles };
  const generated = presetConfig(readPatch(join(repoRoot, 'presets', 'switchboard.patch.yml')), name);
  const actual = presetConfig(readPatch(paths.patch), name);
  const preset = { present: Boolean(actual.preset), mount: actual.config?.mount === true,
    hasRoles: actual.config !== undefined && Object.hasOwn(actual.config, 'roles'),
    error: actual.error ?? null, rules: compareRules(actual.config?.supervisorRules, generated.config?.supervisorRules),
    generatedError: generated.error ?? null, generatedDrift: unknown('尚未读取 DSH standard preset') };
  let runtime = unknown('尚未读取 Electron 安装归档');
  let archive = null;
  try {
    if (readArchive === null) throw new Error('DSH 归档不可用');
    if (readArchive === undefined) { const reader = archiveReader({ env }); readArchive = reader.read; archive = { path: reader.archive, source: reader.source }; }
  } catch (error) { readArchive = null; runtime = unknown(error.message); preset.generatedDrift = unknown(error.message); }
  if (readArchive) {
    try {
      const expected = generatePreset(readArchive('dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), name).body;
      const existing = readFileSync(join(repoRoot, 'presets', 'switchboard.patch.yml'));
      preset.generatedDrift = { status: existing.equals(Buffer.from(expected)) ? 'current' : 'drifted',
        reason: existing.equals(Buffer.from(expected)) ? null : '仓库 preset 与生成器当前产物字节不一致' };
    } catch (error) { preset.generatedDrift = unknown(error.message); }
    try {
      // Electron 归档中实际启动的 dsh 包版本，不使用机器上另装的 CLI 版本。
      const runtimePackage = JSON.parse(readArchive('dsh/package.json'));
      if (typeof runtimePackage.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(runtimePackage.version)) throw new Error('dsh/package.json 无有效版本');
      runtime = { status: 'known', version: runtimePackage.version, source: 'Electron app.asar 内 dsh/package.json（安装运行时；未确认当前运行进程）' };
    } catch (error) { runtime = unknown(error.message); }
  }
  const rolesRead = readConfigFileDetailed(paths.roles);
  // 即使格式未来/不支持，仍只读报告磁盘上的角色数和 wrapper，不尝试迁移写回。
  const config = rolesRead.config ?? readJson(paths.roles).value;
  const wrapperKeys = [];
  for (const [scope, value] of [['', config], ['volatile.', config?.volatile]]) {
    if (object(value)) for (const key of Object.keys(value)) if (/^wrapper/i.test(key)) wrapperKeys.push(scope + key);
  }
  const roles = { exists: !rolesRead.missing, verdict: rolesRead.missing ? 'missing' : rolesRead.format?.status ?? 'unreadable',
    format: rolesRead.format, ok: rolesRead.ok, error: rolesRead.error ?? null,
    count: Array.isArray(config?.roles) ? config.roles.length : null, wrapperPresent: wrapperKeys.length > 0, wrapperKeys };
  const compat = readJson(join(paths.profile, 'compatibility.json'));
  const key = `${name}@${repo.version}`;
  const exemptionPresent = object(compat.value) && Object.hasOwn(compat.value, key);
  const values = exemptionPresent ? compat.value[key] : null;
  const olderKeys = Object.keys(compat.value ?? {}).filter(entry => entry.startsWith(`${name}@`) && entry !== key);
  const compatibility = { runtime, fileExists: compat.exists, error: compat.exists ? compat.error ?? null : null,
    key, exemptionPresent, values, olderKeys,
    exemption: exemptionPresent ? (Array.isArray(values) && values.every(v => typeof v === 'string') ? 'exempt' : 'invalid') : olderKeys.length ? 'expired' : 'absent',
    runtimeExempt: runtime.status === 'known' && Array.isArray(values) ? values.includes(runtime.version) : null };
  const snapshot = { paths, archive, repo, profile, registration, preset, roles, compatibility,
    restart: { requiredForModuleChange: true, reason: '插件模块改动必须完全退出并重启 DSH 进程；Node 模块缓存不能驱逐，reload 不能应用代码升级。' } };
  snapshot.verification = verifyLifecycle(snapshot);
  snapshot.nextStep = nextStep(snapshot);
  return snapshot;
}

export function verifyLifecycle(s) {
  const issues = [];
  const add = (code, reason) => issues.push({ code, reason });
  if (!s.profile.packageExists) {
    if (s.paths.explicitTarget) add('profile.missing', `显式目标缺少 profile package.json：${s.paths.profile}`);
    return { status: issues.length ? 'inconsistent' : 'skipped', issues };
  }
  if (s.profile.error) add('profile.invalid', s.profile.error);
  // 完全未注册时无需断言插件派生制品；部分注册不得跳过。
  if (!s.profile.error && !s.registration.dependencyPresent && !s.registration.inBundles && !s.registration.resolved)
    return { status: 'skipped', issues };
  if (!s.registration.dependencyPresent) add('registration.dependencies', 'dependencies 缺少插件包');
  if (!s.registration.inBundles) add('registration.bundles', s.registration.silentFailureTrap ? '静默不加载陷阱：dependencies 有本包，但 dsh.profile.bundles 缺少本包' : 'dsh.profile.bundles 缺少插件包');
  if (!s.registration.resolved) add('registration.resolution', `登记后包体无法解析：node_modules/<包名>/package.json；${s.registration.resolutionError ?? '包名或版本无效'}`);
  else if (s.registration.resolvedVersion !== s.repo.version) add('registration.version', `磁盘包版本 ${s.registration.resolvedVersion} 与仓库 ${s.repo.version} 不一致`);
  if (s.preset.error) add('preset.structure', s.preset.error);
  if (!s.preset.mount) add('preset.mount', 'preset 本包 config 缺少 mount: true');
  if (s.preset.hasRoles) add('preset.roles', 'preset 携带禁止的 roles 字段；角色只能存放在 roles.json');
  if (s.preset.generatedError) add('preset.generated', s.preset.generatedError);
  if (s.preset.rules.status !== 'current') add('preset.rules', s.preset.rules.reason);
  if (s.preset.generatedDrift.status === 'drifted') add('preset.generatedDrift', s.preset.generatedDrift.reason);
  if (s.roles.verdict !== 'current' || !s.roles.ok) add('roles.format', `roles.json：${s.roles.verdict}；${s.roles.error ?? s.roles.format?.reason ?? '需要当前格式的角色文件'}`);
  if (s.compatibility.error) add('compatibility.file', s.compatibility.error);
  if (s.compatibility.exemption === 'invalid') add('compatibility.exemption', '当前豁免值必须是运行时版本字符串数组');
  if (s.compatibility.exemption === 'expired') add('compatibility.expired', `精确版本豁免已失效：只有 ${s.compatibility.olderKeys.join(', ')}，缺少 ${s.compatibility.key}`);
  if (s.compatibility.exemptionPresent && s.compatibility.runtimeExempt === false) add('compatibility.runtime', '当前运行时版本不在当前插件版本豁免值中');
  // 无豁免不是不兼容的证据；peer 范围是否接受运行时由 DSH 官方装载器裁决。
  return { status: issues.length ? 'inconsistent' : 'consistent', issues };
}

function nextStep(s) {
  // 供当前平台终端复制；JSON 转义会把 Windows 路径的反斜线加倍，不能用于指令。
  const quote = value => process.platform === 'win32' ? `'${String(value).replaceAll("'", "''")}'`
    : `'${String(value).replaceAll("'", "'\\''")}'`;
  if (!s.registration.dependencyPresent || !s.registration.inBundles || !s.registration.resolved) {
    const spec = `link:${s.paths.repoRoot}`;
    return s.profile.kind === 'desktop'
      ? `打开 Electron DSH → 设置 → Plugins → 安装本地目录 ${s.paths.repoRoot}；确认 dependencies 与 dsh.profile.bundles 均登记 ${s.repo.name}，完全退出并重启 DSH。`
      : `dsh plugin --profile ${quote(s.profile.name)} add ${quote(spec)}`;
  }
  if (s.verification.issues.some(i => i.code.startsWith('preset.')))
    return `node scripts/gen-preset.mjs && node scripts/ops/probe-preset.mjs --inject --home ${quote(s.paths.home)} --profile ${quote(s.paths.profile)} --patch ${quote(s.paths.patch)}；然后完全退出并重启 DSH。`;
  if (s.verification.issues.some(i => i.code.startsWith('roles.')))
    return '打开 DSH → 设置 → 角色与派发 → 保存角色配置；然后重新运行 verify。';
  if (s.verification.issues.length) return `打开 DSH → 设置 → Plugins → 检查 ${s.repo.name}@${s.repo.version} 的安装版本和兼容性提示；处理后完全退出并重启 DSH，再运行 verify。`;
  return s.preset.generatedDrift.status === 'unknown' || s.compatibility.runtime.status === 'unknown'
    ? '已知制品一致；补齐 DSH_ASAR 后运行 node scripts/ops/plugin-lifecycle.mjs verify（生成物/运行时仍未验证）。' : '已就绪';
}
