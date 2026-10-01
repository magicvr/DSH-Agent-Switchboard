// 第三轮：判明 claude 的**调用形态**是否正确（把「模型名」变量隔离出去）。
//
// 第二轮结论：claude 无论传不传 `--model` 都报
//   `"gpt-5.6-luna" isn't described by this version's model catalog`
// 因为 `~/.claude/settings.json` 的 `env.ANTHROPIC_MODEL`（以及
// `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL`）都被固定成 `gpt-5.6-luna`，
// 而这个模型名在它的网关里不存在。**这是 claude 侧的配置问题，与插件无关。**
//
// 本脚本做两件事：
//   1. 从网关的 `/v1/models` 拉真实模型列表（只读，不发推理请求）；
//   2. 清掉那几个变量、显式给一个网关认可的模型，验证 `-p` 调用形态本身是否可行。
//
// 用法：node scripts/probe-claude-isolate.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CLAUDE = 'C:\\Users\\magicvr\\.local\\bin\\claude.exe';
const MARK = 'CLI_PROBE_OK';

// --- 1) 读 ~/.claude/settings.json 拿到网关地址 ------------------------------------
const settingsPath = `${process.env.USERPROFILE}\\.claude\\settings.json`;
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const baseUrl = settings?.env?.ANTHROPIC_BASE_URL;
const token = settings?.env?.ANTHROPIC_AUTH_TOKEN;
console.log(`网关: ${baseUrl ?? '（未配置）'}`);
if (baseUrl === undefined) process.exit(0);

// --- 2) 拉模型列表 ----------------------------------------------------------------
try {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
  const body = await res.text();
  console.log(`\nGET ${baseUrl}/models → HTTP ${res.status}`);
  let ids = [];
  try {
    const j = JSON.parse(body);
    ids = (j.data ?? j.models ?? []).map((m) => m?.id ?? m?.name).filter((s) => typeof s === 'string');
  } catch {
    /* 非 JSON，原样打印 */
  }
  if (ids.length > 0) {
    console.log(`可用模型（${ids.length} 个）：`);
    for (const id of ids.slice(0, 40)) console.log(`  ${id}`);
  } else {
    console.log(`响应（截断）：${body.slice(0, 500)}`);
  }

  // --- 3) 清掉覆盖变量后验证调用形态 ---------------------------------------------
  const env = { ...process.env };
  for (const k of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ]) {
    delete env[k];
  }
  // 从一个「已知存在的模型」里挑一个；没有就跳过。
  const probeModel = ids[0];
  console.log(`\n--- 隔离验证：清掉模型覆盖变量，--model ${probeModel ?? '（无可用模型，跳过）'} ---`);
  if (probeModel !== undefined) {
    const r = spawnSync(CLAUDE, ['-p', '--model', probeModel], {
      encoding: 'utf8',
      timeout: 180000,
      shell: false,
      windowsHide: true,
      env,
      input: `Reply with exactly this token and nothing else: ${MARK}`,
    });
    const status = r.error !== undefined ? `error:${r.error.code}` : r.status;
    const out = (r.stdout ?? '').trim();
    const err = (r.stderr ?? '').trim();
    console.log(`退出=${status}`);
    console.log(`stdout(${out.length}B): ${out.slice(0, 300) || '（空）'}`);
    console.log(`stderr(${err.length}B): ${err.slice(0, 300) || '（空）'}`);
    console.log(`标记串出现: ${out.includes(MARK)}`);
  }
} catch (error) {
  console.log(`拉取模型列表失败：${error.message}`);
}
