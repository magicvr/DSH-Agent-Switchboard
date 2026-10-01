/**
 * 把一次 CLI 运行的原始输出解析成子代理结果。
 *
 * 设计依据（docs/cli-backends.md）：
 *   - **不美化、不丢弃**：退出码、失败时的完整 stderr 必须原样回传给主代理，
 *     否则「为什么失败」在链路上会被抹平（D8）。
 *   - **解析失败不算运行失败**：拿不到路由事实只是少一条诊断，不影响结果回传。
 *
 * 本模块不 import 任何 DSH 运行时，可在 Node 里直接单测。
 *
 * @module @magicvr/dsh-agent-switchboard/cli/output
 */

/**
 * codex 会在 stderr 头部明文打印本次运行的路由事实，形如：
 *
 * ```
 * OpenAI Codex v0.159.2
 * --------
 * workdir: C:\...
 * model: gpt-6-luna
 * provider: openai
 * approval: never
 * sandbox: read-only
 * reasoning effort: max
 * ```
 *
 * 这是**可当场读取的生效证据**：把 `model` 从 A 换成 B，这一行会跟着变。
 * 因此它既是诊断信息，也是验收依据。
 */
const ROUTE_FACT_KEYS = [
  'workdir',
  'model',
  'provider',
  'approval',
  'sandbox',
  'reasoning effort',
  'reasoning summary',
];

/**
 * 从 CLI 的 stderr 里抽取路由事实行。
 *
 * 只在头部有限行数内匹配，避免把正常输出里恰好形如 `model: xxx` 的行误当成事实。
 *
 * @param {string} stderr - 完整 stderr。
 * @param {number} [scanLines] - 扫描的行数上限。
 * @returns {Record<string, string>} 抽到的事实键值；无则空对象。
 */
export function parseRouteFacts(stderr, scanLines = 25) {
  const facts = {};
  if (typeof stderr !== 'string' || stderr.length === 0) return facts;
  const keys = ROUTE_FACT_KEYS.join('|');
  const pattern = new RegExp(`^(${keys})\\s*:\\s*(.+)$`);
  for (const line of stderr.split('\n').slice(0, scanLines)) {
    const match = pattern.exec(line.trim());
    if (match) facts[match[1]] = match[2].trim();
  }
  return facts;
}

/**
 * 判断一次运行是否成功。
 *
 * 退出码为 0 **是必要条件但不充分**：部分 CLI 在失败时仍可能返回 0，
 * 因此调用方还应结合「是否拿到正文」判断。这里只做退出码层面的判定。
 *
 * @param {object} run - 运行原始结果。
 * @param {number | null} run.exitCode - 退出码。
 * @param {NodeJS.Signals | null} [run.signal] - 终止信号。
 * @param {boolean} [run.timedOut] - 是否因超时被终止。
 * @returns {{ ok: boolean, reason?: string }} 判定结果。
 */
export function classifyRun({ exitCode, signal, timedOut }) {
  if (timedOut === true) return { ok: false, reason: 'timeout' };
  if (signal) return { ok: false, reason: `terminated by ${signal}` };
  if (exitCode === null || exitCode === undefined) return { ok: false, reason: 'no exit code' };
  if (exitCode !== 0) return { ok: false, reason: `exit code ${exitCode}` };
  return { ok: true };
}

/**
 * 把一次 CLI 运行解析为回传文本。
 *
 * 回传内容刻意包含：
 *   - 角色与路由事实（证明「配置真的被 CLI 接受了」，而非只是本插件以为如此）；
 *   - 正文；
 *   - 失败时的退出码与 stderr 尾部（不截断到看不出原因的长度）。
 *
 * @param {object} input - 解析输入。
 * @param {string} input.roleId - 角色 id。
 * @param {string} input.command - 实际执行的命令（可执行文件或 node）。
 * @param {readonly string[]} input.argv - 实际执行的 argv（用于审计，证明无 shell）。
 * @param {number | null} input.exitCode - 退出码。
 * @param {NodeJS.Signals | null} [input.signal] - 终止信号。
 * @param {boolean} [input.timedOut] - 是否超时。
 * @param {string} input.stdout - 标准输出。
 * @param {string} input.stderr - 标准错误。
 * @param {number} [input.durationMs] - 耗时。
 * @param {number} [input.stderrTailBytes] - 失败时最多回传多少 stderr 字节。
 * @returns {{ text: string, ok: boolean, route: Record<string, string> }} 回传文本与判定。
 */
export function formatRunResult(input) {
  const {
    roleId,
    command,
    argv,
    exitCode,
    signal,
    timedOut,
    stdout,
    stderr,
    durationMs,
    stderrTailBytes = 4000,
  } = input;

  const verdict = classifyRun({ exitCode, signal, timedOut });
  const route = parseRouteFacts(stderr);

  const lines = [];
  lines.push(`[switchboard] role=${roleId} backend=cli command=${command}`);
  lines.push(`[switchboard] argv=${JSON.stringify(argv)}`);
  lines.push(
    `[switchboard] exit=${exitCode === null ? 'null' : exitCode}` +
      `${signal ? ` signal=${signal}` : ''}` +
      `${timedOut ? ' timedOut=true' : ''}` +
      `${typeof durationMs === 'number' ? ` duration=${(durationMs / 1000).toFixed(1)}s` : ''}`,
  );
  if (Object.keys(route).length > 0) {
    // 路由事实是「配置被 CLI 接受」的证据，因此放在最前面醒目位置。
    lines.push(`[switchboard] cli-route ${JSON.stringify(route)}`);
  } else {
    lines.push('[switchboard] cli-route (CLI 未自报路由事实)');
  }
  lines.push('');

  const body = (stdout ?? '').trim();
  if (body.length > 0) {
    lines.push(body);
  } else if (!verdict.ok) {
    lines.push('(CLI 未产生标准输出)');
  } else {
    lines.push('(CLI 成功退出但没有输出内容)');
  }

  if (!verdict.ok) {
    const tail = (stderr ?? '').slice(-stderrTailBytes).trim();
    lines.push('');
    lines.push(`[switchboard] 失败原因：${verdict.reason}`);
    if (tail.length > 0) {
      lines.push('[switchboard] stderr（尾部）：');
      lines.push(tail);
    }
  }

  return { text: lines.join('\n'), ok: verdict.ok, route };
}
