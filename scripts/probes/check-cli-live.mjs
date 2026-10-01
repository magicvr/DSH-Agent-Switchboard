// 可选 live 检查：读取插件既有 roles.json，复用真实派发的 argv + 输出解析层。
// 不属于 npm run check；不会发现或猜测 CLI 安装位置，不读取 .env。
// 用法：npm run check:live -- --roles-file <JSON.local> --role <角色 id>
import { captureSync } from '../lib/capture.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInvocation } from '../../src/cli/argv.js';
import { formatRunResult } from '../../src/cli/output.js';
import { readConfigFile, normalizeConfigShape } from '../../src/config-file.js';
import { normalizeRoles } from '../../src/roles.js';
import { validateCliConfig } from '../lib/cli-config.mjs';
import { PATH_FLAGS, parsePathArgs, resolvePaths, printPaths } from '../lib/paths.mjs';

const MARKER = 'SWITCHBOARD_LIVE_OK';
let pass = 0;
let fail = 0;
function check(label, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (condition) pass++; else fail++;
}

// 与探针相同的凭据隐藏边界；解析层的 argv 审计也使用隐藏后的副本。
function visibleArgs(argv) {
  let secretNext = false;
  return argv.map(arg => {
    if (secretNext) { secretNext = false; return '[已隐藏]'; }
    if (/^--?(?:[\w-]*[-_])?(?:api[-_]?key|token|secret|password|authorization)$/i.test(arg)) secretNext = true;
    return arg.replace(/((?:api[-_]?key|token|secret|password|authorization)=).*/i, '$1[已隐藏]');
  });
}

let temp;
try {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('用法：node scripts/probes/check-cli-live.mjs --role <角色 id> [--roles-file <JSON.local>] [--home <DSH home>] [--cwd <目录>]');
    console.log('读取 --roles-file 或 DSH_HOME/agent-switchboard/roles.json；必须显式选择一个 CLI 角色。此命令会调用配置的 CLI。');
  } else {
    const options = parsePathArgs(argv, [...PATH_FLAGS.filter(key => key !== 'cli-config'), 'role']);
    const pathArgs = Object.entries(options).filter(([key]) => key !== 'role').flatMap(([key, value]) => [`--${key}`, value]);
    const initialPaths = resolvePaths({ argv: pathArgs });
    const loaded = readConfigFile(initialPaths.roles);
    if (!loaded.ok) throw new Error(`角色配置无效：${loaded.error}`);
    if (loaded.missing) throw new Error(`缺少角色配置：${initialPaths.roles}；请提供 --roles-file 或配置 DSH_HOME`);
    if (!options.role) throw new Error('请提供 --role，显式选择一个 CLI 角色');
    const config = normalizeConfigShape(loaded.value);
    const normalized = normalizeRoles(config.roles, config.provider, options.cwd ?? config.cwd);
    if (normalized.errors.length) throw new Error(`角色配置无效：${normalized.errors.join('；')}`);
    const role = normalized.roles.find(item => item.id === options.role);
    if (!role || role.backend !== 'cli') throw new Error(`未找到 CLI 角色：${options.role}`);
    // 补足命令、prefixArgs、控制字符及合并模板校验，使用批次 2b 的既有边界。
    validateCliConfig({ cases: { live: { ...role.cli, model: role.model, effort: role.effort } } });
    const paths = resolvePaths({ argv: pathArgs, cliCwd: role.cli.cwd });
    printPaths(paths);
    const prompt = `Reply with exactly this token and nothing else: ${MARKER}`;
    const delivery = role.cli.promptDelivery;
    let promptValue = delivery === 'argv' ? prompt : undefined;
    if (delivery === 'promptFile') {
      temp = mkdtempSync(join(tmpdir(), 'switchboard-live-'));
      promptValue = join(temp, 'prompt.txt');
      writeFileSync(promptValue, prompt, 'utf8');
    }
    // 与 src/cli/provider.js 相同的调用构造；完整 argv 的首元素是 command。
    const invocation = buildInvocation({
      command: role.cli.command, prefixArgs: role.cli.prefixArgs, args: role.cli.args,
      values: { model: role.model, effort: role.effort, cwd: paths.cwd, prompt: promptValue },
    });
    const auditArgv = visibleArgs(invocation.argv);
    console.log(`command: ${JSON.stringify(invocation.argv[0])}`);
    console.log(`argv: ${JSON.stringify(auditArgv.slice(1))}`);
    console.log(`提示词传递: ${delivery}`);
    check('argv[0] 来自角色 command', invocation.argv[0] === role.cli.command);
    check('prefixArgs 与角色配置一致', role.cli.prefixArgs.every((value, index) => invocation.argv[index + 1] === value));
    check('stdin 模式不把提示词放进 argv', delivery !== 'stdin' || !invocation.argv.some(arg => arg.includes(MARKER)));
    const started = Date.now();
    const result = captureSync(invocation.argv[0], invocation.argv.slice(1), {
      cwd: paths.cwd, input: delivery === 'stdin' ? prompt : undefined,
      timeout: role.cli.timeoutMs ?? 180000, shell: false, windowsHide: true,
      maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' },
    });
    if (result.error) console.error(`CLI 启动/运行失败：${result.error.code ?? '未知错误'}`);
    const formatted = formatRunResult({
      roleId: role.id, command: invocation.argv[0], argv: auditArgv,
      exitCode: result.status, signal: result.signal, timedOut: result.error?.code === 'ETIMEDOUT',
      stdout: result.stdout ?? '', stderr: result.stderr ?? '', durationMs: Date.now() - started,
    });
    console.log(`退出=${result.status} stdout=${(result.stdout ?? '').length}B stderr=${(result.stderr ?? '').length}B`);
    check('退出码为 0 且无运行错误', !result.error && result.status === 0);
    check('解析判定为成功', formatted.ok === true);
    check('正文含标记（提示词确实送达）', (result.stdout ?? '').includes(MARKER));
    // 路由事实是诊断证据；不同 CLI 不保证自报，按已报告字段核对配置。
    if (Object.keys(formatted.route).length) {
      if (formatted.route.model !== undefined) check('自报模型与角色配置一致', formatted.route.model === role.model);
      if (role.effort !== undefined && formatted.route['reasoning effort'] !== undefined) {
        check('自报强度与角色配置一致', formatted.route['reasoning effort'] === role.effort);
      }
    } else console.log('cli-route：CLI 未自报路由事实（模型/强度生效未验证）');
    check('正文含 role 标注', formatted.text.includes(`role=${role.id}`));
    check('正文含 argv 审计信息', formatted.text.includes(`[switchboard] argv=${JSON.stringify(auditArgv)}`));
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    if (fail) process.exitCode = 1;
  }
} catch (error) {
  console.error(`CLI live 检查失败：${error.message}`);
  process.exitCode = 1;
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true });
}
