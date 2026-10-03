// B3 只读命令；包管理与制品写入留给后续批次。
import { pathToFileURL } from 'node:url';
import { resolvePaths, printPaths } from '../lib/paths.mjs';
import { collectLifecycle } from '../lib/lifecycle.mjs';

export function runLifecycle({ argv = process.argv.slice(2), env = process.env, paths,
  collectOptions = {}, log = console.log } = {}) {
  const command = argv[0] ?? 'status';
  if (!['status', 'verify'].includes(command)) throw new Error(`未知子命令：${command}（仅支持 status / verify）`);
  const json = argv.slice(1).includes('--json');
  paths ??= resolvePaths({ argv: argv.slice(1).filter(arg => arg !== '--json'), env });
  const snapshot = collectLifecycle({ ...collectOptions, paths, env });
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
      `当前运行时在豁免值中：${s.compatibility.runtimeExempt ?? '未验证'}`]);
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
