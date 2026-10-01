// 四个配置驱动探针共用的调用边界；不发现入口，不读取 .env。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCliConfig, cliInvocation } from './cli-config.mjs';
import { PATH_FLAGS, parsePathArgs, pathValue, REPO_ROOT } from './paths.mjs';

export function probeConfig(group, { output = false } = {}) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(`用法：node scripts/probes/probe-${group === 'codex' ? 'codex' : `cli-${group}`}.mjs --cli-config <JSON.local> [--cwd <目录>]${output ? ' [--out-dir <目录>]' : ''}`);
    console.log(`配置来源：--cli-config > SWITCHBOARD_CLI_CONFIG；必须提供。执行 cases 中名称以 ${group}. 开头的用例。`);
    console.log('复制 scripts/cli-probes.example.json 为 *.local，替换虚构入口、模型与 cwd；CLI 参数候选须自行核实。');
    process.exit(0);
  }
  const options = parsePathArgs(argv, [...PATH_FLAGS, ...(output ? ['out-dir'] : [])]);
  const pathArgs = Object.entries(options).filter(([key]) => key !== 'out-dir').flatMap(([key, value]) => [`--${key}`, value]);
  const loaded = loadCliConfig({ argv: pathArgs });
  const names = Object.keys(loaded.config.cases).filter(name => name.startsWith(`${group}.`));
  if (!names.length) throw new Error(`配置缺少 ${group}. 开头的 CLI 用例`);
  console.log(`CLI 配置：${loaded.file} [${loaded.source}]`);
  return { loaded, names, pathArgs,
    outDir: output ? pathValue(options['out-dir'] ?? join(REPO_ROOT, 'raw', 'codex-probe'), '--out-dir', process.cwd()) : undefined };
}

// 隐去常见凭据参数；执行时仍使用原始数组，不修改用户参数。
function visibleArgs(argv) {
  let secretNext = false;
  return argv.map(arg => {
    if (secretNext) { secretNext = false; return '[已隐藏]'; }
    if (/^--?(?:[\w-]*[-_])?(?:api[-_]?key|token|secret|password|authorization)$/i.test(arg)) secretNext = true;
    return arg.replace(/((?:api[-_]?key|token|secret|password|authorization)=).*/i, '$1[已隐藏]');
  });
}

export async function runProbe(config, name, prompt, timeout, { maxBuffer = 1024 * 1024, env = process.env } = {}) {
  let temp;
  try {
    const delivery = config.loaded.config.cases[name].promptDelivery;
    let value = prompt;
    if (delivery === 'promptFile') {
      temp = mkdtempSync(join(tmpdir(), 'switchboard-prompt-'));
      value = join(temp, 'prompt.txt');
      writeFileSync(value, prompt, 'utf8');
    }
    // stdin 提示词不参与 argv 值校验（允许多行）。
    const invocation = cliInvocation(config.loaded, name, { prompt: delivery === 'stdin' ? undefined : value }, { argv: config.pathArgs });
    console.log(`command: ${JSON.stringify(invocation.command)}`);
    console.log(`argv: ${JSON.stringify(visibleArgs(invocation.argv))}`);
    console.log(`提示词传递: ${delivery}`);
    const started = Date.now();
    const result = await new Promise(resolve => {
      const child = spawn(invocation.command, invocation.argv, {
        ...invocation.options, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      let error;
      let bytes = 0;
      const timer = setTimeout(() => { error = new Error(`CLI 超时 (${timeout}ms)`); child.kill(); }, timeout);
      const collect = target => chunk => {
        bytes += chunk.length;
        if (bytes > maxBuffer) { error ??= new Error(`CLI 输出超过 ${maxBuffer} 字节`); child.kill(); }
        else target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.on('error', cause => { error = cause; });
      child.stdin.on('error', cause => { if (cause.code !== 'EPIPE') { error = cause; child.kill(); } });
      child.on('close', (status, signal) => {
        clearTimeout(timer);
        resolve({ status, signal, error, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      });
      child.stdin.end(delivery === 'stdin' ? prompt : '');
    });
    if (result.error || result.status !== 0) {
      process.exitCode = 1;
      console.error(`CLI 用例 ${name} 失败：${result.error?.message ?? `退出码 ${result.status}，信号 ${result.signal ?? '-'}`}`);
    }
    return { ...result, elapsedMs: Date.now() - started, invocation };
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}
