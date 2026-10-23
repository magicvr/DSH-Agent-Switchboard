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
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { generatePreset, roleRowsTemplate } from './lib/preset-generator.mjs';
import { captureSync } from './lib/capture.mjs';

const ROOT = process.cwd();
// 用裸说明符由 Node 自行解析入口（`yaml` 的入口不是 index.js）。
const { parse } = await import('yaml');
/** `!!js` 表达式在生成物里必须原样保留；解析只用于结构校验，绝不求值。 */
const parseYaml = text => parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });

const STANDARD_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml';
const SELF_PACKAGE = '@magicvr/dsh-agent-switchboard';
const OUT_FILE = join(ROOT, 'presets', 'switchboard.patch.yml');
// 角色 preset 的**行模板**：同一份标准清单的数据形态，供 Host 在运行期按角色裁剪。
// 与 YAML 产物同源同批生成，`--check` 一起比对，避免两者漂移。
const OUT_ROWS_FILE = join(ROOT, 'presets', 'standard-plugins.json');
const original = existsSync(OUT_FILE) ? readFileSync(OUT_FILE) : null;
const expectedHash = process.env.DSH_PRESET_EXPECTED_SHA256;
if (expectedHash && (!original || createHash('sha256').update(original).digest('hex') !== expectedHash)) {
  console.error('FAIL  preset 文件在规划后已改变，请重新运行');
  process.exit(1);
}

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

const { body, standardPlugins, patchedIds, presets } = generatePreset(standardText, SELF_PACKAGE);


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
console.log(`preset 数: ${presets.length}，每个 ${standardPlugins.length + 1} 行（含本插件条目）`);
console.log(`!!js 表达式（非注释行）: 原文 ${jsTagsIn} 个 → 产物 ${jsTagsOut} 个（期望 ${jsTagsIn * presets.length}）`);
if (jsTagsOut !== jsTagsIn * presets.length) {
  console.error('FAIL  !!js 表达式数量不一致 —— 标签可能被破坏');
  process.exit(1);
}
console.log('PASS  !!js 表达式全部保留');

// 产物必须仍能被解析，且每个 preset 的插件数与展示信息一致。
let produced;
try {
  produced = parseYaml(body);
} catch (error) {
  console.error(`FAIL  产物无法解析：${error.message}`);
  process.exit(1);
}
const inserted = produced[0]?.insert;
if (!Array.isArray(inserted) || inserted.length !== presets.length) {
  console.error(`FAIL  产物 insert 条目数 ${Array.isArray(inserted) ? inserted.length : '非数组'} 不符（期望 ${presets.length}）`);
  process.exit(1);
}
for (const expected of presets) {
  const row = inserted.find((item) => item.id === expected.id);
  if (!row) {
    console.error(`FAIL  产物缺少 ${expected.id}`);
    process.exit(1);
  }
  const config = row.config;
  const self = config?.plugins?.find((plugin) => plugin.name === SELF_PACKAGE);
  if (!self) {
    console.error(`FAIL  ${expected.id} 未引用本包`);
    process.exit(1);
  }
  if (config.id !== expected.key || config.name !== expected.name
    || config.description !== expected.description || config.order !== expected.order) {
    console.error(`FAIL  ${expected.id} 的展示信息与生成器预期不一致`);
    process.exit(1);
  }
  if (self.config?.compositionKey !== expected.compositionKey
    || JSON.stringify(self.config?.excludedRoles ?? []) !== JSON.stringify(expected.excludedRoles)) {
    console.error(`FAIL  ${expected.id} 的组合键或排除角色与生成器预期不一致`);
    process.exit(1);
  }
  if (config.plugins.length !== standardPlugins.length + 1) {
    console.error(`FAIL  ${expected.id} 插件数 ${config.plugins.length} 不符（期望 ${standardPlugins.length + 1}）`);
    process.exit(1);
  }
}
console.log('PASS  产物可解析、两个 preset 的展示信息/组合键/插件数正确、均含本包');
console.log(
  patchedIds.length > 0
    ? `改动：两个 preset 都禁用 standard 的通用委派工具 ${patchedIds.join(', ')}（避免架空角色分工）`
    : '改动：（无）',
);

// 角色 preset 的行模板（数据形态）。与 YAML 产物同源，必须一起保持一致。
const roleRows = roleRowsTemplate(standardPlugins);
const rowsBody = JSON.stringify({
  generatedFrom: STANDARD_ENTRY,
  note: '由 scripts/gen-preset.mjs 生成，请勿手改：Host 在运行期据此按角色裁剪出独立 preset。',
  rows: roleRows,
}, null, 2) + '\n';

// 漂移检测：逐字节比对已落盘产物。只比插件名会漏掉 preset 名称、说明与
// supervisorRules 的改动（历史教训：规则漂移不在 check 主链内，很久没被发现）。
// 字节不一致时再按 preset 给出可读差异，便于定位。
let drift = false;
if (existsSync(OUT_FILE)) {
  const existingBytes = readFileSync(OUT_FILE);
  if (existingBytes.equals(Buffer.from(body))) {
    console.log('\nPASS  无漂移（落盘产物与生成器逐字节一致）');
  } else {
    drift = true;
    console.warn('\n⚠️  已落盘的 presets/switchboard.patch.yml 与生成器产物**不一致**。');
    let existing;
    try { existing = parseYaml(existingBytes.toString('utf8')); } catch { existing = null; }
    const existingInsert = existing?.[0]?.insert;
    if (!Array.isArray(existingInsert) || existingInsert.length !== presets.length) {
      console.warn(`    落盘 preset 数 ${Array.isArray(existingInsert) ? existingInsert.length : '无法解析'}，产物 ${presets.length} 个`);
    }
    for (const expected of presets) {
      const row = Array.isArray(existingInsert) ? existingInsert.find((item) => item.id === expected.id) : undefined;
      if (!row) { console.warn(`    缺少 preset：${expected.id}`); continue; }
      const existingNames = (row.config?.plugins ?? []).map((p) => p.name);
      const producedNames = inserted.find((item) => item.id === expected.id).config.plugins.map((p) => p.name);
      if (JSON.stringify(existingNames) !== JSON.stringify(producedNames)) {
        console.warn(`    ${expected.id} 的插件清单与 standard 不一致（落盘 ${existingNames.length} 项，产物 ${producedNames.length} 项）`);
        const missing = producedNames.filter((n) => !existingNames.includes(n));
        const extra = existingNames.filter((n) => !producedNames.includes(n));
        if (missing.length) console.warn(`      应新增：${missing.join(', ')}`);
        if (extra.length) console.warn(`      已移除：${extra.join(', ')}`);
      } else {
        console.warn(`    ${expected.id} 的插件名一致，差异在名称/说明/规则或其它字节。`);
      }
    }
  }
} else {
  console.log('\n（尚无落盘文件）');
}

// 行模板漂移：内容必须逐字节一致，因为它决定角色子代理能拿到什么工具。
if (existsSync(OUT_ROWS_FILE)) {
  const existingRows = readFileSync(OUT_ROWS_FILE, 'utf8');
  if (existingRows !== rowsBody) {
    drift = true;
    console.warn('⚠️  已落盘的 presets/standard-plugins.json 与当前 standard 不一致（内容有变）。');
  } else {
    console.log('PASS  行模板无漂移（standard-plugins.json 一致）');
  }
} else {
  console.log('（尚无行模板文件）');
}

if (process.argv.includes('--check')) {
  console.log(drift ? '\n--check：存在漂移，需要重新生成。' : '\n--check：一致。');
  process.exit(drift ? 1 : 0);
}

mkdirSync(dirname(OUT_FILE), { recursive: true });
const temp = `${OUT_FILE}.${randomBytes(6).toString('hex')}.tmp`;
try {
  writeFileSync(temp, body, { encoding: 'utf8', flag: 'wx' });
  const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE) : null;
  if (original === null ? current !== null : current === null || !original.equals(current))
    throw new Error('preset 文件在规划后已改变，拒绝写入，请重新运行');
  renameSync(temp, OUT_FILE);
} finally { if (existsSync(temp)) unlinkSync(temp); }
console.log(`\n已写入 ${OUT_FILE}`);

// 行模板同步落盘；同一套原子替换与「规划后未变」校验。
const rowsOriginal = existsSync(OUT_ROWS_FILE) ? readFileSync(OUT_ROWS_FILE) : null;
const rowsTemp = `${OUT_ROWS_FILE}.${randomBytes(6).toString('hex')}.tmp`;
try {
  writeFileSync(rowsTemp, rowsBody, { encoding: 'utf8', flag: 'wx' });
  const current = existsSync(OUT_ROWS_FILE) ? readFileSync(OUT_ROWS_FILE) : null;
  if (rowsOriginal === null ? current !== null : current === null || !rowsOriginal.equals(current))
    throw new Error('行模板文件在规划后已改变，拒绝写入，请重新运行');
  renameSync(rowsTemp, OUT_ROWS_FILE);
} finally { if (existsSync(rowsTemp)) unlinkSync(rowsTemp); }
console.log(`已写入 ${OUT_ROWS_FILE}`);
