// 第一轮：比较各 CLI 的非交互入口、提示词传递与输出。
// 模型/强度/参数来自本地配置；共用模型实验在 run.* 用例配置相同模型。
// 用法：node scripts/probe-cli-run.mjs --cli-config <JSON.local>
import { probeConfig, runProbe } from './lib/probe-cli.mjs';

const MARK = 'CLI_PROBE_OK';
const PROMPT = `Reply with exactly this token and nothing else: ${MARK}`;

try {
  const config = probeConfig('run');
  for (const name of config.names) {
    const r = await runProbe(config, name, PROMPT, 150000);
    const status = r.error ? `error:${r.error.code ?? r.error.message}` : r.status;
    const stdout = r.stdout.trim();
    const stderr = r.stderr.trim();
    console.log(`\n${'='.repeat(64)}\n${name}   退出=${status}  耗时=${(r.elapsedMs / 1000).toFixed(1)}s\n${'='.repeat(64)}`);
    console.log(`stdout(${stdout.length}B): ${stdout.slice(0, 300) || '（空）'}`);
    console.log(`stderr(${stderr.length}B): ${stderr.slice(0, 500) || '（空）'}`);
    console.log(`标记串出现: stdout=${stdout.includes(MARK)}  stderr=${stderr.includes(MARK)}`);
  }
} catch (error) {
  console.error(`CLI 第一轮探针失败：${error.message}`);
  process.exitCode = 1;
}
