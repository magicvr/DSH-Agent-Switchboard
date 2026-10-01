// 一次性读取 asar 内指定文件的全文（不落临时文件）。
// 用法：node scripts/dsh-cat.mjs <archive-relative-path>
import { readFileSync } from 'node:fs';
import { resolveAsar } from './lib/paths.mjs';

let archive;
try {
  const selected = resolveAsar();
  archive = selected.archive;
  console.error(`ASAR: ${archive} [${selected.source}]`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const wanted = process.argv[2];

if (!wanted) {
  console.error('用法：node scripts/dsh-cat.mjs <asar 内相对路径>');
  process.exit(1);
}

const fd = readFileSync(archive);
const jsonSize = fd.readUInt32LE(12);
const header = JSON.parse(fd.subarray(16, 16 + jsonSize).toString('utf8'));
const dataStart = 8 + fd.readUInt32LE(4);

let node = header;
for (const part of wanted.split('/')) {
  node = node?.files?.[part];
  if (!node) {
    console.error(`归档内不存在：${wanted}`);
    process.exit(1);
  }
}
if (node.files) {
  console.error(`这是目录，不是文件：${wanted}`);
  process.exit(1);
}
const start = dataStart + Number(node.offset ?? 0);
process.stdout.write(fd.subarray(start, start + (node.size ?? 0)));
