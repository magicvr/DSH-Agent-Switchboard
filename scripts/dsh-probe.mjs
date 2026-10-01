// 一步到位的只读取证明令：不落任何文件，直接在内存里解析 asar。
// 用法：node scripts/dsh-probe.mjs <mode> [arg]
import { spawnSync } from 'node:child_process';
import { resolveAsar } from './lib/paths.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = join(here, 'inline-asar-probe.mjs');
let archive;
try {
  const selected = resolveAsar();
  archive = selected.archive;
  console.error(`ASAR: ${archive} [${selected.source}]`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const [mode, arg] = process.argv.slice(2);
const r = spawnSync(process.execPath, [PROBE, archive, mode, arg], { stdio: 'inherit' });
process.exit(r.status ?? 1);
