// 一致性验证：**客户端校验不得比 Host 严**。
//
// 为什么单独做这个：实测踩到「角色从 CLI 切回内置后保存被拦下」——客户端要求内置角色
// 必须有 `provider`，而 Host 的规则是 `read('provider') ?? defaultProvider`（留空就用
// 插件级默认值）。**客户端把 Host 完全接受的配置拒绝了**，用户看到的是莫名其妙的
// 保存失败与一句自相矛盾的提示。
//
// 这类 bug 的共性是「两处校验各自演化」。因此这里不再逐条复刻 Host 的规则，而是**同一批
// 输入分别喂给两边，断言判定一致** —— 任何一侧单方面变严都会立刻失败。
//
// 用法：node scripts/check-validation-parity.mjs
import { normalizeRoles } from '../src/roles.js';
import { validateRoles } from '../src/client/logic.js';

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

/** 插件级默认值（与 `Config` 的默认一致：provider 默认 `self`）。 */
const DEFAULT_PROVIDER = 'self';
const DEFAULT_CWD = 'C:/w';

/** 一个合法内置角色的基线。 */
const builtin = {
  id: 'scout',
  description: 'd',
  instructions: 'i',
  model: 'gpt-6-luna',
  backend: 'spawn',
  provider: 'self',
  cwd: DEFAULT_CWD,
};

/** 一个合法 CLI 角色的基线。 */
const cli = {
  id: 'cli-scout',
  description: 'd',
  instructions: 'i',
  model: 'gpt-6-luna',
  backend: 'cli',
  cliDriver: 'codex',
  cliCommand: '{node}',
  cliPrefixArgs: ['{npmRoot}\\@openai\\codex\\bin\\codex.js'],
  cliArgs: ['exec', '-s', 'read-only', '-m', '{model}', '-'],
  cliPromptDelivery: 'stdin',
  cliCwd: DEFAULT_CWD,
};

/**
 * 两边对同一批角色是否判定一致。
 *
 * @param {string} label - 用例名。
 * @param {object[]} roles - 角色数组。
 */
function parity(label, roles) {
  const host = normalizeRoles(roles, DEFAULT_PROVIDER, DEFAULT_CWD);
  const client = validateRoles(roles);
  const hostOk = host.errors.length === 0;
  const clientOk = client === null;
  check(
    `${label}：Host 与客户端判定一致（Host ${hostOk ? '通过' : '拒绝'}）`,
    hostOk === clientOk,
    `Host=${hostOk ? '通过' : `拒绝(${host.errors[0]})`} / 客户端=${clientOk ? '通过' : `拒绝(${client})`}`,
  );
  return { hostOk, clientOk };
}

section('正则用例：两边判定必须一致');
parity('合法内置角色', [{ ...builtin }]);
parity('内置角色留空 provider（跟随默认值）', [{ ...builtin, provider: undefined }]);
parity('内置角色 provider 为空串', [{ ...builtin, provider: '' }]);
parity('内置角色 provider 为空白', [{ ...builtin, provider: '   ' }]);
parity('合法 CLI 角色', [{ ...cli }]);
parity('CLI 角色缺命令', [{ ...cli, cliCommand: undefined }]);
parity('CLI 角色缺参数模板', [{ ...cli, cliArgs: [] }]);
parity('CLI 角色缺提示词传递方式', [{ ...cli, cliPromptDelivery: undefined }]);
parity('缺描述', [{ ...builtin, description: '' }]);
parity('缺指令', [{ ...builtin, instructions: '' }]);
parity('缺模型', [{ ...builtin, model: '' }]);
parity('id 大写', [{ ...builtin, id: 'Scout' }]);
parity('id 重复', [{ ...builtin }, { ...builtin }]);
parity('非法 backend', [{ ...builtin, backend: 'nope' }]);
parity('两个角色（一内置一 CLI）', [{ ...builtin }, { ...cli }]);
parity('空数组', []);

section('重点回归：内置角色留空 provider 必须两边都接受');
{
  const { hostOk, clientOk } = parity('回归', [{ ...builtin, provider: undefined }]);
  check('Host 接受', hostOk);
  check('客户端也接受（曾在此处单方面变严）', clientOk);
}

section('反例：确保 parity 断言不是恒真');
{
  // 构造一个两边都应该拒绝的输入。若 parity 恒真，这条会暴露出来。
  const r = parity('两边都拒绝的输入（反例）', [{ ...builtin, description: '' }]);
  check('反例确实被两边都拒绝', r.hostOk === false && r.clientOk === false);
}

section('面板新增输入：默认 provider 回落与指令必填');
{
  check('Host 将空白 provider 回落插件默认值',
    normalizeRoles([{ ...builtin, provider: '   ' }], DEFAULT_PROVIDER, DEFAULT_CWD).roles[0]?.provider === DEFAULT_PROVIDER);
  for (const role of [builtin, cli]) {
    const { hostOk, clientOk } = parity(`${role.backend} 空指令`, [{ ...role, instructions: '' }]);
    check(`${role.backend} 指令必填：Host 与客户端均拒绝`, !hostOk && !clientOk);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
