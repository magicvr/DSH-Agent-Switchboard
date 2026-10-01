// 只读诊断：解压会话记录，抽取每个子代理会话实际使用的 provider / model / effort。
//
// 为什么需要它：模型名**不会**出现在子代理自己的上下文里（worker 自报
// "not stated in my context"，这是它的诚实回答）。因此「角色是否真的用上了各自
// 指定的模型」只能从**持久化的会话记录**里取权威答案，不能靠询问子代理。
//
// session.v4.jsonl.zstd 是 zstd 压缩的 JSONL；首行应为 session header。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { join } from 'node:path';

/**
 * 解压一个会话文件。
 *
 * ⚠️ 不能用 `zstdDecompressSync`：会话文件由**多个 zstd frame** 组成，
 * 一次性同步解压只会返回第一个 frame（实测只解出 311 字节的头部，
 * 而文件有 22–287 KB）。必须用流式解码器按顺序消费全部 frame。
 *
 * @param {string} file - 会话文件路径。
 * @returns {Promise<string>} 解压后的完整文本。
 */
function decompressAllFrames(file) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const decoder = createZstdDecompress();
    decoder.on('data', (chunk) => chunks.push(chunk));
    decoder.on('error', reject);
    decoder.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    decoder.end(readFileSync(file));
  });
}

const dir = process.argv[2];
if (!dir) {
  console.error('用法：node scripts/inspect-sessions.mjs <会话目录>');
  process.exit(1);
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
 * 在任意嵌套结构里寻找 provider/model/effort 三元组。
 * 记录格式随版本变化，因此用结构搜索而不是写死路径。
 *
 * @param {unknown} value - 待搜索的值。
 * @param {string} path - 当前路径，用于报告来源。
 * @param {Array<{path: string, data: object}>} out - 收集结果。
 */
function findRouteConfigs(value, path, out) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => findRouteConfigs(item, `${path}[${i}]`, out));
    return;
  }
  const hasModel = typeof value.model === 'string';
  const hasProvider = typeof value.provider === 'string';
  if (hasModel || hasProvider) {
    const { provider, model, reasoningEffort, maxTokens } = value;
    out.push({ path, data: { provider, model, reasoningEffort, maxTokens } });
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'stream' || key === 'content') continue; // 跳过体积大且无关的字段
    findRouteConfigs(child, `${path}.${key}`, out);
  }
}

for (const file of findRecords(dir)) {
  const text = await decompressAllFrames(file);
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const sessionName = file.split(/[\\/]/).slice(-2)[0];

  console.log(`\n================ ${sessionName} ================`);
  console.log(`记录行数: ${lines.length}   文本字节: ${Buffer.byteLength(text)}`);

  // 头部：第一行通常是 session header
  try {
    const header = JSON.parse(lines[0]);
    const h = header.data ?? header;
    const keys = Object.keys(h).slice(0, 14);
    console.log(`首行字段: ${keys.join(', ')}`);
    const interesting = {
      delegationDepth: h.delegationDepth,
      cwd: h.cwd,
      parentSession: h.parentSession,
      origin: h.origin,
      agentPreset: h.agentPreset,
    };
    console.log(`头部摘要: ${JSON.stringify(interesting)}`);
  } catch (error) {
    console.log(`首行无法解析为 JSON: ${error.message}`);
  }

  // 在全部事件里搜索 route 配置
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

  // 去重后打印
  const seen = new Set();
  for (const { path, data } of routes) {
    const key = JSON.stringify(data);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${JSON.stringify(data)}   <- ${path}`);
  }
  if (routes.length === 0) console.log('  （未找到 provider/model 配置）');
}
