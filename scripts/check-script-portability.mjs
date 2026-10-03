// 离线：仅写临时 fixture，不运行外部 CLI、不改变真实 USERPROFILE。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureSync } from './lib/capture.mjs';
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
  const env = { ...process.env, DSH_HOME: join(temp, 'isolated-home') };
  const runWiring = (argv, extraEnv = {}) => captureSync(process.execPath,
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
  const repoPreset = parse(readFileSync(new URL('../presets/switchboard.patch.yml', import.meta.url), 'utf8'));
  const supervisorRules = repoPreset.flatMap(op => op?.insert ?? [])
    .find(row => row?.id === 'preset-switchboard').config.plugins
    .find(plugin => plugin?.name === self).config.supervisorRules;
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [self] } }, dependencies: { [self]: '*' } }));
  const wiringPatch = join(profile, 'cordis.patch.yml');
  const wiringText = rules => `- insert:\n  - id: preset-switchboard\n    config:\n      plugins:\n      - name: "${self}"\n        config:\n          mount: true\n${rules === undefined ? '' : `          supervisorRules: ${JSON.stringify(rules)}\n`}`;
  writeFileSync(wiringPatch, wiringText(supervisorRules));
  test('显式目标缺 roles 文件失败', () => { const r = runWiring(['--home', home]); return r.status === 1 && /缺少 roles 文件/.test(r.stderr); });
  mkdirSync(join(home, 'agent-switchboard')); writeFileSync(configPathFor(home), JSON.stringify({ roles: [] }));
  test('非仓库 cwd 的完整 wiring fixture 跑满十一条', () => { const r = runWiring(['--home', home]); return r.status === 0 && /结果：11 通过 \/ 0 失败/.test(r.stdout); });
  for (const rules of [undefined, '', ' \n\t', 42]) {
    writeFileSync(wiringPatch, wiringText(rules));
    test(`无效 supervisorRules ${JSON.stringify(rules)} 必须失败并提示修复`, () => {
      const r = runWiring(['--home', home]);
      return r.status === 1 && /FAIL  preset 里本包的 supervisorRules/.test(r.stdout)
        && /npm run gen:preset && npm run inject:preset，然后重启 DSH/.test(r.stdout);
    });
  }
  writeFileSync(wiringPatch, wiringText(`${supervisorRules}fixture drift`));
  test('规则漂移必须失败并给出有限差异线索', () => {
    const r = runWiring(['--home', home]);
    return r.status === 1 && /FAIL  profile supervisorRules/.test(r.stdout)
      && /profile 已过期，需重新注入/.test(r.stdout) && /首个不同位置/.test(r.stdout)
      && /结果：10 通过 \/ 1 失败/.test(r.stdout);
  });

  const formattedFailure = (result, label) => {
    const output = result.stdout + result.stderr;
    return result.status === 1 && output.includes(`FAIL  ${label}`)
      && /结果：\d+ 通过 \/ [1-9]\d* 失败/.test(output)
      && !/(?:TypeError|SyntaxError|YAMLParseError|^\s+at )/m.test(output);
  };
  test('显式 patch 不存在仍 FAIL 并退出 1', () => {
    const r = runWiring(['--home', home, '--patch', join(temp, 'missing.patch.yml')]);
    return r.status === 1 && /FAIL  找不到/.test(r.stderr) && !/^\s+at /m.test(r.stderr);
  });
  test('默认 home 无 .dsh 仍零项跳过并退出 0', () => {
    const script = join(REPO_ROOT, 'scripts', 'check-profile-wiring.mjs');
    const shim = `
      import os from 'node:os';
      import { syncBuiltinESMExports } from 'node:module';
      delete process.env.DSH_HOME;
      os.homedir = () => ${JSON.stringify(join(temp, 'absent-default-user'))};
      syncBuiltinESMExports();
      process.argv = ${JSON.stringify([process.execPath, script])};
      await import(${JSON.stringify(pathToFileURL(script).href)});
    `;
    const r = captureSync(process.execPath, ['--input-type=module', '--eval', shim], { cwd: temp, env });
    return r.status === 0 && /结果：0 通过 \/ 0 失败（跳过）/.test(r.stdout)
      && /\[os.homedir\(\)\]/.test(r.stdout) && !/FAIL/.test(r.stdout + r.stderr);
  });
  const validPatch = parse(wiringText(supervisorRules));
  for (const [label, mutate, failLabel] of [
    ['顶层为 Object', () => ({ insert: validPatch[0].insert }), '存在 preset-switchboard 声明'],
    ['insert 为 Object', doc => { doc[0].insert = doc[0].insert[0]; return doc; }, '存在 preset-switchboard 声明'],
    ['plugins 为 Object', doc => { doc[0].insert[0].config.plugins = doc[0].insert[0].config.plugins[0]; return doc; }, 'preset 的 plugins 里含本包'],
    ['preset-switchboard 缺失', doc => { doc[0].insert[0].id = 'other-preset'; return doc; }, '存在 preset-switchboard 声明'],
    ['preset config 缺失', doc => { delete doc[0].insert[0].config; return doc; }, 'preset 的 plugins 里含本包'],
    ['preset config 非对象', doc => { doc[0].insert[0].config = []; return doc; }, 'preset 的 plugins 里含本包'],
    ['本包 config 缺失', doc => { delete doc[0].insert[0].config.plugins[0].config; return doc; }, 'preset 里本包不再携带 roles'],
    ['本包 config 非对象', doc => { doc[0].insert[0].config.plugins[0].config = 'invalid'; return doc; }, 'preset 里本包不再携带 roles'],
    ['insert 含 null', doc => { doc[0].insert.unshift(null); return doc; }, '存在 preset-switchboard 声明'],
    ['plugins 含 null', doc => { doc[0].insert[0].config.plugins.unshift(null); return doc; }, 'preset 的 plugins 里含本包'],
  ]) {
    writeFileSync(wiringPatch, JSON.stringify(mutate(structuredClone(validPatch))));
    test(`${label} 必须格式化 FAIL 且无异常栈`, () => {
      const r = runWiring(['--home', home, '--patch', wiringPatch]);
      return formattedFailure(r, failLabel)
        && r.stdout.includes('npm run gen:preset && npm run inject:preset，然后重启 DSH');
    });
  }
  writeFileSync(wiringPatch, '- insert: [');
  test('profile YAML 损坏必须格式化 FAIL 且无异常栈', () =>
    formattedFailure(runWiring(['--home', home]), '存在 preset-switchboard 声明'));
  writeFileSync(wiringPatch, wiringText(supervisorRules));
  for (const [label, text] of [
    ['roles 为 Object', '{"roles":{}}'], ['角色文件顶层 null', 'null'], ['角色 JSON 损坏', '{bad'],
    ['roles 含 null', '{"roles":[null]}'],
  ]) {
    writeFileSync(configPathFor(home), text);
    test(`${label} 必须格式化 FAIL 且无异常栈`, () =>
      formattedFailure(runWiring(['--home', home]), '配置文件可解析且含 roles 数组'));
  }
  writeFileSync(configPathFor(home), JSON.stringify({ roles: [] }));
  const pkgFile = join(profile, 'package.json');
  const validPkg = readFileSync(pkgFile, 'utf8');
  for (const [label, text] of [
    ['bundles 为 Object', JSON.stringify({ dsh: { profile: { bundles: {} } } })],
    ['package 顶层 null', 'null'], ['package JSON 损坏', '{bad'],
  ]) {
    writeFileSync(pkgFile, text);
    test(`${label} 必须格式化 FAIL 且无异常栈`, () =>
      formattedFailure(runWiring(['--home', home]), `dsh.profile.bundles 含 ${self}`));
  }
  writeFileSync(pkgFile, validPkg);

  // 仅在子进程拦截仓库文件读取，验证仓库侧结构错误；不改动真实生成物。
  const runRepoPatch = (relativePath, text) => {
    const script = join(REPO_ROOT, 'scripts', 'check-profile-wiring.mjs');
    const shim = `
      import fs from 'node:fs';
      import { fileURLToPath } from 'node:url';
      import { syncBuiltinESMExports } from 'node:module';
      const originalRead = fs.readFileSync;
      const target = ${JSON.stringify(join(REPO_ROOT, relativePath))};
      fs.readFileSync = (...args) => {
        const path = args[0] instanceof URL ? fileURLToPath(args[0]) : args[0];
        return path === target ? ${JSON.stringify(text)} : originalRead(...args);
      };
      syncBuiltinESMExports();
      process.argv = ${JSON.stringify([process.execPath, script, '--home', home])};
      await import(${JSON.stringify(pathToFileURL(script).href)});
    `;
    return captureSync(process.execPath, ['--input-type=module', '--eval', shim], { cwd: temp, env });
  };
  for (const [label, text] of [
    ['顶层 Object', '{}'], ['insert Object', `[{"insert":{"name":"${self}"}}]`], ['YAML 损坏', '- insert: ['],
  ]) test(`bundle patch ${label} 必须格式化 FAIL 且无异常栈`, () =>
    formattedFailure(runRepoPatch('cordis.patch.yml', text), 'bundle patch 里声明了本包条目'));
  for (const [label, mutate] of [
    ['顶层 Object', () => ({})],
    ['insert Object', doc => { doc[0].insert = doc[0].insert[0]; return doc; }],
    ['plugins Object', doc => { doc[0].insert[0].config.plugins = {}; return doc; }],
    ['preset 缺失', () => []],
    ['config 缺失', doc => { delete doc[0].insert[0].config.plugins[0].config; return doc; }],
    ['supervisorRules 非字符串', doc => { doc[0].insert[0].config.plugins[0].config.supervisorRules = 42; return doc; }],
  ]) test(`仓库 preset ${label} 必须格式化 FAIL 且无异常栈`, () => {
    const r = runRepoPatch('presets/switchboard.patch.yml', JSON.stringify(mutate(structuredClone(validPatch))));
    return formattedFailure(r, 'profile supervisorRules 与仓库 preset 生成物逐字符一致')
      && r.stdout.includes('npm run gen:preset && npm run inject:preset，然后重启 DSH');
  });

  console.log('\n=== 角色文件迁移与删源前复读 ===');
  const migration = join(REPO_ROOT, 'scripts', 'ops', 'migrate-roles-to-file.mjs');
  const seedRoles = [{ id: 'migration-fixture', title: 'Fixture', prompt: 'offline fixture', backend: 'spawn' }];
  const migrationText = `- insert:\n  - id: preset-switchboard\n    config:\n      plugins:\n      - id: switchboard-roles\n        name: "${self}"\n        config:\n          mount: true\n          provider: seed-provider\n          cwd: seed-cwd\n          maxDepth: 2\n          roles: ${JSON.stringify(seedRoles)}\n`;
  const fixture = (name, value) => {
    const home = join(temp, name);
    const profile = join(home, 'profiles', 'desktop');
    const patch = join(profile, 'cordis.patch.yml');
    const roles = configPathFor(home);
    mkdirSync(profile, { recursive: true });
    writeFileSync(patch, migrationText);
    if (value !== undefined) {
      mkdirSync(join(home, 'agent-switchboard'));
      writeFileSync(roles, JSON.stringify(value));
    }
    return { home, patch, roles };
  };
  const runMigration = (f, fault) => {
    const argv = [migration, '--apply', '--home', f.home];
    if (fault) {
      // Patch built-in exports only in this child; production imports still execute unchanged.
      const shim = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const target = ${JSON.stringify(f.roles)};
        const fault = ${JSON.stringify(fault)};
        const originalRead = fs.readFileSync;
        const originalWrite = fs.writeFileSync;
        const originalRename = fs.renameSync;
        let written = false;
        fs.renameSync = (...args) => {
          const result = originalRename(...args);
          if (args[1] === target) written = true;
          return result;
        };
        fs.readFileSync = (...args) => {
          if (written && args[0] === target && fault !== 'write-failure') {
            return JSON.stringify({ roles: fault === 'empty-reread' ? [] : [{ id: 'wrong-role' }] });
          }
          return originalRead(...args);
        };
        fs.writeFileSync = (...args) => {
          if (fault === 'write-failure' && String(args[0]).startsWith(target + '.')) {
            throw new Error('fixture seed write failure');
          }
          return originalWrite(...args);
        };
        syncBuiltinESMExports();
        process.argv = ${JSON.stringify([process.execPath, ...argv])};
        await import(${JSON.stringify(pathToFileURL(migration).href)});
      `;
      return captureSync(process.execPath, ['--input-type=module', '--eval', shim],
        { cwd: temp, env: { ...env, DSH_HOME: f.home } });
    }
    return captureSync(process.execPath, argv, { cwd: temp, env: { ...env, DSH_HOME: f.home } });
  };
  const profileConfig = f => parse(readFileSync(f.patch, 'utf8'))[0].insert[0].config.plugins[0].config;
  const readRoles = f => existsSync(f.roles) ? JSON.parse(readFileSync(f.roles, 'utf8')) : undefined;
  const wrapperOnly = {
    formatVersion: 7, roles: [], provider: 'existing-provider', cwd: 'existing-cwd', maxDepth: 4,
    volatile: { wrapperProvider: 'wrapper-route', wrapperModel: 'wrapper-model', wrapperEffort: 'high', cliTimeoutSec: 45 },
    custom: { retained: true },
  };
  for (const [label, value] of [['缺文件', undefined], ['空 roles 文件', { roles: [] }], ['wrapper-only 文件', wrapperOnly]]) {
    const f = fixture(`migration-success-${label}`, value);
    const result = runMigration(f);
    const after = readRoles(f);
    check(`${label}迁移成功`, result.status === 0 && /PASS  迁移完成/.test(result.stdout));
    check(`${label}播种 roles 与来源一致`, isDeepStrictEqual(after?.roles, seedRoles));
    check(`${label}源 config 只剩 mount:true`, isDeepStrictEqual(profileConfig(f), { mount: true }));
    check(`${label}保留已有字段并补齐默认值`, isDeepStrictEqual(after,
      { formatVersion: 1, provider: 'seed-provider', cwd: 'seed-cwd', maxDepth: 2, ...value, roles: seedRoles }));
  }
  const existingRoles = [{ id: 'existing-role', custom: true }];
  const populated = fixture('migration-existing-roles', { ...wrapperOnly, roles: existingRoles });
  const populatedResult = runMigration(populated);
  check('非空 roles 文件不覆盖且可完成迁移', populatedResult.status === 0
    && isDeepStrictEqual(readRoles(populated), { ...wrapperOnly, roles: existingRoles })
    && isDeepStrictEqual(profileConfig(populated), { mount: true }));
  for (const fault of ['empty-reread', 'mismatch-reread', 'write-failure']) {
    const f = fixture(`migration-${fault}`, wrapperOnly);
    const result = runMigration(f, fault);
    const output = result.stdout + result.stderr;
    check(`${fault}迁移必须失败`, result.status === 1 && /FAIL/.test(output));
    check(`${fault}失败必须原样保留 profile`, readFileSync(f.patch, 'utf8') === migrationText);
    check(`${fault}命中指定故障路径`, fault === 'write-failure'
      ? /fixture seed write failure/.test(output) && isDeepStrictEqual(readRoles(f), wrapperOnly)
      : /PASS  已播种配置文件/.test(output) && /删除 profile 角色前复读/.test(output)
        && isDeepStrictEqual(readRoles(f)?.roles, seedRoles));
  }

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
