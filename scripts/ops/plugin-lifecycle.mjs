// 包管理始终由 DSH 完成；这里只收敛插件自己的派生制品。
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, accessSync, constants, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { resolvePaths, printPaths } from '../lib/paths.mjs';
import { collectLifecycle, isExactDshVersion } from '../lib/lifecycle.mjs';
import { compareVersions } from '../lib/version.mjs';
import { captureSync } from '../lib/capture.mjs';
import { planInjectedPreset, planRolesMigration, readPatch, presetConfig, pluginsWithoutName, scanPackageReferences, stripRootEntry } from '../lib/preset-patch.mjs';
import { initialConfig, migrateConfigFileOnDisk, readConfigFileDetailed } from '../../src/config-file.js';

const HELP = `用法：node scripts/ops/plugin-lifecycle.mjs <status|verify|install|upgrade|uninstall|restore> [路径参数] [--json] [--runtime-version <semver>] [--allow-unknown] [--drop-root-entry]
status：只读报告；verify：只读验证；install：安装后收敛；upgrade：升级收敛；uninstall：安全剥离后提示移除包；
restore：--list 列出/--from <备份> 恢复本工具生成的时间戳备份；--prune --keep <N> 只保留每个目标最近 N 份；默认只列，--apply 才写盘/删除。
写入操作默认 dry-run（省略 --apply；没有 --dry-run flag）；只有 --apply 才写盘，包括漂移的仓库 preset 再生成。
--purge-roles：uninstall 仅包已移除、且没有其它 profile 仍登记本包时删除角色文件。--json：输出单份 JSON 快照及操作事件。
--drop-root-entry：uninstall 专用；按精确 id/name 删除 profile patch 里的插件根条目（含备份/写后复读），用于清掉移包后的悬空引用。
--runtime-version：CLI-managed profile 用它指定实际加载 profile 的 dsh 版本；desktop 默认读 Electron 归档。
--allow-unknown：verify 专用；显式接受 runtime / 生成物判据未知，否则 unknown 判为 unverified 并退出 1。
本工具不安装依赖、不执行 pnpm、不修改包登记。
退出码：0 = 收敛目标一致（status 正常采集、verify 跳过未安装插件或默认缺失 profile 也为 0）；1 = 失败、未修复的漂移或 verify 的未验证判据（含 dry-run 待写入）；3 = 人工包安装/更新/移除、角色定义或兼容豁免步骤待完成。
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
  return `未实测（本机 dsh CLI 可能是更旧版本；0.2.1-rc.2 归档源码/README 支持该语法）：dsh plugin --profile ${quote(s.profile.name)} ${remove ? `remove ${quote(s.repo.name)}` : `add ${quote(spec)}`}`;
}

function exemptionInstruction(s) {
  // 不猜测 GUI 精确文案；CLI 语法有 0.2.1-rc.2 归档源码依据，但本机 CLI 可能更旧，仍标未实测。
  const key = s.compatibility.key;
  const runtime = s.compatibility.runtime.version ?? '<runtime>';
  const warning = '允许不兼容版本运行可能导致崩溃或数据损坏；请先判断能否重 pin / 升级插件，豁免只应作为最后手段。';
  const manual = `人工确认后在 ${join(s.paths.profile, 'compatibility.json')} 设置精确键 ${JSON.stringify(key)} 的值为 ${JSON.stringify([runtime])}；不自动创建豁免。`;
  if (s.profile.kind === 'desktop') {
    return `Electron DSH → Plugins → 本插件 → 允许不兼容版本（按钮/流程未验证）；${manual}${warning}`;
  }
  return `未实测（本机 dsh CLI 版本可能低于 0.2.1-rc.2，源码语法）：dsh plugin --profile ${quote(s.profile.name)} `
    + `allow-version ${quote(key)} --dsh-version ${quote(runtime)} --accept-risk；或${manual}${warning}`;
}

function writableParent(path) {
  let parent = dirname(path);
  while (!existsSync(parent)) parent = dirname(parent);
  accessSync(parent, constants.W_OK);
  if (existsSync(path)) accessSync(path, constants.W_OK);
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return isObject(value) ? { value } : { error: '顶层必须是对象' };
  } catch (error) {
    return { error: error.code === 'ENOENT' ? '文件不存在' : error.message };
  }
}

/** 同一 home 下仍声明或启用本包的其它 profile；roles.json 是 home 级共享数据。 */
function otherProfilesUsingPackage(home, packageName, currentProfile) {
  const profiles = join(home, 'profiles');
  if (!existsSync(profiles)) return [];
  const rows = [];
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(profiles, entry.name);
    if (dir === currentProfile) continue;
    const manifest = readJson(join(dir, 'package.json'));
    if (!manifest.value) {
      // 读不懂的其它 profile 也可能仍在使用共享 roles；不能当成“没登记”而放行 purge。
      if (manifest.error && manifest.error !== '文件不存在')
        rows.push({ name: entry.name, dir, dependency: false, bundle: false, manifestError: true });
      continue;
    }
    const dependency = ['dependencies', 'devDependencies', 'optionalDependencies']
      .some(field => isObject(manifest.value[field]) && Object.hasOwn(manifest.value[field], packageName));
    const bundle = Array.isArray(manifest.value.dsh?.profile?.bundles)
      && manifest.value.dsh.profile.bundles.includes(packageName);
    if (dependency || bundle) rows.push({ name: entry.name, dir, dependency, bundle });
  }
  return rows;
}

function purgeRefusal(rows) {
  return `--purge-roles 被拒绝：roles.json 是 home 级共享数据，下列 profile 仍声明或启用本包：\n`
    + `${rows.map(row => `${row.name}${row.manifestError ? ' manifest-unreadable'
      : `${row.dependency ? ' dependency' : ''}${row.bundle ? ' bundle' : ''}`}`).join('\n')}\n`
    + '请先在那些 profile 中卸载，或自行确认后再删除角色文件。';
}

/** 本工具允许恢复的备份集合：profile patch、home patch、roles 文件。 */
function backupTargets(paths) {
  return [
    { target: paths.patch, prefixes: ['.bak-lifecycle-'] },
    { target: join(paths.home, 'cordis.patch.yml'), prefixes: ['.bak-lifecycle-'] },
    { target: paths.roles, prefixes: ['.bak-lifecycle-', '.bak-migrate-format-'] },
  ];
}

function listBackups(paths) {
  const rows = [];
  for (const { target, prefixes } of backupTargets(paths)) {
    const dir = dirname(target), base = basename(target);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${base}.bak-`)) continue;
      if (!prefixes.some(prefix => name.includes(prefix))) continue;
      const backup = join(dir, name);
      try {
        const stat = statSync(backup);
        rows.push({ backup, target, size: stat.size, mtime: stat.mtime.toISOString() });
      } catch { /* 列不出就跳过，不阻断其它备份 */ }
    }
  }
  return rows.sort((left, right) => right.mtime.localeCompare(left.mtime));
}

function restoreBackup({ argv, paths, apply, log }) {
  const listOnly = argv.includes('--list');
  const prune = argv.includes('--prune');
  const fromAt = argv.indexOf('--from');
  const keepAt = argv.indexOf('--keep');
  let keep = 5;
  if (keepAt >= 0) {
    const raw = argv[keepAt + 1];
    if (!raw || !/^[1-9][0-9]*$/.test(raw)) throw new Error('--keep 需要正整数');
    keep = Number(raw);
  }
  if (!prune && keepAt >= 0) throw new Error('--keep 只能与 --prune 同用');
  if (prune && fromAt >= 0) throw new Error('--prune 与 --from 不能同时使用');
  if (prune && listOnly) throw new Error('--prune 与 --list 不能同时使用');
  if (listOnly && fromAt >= 0) throw new Error('--list 与 --from 不能同时使用');
  if (apply && fromAt < 0 && !prune) throw new Error('--apply 需要配合 --from <备份> 或 --prune');
  if (listOnly && apply) throw new Error('--list 是只读操作，不接受 --apply');
  const rows = listBackups(paths);
  for (const row of rows)
    log(`${row.mtime}  ${String(row.size).padStart(7)}  ${row.backup} -> ${row.target}`);
  if (prune) {
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.target)) groups.set(row.target, []);
      groups.get(row.target).push(row);
    }
    const remove = [];
    for (const group of groups.values()) if (group.length > keep) remove.push(...group.slice(keep));
    if (remove.length === 0) {
      log(`没有超过保留数 ${keep} 的备份。`);
      return { exitCode: 0, restore: { list: rows, pruned: false, keep, removed: [] } };
    }
    if (!apply) {
      for (const row of remove) log(`将删除：${row.backup}`);
      log(`未写盘：--prune 待 --apply；每个目标保留最近 ${keep} 份。`);
      return { exitCode: 0, restore: { list: rows, pruned: false, keep, removed: remove.map(row => row.backup) } };
    }
    for (const row of remove) { unlinkSync(row.backup); log(`已删除：${row.backup}`); }
    log(`PASS  prune 完成：每个目标保留最近 ${keep} 份，共删除 ${remove.length} 份。`);
    return { exitCode: 0, restore: { list: rows, pruned: true, keep, removed: remove.map(row => row.backup) } };
  }
  if (listOnly || fromAt < 0) {
    log(rows.length > 0 ? `共 ${rows.length} 个可恢复备份；用 --from <路径> --apply 恢复。` : '没有可恢复的备份。');
    return { exitCode: 0, restore: { list: rows, applied: false } };
  }
  const value = argv[fromAt + 1];
  if (!value || value.startsWith('--')) throw new Error('--from 缺少备份路径');
  if (argv.indexOf('--from', fromAt + 1) >= 0) throw new Error('--from 重复');
  const backup = resolve(value);
  const hit = rows.find(row => row.backup === backup);
  if (!hit) throw new Error(`拒绝恢复不在允许列表中的文件：${backup}`);
  const bytes = readFileSync(backup);
  if (bytes.toString('utf8').startsWith('原文件不存在；'))
    throw new Error('该备份是“原文件不存在”记录，不能当内容恢复；请直接删除目标文件');
  if (!apply) {
    log(`未写盘：将恢复 ${hit.target} <- ${hit.backup}；加 --apply 才写入。`);
    return { exitCode: 0, restore: { list: rows, applied: false, target: hit.target, backup: hit.backup } };
  }
  backedChange(hit.target, bytes, log, snapshotBytes(hit.target));
  log(`PASS  已恢复 ${hit.target}（恢复前当前内容已另存备份）`);
  return { exitCode: 0, restore: { list: rows, applied: true, target: hit.target, backup: hit.backup } };
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

function converge(command, s, { apply, purge, collect, env, log, dropRoot = false }) {
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
  // 缺失的 profile patch 在 DSH 中等价于空用户层（initProfile 会创建；fatal recovery 会改名备份）。
  const patchBytes = snapshotBytes(s.paths.patch);
  const patchOriginal = patchBytes ?? Buffer.from('[]\n');
  const original = patchOriginal.toString('utf8');
  const rolesOriginal = snapshotBytes(s.paths.roles);
  const generatedPath = join(s.paths.repoRoot, 'presets', 'switchboard.patch.yml');
  const rowsPath = join(s.paths.repoRoot, 'presets', 'standard-plugins.json');
  const generatedOriginal = command === 'uninstall' ? null : readFileSync(generatedPath);
  const rowsOriginal = command === 'uninstall' ? null : snapshotBytes(rowsPath);
  let block = generatedOriginal?.toString('utf8') ?? '';
  if (command !== 'uninstall') {
    const repoPresetPatch = readPatch(join(s.paths.repoRoot, 'presets', 'switchboard.patch.yml'));
    const generated = presetConfig(repoPresetPatch, s.repo.name);
    const generatedSolo = presetConfig(repoPresetPatch, s.repo.name, 'preset-switchboard-solo');
    for (const preset of [generated, generatedSolo]) {
      if (preset.error || preset.config?.mount !== true || Object.hasOwn(preset.config ?? {}, 'roles')
        || typeof preset.config?.supervisorRules !== 'string' || !preset.config.supervisorRules.trim()
        || pluginsWithoutName(preset.preset.config.plugins).length) throw new Error('仓库 preset 无效，拒绝同步');
    }
    if (!Array.isArray(generatedSolo.config?.excludedRoles)
      || !generatedSolo.config.excludedRoles.includes('worker')
      || generatedSolo.config?.compositionKey === 'switchboard')
      throw new Error('仓库自办 preset 的组合键/排除角色无效，拒绝同步');
    if (s.roles.exists && !s.roles.ok) throw new Error(`roles.json 不可安全迁移：${s.roles.error}`);
  }
  // ⚠️ preset 由 **bundle**（`dsh.bundle.patch`）投递，profile 里不再内联副本：
  //    顶层 `insert` 是纯追加、不按 id 去重，而 `dsh-agent-preset` 注册重复 id 会硬抛，
  //    所以内联的那份既是多余的、又会装载失败。这里统一**剥离**残留副本。
  let next = planInjectedPreset(original, block, { remove: true });
  // 根条目是用户配置，只在显式 --drop-root-entry 时按精确 id/name 删除；
  // 否则移包后会留下对已移除包名的悬空引用。
  let rootDropped = false;
  if (command === 'uninstall' && dropRoot) {
    const strippedRoot = stripRootEntry(next, s.repo.name);
    if (!strippedRoot.ok) throw new Error(strippedRoot.error);
    if (strippedRoot.changed) { next = strippedRoot.text; rootDropped = true; }
    else log(`根条目未删除：${strippedRoot.reason}`);
  }
  // 收尾迁移：把根条目里完整的 `roles` 块裁成 `roleSettings` 旋钮块（定义已住在文件里）。
  //
  // ⚠️ 安全闸门在 `planRolesMigration` 里：设置与文件的角色 id 集合不一致、或文件里没有
  //    定义时**拒绝迁移**（宁可不迁移也不丢角色）。这里是**文本级**改写 —— profile patch
  //    含 `!!js` 标签，YAML round-trip 会把它们降级成字符串。
  let rolesMigration;
  if (command === 'uninstall') {
    rolesMigration = { ok: true, changed: false, text: next, reason: '卸载不迁移' };
  } else {
    // 定义从文件**原文**读；文件缺失时允许用根条目里的 legacy roles 作为播种来源，
    // 这样“先播种文件、再裁设置”可以在同一次 install 内完成，不依赖重启时的根实例同步。
    const rolesRead = readConfigFileDetailed(s.paths.roles);
    const fileDefinitions = rolesRead.ok && Array.isArray(rolesRead.config?.roles) ? rolesRead.config.roles : [];
    const definitions = fileDefinitions.length > 0 ? fileDefinitions
      : (!s.roles.exists && Array.isArray(s.roles.settingsRoles) ? s.roles.settingsRoles : []);
    const planned = planRolesMigration(next, definitions);
    if (!planned.ok) {
      // ⚠️ 拒绝是**跳过**，不是失败：闸门拦住时设置层仍是完整的 `roles`，legacy 路径照常工作。
      //    让 install/upgrade 因此中止，等于用一次「本可选的收尾」阻断一件用户真正要做的事。
      log(`跳过角色设置收尾迁移（不阻断本次操作）：${planned.error}`);
      rolesMigration = { ok: true, changed: false, text: next, reason: planned.error };
    } else {
      rolesMigration = planned;
      if (planned.changed) next = planned.text;
    }
  }
  if (command !== 'uninstall') {
    const rowsDrift = s.preset.rowsDrift ?? { status: 'unknown', reason: '行模板漂移判据缺失' };
    if (s.preset.generatedDrift.status === 'unknown' || rowsDrift.status === 'unknown')
      log(`仓库生成物漂移未验证；无法自动再生成：${s.preset.generatedDrift.reason ?? rowsDrift.reason}；手工回退：npm run gen:preset；继续收敛可验证制品。`);
    if (s.preset.generatedDrift.status === 'drifted' || rowsDrift.status === 'drifted') {
      const targets = [s.preset.generatedDrift.status === 'drifted' ? 'presets/switchboard.patch.yml' : '',
        rowsDrift.status === 'drifted' ? 'presets/standard-plugins.json' : ''].filter(Boolean).join('、');
      log(`仓库生成物漂移：待再生成 ${targets}（git 跟踪文件）。`);
      if (!apply) log('未写盘：preset 再生成待 --apply；随后剥离残留注入并验证。');
      else {
        // 在生成器写入前完成现有目标的结构、格式和权限预检。
        writableParent(generatedPath);
        writableParent(rowsPath);
        writableParent(s.paths.patch);
        if (!s.roles.exists || s.roles.verdict === 'migrated') writableParent(s.paths.roles);
        assertUnchanged(s.paths.patch, patchBytes);
        assertUnchanged(s.paths.roles, rolesOriginal);
        assertUnchanged(generatedPath, generatedOriginal);
        log('再生成：node scripts/gen-preset.mjs（shell: false，文件描述符 captureSync）。');
        const result = captureSync(process.execPath, [join(s.paths.repoRoot, 'scripts', 'gen-preset.mjs')],
          { cwd: s.paths.repoRoot, env: { ...env, DSH_PRESET_EXPECTED_SHA256: createHash('sha256').update(generatedOriginal).digest('hex') }, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
        for (const output of [result.stdout, result.stderr]) if (output?.trim()) log(output.trim());
        if (result.error || result.status !== 0)
          throw new Error(`preset 再生成失败：${result.error?.message ?? `退出码 ${result.status}，信号 ${result.signal ?? '-'}；${result.stderr.trim() || result.stdout.trim()}`}`);
        const regenerated = readFileSync(generatedPath, 'utf8');
        const rowsRegenerated = snapshotBytes(rowsPath);
        assertUnchanged(s.paths.patch, patchBytes);
        assertUnchanged(s.paths.roles, rolesOriginal);
        const afterGeneration = collect();
        const yamlChanged = regenerated !== block;
        const rowsChanged = rowsRegenerated !== null
          && (rowsOriginal === null || !rowsRegenerated.equals(rowsOriginal));
        if (!yamlChanged && !rowsChanged)
          throw new Error('preset 再生成后复读验证失败：文件字节未改变');
        if (afterGeneration.preset.generatedDrift.status !== 'current' || afterGeneration.preset.rowsDrift?.status !== 'current')
          throw new Error(`preset 再生成后复读验证失败：${afterGeneration.preset.generatedDrift.reason
            ?? afterGeneration.preset.rowsDrift?.reason ?? '产物未达到 current'}`);
        log('PASS  preset 再生成后复读验证：字节已改变，YAML 与行模板均为 current。');
        s = afterGeneration;
        block = regenerated;
        next = planInjectedPreset(original, block, { remove: true });
      }
    }
  }
  const patchChanged = original !== next;
  // split 模式的定义必须已经在文件里；缺失时绝不能播种空文件，否则运行期直接报
  // “有 roleSettings 但没有角色定义”，而工具却会以 0 退出。
  const splitSettings = s.roles.settingsRoleSettingsPresent === true;
  const invalidLegacyRoles = s.roles.settingsRolesPresent === true && !Array.isArray(s.roles.settingsRoles);
  const seedRoles = Array.isArray(s.roles.settingsRoles) ? s.roles.settingsRoles : [];
  const seed = command !== 'uninstall' && !s.roles.exists && !splitSettings && !invalidLegacyRoles;
  const manualRoles = command !== 'uninstall' && !s.roles.exists && splitSettings;
  const migrate = command !== 'uninstall' && s.roles.verdict === 'migrated';
  const purgeRoles = command === 'uninstall' && purge && s.roles.exists;
  // --purge-roles 删除的是 home 级共享文件：写入前先拒绝「其它 profile 仍在用」，避免先改
  // profile patch 再报错。这样 dry-run 也不会打印“roles 将删除”。
  if (purgeRoles) {
    const otherProfiles = otherProfilesUsingPackage(s.paths.home, s.repo.name, s.paths.profile);
    if (otherProfiles.length > 0) throw new Error(purgeRefusal(otherProfiles));
  }
  // 所有结构/格式/权限预检先于任何备份、目录创建或写入。
  if (apply) {
    assertUnchanged(s.paths.patch, patchBytes);
    assertUnchanged(s.paths.roles, rolesOriginal);
    if (patchChanged) writableParent(s.paths.patch);
    if (seed || migrate || purgeRoles) writableParent(s.paths.roles);
  }
  // 文案必须分别反映两件可能同时发生的事：剥离残留副本、收尾迁移。
  const willStrip = planInjectedPreset(original, block, { remove: true }) !== original;
  const parts = [willStrip ? '将剥离残留注入副本' : '', rootDropped ? '将删除插件根条目' : '',
    rolesMigration.changed ? '将收尾角色设置迁移' : ''].filter(Boolean);
  const presetPlan = parts.length > 0 ? parts.join('并') : '无需改动';
  const rolesPlan = seed ? (seedRoles.length > 0 ? `将用设置里的 ${seedRoles.length} 个角色播种` : '将播种空角色列表')
    : manualRoles ? '缺失但设置已是 roleSettings 形态，拒绝播种空文件'
      : migrate ? '将迁移格式' : purgeRoles ? '将删除' : '保留原始字节';
  log(`${apply ? 'apply' : 'dry-run'}：preset ${presetPlan}`
    + `${rolesMigration.changed ? `（roles → roleSettings：${rolesMigration.knobs.length} 个角色，定义已住在文件里）` : ''}`
    + `；roles ${rolesPlan}。`);
  if (patchChanged && apply) backedChange(s.paths.patch, next, log, patchBytes);
  if (command === 'uninstall') {
    // 强制屏障：复读确认引用已消失，才能输出包移除指令。
    if (apply || !patchChanged) {
      const patch = existsSync(s.paths.patch) ? readPatch(s.paths.patch) : { entries: [] };
      if (patch.error || (Array.isArray(patch.entries) && patch.entries.some(row =>
        row.id === 'preset-switchboard' || row.id === 'preset-switchboard-solo')))
        throw new Error('卸载剥离后验证失败！不得移除包');
      const remaining = [];
      // 扫描移包后仍保留的用户层：profile patch、profile cordis.yml、home patch。
      // home patch 在 profile patch 之后应用，漏掉它会把悬空引用放进更优先的层。
      const scanned = [s.paths.patch, join(s.paths.profile, 'cordis.yml'), s.preset.homePatchPath]
        .filter(path => existsSync(path));
      for (const path of scanned) {
        for (const ref of scanPackageReferences(readFileSync(path, 'utf8'), s.repo.name))
          remaining.push(`${path}:${ref.line} id=${ref.id}`);
      }
      if (remaining.length) throw new Error(`profile / home 配置中仍有包引用，移除包将留下悬空引用；拒绝移除指令及 --purge-roles。工具刻意不删除用户编写的内容；请自行解决或移除下列条目后重新运行：\n${remaining.join('\n')}`);
      log('PASS  preset 剥离后复读验证；profile patch、cordis.yml 与 home patch（若存在）均无剩余包引用。');
    } else { log('未写盘：必须先 --apply 剥离并验证 preset，之后才可移除包。'); return { snapshot: s, exitCode: 1 }; }
    // 豁免是精确版本的风险授权，卸载后不会自动失效；至少提示用户撤销。
    const staleKeys = [s.compatibility.key, ...s.compatibility.olderKeys];
    if (s.compatibility.exemptionPresent || s.compatibility.olderKeys.length > 0) {
      log(`兼容性豁免残留：${staleKeys.join(', ')} 仍在 ${join(s.paths.profile, 'compatibility.json')}；`
        + '移除包后如不再需要，请在 DSH 插件页或 dsh plugin revoke-version（版本支持时）撤销；工具不自动删除授权。');
    }
    if (registered) { log(`人工包移除步骤：${packageInstruction(s, true)}`); return { snapshot: collect(), exitCode: 3 }; }
    if (purgeRoles && !apply) log('未写盘：roles 文件未删除；加 --apply 才执行 --purge-roles。');
    if (purgeRoles && apply) backedChange(s.paths.roles, null, log, rolesOriginal, () => {
      const current = JSON.parse(readFileSync(join(s.paths.profile, 'package.json'), 'utf8'));
      if (!current || typeof current !== 'object' || Array.isArray(current)
        || Object.hasOwn(current.dependencies ?? {}, s.repo.name) || current.dsh?.profile?.bundles?.includes(s.repo.name))
        throw new Error('--purge-roles 被拒绝：包重新登记或登记文件无效，请重新运行');
    });
    log(s.restart.reason);
    return { snapshot: collect(), exitCode: !apply && purgeRoles ? 1 : 0 };
  }
  if (seed && apply) backedChange(s.paths.roles, `${JSON.stringify(initialConfig(seedRoles), null, 2)}\n`, log, rolesOriginal);
  if (migrate) {
    const result = migrateConfigFileOnDisk(s.paths.roles, { apply, expected: rolesOriginal });
    if (!result.ok) throw new Error(result.error);
    if (result.backup) log(`备份：${result.backup}`);
    log(apply ? 'PASS  roles 格式迁移后复读验证' : `未写盘：roles 格式迁移 ${JSON.stringify(result.applied)}`);
  }
  const after = collect();
  if (apply && (seed || migrate) && (!readConfigFileDetailed(s.paths.roles).ok || after.roles.verdict !== 'current'))
    throw new Error('roles 写后格式验证失败！请从备份恢复');
  if (manualRoles) {
    log(`人工角色定义步骤：设置层已使用 roleSettings，但 roles.json 不存在；拒绝写入空角色列表。`
      + `请先在 DSH → 设置 → 角色与派发保存角色定义，或把定义写入 ${s.paths.roles}，然后重新运行 install/upgrade。`);
    log(after.restart.reason);
    const otherIssues = after.verification.issues.filter(issue =>
      issue.code !== 'roles.definitions' && issue.code !== 'roles.format');
    for (const issue of otherIssues) log(`FAIL  ${issue.code}：${issue.reason}`);
    return { snapshot: after, exitCode: otherIssues.length ? 1 : 3 };
  }
  // upgrade 只向前：已安装版本高于仓库时，packageInstruction 的 link: 会变成降级。
  let installedAhead = false;
  if (command === 'upgrade' && isExactDshVersion(after.registration.resolvedVersion)) {
    try { installedAhead = compareVersions(after.registration.resolvedVersion, after.repo.version) > 0; }
    catch { installedAhead = false; }
  }
  if (installedAhead) {
    log(`已安装版本 ${after.registration.resolvedVersion} 高于仓库 ${after.repo.version}；upgrade 不降级，拒绝输出包替换指令。`
      + '如确需回退，请显式指定 DSH/GUI 的版本，而不是用本仓库当前版本覆盖。');
    log(after.restart.reason);
    const otherIssues = after.verification.issues.filter(issue => issue.code !== 'registration.version');
    for (const issue of otherIssues) log(`FAIL  ${issue.code}：${issue.reason}`);
    return { snapshot: after, exitCode: otherIssues.length ? 1 : 3 };
  }
  const needsPackageUpdate = command === 'upgrade' && after.registration.resolvedVersion !== after.repo.version;
  const needsExemption = after.compatibility.peers.status === 'incompatible' && after.compatibility.runtimeExempt !== true;
  if (needsPackageUpdate) {
    log(`安装版本 ${after.registration.resolvedVersion} 与仓库版本 ${after.repo.version} 不同；人工包更新步骤：${packageInstruction(after)}`);
  }
  if (needsExemption) {
    log(`兼容性人工豁免步骤（优先重 pin / 升级插件，豁免有风险）：${exemptionInstruction(after)}`);
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
  for (const item of after.verification.unverified ?? []) log(`UNVERIFIED  ${item.code}：${item.reason}`);
  return { snapshot: after, exitCode: after.verification.issues.length ? 1 : 0 };
}

export function runLifecycle({ argv = process.argv.slice(2), env = process.env, paths,
  collectOptions = {}, log = console.log } = {}) {
  const command = argv[0] ?? 'status';
  if (argv.includes('--help') || command === 'help') { log(HELP); return { exitCode: 0 }; }
  if (!['status', 'verify', 'install', 'upgrade', 'uninstall', 'restore'].includes(command)) throw new Error(`未知子命令：${command}`);
  const rest = argv.slice(1);
  let runtimeVersion;
  const runtimeAt = rest.indexOf('--runtime-version');
  if (runtimeAt >= 0) {
    const value = rest[runtimeAt + 1];
    if (!value || value.startsWith('--')) throw new Error('--runtime-version 缺少精确 SemVer');
    if (rest.indexOf('--runtime-version', runtimeAt + 1) >= 0) throw new Error('--runtime-version 重复');
    if (!isExactDshVersion(value)) throw new Error(`--runtime-version 必须是精确 SemVer：${value}`);
    runtimeVersion = value;
    rest.splice(runtimeAt, 2);
  }
  const allowUnknown = rest.includes('--allow-unknown');
  if (allowUnknown) {
    if (command !== 'verify') throw new Error('--allow-unknown 仅适用于 verify');
    rest.splice(rest.indexOf('--allow-unknown'), 1);
  }
  const dropRoot = rest.includes('--drop-root-entry');
  if (dropRoot) {
    if (command !== 'uninstall') throw new Error('--drop-root-entry 仅适用于 uninstall');
    rest.splice(rest.indexOf('--drop-root-entry'), 1);
  }
  if (command === 'restore' && runtimeVersion !== undefined) throw new Error('restore 不接受 --runtime-version');
  if (command !== 'restore' && ['--from', '--list', '--prune', '--keep'].some(flag => rest.includes(flag)))
    throw new Error('--from / --list / --prune / --keep 仅适用于 restore');
  const json = rest.includes('--json');
  const apply = rest.includes('--apply'), purge = rest.includes('--purge-roles');
  if ((apply && ['status', 'verify'].includes(command)) || (purge && command !== 'uninstall')) throw new Error('写入参数不适用于此命令');
  const pathArgs = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (['--json', '--apply', '--purge-roles', '--list', '--prune'].includes(arg)) continue;
    if (arg === '--from' || arg === '--keep') { index++; continue; }
    pathArgs.push(arg);
  }
  paths ??= resolvePaths({ argv: pathArgs, env });
  if (command === 'restore') {
    try {
      const result = restoreBackup({ argv: rest, paths, apply, log });
      if (json) log(JSON.stringify({ paths, restore: result.restore }, null, 2));
      return result;
    } catch (error) {
      if (!json) log(`FAIL  ${error.message}`);
      else log(JSON.stringify({ paths, restore: { error: error.message, applied: false } }, null, 2));
      return { exitCode: 1, restore: { error: error.message, applied: false } };
    }
  }
  const effectiveRuntime = runtimeVersion ?? collectOptions.runtimeVersion;
  const options = { ...collectOptions, paths, env,
    ...(effectiveRuntime !== undefined ? { runtimeVersion: effectiveRuntime } : {}) };
  const snapshot = collectLifecycle(options);
  if (['install', 'upgrade', 'uninstall'].includes(command)) {
    const events = [];
    if (!json) printPaths(paths, log);
    let result;
    try { result = converge(command, snapshot, { apply, purge, dropRoot, env,
      collect: () => collectLifecycle(options), log: line => { events.push(line); if (!json) log(line); } }); }
    catch (error) { events.push(`FAIL  ${error.message}`); if (!json) log(events.at(-1)); result = { snapshot, exitCode: 1 }; }
    if (json) log(JSON.stringify({ ...result.snapshot, operation: { command, apply, dropRoot,
      runtimeVersion: effectiveRuntime ?? null, allowUnknown, events, exitCode: result.exitCode } }, null, 2));
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
      `profile patch 存在=${s.preset.patchExists}；home patch（$DSH_HOME/cordis.patch.yml）存在=${s.preset.homePatchExists}`,
      ...(s.profile.error ? [s.profile.error] : [])]);
    section('registration', [`dependencies：${s.registration.dependencySpec ?? '缺失'}`,
      `安装源：${s.registration.sourceKind ?? '无'}${s.registration.sourceKind === 'link'
        ? `（${s.registration.sourceMatchesRepo ? '指向本仓库' : `不指向本仓库：${s.registration.sourceTarget}`}）`
        : s.registration.sourceKind === 'registry' ? '（无法确认与仓库制品一致）' : ''}`,
      `dsh.profile.bundles：${s.registration.inBundles ? '已登记' : '未登记'}`,
      `磁盘包体：${s.registration.resolved ? `可解析（${s.registration.resolvedVersion}）` : '不可解析'}`,
      `仓库 node_modules dsh*：${s.repoDependencies.status}${s.repoDependencies.reason ? ` — ${s.repoDependencies.reason}` : ''}`,
      ...(s.registration.silentFailureTrap ? ['静默不加载陷阱：dependencies 有本包，但 bundles 缺少本包。'] : [])]);
    section('preset', [`仓库 preset 的 preset-switchboard 存在=${s.preset.present}；mount:true=${s.preset.mount}；禁止的 roles 字段=${s.preset.hasRoles}`,
      `supervisorRules：${verdict(s.preset.rules)}`, `仓库生成物：${verdict(s.preset.generatedDrift)}；行模板：${verdict(s.preset.rowsDrift ?? { status: 'unknown' })}`,
      `bundle 投递（dsh.bundle.patch 声明 presets/switchboard.patch.yml）：${s.preset.bundleDeclaresPreset ? '已声明' : '未声明'}`,
      `profile 里的残留注入副本：${s.preset.injectedInProfile ? '仍有（需剥离）' : '无'}；`
        + `home patch 里的残留注入副本：${s.preset.injectedInHome ? '仍有（需手动移除）' : '无'}`,
      `自办 preset（preset-switchboard-solo）：存在=${s.presetSolo?.present}；mount:true=${s.presetSolo?.mount}；`
        + `compositionKey=${JSON.stringify(s.presetSolo?.compositionKey)}；excludedRoles=${JSON.stringify(s.presetSolo?.excludedRoles)}；`
        + `supervisorRules=${verdict(s.presetSolo?.rules ?? { status: 'unknown' })}`]);
    section('roles', [`roles.json：${s.roles.verdict}；角色数=${s.roles.count ?? '未知'}；wrapper=${s.roles.wrapperPresent}`,
      `设置层：roleSettings=${s.roles.settingsRoleSettingsPresent ? '有' : '无'}；完整 roles=${s.roles.settingsRolesPresent ? '有' : '无'}；`
        + `文件定义 id=${JSON.stringify(s.roles.definitionIds)}`,
      ...(s.roles.error ? [s.roles.error] : []), ...(s.roles.wrapperKeys.length ? [`wrapper 字段：${s.roles.wrapperKeys.join(', ')}`] : [])]);
    section('compatibility', [`运行时：${s.compatibility.runtime.version ?? verdict(s.compatibility.runtime)}`
      + `（${s.compatibility.runtime.source ?? '来源未知'}）`,
      `已安装版本=${s.compatibility.installedVersion ?? '不可解析'}；仓库目标版本=${s.compatibility.targetVersion}`,
      `精确豁免 ${s.compatibility.key}：${s.compatibility.exemption}；值=${JSON.stringify(s.compatibility.values)}`,
      `当前运行时在豁免值中：${s.compatibility.runtimeExempt ?? '未验证'}`,
      `DSH peers（${s.compatibility.manifestSource} manifest）：${verdict(s.compatibility.peers)}`]);
    section('restart', [s.restart.reason]);
    for (const issue of snapshot.verification.issues) log(`  FAIL  ${issue.code}：${issue.reason}`);
    for (const item of snapshot.verification.unverified ?? []) log(`  UNVERIFIED  ${item.code}：${item.reason}`);
    log(`\n${snapshot.verification.status === 'skipped' ? '跳过：未安装插件或默认 profile 不存在。' : `验证：${snapshot.verification.status}`}`);
    log(`下一步：${snapshot.nextStep}`);
  }
  return { snapshot, exitCode: command === 'verify' && (snapshot.verification.issues.length > 0
    || (snapshot.verification.status === 'unverified' && !allowUnknown)) ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = runLifecycle().exitCode; }
  catch (error) { console.error(`FAIL  ${error.message}`); process.exitCode = 1; }
}
