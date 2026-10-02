// 历史检查入口原位迁移到专属工具与 runner，不调用任何真实 CLI。
// 用法：node scripts/check-cli-provider.mjs
import { createCliTool } from '../src/cli/provider.js';
import { validateArgs, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { runCli } from '../src/cli/runner.js';

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

const childExec = (signal) => ({ agent: { id: 'child-1', session: { header: { origin: 'subagent' } } }, signal });
/**
 * 造一个可控的 fake spawn。返回句柄与「被调用记录」。
 *
 * @param {object} plan - 计划好的结果。
 * @returns {{ spawn: Function, calls: object[] }}
 */
function makeSpawn(plan = {}) {
  const calls = [];
  const spawn = (spec) => {
    calls.push(spec);
    const stdout = plan.stdout ?? '';
    const stderr = plan.stderr ?? '';
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {
        stdout: {
          readFrom: (from) => ({
            text: from === 0 ? stdout : '',
            nextOffset: from === 0 ? stdout.length : from,
            lossy: false,
          }),
        },
        stderr: {
          readFrom: (from) => ({
            text: from === 0 ? stderr : '',
            nextOffset: from === 0 ? stderr.length : from,
            lossy: false,
          }),
        },
      },
      done: Promise.resolve({ exitCode: plan.exitCode ?? 0, signal: plan.signal ?? null }),
      terminate() {},
      waitForExit: async () => true,
    };
  };
  return { spawn, calls };
}

/** 一个合法的 cli 角色（默认 stdin 模式，codex 形态）。 */
function codexRole(overrides = {}) {
  return {
    id: 'scout',
    toolName: 'delegate_to_scout',
    backend: 'cli',
    model: 'gpt-6-luna',
    effort: 'medium',
    readOnly: true,
    cli: {
      promptDelivery: 'stdin',
      command: 'C:/node.exe',
      prefixArgs: ['C:/codex.js'],
      args: ['exec', '-s', 'read-only', '-m', '{model}', '-c', 'model_reasoning_effort={effort}', '-'],
      cwd: 'C:/work',
      graceMs: 3000,
      maxOutputBytes: 1_000_000,
      maxErrorBytes: 100_000,
      ...overrides,
    },
  };
}

section('专属工具定义：单一必填正文、有界结构化结果');
{
  const { spawn } = makeSpawn();
  const p = createCliTool({ role: codexRole(), spawn });
  check('工具名含角色后缀', p.name === 'switchboard_cli_run_scout', p.name);
  check('不再导出 provider 的 start/capabilities', !('start' in p) && !('capabilities' in p));
  check('parameters 只有 prompt', Object.keys(p.parameters.properties).join(',') === 'prompt');
  check('prompt 为必填 string', p.parameters.properties.prompt.type === 'string'
    && JSON.stringify(p.parameters.required) === '["prompt"]');
  for (const args of [{}, { prompt: 42 }, { prompt: null }, { prompt: ['T'] }]) {
    let refused = false;
    try { validateArgs(p.parameters, args); } catch { refused = true; }
    check(`参数 schema 拒绝非法正文 ${JSON.stringify(args)}`, refused);
  }
  check('output 为封闭对象且必需字段齐全', p.output.schema.type === 'object'
    && p.output.schema.additionalProperties === false
    && p.output.schema.required.includes('routeSummary') && p.output.schema.required.includes('cancelled'));
  check('缺少 cli 配置时抛错', (() => {
    try { createCliTool({ role: { id: 'x' }, spawn }); return false; } catch { return true; }
  })());
}

section('执行防御：只允许 subagent，拒绝时不能启动进程');
{
  const h = makeSpawn();
  const p = createCliTool({ role: codexRole(), spawn: h.spawn });
  for (const [label, exec] of [['缺少 exec', undefined], ['缺少 agent', {}], ['缺少 session', { agent: {} }],
    ['主代理', { agent: { session: { header: { origin: 'user' } } } }],
    ['其它 origin', { agent: { session: { header: { origin: 'other' } } } }]]) {
    let error;
    try { await p.execute({ prompt: 'T' }, exec); } catch (e) { error = e; }
    check(`非子代理拒绝：${label}`, error?.message.includes('仅供子代理执行') && h.calls.length === 0);
  }
  let invalid;
  try { await p.execute({ prompt: 1 }, childExec()); } catch (e) { invalid = e; }
  check('直接 execute 也拒绝非字符串', invalid instanceof Error && h.calls.length === 0);
}

section('argv 与 stdio：绑定配置，不接受模型覆盖');
{
  const role = codexRole();
  const { spawn, calls } = makeSpawn({ stdout: 'ANSWER', exitCode: 0 });
  const p = createCliTool({ role, spawn });
  // 注册后修改原对象不能改变已绑定的命令、参数、模型或 cwd。
  role.cli.command = 'malicious'; role.cli.args.push('--unconfigured'); role.model = 'wrong-model';
  const result = await p.execute({ prompt: 'the task', driver: 'other', cwd: 'wrong', readOnly: false,
    cliCommand: 'wrong', cliArgs: ['wrong'], model: 'wrong', instructions: 'wrong' }, childExec());
  check('spawn 被调用一次', calls.length === 1);
  const spec = calls[0];
  check('argv[0] 是绑定可执行文件', spec.argv[0] === 'C:/node.exe');
  check('prefixArgs 紧随其后', spec.argv[1] === 'C:/codex.js');
  check('model 来自注册快照', spec.argv.includes('gpt-6-luna'));
  check('effort 来自角色配置', spec.argv.includes('model_reasoning_effort=medium'));
  check('权限参数不能被调用参数改写', spec.argv.includes('read-only'));
  check('注册后模板变更不生效', !spec.argv.includes('--unconfigured'));
  check('stdin 模式：提示词不进 argv', !spec.argv.includes('the task'));
  check('stdin 模式：提示词经 stdin 传入', spec.stdio.stdin.data === 'the task');
  check('cwd 来自绑定配置', spec.cwd === 'C:/work');
  check('graceMs 来自配置', spec.graceMs === 3000);
  check('传入了 signal 字段', 'signal' in spec);
  check('成功状态与退出码', result.status === 'completed' && result.exitCode === 0 && result.signal === null);
  check('正文原样回传', result.stdout === 'ANSWER');
  check('正常完成不是取消', result.cancelled === false);
  check('工具结果通过实际 output schema', validateJsonSchemaValue(p.output.schema, result).length === 0);
  check('不回传完整 argv/实时日志', !('text' in result) && !('argv' in result) && !('logs' in result));
  check('render 只显示有界结果', p.output.render({}, result)[0].text === JSON.stringify(result));
}

section('argv 与 stdio：argv 模式');
{
  const { spawn, calls } = makeSpawn({ stdout: 'OK' });
  const p = createCliTool({ role: codexRole({ promptDelivery: 'argv', args: ['-p', '{prompt}'] }), spawn });
  await p.execute({ prompt: 'task text' }, childExec());
  check('argv 模式：提示词进入 argv', calls[0].argv.includes('task text'));
  check('argv 模式：stdin 为 ignore', calls[0].stdio.stdin === 'ignore');
}

section('promptFile 与角色指令：确定性前置、临时文件清理');
{
  for (const delivery of ['stdin', 'promptFile']) {
    const role = codexRole(delivery === 'promptFile' ? { promptDelivery: delivery, args: ['--prompt-file', '{prompt}'] } : {});
    role.instructions = 'ROLE-INSTRUCTIONS-SENTINEL';
    const h = makeSpawn({ stdout: 'OK' });
    let content;
    let path;
    const p = createCliTool({ role, spawn: spec => {
      if (delivery === 'promptFile') { path = spec.argv.at(-1); content = readFileSync(path, 'utf8'); }
      else content = spec.stdio.stdin.data;
      return h.spawn(spec);
    } });
    await p.execute({ prompt: '第一行\n第二行', instructions: 'OVERRIDE' }, childExec());
    check(`${delivery}：角色规则精确前置`, content === 'ROLE-INSTRUCTIONS-SENTINEL\n\n---\n\n第一行\n第二行');
    check(`${delivery}：不接受规则覆盖`, !content.includes('OVERRIDE'));
    check(`${delivery}：正文不进入 argv`, !h.calls[0].argv.some(a => a.includes('第一行')));
    if (delivery === 'promptFile') {
      check('promptFile：含配置 flag', h.calls[0].argv.includes('--prompt-file'));
      check('promptFile：路径不含换行', typeof path === 'string' && !/[\n\r]/.test(path));
      check('promptFile：stdin 为 ignore', h.calls[0].stdio.stdin === 'ignore');
      check('promptFile：运行后文件已清理', !existsSync(path));
    } else check('stdin：使用配置 stdin 通道', typeof h.calls[0].stdio.stdin === 'object');
  }
  const role = codexRole(); role.instructions = '   ';
  const h = makeSpawn();
  await createCliTool({ role, spawn: h.spawn }).execute({ prompt: 'ONLY TASK' }, childExec());
  check('空角色指令时不加分隔线', h.calls[0].stdio.stdin.data === 'ONLY TASK');
  const h2 = makeSpawn();
  const r = await createCliTool({ role: codexRole({ promptDelivery: 'argv', args: ['-p', '{prompt}'] }),
    spawn: h2.spawn }).execute({ prompt: 'line1\nline2' }, childExec());
  check('argv 多行正文被明确拒绝且不 spawn', h2.calls.length === 0 && r.status === 'start-failed');
  check('argv 错误说明换行限制', r.diagnostic.includes('换行'));
}

section('路由证据：配置摘要与 CLI 自报事实分别保留');
{
  const stderr = 'OpenAI Codex\nworkdir: C:/work\nmodel: actual-model\nprovider: openai\nsandbox: read-only\nreasoning effort: high';
  const h = makeSpawn({ stdout: 'BODY', stderr });
  const r = await createCliTool({ role: codexRole(), spawn: h.spawn }).execute({ prompt: 'T' }, childExec());
  check('摘要含配置 driver', r.routeSummary.includes('backend=cli(codex)'));
  check('摘要含配置模型', r.routeSummary.includes('model=gpt-6-luna'));
  check('摘要含实际 CLI 模型', r.routeSummary.includes('"model":"actual-model"'));
  check('摘要含实际 CLI 强度', r.routeSummary.includes('"reasoning effort":"high"'));
  check('摘要含实际 CLI 权限', r.routeSummary.includes('"sandbox":"read-only"'));
  check('stderr 保留自报事实', r.stderr === stderr);
  check('正文独立保留', r.stdout === 'BODY');
  const noFacts = await createCliTool({ role: codexRole(), spawn: makeSpawn().spawn }).execute({ prompt: 'T' }, childExec());
  check('未自报时不编造路由', noFacts.routeSummary.endsWith('cli-route={}') && !noFacts.routeSummary.includes('undefined'));
}

section('失败语义与解析器回退');
{
  const r = await createCliTool({ role: codexRole(), spawn: makeSpawn({ exitCode: 1,
    stderr: 'stream error: model not found' }).spawn }).execute({ prompt: 'T' }, childExec());
  check('非零退出分类为 process-failed', r.status === 'process-failed');
  check('退出码原样回传', r.exitCode === 1);
  check('失败 stderr 原样保留', r.stderr === 'stream error: model not found');
  check('失败不是取消', r.cancelled === false);
  const h = makeSpawn();
  const bad = await createCliTool({ role: codexRole({ args: ['exec', '{modle}', '-'] }), spawn: h.spawn })
    .execute({ prompt: 'T' }, childExec());
  check('模板错误不 spawn', h.calls.length === 0);
  check('模板错误归类 start-failed', bad.status === 'start-failed');
  check('模板错误保留诊断', bad.diagnostic.includes('参数模板错误'));
  const missing = await createCliTool({ role: codexRole(), spawn: () => { throw new Error('ENOENT'); } })
    .execute({ prompt: 'T' }, childExec());
  check('spawn 异常归类 start-failed', missing.status === 'start-failed');
  check('spawn 异常保留原始错误', missing.diagnostic.includes('ENOENT'));
  const h1 = makeSpawn();
  await createCliTool({ role: codexRole({ command: 'codex' }), spawn: h1.spawn,
    resolveExecutable: async cmd => `RESOLVED(${cmd})` }).execute({ prompt: 'T' }, childExec());
  check('使用解析后的可执行路径', h1.calls[0].argv[0] === 'RESOLVED(codex)');
  const h2 = makeSpawn();
  const fallback = await createCliTool({ role: codexRole({ command: 'codex' }), spawn: h2.spawn,
    resolveExecutable: async () => { throw new Error('lookup failed'); } }).execute({ prompt: 'T' }, childExec());
  check('解析失败回落字面命令', h2.calls[0].argv[0] === 'codex');
  check('解析回落后仍可成功', fallback.status === 'completed');
  const empty = await createCliTool({ role: codexRole(), spawn: makeSpawn().spawn }).execute({ prompt: 'T' }, childExec());
  check('无正文时仍报告成功退出', empty.status === 'completed');
  check('无正文诊断如实记录', empty.diagnostic.includes('没有输出内容'));
}

section('工具结果容量：正文、错误尾部、元信息与失败诊断均有界');
{
  const role = codexRole({ maxOutputBytes: 4, maxErrorBytes: 16 });
  const h = makeSpawn({ stdout: '中文abcdef', stderr: 'model: abc\n' + 'x'.repeat(100) + 'END-ERROR' });
  const p = createCliTool({ role, spawn: h.spawn });
  const r = await p.execute({ prompt: 'T' }, childExec());
  check('工具正文限制 UTF-8 字节数', Buffer.byteLength(r.stdout) <= 4 && r.stdout === '中');
  check('工具 stderr 有界且保留尾部', Buffer.byteLength(r.stderr) <= 16 && r.stderr.endsWith('END-ERROR'));
  check('工具显式标记两路截断', r.stdoutTruncated && r.stderrTruncated);
  const fail = await createCliTool({ role, spawn: () => { throw new Error('错'.repeat(5000)); } })
    .execute({ prompt: 'T' }, childExec());
  check('启动失败的 stderr 也受配置限制', Buffer.byteLength(fail.stderr) <= 16 && fail.stderrTruncated);
  check('诊断有固定容量且标记截断', Buffer.byteLength(fail.diagnostic) <= 4096 && fail.diagnosticTruncated);
  const huge = { ...role, model: 'm'.repeat(5000) };
  const route = await createCliTool({ role: huge, spawn: makeSpawn().spawn }).execute({ prompt: 'T' }, childExec());
  check('路由摘要有固定容量且标记截断', Buffer.byteLength(route.routeSummary) <= 4096 && route.routeSummaryTruncated);
  check('截断结果仍通过实际 output schema', validateJsonSchemaValue(p.output.schema, r).length === 0);
}

// 取消代替旧超时保护，并覆盖清理、退出竞态和未来工具的回流接口。
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function controlledSpawn() {
  let finish;
  let reject;
  let aborted = false;
  const calls = [];
  let cleanups = 0;
  const spawn = spec => {
    calls.push(spec);
    const done = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
    const onAbort = () => { aborted = true; finish({ exitCode: null, signal: 'SIGTERM' }); };
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    // 假适配器也履行 subprocess 的监听器所有权，避免测桩自身泄漏。
    const settled = done.finally(() => {
      cleanups++;
      spec.signal?.removeEventListener('abort', onAbort);
    });
    return { done: settled, collected: {}, terminate() { finish({ exitCode: null, signal: 'SIGTERM' }); },
      waitForExit: async () => true };
  };
  return { spawn, calls, finish: () => finish({ exitCode: 0, signal: null }),
    reject: () => reject(new Error('done failed')), aborted: () => aborted, cleanups: () => cleanups };
}

section('无运行期限：源码不含期限参数或计时终止');
{
  const runner = readFileSync(new URL('../src/cli/runner.js', import.meta.url), 'utf8');
  const provider = readFileSync(new URL('../src/cli/provider.js', import.meta.url), 'utf8');
  const host = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  check('执行器和 provider 无 timeoutMs / setTimeout / timedOutByUs',
    !/timeoutMs|setTimeout|timedOutByUs/.test(runner + provider));
  check('Host 不读取或注入运行期限', !/const cliTimeoutSec|timeoutMs:|cliTimeoutSec:\s*z\./.test(host));
}

section('取消：信号直通、终止、分类、审计与资源清理');
{
  const ac = new AbortController();
  const h = controlledSpawn();
  const role = codexRole({ promptDelivery: 'promptFile', args: ['--prompt-file', '{prompt}'] });
  const p = createCliTool({ role, spawn: h.spawn });
  const started = p.execute({ prompt: 'CANCEL ME' }, childExec(ac.signal));
  const path = h.calls[0].argv.at(-1);
  check('运行中提示词文件存在', existsSync(path));
  check('request.signal 原样传入 spawn', h.calls[0].signal === ac.signal);
  ac.abort();
  const result = await started;
  check('调用方取消 → 子进程被中止', h.aborted());
  check('取消 → status cancelled', result.status === 'cancelled' && result.signal === 'SIGTERM');
  check('取消标记为 true', result.cancelled === true);
  check('取消原因是 cancelled 而不是 timeout', result.status === 'cancelled' && !/timeout|timedOut/.test(result.diagnostic));
  check('取消仍有路由摘要', result.routeSummary.includes('backend=cli'));
  check('取消后临时提示词文件已清理', !existsSync(path));
  check('取消后全部 abort 监听器已移除', getEventListeners(ac.signal, 'abort').length === 0);
}

section('已取消信号与解析期间取消：不得启动新进程');
{
  const ac = new AbortController();
  ac.abort();
  const h = makeSpawn();
  const result = await runCli({ role: codexRole(), prompt: 'T', signal: ac.signal, spawn: h.spawn });
  check('预取消不 spawn 且终态 cancelled', h.calls.length === 0 && result.status === 'cancelled');
  check('预取消不留监听器', getEventListeners(ac.signal, 'abort').length === 0);
  const ac2 = new AbortController();
  let release;
  let promptPath;
  const { readdirSync } = await import('node:fs');
  const before = new Set(readdirSync(tmpdir()));
  const role = codexRole({ promptDelivery: 'promptFile', args: ['--prompt-file', '{prompt}'] });
  const task = runCli({ role, prompt: 'T', signal: ac2.signal, spawn: h.spawn,
    resolveExecutable: () => new Promise(resolve => {
      release = resolve;
      promptPath = readdirSync(tmpdir()).find(name => name.startsWith('switchboard-prompt-') && !before.has(name));
    }) });
  ac2.abort();
  release('fake');
  const r2 = await task;
  check('解析期间取消不 spawn 且终态 cancelled', h.calls.length === 0 && r2.status === 'cancelled');
  check('解析期间取消清除监听器', getEventListeners(ac2.signal, 'abort').length === 0);
  check('解析期间取消清理提示词文件', Boolean(promptPath) && !existsSync(join(tmpdir(), promptPath)));
}

section('失败路径统一清理：模板、启动和 done 拒绝');
{
  for (const [name, args, spawn, status] of [
    ['模板失败', ['{bad}'], () => { throw new Error('不应 spawn'); }, 'start-failed'],
    ['启动失败', ['{prompt}'], () => { throw new Error('ENOENT'); }, 'start-failed'],
    ['done 拒绝', ['{prompt}'], () => ({ done: Promise.reject(new Error('done failed')),
      terminate() {}, waitForExit: async () => true }), 'process-failed'],
  ]) {
    let file;
    const ac = new AbortController();
    const role = codexRole({ promptDelivery: 'promptFile', args });
    // 文件名从临时目录的新增文件获取，模板失败时没有 spawn argv 可查。
    const { readdirSync } = await import('node:fs');
    const before = new Set(readdirSync(tmpdir()));
    const r = await runCli({ role, prompt: 'T', signal: ac.signal,
      resolveExecutable: async command => {
        file = readdirSync(tmpdir()).find(name => name.startsWith('switchboard-prompt-') && !before.has(name));
        return command;
      }, spawn });
    check(`${name}：独立终态分类`, r.status === status);
    check(`${name}：临时提示词已清理`, Boolean(file) && !existsSync(join(tmpdir(), file)));
    check(`${name}：监听器已移除`, getEventListeners(ac.signal, 'abort').length === 0);
  }
}

section('取消与正常退出竞态：只有一个终态，不被后续取消改写');
{
  for (const order of ['cancel-first', 'done-observed', 'same-turn']) {
    const label = { 'cancel-first': '取消先发生', 'done-observed': '完成先被观察', 'same-turn': '退出与取消同一轮发生' }[order];
    const ac = new AbortController();
    const h = controlledSpawn();
    let terminals = 0;
    const task = runCli({ role: codexRole(), prompt: 'T', signal: ac.signal, spawn: h.spawn });
    task.then(() => { terminals++; });
    if (order === 'cancel-first') { ac.abort(); h.finish(); }
    else if (order === 'same-turn') { h.finish(); ac.abort(); }
    else { h.finish(); await task; ac.abort(); }
    const result = await task;
    await delay(0);
    check(`${label}：终态只产生一次`, terminals === 1 && h.cleanups() === 1);
    check(`${label}：终态分类固定`, result.status === (order === 'done-observed' ? 'completed' : 'cancelled'));
    check(`${label}：无残留监听器`, getEventListeners(ac.signal, 'abort').length === 0);
  }
}

section('输出容量和回流：截断标志、sink 隔离与完成后取消');
{
  const ac = new AbortController();
  const role = codexRole({ maxOutputBytes: 4, maxErrorBytes: 8 });
  const base = makeSpawn({ stdout: '0123456789', stderr: 'model: abc\n' });
  let events = 0;
  const result = await runCli({ role, prompt: 'T', signal: ac.signal, spawn: base.spawn,
    onOutput: async () => { events++; ac.abort(); throw new Error('sink offline'); } });
  check('输出上限仍传入 subprocess', base.calls[0].stdio.stdout.maxBytes === 4 && base.calls[0].stdio.stderr.maxBytes === 8);
  check('stdout 和 stderr 均受容量限制', Buffer.byteLength(result.stdout) <= 4 && Buffer.byteLength(result.stderr) <= 8);
  check('两路截断在结果和正文标记', result.stdoutTruncated && result.stderrTruncated
    && result.text.includes('stdout 已截断') && result.text.includes('stderr 已截断'));
  check('sink 接收两路输出，失败只记诊断', events === 2 && result.diagnostic.includes('sink offline'));
  check('done 后 sink 期间取消不改写 completed', result.status === 'completed');
  check('sink 失败也清除监听器', getEventListeners(ac.signal, 'abort').length === 0);
  const lossy = await runCli({ role: codexRole(), prompt: 'T', spawn: () => ({
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: { stdout: { readFrom: () => ({ text: 'tail', nextOffset: 0, lossy: true }) } },
  }) });
  check('收集器 lossy 标志保留为截断', lossy.stdoutTruncated && lossy.text.includes('stdout 已截断'));
  const unicode = await runCli({ role, prompt: 'T', spawn: makeSpawn({ stdout: '中文字符' }).spawn });
  check('UTF-8 截断不切坏字符或超过容量', unicode.stdout === '中' && Buffer.byteLength(unicode.stdout) <= 4);
}

section('假 CLI 真进程：长时无自行终止，手动取消与成功清理');
{
  const dir = mkdtempSync(join(tmpdir(), 'switchboard-runner-'));
  const script = join(dir, 'fake-cli.mjs');
  writeFileSync(script, `import { existsSync, readFileSync } from 'node:fs';
console.log('READY ' + process.pid + ' ' + readFileSync(process.argv[2], 'utf8'));
console.error('model: fake-model');
const timer = setInterval(() => { if (existsSync(process.argv[3])) { clearInterval(timer); console.log('FINISHED'); } }, 10);
`);
  let active;
  const spawn = spec => {
    const out = join(dir, 'stdout');
    const err = join(dir, 'stderr');
    const fds = [openSync(out, 'w'), openSync(err, 'w')];
    const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), { cwd: dir, shell: false, windowsHide: true,
      stdio: ['ignore', ...fds] });
    active = child;
    const onAbort = () => child.kill();
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    const reader = path => ({ readFrom: from => {
      const bytes = readFileSync(path);
      return { text: bytes.subarray(from).toString('utf8'), nextOffset: bytes.length, lossy: false };
    } });
    const done = new Promise((resolve, reject) => {
      let error;
      child.on('error', e => { error = e; });
      child.on('close', (exitCode, signal) => {
        spec.signal?.removeEventListener('abort', onAbort);
        fds.forEach(closeSync);
        if (error) reject(error); else resolve({ exitCode, signal });
      });
    });
    return { done, collected: { stdout: reader(out), stderr: reader(err) },
      terminate: () => child.kill(), waitForExit: () => done.then(() => true, () => true) };
  };
  try {
    for (const cancel of [false, true]) {
      const flag = join(dir, cancel ? 'cancel-run' : 'exit-run');
      const ac = new AbortController();
      const role = codexRole({ command: process.execPath, prefixArgs: [script],
        promptDelivery: 'promptFile', args: ['{prompt}', flag], cwd: dir });
      let terminals = 0;
      let streamed = '';
      const task = runCli({ role, prompt: 'MULTI\nLINE', spawn, signal: ac.signal,
        onOutput: event => { streamed += event.text; } });
      task.then(() => { terminals++; });
      // 超过旧配置最小期限 1 秒；没有自然退出指令时必须仍存活。
      await delay(1150);
      check(`${cancel ? '取消运行' : '正常运行'}：长时进程仍存活`, active.exitCode === null && active.signalCode === null && terminals === 0);
      check(`${cancel ? '取消运行' : '正常运行'}：终态前已回流输出`, streamed.includes('READY') && streamed.includes('fake-model'));
      const output = readFileSync(join(dir, 'stdout'), 'utf8');
      // 直接从适配器 argv 捕获提示词路径，而不解析输出中的用户内容。
      const promptPath = active.spawnargs[2];
      check(`${cancel ? '取消运行' : '正常运行'}：假 CLI 已读多行提示词`, output.includes('MULTI\nLINE') && existsSync(promptPath));
      if (cancel) ac.abort(); else writeFileSync(flag, 'exit');
      const result = await task;
      check(`${cancel ? '取消运行' : '正常运行'}：分类正确`, result.status === (cancel ? 'cancelled' : 'completed'));
      check(`${cancel ? '取消运行' : '正常运行'}：进程确已退出`, active.exitCode !== null || active.signalCode !== null);
      check(`${cancel ? '取消运行' : '正常运行'}：提示词文件已清理`, !existsSync(promptPath));
      check(`${cancel ? '取消运行' : '正常运行'}：终态唯一且监听器清理`, terminals === 1 && getEventListeners(ac.signal, 'abort').length === 0);
    }
    for (const cancel of [false, true]) {
      const flag = join(dir, cancel ? 'tool-cancel' : 'tool-exit');
      const ac = new AbortController();
      const role = codexRole({ command: process.execPath, prefixArgs: [script], promptDelivery: 'promptFile',
        args: ['{prompt}', flag], cwd: dir, maxOutputBytes: 12, maxErrorBytes: 20 });
      role.instructions = 'TOOL-RULES';
      const tool = createCliTool({ role, spawn });
      let terminals = 0;
      const task = tool.execute({ prompt: 'TOOL-TASK' }, childExec(ac.signal));
      task.then(() => { terminals++; });
      for (let guard = 0; guard < 100; guard++) {
        if (existsSync(join(dir, 'stdout')) && readFileSync(join(dir, 'stdout'), 'utf8').includes('TOOL-TASK')) break;
        await delay(20);
      }
      const label = cancel ? '专属工具取消' : '专属工具完成';
      const promptPath = active.spawnargs[2];
      check(`${label}：工具拉起真实 Node 假 CLI 且 argv 正确`, active.spawnargs[0] === process.execPath
        && active.spawnargs[1] === script && active.spawnargs[3] === flag && active.spawnargs.length === 4);
      check(`${label}：假 CLI 读取确定性前置的规则与正文`,
        readFileSync(join(dir, 'stdout'), 'utf8').includes('TOOL-RULES\n\n---\n\nTOOL-TASK'));
      check(`${label}：工具等待完成，不提前返回`, terminals === 0 && existsSync(promptPath));
      if (cancel) ac.abort(); else writeFileSync(flag, 'exit');
      const result = await task;
      check(`${label}：有界正文与截断标记`, Buffer.byteLength(result.stdout) <= 12 && result.stdoutTruncated);
      check(`${label}：有界 stderr 与实际路由证据`, Buffer.byteLength(result.stderr) <= 20
        && result.routeSummary.includes('fake-model'));
      check(`${label}：状态与取消标记正确`, result.status === (cancel ? 'cancelled' : 'completed')
        && result.cancelled === cancel && (cancel ? result.signal !== null : result.exitCode === 0));
      check(`${label}：退出后文件与信号监听器清理`, !existsSync(promptPath)
        && getEventListeners(ac.signal, 'abort').length === 0 && terminals === 1);
    }
  } finally {
    if (active && active.exitCode === null && active.signalCode === null) active.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
