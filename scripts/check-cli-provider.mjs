// CLI provider 的离线验证：注入 fake spawn，不调用任何真实 CLI。
// 用法：node scripts/check-cli-provider.mjs
import {
  CLI_CAPABILITIES,
  CLI_INHERITS_PARENT_CONTEXT,
  createCliProvider,
  promptText,
} from '../src/cli/provider.js';
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

/** 造一个只含 text 块的 prompt。 */
const textPrompt = (t) => [{ type: 'text', text: t }];

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
      ...overrides,
    },
  };
}

section('promptText');
{
  const a = promptText(textPrompt('hello'));
  check('单文本块', a.text === 'hello' && a.ignoredBlocks.length === 0);

  const b = promptText([
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ]);
  check('多文本块以换行连接', b.text === 'a\nb', JSON.stringify(b.text));

  const c = promptText([
    { type: 'text', text: 'keep' },
    { type: 'image', attachment: {} },
    { type: 'file', attachment: {} },
  ]);
  check('忽略非文本块但如实记录类型', c.text === 'keep' && c.ignoredBlocks.join(',') === 'image,file', JSON.stringify(c));

  check('非数组输入 → 空', promptText(undefined).text === '' && promptText('nope').text === '');
  check('无 text 字段的块被忽略', promptText([{ type: 'text' }]).text === '');
}

section('provider 元信息');
{
  const { spawn } = makeSpawn();
  const p = createCliProvider({ role: codexRole(), spawn });
  check('provider 名含角色 id', p.name === 'switchboard-cli-scout', p.name);
  check('capabilities 全为 false', Object.values(p.capabilities).every((v) => v === false));
  check('capabilities 与导出常量一致', JSON.stringify(p.capabilities) === JSON.stringify(CLI_CAPABILITIES));
  check('不继承父上下文', p.inheritsParentContext === false && CLI_INHERITS_PARENT_CONTEXT === false);
  check('缺少 cli 配置时抛错', (() => {
    try {
      createCliProvider({ role: { id: 'x' }, spawn });
      return false;
    } catch {
      return true;
    }
  })());
}

section('argv 与 stdio：stdin 模式');
{
  const role = codexRole();
  const { spawn, calls } = makeSpawn({ stdout: 'ANSWER', exitCode: 0 });
  const p = createCliProvider({ role, spawn });
  const run = await p.start({ prompt: textPrompt('the task'), parent: { id: 'parent-1' } });

  check('spawn 被调用一次', calls.length === 1);
  const spec = calls[0];
  // argv[0] 是可执行文件，其后是 prefixArgs（node 形态下是脚本路径），再后是模板。
  check('argv[0] 是可执行文件', spec.argv[0] === 'C:/node.exe', JSON.stringify(spec.argv));
  check('prefixArgs 紧随其后', spec.argv[1] === 'C:/codex.js', JSON.stringify(spec.argv));
  // 占位符取自**角色顶层**的 model/effort（同一字段在 builtin 后端下是 DSH route，
  // 在 cli 后端下是外部 CLI 的模型 id —— 命名空间不同但只应有一个来源，见 D12）。
  check('role.model 占位符已替换', spec.argv.includes('gpt-6-luna'), JSON.stringify(spec.argv));
  check('role.effort 占位符已替换', spec.argv.includes('model_reasoning_effort=medium'), JSON.stringify(spec.argv));
  check('stdin 模式：提示词不进 argv', !spec.argv.includes('the task'), JSON.stringify(spec.argv));
  check('stdin 模式：提示词经 stdin 传入', JSON.stringify(spec.stdio.stdin) === JSON.stringify({ data: 'the task' }));
  check('cwd 来自配置', spec.cwd === 'C:/work');
  check('graceMs 来自配置', spec.graceMs === 3000);
  check('传入了 abort signal 字段', 'signal' in spec);

  const result = await run.result;
  check('run.localAgent 为 undefined', run.localAgent === undefined);
  check('成功 → stopReason completed', result.stopReason === 'completed', result.stopReason);
  check('正文回传', result.output[0].text.includes('ANSWER'));
  check('structured 含退出码', result.structured.exitCode === 0);
  check('dispose 可调用', typeof run.dispose === 'function');
}

section('argv 与 stdio：argv 模式');
{
  const role = codexRole({ promptDelivery: 'argv', args: ['-p', '{prompt}'] });
  const { spawn, calls } = makeSpawn({ stdout: 'OK' });
  const p = createCliProvider({ role, spawn });
  await (await p.start({ prompt: textPrompt('task text') })).result;

  check('argv 模式：提示词进入 argv', calls[0].argv.includes('task text'), JSON.stringify(calls[0].argv));
  check('argv 模式：stdin 为 ignore', calls[0].stdio.stdin === 'ignore');
}

section('argv 与 stdio：promptFile 模式');
{
  // 为什么需要这个模式：`argv` 模式把提示词当命令行参数，而**参数值不得含换行**
  // （见 cli/argv.js），真实提示词几乎都是多行的。`promptFile` 把提示词写进临时文件、
  // 只把**路径**放进 argv，从而绕开该限制。grok 就依赖它（`--prompt-file`）。
  const role = codexRole({ promptDelivery: 'promptFile', args: ['--prompt-file', '{prompt}'] });
  const { spawn, calls } = makeSpawn({ stdout: 'OK' });
  const p = createCliProvider({ role, spawn });
  // 刻意用**多行**提示词：这正是 argv 模式会失败的输入。
  await (await p.start({ prompt: textPrompt('第一行\n第二行') })).result;

  const argv = calls[0].argv;
  const fileIdx = argv.indexOf('--prompt-file');
  check('promptFile 模式：含 --prompt-file', fileIdx !== -1, JSON.stringify(argv));
  const path = fileIdx === -1 ? undefined : argv[fileIdx + 1];
  check('promptFile 模式：其后是一个文件路径', typeof path === 'string' && path.length > 0, String(path));
  check('promptFile 模式：提示词本体**不进** argv', !argv.some((a) => a.includes('第一行')), JSON.stringify(argv));
  check(
    'promptFile 模式：路径不含换行（这正是它能绕开限制的原因）',
    typeof path === 'string' && !/[\n\r]/.test(path),
    String(path),
  );
  check('promptFile 模式：stdin 为 ignore（提示词走文件，不走 stdin）', calls[0].stdio.stdin === 'ignore');
  check('promptFile 模式：运行结束后临时文件已清理', path !== undefined && !existsSync(path), String(path));
}

section('回传日志必须让主代理看得出「走了哪条线路」');
{
  // ⚠️ 主代理需要把「角色本该走哪条线路」与「实际走了哪条」对上。因此日志里要有一行
  //    线路摘要，且措辞与系统提示词的 `routeSummaryFor` 一致（同一套措辞才能对照）。
  const { spawn } = makeSpawn({ stdout: 'BODY' });
  const p = createCliProvider({
    role: codexRole(),
    spawn,
    routeSummary: 'backend=cli(codex) model=gpt-6-luna effort=medium',
  });
  const result = await (await p.start({ prompt: textPrompt('t') })).result;
  const text = result.output[0].text;
  check('日志含线路摘要行', text.includes('[switchboard] 线路=backend=cli(codex)'), text.slice(0, 240));
  check('线路摘要含模型', text.includes('model=gpt-6-luna'), text.slice(0, 240));
  check('日志仍含 role 行', text.includes('[switchboard] role='), text.slice(0, 240));

  // 未提供摘要时不得出现半截的 `线路=undefined`（退化输入）。
  const { spawn: spawn2 } = makeSpawn({ stdout: 'BODY' });
  const p2 = createCliProvider({ role: codexRole(), spawn: spawn2 });
  const text2 = (await (await p2.start({ prompt: textPrompt('t') })).result).output[0].text;
  check('未提供摘要时不输出 undefined', !text2.includes('[switchboard] 线路=undefined'), text2.slice(0, 200));
  check(
    '未提供摘要时日志仍完整',
    text2.includes('[switchboard] role=') && text2.includes('[switchboard] argv='),
  );
}

section('路由事实被抽入 structured 与正文');
{
  const stderr = [
    'OpenAI Codex v0.159.2',
    '--------',
    'workdir: C:/work',
    'model: gpt-6-astra',
    'provider: openai',
    'sandbox: read-only',
    'reasoning effort: high',
  ].join('\n');
  const { spawn } = makeSpawn({ stdout: 'BODY', stderr });
  const p = createCliProvider({ role: codexRole(), spawn });
  const result = await (await p.start({ prompt: textPrompt('t') })).result;

  check('structured.cliRoute.model 正确', result.structured.cliRoute.model === 'gpt-6-astra');
  check('structured.cliRoute 含 strength', result.structured.cliRoute['reasoning effort'] === 'high');
  check('正文含路由事实（可审计）', result.output[0].text.includes('gpt-6-astra'));
}

section('失败语义');
{
  const { spawn } = makeSpawn({ exitCode: 1, stdout: '', stderr: 'stream error: model not found' });
  const p = createCliProvider({ role: codexRole(), spawn });
  const result = await (await p.start({ prompt: textPrompt('t') })).result;

  check('非零退出 → stopReason error', result.stopReason === 'error', result.stopReason);
  check('正文含退出码', result.output[0].text.includes('exit=1'));
  check('正文保留 stderr', result.output[0].text.includes('model not found'));
  check('正文说明失败原因', result.output[0].text.includes('失败原因'));
}

section('参数模板错误：在启动前失败，不 spawn');
{
  const role = codexRole({ args: ['exec', '{modle}', '-'] });
  const { spawn, calls } = makeSpawn();
  const p = createCliProvider({ role, spawn });
  const result = await (await p.start({ prompt: textPrompt('t') })).result;

  check('未调用 spawn', calls.length === 0);
  check('stopReason error', result.stopReason === 'error');
  check('正文说明模板错误', result.output[0].text.includes('参数模板错误'), result.output[0].text);
}

section('spawn 抛错：转为可读失败而非抛出');
{
  const p = createCliProvider({
    role: codexRole(),
    spawn: () => {
      throw new Error('ENOENT: 找不到可执行文件');
    },
  });
  const result = await (await p.start({ prompt: textPrompt('t') })).result;
  check('stopReason error', result.stopReason === 'error');
  check('正文含原始错误', result.output[0].text.includes('ENOENT'));
}

section('resolveExecutable 的使用与回退');
{
  // 解析成功：应该用解析结果替换配置里的命令名。
  const { spawn, calls } = makeSpawn({ stdout: 'x' });
  const p = createCliProvider({
    role: codexRole({ command: 'codex' }),
    spawn,
    resolveExecutable: async (cmd) => `RESOLVED(${cmd})`,
  });
  await (await p.start({ prompt: textPrompt('t') })).result;
  check('使用解析后的路径', calls[0].argv[0] === 'RESOLVED(codex)', calls[0].argv[0]);

  // 解析失败：回退到配置的字面值，不应中断派发。
  const s2 = makeSpawn({ stdout: 'x' });
  const p2 = createCliProvider({
    role: codexRole({ command: 'codex' }),
    spawn: s2.spawn,
    resolveExecutable: async () => {
      throw new Error('lookup failed');
    },
  });
  const r2 = await (await p2.start({ prompt: textPrompt('t') })).result;
  check('解析失败时回退到字面命令', s2.calls[0].argv[0] === 'codex', s2.calls[0].argv[0]);
  check('回退后仍成功', r2.stopReason === 'completed');
}

section('非文本提示块被如实报告');
{
  const { spawn } = makeSpawn({ stdout: 'x' });
  const p = createCliProvider({ role: codexRole(), spawn });
  const result = await (
    await p.start({ prompt: [{ type: 'text', text: 'T' }, { type: 'image', attachment: {} }] })
  ).result;
  check('diagnostic 记录被忽略的块', typeof result.diagnostic === 'string' && result.diagnostic.includes('image'), String(result.diagnostic));
}

section('成功但无输出：如实标注');
{
  const { spawn } = makeSpawn({ exitCode: 0, stdout: '' });
  const p = createCliProvider({ role: codexRole(), spawn });
  const result = await (await p.start({ prompt: textPrompt('t') })).result;
  check('stopReason 仍为 completed', result.stopReason === 'completed');
  check('diagnostic 标注无输出', typeof result.diagnostic === 'string' && result.diagnostic.includes('没有输出内容'), String(result.diagnostic));
}

section('角色指令被前置进提示词');
{
  // CLI provider 的 persona 能力为 false，因此 provider 必须自己把角色指令
  // 拼进提示词；否则 CLI 子代理不知道自己是什么角色。
  const role = codexRole();
  role.instructions = 'ROLE-INSTRUCTIONS-SENTINEL';
  const { spawn, calls } = makeSpawn({ stdout: 'x' });
  const p = createCliProvider({ role, spawn });
  await (await p.start({ prompt: textPrompt('THE TASK') })).result;

  const stdin = calls[0].stdio.stdin;
  check('提示词经 stdin 传入', typeof stdin === 'object' && typeof stdin.data === 'string');
  check('含角色指令', stdin.data.includes('ROLE-INSTRUCTIONS-SENTINEL'), stdin.data.slice(0, 120));
  check('含任务正文', stdin.data.includes('THE TASK'));
  check('角色指令在任务之前', stdin.data.indexOf('ROLE-INSTRUCTIONS-SENTINEL') < stdin.data.indexOf('THE TASK'));

  // argv 模式：角色指令**不会**被前置（多行值不得进入 argv 元素）。
  // 这是命令行传参的固有限制，不是疏漏 —— 断言把它固定下来，避免日后误以为
  // 「argv 模式也能带角色指令」。
  const role2 = codexRole({ promptDelivery: 'argv', args: ['-p', '{prompt}'] });
  role2.instructions = 'ROLE-INSTRUCTIONS-SENTINEL';
  const s2 = makeSpawn({ stdout: 'x' });
  const p2 = createCliProvider({ role: role2, spawn: s2.spawn });
  await (await p2.start({ prompt: textPrompt('THE TASK') })).result;
  check('argv 模式确实调用了 spawn', s2.calls.length === 1);
  const promptArg = s2.calls[0].argv.find((a) => a.includes('THE TASK'));
  check('argv 模式的任务正文进入 argv', typeof promptArg === 'string', String(promptArg));
  check(
    'argv 模式不前置角色指令（多行值不得进 argv，属固有限制）',
    typeof promptArg === 'string' && !promptArg.includes('ROLE-INSTRUCTIONS-SENTINEL'),
    String(promptArg),
  );

  // 多行的提示词在 argv 模式下必须被明确拒绝，而不是悄悄截断或塞进去。
  const s4 = makeSpawn({ stdout: 'x' });
  const p4 = createCliProvider({ role: role2, spawn: s4.spawn });
  const multi = await (
    await p4.start({ prompt: [{ type: 'text', text: 'line1\nline2' }] })
  ).result;
  check('argv 模式下多行提示词被拒绝且不 spawn', s4.calls.length === 0 && multi.stopReason === 'error');
  check(
    '错误信息说明是换行导致',
    multi.output[0].text.includes('换行'),
    multi.output[0].text.slice(0, 160),
  );

  // 无角色指令时不应残留分隔线。
  const role3 = codexRole();
  role3.instructions = '   ';
  const s3 = makeSpawn({ stdout: 'x' });
  const p3 = createCliProvider({ role: role3, spawn: s3.spawn });
  await (await p3.start({ prompt: textPrompt('ONLY TASK') })).result;
  check('空角色指令时不加分隔线', s3.calls[0].stdio.stdin.data === 'ONLY TASK', s3.calls[0].stdio.stdin.data);
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
  const p = createCliProvider({ role, spawn: h.spawn });
  const started = p.start({ prompt: textPrompt('CANCEL ME'), signal: ac.signal });
  const path = h.calls[0].argv.at(-1);
  check('运行中提示词文件存在', existsSync(path));
  check('request.signal 原样传入 spawn', h.calls[0].signal === ac.signal);
  ac.abort();
  const result = await (await started).result;
  check('调用方取消 → 子进程被中止', h.aborted());
  check('取消 → stopReason aborted', result.stopReason === 'aborted');
  check('取消正文标注 cancelled=true', result.output[0].text.includes('cancelled=true'));
  check('取消原因是 cancelled 而不是 timeout', result.structured.status === 'cancelled'
    && result.output[0].text.includes('失败原因：cancelled') && !/timeout|timedOut/.test(result.output[0].text));
  check('取消仍有 argv 审计行', result.output[0].text.includes('[switchboard] argv='));
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
  } finally {
    if (active && active.exitCode === null && active.signalCode === null) active.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
