// 读取网关模型列表，清除进程模型覆盖变量，再验证用户声明的隔离调用。
// 用法：node scripts/probes/probe-claude-isolate.mjs --cli-config <JSON.local> [--settings <JSON>]
// cases 名称以 isolate. 开头；model 必须由用户指定并在网关列表中存在。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadCliConfig } from '../lib/cli-config.mjs';
import { runProbe } from '../lib/probe-cli.mjs';
import { PATH_FLAGS, parsePathArgs, pathValue } from '../lib/paths.mjs';

const MARK = 'CLI_PROBE_OK';

try {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('用法：node scripts/probes/probe-claude-isolate.mjs --cli-config <JSON.local> [--settings <JSON>] [--cwd <目录>]');
    console.log('执行 isolate.* 用例；入口、参数、模型来自 CLI 配置。settings 默认 os.homedir()/.claude/settings.json，与 DSH_HOME 无关。');
  } else {
    const options = parsePathArgs(argv, [...PATH_FLAGS, 'settings']);
    const pathArgs = Object.entries(options).filter(([key]) => key !== 'settings').flatMap(([key, value]) => [`--${key}`, value]);
    const loaded = loadCliConfig({ argv: pathArgs });
    const names = Object.keys(loaded.config.cases).filter(name => name.startsWith('isolate.'));
    if (!names.length) throw new Error('配置缺少 isolate. 开头的 CLI 用例');
    for (const name of names) if (!loaded.config.cases[name].model) throw new Error(`${name}.model 必须显式配置`);
    const settingsPath = Object.hasOwn(options, 'settings')
      ? pathValue(options.settings, '--settings', process.cwd()) : join(homedir(), '.claude', 'settings.json');
    console.log(`CLI 配置：${loaded.file} [${loaded.source}]`);
    console.log(`Claude settings: ${settingsPath} [${Object.hasOwn(options, 'settings') ? '--settings' : 'os.homedir()'}]`);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const baseUrl = settings?.env?.ANTHROPIC_BASE_URL;
    const token = settings?.env?.ANTHROPIC_AUTH_TOKEN;
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new Error('Claude settings 缺少 env.ANTHROPIC_BASE_URL');
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/models`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网关地址必须是无内嵌凭据的 HTTP(S) URL');
    const res = await fetch(url, {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    console.log(`GET 网关 /models → HTTP ${res.status}`);
    if (!res.ok) throw new Error(`拉取模型列表失败：HTTP ${res.status}`);
    const body = await res.json();
    const models = body.data ?? body.models;
    if (!Array.isArray(models)) throw new Error('网关响应缺少 data / models 数组');
    const ids = models.map(model => model?.id ?? model?.name).filter(id => typeof id === 'string');
    console.log(`可用模型：${ids.length} 个`);
    for (const name of names) {
      if (!ids.includes(loaded.config.cases[name].model)) throw new Error(`${name}.model 不在网关模型列表中`);
    }
    const env = { ...process.env };
    for (const key of [
      'ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
      ...['SONNET', 'OPUS', 'HAIKU', 'FABLE'].flatMap(kind => [`ANTHROPIC_DEFAULT_${kind}_MODEL`, `ANTHROPIC_DEFAULT_${kind}_MODEL_NAME`]),
    ]) delete env[key];
    console.log('隔离验证：已清除进程环境中的模型覆盖变量；Claude 设置文件保持原样。');
    for (const name of names) {
      const result = await runProbe({ loaded, pathArgs }, name,
        `Reply with exactly this token and nothing else: ${MARK}`, 180000, { env });
      console.log(`退出=${result.status} stdout=${result.stdout.length}B stderr=${result.stderr.length}B`);
      const marked = result.stdout.includes(MARK);
      console.log(`标记串出现: ${marked}`);
      if (!marked) process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`Claude 隔离探针失败：${error.message}`);
  process.exitCode = 1;
}
