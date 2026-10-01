// 只读诊断：解压会话记录，抽取每个子代理会话实际使用的 provider / model / effort。
//
// 为什么需要它：模型名**不会**出现在子代理自己的上下文里（实测 worker 回答
// "not stated in my context"，这是它的诚实回答）。因此「角色是否真的用上了各自
// 指定的模型」只能从**持久化的会话记录**里取权威答案，不能靠询问子代理。
//
// ⚠️ 两个已踩过的坑（本脚本的注释就是为了防止再踩）：
//   1. 会话文件由**多个 zstd frame** 顺序拼成（单个会话实测可达 169 个 frame）。
//      `zstdDecompressSync` 只解第一个 frame；`createZstdDecompress` 流式解码
//      **同样只产出第一个 frame** 的内容。必须按 frame 边界逐个解压再拼接。
//   2. 截断的解压结果看起来是「成功」的，因此极易被误判为「记录里没有该信息」。
//      本脚本会报告 frame 数与解压总字节，便于发现截断。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * 按 zstd frame 边界解压整个文件。
 *
 * @param {string} file - 会话文件路径。
 * @returns {{ text: string, frames: number }} 解压文本与 frame 数。
 */
function decompressFrames(file) {
  const buf = readFileSync(file);
  const offsets = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      offsets.push(i);
    }
  }
  if (offsets.length === 0) return { text: '', frames: 0 };

  const parts = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
    } catch {
      // 单个 frame 解压失败不应让整次读取失败；跳过并继续。
    }
  }
  return { text: parts.join(''), frames: offsets.length };
}

/** 递归找出所有 session.v4.jsonl.zstd。 */
function findRecords(root) {
  const found = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) found.push(...findRecords(full));
    else if (name.endsWith('.jsonl.zstd')) found.push(full);
  }
  return found;
}

/**
 * 在嵌套结构里寻找含 provider/model 的对象。
 *
 * @param {unknown} value - 待搜索值。
 * @param {string} path - 当前路径。
 * @param {Array<{path: string, data: object}>} out - 收集结果。
 */
function findRouteConfigs(value, path, out) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => findRouteConfigs(item, `${path}[${i}]`, out));
    return;
  }
  if (typeof value.model === 'string' || typeof value.provider === 'string') {
    out.push({
      path,
      data: {
        provider: value.provider,
        model: value.model,
        reasoningEffort: value.reasoningEffort,
        maxTokens: value.maxTokens,
      },
    });
  }
  for (const [key, child] of Object.entries(value)) {
    // 跳过体积大且与路由无关的字段，避免无谓遍历。
    if (key === 'text' || key === 'stream' || key === 'content') continue;
    findRouteConfigs(child, `${path}.${key}`, out);
  }
}

const dir = process.argv[2];
if (!dir) {
  console.error('用法：node scripts/inspect-sessions.mjs <会话目录>');
  process.exit(1);
}

for (const file of findRecords(dir)) {
  const { text, frames } = decompressFrames(file);
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const sessionName = file.split(/[\\/]/).slice(-2)[0];

  console.log(`\n================ ${sessionName} ================`);
  console.log(`frame 数: ${frames}   记录行数: ${lines.length}   解压字节: ${Buffer.byteLength(text)}`);

  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    console.log('首行无法解析');
    continue;
  }
  const h = header.data ?? header;
  console.log(
    `头部: depth=${h.delegationDepth} origin=${h.origin ?? '-'} preset=${h.agentPreset ?? '-'} parent=${h.parentSession ?? '-'}`,
  );

  const routes = [];
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    findRouteConfigs(event, 'event', routes);
  }

  const seen = new Set();
  let printed = 0;
  for (const { path, data } of routes) {
    const key = JSON.stringify(data);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${JSON.stringify(data)}\n      <- ${path}`);
    if (++printed >= 12) break;
  }
  if (routes.length === 0) console.log('  （未找到 provider/model 配置）');
}
