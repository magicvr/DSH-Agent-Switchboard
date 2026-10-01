// 第二轮：各 CLI 使用各自模型，并比较有/无 effort 的调用。
// 模型/强度/参数来自本地配置；run2.* 保留有/无 effort 独立用例，不与第一轮合并。
// 用法：node scripts/probes/probe-cli-run2.mjs --cli-config <JSON.local>
import { probeConfig, runProbe } from '../lib/probe-cli.mjs';

const MARK = 'CLI_PROBE_OK';
const PROMPT = `Reply with exactly this token and nothing else: ${MARK}`;

try {
  const config = probeConfig('run2');
  for (const name of config.names) {
    const r = await runProbe(config, name, PROMPT, 180000);
    const status = r.error ? `error:${r.error.code ?? r.error.message}` : r.status;
    const stdout = r.stdout.trim();
    const stderr = r.stderr.trim();
    console.log(`\n${'='.repeat(64)}\n${name}   退出=${status}  耗时=${(r.elapsedMs / 1000).toFixed(1)}s\n${'='.repeat(64)}`);
    console.log(`stdout(${stdout.length}B): ${stdout.slice(0, 260) || '（空）'}`);
    console.log(`stderr(${stderr.length}B): ${stderr.slice(0, 400) || '（空）'}`);
    console.log(`标记串出现: stdout=${stdout.includes(MARK)}  stderr=${stderr.includes(MARK)}`);
  }
} catch (error) {
  console.error(`CLI 第二轮探针失败：${error.message}`);
  process.exitCode = 1;
}
