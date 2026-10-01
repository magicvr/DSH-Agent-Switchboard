// Codex 非交互探针：入口、参数、模型/强度及提示词传递均由本地配置声明。
// 配置 codex.* 用例可重现基线、换模型、high/low、非法模型/effort、JSON 事件流实验。
// 用法：node scripts/probes/probe-codex.mjs --cli-config <JSON.local> [--out-dir <目录>] [--cwd <目录>]
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { probeConfig, runProbe } from '../lib/probe-cli.mjs';

const TIMEOUT_MS = 180_000;
const MARKER = 'SWITCHBOARD_PROBE_OK';
const PROMPT = `Reply with exactly this token and nothing else: ${MARKER}`;

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

async function run(config, label) {
  console.log(`\n================ ${label} ================`);
  const result = await runProbe(config, label, PROMPT, TIMEOUT_MS, {
    maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' },
  });
  const elapsedMs = result.elapsedMs;
  // -o 路径只读取用户已配置的 argv，绝不追加或改写 CLI 参数。
  const argv = result.invocation.argv;
  const outIndex = argv.indexOf('-o');
  const outArg = outIndex < 0 ? argv.find(arg => arg.startsWith('--output-last-message='))?.slice('--output-last-message='.length)
    ?? (argv.includes('--output-last-message') ? argv[argv.indexOf('--output-last-message') + 1] : undefined) : argv[outIndex + 1];
  const outFile = outArg ? resolve(result.invocation.options.cwd, outArg) : undefined;

  const outText = (outFile !== undefined && existsSync(outFile)) ? readFileSync(outFile, 'utf8') : '';
  const stderr = result.stderr ?? '';
  const facts = {
    label,
    elapsedMs,
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.message ?? result.error) : undefined,
    stdoutBytes: (result.stdout ?? '').length,
    stderrBytes: stderr.length,
    outFile,
    outFileExists: (outFile !== undefined && existsSync(outFile)),
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

  const index = config.names.indexOf(label) + 1;
  writeFileSync(join(config.outDir, `${index}-stdout.txt`), result.stdout, 'utf8');
  writeFileSync(join(config.outDir, `${index}-stderr.txt`), stderr, 'utf8');
  return facts;
}

try {
  const config = probeConfig('codex', { output: true });
  mkdirSync(config.outDir, { recursive: true });
  console.log(`报告目录：${config.outDir}`);
  const results = [];
  for (const name of config.names) results.push(await run(config, name));

  writeFileSync(join(config.outDir, 'summary.json'), JSON.stringify(results, null, 2), 'utf8');

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
  console.log(`\n详情已写入 ${join(config.outDir, 'summary.json')}`);

} catch (error) {
  console.error(`Codex 探针失败：${error.message}`);
  process.exitCode = 1;
}
