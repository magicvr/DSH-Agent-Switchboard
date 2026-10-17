// 只读解析 Electron asar 归档：解析头部索引，按 offset/size 直接切片。
// 不写任何文件，也不依赖 Electron 的 fs 补丁。
import { readFileSync } from 'node:fs';

/**
 * 打开一个 asar 归档。
 *
 * @param {string} archivePath - 归档绝对路径。
 * @returns {{entries: {path: string, offset: number, size: number}[], read: (path: string) => Buffer|undefined}}
 *   `entries` 为全部文件条目（含路径与偏移），`read` 按归档内路径取内容；不存在时返回 undefined。
 */
export function openAsar(archivePath) {
  const buffer = readFileSync(archivePath);
  // 布局：4B 长度 + 4B headerSize + 4B jsonSize + json header + 数据区。
  const headerSize = buffer.readUInt32LE(4);
  const jsonSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'));
  const dataStart = 8 + headerSize;

  const entries = [];
  (function walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, path);
      else entries.push({ path, offset: Number(child.offset ?? 0), size: child.size ?? 0 });
    }
  })(header, '');

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const read = (path) => {
    const entry = byPath.get(path);
    if (entry === undefined) return undefined;
    const start = dataStart + entry.offset;
    return buffer.subarray(start, start + entry.size);
  };
  return { entries, read };
}

/**
 * 读取归档内一个 JSON 文件。
 *
 * @param {ReturnType<typeof openAsar>} archive - 已打开的归档。
 * @param {string} path - 归档内路径。
 * @returns {object|undefined} 解析结果；文件不存在时返回 undefined。
 */
export function readJson(archive, path) {
  const buffer = archive.read(path);
  return buffer === undefined ? undefined : JSON.parse(buffer.toString('utf8'));
}
