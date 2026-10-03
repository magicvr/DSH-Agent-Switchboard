// 离线检查：只修改 tmpdir fixture，不接触真实 DSH profile 或归档。
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { parse, stringify } from 'yaml';
import { captureSync } from './lib/capture.mjs';
import { REPO_ROOT, resolvePaths } from './lib/paths.mjs';
import { collectLifecycle, satisfiesDshRange, evaluateDshPeers } from './lib/lifecycle.mjs';
import { generatePreset } from './lib/preset-generator.mjs';
import { readPatch, presetConfig, stripInjectedPreset, isOurBlockLine, assertNoStrayOperations } from './lib/preset-patch.mjs';
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
  const generated = generatePreset(standard, pkg.name).body;
  put(join(repoRoot, 'presets', 'switchboard.patch.yml'), generated);
  const paths = { ...resolvePaths({ argv: ['--home', home], env: {} }), repoRoot, explicitTarget: false };
  const profilePackage = join(paths.profile, 'package.json');
  const packageBody = join(paths.profile, 'node_modules', pkg.name, 'package.json');
  const compatibilityFile = join(paths.profile, 'compatibility.json');
  const archive = entry => {
    if (entry.endsWith('standard.patch.yml')) return standard;
    if (entry === 'dsh/package.json') return JSON.stringify({ version: '0.2.0-rc.2' });
    throw new Error(`fixture 无归档条目 ${entry}`);
  };
  const options = { paths, repoRoot, readArchive: archive };
  const collect = () => collectLifecycle(options);
  const invoke = (command, extra = {}) => runLifecycle({ argv: [command], paths, collectOptions: options, log: () => {}, ...extra });
  const registered = () => put(profilePackage, { dependencies: { [pkg.name]: 'link:fixture' }, dsh: { profile: { bundles: [pkg.name] } } });
  const patchWith = config => {
    const document = parse(generated);
    document[0].insert[0].config.plugins.find(row => row.name === pkg.name).config = config;
    return stringify(document);
  };
  const config = presetConfig(readPatch(join(repoRoot, 'presets', 'switchboard.patch.yml')), pkg.name).config;
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

  section('preset 和严格剥离 guard');
  put(paths.patch, cleanPatch); s = collect();
  check('preset 缺失有明确判据', !s.preset.present && s.verification.issues.some(i => i.code === 'preset.structure'));
  put(paths.patch, cleanPatch + generated);
  check('cwd 中含 Switchboard 不属于本块', !isOurBlockLine('        cwd: DSH-Agent-Switchboard'));
  check('剥离只删除 preset 并保留 cwd', stripInjectedPreset(cleanPatch + generated).includes('cwd: DSH-Agent-Switchboard')
    && !stripInjectedPreset(cleanPatch + generated).includes('id: preset-switchboard'));
  check('剥离后结构断言继续通过', assertNoStrayOperations(stripInjectedPreset(cleanPatch + generated), 'fixture'));
  put(paths.patch, patchWith({ ...config, supervisorRules: config.supervisorRules + 'x' })); s = collect();
  check('supervisorRules 一字节漂移精确报告', s.preset.rules.status === 'drifted' && /首个不同位置/.test(s.preset.rules.reason));
  check('status 漂移仍退出 0', invoke('status').exitCode === 0);
  check('verify 漂移退出非零', invoke('verify').exitCode === 1);
  put(paths.patch, patchWith({ ...config, roles: [] }));
  check('禁止 roles 字段明确失败', collect().preset.hasRoles && collect().verification.issues.some(i => i.code === 'preset.roles'));
  put(paths.patch, generated);
  check('规则逐字一致且生成物无漂移', collect().preset.rules.status === 'current' && collect().preset.generatedDrift.status === 'current');
  check('成功读取 standard 后无漂移原因为空', collect().preset.generatedDrift.reason === null);
  put(join(repoRoot, 'presets', 'switchboard.patch.yml'), generated + '\n');
  s = collect();
  check('生成物单个换行漂移也被检测', s.preset.generatedDrift.status === 'drifted');
  check('生成物漂移进入 verify 判据', s.verification.issues.some(i => i.code === 'preset.generatedDrift'
    && i.reason === '仓库 preset 与生成器当前产物字节不一致') && invoke('verify').exitCode === 1);
  put(join(repoRoot, 'presets', 'switchboard.patch.yml'), generated);
  check('恢复生成物后清除漂移判据', collect().preset.generatedDrift.status === 'current'
    && !collect().verification.issues.some(i => i.code === 'preset.generatedDrift'));
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

  section('临时 ASAR 与真实子进程读取');
  // 按 dsh-cat 的归档格式生成最小 fixture，覆盖非注入的 captureSync 路径。
  const archivePath = join(temp, 'fixture.asar');
  const archiveHeader = { files: {} }, archiveBodies = [];
  let offset = 0;
  for (const [entry, content] of [
    ['dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml', standard],
    ['dsh/package.json', JSON.stringify({ version: '0.2.0-rc.2' })],
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
    && cat.stderr.includes('ASAR:') && JSON.parse(cat.stdout).version === '0.2.0-rc.2', cat.stderr);
  console.log(`  观察到 stderr：${cat.stderr.trim()}；JSON version=${JSON.parse(cat.stdout).version}`);
  s = collectLifecycle({ paths, repoRoot, env: archiveEnv });
  check('实际归档读取接受诊断 stderr 并验证生成物与运行时', s.preset.generatedDrift.status === 'current'
    && s.compatibility.runtime.status === 'known' && s.compatibility.runtime.version === '0.2.0-rc.2');

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
    && s.compatibility.runtime.version === '0.2.0-rc.2' && s.compatibility.exemption === 'absent'
    && !s.compatibility.exemptionPresent && s.compatibility.runtimeExempt === false);
  const key = `${pkg.name}@${pkg.version}`;
  put(compatibilityFile, { [key]: ['0.2.0-rc.2'] }); s = collect();
  check('stub 运行时流入 exempt 判据并命中', s.compatibility.runtime.status === 'known'
    && s.compatibility.runtime.version === '0.2.0-rc.2' && s.compatibility.exemption === 'exempt'
    && s.compatibility.exemptionPresent && s.compatibility.runtimeExempt === true);
  put(compatibilityFile, { [`${pkg.name}@0.0.0`]: ['0.2.0-rc.2'] }); s = collect();
  check('stub 运行时已知但旧版本豁免仍是 expired', s.compatibility.runtime.status === 'known'
    && s.compatibility.runtime.version === '0.2.0-rc.2' && s.compatibility.exemption === 'expired'
    && s.compatibility.runtimeExempt === false && s.verification.issues.some(i => i.code === 'compatibility.expired'));
  put(compatibilityFile, { [key]: ['different-runtime'] });
  check('当前运行时不在豁免数组明确失败', collect().compatibility.runtimeExempt === false && invoke('verify').exitCode === 1);
  put(compatibilityFile, { [key]: ['0.2.0-rc.2'] });
  check('desktop basename 分类', collect().profile.kind === 'desktop');
  check('其他 basename 分类 cli-managed', collectLifecycle({ ...options, paths: { ...paths, profile: join(temp, 'server') } }).profile.kind === 'cli-managed');
  check('模块变化完整重启是固定事实', collect().restart.requiredForModuleChange === true);
  check('完全一致 fixture verify 退出 0', invoke('verify').exitCode === 0 && collect().verification.status === 'consistent');

  section('命令行、零写入及实际输出');
  const cli = command => captureSync(process.execPath, [script, command, '--home', home, '--json'], { env, cwd: REPO_ROOT });
  const before = fingerprint(temp);
  invoke('status'); invoke('verify');
  const status = cli('status'), verify = cli('verify');
  check('status / verify CLI 退出 0 且 JSON 是单份快照', status.status === 0 && verify.status === 0
    && JSON.parse(status.stdout).paths.sources.home === '--home' && JSON.parse(verify.stdout).verification.status === 'consistent', status.stderr + verify.stderr);
  check('零写入：所有 fixture 文件 mtimeMs 与 size 及文件集合不变', fingerprint(temp) === before);
  put(paths.patch, patchWith({ ...config, supervisorRules: config.supervisorRules + 'x' }));
  const drift = cli('verify');
  check('真实 CLI 漂移退出 1 且给出精确原因', drift.status === 1 && JSON.parse(drift.stdout).verification.issues.some(i => i.code === 'preset.rules' && /首个不同位置/.test(i.reason)));
  put(paths.patch, generated);
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
  ]) check(`${version} / ${range} → ${expected}`, satisfiesDshRange(version, range).status === expected);
  check('未支持范围明确报告 unsupported-range', satisfiesDshRange('1.0.0', '>=1.0.0 || <2.0.0').reason === 'unsupported-range');
  check('仅镜像 DSH gate 包名范围', evaluateDshPeers('0.2.0', { '@deepseek-ai/dshx': 'bad', '@deepseek-ai/cordis': 'bad', '@deepseek-ai/dsh': '~0.2.0' }).status === 'compatible');

  section('B4 合成 profile 收敛与安全屏障');
  let fixtureNumber = 0;
  const rich = JSON.stringify({ formatVersion: 1, roles: [{ id: 'user', instructions: 'keep', custom: { rich: true } }],
    wrapperProvider: 'keep', extra: { nested: [1, 2, 3] } }, null, 4) + '\n';
  function fixture({ kind = 'desktop', registration = 'complete', patch = cleanPatch + generated, roles = rich } = {}) {
    const fixtureHome = join(temp, `b4-${++fixtureNumber}`);
    const p = { ...resolvePaths({ argv: ['--home', fixtureHome, '--profile', join(fixtureHome, 'profiles', kind)], env: {} }), repoRoot };
    mkdirSync(p.profile, { recursive: true });
    put(join(p.profile, 'package.json'), registration === 'none' ? {} : {
      dependencies: { [pkg.name]: 'link:fixture' }, dsh: { profile: { bundles: registration === 'complete' ? [pkg.name] : [] } } });
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
    const f = fixture({ patch: command === 'uninstall' ? cleanPatch + generated : cleanPatch, roles: command === 'install' ? null : rich });
    const before = fingerprint(f.home), patchBefore = readFileSync(f.p.patch), rolesBefore = fs.existsSync(f.p.roles) ? readFileSync(f.p.roles) : null;
    const dry = f.run(command);
    check(`${command} dry-run 全树 mtime+size 零写入`, fingerprint(f.home) === before, dry.output);
    const applied = f.run(command, ['--apply']);
    const patchAfter = readFileSync(f.p.patch);
    const backups = readdirSync(f.p.profile).filter(name => name.includes('.bak-lifecycle-'));
    check(`${command} --apply 备份及写后验证`, backups.length === 1
      && readFileSync(join(f.p.profile, backups[0])).equals(patchBefore)
      && /PASS  写后复读验证/.test(applied.output) && applied.exitCode === (command === 'uninstall' ? 3 : 0), applied.output);
    check(`${command} preset 目标状态正确`, Boolean(readPatch(f.p.patch).entries.some(row => row.id === 'preset-switchboard')) === (command !== 'uninstall'));
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
    const f = fixture();
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
    const f = fixture({ patch: command === 'uninstall' ? cleanPatch + generated : cleanPatch });
    const before = bytesTree(f.home), access = fs.accessSync;
    let result;
    try {
      fs.accessSync = path => { if (String(path).startsWith(f.home)) throw new Error('EACCES fixture directory unwritable'); return access(path); };
      syncBuiltinESMExports(); result = f.run(command, ['--apply']);
    } finally { fs.accessSync = access; syncBuiltinESMExports(); }
    check(`${command} unwritable fixture 预检失败全树字节不变`, result.exitCode === 1 && /EACCES/.test(result.output) && bytesTree(f.home) === before);
  }
  const postWrite = fixture({ patch: cleanPatch });
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
  const absentTarget = fixture();
  rmSync(absentTarget.p.profile, { recursive: true });
  for (const command of ['install', 'upgrade', 'uninstall']) {
    const before = fingerprint(absentTarget.home), result = absentTarget.run(command, ['--apply']);
    check(`${command} profile 不存在拒绝且不创建`, result.exitCode === 1 && fingerprint(absentTarget.home) === before);
  }
  const jsonFixture = fixture({ patch: cleanPatch });
  const jsonLogs = [];
  const jsonResult = jsonFixture.run('install', ['--apply', '--json'], { log: line => jsonLogs.push(line) });
  check('mutating --json 单份快照包含路径、验证事件与退出码', jsonResult.exitCode === 0 && jsonLogs.length === 1
    && JSON.parse(jsonLogs[0]).operation.events.some(line => /写后复读验证/.test(line))
    && JSON.parse(jsonLogs[0]).operation.exitCode === 0);
  section('B4 真实命令入口，仅合成 profile');
  for (const command of ['install', 'upgrade', 'uninstall']) {
    const f = fixture({ patch: command === 'uninstall' ? cleanPatch + generated : cleanPatch });
    const before = fingerprint(f.home), patchBefore = readFileSync(f.p.patch);
    const args = [script, command, '--home', f.home, '--profile', f.p.profile];
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
  console.log(`\n一致 verify exit=${verify.status}；漂移 verify exit=${drift.status}，${JSON.parse(drift.stdout).verification.issues.find(i => i.code === 'preset.rules').reason}`);
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
