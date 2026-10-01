// codex CLI 非交互调用探针。
//
// 目的：在**不触碰插件代码**的前提下，把 codex 作为子代理后端所需的全部事实实测清楚，
// 避免「改插件 → 重启 → 发现参数不对 → 再改 → 再重启」的循环。
//
// ⚠️ 实测确认的三条入口事实（原计划用 `.cmd` 包装，是错的）：
//   1. 裸 `codex` → 解析到 `%APPDATA%\npm\codex.ps1`（PowerShell 脚本），
//      `spawnSync` 报 `ENOENT`。
//   2. `codex.cmd` → `spawnSync` 报 `EINVAL`：Node ≥19 禁止在 `shell: false`
//      下 spawn `.cmd`/`.bat`（CVE-2024-27980 的缓解措施）。
//   3. **唯一可行**：`node <...>/@openai/codex/bin/codex.js`。
//
// 安全：全部调用使用只读沙箱（-s read-only），提示词只要求回一个标记串。
//
// 用法：node scripts/probe-codex.mjs
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const OUT_DIR = join(REPO, 'raw', 'codex-probe');
const TIMEOUT_MS = 180_000;
const MARKER = 'SWITCHBOARD_PROBE_OK';

/** 唯一可行的入口：codex 的 node 脚本。 */
const JS_ENTRY = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');

/**
 * 从 codex 的 stderr 头部抽出它自己打印的路由事实行。
 *
 * codex 会把 `model` / `provider` / `sandbox` / `reasoning effort` 等**明文打印**到
 * stderr，因此「参数是否真的生效」是可当场读取的事实，不必靠推断。
 *
 * @param {string} stderr - 完整 stderr。
 * @returns {Record<string, string>} 事实键值。
 */
function routeFacts(stderr) {
  const out = {};
  for (const line of stderr.split('\n').slice(0, 25)) {
    const m = /^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summary)\s*:\s*(.+)$/.exec(
      line.trim(),
    );
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * 跑一次 codex exec 并记录事实。提示词一律走 stdin（`-`）。
 *
 * @param {string} label - 用例名。
 * @param {object} options - 用例参数。
 * @param {string[]} options.args - 除提示词外的 argv。
 * @param {string} options.prompt - 通过 stdin 传入的提示词。
 * @param {string} options.outFile - `-o` 输出文件路径。
 * @returns {object} 观测结果。
 */
function run(label, { args, prompt, outFile }) {
  const argv = [JS_ENTRY, 'exec', ...args, '-o', outFile, '-'];

  console.log(`\n================ ${label} ================`);
  console.log(`argv: node codex.js ${argv.slice(1).join(' ')}`);

  const started = Date.now();
  const result = spawnSync(process.execPath, argv, {
    cwd: REPO,
    input: prompt,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const elapsedMs = Date.now() - started;

  const outText = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  const stderr = result.stderr ?? '';
  const facts = {
    label,
    elapsedMs,
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.message ?? result.error) : undefined,
    stdoutBytes: (result.stdout ?? '').length,
    stderrBytes: stderr.length,
    outFileExists: existsSync(outFile),
    outFileBytes: outText.length,
    outFileHead: outText.slice(0, 300),
    stdoutHead: (result.stdout ?? '').slice(0, 300),
    stderrFull: stderr,
    route: routeFacts(stderr),
    markerInOutFile: outText.includes(MARKER),
    markerInStdout: (result.stdout ?? '').includes(MARKER),
  };

  console.log(`耗时 ${(elapsedMs / 1000).toFixed(1)}s  退出码 ${facts.status}  信号 ${facts.signal ?? '-'}`);
  if (facts.error) console.log(`spawn error: ${facts.error}`);
  console.log(
    `stdout ${facts.stdoutBytes}B  stderr ${facts.stderrBytes}B  -o ${facts.outFileExists ? `${facts.outFileBytes}B` : '缺失'}  标记=${facts.markerInOutFile}`,
  );
  console.log(`stderr 路由事实: ${JSON.stringify(facts.route)}`);
  if (facts.outFileHead) console.log(`-o: ${JSON.stringify(facts.outFileHead.slice(0, 140))}`);

  return facts;
}

const results = [];
const base = ['-s', 'read-only', '--skip-git-repo-check'];
const say = (m) => `Reply with exactly this token and nothing else: ${m}`;

results.push(
  run('1. 基线（不指定模型，用 codex 自身配置）', {
    args: base,
    prompt: say(MARKER),
    outFile: join(OUT_DIR, '1-baseline.txt'),
  }),
);

results.push(
  run('2. -m gpt-6-luna', {
    args: [...base, '-m', 'gpt-6-luna'],
    prompt: say(MARKER),
    outFile: join(OUT_DIR, '2-model-luna.txt'),
  }),
);

results.push(
  run('3. -m gpt-6-astra（换模型，看 stderr 的 model 行是否跟着变）', {
    args: [...base, '-m', 'gpt-6-astra'],
    prompt: say(MARKER),
    outFile: join(OUT_DIR, '3-model-astra.txt'),
  }),
);

results.push(
  run('4. -c model_reasoning_effort=high', {
    args: [...base, '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=high'],
    prompt: say(MARKER),
    outFile: join(OUT_DIR, '4-effort-high.txt'),
  }),
);

results.push(
  run('5. -c model_reasoning_effort=low', {
    args: [...base, '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=low'],
    prompt: say(MARKER),
    outFile: join(OUT_DIR, '5-effort-low.txt'),
  }),
);

results.push(
  run('6. 反证：不存在的模型 id', {
    args: [...base, '-m', 'no-such-model-xyz-9999'],
    prompt: say(MARKER),
    outFile: join(OUT_DIR, '6-bogus-model.txt'),
  }),
);

results.push(
  run('7. 反证：非法 effort 档位', {
    args: [...base, '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=not-a-real-level'],
    prompt: say(MARKER),
    outFile: join(OUT_DIR, '7-bogus-effort.txt'),
  }),
);

results.push(
  run('8. --json 事件流', {
    args: [...base, '-m', 'gpt-6-luna', '--json'],
    prompt: say(MARKER),
    outFile: join(OUT_DIR, '8-json.txt'),
  }),
);

writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 2), 'utf8');

console.log('\n\n================ 汇总 =========================');
console.log(['用例', '退出码', '耗时s', '-o字节', '标记'].join('\t'));
for (const r of results) {
  console.log(
    [r.label, String(r.status), (r.elapsedMs / 1000).toFixed(1), String(r.outFileBytes), String(r.markerInOutFile)].join('\t'),
  );
}
console.log('\n--- 各用例由 codex 自报的路由事实 ---');
for (const r of results) {
  console.log(`${r.label}\n    ${JSON.stringify(r.route)}`);
}
console.log('\n详情已写入 raw/codex-probe/summary.json');
