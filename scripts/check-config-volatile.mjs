// volatile 配置读取的回归验证。
//
// 为什么需要这个文件：`src/index.js` 曾用 `resolved.volatile?.allowCrossCli === true`
// 直接读取值，而 `.volatile()` 会把该子对象变成**引用对象**（属性不在自身上），
// 于是这个判定**恒为 false** —— 跨 CLI 派发开关从未真正生效过。
//
// 关键点：这个 bug 逃过了已有的 103 + 55 + 55 条断言，因为那些断言直接调用纯函数
// `planCliMounts(roles, boolean)`，**绕过了 apply 层的取值**。因此本文件刻意
// **穿过真实的 Config schema** 取值，让同类错误无处可藏。
//
// 用法：node scripts/check-config-volatile.mjs
import { Config, readVolatile } from '../src/index.js';

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

section('自检：确认这个坑真实存在（否则本文件在测空气）');
{
  // 这是**已知坏形态**：直接访问属性。如果它哪天变成可用的，说明 schemastery 行为
  // 变了，本文件的前提要重新核实 —— 因此把它也断言下来。
  const resolved = Config({ volatile: { allowCrossCli: true } });
  check(
    '直接读 `resolved.volatile.allowCrossCli` 确实取不到值（这就是原 bug 的机制）',
    resolved.volatile?.allowCrossCli === undefined,
    `实际得到 ${JSON.stringify(resolved.volatile?.allowCrossCli)}`,
  );
  check(
    '`resolved.volatile.get()` 能取到真值',
    resolved.volatile?.get?.()?.allowCrossCli === true,
    `实际得到 ${JSON.stringify(resolved.volatile?.get?.()?.allowCrossCli)}`,
  );
}

section('readVolatile：穿过真实 Config schema');
{
  const cases = [
    ['allowCrossCli = true', { volatile: { allowCrossCli: true } }, true],
    ['allowCrossCli = false', { volatile: { allowCrossCli: false } }, false],
    ['未提供 volatile（应回落到默认 false）', { provider: 'self' }, false],
    ['volatile 为空对象（应回落到默认 false）', { provider: 'self', volatile: {} }, false],
  ];
  for (const [label, input, expected] of cases) {
    const v = readVolatile(Config(input));
    check(
      `${label} → allowCrossCli === ${expected}`,
      v.allowCrossCli === expected,
      `实际 ${JSON.stringify(v.allowCrossCli)}`,
    );
  }
}

section('readVolatile：cliTimeoutSec 默认值与覆盖');
{
  const dflt = readVolatile(Config({ provider: 'self' }));
  check(
    '未提供时 cliTimeoutSec 为 900',
    dflt.cliTimeoutSec === 900,
    `实际 ${JSON.stringify(dflt.cliTimeoutSec)}`,
  );
  const over = readVolatile(Config({ volatile: { cliTimeoutSec: 30 } }));
  check('可被覆盖为 30', over.cliTimeoutSec === 30, `实际 ${JSON.stringify(over.cliTimeoutSec)}`);
}

section('readVolatile：输入退化情形不抛错');
{
  // 这些形态在真实运行里可能出现（例如 Loader 传 undefined，或配置取值异常）。
  const inputs = [
    ['undefined', undefined],
    ['null', null],
    ['空对象', {}],
    ['volatile 为 null', { volatile: null }],
    ['volatile 为 undefined', { volatile: undefined }],
    ['volatile 为非对象', { volatile: 42 }],
  ];
  for (const [label, input] of inputs) {
    let ok = true;
    let got;
    try {
      got = readVolatile(input);
      ok = got !== null && typeof got === 'object' && !Array.isArray(got);
    } catch (error) {
      ok = false;
      got = `抛错：${error.message}`;
    }
    check(`${label} → 返回普通对象且不抛错`, ok, `实际 ${JSON.stringify(got)}`);
  }
}

// ---------------------------------------------------------------------------
// 可写性不变式：这是「角色设置页能不能写回配置」的**硬前提**。
//
// 背景（见 docs/architecture.md 3.1e）：服务端 SettingsForms.write 对路径操作做
// isVolatilePath 校验，非 volatile 路径一律抛 `Config field "..." is not volatile`。
// 因此 `roles` **必须**标 .volatile()，否则自建的角色设置页一个字都写不进去。
//
// 而 volatile 又只能标在**数组整体**：标在元素内部会被客户端
// validateVolatileSchema 以「路径含 * 不固定」为由拒绝。
//
// 这三条断言把这个组合锁住 —— 一旦有人「顺手」改动 schema 结构，这里会立刻失败，
// 而不是等到实机写配置时才发现。
// ---------------------------------------------------------------------------
section('可写性不变式：roles 必须整体 volatile，且数组下标路径可写');
{
  /**
   * 复刻 dsh-settings 的 `isVolatilePath`。
   *
   * @param {object} schema - schemastery schema 节点。
   * @param {string[]} path - 字段路径段。
   * @returns {boolean} 该路径是否可实时编辑。
   */
  function isVolatilePath(schema, path) {
    if (schema.meta.volatile) return true;
    const [key, ...rest] = path;
    const child = key === undefined ? undefined : schema.dict?.[key];
    return child !== undefined && isVolatilePath(child, rest);
  }

  const schema = Config;
  check('roles 自身可写（决定了整个设置页能否工作）', isVolatilePath(schema, ['roles']));

  const arrayPaths = [
    ['roles', '0', 'backend'],
    ['roles', '0', 'model'],
    ['roles', '3', 'cliArgs', '0'],
    ['roles', '1', 'cliPromptDelivery'],
  ];
  for (const p of arrayPaths) {
    check(`数组下标路径可写：${p.join('.')}`, isVolatilePath(schema, p));
  }
  // 删元素也走同一条路径判定，因此它同样是「可写」的前提。
  check('删元素路径可写：roles.4（unset 会 splice 掉该元素）', isVolatilePath(schema, ['roles', '4']));

  // 反向断言：非 volatile 的顶层字段**不应**变成可写 —— 否则等于把 provider/maxDepth
  // 也交给了设置页，超出 D13 的范围。
  check('provider 不在 volatile 子树下（不应被设置页改写）', !isVolatilePath(schema, ['provider']));
  check('maxDepth 不在 volatile 子树下', !isVolatilePath(schema, ['maxDepth']));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
