// 第二轮真机验证：用**各自的真实模型**确认 claude 与 grok 的调用形态可用，
// 并确认 `--effort` / `--reasoning-effort` 是否被接受。
//
// 第一轮（scripts/probe-cli-run.mjs）的结论：
//   - codex 用 `gpt-6-luna` 通过（stderr 自报路由与 argv 一致）；
//   - claude 与 grok 都因**模型 id 不属于各自的命名空间**而失败（退出 1）。
//     claude 报 "isn't described by this version's model catalog"，
//     grok 报 "unknown model id"。
// 这证明：**每个 CLI 有自己的模型命名空间，不能共用一份列表。**
//
// 用法：node scripts/probe-cli-run2.mjs
import { spawnSync } from 'node:child_process';

const MARK = 'CLI_PROBE_OK';
const PROMPT = `Reply with exactly this token and nothing else: ${MARK}`;

/** 各 CLI 的真实模型（grok 由 `grok models` 实测；claude 用 help 所述别名）。 */
const CASES = [
  {
    name: 'claude (model=sonnet, effort=low)',
    argv: ['C:\\Users\\magicvr\\.local\\bin\\claude.exe'],
    args: ['-p', '--model', 'sonnet', '--effort', 'low'],
    delivery: 'stdin',
  },
  {
    name: 'claude (model=sonnet, 不带 --effort)',
    argv: ['C:\\Users\\magicvr\\.local\\bin\\claude.exe'],
    args: ['-p', '--model', 'sonnet'],
    delivery: 'stdin',
  },
  {
    name: 'grok (model=grok-4.7, reasoning-effort=low)',
    argv: ['C:\\Users\\magicvr\\.grok\\bin\\grok.exe'],
    args: ['-p', '<PROMPT>', '-m', 'grok-4.7', '--reasoning-effort', 'low'],
    delivery: 'argv',
  },
];

for (const c of CASES) {
  const args = c.args.map((a) => (a === '<PROMPT>' ? PROMPT : a));
  const started = Date.now();
  const r = spawnSync(c.argv[0], [...c.argv.slice(1), ...args], {
    encoding: 'utf8',
    timeout: 180000,
    shell: false,
    windowsHide: true,
    input: c.delivery === 'stdin' ? PROMPT : '',
  });
  const ms = Date.now() - started;
  const status = r.error !== undefined ? `error:${r.error.code ?? r.error.message}` : r.status;
  const stdout = (r.stdout ?? '').trim();
  const stderr = (r.stderr ?? '').trim();

  console.log(`\n${'='.repeat(64)}\n${c.name}   退出=${status}  耗时=${(ms / 1000).toFixed(1)}s\n${'='.repeat(64)}`);
  console.log(`argv: ${JSON.stringify(args).slice(0, 360)}`);
  console.log(`stdout(${stdout.length}B): ${stdout.slice(0, 260) || '（空）'}`);
  console.log(`stderr(${stderr.length}B): ${stderr.slice(0, 400) || '（空）'}`);
  console.log(`标记串出现: stdout=${stdout.includes(MARK)}  stderr=${stderr.includes(MARK)}`);
}
