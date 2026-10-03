// 角色配置文件存储的离线验证。
//
// 为什么需要：角色现在有**两条来源**——UI 写进插件的 Cordis 配置，Host 侧再把它同步到
// 这个文件。文件层一旦出错（半截文件、把损坏当空），用户配置就会静默丢失。因此这里只
// 验证存储层的不变量，不涉及 Cordis。
//
// 用法：node scripts/check-config-file.mjs
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configPathFor,
  readConfigFile,
  readConfigFileDetailed,
  createConfigFileResolver,
  writeConfigFile,
  migrateConfigFileOnDisk,
  normalizeConfigShape,
  initialConfig,
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
} from '../src/config-file.js';

import { inspectConfigFormat, migrateConfig, CONFIG_MIGRATIONS } from '../src/config-migrations.js';

let pass = 0;
let fail = 0;
/**
 * 断言。
 *
 * @param {string} label - 说明。
 * @param {boolean} condition - 条件。
 * @param {string} [detail] - 失败详情。
 */
function check(label, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
/** @param {string} title - 小节标题。 */
function section(title) {
  console.log(`\n=== ${title} ===`);
}

const tmp = mkdtempSync(join(tmpdir(), 'switchboard-cfg-'));
const cfgPath = join(tmp, 'nested', CONFIG_FILE_NAME);

section('配置格式：有序迁移、版本门禁与纯函数');
{
  const legacy = { roles: [], custom: { keep: true } };
  const before = JSON.stringify(legacy);
  const upgraded = migrateConfig(legacy);
  check('缺失版本 → migrated，声明唯一 0 → 1 步骤', inspectConfigFormat(legacy).status === 'migrated'
    && inspectConfigFormat(legacy).needsWrite && inspectConfigFormat(legacy).applied.length === 1
    && CONFIG_MIGRATIONS[0].from === 0 && CONFIG_MIGRATIONS[0].to === 1);
  check('迁移返回新对象且不修改输入及其它字段', upgraded !== legacy && upgraded.formatVersion === 1
    && upgraded.custom === legacy.custom && JSON.stringify(legacy) === before);
  check('版本 1 → current，无需写盘', inspectConfigFormat(upgraded).status === 'current'
    && !inspectConfigFormat(upgraded).needsWrite && migrateConfig(upgraded) !== upgraded);
  check('版本 999 → future，报告支持版本', inspectConfigFormat({ formatVersion: 999 }).status === 'future'
    && inspectConfigFormat({ formatVersion: 999 }).reason.includes('支持版本 1'));
  for (const value of [null, [], '1', 42, { formatVersion: '1' }, { formatVersion: -1 },
    { formatVersion: 0.5 }, { formatVersion: null }, { formatVersion: undefined }, { formatVersion: NaN }]) {
    let rejected = false;
    try { migrateConfig(value); } catch { rejected = true; }
    check(`非法输入 ${JSON.stringify(value)} → unsupported 且迁移拒绝`,
      inspectConfigFormat(value).status === 'unsupported' && rejected);
  }
  let futureRejected = false;
  try { migrateConfig({ formatVersion: 999 }); } catch { futureRejected = true; }
  check('未来版本不能迁移', futureRejected);
  const path = join(tmp, 'formats.json');
  writeFileSync(path, JSON.stringify(legacy));
  check('兼容读取返回内存迁移值，详细读取保留磁盘判据', readConfigFile(path).value.formatVersion === 1
    && readConfigFileDetailed(path).format.status === 'migrated');
  writeFileSync(path, JSON.stringify({ formatVersion: 1, roles: 'invalid' }));
  check('current 不绕过 roles 形状校验', readConfigFileDetailed(path).format.status === 'current'
    && !readConfigFile(path).ok);
  writeFileSync(path, JSON.stringify(upgraded));
  const resolver = createConfigFileResolver(path);
  check('正常版本缓存可读', resolver.read().ok && resolver.read().cached);
  writeFileSync(path, JSON.stringify({ ...upgraded, formatVersion: 999 }));
  check('未来版本不能回落旧缓存且重复读取仍拒绝', !resolver.read().ok && !resolver.read().ok
    && resolver.read().format.status === 'future');
  writeFileSync(path, '{malformed');
  const corruptBlocked = resolver.read();
  check('G2：current → future → 坏 JSON 仍拒绝且不复活旧缓存', !corruptBlocked.ok
    && !corruptBlocked.value && !corruptBlocked.cached && !resolver.read().ok, JSON.stringify(corruptBlocked));
  rmSync(path);
  check('G2：封锁后文件消失也不能解除封锁', !resolver.read().ok);
  writeFileSync(path, JSON.stringify({ ...upgraded, custom: { recovered: true } }));
  check('改回 current 后缓存恢复', resolver.read().ok && resolver.read().format.status === 'current');
}

section('通用写入门禁：旧格式自动备份迁移，其它不支持格式拒绝');
{
  const path = join(tmp, 'write-gate.json');
  for (const [status, value] of [
    ['current', initialConfig([])], ['migrated', { roles: [] }],
    ['future', { formatVersion: 999, roles: [] }], ['unsupported', { formatVersion: '1', roles: [] }],
  ]) {
    writeFileSync(path, JSON.stringify(value));
    const before = readFileSync(path);
    const count = readdirSync(tmp).length;
    const result = writeConfigFile(path, initialConfig([{ id: 'replacement' }]));
    check(`${status} 返回写入结果`, ['current', 'migrated'].includes(status) ? result.ok
      : !result.ok && /拒绝写入/.test(result.error) && before.equals(readFileSync(path)) && readdirSync(tmp).length === count, JSON.stringify(result));
  }
  writeFileSync(path, '{bad');
  check('显式写入仍可修复不可解析 JSON', writeConfigFile(path, initialConfig([])).ok && readConfigFile(path).ok);
  writeFileSync(path, '{"roles":[{"id":"old"}],"custom":true}');
  const oldBytes = readFileSync(path);
  const edit = initialConfig([{ id: 'edited' }], { custom: true });
  const saved = writeConfigFile(path, edit);
  check('G1：自动迁移返回步骤与原始字节备份且编辑落盘', saved.ok && saved.migrated?.from === 0
    && saved.migrated.to === 1 && saved.migrated.applied.length === 1
    && oldBytes.equals(readFileSync(saved.migrated.backup))
    && readFileSync(path, 'utf8') === JSON.stringify(edit, null, 2) + '\n', JSON.stringify(saved));
  writeFileSync(path, oldBytes);
  const originalRead = fs.readFileSync;
  let verification;
  try {
    fs.readFileSync = (...args) => {
      const text = originalRead(...args);
      if (args[0] === path && args[1] === 'utf8' && JSON.parse(text).formatVersion === 1) return '{bad';
      return text;
    };
    syncBuiltinESMExports();
    verification = writeConfigFile(path, edit);
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  check('G1：自动迁移复读失败必须响亮报告且保留备份', !verification.ok
    && /自动迁移后复读验证失败/.test(verification.error) && existsSync(verification.backup), JSON.stringify(verification));
}

section('migrateConfigFileOnDisk：显式备份迁移与复读验证');
{
  const path = join(tmp, 'migration.json');
  const backups = () => readdirSync(tmp).filter(name => name.startsWith('migration.json.bak-migrate-format-'));
  const missing = migrateConfigFileOnDisk(path, { apply: true });
  check('缺文件是干净 no-op', missing.ok && missing.status === 'missing' && !missing.changed && !existsSync(path));
  const currentText = JSON.stringify(initialConfig([{ id: 'current' }]));
  writeFileSync(path, currentText);
  const current = migrateConfigFileOnDisk(path, { apply: true });
  check('current 不写入、不备份', current.ok && current.status === 'current' && !current.changed
    && readFileSync(path, 'utf8') === currentText && backups().length === 0);
  const legacy = { roles: [{ id: 'keep', nested: { values: [1, '二'] } }], custom: true };
  const legacyText = JSON.stringify(legacy);
  writeFileSync(path, legacyText);
  const dry = migrateConfigFileOnDisk(path);
  check('migrated dry-run 报告步骤且不写盘', dry.ok && dry.status === 'migrated' && !dry.changed
    && dry.applied.length === 1 && readFileSync(path, 'utf8') === legacyText && backups().length === 0);
  const applied = migrateConfigFileOnDisk(path, { apply: true });
  check('migrated apply 创建原始字节备份并通过内部验证', applied.ok && applied.changed
    && applied.status === 'migrated' && applied.applied.length === 1 && backups().length === 1
    && readFileSync(applied.backup, 'utf8') === legacyText, JSON.stringify(applied));
  check('迁移写入当前版本且 roles 与其它字段原样保留', readFileSync(path, 'utf8')
    === JSON.stringify({ ...legacy, formatVersion: 1 }, null, 2) + '\n');
  for (const [status, text] of [
    ['future', '{"formatVersion":999,"roles":[]}'],
    ['unsupported', '{"formatVersion":"1","roles":[]}'], ['unreadable', '{bad'],
  ]) {
    writeFileSync(path, text);
    const before = readFileSync(path);
    const count = backups().length;
    const result = migrateConfigFileOnDisk(path, { apply: true });
    check(`${status} 拒绝且字节不变、不创建备份`, !result.ok && result.status === status
      && before.equals(readFileSync(path)) && backups().length === count, JSON.stringify(result));
  }
  const verificationPath = join(tmp, 'verification-failure.json');
  writeFileSync(verificationPath, legacyText);
  const originalRead = fs.readFileSync;
  let reads = 0;
  let verification;
  try {
    fs.readFileSync = (...args) => {
      if (args[0] === verificationPath && args[1] === 'utf8' && ++reads === 1) {
        return JSON.stringify(initialConfig([{ id: 'wrong-role' }]));
      }
      return originalRead(...args);
    };
    syncBuiltinESMExports();
    verification = migrateConfigFileOnDisk(verificationPath, { apply: true });
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
  check('复读 roles 不匹配必须响亮失败并保留备份', !verification.ok && verification.changed
    && /迁移后复读验证失败/.test(verification.error) && existsSync(verification.backup), JSON.stringify(verification));
}

section('路径解析：落在 $DSH_HOME 下的插件私有目录');
{
  const p = configPathFor('/home/u/.dsh');
  check('路径以 .dsh 为根', p.includes('.dsh'), p);
  check('包含插件私有目录名', p.includes(CONFIG_DIR_NAME), p);
  check('以 roles.json 结尾', p.endsWith(CONFIG_FILE_NAME), p);
}

section('文件不存在 → missing（不是错误，也不是空配置）');
{
  const read = readConfigFile(cfgPath);
  check('ok 为 true（缺失不是失败）', read.ok === true, JSON.stringify(read));
  check('missing 标记为 true', read.missing === true, JSON.stringify(read));
}

section('原子写入：新建、覆盖、读回');
{
  const w1 = writeConfigFile(cfgPath, initialConfig([{ id: 'scout' }]));
  check('首次写入成功（含自动建目录）', w1.ok === true, JSON.stringify(w1));
  const r1 = readConfigFile(cfgPath);
  check('读回 roles 正确', r1.ok && r1.value.roles[0].id === 'scout', JSON.stringify(r1));

  const w2 = writeConfigFile(cfgPath, initialConfig([{ id: 'worker' }, { id: 'reviewer' }]));
  check('覆盖写成功', w2.ok === true, JSON.stringify(w2));
  const r2 = readConfigFile(cfgPath);
  check(
    '覆盖后内容正确',
    r2.ok && r2.value.roles.map((r) => r.id).join(',') === 'worker,reviewer',
    JSON.stringify(r2.value?.roles),
  );

  // 原子性的一项可观测证据：写完不留临时文件。
  const leftovers = readdirSync(join(tmp, 'nested')).filter((f) => f.includes('.tmp'));
  check('写入后不残留 .tmp 文件', leftovers.length === 0, leftovers.join(','));
}

section('文件损坏 → 明确报错（绝不静默当作空配置）');
{
  const brokenPath = join(tmp, 'broken.json');
  writeFileSync(brokenPath, '{ not json', 'utf8');
  const read = readConfigFile(brokenPath);
  check('ok 为 false', read.ok === false, JSON.stringify(read));
  check('给出 JSON 解析错误', /JSON/.test(read.error ?? ''), read.error);

  const arrPath = join(tmp, 'array.json');
  writeFileSync(arrPath, '[1,2,3]', 'utf8');
  check('顶层是数组 → 报错', readConfigFile(arrPath).ok === false);

  const noRolesPath = join(tmp, 'noroles.json');
  writeFileSync(noRolesPath, '{"formatVersion":1}', 'utf8');
  const noRoles = readConfigFile(noRolesPath);
  check('缺少 roles 数组 → 报错', noRoles.ok === false, JSON.stringify(noRoles));
  check('错误信息点名 roles', /roles/.test(noRoles.error ?? ''), noRoles.error);

  // 关键：损坏的文件**不得**被覆盖（用户配置必须保留，让人有机会手工修）。
  const before = readFileSync(brokenPath, 'utf8');
  check('损坏文件在读取后保持原样', readFileSync(brokenPath, 'utf8') === before);
}

section('normalizeConfigShape：只做结构归一，不重复字段级校验');
{
  const s = normalizeConfigShape({ roles: [{ id: 'a' }], provider: 'self', cwd: 'C:/w', maxDepth: 2 });
  check('保留 roles', Array.isArray(s.roles) && s.roles.length === 1);
  check('保留 provider/cwd/maxDepth', s.provider === 'self' && s.cwd === 'C:/w' && s.maxDepth === 2);
  const bad = normalizeConfigShape({ roles: 'nope' });
  check('roles 非数组 → 归一为空数组（交由 normalizeRoles 报错）', Array.isArray(bad.roles) && bad.roles.length === 0);
  const empty = normalizeConfigShape(undefined);
  check('输入 undefined 不抛错', Array.isArray(empty.roles));
}

section('initialConfig：带默认值的初始形态');
{
  const init = initialConfig([{ id: 'a' }], { provider: 'self', cwd: 'C:/w' });
  check('含 formatVersion', typeof init.formatVersion === 'number', String(init.formatVersion));
  check('含传入的 roles', init.roles.length === 1 && init.roles[0].id === 'a');
  check('含传入的默认值', init.provider === 'self' && init.cwd === 'C:/w');
  // 写出去的必须能读回来（往返一致性）。
  const p2 = join(tmp, 'roundtrip', CONFIG_FILE_NAME);
  check('往返可读', writeConfigFile(p2, init).ok === true && readConfigFile(p2).ok === true);
}

section('迁移竞态与备份唯一性');
{
  const path = join(tmp, 'race.json');
  const original = '{"roles":[{"id":"original"}]}';
  const external = '{"roles":[{"id":"external-edit"}]}';
  writeFileSync(path, original);
  const originalWrite = fs.writeFileSync;
  let result;
  try {
    fs.writeFileSync = (target, ...args) => {
      const value = originalWrite(target, ...args);
      if (String(target).startsWith(path + '.bak-migrate-format-')) originalWrite(path, external);
      return value;
    };
    syncBuiltinESMExports();
    result = migrateConfigFileOnDisk(path, { apply: true });
  } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  check('G3：备份后外部改写必须 changed 拒绝，外部字节保留', !result.ok && result.status === 'changed'
    && !result.changed && /已改变.*拒绝写入/.test(result.error)
    && readFileSync(path, 'utf8') === external && readFileSync(result.backup, 'utf8') === original, JSON.stringify(result));
  const OriginalDate = globalThis.Date;
  const names = [];
  try {
    globalThis.Date = class extends OriginalDate { toISOString() { return '2026-01-01T00:00:00.000Z'; } };
    for (let n = 0; n < 2; n++) {
      writeFileSync(path, original);
      names.push(migrateConfigFileOnDisk(path, { apply: true }));
    }
  } finally { globalThis.Date = OriginalDate; }
  check('G4：同毫秒两次迁移均成功且备份随机后缀不同', names.every(r => r.ok)
    && names[0].backup !== names[1].backup
    && names.every(r => /bak-migrate-format-2026-01-01T00-00-00-000Z-[a-f0-9]{12}$/.test(r.backup)), JSON.stringify(names));
}


rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
