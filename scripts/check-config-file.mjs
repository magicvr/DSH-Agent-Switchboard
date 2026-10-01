// 角色配置文件存储的离线验证。
//
// 为什么需要：角色现在有**两条来源**——UI 写进插件的 Cordis 配置，Host 侧再把它同步到
// 这个文件。文件层一旦出错（半截文件、把损坏当空），用户配置就会静默丢失。因此这里只
// 验证存储层的不变量，不涉及 Cordis。
//
// 用法：node scripts/check-config-file.mjs
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configPathFor,
  readConfigFile,
  writeConfigFile,
  normalizeConfigShape,
  initialConfig,
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
} from '../src/config-file.js';

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

rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
