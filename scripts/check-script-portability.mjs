// 离线：仅写临时 fixture，不运行外部 CLI、不改变真实 USERPROFILE。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configPathFor } from '../src/config-file.js';
import { PLACEHOLDERS } from '../src/cli/argv.js';
import { REPO_ROOT, parsePathArgs, resolvePaths, resolveAsar, printPaths } from './lib/paths.mjs';
import { loadCliConfig, validateCliConfig, cliInvocation } from './lib/cli-config.mjs';

let pass = 0;
let fail = 0;
function check(label, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (condition) pass++; else fail++;
}
function test(label, fn) {
  try { check(label, Boolean(fn())); } catch { check(label, false); }
}
function rejects(fn, pattern = /./) {
  try { fn(); return false; } catch (error) { return pattern.test(error.message); }
}

// 保留真实进程验证；受限沙箱不允许管道捕获，所以用文件描述符读回输出。
function spawnSyncToFiles(command, argv, { cwd, env }) {
  const captureDir = mkdtempSync(join(tmpdir(), 'switchboard-capture-'));
  const stdoutPath = join(captureDir, 'stdout');
  const stderrPath = join(captureDir, 'stderr');
  let stdoutFd;
  let stderrFd;
  try {
    stdoutFd = openSync(stdoutPath, 'w');
    stderrFd = openSync(stderrPath, 'w');
    const result = spawnSync(command, argv, { cwd, env, stdio: ['ignore', stdoutFd, stderrFd] });
    return { ...result, stdout: readFileSync(stdoutPath, 'utf8'), stderr: readFileSync(stderrPath, 'utf8') };
  } finally {
    try { if (stdoutFd !== undefined) closeSync(stdoutFd); }
    finally {
      try { if (stderrFd !== undefined) closeSync(stderrFd); }
      finally { rmSync(captureDir, { recursive: true, force: true }); }
    }
  }
}

const temp = mkdtempSync(join(tmpdir(), 'switchboard-portability-'));
try {
  const base = { argv: [], env: {}, cwd: temp, homedir: () => join(temp, 'user') };
  const paths = extra => resolvePaths({ ...base, ...extra });
  console.log('\n=== 路径优先级与纯解析 ===');
  test('参数 home 覆盖环境 home', () => paths({ argv: ['--home', 'arg'], env: { DSH_HOME: 'env' } }).home === join(temp, 'arg'));
  test('环境 home 覆盖 homedir', () => paths({ env: { DSH_HOME: 'env' } }).home === join(temp, 'env'));
  test('默认 home 来自注入 homedir', () => paths().home === join(temp, 'user', '.dsh'));
  test('相对路径锚定启动 cwd', () => paths({ argv: ['--home', 'relative'] }).home === resolve(temp, 'relative'));
  test('shell 变量保持字面量', () => paths({ argv: ['--home', '$DSH_HOME/%APPDATA%'] }).home === resolve(temp, '$DSH_HOME/%APPDATA%'));
  test('仓库根来自模块 URL 不受 cwd 影响', () => resolve(paths().repoRoot) === resolve(REPO_ROOT) && resolve(paths().cwd) === resolve(REPO_ROOT));
  test('默认 profile 属于解析后的 home', () => paths({ argv: ['--home', 'selected'] }).profile === join(temp, 'selected', 'profiles', 'desktop'));
  test('profile 参数不反推 home', () => paths({ argv: ['--profile', 'independent'] }).home === join(temp, 'user', '.dsh'));
  test('显式 profile 与 home 独立', () => paths({ argv: ['--home', 'h', '--profile', 'p'] }).profile === join(temp, 'p'));
  test('roles 默认复用 configPathFor(home)', () => paths({ argv: ['--profile', 'p'] }).roles === configPathFor(paths().home));
  test('roles-file 参数覆盖默认', () => paths({ argv: ['--roles-file', 'roles.local'] }).roles === join(temp, 'roles.local'));
  test('patch 默认属于 profile', () => paths({ argv: ['--profile', 'p'] }).patch === join(temp, 'p', 'cordis.patch.yml'));
  test('patch 参数覆盖默认', () => paths({ argv: ['--patch', 'patch.local'] }).patch === join(temp, 'patch.local'));
  test('CLI 配置 cwd 覆盖仓库根', () => paths({ cliCwd: 'configured' }).cwd === join(temp, 'configured'));
  test('cwd 参数覆盖 CLI 配置', () => paths({ argv: ['--cwd', 'arg'], cliCwd: 'configured' }).cwd === join(temp, 'arg'));
  test('来源标记覆盖参数环境与推导', () => {
    const p = paths({ argv: ['--profile', 'p'], env: { DSH_HOME: 'h' } });
    return p.sources.home === 'DSH_HOME' && p.sources.profile === '--profile' && p.sources.roles === 'configPathFor(home)';
  });
  test('执行前显示全部路径及来源且无令牌', () => {
    const lines = []; printPaths(paths({ env: { TOKEN: 'secret-token' } }), line => lines.push(line));
    return lines.length === 5 && lines.every(line => /\[.+\]/.test(line)) && !lines.join('').includes('secret-token');
  });
  test('解析不创建目录且不读取缺失 roles', () => {
    const p = paths({ argv: ['--home', 'not-created'] });
    return !existsSync(p.home) && !existsSync(p.roles);
  });
  test('缺值参数拒绝', () => rejects(() => paths({ argv: ['--home'] })));
  test('下一选项不能作为路径值', () => rejects(() => paths({ argv: ['--home', '--profile', 'p'] })));
  test('重复冲突参数拒绝', () => rejects(() => paths({ argv: ['--home', 'a', '--home', 'b'] })));
  test('相同重复参数允许', () => parsePathArgs(['--home', 'a', '--home', 'a']).home === 'a');
  test('未知参数拒绝', () => rejects(() => paths({ argv: ['--unknown', 'a'] })));
  test('空白参数拒绝不回退', () => rejects(() => paths({ argv: ['--home', '   '] })));
  test('空白 DSH_HOME 拒绝不回退', () => rejects(() => paths({ env: { DSH_HOME: ' ' } })));
  test('含 NUL 路径拒绝', () => rejects(() => paths({ argv: ['--home', 'bad\0path'] })));
  test('无效 CLI 配置 cwd 拒绝', () => rejects(() => paths({ cliCwd: ' ' })));
  test('homedir 抛错提示显式 home', () => rejects(() => paths({ homedir: () => { throw new Error(); } }), /--home.*DSH_HOME/));
  test('homedir 空值拒绝', () => rejects(() => paths({ homedir: () => '' })));
  test('homedir 相对值拒绝', () => rejects(() => paths({ homedir: () => 'relative' })));
  test('显式 home 不依赖 homedir', () => paths({ argv: ['--home', 'h'], homedir: () => { throw new Error(); } }).home === join(temp, 'h'));
  test('不缓存环境解析结果', () => {
    const env = { DSH_HOME: 'first' }; const first = paths({ env }).home;
    env.DSH_HOME = 'second'; return first !== paths({ env }).home;
  });

  console.log('\n=== 显式目标与 wiring 进程退出 ===');
  const env = { ...process.env }; delete env.DSH_HOME;
  const runWiring = (argv, extraEnv = {}) => spawnSyncToFiles(process.execPath,
    [join(REPO_ROOT, 'scripts', 'check-profile-wiring.mjs'), ...argv], { cwd: temp, env: { ...env, ...extraEnv } });
  for (const [label, argv, extraEnv] of [
    ['显式 home 缺失失败不跳过', ['--home', join(temp, 'missing')], {}],
    ['环境 home 缺失失败不跳过', [], { DSH_HOME: join(temp, 'missing') }],
    ['显式 profile 缺失失败不跳过', ['--profile', join(temp, 'missing')], {}],
    ['缺值参数进程非零退出', ['--home'], {}],
  ]) test(label, () => { const r = runWiring(argv, extraEnv); return r.status === 1 && /FAIL/.test(r.stdout + r.stderr) && !/结果：0 通过/.test(r.stdout); });
  const home = join(temp, 'wiring'); const profile = join(home, 'profiles', 'desktop');
  mkdirSync(profile, { recursive: true });
  const self = '@magicvr/dsh-agent-switchboard';
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [self] } }, dependencies: { [self]: '*' } }));
  writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:\n  - id: preset-switchboard\n    config:\n      plugins:\n      - name: "${self}"\n        config:\n          mount: true\n`);
  test('显式目标缺 roles 文件失败', () => { const r = runWiring(['--home', home]); return r.status === 1 && /缺少 roles 文件/.test(r.stderr); });
  mkdirSync(join(home, 'agent-switchboard')); writeFileSync(configPathFor(home), JSON.stringify({ roles: [] }));
  test('非仓库 cwd 的完整 wiring fixture 跑满九条', () => { const r = runWiring(['--home', home]); return r.status === 0 && /结果：9 通过 \/ 0 失败/.test(r.stdout); });

  console.log('\n=== ASAR 定位 ===');
  const asar = extra => resolveAsar({ env: {}, cwd: temp, homedir: base.homedir, platform: 'win32', isFile: () => true, ...extra });
  test('DSH_ASAR 覆盖默认且相对启动 cwd', () => asar({ env: { DSH_ASAR: 'selected.asar', LOCALAPPDATA: 'local' } }).archive === join(temp, 'selected.asar'));
  test('指定 ASAR 缺失失败且不回退', () => rejects(() => asar({ env: { DSH_ASAR: 'missing.asar', LOCALAPPDATA: 'local' }, isFile: path => path !== join(temp, 'missing.asar') }), /DSH_ASAR/));
  test('空 DSH_ASAR 拒绝不猜默认', () => rejects(() => asar({ env: { DSH_ASAR: '' } })));
  test('Windows 默认来自 LOCALAPPDATA', () => asar({ env: { LOCALAPPDATA: 'local' } }).archive === join(temp, 'local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'));
  test('Windows 缺 LOCALAPPDATA 从 homedir 推导', () => asar().archive === join(temp, 'user', 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'));
  test('默认 ASAR 缺失提示设置 DSH_ASAR', () => rejects(() => asar({ isFile: () => false }), /DSH_ASAR/));
  test('空 LOCALAPPDATA 拒绝', () => rejects(() => asar({ env: { LOCALAPPDATA: ' ' } })));
  test('ASAR homedir 失败拒绝', () => rejects(() => asar({ homedir: () => { throw new Error(); } })));
  test('非 Windows 默认不猜安装位置', () => rejects(() => asar({ platform: 'linux' }), /DSH_ASAR/));
  test('非 Windows 显式 ASAR 可用', () => asar({ platform: 'linux', env: { DSH_ASAR: 'portable.asar' } }).source === 'DSH_ASAR');

  console.log('\n=== CLI 用户配置与分离 argv ===');
  const valid = { command: 'fixture-cli', prefixArgs: ['entry.js'], cases: { sample: { args: ['-m', '{model}', '-p', '{prompt}', '--cwd', '{cwd}', '{effort}'], promptDelivery: 'argv', cwd: 'configured' } } };
  const argFile = join(temp, 'args.local'); const envFile = join(temp, 'env.local');
  writeFileSync(argFile, JSON.stringify(valid)); writeFileSync(envFile, JSON.stringify({ ...valid, command: 'env-cli' }));
  const load = extra => loadCliConfig({ argv: [], env: {}, cwd: temp, ...extra });
  test('cli-config 参数覆盖环境配置', () => load({ argv: ['--cli-config', 'args.local'], env: { SWITCHBOARD_CLI_CONFIG: envFile } }).config.command === 'fixture-cli');
  test('CLI 环境配置作为次选', () => load({ env: { SWITCHBOARD_CLI_CONFIG: envFile } }).config.command === 'env-cli');
  test('未提供 CLI 配置明确报错', () => rejects(() => load(), /--cli-config.*SWITCHBOARD_CLI_CONFIG/));
  test('显式 CLI 文件缺失不回退环境', () => rejects(() => load({ argv: ['--cli-config', 'missing.local'], env: { SWITCHBOARD_CLI_CONFIG: envFile } })));
  test('空 CLI 环境配置拒绝', () => rejects(() => load({ env: { SWITCHBOARD_CLI_CONFIG: ' ' } })));
  writeFileSync(join(temp, 'broken.local'), '{bad');
  test('无效 JSON 拒绝', () => rejects(() => load({ argv: ['--cli-config', 'broken.local'] })));
  const validate = config => validateCliConfig(config, { cwd: temp });
  test('command 必须非空字符串', () => rejects(() => validate({ ...valid, command: ' ' })));
  test('command 禁止模型占位符', () => rejects(() => validate({ ...valid, command: '{model}' })));
  test('prefixArgs 必须字符串数组', () => rejects(() => validate({ ...valid, prefixArgs: [42] })));
  test('args 必须字符串数组', () => rejects(() => validate({ ...valid, cases: { sample: { args: [42], promptDelivery: 'stdin' } } })));
  test('args 非数组拒绝', () => rejects(() => validate({ ...valid, cases: { sample: { args: 'exec', promptDelivery: 'stdin' } } })));
  test('args 未知占位符拒绝', () => rejects(() => validate({ ...valid, cases: { sample: { args: ['{unknown}'], promptDelivery: 'stdin' } } })));
  test('prefixArgs 未知占位符拒绝', () => rejects(() => validate({ ...valid, prefixArgs: ['{unknown}'] })));
  test('白名单与 argv.js 一致且四项均可用', () => PLACEHOLDERS.join(',') === 'prompt,cwd,model,effort' && validate(valid).cases.sample.args.length === 7);
  test('promptDelivery 无效拒绝', () => rejects(() => validate({ ...valid, cases: { sample: { args: [], promptDelivery: 'shell' } } })));
  test('stdin 含 prompt 拒绝', () => rejects(() => validate({ ...valid, cases: { sample: { args: ['{prompt}'], promptDelivery: 'stdin' } } })));
  test('argv 缺 prompt 拒绝', () => rejects(() => validate({ ...valid, cases: { sample: { args: [], promptDelivery: 'argv' } } })));
  test('promptFile 复用 prompt 可通过', () => validate({ ...valid, cases: { sample: { args: ['{prompt}'], promptDelivery: 'promptFile' } } }).cases.sample.promptDelivery === 'promptFile');
  test('cases 无效拒绝', () => rejects(() => validate({ ...valid, cases: [] })));
  test('用例 cwd 空白拒绝', () => rejects(() => validate({ ...valid, cases: { sample: { ...valid.cases.sample, cwd: ' ' } } })));
  test('用例 cwd 相对启动 cwd', () => validate(valid).cases.sample.cwd === join(temp, 'configured'));
  const loaded = load({ argv: ['--cli-config', argFile] });
  const invocation = () => cliInvocation(loaded, 'sample', { model: 'fixture-model', effort: 'high', prompt: 'space & $() ; prompt' }, { ...base, log: () => {} });
  test('调用仅使用用户 command 与分离 argv', () => { const r = invocation(); return r.command === 'fixture-cli' && Array.isArray(r.argv) && r.argv[0] === 'entry.js' && r.argv.includes('space & $() ; prompt'); });
  test('调用固定 shell:false', () => invocation().options.shell === false);
  test('调用 cwd 使用 CLI 配置', () => invocation().options.cwd === join(temp, 'configured'));
  test('未知用例拒绝', () => rejects(() => cliInvocation(loaded, 'unknown', {}, { ...base, log: () => {} })));
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
