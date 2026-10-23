// 离线检查：只修改 tmpdir fixture，不接触真实 DSH profile 或归档。
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { parse, stringify } from 'yaml';
import { captureSync } from './lib/capture.mjs';
import { REPO_ROOT, resolvePaths } from './lib/paths.mjs';
import { collectLifecycle, satisfiesDshRange, evaluateDshPeers, evaluateDshRequirements, isExactDshVersion, isExactDshVersionList, isExactDshExemptionKey } from './lib/lifecycle.mjs';
import { generatePreset, roleRowsTemplate } from './lib/preset-generator.mjs';
import { readPatch, presetConfig, stripInjectedPreset, isOurBlockLine, assertNoStrayOperations, planInjectedPreset, planRolesMigration, scanPackageReferences } from './lib/preset-patch.mjs';
import { runLifecycle } from './ops/plugin-lifecycle.mjs';
import { CONFIG_FORMAT_VERSION } from '../src/config-file.js';

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  if (condition) pass++; else fail++;
}
function section(title) { console.log(`\n=== ${title} ===`); }
const temp = mkdtempSync(join(tmpdir(), 'switchboard-lifecycle-'));
const put = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
// fixture 运行时版本跟随仓库唯一精确 pin 的 dsh peer：manifest 升级 peers 后 stub 必须一起走，
// 否则本检查会在陈旧 stub 上继续绿（0.2.0-rc.2 → 0.2.1-rc.1 事故正是这样漏掉的）。
const dshPeerPins = [...new Set(Object.entries(pkg.peerDependencies ?? {})
  .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  .map(([, range]) => range))];
const stubRuntime = dshPeerPins.length === 1 && isExactDshVersion(dshPeerPins[0]) ? dshPeerPins[0] : '0.2.1-rc.1';
const standard = stringify([{ insert: [{ id: 'preset-standard', config: { plugins: [
  { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent' },
  { id: 'fixture-plugin', name: 'fixture-plugin', config: { text: '嵌套配置' } },
] } }] }]);
const script = join(REPO_ROOT, 'scripts', 'ops', 'plugin-lifecycle.mjs');
const env = { ...process.env, DSH_ASAR: join(temp, 'absent.asar') };
delete env.DSH_HOME;
function fingerprint(path) {
  const files = {};
  function visit(dir) {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name), stat = statSync(file);
      if (stat.isDirectory()) visit(file);
      else files[file] = [stat.mtimeMs, stat.size];
    }
  }
  visit(path);
  return JSON.stringify(files);
}
try {
  const home = join(temp, 'home'), repoRoot = join(temp, 'repo');
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true });
  mkdirSync(join(repoRoot, 'presets'), { recursive: true });
  put(join(repoRoot, 'package.json'), pkg);
  put(join(repoRoot, 'cordis.patch.yml'), '[]\n');
  const generatedPreset = generatePreset(standard, pkg.name);
  const generated = generatedPreset.body;
  const rowsBody = JSON.stringify({
    generatedFrom: 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml',
    note: '由 scripts/gen-preset.mjs 生成，请勿手改：Host 在运行期据此按角色裁剪出独立 preset。',
    rows: roleRowsTemplate(generatedPreset.standardPlugins),
  }, null, 2) + '\n';
  put(join(repoRoot, 'presets', 'switchboard.patch.yml'), generated);
  put(join(repoRoot, 'presets', 'standard-plugins.json'), rowsBody);
  const paths = { ...resolvePaths({ argv: ['--home', home], env: {} }), repoRoot, explicitTarget: false };
  const profilePackage = join(paths.profile, 'package.json');
  const packageBody = join(paths.profile, 'node_modules', pkg.name, 'package.json');
  const compatibilityFile = join(paths.profile, 'compatibility.json');
  const archive = entry => {
    if (entry.endsWith('standard.patch.yml')) return standard;
    if (entry === 'dsh/package.json') return JSON.stringify({ version: stubRuntime });
    throw new Error(`fixture 无归档条目 ${entry}`);
  };
  const options = { paths, repoRoot, readArchive: archive };
  const collect = () => collectLifecycle(options);
  const invoke = (command, extra = {}) => runLifecycle({ argv: [command], paths, collectOptions: options, log: () => {}, ...extra });
  const registered = () => put(profilePackage, { dependencies: { [pkg.name]: `link:${repoRoot}` }, dsh: { profile: { bundles: [pkg.name] } } });
  const patchWith = config => {
    const document = parse(generated);
    document[0].insert[0].config.plugins.find(row => row.name === pkg.name).config = config;
    return stringify(document);
  };
  const patchSoloWith = config => {
    const document = parse(generated);
    document[0].insert[1].config.plugins.find(row => row.name === pkg.name).config = config;
    return stringify(document);
  };
  const repoPresetPatch = readPatch(join(repoRoot, 'presets', 'switchboard.patch.yml'));
  const config = presetConfig(repoPresetPatch, pkg.name).config;
  const soloConfig = presetConfig(repoPresetPatch, pkg.name, 'preset-switchboard-solo').config;
  const cleanPatch = '- insert:\n    - id: unrelated\n      name: unrelated\n      config:\n        cwd: DSH-Agent-Switchboard\n';

  section('缺失与包登记');
  check('默认 profile 缺 package.json 干净跳过', invoke('verify').exitCode === 0 && collect().verification.status === 'skipped');
  check('显式缺失目标失败', invoke('verify', { paths: { ...paths, explicitTarget: true } }).exitCode === 1);
  put(profilePackage, {});
  check('插件完全未安装干净跳过不崩溃', invoke('verify').exitCode === 0 && collect().verification.status === 'skipped');
  put(profilePackage, { dependencies: { [pkg.name]: '*' } });
  let s = collect();
  check('dependencies 不等于安装：缺 bundles 是静默陷阱', s.registration.silentFailureTrap && !s.registration.inBundles
    && s.verification.issues.some(i => i.code === 'registration.bundles' && /静默不加载陷阱/.test(i.reason)));
  registered(); s = collect();
  check('登记正确但磁盘包体不存在单独报告', s.registration.inBundles && s.registration.dependencyPresent
    && !s.registration.resolved && s.verification.issues.some(i => i.code === 'registration.resolution'));
  mkdirSync(join(packageBody, '..'), { recursive: true }); put(packageBody, pkg);
  {
    const depScope = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-tools');
    mkdirSync(depScope, { recursive: true });
    put(join(depScope, 'package.json'), { name: '@deepseek-ai/dsh-tools', version: '0.0.0' });
    s = collect();
    check('仓库 node_modules dsh* 版本不一致时明确失败', s.repoDependencies.status === 'drifted'
      && s.verification.issues.some(i => i.code === 'dependencies.runtime'));
    put(join(depScope, 'package.json'), { name: '@deepseek-ai/dsh-tools', version: stubRuntime });
    s = collect();
    check('仓库 node_modules dsh* 对齐后清除判据', s.repoDependencies.status === 'current'
      && !s.verification.issues.some(i => i.code === 'dependencies.runtime'));
    rmSync(join(repoRoot, 'node_modules', '@deepseek-ai'), { recursive: true, force: true });
  }

  section('preset：权威副本在仓库，profile 只应保持干净');
  put(paths.patch, cleanPatch); s = collect();
  check('profile 干净时 preset 判据来自仓库且无 preset 问题',
    s.preset.present && s.preset.rules.status === 'current' && !s.preset.injectedInProfile
      && !s.verification.issues.some(i => i.code.startsWith('preset.')),
    JSON.stringify({ present: s.preset.present, rules: s.preset.rules, injected: s.preset.injectedInProfile,
      bundle: s.preset.bundleDeclaresPreset, drift: s.preset.generatedDrift,
      issues: s.verification.issues.map(i => `${i.code}:${i.reason}`) }));
  put(paths.patch, cleanPatch + generated); s = collect();
  check('profile 里残留注入副本时明确失败并给出剥离指令',
    s.preset.injectedInProfile && s.verification.issues.some(i => i.code === 'preset.injectedInProfile'
      && /剥离/.test(i.reason)));
  // bundle 未声明 preset 文件时，声明不会被合成，必须明确失败（临时改 fixture 的 package.json）。
  put(join(repoRoot, 'package.json'), { ...pkg, dsh: { ...pkg.dsh, bundle: { patch: ['./cordis.patch.yml'] } } });
  check('bundle 未声明 preset 文件时明确失败',
    collect().verification.issues.some(i => i.code === 'preset.bundleDeclaration'));
  put(join(repoRoot, 'package.json'), pkg);
  put(paths.patch, cleanPatch);
  check('cwd 中含 Switchboard 不属于本块', !isOurBlockLine('        cwd: DSH-Agent-Switchboard'));
  check('剥离只删除 preset 并保留 cwd', stripInjectedPreset(cleanPatch + generated).includes('cwd: DSH-Agent-Switchboard')
    && !stripInjectedPreset(cleanPatch + generated).includes('id: preset-switchboard'));
  check('剥离后结构断言继续通过', assertNoStrayOperations(stripInjectedPreset(cleanPatch + generated), 'fixture'));
  for (const [label, original] of [['空序列注入', '[]\n'], ['strip → re-inject', planInjectedPreset(generated, '', { remove: true })]]) {
    let parsed, error;
    try { parsed = parse(planInjectedPreset(original, generated)); } catch (e) { error = e.message; }
    check(`${label} 可解析且 preset 存在`, parsed?.[0]?.insert?.[0]?.id === 'preset-switchboard', error);
  }
  // 历史 profile 可能只注入过单条 preset；升级必须能剥离旧块并换上双 preset 块。
  {
    const soloStartInGenerated = generated.indexOf('\n    - id: preset-switchboard-solo');
    const oldSingle = generated.slice(0, soloStartInGenerated) + '\n';
    let upgraded, upgradeError;
    try { upgraded = parse(planInjectedPreset(oldSingle, generated)); } catch (error) { upgradeError = error.message; }
    check('历史单 preset 注入可升级为双 preset 且不重复',
      !upgradeError && Array.isArray(upgraded?.[0]?.insert)
        && upgraded[0].insert.length === 2
        && upgraded[0].insert[0].id === 'preset-switchboard'
        && upgraded[0].insert[1].id === 'preset-switchboard-solo',
      upgradeError);
  }
  const userComment = '# 用户注释：必须逐字保留\n';
  check('相邻用户注释剥离后逐字保留', stripInjectedPreset(generated + userComment + cleanPatch).includes(userComment)
    && planInjectedPreset(generated + userComment, '', { remove: true }).includes(userComment));
  check('缩进的尾随用户注释也逐字保留', stripInjectedPreset(generated + '  ' + userComment + cleanPatch).includes('  ' + userComment));
  const rootReference = `- insert:\n    - id: agent-switchboard\n      name: ${JSON.stringify(pkg.name)}\n`;
  const packageRefs = scanPackageReferences(rootReference + generated, pkg.name);
  check('全深度引用扫描列出根条目与两个 preset 的本包行', packageRefs.length === 3
    && packageRefs[0].id === 'agent-switchboard'
    && packageRefs[0].line === 3
    && packageRefs.filter(ref => ref.id === 'switchboard-roles').length === 2);
  const aliasReferences = scanPackageReferences(`- insert:\n    - id: alias-owner\n      module: &pkg ${JSON.stringify(pkg.name)}\n    - id: alias-user\n      package: *pkg\n`, pkg.name);
  check('等价字段与 alias 引用保留 id 和行', aliasReferences.length === 2 && aliasReferences[1].id === 'alias-user' && aliasReferences[1].line === 5);
  // 仓库 preset（权威副本）自身的结构问题仍必须逐条报告。
  const generatedFile = join(repoRoot, 'presets', 'switchboard.patch.yml');
  put(generatedFile, '- insert: []\n'); s = collect();
  check('仓库 preset 缺少 preset-switchboard 时明确失败',
    s.verification.issues.some(i => i.code === 'preset.structure'));
  put(generatedFile, patchWith({ ...config, supervisorRules: '' })); s = collect();
  check('仓库 preset 的 supervisorRules 仅含空白时明确失败',
    s.preset.rules.status === 'invalid' && s.verification.issues.some(i => i.code === 'preset.rules'));
  put(generatedFile, patchWith({ ...config, roles: [] }));
  check('禁止 roles 字段明确失败', collect().preset.hasRoles && collect().verification.issues.some(i => i.code === 'preset.roles'));
  put(generatedFile, patchWith({ ...config, mount: false }));
  check('仓库 preset 缺少 mount:true 时明确失败',
    collect().verification.issues.some(i => i.code === 'preset.mount'));
  put(generatedFile, patchSoloWith({ ...soloConfig, supervisorRules: '' })); s = collect();
  check('自办 preset 的 supervisorRules 为空时明确失败',
    s.presetSolo.rules.status === 'invalid' && s.verification.issues.some(i => i.code === 'preset.solo.rules'));
  put(generatedFile, patchSoloWith({ ...soloConfig, excludedRoles: [] })); s = collect();
  check('自办 preset 未排除 worker 时明确失败',
    s.verification.issues.some(i => i.code === 'preset.solo.exclusion'));
  put(generatedFile, patchSoloWith({ ...soloConfig, compositionKey: 'switchboard' })); s = collect();
  check('自办 preset 与完整分工版共用 compositionKey 时明确失败',
    s.verification.issues.some(i => i.code === 'preset.solo.compositionKey'));
  put(generatedFile, generated);
  check('规则有效且生成物无漂移', collect().preset.rules.status === 'current' && collect().preset.generatedDrift.status === 'current');
  put(paths.patch, cleanPatch + generated);
  check('profile 残留注入副本让 verify 退出非零', invoke('verify').exitCode === 1);
  put(paths.patch, cleanPatch);
  check('成功读取 standard 后无漂移原因为空', collect().preset.generatedDrift.reason === null);
  put(join(repoRoot, 'presets', 'switchboard.patch.yml'), generated + '\n');
  s = collect();
  check('生成物单个换行漂移也被检测', s.preset.generatedDrift.status === 'drifted');
  check('生成物漂移进入 verify 判据', s.verification.issues.some(i => i.code === 'preset.generatedDrift'
    && i.reason === '仓库 preset 与生成器当前产物字节不一致') && invoke('verify').exitCode === 1);
  put(join(repoRoot, 'presets', 'switchboard.patch.yml'), generated);
  check('恢复生成物后清除漂移判据', collect().preset.generatedDrift.status === 'current'
    && !collect().verification.issues.some(i => i.code === 'preset.generatedDrift'));
  put(join(repoRoot, 'presets', 'standard-plugins.json'), rowsBody + '\n');
  s = collect();
  check('行模板单个换行漂移也被检测并进入 verify', s.preset.rowsDrift.status === 'drifted'
    && s.verification.issues.some(i => i.code === 'preset.rowsDrift') && invoke('verify').exitCode === 1);
  put(join(repoRoot, 'presets', 'standard-plugins.json'), rowsBody);
  check('恢复行模板后清除漂移判据', collect().preset.rowsDrift.status === 'current'
    && !collect().verification.issues.some(i => i.code === 'preset.rowsDrift'));
  check('无归档是 unknown 而不是伪验证或崩溃', collectLifecycle({ ...options, readArchive: null }).preset.generatedDrift.status === 'unknown');
  s = collectLifecycle({ ...options, readArchive: () => { throw new Error('missing entry'); } });
  check('归档读取失败保留生成物与运行时的真实原因', s.preset.generatedDrift.status === 'unknown'
    && s.preset.generatedDrift.reason === '未验证：missing entry' && s.compatibility.runtime.status === 'unknown'
    && s.compatibility.runtime.reason === '未验证：missing entry' && !Object.hasOwn(s.compatibility.runtime, 'version')
    && s.compatibility.runtimeExempt === null);
  s = collectLifecycle({ ...options, readArchive: entry => entry.endsWith('standard.patch.yml') ? 'invalid standard' : '{' });
  check('退出成功但归档内容不可解析仍是 unknown 且有原因', s.preset.generatedDrift.status === 'unknown'
    && s.preset.generatedDrift.reason.includes('plugins:') && s.compatibility.runtime.status === 'unknown'
    && s.compatibility.runtime.reason.startsWith('未验证：') && !Object.hasOwn(s.compatibility.runtime, 'version'));
  s = collectLifecycle({ ...options, readArchive: entry => entry === 'dsh/package.json' ? '{"version":"01.2.3"}' : archive(entry) });
  check('畸形运行时版本 unknown、有原因且不进入 verdict', s.compatibility.runtime.status === 'unknown'
    && /SemVer/.test(s.compatibility.runtime.reason) && !Object.hasOwn(s.compatibility.runtime, 'version')
    && s.compatibility.peers.status === 'unknown' && !s.compatibility.peers.ranges && s.compatibility.runtimeExempt === null);

  section('临时 ASAR 与真实子进程读取');
  // 按 dsh-cat 的归档格式生成最小 fixture，覆盖非注入的 captureSync 路径。
  const archivePath = join(temp, 'fixture.asar');
  const archiveHeader = { files: {} }, archiveBodies = [];
  let offset = 0;
  for (const [entry, content] of [
    ['dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml', standard],
    ['dsh/package.json', JSON.stringify({ version: stubRuntime })],
  ]) {
    const body = Buffer.from(content);
    const parts = entry.split('/');
    let parent = archiveHeader;
    for (const part of parts.slice(0, -1)) parent = parent.files[part] ??= { files: {} };
    parent.files[parts.at(-1)] = { offset: String(offset), size: body.length };
    archiveBodies.push(body); offset += body.length;
  }
  const header = Buffer.from(JSON.stringify(archiveHeader));
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(header.length + 8, 4);
  prefix.writeUInt32LE(header.length + 4, 8);
  prefix.writeUInt32LE(header.length, 12);
  writeFileSync(archivePath, Buffer.concat([prefix, header, ...archiveBodies]));
  const archiveEnv = { ...env, DSH_ASAR: archivePath };
  const cat = captureSync(process.execPath, [join(REPO_ROOT, 'scripts', 'dsh-cat.mjs'), 'dsh/package.json'], { env: archiveEnv });
  check('ASAR stderr 非空但退出成功且 JSON 可解析', cat.status === 0 && !cat.error
    && cat.stderr.includes('ASAR:') && JSON.parse(cat.stdout).version === stubRuntime, cat.stderr);
  console.log(`  观察到 stderr：${cat.stderr.trim()}；JSON version=${JSON.parse(cat.stdout).version}`);
  s = collectLifecycle({ paths, repoRoot, env: archiveEnv });
  check('实际归档读取接受诊断 stderr 并验证生成物与运行时', s.preset.generatedDrift.status === 'current'
    && s.compatibility.runtime.status === 'known' && s.compatibility.runtime.version === stubRuntime);

  section('角色文件与精确版本豁免');
  check('角色文件 missing', collect().roles.verdict === 'missing');
  mkdirSync(join(paths.roles, '..'), { recursive: true });
  put(paths.roles, { formatVersion: CONFIG_FORMAT_VERSION, roles: [{ id: 'worker' }], volatile: { wrapperProvider: 'fixture' } });
  s = collect();
  check('角色文件 current、计数及 wrapper', s.roles.verdict === 'current' && s.roles.count === 1 && s.roles.wrapperPresent);
  put(paths.roles, { roles: [] });
  check('旧格式 distinct migrated 且 verify 失败', collect().roles.verdict === 'migrated' && invoke('verify').exitCode === 1);
  put(paths.roles, { formatVersion: CONFIG_FORMAT_VERSION, roles: [] });
  put(compatibilityFile, {});
  s = collect();
  check('stub 运行时流入 absent 判据', s.compatibility.runtime.status === 'known'
    && s.compatibility.runtime.version === stubRuntime && s.compatibility.exemption === 'absent'
    && !s.compatibility.exemptionPresent && s.compatibility.runtimeExempt === false);
  const key = `${pkg.name}@${pkg.version}`;
  put(compatibilityFile, { [key]: [stubRuntime] }); s = collect();
  check('stub 运行时流入 exempt 判据并命中', s.compatibility.runtime.status === 'known'
    && s.compatibility.runtime.version === stubRuntime && s.compatibility.exemption === 'exempt'
    && s.compatibility.exemptionPresent && s.compatibility.runtimeExempt === true);
  put(compatibilityFile, { [`${pkg.name}@0.0.0`]: [stubRuntime] }); s = collect();
  check('stub 运行时已知但旧版本豁免仍是 expired', s.compatibility.runtime.status === 'known'
    && s.compatibility.runtime.version === stubRuntime && s.compatibility.exemption === 'expired'
    && s.compatibility.runtimeExempt === false && s.verification.issues.some(i => i.code === 'compatibility.expired'));
  put(compatibilityFile, { [key]: ['different-runtime'] });
  check('当前运行时不在豁免数组明确失败', collect().compatibility.runtimeExempt === false && invoke('verify').exitCode === 1);
  put(compatibilityFile, { [key]: [stubRuntime] });
  check('desktop basename 分类', collect().profile.kind === 'desktop');
  check('Desktop 大小写不改变 desktop 分类', collectLifecycle({ ...options,
    paths: { ...paths, profile: join(temp, 'Desktop') } }).profile.kind === 'desktop');
  check('其他 basename 分类 cli-managed', collectLifecycle({ ...options, paths: { ...paths, profile: join(temp, 'server') } }).profile.kind === 'cli-managed');
  check('模块变化完整重启是固定事实', collect().restart.requiredForModuleChange === true);
  check('完全一致 fixture verify 退出 0', invoke('verify').exitCode === 0 && collect().verification.status === 'consistent');

  section('真实 gate 镜像：stub 来源、engines.dsh 优先级与豁免校验');
  check('fixture 运行时版本来自仓库唯一精确 dsh peer pin', dshPeerPins.length === 1 && isExactDshVersion(dshPeerPins[0])
    && stubRuntime === dshPeerPins[0], JSON.stringify(dshPeerPins));
  put(compatibilityFile, {});
  // engines.dsh 存在时 peers 被完全忽略：这是真实 gate unmetRequirements 的第一个分支。
  put(join(repoRoot, 'package.json'), { ...pkg, engines: { dsh: stubRuntime },
    peerDependencies: { ...pkg.peerDependencies, '@deepseek-ai/dsh-tools': '0.0.0' } });
  s = collect();
  check('engines.dsh 满足时忽略不兼容 peers 并判 consistent', s.repo.enginesDsh === stubRuntime
    && s.compatibility.peers.source === 'engines.dsh' && s.compatibility.peers.ranges.length === 1
    && s.compatibility.peers.ranges[0].name === 'engines.dsh' && s.compatibility.peers.status === 'compatible'
    && s.verification.status === 'consistent' && invoke('verify').exitCode === 0);
  put(join(repoRoot, 'package.json'), { ...pkg, engines: { dsh: '0.0.0' } });
  s = collect();
  check('engines.dsh 不满足时忽略兼容 peers 并判 incompatible', s.compatibility.peers.source === 'engines.dsh'
    && s.compatibility.peers.status === 'incompatible' && /^engines\.dsh: /.test(s.compatibility.peers.reason)
    && s.verification.issues.some(i => i.code === 'compatibility.peers') && invoke('verify').exitCode === 1);
  put(join(repoRoot, 'package.json'), { ...pkg, engines: {} });
  s = collect();
  check('engines 无 dsh 键时回退 peers', s.repo.enginesDsh === null
    && s.compatibility.peers.source === 'peerDependencies' && s.compatibility.peers.status === 'compatible');
  put(join(repoRoot, 'package.json'), { ...pkg, engines: { dsh: 1 } });
  check('畸形 engines.dsh 不猜测判定', collect().compatibility.peers.status === 'unknown'
    && /engines\.dsh/.test(collect().compatibility.peers.reason));
  put(join(repoRoot, 'package.json'), { ...pkg, engines: [] });
  check('非对象 engines 不猜测判定', collect().compatibility.peers.status === 'unknown');
  put(join(repoRoot, 'package.json'), { ...pkg, peerDependencies: { ...pkg.peerDependencies, '@deepseek-ai/dsh-tools': 'workspace:^' } });
  s = collect();
  check('workspace:^ peer 视为当前运行时', s.compatibility.peers.status === 'compatible'
    && s.compatibility.peers.ranges.find(row => row.name === '@deepseek-ai/dsh-tools')?.status === 'compatible');
  put(join(repoRoot, 'package.json'), { ...pkg, peerDependencies: { ...pkg.peerDependencies,
    '@deepseek-ai/dsh-tools': 'workspace:*', '@deepseek-ai/dsh-scope': 'workspace:~' } });
  check('workspace:* 与 workspace:~ peer 同样满足', collect().compatibility.peers.status === 'compatible');
  put(join(repoRoot, 'package.json'), pkg);
  check('engines.dsh 中的 workspace: 协议值一律不满足', evaluateDshRequirements(stubRuntime, { engines: { dsh: 'workspace:^' } }).status === 'incompatible');
  for (const invalid of [['0.2.*'], ['0.2.*', stubRuntime], ['v0.2.1'], [` ${stubRuntime}`], stubRuntime, [1], [stubRuntime, null]]) {
    put(compatibilityFile, { [key]: invalid });
    s = collect();
    check(`非法豁免值 ${JSON.stringify(invalid)} 不被 DSH 接受`, s.compatibility.exemption === 'invalid'
      && s.compatibility.exemptionPresent && s.compatibility.runtimeExempt === false
      && s.verification.issues.some(i => i.code === 'compatibility.exemption') && invoke('verify').exitCode === 1);
  }
  put(compatibilityFile, { [key]: [] });
  check('空豁免列表合法但不豁免任何运行时', collect().compatibility.exemption === 'exempt'
    && collect().compatibility.runtimeExempt === false && invoke('verify').exitCode === 1);
  put(compatibilityFile, { [key]: [stubRuntime] });
  s = collect();
  check('精确规范 SemVer 豁免仍被接受并命中', s.compatibility.exemption === 'exempt' && s.compatibility.runtimeExempt === true
    && invoke('verify').exitCode === 0);
  check('非法豁免键不会被 DSH 接受', isExactDshExemptionKey(key) && !isExactDshExemptionKey(`${pkg.name}@^${pkg.version}`)
    && !isExactDshExemptionKey(pkg.name));

  section('命令行、零写入及实际输出');
  const cli = command => captureSync(process.execPath, [script, command, '--home', home, '--json'], { env, cwd: REPO_ROOT });
  invoke('status'); invoke('verify');
  // 真实 CLI 的仓库根是 REPO_ROOT，而上面 collect() 的 repoRoot 是 temp fixture；
  // 安装源检查要求 link: 指向运行工具的那个仓库，所以 CLI 段临时改指向 REPO_ROOT。
  const setProfileSpec = spec => put(profilePackage, { dependencies: { [pkg.name]: spec },
    dsh: { profile: { bundles: [pkg.name] } } });
  setProfileSpec(`link:${REPO_ROOT}`);
  const before = fingerprint(temp);
  const status = cli('status'), verify = cli('verify');
  // CLI fixture 故意让归档不可读：status 仍应 0，但 verify 必须把 unknown 判为 unverified 而非假绿。
  check('status / verify CLI 单份 JSON；无归档时 verify 为 unverified 且退出 1', status.status === 0 && verify.status === 1
    && JSON.parse(status.stdout).paths.sources.home === '--home'
    && JSON.parse(verify.stdout).verification.status === 'unverified'
    && JSON.parse(verify.stdout).verification.unverified.length === 4, status.stderr + verify.stderr);
  const allowedUnknown = captureSync(process.execPath, [script, 'verify', '--home', home, '--json', '--allow-unknown'], { env, cwd: REPO_ROOT });
  check('verify --allow-unknown 显式接受未知判据并退出 0', allowedUnknown.status === 0
    && JSON.parse(allowedUnknown.stdout).verification.status === 'unverified', allowedUnknown.stderr);
  check('零写入：所有 fixture 文件 mtimeMs 与 size 及文件集合不变', fingerprint(temp) === before);
  put(paths.patch, cleanPatch + generated);
  const drift = cli('verify');
  check('真实 CLI 漂移退出 1 且给出精确原因', drift.status === 1
    && JSON.parse(drift.stdout).verification.issues.some(i => i.code === 'preset.injectedInProfile'
      && /剥离/.test(i.reason)));
  put(paths.patch, cleanPatch);
  const missing = captureSync(process.execPath, [script, 'verify', '--profile', join(temp, 'absent-profile')], { env });
  check('CLI 显式缺 profile 失败', missing.status === 1 && /显式目标缺少 profile package.json/.test(missing.stdout));
  const shim = `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module';
    delete process.env.DSH_HOME; os.homedir = () => ${JSON.stringify(join(temp, 'absent-user'))}; syncBuiltinESMExports();
    const { runLifecycle } = await import(${JSON.stringify(pathToFileURL(script).href)});
    process.exitCode = runLifecycle({ argv: ['verify'] }).exitCode;`;
  const skipped = captureSync(process.execPath, ['--input-type=module', '--eval', shim], { env });
  check('默认缺 profile CLI 退出 0 干净跳过', skipped.status === 0 && /跳过/.test(skipped.stdout));
  const environmental = captureSync(process.execPath, [script, 'verify'], { env: { ...env, DSH_HOME: join(temp, 'absent-home') } });
  check('DSH_HOME 显式缺 profile CLI 退出 1', environmental.status === 1 && /显式目标缺少/.test(environmental.stdout));
  setProfileSpec(`link:${repoRoot}`);
  section('有界 DSH peer 范围');
  for (const [version, range, expected] of [
    ['0.2.0-rc.2', '0.2.0-rc.2', 'compatible'], ['0.2.0-rc.3', '0.2.0-rc.2', 'incompatible'],
    ['0.2.9', '~0.2.0', 'compatible'], ['0.2.9-rc.1', '~0.2.0', 'compatible'],
    ['0.2.0-rc.2', '~0.2.0', 'incompatible'], ['0.3.0-rc.1', '~0.2.0', 'incompatible'],
    ['1.9.0', '^1.2.0', 'compatible'], ['2.0.0-rc.1', '^1.2.0', 'incompatible'],
    ['0.2.9', '^0.2.0', 'compatible'], ['0.3.0', '^0.2.0', 'incompatible'],
    ['0.0.2', '^0.0.1', 'incompatible'], ['0.0.1', '^0.0.1', 'compatible'],
    ['0.2.0-rc.3', '^0.2.0-rc.2', 'compatible'], ['0.2.0+build', '0.2.0', 'compatible'],
    ['1.0.0', '>=1.0.0 || <2.0.0', 'unknown'], ['bad', '~0.2.0', 'unknown'],
    // 真实 gate `satisfies` 先 trim 再判定：trim 后为空必定 unmet；周围空白不影响合法范围。
    ['0.2.1-rc.1', '', 'incompatible'], ['0.2.1-rc.1', '   ', 'incompatible'],
    ['0.2.1-rc.1', ' 0.2.1-rc.1 ', 'compatible'], ['0.2.1-rc.1', ' ~0.4.0 ', 'incompatible'],
    // workspace: 由 evaluateDshRequirements 按真实 gate 分支解释，范围层保持 unknown（不猜测）。
    ['0.2.1-rc.1', 'workspace:^', 'unknown'],
  ]) check(`${version} / ${range} → ${expected}`, satisfiesDshRange(version, range).status === expected);
  check('未支持范围明确报告 unsupported-range', satisfiesDshRange('1.0.0', '>=1.0.0 || <2.0.0').reason === 'unsupported-range');
  check('空范围有明确原因且不接受', satisfiesDshRange('1.0.0', '  ').accepts === undefined && satisfiesDshRange('1.0.0', '  ').status === 'incompatible');
  check('仅镜像 DSH gate 包名范围', evaluateDshPeers('0.2.0', { '@deepseek-ai/dshx': 'bad', '@deepseek-ai/cordis': 'bad', '@deepseek-ai/dsh': '~0.2.0' }).status === 'compatible');
  check('peers 之外的非 dsh 包名不参与判定', evaluateDshPeers('0.2.0', { '@deepseek-ai/cordis': 'bad', '@deepseek-ai/schemastery': 'bad' }).status === 'compatible');
  check('engines.dsh 满足时 peers 完全忽略', evaluateDshRequirements('0.2.1-rc.1',
    { engines: { dsh: '0.2.1-rc.1' }, peerDependencies: { '@deepseek-ai/dsh-tools': '0.0.0', '@deepseek-ai/dsh': '^9.0.0' } }).status === 'compatible');
  check('畸形 engines/peerDependencies/范围不猜测判定', evaluateDshRequirements('0.2.1-rc.1', { engines: null }).status === 'unknown'
    && evaluateDshRequirements('0.2.1-rc.1', { peerDependencies: [] }).status === 'unknown'
    && evaluateDshRequirements('0.2.1-rc.1', { peerDependencies: { '@deepseek-ai/dsh-tools': 1 } }).status === 'unknown');
  check('workspace:^/~/* peer 视为当前运行时', ['workspace:^', 'workspace:~', 'workspace:*']
    .every(range => evaluateDshRequirements('0.2.1-rc.1', { peerDependencies: { '@deepseek-ai/dsh-tools': range } }).status === 'compatible'));
  for (const [value, expected] of [['0.2.1-rc.1', true], ['0.2.1', true], ['0.2.0+build', true], ['0.2.*', false],
    ['v0.2.1', false], [' 0.2.1', false], ['0.2.1 ', false], ['=0.2.1', false], ['^0.2.1', false], ['', false], [1, false]])
    check(`精确规范 SemVer ${JSON.stringify(value)} → ${expected}`, isExactDshVersion(value) === expected);
  check('豁免版本列表要求全部为精确规范 SemVer', isExactDshVersionList(['0.2.1-rc.1', '1.0.0'])
    && !isExactDshVersionList(['0.2.*']) && !isExactDshVersionList(['0.2.1', '0.2.*']) && !isExactDshVersionList('0.2.1')
    && isExactDshVersionList([]));
  check('豁免键要求精确 package@version', isExactDshExemptionKey('@magicvr/dsh-agent-switchboard@0.2.1-rc.1')
    && isExactDshExemptionKey('dsh@0.2.1') && !isExactDshExemptionKey('dsh@^0.2.1') && !isExactDshExemptionKey('dsh@0.2.1 ')
    && !isExactDshExemptionKey('dsh') && !isExactDshExemptionKey('@Bad/pkg@0.2.1'));

  section('B4 合成 profile 收敛与安全屏障');
  let fixtureNumber = 0;
  const rich = JSON.stringify({ formatVersion: 1, roles: [{ id: 'user', instructions: 'keep', custom: { rich: true } }],
    wrapperProvider: 'keep', extra: { nested: [1, 2, 3] } }, null, 4) + '\n';
  function fixture({ kind = 'desktop', registration = 'complete', patch = cleanPatch + generated, roles = rich } = {}) {
    const fixtureHome = join(temp, `b4-${++fixtureNumber}`);
    const p = { ...resolvePaths({ argv: ['--home', fixtureHome, '--profile', join(fixtureHome, 'profiles', kind)], env: {} }), repoRoot };
    mkdirSync(p.profile, { recursive: true });
    put(join(p.profile, 'package.json'), registration === 'none' ? {} : {
      dependencies: { [pkg.name]: `link:${repoRoot}` }, dsh: { profile: { bundles: registration === 'complete' ? [pkg.name] : [] } } });
    if (registration !== 'none') {
      mkdirSync(join(p.profile, 'node_modules', pkg.name), { recursive: true });
      put(join(p.profile, 'node_modules', pkg.name, 'package.json'), pkg);
    }
    put(p.patch, patch);
    if (roles !== null) { mkdirSync(join(p.roles, '..'), { recursive: true }); put(p.roles, roles); }
    const run = (command, args = [], extra = {}) => {
      const logs = [];
      const result = runLifecycle({ argv: [command, ...args], paths: p,
        collectOptions: { repoRoot, readArchive: archive }, log: line => logs.push(line), ...extra });
      return { ...result, output: logs.join('\n') };
    };
    return { p, home: fixtureHome, run };
  }
  function bytesTree(root) {
    const values = {};
    function visit(dir) { for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) visit(file); else values[file] = readFileSync(file).toString('base64');
    } }
    visit(root); return JSON.stringify(values);
  }
  section('并发与卸载引用回归');
  const dangling = fixture({ patch: rootReference + generated });
  const danglingResult = dangling.run('uninstall', ['--apply']);
  check('双引用卸载拒绝移包指令且保留用户根条目', danglingResult.exitCode === 1
    && danglingResult.output.includes(`${dangling.p.patch}:3 id=agent-switchboard`)
    && /profile \/ home 配置中仍有包引用/.test(danglingResult.output) && /刻意不删除用户编写的内容/.test(danglingResult.output)
    && /请自行解决或移除下列条目后重新运行/.test(danglingResult.output)
    && /悬空引用/.test(danglingResult.output) && !/人工包移除步骤/.test(danglingResult.output)
    && readFileSync(dangling.p.patch, 'utf8').includes(rootReference) && !readPatch(dangling.p.patch).entries.some(row => row.id === 'preset-switchboard'), danglingResult.output);
  console.log(`  双引用卸载 exit=${danglingResult.exitCode}\n${danglingResult.events.join('\n')}`);
  const danglingPurge = fixture({ registration: 'none', patch: rootReference + generated });
  const danglingRoles = readFileSync(danglingPurge.p.roles);
  const danglingPurgeResult = danglingPurge.run('uninstall', ['--apply', '--purge-roles']);
  check('profile 残留引用拒绝 purge 和移包，角色及用户条目字节保留', danglingPurgeResult.exitCode === 1
    && danglingPurgeResult.output.includes(`${danglingPurge.p.patch}:3 id=agent-switchboard`)
    && /拒绝移除指令及 --purge-roles/.test(danglingPurgeResult.output)
    && /请自行解决或移除下列条目后重新运行/.test(danglingPurgeResult.output)
    && !/人工包移除步骤/.test(danglingPurgeResult.output) && danglingRoles.equals(readFileSync(danglingPurge.p.roles))
    && readFileSync(danglingPurge.p.patch, 'utf8') === stripInjectedPreset(rootReference + generated), danglingPurgeResult.output);
  put(join(repoRoot, 'cordis.patch.yml'), rootReference);
  const reachable = fixture();
  const reachableRoles = readFileSync(reachable.p.roles);
  const reachableResult = reachable.run('uninstall', ['--apply']);
  check('仅注入 preset 引用的 uninstall 可达 exit=3，包内 bundle 自引用不阻塞', reachableResult.exitCode === 3
    && /PASS  preset 剥离后复读验证/.test(reachableResult.output) && /人工包移除步骤/.test(reachableResult.output)
    && scanPackageReferences(readFileSync(reachable.p.patch, 'utf8'), pkg.name).length === 0
    && reachableRoles.equals(readFileSync(reachable.p.roles))
    && readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8') === rootReference, reachableResult.output);
  console.log(`  uninstall 可达 exit=${reachableResult.exitCode}\n${reachableResult.events.join('\n')}`);
  put(join(repoRoot, 'cordis.patch.yml'), '[]\n');
  for (const purge of [false, true]) {
    const f = fixture({ registration: purge ? 'none' : 'complete' });
    const profileConfig = join(f.p.profile, 'cordis.yml');
    put(profileConfig, `plugins:\n  - id: profile-switchboard\n    name: ${JSON.stringify(pkg.name)}\n`);
    const rolesBefore = readFileSync(f.p.roles);
    const r = f.run('uninstall', ['--apply', ...(purge ? ['--purge-roles'] : [])]);
    check(`profile cordis.yml 残留引用拒绝${purge ? ' purge' : '移包'}且保留用户内容`, r.exitCode === 1
      && r.output.includes(`${profileConfig}:3 id=profile-switchboard`)
      && /请自行解决或移除下列条目后重新运行/.test(r.output) && !/人工包移除步骤/.test(r.output)
      && scanPackageReferences(readFileSync(profileConfig, 'utf8'), pkg.name).length === 1
      && rolesBefore.equals(readFileSync(f.p.roles)), r.output);
  }
  const cleanConfig = fixture();
  put(join(cleanConfig.p.profile, 'cordis.yml'), 'plugins: []\n');
  check('存在无包引用的 profile cordis.yml 仍允许人工移包', cleanConfig.run('uninstall', ['--apply']).exitCode === 3);
  for (const command of ['install', 'upgrade', 'uninstall']) {
    const f = fixture({ patch: cleanPatch + generated });
    const changed = readFileSync(f.p.patch, 'utf8') + '# 并发编辑\n';
    let edited = false;
    const r = f.run(command, ['--apply'], { log: line => {
      if (!edited && line.startsWith('apply：')) { edited = true; put(f.p.patch, changed); }
    } });
    check(`${command} 规划到写入并发改变拒绝、无备份且保留并发字节`, r.exitCode === 1
      && r.events.some(line => /规划后已改变.*重新运行/.test(line)) && readFileSync(f.p.patch, 'utf8') === changed
      && !readdirSync(f.p.profile).some(name => name.includes('.bak-lifecycle-')), r.events.join('\n'));
  }
  for (const mode of ['dependencies', 'bundles', 'unreadable']) {
    const f = fixture({ registration: 'none' });
    const beforeRoles = readFileSync(f.p.roles);
    const r = f.run('uninstall', ['--apply', '--purge-roles'], { log: line => {
      if (line.startsWith('备份：') && line.includes('roles.json')) {
        put(join(f.p.profile, 'package.json'), mode === 'unreadable' ? '{invalid' : mode === 'dependencies'
          ? { dependencies: { [pkg.name]: '*' } } : { dsh: { profile: { bundles: [pkg.name] } } });
      }
    } });
    check(`purge 前 ${mode} 登记变化拒绝且数据保留`, r.exitCode === 1 && beforeRoles.equals(readFileSync(f.p.roles)), r.events.join('\n'));
  }
  for (const mode of ['seed', 'migrate']) {
    const f = fixture({ roles: mode === 'seed' ? null : { roles: [], user: true } });
    const concurrentRoles = JSON.stringify({ formatVersion: 1, roles: [], concurrent: true });
    const r = f.run('install', ['--apply'], { log: line => {
      if (line.startsWith('apply：')) {
        mkdirSync(join(f.p.roles, '..'), { recursive: true }); put(f.p.roles, concurrentRoles);
      }
    } });
    check(`${mode} 角色规划快照变化拒绝且保留并发内容`, r.exitCode === 1
      && readFileSync(f.p.roles, 'utf8') === concurrentRoles && r.events.some(line => /规划后已改变/.test(line)), r.events.join('\n'));
  }
  section('生成物再生成屏障（真实生成器，仅 tmpdir）');
  const regenerationRepo = join(temp, 'regeneration-repo');
  mkdirSync(join(regenerationRepo, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(regenerationRepo, 'presets'), { recursive: true });
  put(join(regenerationRepo, 'package.json'), pkg);
  put(join(regenerationRepo, 'cordis.patch.yml'), '[]\n');
  put(join(regenerationRepo, 'presets', 'standard-plugins.json'), rowsBody);
  for (const name of ['gen-preset.mjs', 'dsh-cat.mjs', 'lib/paths.mjs', 'lib/capture.mjs', 'lib/preset-generator.mjs'])
    cpSync(join(REPO_ROOT, 'scripts', name), join(regenerationRepo, 'scripts', name));
  cpSync(join(REPO_ROOT, 'src'), join(regenerationRepo, 'src'), { recursive: true });
  cpSync(join(REPO_ROOT, 'node_modules', 'yaml'), join(regenerationRepo, 'node_modules', 'yaml'), { recursive: true });
  const regenerationFile = join(regenerationRepo, 'presets', 'switchboard.patch.yml');
  const staleGenerated = generated.replace('主代理调度规则', '旧主代理调度规则');
  const regenerationOptions = { repoRoot: regenerationRepo, readArchive: archive };
  const regenerationFixture = () => {
    const f = fixture({ patch: cleanPatch + staleGenerated });
    f.p.repoRoot = regenerationRepo;
    put(join(f.p.profile, 'package.json'), { dependencies: { [pkg.name]: `link:${regenerationRepo}` },
      dsh: { profile: { bundles: [pkg.name] } } });
    put(regenerationFile, staleGenerated);
    const run = (command, args = [], extra = {}) => f.run(command, args,
      { env: archiveEnv, collectOptions: regenerationOptions, ...extra });
    return { ...f, run };
  };
  for (const command of ['install', 'upgrade']) {
    const f = regenerationFixture(), before = fingerprint(temp);
    const status = f.run('status');
    check(`${command} 漂移 status 只报告且全树零写入`, status.exitCode === 0 && fingerprint(temp) === before
      && /仓库生成物：drifted/.test(status.output));
    const dry = f.run(command);
    check(`${command} 再生成 dry-run 待 --apply，全树零写入`, dry.exitCode === 1 && fingerprint(temp) === before
      && /再生成待 --apply/.test(dry.output), dry.output);
    const applied = f.run(command, ['--apply']);
    check(`${command} 真实生成器再生成并复读 current`, applied.exitCode === 0
      && readFileSync(regenerationFile, 'utf8') === generated
      && /已写入/.test(applied.output) && /PASS  preset 再生成后复读验证/.test(applied.output), applied.output);
    check(`${command} 再生成后重新收敛并写后验证`, applied.snapshot.preset.rules.status === 'current'
      && !readFileSync(f.p.patch, 'utf8').includes('旧主代理调度规则') && /PASS  写后复读验证/.test(applied.output), applied.output);
    const secondBefore = fingerprint(temp), second = f.run(command, ['--apply']);
    check(`${command} 再生成后第二次 no-op`, second.exitCode === 0 && fingerprint(temp) === secondBefore
      && !/再生成：/.test(second.output), second.output);
    console.log(`  ${command} 证据 dry=${dry.exitCode}, apply=${applied.exitCode}, second=${second.exitCode}\n${applied.events.join('\n')}`);
  }
  const failureFixture = regenerationFixture(), failureBefore = bytesTree(failureFixture.home);
  const fixtureCat = join(regenerationRepo, 'scripts', 'dsh-cat.mjs'), catOriginal = readFileSync(fixtureCat);
  put(fixtureCat, "console.error('fixture archive read failure'); process.exit(7);\n");
  const generationFailure = failureFixture.run('upgrade', ['--apply']);
  check('生成器非零失败 exit=1 保留真实原因，不注入、不改 profile', generationFailure.exitCode === 1
    && /退出码 1/.test(generationFailure.output) && /fixture archive read failure/.test(generationFailure.output)
    && bytesTree(failureFixture.home) === failureBefore && readFileSync(regenerationFile, 'utf8') === staleGenerated,
  generationFailure.output);
  console.log(`  生成器失败证据 exit=${generationFailure.exitCode}\n${generationFailure.events.join('\n')}`);
  writeFileSync(fixtureCat, catOriginal);
  const generatorFile = join(regenerationRepo, 'scripts', 'gen-preset.mjs'), generatorOriginal = readFileSync(generatorFile);
  const concurrentGeneration = regenerationFixture();
  const concurrentPatch = readFileSync(concurrentGeneration.p.patch, 'utf8') + '# 再生成期间并发编辑\n';
  put(generatorFile, `import { writeFileSync as concurrentWrite } from 'node:fs';\nconcurrentWrite(${JSON.stringify(concurrentGeneration.p.patch)}, ${JSON.stringify(concurrentPatch)});\n` + generatorOriginal.toString('utf8'));
  const concurrentResult = concurrentGeneration.run('upgrade', ['--apply']);
  check('再生成窗口内 profile 改变拒绝覆盖', concurrentResult.exitCode === 1
    && /规划后已改变/.test(concurrentResult.output) && readFileSync(concurrentGeneration.p.patch, 'utf8') === concurrentPatch, concurrentResult.output);
  writeFileSync(generatorFile, generatorOriginal);
  put(regenerationFile, staleGenerated);
  const generatedRace = regenerationFixture();
  const externalGenerated = staleGenerated + '# 用户并发生成物编辑\n';
  const generatedRaceResult = generatedRace.run('upgrade', ['--apply'], { log: line => {
    if (line.startsWith('再生成：')) put(regenerationFile, externalGenerated);
  } });
  check('生成器启动前规划快照不同拒绝、保留并发生成物', generatedRaceResult.exitCode === 1
    && generatedRaceResult.events.some(line => /规划后已改变/.test(line))
    && readFileSync(regenerationFile, 'utf8') === externalGenerated, generatedRaceResult.events.join('\n'));
  const generatorRenameRace = regenerationFixture();
  put(generatorFile, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const originalWrite = fs.writeFileSync;
fs.writeFileSync = (...args) => {
  const result = originalWrite(...args);
  if (String(args[0]).endsWith('.tmp')) originalWrite('presets/switchboard.patch.yml', ${JSON.stringify(externalGenerated)});
  return result;
}; syncBuiltinESMExports();\n` + generatorOriginal.toString('utf8'));
  const generatorRenameResult = generatorRenameRace.run('upgrade', ['--apply']);
  check('生成器 rename 前并发改变拒绝、保留生成物并清理 temp', generatorRenameResult.exitCode === 1
    && /规划后已改变/.test(generatorRenameResult.output) && readFileSync(regenerationFile, 'utf8') === externalGenerated
    && !readdirSync(join(regenerationRepo, 'presets')).some(name => name.endsWith('.tmp')), generatorRenameResult.output);
  writeFileSync(generatorFile, generatorOriginal);
  put(regenerationFile, staleGenerated);
  put(generatorFile, "console.log('fixture pretend success');\n");
  const skippedGeneration = failureFixture.run('upgrade', ['--apply']);
  check('生成器假成功未写文件必须被复读屏障拒绝，不注入', skippedGeneration.exitCode === 1
    && /再生成后复读验证失败：文件字节未改变/.test(skippedGeneration.output)
    && bytesTree(failureFixture.home) === failureBefore, skippedGeneration.output);
  writeFileSync(generatorFile, generatorOriginal);
  const wrongFile = regenerationFixture(), wrongBefore = bytesTree(wrongFile.home);
  put(generatorFile, "import { appendFileSync } from 'node:fs'; appendFileSync('presets/switchboard.patch.yml', '\\n');\n");
  const wrongGeneration = wrongFile.run('upgrade', ['--apply']);
  check('生成器改变字节但未达到 current 必须拒绝，不注入', wrongGeneration.exitCode === 1
    && /再生成后复读验证失败/.test(wrongGeneration.output) && bytesTree(wrongFile.home) === wrongBefore, wrongGeneration.output);
  writeFileSync(generatorFile, generatorOriginal);
  for (const readArchive of [null, () => { throw new Error('fixture unavailable'); }]) {
    const f = regenerationFixture(), beforeRepo = fingerprint(regenerationRepo);
    put(f.p.patch, cleanPatch + generated);
    const degraded = f.run('upgrade', ['--apply'], { collectOptions: { repoRoot: regenerationRepo, readArchive } });
    check('归档不可用明确未验证与手工回退，继续同步已知制品', degraded.exitCode === 0
      && /漂移未验证/.test(degraded.output) && /npm run gen:preset/.test(degraded.output)
      && degraded.snapshot.preset.generatedDrift.status === 'unknown' && fingerprint(regenerationRepo) === beforeRepo
      && /PASS  写后复读验证/.test(degraded.output), degraded.output);
  }
  section('帮助入口');
  const lifecycleHelp = captureSync(process.execPath, [script, '--help'], { env });
  const versionHelp = captureSync(process.execPath, [join(REPO_ROOT, 'scripts', 'ops', 'plugin-version.mjs'), '--help'], { env });
  check('lifecycle --help 五个命令、全部参数、dry-run 和完整退出码', lifecycleHelp.status === 0
    && ['status', 'verify', 'install', 'upgrade', 'uninstall', '--apply', '--purge-roles', '--json',
      '--runtime-version', '--allow-unknown', '--home', '--profile', '--patch', '--roles-file', '--cwd',
      '没有 --dry-run', '0 =', '1 =', '3 =']
      .every(token => lifecycleHelp.stdout.includes(token)), lifecycleHelp.stdout + lifecycleHelp.stderr);
  check('version --help 命令、参数、互斥与无备份/commit/tag', versionHelp.status === 0
    && ['show', 'bump', 'major|minor|patch|X.Y.Z', '--pre <tag>', '--finalize', '--apply', '互斥', '显式版本', '.bak', 'commit', 'tag']
      .every(token => versionHelp.stdout.includes(token)), versionHelp.stdout + versionHelp.stderr);
  for (const kind of ['desktop', 'server']) for (const registration of ['none', 'trap']) {
    const f = fixture({ kind, registration, roles: null, patch: cleanPatch });
    const before = fingerprint(f.home);
    for (const command of ['install', 'upgrade']) {
      const r = f.run(command, ['--apply']);
      check(`${kind} ${registration} ${command} 人工步骤 exit=3 且零写入`, r.exitCode === 3 && fingerprint(f.home) === before
        && (kind === 'desktop' ? /Plugins 页面 → 添加插件 → 粘贴 link:.* → 安装 → 立即启用/.test(r.output)
          : /dsh plugin --profile 'server' add 'link:/.test(r.output))
        && (registration !== 'trap' || /静默不加载陷阱/.test(r.output)), r.output);
      console.log(`  人工证据 ${kind}/${registration}/${command} exit=${r.exitCode}：${r.events.join('；')}`);
    }
  }
  for (const command of ['install', 'upgrade', 'uninstall']) {
    // 起点都带「历史上内联进 profile 的 preset 副本」：现在 install/upgrade/uninstall 的
    // 写盘动作就是**剥离**它，所以这样才有真实的写入可验证。
    const f = fixture({ patch: cleanPatch + generated, roles: command === 'install' ? null : rich });
    const before = fingerprint(f.home), patchBefore = readFileSync(f.p.patch), rolesBefore = fs.existsSync(f.p.roles) ? readFileSync(f.p.roles) : null;
    const dry = f.run(command);
    check(`${command} dry-run 全树 mtime+size 零写入`, fingerprint(f.home) === before, dry.output);
    const applied = f.run(command, ['--apply']);
    const patchAfter = readFileSync(f.p.patch);
    const backups = readdirSync(f.p.profile).filter(name => name.includes('.bak-lifecycle-'));
    check(`${command} --apply 备份及写后验证`, backups.length === 1
      && readFileSync(join(f.p.profile, backups[0])).equals(patchBefore)
      && /PASS  写后复读验证/.test(applied.output) && applied.exitCode === (command === 'uninstall' ? 3 : 0), applied.output);
    check(`${command} 后 profile 里不再有内联 preset 副本`,
      !readPatch(f.p.patch).entries.some(row => row.id === 'preset-switchboard'), applied.output);
    if (command === 'uninstall') {
      check('卸载必须先剥离并复读验证，再输出包移除步骤', applied.output.indexOf('PASS  preset 剥离后复读验证') >= 0
        && applied.output.indexOf('PASS  preset 剥离后复读验证') < applied.output.indexOf('人工包移除步骤：') && applied.exitCode === 3, applied.output);
      check('卸载 dry-run 未剥离前不输出包移除指令', dry.exitCode === 1 && !dry.output.includes('人工包移除步骤：'));
    } else {
      const beforeSecond = fingerprint(f.home);
      const second = f.run(command, ['--apply']);
      check(`${command} 幂等第二次零写入且 consistent`, second.exitCode === 0 && fingerprint(f.home) === beforeSecond
        && readFileSync(f.p.patch).equals(patchAfter) && /制品已同步/.test(second.output), second.output);
    }
    if (rolesBefore) check(`${command} 丰富用户 roles 字节保留`, rolesBefore.equals(readFileSync(f.p.roles)));
    else check('缺失 roles 播种当前格式且存在备份记录', JSON.parse(readFileSync(f.p.roles)).formatVersion === 1
      && readdirSync(join(f.p.roles, '..')).some(name => name.includes('.bak-lifecycle-')));
    console.log(`  ${command} dry-run exit=${dry.exitCode}；apply exit=${applied.exitCode}；patch bytes ${patchBefore.length} → ${patchAfter.length}；backup=${backups.join(', ')}\n${applied.events.join('\n')}`);
  }
  for (const command of ['install', 'upgrade']) {
    // 「已一致」= profile 里没有残留副本（清理后的稳态）→ 不应有任何写入。
    const f = fixture({ patch: cleanPatch });
    const before = fingerprint(f.home), result = f.run(command, ['--apply']);
    check(`${command} 已一致 profile 不写盘`, result.exitCode === 0 && fingerprint(f.home) === before, result.output);
    const stale = fixture({ roles: { roles: [{ id: 'user' }], rich: { keep: true } } });
    const staleBefore = fingerprint(stale.home), originalRoles = readFileSync(stale.p.roles);
    const dry = stale.run(command);
    check(`${command} 旧格式 dry-run 不写盘且报告迁移`, fingerprint(stale.home) === staleBefore && /未写盘：roles 格式迁移/.test(dry.output));
    const apply = stale.run(command, ['--apply']);
    const backup = readdirSync(dirnameFor(stale.p.roles)).find(name => name.includes('.bak-migrate-format-'));
    check(`${command} 旧格式迁移备份及验证`, apply.exitCode === 0 && backup
      && originalRoles.equals(readFileSync(join(dirnameFor(stale.p.roles), backup)))
      && JSON.parse(readFileSync(stale.p.roles)).rich.keep && /迁移后复读验证/.test(apply.output), apply.output);
  }
  function dirnameFor(path) { return join(path, '..'); }
  const stillRegistered = fixture();
  const purgeBefore = fingerprint(stillRegistered.home), refused = stillRegistered.run('uninstall', ['--apply', '--purge-roles']);
  check('包仍登记时 --purge-roles 拒绝且零写入', refused.exitCode === 1 && /--purge-roles 被拒绝/.test(refused.output) && fingerprint(stillRegistered.home) === purgeBefore);
  console.log(`  purge refusal exit=${refused.exitCode}：${refused.events.join('；')}`);
  const removed = fixture({ registration: 'none', patch: cleanPatch });
  const removedBefore = fingerprint(removed.home), purgeDry = removed.run('uninstall', ['--purge-roles']);
  check('包已移除 purge dry-run 零写入', purgeDry.exitCode === 1 && fingerprint(removed.home) === removedBefore);
  const purged = removed.run('uninstall', ['--apply', '--purge-roles']);
  check('包已移除允许 purge 且备份原数据、验证缺失', purged.exitCode === 0 && !fs.existsSync(removed.p.roles)
    && readdirSync(dirnameFor(removed.p.roles)).some(name => name.includes('.bak-lifecycle-')) && /写后复读验证/.test(purged.output));
  section('边界修复：split / legacy 播种 / 跨 profile purge / home patch / 缺 patch');
  {
    const splitPatch = `- id: agent-switchboard\n  name: ${JSON.stringify(pkg.name)}\n  config:\n    roleSettings:\n      - id: worker\n        backend: spawn\n`;
    const f = fixture({ patch: splitPatch, roles: null });
    const r = f.run('install', ['--apply']);
    check('split 模式缺 roles 时拒绝播种空文件并 exit=3', r.exitCode === 3
      && !existsSync(f.p.roles) && /人工角色定义步骤/.test(r.output)
      && !/roles 将播种空角色列表/.test(r.output), r.output);
    const v = f.run('verify');
    check('split 模式缺定义时 verify 明确报 roles.definitions', v.exitCode === 1
      && v.snapshot.verification.issues.some(i => i.code === 'roles.definitions'), v.output);
    mkdirSync(join(f.p.roles, '..'), { recursive: true });
    put(f.p.roles, { formatVersion: 1, roles: [{ id: 'worker', backend: 'spawn' }] });
    const ok = f.run('install', ['--apply']);
    check('split 模式补齐定义后 install 收敛', ok.exitCode === 0
      && ok.snapshot.verification.status === 'consistent', ok.output);
  }
  {
    const legacyPatch = `- id: agent-switchboard\n  name: ${JSON.stringify(pkg.name)}\n  config:\n    roles:\n      - id: worker\n        backend: spawn\n        model: m\n`;
    const f = fixture({ patch: legacyPatch, roles: null });
    const r = f.run('install', ['--apply']);
    const rolesBody = existsSync(f.p.roles) ? JSON.parse(readFileSync(f.p.roles, 'utf8')) : null;
    const patchBody = readFileSync(f.p.patch, 'utf8');
    check('legacy roles 在缺文件时从设置播种并裁成 roleSettings', r.exitCode === 0
      && rolesBody?.roles?.length === 1 && rolesBody.roles[0].id === 'worker'
      && /^    roleSettings:/m.test(patchBody) && !/^    roles:/m.test(patchBody), r.output);
  }
  {
    const f = fixture({ patch: cleanPatch, roles: null });
    rmSync(f.p.patch);
    const r = f.run('install', ['--apply']);
    check('缺 profile patch 时按空用户层收敛', r.exitCode === 0 && !existsSync(f.p.patch)
      && JSON.parse(readFileSync(f.p.roles, 'utf8')).roles.length === 0, r.output);
    const u = f.run('uninstall', ['--apply']);
    check('缺 profile patch 时 uninstall 不因 ENOENT 失败', u.exitCode === 3
      && /人工包移除步骤/.test(u.output), u.output);
  }
  {
    const orphan = fixture({ registration: 'none', patch: cleanPatch + generated });
    const v = orphan.run('verify');
    check('未登记但残留 profile preset 时 verify 不再 skipped', v.exitCode === 1
      && v.snapshot.verification.status === 'inconsistent'
      && v.snapshot.verification.issues.some(i => i.code === 'preset.injectedInProfile')
      && /uninstall --apply/.test(v.snapshot.nextStep), v.output);
  }
  {
    const f = fixture({ patch: cleanPatch });
    put(join(f.home, 'cordis.patch.yml'), generated);
    const s = f.run('status');
    check('home patch 的注入副本被识别', s.exitCode === 0 && s.snapshot.preset.injectedInHome
      && s.snapshot.verification.issues.some(i => i.code === 'preset.injectedInHome'));
    const v = f.run('verify');
    check('home patch 注入副本让 verify 非零', v.exitCode === 1, v.output);
    const u = f.run('uninstall', ['--apply']);
    check('home patch 的包引用阻止移包', u.exitCode === 1
      && u.output.includes(join(f.home, 'cordis.patch.yml'))
      && /profile \/ home 配置中仍有包引用/.test(u.output), u.output);
  }
  {
    const f = fixture({ registration: 'none', patch: cleanPatch });
    const other = join(f.home, 'profiles', 'server');
    mkdirSync(other, { recursive: true });
    put(join(other, 'package.json'), { dependencies: { [pkg.name]: `link:${repoRoot}` },
      dsh: { profile: { bundles: [pkg.name] } } });
    const beforeRoles = readFileSync(f.p.roles);
    const refused = f.run('uninstall', ['--purge-roles', '--apply']);
    check('其它 profile 仍登记时 --purge-roles 拒绝且 roles 保留', refused.exitCode === 1
      && /下列 profile 仍声明或启用本包/.test(refused.output)
      && beforeRoles.equals(readFileSync(f.p.roles)), refused.output);
    put(join(other, 'package.json'), {});
    const allowed = f.run('uninstall', ['--purge-roles', '--apply']);
    check('其它 profile 移除后 --purge-roles 允许', allowed.exitCode === 0 && !existsSync(f.p.roles), allowed.output);
  }
  {
    const f = fixture({ registration: 'none', patch: cleanPatch + generated });
    const other = join(f.home, 'profiles', 'other');
    mkdirSync(other, { recursive: true });
    put(join(other, 'package.json'), { dependencies: { [pkg.name]: `link:${repoRoot}` } });
    const beforePatch = readFileSync(f.p.patch);
    const refused = f.run('uninstall', ['--purge-roles', '--apply']);
    check('purge 跨 profile 拒绝发生在任何写入之前', refused.exitCode === 1
      && beforePatch.equals(readFileSync(f.p.patch))
      && !readdirSync(f.p.profile).some(name => name.includes('.bak-lifecycle-')), refused.output);
  }
  {
    const f = fixture({ registration: 'none', patch: cleanPatch });
    const other = join(f.home, 'profiles', 'broken');
    mkdirSync(other, { recursive: true });
    put(join(other, 'package.json'), '{bad');
    const beforeRoles = readFileSync(f.p.roles);
    const refused = f.run('uninstall', ['--purge-roles', '--apply']);
    check('其它 profile 清单不可读时 purge 拒绝且 roles 保留', refused.exitCode === 1
      && /manifest-unreadable/.test(refused.output) && beforeRoles.equals(readFileSync(f.p.roles)), refused.output);
  }
  {
    const f = fixture();
    put(join(f.p.profile, 'node_modules', pkg.name, 'package.json'), { ...pkg, version: '0.0.0' });
    const s = f.run('status');
    check('豁免键按已安装版本构造并标注 manifest 来源', s.snapshot.compatibility.key === `${pkg.name}@0.0.0`
      && s.snapshot.compatibility.targetKey === `${pkg.name}@${pkg.version}`
      && s.snapshot.compatibility.manifestSource === 'installed', JSON.stringify(s.snapshot.compatibility));
  }
  {
    const f = fixture({ patch: cleanPatch });
    put(join(f.p.profile, 'package.json'), { dependencies: { [pkg.name]: `link:${join(temp, 'other-repo')}` },
      dsh: { profile: { bundles: [pkg.name] } } });
    const s = f.run('status');
    check('link 安装源不指向本仓库时 verify 失败', s.snapshot.registration.sourceKind === 'link'
      && s.snapshot.registration.sourceMatchesRepo === false
      && s.snapshot.verification.issues.some(i => i.code === 'registration.source')
      && f.run('verify').exitCode === 1, JSON.stringify(s.snapshot.registration));
  }
  {
    const f = fixture({ patch: cleanPatch });
    put(join(f.p.profile, 'package.json'), { dependencies: { [pkg.name]: pkg.version },
      dsh: { profile: { bundles: [pkg.name] } } });
    const s = f.run('status');
    check('registry 安装源无法用仓库制品证明，判 unverified', s.snapshot.registration.sourceKind === 'registry'
      && s.snapshot.verification.status === 'unverified'
      && s.snapshot.verification.unverified.some(i => i.code === 'registration.source')
      && f.run('verify').exitCode === 1, JSON.stringify(s.snapshot.registration));
  }
  {
    const f = fixture({ registration: 'none', patch: cleanPatch });
    put(join(f.p.profile, 'compatibility.json'), { [`${pkg.name}@${pkg.version}`]: [stubRuntime] });
    const r = f.run('uninstall', ['--apply']);
    check('卸载后提示 compatibility 豁免残留且不自动删除', r.exitCode === 0
      && /兼容性豁免残留/.test(r.output) && existsSync(join(f.p.profile, 'compatibility.json')), r.output);
  }
  {
    const f = fixture({ kind: 'server', patch: cleanPatch });
    const s = f.run('status');
    check('CLI-managed 默认不拿 Electron 归档当运行时',
      s.snapshot.compatibility.runtime.status === 'unknown'
        && /CLI-managed/.test(s.snapshot.compatibility.runtime.reason)
        && s.snapshot.verification.status === 'unverified');
    const v = f.run('verify', ['--runtime-version', stubRuntime]);
    check('CLI-managed 显式 --runtime-version 后恢复验证', v.exitCode === 0
      && v.snapshot.compatibility.runtime.version === stubRuntime
      && v.snapshot.verification.status === 'consistent', v.output);
  }
  for (const kind of ['desktop', 'server']) {
    const f = fixture({ kind });
    const result = f.run('uninstall', ['--apply']);
    check(`${kind} 卸载步骤对应正确通道`, result.exitCode === 3 && (kind === 'desktop'
      ? /Plugins 页面.*卸载插件/.test(result.output) : /dsh plugin --profile 'server' remove/.test(result.output)), result.output);
  }
  for (const patch of ['- insert: [', cleanPatch + generated.replace(/^#.*\n/gm, ''), cleanPatch + generated + generated,
    cleanPatch + '- insert:\n    - id: preset-switchboard\n      config: {}\n    - id: user-data\n      config: {}\n']) {
    for (const command of ['install', 'upgrade', 'uninstall']) {
      const f = fixture({ patch }), before = bytesTree(f.home);
      const r = f.run(command, ['--apply']);
      check(`${command} malformed/unmarked/ambiguous 安全拒绝`, r.exitCode === 1 && /FAIL/.test(r.output)
        && !/\n\s+at /.test(r.output) && bytesTree(f.home) === before, r.output);
    }
  }
  // 平台无关的权限拒绝 fixture：注入 OS EACCES，避免 Windows chmod 无法模拟 ACL 的假测试。
  for (const command of ['install', 'upgrade', 'uninstall']) {
    const f = fixture({ patch: cleanPatch + generated });
    const before = bytesTree(f.home), access = fs.accessSync;
    let result;
    try {
      fs.accessSync = path => { if (String(path).startsWith(f.home)) throw new Error('EACCES fixture directory unwritable'); return access(path); };
      syncBuiltinESMExports(); result = f.run(command, ['--apply']);
    } finally { fs.accessSync = access; syncBuiltinESMExports(); }
    check(`${command} unwritable fixture 预检失败全树字节不变`, result.exitCode === 1 && /EACCES/.test(result.output) && bytesTree(f.home) === before);
  }
  const postWrite = fixture();
  const read = fs.readFileSync, rename = fs.renameSync;
  let written = false, failure;
  try {
    fs.renameSync = (...args) => { const result = rename(...args); if (args[1] === postWrite.p.patch) written = true; return result; };
    fs.readFileSync = (...args) => written && args[0] === postWrite.p.patch ? Buffer.from('verification fault') : read(...args);
    syncBuiltinESMExports(); failure = postWrite.run('install', ['--apply']);
  } finally { fs.readFileSync = read; fs.renameSync = rename; syncBuiltinESMExports(); }
  check('写后复读失败必须非零且留下可恢复备份', failure.exitCode === 1 && /写后复读验证失败/.test(failure.output)
    && readdirSync(postWrite.p.profile).some(name => name.includes('.bak-lifecycle-')), failure.output);
  const incompatible = fixture();
  const incompatibleResult = incompatible.run('upgrade', ['--apply'], { collectOptions: { repoRoot,
    readArchive: entry => entry === 'dsh/package.json' ? JSON.stringify({ version: '0.3.0' }) : archive(entry) } });
  check('upgrade peer mismatch 给出精确人工豁免步骤', incompatibleResult.exitCode === 3
    && /DSH peers：incompatible/.test(incompatibleResult.output) && incompatibleResult.output.includes(`${pkg.name}@${pkg.version}`)
    && incompatibleResult.output.includes('["0.3.0"]'), incompatibleResult.output);
  const incompatibleVerify = incompatible.run('verify', [], { collectOptions: { repoRoot,
    readArchive: entry => entry === 'dsh/package.json' ? JSON.stringify({ version: '0.3.0' }) : archive(entry) } });
  check('verify 不兼容且无豁免必须非零', incompatibleVerify.exitCode === 1 && incompatibleVerify.snapshot.compatibility.runtimeExempt === false);
  // 运行时确实不兼容时：非法豁免值不得救场，精确 SemVer 才放行（真实 gate 的静默忽略语义）。
  const mismatchArchive = entry => entry === 'dsh/package.json' ? JSON.stringify({ version: '0.3.0' }) : archive(entry);
  const invalidExemption = fixture();
  put(join(invalidExemption.p.profile, 'compatibility.json'), { [key]: ['0.3.*'] });
  const invalidResult = invalidExemption.run('upgrade', ['--apply'], { collectOptions: { repoRoot, readArchive: mismatchArchive } });
  check('运行时 0.3.0 下范围式豁免不被接受，仍需人工豁免 exit=3', invalidResult.exitCode === 3
    && /兼容性人工豁免步骤/.test(invalidResult.output) && invalidResult.snapshot.compatibility.exemption === 'invalid'
    && invalidResult.snapshot.compatibility.runtimeExempt === false, invalidResult.output);
  const validExemption = fixture();
  put(join(validExemption.p.profile, 'compatibility.json'), { [key]: ['0.3.0'] });
  const validResult = validExemption.run('upgrade', ['--apply'], { collectOptions: { repoRoot, readArchive: mismatchArchive } });
  check('运行时 0.3.0 下精确 SemVer 豁免被接受且放行', validResult.exitCode === 0
    && validResult.snapshot.compatibility.exemption === 'exempt' && validResult.snapshot.compatibility.runtimeExempt === true
    && validResult.snapshot.verification.status === 'consistent', validResult.output);
  const absentTarget = fixture();
  rmSync(absentTarget.p.profile, { recursive: true });
  for (const command of ['install', 'upgrade', 'uninstall']) {
    const before = fingerprint(absentTarget.home), result = absentTarget.run(command, ['--apply']);
    check(`${command} profile 不存在拒绝且不创建`, result.exitCode === 1 && fingerprint(absentTarget.home) === before);
  }
  const jsonFixture = fixture();
  const jsonLogs = [];
  const jsonResult = jsonFixture.run('install', ['--apply', '--json'], { log: line => jsonLogs.push(line) });
  check('mutating --json 单份快照包含路径、验证事件与退出码', jsonResult.exitCode === 0 && jsonLogs.length === 1
    && JSON.parse(jsonLogs[0]).operation.events.some(line => /写后复读验证/.test(line))
    && JSON.parse(jsonLogs[0]).operation.exitCode === 0);
  section('B4 真实命令入口，仅合成 profile');
  cpSync(join(REPO_ROOT, 'scripts', 'lib'), join(regenerationRepo, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(regenerationRepo, 'scripts', 'ops'), { recursive: true });
  const isolatedScript = join(regenerationRepo, 'scripts', 'ops', 'plugin-lifecycle.mjs');
  cpSync(script, isolatedScript);
  put(regenerationFile, generated);
  const cliDangling = fixture({ patch: rootReference + generated });
  const cliDanglingResult = captureSync(process.execPath, [isolatedScript, 'uninstall', '--home', cliDangling.home, '--profile', cliDangling.p.profile, '--apply'], { env, cwd: temp });
  check('双引用真实 CLI exit=1、报告剩余 id/行且不发移包指令', cliDanglingResult.status === 1
    && /cordis.patch.yml:3 id=agent-switchboard/.test(cliDanglingResult.stdout)
    && !/人工包移除步骤/.test(cliDanglingResult.stdout), cliDanglingResult.stdout + cliDanglingResult.stderr);
  console.log(`  双引用 CLI exit=${cliDanglingResult.status}；${cliDanglingResult.stdout.split('\n').filter(line => /悬空引用|id=/.test(line)).join('；')}`);
  for (const command of ['install', 'upgrade', 'uninstall']) {
    const f = fixture({ patch: cleanPatch + generated });
    put(join(f.p.profile, 'package.json'), { dependencies: { [pkg.name]: `link:${regenerationRepo}` },
      dsh: { profile: { bundles: [pkg.name] } } });
    const before = fingerprint(f.home), patchBefore = readFileSync(f.p.patch);
    const args = [isolatedScript, command, '--home', f.home, '--profile', f.p.profile];
    const dry = captureSync(process.execPath, args, { env, cwd: temp });
    check(`${command} CLI dry-run exit=1 全树零写入`, dry.status === 1 && fingerprint(f.home) === before, dry.stdout + dry.stderr);
    const applied = captureSync(process.execPath, [...args, '--apply'], { env, cwd: temp });
    const backup = readdirSync(f.p.profile).find(name => name.includes('.bak-lifecycle-'));
    check(`${command} CLI --apply 正确退出、备份与复读验证`, applied.status === (command === 'uninstall' ? 3 : 0)
      && backup && readFileSync(join(f.p.profile, backup)).equals(patchBefore)
      && /PASS  写后复读验证/.test(applied.stdout), applied.stdout + applied.stderr);
    console.log(`  命令 node scripts/ops/plugin-lifecycle.mjs ${command} --home <tmp-fixture> --profile <tmp-profile> [--apply]：dry=${dry.status}, apply=${applied.status}, bytes=${patchBefore.length}→${readFileSync(f.p.patch).length}, backup=${backup}`);
  }
  const changedManifest = fixture();
  const installedPath = join(changedManifest.p.profile, 'node_modules', pkg.name, 'package.json');
  put(installedPath, { ...pkg, dsh: { ...pkg.dsh, manifestVersion: 0 } });
  check('upgrade 报告可判定的 manifestVersion 变化', /manifestVersion：0 → 1（变化）/.test(changedManifest.run('upgrade').output));
  put(installedPath, { ...pkg, version: '0.0.0' });
  const oldVersion = changedManifest.run('upgrade', ['--apply']);
  check('upgrade 旧安装版本指向 DSH 人工包更新 exit=3', oldVersion.exitCode === 3 && /人工包更新步骤/.test(oldVersion.output));
  put(installedPath, { ...pkg, version: '9.9.9' });
  const aheadVersion = changedManifest.run('upgrade', ['--apply']);
  check('upgrade 不用仓库旧版本覆盖更高安装版本', aheadVersion.exitCode === 3
    && /不降级/.test(aheadVersion.output) && !/人工包更新步骤/.test(aheadVersion.output), aheadVersion.output);
  for (const command of ['install', 'upgrade']) for (const roles of ['{bad', { formatVersion: 999, roles: [] }]) {
    const f = fixture({ patch: cleanPatch, roles }), before = bytesTree(f.home);
    const result = f.run(command, ['--apply']);
    check(`${command} 无效/未来角色格式预检拒绝、preset 也不写`, result.exitCode === 1 && bytesTree(f.home) === before);
  }
  console.log('\n一致 fixture status：');
  runLifecycle({ argv: ['status'], paths, collectOptions: options });
  put(paths.patch, cleanPatch);
  console.log('\n缺 preset fixture status：');
  runLifecycle({ argv: ['status'], paths, collectOptions: options });
  const driftReason = JSON.parse(drift.stdout).verification.issues.find(i => i.code === 'preset.injectedInProfile')?.reason;
  console.log(`\n一致 verify exit=${verify.status}；漂移 verify exit=${drift.status}，${driftReason}`);
} finally { rmSync(temp, { recursive: true, force: true }); }
  section('收尾迁移：roles 块 → roleSettings 旋钮块（文本级）');
  {
    // ⚠️ 这是**文本级**改写，因为 profile patch 含 `!!js` 表达式标签，YAML round-trip 会把
    //    它们降级成普通字符串。历史同源教训：剥离早期用宽泛匹配，一路吃到文件末尾，
    //    删掉近 900 行（含全部角色配置）。所以这里逐条钉住「什么都不许少」。
    const migrationPatch = [
      '# 用户注释必须逐字保留',
      '- id: unrelated-entry',
      '  name: unrelated',
      '  config:',
      '    keep: yes',
      '- id: agent-switchboard',
      '  name: "@magicvr/dsh-agent-switchboard"',
      '  config:',
      '    mount: false',
      '    provider: self',
      '    cwd: DSH-Agent-Switchboard',
      '    volatile:',
      '      wrapperModel: keep-me',
      '    roles:',
      '      - id: scout',
      '        title: 侦察',
      '        description: d',
      '        instructions: |',
      '          多行 persona 原文',
      '        backend: spawn',
      '        model: m-scout',
      '        effort: high',
      '        readOnly: true',
      '      - id: worker',
      '        description: d',
      '        instructions: i',
      '        backend: cli',
      '        model: m-worker',
      '        cliArgs:',
      '          - exec',
      '          - "{prompt}"',
      '- id: after-entry',
      '  name: after',
      '  config:',
      "    disabled: !!js process.platform === 'win32'",
      '',
    ].join('\n');
    const definitions = [
      { id: 'scout', description: 'd', instructions: '多行 persona 原文', backend: 'spawn', model: 'm-scout' },
      { id: 'worker', description: 'd', instructions: 'i', backend: 'cli', model: 'm-worker' },
    ];
    const plan = planRolesMigration(migrationPatch, definitions);
    check('迁移计划成立且报告被裁剪的角色数',
      plan.ok && plan.changed && plan.knobs.length === 2, JSON.stringify(plan.error ?? plan.reason));
    const migrated = plan.text;
    const settingsAt = migrated.indexOf('    roleSettings:');
    const afterAt = migrated.indexOf('- id: after-entry');
    check('迁移后 roleSettings 只带旋钮，persona / CLI argv / title 一律不进设置',
      settingsAt >= 0 && afterAt > settingsAt
        && !/instructions:|cliArgs:|title:/.test(migrated.slice(settingsAt, afterAt)));
    check('迁移后旋钮值逐字保留',
      migrated.includes('      - id: scout') && migrated.includes('        backend: spawn')
        && migrated.includes('        model: m-scout') && migrated.includes('        effort: high')
        && migrated.includes('        readOnly: true') && migrated.includes('        backend: cli')
        && migrated.includes('        model: m-worker'));
    // 最重要的三条：块外的一切必须逐字原样。
    check('迁移不吞相邻条目、注释与 !!js 标签（历史险情的直接守卫）',
      migrated.includes('# 用户注释必须逐字保留')
        && migrated.includes('    keep: yes')
        && migrated.includes("    disabled: !!js process.platform === 'win32'")
        && migrated.includes('- id: after-entry') && migrated.includes('- id: unrelated-entry'));
    check('根条目自己的其它设置原样保留（mount / provider / cwd / volatile）',
      migrated.includes('    mount: false') && migrated.includes('    provider: self')
        && migrated.includes('    cwd: DSH-Agent-Switchboard')
        && migrated.includes('      wrapperModel: keep-me'));
    check('迁移后仍是合法 YAML 且条目数不变',
      (() => { try { return parse(migrated).length === 3; } catch { return false; } })());
    check('迁移是幂等的：再跑一次无需改动',
      (() => { const again = planRolesMigration(migrated, definitions); return again.ok && !again.changed; })());
    // 安全闸门：宁可不迁移，也不丢角色。
    check('文件里没有定义时拒绝迁移',
      planRolesMigration(migrationPatch, []).ok === false
        && /没有角色定义/.test(planRolesMigration(migrationPatch, []).error));
    check('设置与文件的角色 id 集合不一致时拒绝迁移',
      planRolesMigration(migrationPatch, [...definitions, { id: 'extra' }]).ok === false
        && /不一致/.test(planRolesMigration(migrationPatch, [...definitions, { id: 'extra' }]).error));
    check('没有 roles 块时无需迁移（不误报）',
      (() => { const r = planRolesMigration('- id: agent-switchboard\n  config:\n    mount: false\n', definitions);
        return r.ok && !r.changed; })());
    check('roles 为空块时无需迁移',
      (() => { const r = planRolesMigration('- id: agent-switchboard\n  config:\n    roles:\n', definitions);
        return r.ok && !r.changed; })());
  }

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
