// 生成 Switchboard 的 Agent preset 声明文件。
//
// 方案 A：复制 `standard` 的**完整**插件清单，再叠加本插件。
//
// 为什么用「文本行复制」而不是 YAML 序列化：
//   `standard.patch.yml` 里有 `disabled: !!js process.platform === 'win32'` 这类表达式。
//   `yaml` 库解析后会把 `!!js` 变成**普通字符串**，再序列化就得到
//   `disabled: process.platform === 'win32'` —— 一个非空字符串在 YAML 里是真值，
//   于是「Windows 上禁用 bash、非 Windows 上禁用 pwsh」这条规则会**静默反转**。
//   为保住标签，这里逐行搬运原文并只调整缩进。
//
// 用法：
//   node scripts/gen-preset.mjs            写入 presets/switchboard.patch.yml
//   node scripts/gen-preset.mjs --check     只比对漂移，不写盘
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { generatePreset } from './lib/preset-generator.mjs';
import { captureSync } from './lib/capture.mjs';

const ROOT = process.cwd();
// 用裸说明符由 Node 自行解析入口（`yaml` 的入口不是 index.js）。
const { parse } = await import('yaml');

const STANDARD_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml';
const PRESET_ID = 'preset-switchboard';
const PRESET_KEY = 'switchboard';
const SELF_PACKAGE = '@magicvr/dsh-agent-switchboard';
const OUT_FILE = join(ROOT, 'presets', 'switchboard.patch.yml');

/**
 * 读取归档内某个文件的文本（复用只读探针 dsh-cat.mjs）。
 *
 * @param {string} asarPath - 归档内路径。
 * @returns {string} 文件文本。
 */
function cat(asarPath) {
  const result = captureSync(process.execPath, [join(ROOT, 'scripts', 'dsh-cat.mjs'), asarPath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? Object.assign(new Error(`dsh-cat 失败：退出码 ${result.status}，信号 ${result.signal ?? '-'}\n${result.stderr}`), result);
  }
  return result.stdout;
}

/** standard preset 的原始文本。 */
const standardText = cat(STANDARD_ENTRY);

const { body, standardPlugins, patchedIds } = generatePreset(standardText, SELF_PACKAGE);


// 断言：原文里的 !!js 表达式必须一字不少地带过来。
// ⚠️ 只统计**非注释行** —— 文件头注释里提到了 `!!js`，全文计数会把它算进来，
// 造成假失败（第一版就是这样）。
const countJsTags = (text) =>
  text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
    .match(/!!js /g)?.length ?? 0;

const jsTagsIn = countJsTags(standardText);
const jsTagsOut = countJsTags(body);
console.log(`standard 插件数: ${standardPlugins.length}`);
console.log(`本插件条目: 1，合计 ${standardPlugins.length + 1}`);
console.log(`!!js 表达式（非注释行）: 原文 ${jsTagsIn} 个 → 产物 ${jsTagsOut} 个`);
if (jsTagsIn !== jsTagsOut) {
  console.error('FAIL  !!js 表达式数量不一致 —— 标签可能被破坏');
  process.exit(1);
}
console.log('PASS  !!js 表达式全部保留');

// 产物必须仍能被解析，且插件数与预期一致。
let produced;
try {
  produced = parse(body);
} catch (error) {
  console.error(`FAIL  产物无法解析：${error.message}`);
  process.exit(1);
}
const producedPlugins = produced[0].insert[0].config.plugins;
if (producedPlugins.length !== standardPlugins.length + 1) {
  console.error(`FAIL  产物插件数 ${producedPlugins.length} 不符（期望 ${standardPlugins.length + 1}）`);
  process.exit(1);
}
if (!producedPlugins.some((p) => p.name === SELF_PACKAGE)) {
  console.error('FAIL  产物未引用本包');
  process.exit(1);
}
console.log('PASS  产物可解析、插件数正确、含本包');
console.log(
  patchedIds.length > 0
    ? `改动：禁用 standard 的通用委派工具 ${patchedIds.join(', ')}（避免架空角色分工）`
    : '改动：（无）',
);

// 漂移检测：与已落盘的产物比对插件名序列。
let drift = false;
if (existsSync(OUT_FILE)) {
  const existing = parse(readFileSync(OUT_FILE, 'utf8'));
  const existingNames = existing[0].insert[0].config.plugins.map((p) => p.name);
  const producedNames = producedPlugins.map((p) => p.name);
  if (JSON.stringify(existingNames) !== JSON.stringify(producedNames)) {
    drift = true;
    console.warn('\n⚠️  已落盘的 presets/switchboard.patch.yml 与当前 standard 清单**不一致**：');
    console.warn(`    落盘 ${existingNames.length} 项，当前 standard ${producedNames.length} 项`);
    const missing = producedNames.filter((n) => !existingNames.includes(n));
    const extra = existingNames.filter((n) => !producedNames.includes(n));
    if (missing.length) console.warn(`    应新增：${missing.join(', ')}`);
    if (extra.length) console.warn(`    已移除：${extra.join(', ')}`);
  } else {
    console.log('\nPASS  无漂移（与当前 standard 清单一致）');
  }
} else {
  console.log('\n（尚无落盘文件）');
}

if (process.argv.includes('--check')) {
  console.log(drift ? '\n--check：存在漂移，需要重新生成。' : '\n--check：一致。');
  process.exit(drift ? 1 : 0);
}

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, body, 'utf8');
console.log(`\n已写入 ${OUT_FILE}`);
