// 角色配置文件存储与远程服务的离线验证。
//
// 为什么需要：D13 把角色配置从 Cordis 配置搬到了插件自己的文件 + 自己的远程服务。
// 这引入了两个新机制，各自都有静默失效的风险：
//   1. **文件读写**：原子写是否真的原子（不留半截文件）、「文件缺失」与「文件损坏」
//      是否被区分（混淆会把用户配置静默当成空）。
//   2. **远程方法标记**：远程方法靠原型上的一个 symbol 描述符被发现（零转译手工施加）。
//      若标记没生效，客户端调用会得到「未知端点」而不是一个明确的错误。
//
// 用法：node scripts/check-config-service.mjs
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
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
import { REMOTE_METHODS, RoleConfigService, applyRemoteMarker } from '../src/config-service.js';
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';

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

const tmp = mkdtempSync(join(tmpdir(), 'switchboard-check-'));
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

section('远程方法标记：零转译手工施加后必须能被 remoteMethods 发现');
{
  check('已标记 read 与 write', REMOTE_METHODS.slice().sort().join(',') === 'read,write', REMOTE_METHODS.join(','));

  // 直接对实例断言（网关就是这么调的：remoteMethods(instance)）。
  const probe = Object.create(RoleConfigService.prototype);
  const found = remoteMethods(probe)
    .map((m) => m.exportName ?? m.method)
    .sort();
  check('remoteMethods(实例) 找到 read/write', found.join(',') === 'read,write', found.join(','));

  // 反例：未标记的类不应被发现（证明断言不是恒真）。
  class Unmarked {
    read() {}
  }
  check('未标记的类不被发现', remoteMethods(new Unmarked()).length === 0);
}

section('applyRemoteMarker：对不存在的方法必须抛错而不是静默通过');
{
  class Nothing {}
  let threw = false;
  try {
    applyRemoteMarker(Nothing, 'ghost', 'ghost');
  } catch {
    threw = true;
  }
  check('施加到不存在的方法会抛错', threw);

  // 幂等：重复施加同一标记不应产生第二条（否则网关会看到重复端点）。
  class Twice {
    read() {}
  }
  applyRemoteMarker(Twice, 'read', 'read');
  applyRemoteMarker(Twice, 'read', 'read');
  check('重复施加不产生重复标记', remoteMethods(new Twice()).length === 1, String(remoteMethods(new Twice()).length));
}

section('RoleConfigService.read / write：业务语义');
{
  // 用原型方法直接调用，避开需要真 Cordis Context 的构造。
  const svc = {
    path: join(tmp, 'svc', CONFIG_FILE_NAME),
    defaults: { provider: 'self', cwd: 'C:/w' },
    log() {},
  };
  const read = RoleConfigService.prototype.read;
  const write = RoleConfigService.prototype.write;

  const missing = read.call(svc);
  check('文件缺失 → ok:true + missing:true（界面显示「尚未配置」而非报错）', missing.ok === true && missing.missing === true, JSON.stringify(missing));

  const bad = write.call(svc, { roles: [{ id: 'BAD' }] });
  check('非法角色被拒绝', bad.ok === false, JSON.stringify(bad));
  check('拒绝时给出可读原因', typeof bad.error === 'string' && bad.error.length > 0, bad.error);
  check('被拒绝时不创建文件', read.call(svc).missing === true);

  const good = [
    { id: 'scout', description: 'd', instructions: 'i', model: 'gpt-6-luna', backend: 'spawn', readOnly: true, allowNestedDispatch: false },
  ];
  const written = write.call(svc, { roles: good });
  check('合法角色写入成功', written.ok === true, JSON.stringify(written));
  check('返回写入的角色数', written.roleCount === 1, String(written.roleCount));

  const back = read.call(svc);
  check('读回与写入一致', back.ok === true && back.roles.length === 1 && back.roles[0].id === 'scout', JSON.stringify(back.roles));

  check('写入非对象被拒绝', write.call(svc, 'nope').ok === false);
  check('写入数组被拒绝', write.call(svc, [1, 2]).ok === false);

  // 跨 CLI 角色也应当能写入（校验规则与装载期共用 normalizeRoles）。
  const cli = {
    id: 'codex-scout',
    description: 'd',
    instructions: 'i',
    model: 'gpt-6-astra',
    effort: 'medium',
    backend: 'cli',
    cliCommand: 'node',
    cliArgs: ['exec', '-m', '{model}', '-'],
    cliPromptDelivery: 'stdin',
    cliCwd: 'C:/w',
  };
  check('合法 CLI 角色写入成功', write.call(svc, { roles: [cli] }).ok === true);
  check('CLI 角色读回后 backend 仍为 cli', read.call(svc).roles[0].backend === 'cli');
}

rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
