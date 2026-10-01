// 离线端到端验证：不经插件、不起 DSH，直接走本插件的 argv + 输出解析层调用真实 codex。
//
// 这填补了一个空白：插件内的 `ctx.subprocess` 需要重启才能验证，但「argv 构造是否正确」
// 与「输出解析是否正确」可以用真实的 spawnSync 验证，无需重启。
//
// 安全：只读沙箱，提示词只要求回一个标记串。
// 用法：node scripts/check-cli-live.mjs
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildInvocation } from '../src/cli/argv.js';
import { formatRunResult } from '../src/cli/output.js';

const REPO = process.cwd();
const MARKER = 'SWITCHBOARD_LIVE_OK';
const NODE_EXE = process.execPath;
const CODEX_JS = join(
  process.env.APPDATA ?? '',
  'npm',
  'node_modules',
  '@openai',
  'codex',
  'bin',
  'codex.js',
);

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

console.log('=== 真实 codex：argv 构造 + 输出解析端到端 ===');
console.log(`node: ${NODE_EXE}`);
console.log(`codex.js: ${CODEX_JS}`);

// 用真实的 codex 形态构造 argv —— 与 scripts/probe-codex.mjs 验证过的形态逐字一致。
const invocation = buildInvocation({
  command: NODE_EXE,
  prefixArgs: [CODEX_JS],
  args: [
    'exec',
    '-s',
    'read-only',
    '--skip-git-repo-check',
    '-m',
    '{model}',
    '-c',
    'model_reasoning_effort={effort}',
    '-',
  ],
  values: { model: 'gpt-6-astra', effort: 'medium' },
});

console.log(`argv: ${JSON.stringify(invocation.argv)}`);
check('argv[0] 是 node', invocation.argv[0] === NODE_EXE);
check('argv[1] 是 codex.js', invocation.argv[1] === CODEX_JS);
check('模型已替换', invocation.argv.includes('gpt-6-astra'));
check('强度已替换', invocation.argv.includes('model_reasoning_effort=medium'));
check('argv 中没有提示词（走 stdin）', !invocation.argv.some((a) => a.includes(MARKER)));

const started = Date.now();
const result = spawnSync(invocation.argv[0], invocation.argv.slice(1), {
  cwd: REPO,
  input: `Reply with exactly this token and nothing else: ${MARKER}`,
  encoding: 'utf8',
  timeout: 180_000,
  shell: false,
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, NO_COLOR: '1' },
});
const durationMs = Date.now() - started;

const formatted = formatRunResult({
  roleId: 'scout',
  command: invocation.argv[0],
  argv: invocation.argv,
  exitCode: result.status,
  signal: result.signal,
  stdout: result.stdout ?? '',
  stderr: result.stderr ?? '',
  durationMs,
});

console.log(`\n耗时 ${(durationMs / 1000).toFixed(1)}s  退出码 ${result.status}`);
console.log(`stdout ${(result.stdout ?? '').length}B  stderr ${(result.stderr ?? '').length}B`);
console.log('\n--- 解析结果 ---');
console.log(formatted.text.slice(0, 900));

console.log('\n=== 断言 ===');
check('退出码为 0', result.status === 0, String(result.status));
check('解析判定为成功', formatted.ok === true);
check('正文含标记（提示词经 stdin 确实送达）', formatted.text.includes(MARKER));
check('抽到了 cli-route', Object.keys(formatted.route).length > 0, JSON.stringify(formatted.route));
check('cli-route.model 是我指定的模型', formatted.route.model === 'gpt-6-astra', String(formatted.route.model));
check(
  'cli-route.reasoning effort 是我指定的档位',
  formatted.route['reasoning effort'] === 'medium',
  String(formatted.route['reasoning effort']),
);
check('cli-route.sandbox 为 read-only', formatted.route.sandbox === 'read-only', String(formatted.route.sandbox));
check('正文含 role 标注', formatted.text.includes('role=scout'));
check('正文含 argv 审计信息', formatted.text.includes('codex.js'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
