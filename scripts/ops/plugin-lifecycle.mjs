// 包管理始终由 DSH 完成；这里只收敛插件自己的派生制品。
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { resolvePaths, printPaths } from '../lib/paths.mjs';
import { collectLifecycle } from '../lib/lifecycle.mjs';
import { captureSync } from '../lib/capture.mjs';
import { planInjectedPreset, readPatch, presetConfig, pluginsWithoutName, scanPackageReferences } from '../lib/preset-patch.mjs';
import { initialConfig, migrateConfigFileOnDisk, readConfigFileDetailed } from '../../src/config-file.js';

const HELP = `用法：node scripts/ops/plugin-lifecycle.mjs <status|verify|install|upgrade|uninstall> [路径参数] [--json]
status：只读报告；verify：只读验证；install：安装后收敛；upgrade：升级收敛；uninstall：安全剥离后提示移除包。
写入操作默认 dry-run（省略 --apply；没有 --dry-run flag）；只有 --apply 才写盘，包括漂移的仓库 preset 再生成。
--purge-roles：uninstall 仅包已移除后删除角色文件。--json：输出单份 JSON 快照及操作事件。
本工具不安装依赖、不执行 pnpm、不修改包登记。
退出码：0 = 收敛目标一致（status 正常采集、verify 跳过未安装插件或默认缺失 profile 也为 0）；1 = 失败或未修复的漂移（含 dry-run 待写入）；3 = 人工包安装/更新/移除或兼容豁免步骤待完成。
路径参数：--home <path> / --profile <path> / --patch <path> / --roles-file <path> / --cwd <path>。
代码升级必须完全退出并重启 DSH；reload 无法生效。`;

const quote = value => process.platform === 'win32' ? `'${String(value).replaceAll("'", "''")}'`
  : `'${String(value).replaceAll("'", "'\\''")}'`;

export function packageInstruction(s, remove = false) {
  const spec = `link:${s.paths.repoRoot.replaceAll('\\', '/')}`;
  // 本机 CLI/归档无法读取时不把候选命令伪称为实测；GUI link: 有 docs/plan.md 历史真机证据。
  if (s.profile.kind === 'desktop') return remove
    ? `Electron DSH → Plugins 页面 → 找到 ${s.repo.name} → 卸载插件（GUI 按钮名称未验证）；确认 dependencies 与 dsh.profile.bundles 均已移除。`
    : `Electron DSH → Plugins 页面 → 添加插件 → 粘贴 ${spec} → 安装 → 立即启用（GUI 文案未验证；link: 绝对路径见 docs/plan.md 历史实测）。`;
  return `未验证（本工具未核实本机 dsh CLI/源码）：dsh plugin --profile ${quote(s.profile.name)} ${remove ? `remove ${quote(s.repo.name)}` : `add ${quote(spec)}`}`;
}

function exemptionInstruction(s) {
  // 不猜测 CLI flag 或 GUI 精确文案；给出可核对的精确文件键值，但不代写豁免。
  return `${s.profile.kind === 'desktop' ? 'Electron DSH → Plugins → 本插件 → 允许不兼容版本（按钮/流程未验证）' : 'DSH CLI 豁免子命令未验证'}；人工确认后在 ${join(s.paths.profile, 'compatibility.json')} 设置精确键 ${JSON.stringify(s.compatibility.key)} 的值为 ${JSON.stringify([s.compatibility.runtime.version])}；不自动创建豁免。`;
}

function writableParent(path) {
  let parent = dirname(path);
  while (!existsSync(parent)) parent = dirname(parent);
  accessSync(parent, constants.W_OK);
  if (existsSync(path)) accessSync(path, constants.W_OK);
}

const snapshotBytes = path => existsSync(path) ? readFileSync(path) : null;
function assertUnchanged(path, original) {
  const current = snapshotBytes(path);
  if (original === null ? current !== null : current === null || !original.equals(current))
    throw new Error(`文件在规划后已改变，拒绝写入，请重新运行：${path}`);
}

function backedChange(path, next, log, original, beforeReplace = () => {}) {
  assertUnchanged(path, original);
  const exists = original !== null;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(6).toString('hex')}`;
  const backup = `${path}.bak-lifecycle-${suffix}`;
  writeFileSync(backup, original ?? '原文件不存在；恢复时删除新建目标文件。\n', { flag: 'wx', mode: 0o600 });
  log(`备份：${backup}${exists ? '' : '（原文件不存在记录）'}`);
  if (next === null) { beforeReplace(); assertUnchanged(path, original); unlinkSync(path); }
  else {
    const temp = `${path}.${suffix}.tmp`;
    try { writeFileSync(temp, next, { flag: 'wx', mode: 0o600 }); beforeReplace(); assertUnchanged(path, original); renameSync(temp, path); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  const verified = next === null ? !existsSync(path) : Buffer.from(next).equals(readFileSync(path));
  if (!verified) throw new Error(`写后复读验证失败！备份可恢复：${backup}`);
  log(`PASS  写后复读验证：${path}`);
}

function converge(command, s, { apply, purge, collect, env, log }) {
  if (!s.profile.exists || !s.profile.packageExists || s.profile.error)
    throw new Error(`profile 不存在或无效，拒绝写入：${s.profile.error ?? s.paths.profile}`);
  const registered = s.registration.dependencyPresent || s.registration.inBundles;
  if (command !== 'uninstall' && (!s.registration.dependencyPresent || !s.registration.inBundles || !s.registration.resolved)) {
    if (s.registration.silentFailureTrap) log('静默不加载陷阱：dependencies 有本包，但 dsh.profile.bundles 缺少本包。');
    log(`人工包步骤：${packageInstruction(s)}`);
    return { snapshot: s, exitCode: 3 };
  }
  if (command === 'uninstall' && purge && registered) throw new Error('--purge-roles 被拒绝：包仍登记；先安全剥离 preset、由 DSH 移除包后再执行。');
  if (command === 'upgrade') {
    log(s.registration.resolvedManifestVersion === null || s.repo.manifestVersion === null
      ? 'manifestVersion：未验证（包未声明）'
      : `manifestVersion：${s.registration.resolvedManifestVersion} → ${s.repo.manifestVersion}${s.registration.resolvedManifestVersion === s.repo.manifestVersion ? '（未变）' : '（变化）'}`);
    log(`DSH peers：${s.compatibility.peers.status}；${s.compatibility.peers.reason ?? '范围接受当前运行时'}`);
  }
  const patchOriginal = readFileSync(s.paths.patch);
  const original = patchOriginal.toString('utf8');
  const rolesOriginal = snapshotBytes(s.paths.roles);
  const generatedPath = join(s.paths.repoRoot, 'presets', 'switchboard.patch.yml');
  const generatedOriginal = command === 'uninstall' ? null : readFileSync(generatedPath);
  let block = generatedOriginal?.toString('utf8') ?? '';
  if (command !== 'uninstall') {
    const generated = presetConfig(readPatch(join(s.paths.repoRoot, 'presets', 'switchboard.patch.yml')), s.repo.name);
    if (generated.error || generated.config?.mount !== true || Object.hasOwn(generated.config ?? {}, 'roles')
      || typeof generated.config?.supervisorRules !== 'string' || !generated.config.supervisorRules.trim()
      || pluginsWithoutName(generated.preset.config.plugins).length) throw new Error('仓库 preset 无效，拒绝同步');
    if (s.roles.exists && !s.roles.ok) throw new Error(`roles.json 不可安全迁移：${s.roles.error}`);
  }
  let next = planInjectedPreset(original, block, { remove: command === 'uninstall' });
  if (command !== 'uninstall') {
    if (s.preset.generatedDrift.status === 'unknown')
      log(`仓库生成物漂移未验证；无法自动再生成：${s.preset.generatedDrift.reason}；手工回退：npm run gen:preset；继续收敛可验证制品。`);
    if (s.preset.generatedDrift.status === 'drifted') {
      log('仓库生成物漂移：待再生成 presets/switchboard.patch.yml（git 跟踪文件）。');
      if (!apply) log('未写盘：preset 再生成待 --apply；随后重新注入并验证。');
      else {
        // 在生成器写入前完成现有目标的结构、格式和权限预检。
        writableParent(generatedPath);
        writableParent(s.paths.patch);
        if (!s.roles.exists || s.roles.verdict === 'migrated') writableParent(s.paths.roles);
        assertUnchanged(s.paths.patch, patchOriginal);
        assertUnchanged(s.paths.roles, rolesOriginal);
        assertUnchanged(generatedPath, generatedOriginal);
        log('再生成：node scripts/gen-preset.mjs（shell: false，文件描述符 captureSync）。');
        const result = captureSync(process.execPath, [join(s.paths.repoRoot, 'scripts', 'gen-preset.mjs')],
          { cwd: s.paths.repoRoot, env: { ...env, DSH_PRESET_EXPECTED_SHA256: createHash('sha256').update(generatedOriginal).digest('hex') }, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
        for (const output of [result.stdout, result.stderr]) if (output?.trim()) log(output.trim());
        if (result.error || result.status !== 0)
          throw new Error(`preset 再生成失败：${result.error?.message ?? `退出码 ${result.status}，信号 ${result.signal ?? '-'}；${result.stderr.trim() || result.stdout.trim()}`}`);
        const regenerated = readFileSync(generatedPath, 'utf8');
        assertUnchanged(s.paths.patch, patchOriginal);
        assertUnchanged(s.paths.roles, rolesOriginal);
        const afterGeneration = collect();
        if (regenerated === block || afterGeneration.preset.generatedDrift.status !== 'current')
          throw new Error(`preset 再生成后复读验证失败：${regenerated === block ? '文件字节未改变' : afterGeneration.preset.generatedDrift.reason ?? '产物未达到 current'}`);
        log('PASS  preset 再生成后复读验证：字节已改变，生成物 current。');
        s = afterGeneration;
        block = regenerated;
        next = planInjectedPreset(original, block);
      }
    }
  }
  const patchChanged = original !== next;
  const seed = command !== 'uninstall' && !s.roles.exists;
  const migrate = command !== 'uninstall' && s.roles.verdict === 'migrated';
  const purgeRoles = command === 'uninstall' && purge && s.roles.exists;
  // 所有结构/格式/权限预检先于任何备份、目录创建或写入。
  if (apply) {
    assertUnchanged(s.paths.patch, patchOriginal);
    assertUnchanged(s.paths.roles, rolesOriginal);
    if (patchChanged) writableParent(s.paths.patch);
    if (seed || migrate || purgeRoles) writableParent(s.paths.roles);
  }
  log(`${apply ? 'apply' : 'dry-run'}：preset ${patchChanged ? command === 'uninstall' ? '将剥离' : '将同步' : '无需改动'}；roles ${seed ? '将播种空角色列表' : migrate ? '将迁移格式' : purgeRoles ? '将删除' : '保留原始字节'}。`);
  if (patchChanged && apply) backedChange(s.paths.patch, next, log, patchOriginal);
  if (command === 'uninstall') {
    // 强制屏障：复读确认引用已消失，才能输出包移除指令。
    if (apply || !patchChanged) {
      const patch = readPatch(s.paths.patch);
      if (patch.error || patch.entries.some(row => row.id === 'preset-switchboard')) throw new Error('卸载剥离后验证失败！不得移除包');
      const remaining = [];
      // 只扫描移包后仍保留的 profile 配置；仓库 bundle patch 随包分发、随包移除，不会悬空。
      const profileConfig = join(s.paths.profile, 'cordis.yml');
      for (const path of [s.paths.patch, ...(existsSync(profileConfig) ? [profileConfig] : [])]) {
        for (const ref of scanPackageReferences(readFileSync(path, 'utf8'), s.repo.name))
          remaining.push(`${path}:${ref.line} id=${ref.id}`);
      }
      if (remaining.length) throw new Error(`profile 配置中仍有包引用，移除包将留下悬空引用；拒绝移除指令及 --purge-roles。工具刻意不删除用户编写的内容；请自行解决或移除下列条目后重新运行：\n${remaining.join('\n')}`);
      log('PASS  preset 剥离后复读验证；profile patch 与 cordis.yml（若存在）均无剩余包引用。');
    } else { log('未写盘：必须先 --apply 剥离并验证 preset，之后才可移除包。'); return { snapshot: s, exitCode: 1 }; }
    if (registered) { log(`人工包移除步骤：${packageInstruction(s, true)}`); return { snapshot: collect(), exitCode: 3 }; }
    if (purgeRoles && apply) backedChange(s.paths.roles, null, log, rolesOriginal, () => {
      const current = JSON.parse(readFileSync(join(s.paths.profile, 'package.json'), 'utf8'));
      if (!current || typeof current !== 'object' || Array.isArray(current)
        || Object.hasOwn(current.dependencies ?? {}, s.repo.name) || current.dsh?.profile?.bundles?.includes(s.repo.name))
        throw new Error('--purge-roles 被拒绝：包重新登记或登记文件无效，请重新运行');
    });
    log(s.restart.reason);
    return { snapshot: collect(), exitCode: !apply && purgeRoles ? 1 : 0 };
  }
  if (seed && apply) backedChange(s.paths.roles, `${JSON.stringify(initialConfig(), null, 2)}\n`, log, rolesOriginal);
  if (migrate) {
    const result = migrateConfigFileOnDisk(s.paths.roles, { apply, expected: rolesOriginal });
    if (!result.ok) throw new Error(result.error);
    if (result.backup) log(`备份：${result.backup}`);
    log(apply ? 'PASS  roles 格式迁移后复读验证' : `未写盘：roles 格式迁移 ${JSON.stringify(result.applied)}`);
  }
  const after = collect();
  if (apply && (seed || migrate) && (!readConfigFileDetailed(s.paths.roles).ok || after.roles.verdict !== 'current'))
    throw new Error('roles 写后格式验证失败！请从备份恢复');
  const needsPackageUpdate = command === 'upgrade' && after.registration.resolvedVersion !== after.repo.version;
  const needsExemption = after.compatibility.peers.status === 'incompatible' && after.compatibility.runtimeExempt !== true;
  if (needsPackageUpdate) {
    log(`安装版本 ${after.registration.resolvedVersion} 与仓库版本 ${after.repo.version} 不同；人工包更新步骤：${packageInstruction(after)}`);
  }
  if (needsExemption) {
    log(`兼容性人工豁免步骤：${exemptionInstruction(after)}`);
  }
  if (needsPackageUpdate || needsExemption) {
    log(after.restart.reason);
    const otherIssues = after.verification.issues.filter(issue => !(needsPackageUpdate && issue.code === 'registration.version')
      && !(needsExemption && issue.code.startsWith('compatibility.')));
    for (const issue of otherIssues) log(`FAIL  ${issue.code}：${issue.reason}`);
    return { snapshot: after, exitCode: otherIssues.length ? 1 : 3 };
  }
  log(`${after.verification.issues.length ? '制品尚未完全同步' : '制品已同步'}；生效必须重启。`);
  log(after.restart.reason);
  for (const issue of after.verification.issues) log(`FAIL  ${issue.code}：${issue.reason}`);
  return { snapshot: after, exitCode: after.verification.issues.length ? 1 : 0 };
}

export function runLifecycle({ argv = process.argv.slice(2), env = process.env, paths,
  collectOptions = {}, log = console.log } = {}) {
  const command = argv[0] ?? 'status';
  if (argv.includes('--help') || command === 'help') { log(HELP); return { exitCode: 0 }; }
  if (!['status', 'verify', 'install', 'upgrade', 'uninstall'].includes(command)) throw new Error(`未知子命令：${command}`);
  const json = argv.slice(1).includes('--json');
  const apply = argv.slice(1).includes('--apply'), purge = argv.slice(1).includes('--purge-roles');
  if ((apply && ['status', 'verify'].includes(command)) || (purge && command !== 'uninstall')) throw new Error('写入参数不适用于此命令');
  paths ??= resolvePaths({ argv: argv.slice(1).filter(arg => !['--json', '--apply', '--purge-roles'].includes(arg)), env });
  const snapshot = collectLifecycle({ ...collectOptions, paths, env });
  if (['install', 'upgrade', 'uninstall'].includes(command)) {
    const events = [];
    if (!json) printPaths(paths, log);
    let result;
    try { result = converge(command, snapshot, { apply, purge, env,
      collect: () => collectLifecycle({ ...collectOptions, paths, env }), log: line => { events.push(line); if (!json) log(line); } }); }
    catch (error) { events.push(`FAIL  ${error.message}`); if (!json) log(events.at(-1)); result = { snapshot, exitCode: 1 }; }
    if (json) log(JSON.stringify({ ...result.snapshot, operation: { command, apply, events, exitCode: result.exitCode } }, null, 2));
    return { ...result, events };
  }
  if (json) log(JSON.stringify(snapshot, null, 2));
  else {
    printPaths(paths, log);
    const s = snapshot;
    const section = (key, lines) => { log(`\n=== ${key} ===`); for (const line of lines) log(`  ${line}`); };
    const verdict = value => `${value.status}${value.reason ? ` — ${value.reason}` : ''}`;
    section('repo', [`${s.repo.name}@${s.repo.version}；manifestVersion=${s.repo.manifestVersion}；CONFIG_FORMAT_VERSION=${s.repo.configFormatVersion}`,
      `DSH peers：${JSON.stringify(s.repo.peerDependencies)}`]);
    section('profile', [`目录存在=${s.profile.exists}；package.json 存在=${s.profile.packageExists}；kind=${s.profile.kind}`,
      ...(s.profile.error ? [s.profile.error] : [])]);
    section('registration', [`dependencies：${s.registration.dependencySpec ?? '缺失'}`,
      `dsh.profile.bundles：${s.registration.inBundles ? '已登记' : '未登记'}`,
      `磁盘包体：${s.registration.resolved ? `可解析（${s.registration.resolvedVersion}）` : '不可解析'}`,
      ...(s.registration.silentFailureTrap ? ['静默不加载陷阱：dependencies 有本包，但 bundles 缺少本包。'] : [])]);
    section('preset', [`preset-switchboard 存在=${s.preset.present}；mount:true=${s.preset.mount}；禁止的 roles 字段=${s.preset.hasRoles}`,
      `supervisorRules：${verdict(s.preset.rules)}`, `仓库生成物：${verdict(s.preset.generatedDrift)}`]);
    section('roles', [`roles.json：${s.roles.verdict}；角色数=${s.roles.count ?? '未知'}；wrapper=${s.roles.wrapperPresent}`,
      ...(s.roles.error ? [s.roles.error] : []), ...(s.roles.wrapperKeys.length ? [`wrapper 字段：${s.roles.wrapperKeys.join(', ')}`] : [])]);
    section('compatibility', [`Electron DSH runtime：${s.compatibility.runtime.version ?? verdict(s.compatibility.runtime)}`,
      `精确豁免 ${s.compatibility.key}：${s.compatibility.exemption}；值=${JSON.stringify(s.compatibility.values)}`,
      `当前运行时在豁免值中：${s.compatibility.runtimeExempt ?? '未验证'}`,
      `DSH peers：${verdict(s.compatibility.peers)}`]);
    section('restart', [s.restart.reason]);
    for (const issue of snapshot.verification.issues) log(`  FAIL  ${issue.code}：${issue.reason}`);
    log(`\n${snapshot.verification.status === 'skipped' ? '跳过：未安装插件或默认 profile 不存在。' : `验证：${snapshot.verification.status}`}`);
    log(`下一步：${snapshot.nextStep}`);
  }
  return { snapshot, exitCode: command === 'verify' && snapshot.verification.issues.length ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = runLifecycle().exitCode; }
  catch (error) { console.error(`FAIL  ${error.message}`); process.exitCode = 1; }
}
