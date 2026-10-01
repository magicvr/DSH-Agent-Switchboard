// 探测本机可用的外部 CLI：入口可执行性 + 非交互调用形态 + 模型/强度 flag。
//
// 为什么必须实测：`docs/cli-backends.md` §1 已证明「命令存在」不等于「能被 spawn」——
// 本机 codex 的三个入口里只有 `node codex.js` 可用（`.ps1` → ENOENT，`.cmd` → EINVAL，
// 后者是 Node ≥19 对 CVE-2024-27980 的缓解）。因此 claude / grok 也必须逐个实测，
// 不能假定它们与 codex 相同。
//
// 本脚本**只做轻量探测**：`--version` / `--help`，不发起真实模型调用（那会很慢且消耗额度）。
//
// 用法：node scripts/probe-clis.mjs
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 把命令解析为「可直接 spawn 的 argv 前缀」。
 *
 * @param {string} name - 命令名。
 * @returns {{ok: boolean, argv?: string[], detail: string}} 结果。
 */
function resolveEntry(name) {
  let found;
  try {
    found = execFileSync('where.exe', [name], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return { ok: false, detail: 'where.exe 找不到该命令' };
  }
  if (found.length === 0) return { ok: false, detail: 'where.exe 返回空' };

  // 优先真正的 .exe；其次找同目录下可用的 js 入口（codex 的情况）。
  const exe = found.find((p) => /\.exe$/i.test(p));
  if (exe) return { ok: true, argv: [exe], detail: `直接使用 .exe：${exe}` };

  // 无 .exe：尝试 npm 全局包里的 bin/*.js（codex 的可用入口形态）。
  const npmRoot = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules') : undefined;
  if (npmRoot !== undefined) {
    for (const scopePkg of [
      ['@openai', 'codex', 'bin/codex.js'],
      ['@anthropic-ai', 'claude-code', 'cli.js'],
    ]) {
      const candidate = join(npmRoot, ...scopePkg);
      if (existsSync(candidate)) {
        return { ok: true, argv: [process.execPath, candidate], detail: `node + ${candidate}` };
      }
    }
  }
  return { ok: false, detail: `只找到脚本入口（${found.join(', ')}），按 §1 的结论不可直接 spawn` };
}

/**
 * 用给定 argv 前缀跑一次，返回观测结果。
 *
 * @param {string[]} argv - argv 前缀。
 * @param {string[]} args - 追加参数。
 * @param {number} timeoutMs - 超时。
 * @returns {{ok: boolean, status: number|string, stdout: string, stderr: string}} 结果。
 */
function run(argv, args, timeoutMs = 20000) {
  const r = spawnSync(argv[0], [...argv.slice(1), ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false,
    windowsHide: true,
  });
  return {
    ok: r.error === undefined && r.status === 0,
    status: r.error !== undefined ? `error:${r.error.code ?? r.error.message}` : r.status,
    stdout: (r.stdout ?? '').slice(0, 600),
    stderr: (r.stderr ?? '').slice(0, 600),
  };
}

const CLIS = ['codex', 'claude', 'grok'];

for (const name of CLIS) {
  console.log(`\n${'='.repeat(60)}\n${name}\n${'='.repeat(60)}`);
  const entry = resolveEntry(name);
  console.log(`入口解析：${entry.ok ? 'OK' : '失败'} —— ${entry.detail}`);
  if (!entry.ok) continue;

  for (const args of [['--version'], ['--help']]) {
    const r = run(entry.argv, args);
    console.log(`\n$ ${[name, ...args].join(' ')}   → status=${r.status}`);
    if (r.stderr.trim().length > 0) console.log(`  stderr: ${r.stderr.trim().split('\n').slice(0, 6).join('\n          ')}`);
    if (r.stdout.trim().length > 0) console.log(`  stdout: ${r.stdout.trim().split('\n').slice(0, 14).join('\n          ')}`);
  }
}
