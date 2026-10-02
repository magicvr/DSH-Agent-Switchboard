/**
 * 可复用的单次 CLI 执行器，不依赖 DSH 工具或 Jobs。
 * 命令与 argv 模板只取自角色配置；调用方只提供提示词和取消信号。
 */
import { buildInvocation } from './argv.js';
import { formatRunResult } from './output.js';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

/**
 * @param {object} options
 * @param {object} options.role - 已规范化的角色及 cli 配置。
 * @param {string} options.prompt - 任务正文；执行器按传递模式前置角色指令。
 * @param {Function} options.spawn - ctx.subprocess.spawn 同形函数。
 * @param {Function} [options.resolveExecutable] - 可执行文件解析器。
 * @param {AbortSignal} [options.signal] - 调用方的取消信号，原样传入 spawn。
 * @param {string} [options.routeSummary] - 由调用方生成的线路摘要。
 * @param {Function} [options.onOutput] - 可选异步 sink，接收 {stream, text, lossy}。
 *   增量读取收集器，不消费输出；sink 异常只记诊断，不改变进程结果。
 * @param {Function} [options.now] - 测试用时钟。
 * @returns {Promise<object>} 唯一终态：status、exitCode、输出、路由事实与格式化结果。
 */
export async function runCli({ role, prompt, spawn, resolveExecutable, signal, routeSummary,
  onOutput, now = () => Date.now() }) {
  const cli = role.cli;
  if (!cli) throw new Error(`角色 "${role.id}" 使用 cli 后端但缺少 cli 配置`);
  const startedAt = now();
  let promptFilePath;
  let handle;
  let monitor;
  let settled = false;
  let cancelled = signal?.aborted === true;
  let invocation;
  let stage = '无法准备 CLI';
  let sinkDiagnostic;
  let outcome;
  let failure;
  const cleanupDiagnostics = [];
  let pendingOutput = Promise.resolve();
  const offsets = { stdout: 0, stderr: 0 };
  const onAbort = () => { if (!settled) cancelled = true; };
  signal?.addEventListener('abort', onAbort, { once: true });

  const emitOutput = () => {
    if (typeof onOutput !== 'function') return;
    for (const stream of ['stdout', 'stderr']) {
      const read = readCollected(handle?.collected?.[stream], offsets[stream]);
      offsets[stream] = read.nextOffset;
      if (!read.text && !read.lossy) continue;
      pendingOutput = pendingOutput.then(() => onOutput({ stream, text: read.text, lossy: read.lossy }))
        .catch(error => { sinkDiagnostic ??= `输出回流失败：${error.message ?? error}`; });
    }
  };

  try {
    // 已取消时连文件和可执行文件解析都不发起；解析期间取消则在 spawn 前再次检查。
    if (cancelled) throw new Error('调用方已取消');
    const canCarryRole = cli.promptDelivery === 'stdin' || cli.promptDelivery === 'promptFile';
    const withRole = canCarryRole && role.instructions?.trim()
      ? `${role.instructions.trim()}\n\n---\n\n${prompt}` : prompt;
    if (cli.promptDelivery === 'promptFile') {
      stage = '无法写入提示词临时文件';
      promptFilePath = join(tmpdir(), `switchboard-prompt-${randomUUID()}.txt`);
      writeFileSync(promptFilePath, withRole, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }

    let command = cli.command;
    if (typeof resolveExecutable === 'function') {
      try { command = await resolveExecutable(cli.command, cli.env, signal); }
      catch { command = cli.command; /* 交给 spawn 报告字面命令的启动错误 */ }
    }
    if (cancelled) throw new Error('调用方已取消');
    stage = '参数模板错误';
    invocation = buildInvocation({ command, prefixArgs: cli.prefixArgs ?? [], args: cli.args,
      values: { prompt: cli.promptDelivery === 'argv' ? withRole
        : cli.promptDelivery === 'promptFile' ? promptFilePath : undefined,
      cwd: cli.cwd, model: role.model, effort: role.effort } });

    stage = '无法启动 CLI';
    handle = spawn({ argv: invocation.argv, cwd: cli.cwd,
      stdio: { stdin: cli.promptDelivery === 'stdin' ? { data: withRole } : 'ignore',
        stdout: { maxBytes: cli.maxOutputBytes }, stderr: { maxBytes: cli.maxErrorBytes } },
      graceMs: cli.graceMs, signal, env: cli.env });
    stage = 'CLI 进程失败';
    // 只在需要回流时轮询非消费型收集器；这不是运行期限，不会触发进程终止。
    if (typeof onOutput === 'function') {
      monitor = setInterval(() => {
        try { emitOutput(); }
        catch (error) { sinkDiagnostic ??= `输出读取失败：${error.message ?? error}`; }
      }, 50);
    }
    outcome = await handle.done;
    // done 被观察到即固定终态，后续异步 sink 或取消不能改写已经退出的结果。
    settled = true;
    clearInterval(monitor);
    emitOutput();
    await pendingOutput;
  } catch (error) {
    settled = true;
    failure = `${stage}：${error.message ?? error}`;
    // done 拒绝也必须收尾。具体终止与宽限由 subprocess 负责，不另造期限。
    if (handle) {
      try { await handle.terminate(); }
      catch (error) { cleanupDiagnostics.push(`进程终止请求失败（${error.code ?? '未知错误'}）`); }
    }
    clearInterval(monitor);
    // 进程失败也排空最后一段输出，不重复已经交给 sink 的字节。
    try { emitOutput(); }
    catch (error) { sinkDiagnostic ??= `输出读取失败：${error.message ?? error}`; }
    await pendingOutput;
  } finally {
    settled = true;
    clearInterval(monitor);
    signal?.removeEventListener('abort', onAbort);
    await pendingOutput;
    // terminate 抛错也独立尝试；成功路径同样确认受管范围，而非只等 handle.done。
    if (handle) {
      try {
        if (await handle.waitForExit() !== true) throw new Error('退出未确认');
      } catch (error) {
        cleanupDiagnostics.push(`未能确认受管进程范围已清空（${error.code ?? '未知错误'}）`);
      }
    }
    // 退出确认期间新增的输出也排空；偏移保证不会重复已推送的字节。
    try { emitOutput(); }
    catch (error) { sinkDiagnostic ??= `输出读取失败：${error.message ?? error}`; }
    await pendingOutput;
    if (promptFilePath) {
      try { rmSync(promptFilePath, { force: true }); }
      // 不带错误 message / 文件内容；只报告操作与错误码，避免暴露提示词。
      catch (error) { cleanupDiagnostics.push(`提示词临时文件删除失败，可能残留（${error.code ?? '未知错误'}）`); }
    }
  }
  // 清理完成后统一形成结果，清理失败如实诊断，不挂起、不宣称资源已全部释放。
  let out = { text: '', lossy: false };
  let err = { text: '', lossy: false };
  try {
    out = readCollected(handle?.collected?.stdout, 0, cli.maxOutputBytes);
    err = readCollected(handle?.collected?.stderr, 0, cli.maxErrorBytes);
  } catch (error) { failure ??= `CLI 输出读取失败：${error.message ?? error}`; }
  const stderr = [err.text, failure].filter(Boolean).join('\n');
  const formatted = formatRunResult({ roleId: role.id, command: invocation?.argv[0] ?? cli.command,
    argv: invocation?.argv ?? [], routeSummary, exitCode: outcome?.exitCode ?? null,
    signal: outcome?.signal, cancelled, startFailed: Boolean(failure) && !handle,
    stdout: out.text, stderr, stdoutTruncated: out.lossy, stderrTruncated: err.lossy,
    durationMs: now() - startedAt });
  // 清理事实优先保留，避免巨大的进程错误占满诊断容量。
  const diagnosticBytes = Buffer.from([...cleanupDiagnostics, cancelled ? undefined : failure,
    sinkDiagnostic].filter(Boolean).join('\n'));
  return { ...formatted, status: cancelled ? 'cancelled' : failure
    ? handle ? 'process-failed' : 'start-failed' : formatted.ok ? 'completed' : 'process-failed',
    exitCode: outcome?.exitCode ?? null, signal: outcome?.signal ?? null,
    stdout: out.text, stderr, stderrTail: [err.tailText ?? err.text, failure].filter(Boolean).join('\n'),
    stdoutTruncated: out.lossy, stderrTruncated: err.lossy, cleanupFailed: cleanupDiagnostics.length > 0,
    diagnostic: diagnosticBytes.length ? new StringDecoder('utf8').write(diagnosticBytes.subarray(0, 4096)) : undefined,
    diagnosticTruncated: diagnosticBytes.length > 4096 };
}

/** 有界读取，保留收集器的丢失标志，并对非标准适配器防御性限制结果容量。 */
function readCollected(reader, from = 0, maxBytes = Infinity) {
  let offset = from;
  let lossy = false;
  const chunks = [];
  if (typeof reader?.readFrom !== 'function') return { text: '', nextOffset: offset, lossy };
  for (let guard = 0; guard < 10_000; guard++) {
    const read = reader.readFrom(offset);
    if (!read || typeof read.text !== 'string') break;
    chunks.push(read.text);
    lossy ||= read.lossy === true;
    if (typeof read.nextOffset !== 'number' || read.nextOffset <= offset) break;
    offset = read.nextOffset;
  }
  const bytes = Buffer.from(chunks.join(''));
  const limit = typeof maxBytes === 'number' && maxBytes >= 0 ? maxBytes : Infinity;
  let tailStart = Math.max(0, bytes.length - limit);
  while (tailStart < bytes.length && (bytes[tailStart] & 0xc0) === 0x80) tailStart++;
  // 不把截断的半个 UTF-8 字符替换成更长的 U+FFFD，避免返回值反而超过字节上限。
  return { text: new StringDecoder('utf8').write(bytes.subarray(0, Math.min(bytes.length, limit))),
    tailText: bytes.subarray(tailStart).toString('utf8'),
    nextOffset: offset, lossy: lossy || bytes.length > limit };
}
