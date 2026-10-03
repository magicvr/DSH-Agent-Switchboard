// 修正 CLI 角色的 model，并确保根条目有 `cwd`。
//
// ## 为什么需要
//
// 1. **模型**：UI 的驱动选择器**不会**自动填模型（每个 CLI 有自己的模型命名空间，
//    插件给不出通用默认值），因此换驱动后模型很可能还是旧的内置路由名。实测：
//      - grok + `gpt-6-luna`   → 退出 1，`unknown model id`
//      - grok + `grok-4.7`     → 退出 0
//      - codex + `gpt-6.1-sol` → 退出 0（自报 `model: gpt-6.1-sol`）
// 2. **cwd**：CLI 角色必须有工作目录，`normalizeRole` 在 `cliCwd` 与全局 `cwd` 都为空时
//    报错并**不挂载该角色**。根条目 config 原本没有 `cwd`，于是「从 UI 新建 CLI 角色」
//    必然带空 `cliCwd`，到装载期才失败。
//
// ## 实现约束（都是踩过的坑）
//
// - **按行处理，不用 `indexOf` 猜位置**：上一版用 `out.indexOf('provider:')` 结果匹配到了
//   文件里**另一处**无缩进的 `provider:`，插入 `cwd` 时缩进错位、把 YAML 写坏。
//   现在先按缩进确定根条目 config 块的范围，只在该范围内操作。
// - **文本层修改**，不用 `yaml.stringify` 整体重写：整体重写会把 `!!js` 表达式降级成
//   普通字符串，使 platform 条件静默失效。
// - **先断言后写盘**：任何一条断言不过就完全不写。
//
// 用法：
//   node scripts/ops/fix-cli-models.mjs --check
//   node scripts/ops/fix-cli-models.mjs --apply
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parse } from 'yaml';
// 用**驱动表本身**产出参数模板，而不是在这里再写一份 ——
// 界面「一键填好」用的也是这个函数，因此脚本改出来的值与界面一致（有漂移断言锁定）。
import { cliFieldsFor } from '../../src/cli/drivers.js';
import { readConfigFileDetailed, writeConfigFile } from '../../src/config-file.js';
import { parsePathArgs, resolvePaths, printPaths } from '../lib/paths.mjs';

const pathArgv = process.argv.slice(2).filter(a => !['--apply', '--check'].includes(a));
const options = parsePathArgs(pathArgv, ['home', 'profile', 'patch', 'roles-file', 'cwd']);
const paths = resolvePaths({ argv: pathArgv });
printPaths(paths);
const PATCH = paths.patch;
const ROLES_FILE = paths.roles;
if (Object.hasOwn(options, 'roles-file') && !existsSync(ROLES_FILE)) {
  throw new Error(`找不到显式 roles 文件：${ROLES_FILE}`);
}
const mode = process.argv.includes('--apply') ? 'apply' : 'check';
const fileRead = readConfigFileDetailed(ROLES_FILE);
if (!fileRead.ok) {
  const format = fileRead.format;
  console.error(format?.status === 'future' || format?.status === 'unsupported'
    ? `FAIL  磁盘配置版本 ${JSON.stringify(format.onDiskVersion)}，支持版本 ${format.currentVersion}；拒绝修正，所有文件保持原状。${fileRead.error}`
    : `FAIL  无法读取 roles 配置，所有文件保持原状：${fileRead.error}`);
  process.exit(1);
}
const backupSuffix = () => `${Date.now()}-${randomBytes(4).toString('hex')}`;

/**
 * 期望的「角色 → 字段修正」。只列需要改的；`worker` 的模型已实测可用故不动。
 *
 * `promptDelivery: 'promptFile'` 是**必须**的（不是偏好）：实测 grok 用 `argv` 模式传
 * 多行提示词会直接报「占位符 {prompt} 的值含换行或 NUL」，而真实提示词几乎都是多行的。
 * 改用 grok 自己的 `--prompt-file`（已实测支持多行）后该限制消失。
 */
const WANTED = {
  scout: { driver: 'grok', model: 'grok-4.7', promptDelivery: 'promptFile' },
};

let pass = 0;
let fail = 0;
/**
 * 断言。
 *
 * @param {string} label - 说明。
 * @param {boolean} c - 条件。
 * @param {string} [d] - 详情。
 */
function check(label, c, d = '') {
  if (c) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${d ? ` — ${d}` : ''}`);
  }
}

const original = readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n');
const lines = original.split('\n');
const doc = parse(original);
const root = doc.find((o) => o && o.id === 'agent-switchboard');
if (root === undefined) {
  console.error('FAIL  找不到根条目 agent-switchboard');
  process.exit(1);
}
const roles = root.config?.roles ?? [];
const CWD_VALUE = Object.hasOwn(options, 'cwd') ? paths.cwd : root.config?.cwd || paths.repoRoot;
console.log(`配置 cwd: ${CWD_VALUE} [${Object.hasOwn(options, 'cwd') ? '--cwd' : root.config?.cwd ? '目标配置已有 cwd' : '仓库根（模块 URL）'}]`);

console.log('当前角色：');
for (const r of roles) {
  console.log(
    `  ${String(r.id).padEnd(11)} backend=${String(r.backend).padEnd(6)} driver=${String(r.cliDriver ?? '-').padEnd(8)} model=${r.model}`,
  );
}

/** 根条目那一行（顶层数组项）。 */
const rootLine = lines.findIndex((l) => /^-\s*id:\s*agent-switchboard\s*$/.test(l));
if (rootLine === -1) {
  console.error('FAIL  按行定位根条目失败');
  process.exit(1);
}
// 根条目块 = 从该行到下一个顶层 `- ` 之前。
let rootEnd = lines.length;
for (let i = rootLine + 1; i < lines.length; i++) {
  if (/^-\s/.test(lines[i])) {
    rootEnd = i;
    break;
  }
}
console.log(`\n根条目位于第 ${rootLine + 1}..${rootEnd} 行`);

const next = [...lines];

// --- 改动 1：根条目补 `cwd`（若缺）-------------------------------------------
const rootSeg = next.slice(rootLine, rootEnd);
// 只定位 config 的直接子字段，不能把角色或其他子树的 cwd 当作根 cwd。
const configRel = rootSeg.findIndex(l => /^  config:\s*$/.test(l));
if (configRel === -1) throw new Error('FAIL  找不到根条目的 config: 行');
const configIndent = /^(\s*)/.exec(rootSeg[configRel])[1].length + 2;
let configEnd = configRel + 1;
while (configEnd < rootSeg.length && (rootSeg[configEnd].trim() === '' || rootSeg[configEnd].length - rootSeg[configEnd].trimStart().length >= configIndent)) configEnd++;
const cwdRel = rootSeg.findIndex((l, i) => i > configRel && i < configEnd && new RegExp(`^ {${configIndent}}cwd:`).test(l));
const hasCwd = cwdRel !== -1;
let cwdChange = false;
if (hasCwd && (Object.hasOwn(options, 'cwd') || !root.config?.cwd)) {
  next[rootLine + cwdRel] = `${' '.repeat(configIndent)}cwd: ${JSON.stringify(CWD_VALUE)}`;
  cwdChange = true;
} else if (!hasCwd) {
  // 插在根条目的 `provider:` 行之后；缩进沿用该行（`config:` 下两级）。
  const provRel = rootSeg.findIndex((l, i) => i > configRel && i < configEnd && new RegExp(`^ {${configIndent}}provider:\\s*`).test(l));
  if (provRel === -1) {
    console.error('FAIL  根条目里找不到 provider: 行，无法安全插入 cwd');
    process.exit(1);
  }
  const provAbs = rootLine + provRel;
  const indent = /^(\s*)/.exec(lines[provAbs])[1];
  next.splice(provAbs + 1, 0, `${indent}cwd: ${JSON.stringify(CWD_VALUE)}`);
  cwdChange = true;
  console.log(`  计划：在第 ${provAbs + 2} 行插入 cwd（缩进 ${indent.length} 空格）`);
} else {
  console.log('  根条目已有 cwd，无需插入');
}

// --- 改动 2：角色字段（model / cliPromptDelivery / cliArgs）--------------------
//
// 都**只在根条目块内**按行定位：先前用 `indexOf` 猜位置时匹配到了文件里另一处同名字段，
// 把 YAML 写坏过（见文件头的说明）。
const fieldChanges = [];
{
  for (const r of roles) {
    const want = WANTED[r.id];
    if (want === undefined) continue;
    const idRel = next.slice(rootLine).findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*${r.id}\\s*$`).test(l));
    if (idRel === -1) {
      console.error(`FAIL  按行定位角色 ${r.id} 失败`);
      process.exit(1);
    }
    const idAbs = rootLine + idRel;
    // 该角色的范围：`- id:` 之后到下一个 `- id:` 之前。
    let segEnd = next.length;
    for (let i = idAbs + 1; i < next.length; i++) {
      if (/^\s*-\s*id:\s*/.test(next[i])) {
        segEnd = i;
        break;
      }
    }
    /** 在角色段内找某个顶层字段的行号。 */
    const findField = (name) => {
      for (let i = idAbs + 1; i < segEnd; i++) {
        if (new RegExp(`^\\s*${name}:\\s*`).test(next[i])) return i;
      }
      return -1;
    };
    const setScalar = (name, value) => {
      const at = findField(name);
      if (at === -1) {
        console.error(`FAIL  ${r.id} 里找不到 ${name}: 行`);
        process.exit(1);
      }
      const indent = /^(\s*)/.exec(next[at])[1];
      const from = next[at].trim();
      next[at] = `${indent}${name}: ${value}`;
      fieldChanges.push({ id: r.id, field: name, from, to: `${name}: ${value}`, line: at });
    };

    if (want.model !== undefined && r.model !== want.model) setScalar('model', want.model);
    if (want.promptDelivery !== undefined && r.cliPromptDelivery !== want.promptDelivery) {
      setScalar('cliPromptDelivery', want.promptDelivery);
    }
    // `cliArgs` 必须与驱动模板一致；否则界面反推不出驱动（会显示「自定义命令」）。
    if (want.model !== undefined) {
      const fields = cliFieldsFor(want.driver, r.readOnly === true);
      if (fields !== undefined && JSON.stringify(r.cliArgs) !== JSON.stringify(fields.cliArgs)) {
        const at = findField('cliArgs');
        if (at === -1) {
          console.error(`FAIL  ${r.id} 里找不到 cliArgs: 行`);
          process.exit(1);
        }
        // 该数组可能是多行块；找到它的结束位置（缩进回到同级或更浅）。
        const indent = /^(\s*)/.exec(next[at])[1];
        let end = at + 1;
        while (end < segEnd) {
          const l = next[end];
          if (l.trim().length === 0) {
            end++;
            continue;
          }
          if (l.length - l.trimStart().length <= indent.length) break;
          end++;
        }
        const replacement = [`${indent}cliArgs:`, ...fields.cliArgs.map((a) => `${indent}  - ${JSON.stringify(a)}`)];
        next.splice(at, end - at, ...replacement);
        // 插删之后，后面记录的行号会偏移，但本脚本只用一次，故不修正已记录的 line。
        fieldChanges.push({
          id: r.id,
          field: 'cliArgs',
          from: `${r.cliArgs?.length ?? 0} 项`,
          to: `${fields.cliArgs.length} 项`,
          line: at,
        });
        segEnd += replacement.length - (end - at);
      }
    }
  }
}

console.log('\n将要做出的改动：');
for (const c of fieldChanges) {
  console.log(`  ${c.id}.${c.field}: ${c.from} → ${c.to}`);
}
if (cwdChange) console.log(`  根条目补上 cwd: ${CWD_VALUE}`);
if (fieldChanges.length === 0 && !cwdChange) console.log('  （无改动）');

if (mode === 'check') {
  console.log('\n未写盘（加 --apply 才写）。');
  process.exit(0);
}

// --- 断言（写盘前）-----------------------------------------------------------
const out = next.join('\n');
const jsBefore = (original.match(/!!js /g) ?? []).length;
const jsAfter = (out.match(/!!js /g) ?? []).length;
check(`!!js 表达式数量不变（${jsBefore} → ${jsAfter}）`, jsBefore === jsAfter);
check('根条目仍带 mount:false', root.config?.mount === false, JSON.stringify(root.config?.mount));

// ⚠️ 最关键的一条：**产物必须能解析**。上一版就是没验这个才把 YAML 写坏。
let after;
try {
  after = parse(out);
  check('产物可解析', true);
} catch (error) {
  check('产物可解析', false, error.message);
  console.error('\n未写盘 —— 产物不可解析。');
  process.exit(1);
}
const afterRoot = after.find((o) => o && o.id === 'agent-switchboard');
check('顶层仍是数组', Array.isArray(after));
check('根条目仍存在', afterRoot !== undefined);
check(
  '根条目已有 cwd',
  typeof afterRoot?.config?.cwd === 'string' && afterRoot.config.cwd.length > 0,
  JSON.stringify(afterRoot?.config?.cwd),
);
for (const [id, want] of Object.entries(WANTED)) {
  const r = (afterRoot?.config?.roles ?? []).find((x) => x.id === id);
  check(`${id} 的 model == ${want.model}`, r?.model === want.model, String(r?.model));
  check(`${id} 仍是 cli 后端`, r?.backend === 'cli', String(r?.backend));
  check(`${id} 的 driver 未被改动`, r?.cliDriver === want.driver, String(r?.cliDriver));
  if (want.promptDelivery !== undefined) {
    check(
      `${id} 的 cliPromptDelivery == ${want.promptDelivery}`,
      r?.cliPromptDelivery === want.promptDelivery,
      String(r?.cliPromptDelivery),
    );
  }
  // 参数模板必须与驱动表**逐项一致**，否则界面反推不出驱动（会显示「自定义命令」）。
  const expectFields = cliFieldsFor(want.driver, r?.readOnly === true);
  if (expectFields !== undefined) {
    check(
      `${id} 的 cliArgs 与驱动表一致`,
      JSON.stringify(r?.cliArgs) === JSON.stringify(expectFields.cliArgs),
      JSON.stringify(r?.cliArgs),
    );
  }
}
const architect = (afterRoot?.config?.roles ?? []).find((x) => x.id === 'architect');
check('未列出的角色未被改动', architect?.model === 'gpt-6-astra', String(architect?.model));
check('角色数量不变', (afterRoot?.config?.roles ?? []).length === roles.length, String(afterRoot?.config?.roles?.length));

// 端到端判据：修正后的配置必须能通过规范化 —— 这才是「实验能不能跑」的真正条件。
const { normalizeRoles } = await import('../../src/roles.js');
const norm = normalizeRoles(afterRoot.config.roles, afterRoot.config.provider, afterRoot.config.cwd);
check('修正后规范化无错', norm.errors.length === 0, norm.errors.join('; '));
const cliCount = norm.roles.filter((r) => r.cli !== undefined).length;
check('两个 CLI 角色都能挂载', cliCount === 2, String(cliCount));

if (fail > 0) {
  console.error('\n有断言失败，未写盘。');
  process.exit(1);
}

// --- 写盘 --------------------------------------------------------------------
copyFileSync(PATCH, `${PATCH}.bak-fix-cli-models-${backupSuffix()}`);
writeFileSync(PATCH, out, 'utf8');
console.log(`\n已写入 ${PATCH}`);

// 同步到插件文件（preset 会话从那里回落 cwd / 默认值）。
if (existsSync(ROLES_FILE)) {
  const fileCfg = fileRead.config;
  const fileRoles = Array.isArray(fileCfg.roles) ? fileCfg.roles : [];
  fileCfg.roles = fileRoles.map((r) => {
    const want = WANTED[r.id];
    if (want === undefined) return r;
    const fields = cliFieldsFor(want.driver, r.readOnly === true);
    return {
      ...r,
      ...(want.model === undefined ? {} : { model: want.model }),
      ...(want.promptDelivery === undefined ? {} : { cliPromptDelivery: want.promptDelivery }),
      ...(fields === undefined ? {} : { cliPrefixArgs: fields.cliPrefixArgs, cliArgs: fields.cliArgs }),
    };
  });
  if (Object.hasOwn(options, 'cwd') || typeof fileCfg.cwd !== 'string' || fileCfg.cwd.length === 0) fileCfg.cwd = CWD_VALUE;
  copyFileSync(ROLES_FILE, `${ROLES_FILE}.bak-fix-cli-models-${backupSuffix()}`);
  const written = writeConfigFile(ROLES_FILE, fileCfg);
  if (!written.ok) {
    console.error(`FAIL  同步 roles 配置失败：${written.error}`);
    process.exit(1);
  }
  console.log(`已同步到 ${ROLES_FILE}（cwd=${fileCfg.cwd}）`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
