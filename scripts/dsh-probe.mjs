// 一步到位的只读取证明令：不落任何文件，直接在内存里解析 asar。
// 用法：node scripts/dsh-probe.mjs <mode> [arg]
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = join(here, 'inline-asar-probe.mjs');
const DEFAULT_ARCHIVE =
  'C:\\Users\\magicvr\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar';

const archive = process.env.DSH_ASAR || DEFAULT_ARCHIVE;
if (!existsSync(archive)) {
  console.error(`找不到归档：${archive}`);
  process.exit(1);
}

const [mode, arg] = process.argv.slice(2);
const r = spawnSync(process.execPath, [PROBE, archive, mode, arg], { stdio: 'inherit' });
process.exit(r.status ?? 1);
