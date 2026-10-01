// 真机验证三个 CLI 的「一件小事」端到端调用：能否 spawn、提示词怎么传、退出码与输出。
//
// 为什么不能只信 help（`docs/cli-backends.md` §5.3 与 D12 的教训）：
//   - codex 的三个入口里只有 `node codex.js` 可用（`.ps1` ENOENT、`.cmd` EINVAL）；
//   - codex 的思考强度参数在 `--help` 里**完全未出现**，只能靠真实调用确认。
// 因此每个 CLI 都要真跑一次，产出的 `argv` 与输出才是可以写进预设的依据。
//
// 提示词只要求回一个标记串，成本最低。
//
// 用法：node scripts/probe-cli-run.mjs
import { spawnSync } from 'node:child_process';

const MARK = 'CLI_PROBE_OK';
const MODEL = 'gpt-6-luna';

/** 待验证的调用形态（候选来自 --help，是否可用由本次实测决定）。 */
const CASES = [
  {
    name: 'codex',
    argv: [process.execPath, `${process.env.APPDATA}\\npm\\node_modules\\@openai\\codex\\bin\\codex.js`],
    args: ['exec', '-s', 'read-only', '--skip-git-repo-check', '-m', MODEL, '-c', 'model_reasoning_effort=low', '-'],
    delivery: 'stdin',
  },
  {
    name: 'claude',
    argv: ['C:\\Users\\magicvr\\.local\\bin\\claude.exe'],
    args: ['-p', '--model', MODEL, '--effort', 'low'],
    delivery: 'stdin',
  },
  {
    name: 'grok',
    argv: ['C:\\Users\\magicvr\\.grok\\bin\\grok.exe'],
    // grok 的 `-p/--single <PROMPT>` 需要**参数**形式的提示词，因此提示词只能进 argv。
    args: ['-p', '<PROMPT>', '-m', MODEL, '--reasoning-effort', 'low'],
    delivery: 'argv',
  },
];

const PROMPT = `Reply with exactly this token and nothing else: ${MARK}`;

for (const c of CASES) {
  const prompt = PROMPT;
  const args = c.args.map((a) => (a === '<PROMPT>' ? prompt : a));
  const started = Date.now();
  const r = spawnSync(c.argv[0], [...c.argv.slice(1), ...args], {
    encoding: 'utf8',
    timeout: 150000,
    shell: false,
    windowsHide: true,
    // stdin 传递时把提示词写入子进程 stdin；argv 传递时给空 stdin 让它读到 EOF。
    input: c.delivery === 'stdin' ? prompt : '',
  });
  const ms = Date.now() - started;

  const status = r.error !== undefined ? `error:${r.error.code ?? r.error.message}` : r.status;
  const stdout = (r.stdout ?? '').trim();
  const stderr = (r.stderr ?? '').trim();

  console.log(`\n${'='.repeat(64)}\n${c.name}   退出=${status}  耗时=${(ms / 1000).toFixed(1)}s\n${'='.repeat(64)}`);
  console.log(`argv: ${JSON.stringify([c.argv[0].split('\\').pop(), ...args]).slice(0, 400)}`);
  console.log(`提示词传递: ${c.delivery}`);
  console.log(`stdout(${stdout.length}B): ${stdout.slice(0, 300) || '（空）'}`);
  console.log(`stderr(${stderr.length}B): ${stderr.slice(0, 500) || '（空）'}`);
  console.log(`标记串出现: stdout=${stdout.includes(MARK)}  stderr=${stderr.includes(MARK)}`);
}
