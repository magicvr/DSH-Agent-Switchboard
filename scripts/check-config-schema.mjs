// 离线预检：在 Node 里真实构造插件 Config，并把 schemastery schema 序列化成
// JSON Schema 打印出来。目的是把「schemastery API 用错」这类问题在**重启前**暴露
// ——它已经真实发生过一次（`z.enum is not a function`，见 architecture.md 3.1c）。
//
// Host 与 package.json 由本脚本 URL 定位，可从任意 cwd 运行；依赖仍须真实可解析。
// 用法：node scripts/check-config-schema.mjs [--json]
const hostUrl = new URL('../src/index.js', import.meta.url);

const wantJson = process.argv.includes('--json');

let mod;
try {
  mod = await import(hostUrl);
} catch (error) {
  console.error('FAIL  无法 import Host 半边');
  console.error(`      ${error.constructor.name}: ${error.message}`);
  process.exitCode = 1;
  // 直接结束，避免后续步骤在缺 mod 的情况下抛错而掩盖真实原因。
  throw new Error('__preflight_abort__');
}

console.log('PASS  Host 半边可 import');
console.log(`      导入成功，共 ${Object.keys(mod).length} 个导出`);

const required = ['name', 'inject', 'Config', 'apply'];
const missing = required.filter((k) => !(k in mod));
if (missing.length > 0) {
  console.error(`FAIL  缺少必需导出：${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`PASS  必需导出齐全：${required.join(', ')}`);
}

console.log(`      name   = ${JSON.stringify(mod.name)}`);
console.log(`      inject = ${JSON.stringify(mod.inject)}`);

// ---------------------------------------------------------------------------
// 深层依赖可解析性检查。
//
// 这是被真实故障教会的：`import('@deepseek-ai/dsh-tool-subagent')` 在运行中的
// 应用里失败，因为 app 的解析器只对「出现在某个祖先 package.json 的
// peerDependencies 键集合里」的包启用拦截路由（见 dsh-app-boot 的
// readPeerNames / routeUrl 判据）。所以每个运行时需要的包都必须显式声明为 peer。
// 一旦漏声明，插件照样能装载、自检也有响应，但角色工具会**全部**挂载失败 —— 很难察觉。
// ---------------------------------------------------------------------------
const { readFileSync } = await import('node:fs');
const selfManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const declaredPeers = new Set(Object.keys(selfManifest.peerDependencies ?? {}));
const RUNTIME_IMPORTS = [
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-tool-subagent',
];

for (const spec of RUNTIME_IMPORTS) {
  const declared = declaredPeers.has(spec);
  try {
    const imported = await import(spec);
    const count = Object.keys(imported).length;
    if (declared) console.log(`PASS  ${spec} 已声明 peer 且可 import（导出 ${count} 项）`);
    else {
      console.error(`FAIL  ${spec} 可 import 但**未声明 peerDependencies** —— 应用内拦截路由会拒绝它`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `FAIL  ${spec} 无法 import${declared ? '（已声明 peer）' : '（且未声明 peer）'}：${error.code ?? error.message}`,
    );
    process.exitCode = 1;
  }
}

/**
 * 与 `dsh-app-boot` 的 `isNativeConfigSchema` 同构的判定。
 * 单独抽出来是为了能先用**已知正确**的 schema 自检这个判定本身。
 *
 * @param {unknown} value - 待判定的 Config 导出。
 * @returns {boolean} 是否为 native schemastery schema。
 */
function isNativeConfigSchema(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const meta = Reflect.get(value, 'meta');
  return (
    Reflect.get(value, Symbol.for('schemastery')) === true &&
    typeof Reflect.get(value, 'type') === 'string' &&
    meta !== null &&
    typeof meta === 'object'
  );
}

// ---------------------------------------------------------------------------
// 检测器自检：先用一个**已知正确**的 schemastery schema 验证判定逻辑本身。
// 否则「判定失败」既可能是被测对象有问题，也可能是检查器写错了 —— 无法区分。
// 这正是本项目在 schema 上栽过一次的同类错误（只验产物不验输入）。
// ---------------------------------------------------------------------------
try {
  const { default: z } = await import('@deepseek-ai/schemastery');
  const control = z.object({ flag: z.boolean().default(false) });
  const controlOk = isNativeConfigSchema(control);
  if (controlOk) {
    console.log('PASS  自检：已知正确的 schema 能被判定为 native（检查器可信）');
  } else {
    console.error('FAIL  自检：已知正确的 schema 竟被判为非 native —— 检查器本身有误');
    console.error(
      `      诊断：Symbol.for('schemastery')=${String(Reflect.get(control, Symbol.for('schemastery')))} ` +
        `type=${String(Reflect.get(control, 'type'))} meta=${typeof Reflect.get(control, 'meta')}`,
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`FAIL  自检无法执行（import schemastery 失败）：${error.message}`);
  process.exitCode = 1;
}

// 1) Config 是否被识别为 native schemastery schema
const cfg = mod.Config;
const isNative = isNativeConfigSchema(cfg);
if (isNative) console.log('PASS  Config 是 native schemastery schema（加载器会接受）');
else {
  console.error('FAIL  Config 不是 native schemastery schema —— 加载器会标为 unsupported');
  console.error(
    `      诊断：Symbol.for('schemastery')=${String(Reflect.get(cfg, Symbol.for('schemastery')))} ` +
      `type=${String(Reflect.get(cfg, 'type'))} meta=${typeof Reflect.get(cfg, 'meta')} ` +
      `keys=${JSON.stringify(Object.keys(cfg ?? {}))}`,
  );
  process.exitCode = 1;
}

// 2) 遍历 schemastery 的内部表示，确认角色字段都被描述到。
//
// ⚠️ 为什么不投影成 JSON Schema：`toJSON()` 给的是 schemastery 的**内部表示**
// （`uid` / `refs` / `dict` / `list`），而 `toJSONSchema` 不在这个包上（在
// typert/loader 侧）。与其为了检查去复刻一个投影器，不如直接读内部结构——
// 目标只是「角色字段有没有被描述到」，不是「生成一份 JSON Schema」。
const root = JSON.parse(JSON.stringify(cfg.toJSON ? cfg.toJSON() : cfg));
const refs = root.refs ?? {};

/** 按 ref id 解引用；非数字或缺失时原样返回。 */
const deref = (node) => (typeof node === 'number' ? refs[String(node)] : node);

/** 把一个 schemastery 节点描述成人可读的短形式，用于断言。 */
function describeNode(node) {
  const resolved = deref(node);
  if (!resolved) return '(missing)';
  const meta = resolved.meta ?? {};
  const bits = [resolved.type ?? '?'];
  if (meta.default !== undefined) bits.push(`default=${JSON.stringify(meta.default)}`);
  if (meta.volatile) bits.push('volatile');
  if (resolved.list) bits.push('list');
  if (resolved.dict) bits.push('dict');
  if (resolved.inner !== undefined) bits.push('inner');
  return bits.join(' ');
}

console.log('\n=== schemastery 内部结构检查 ===');
const rootNode = deref(root.uid !== undefined ? root.uid : root);
const rootDict = rootNode?.dict ?? {};
const fieldNames = Object.keys(rootDict);
console.log(`Config 顶层字段：${fieldNames.join(', ')}`);

for (const want of ['provider', 'maxDepth', 'cwd', 'roles', 'volatile']) {
  if (fieldNames.includes(want)) console.log(`PASS  顶层字段 ${want} 存在`);
  else {
    console.error(`FAIL  顶层字段 ${want} 缺失`);
    process.exitCode = 1;
  }
}

// volatile 的判定规则来自 dsh-settings 的 volatileForm：
//   function volatileForm(schema) {
//     if (schema.meta.volatile) return plainSchema(schema);   // 标在节点自己身上即可
//     ... 否则对 object 递归下钻 ...
//   }
// 其 JSDoc 原文：“Select fields whose nearest volatile ancestor makes them editable
// without remounting.” —— 也就是说标记在**最近的 volatile 祖先**上就够，
// 子字段不必逐个标记。把 volatile 对象整体标 volatile 是正确且推荐的写法。
const volNode2 = deref(rootDict.volatile);
const volDict = volNode2?.dict ?? {};
console.log(`volatile 子字段：${Object.keys(volDict).join(', ') || '(无)'}`);
const volSelfMarked = volNode2?.meta?.volatile === true;
if (volSelfMarked) {
  console.log('PASS  volatile 对象自带 meta.volatile（其子字段经「最近 volatile 祖先」规则可编辑）');
} else {
  console.error(
    `FAIL  volatile 对象没有 meta.volatile —— 设置页不会暴露它（实际值=${JSON.stringify(volNode2?.meta?.volatile)}）`,
  );
  process.exitCode = 1;
}

// volatile 只保留兼容容器；运行期限字段必须从 schema 消失。
for (const key of Object.keys(volDict)) {
  console.log(`      volatile.${key}：由父节点的 volatile 标记覆盖`);
}
if (!Object.hasOwn(volDict, 'cliTimeoutSec')) {
  console.log('PASS  volatile 不再声明运行期限字段 cliTimeoutSec');
} else {
  console.error('FAIL  cliTimeoutSec 仍在 schema 中');
  process.exitCode = 1;
}

// roles 是 list，其 inner 应该描述角色的全部字段
const rolesNode = deref(rootDict.roles);
const rolesInner = deref(rolesNode?.inner);
const roleFields = rolesInner?.dict ?? {};
console.log(`roles[].字段：${Object.keys(roleFields).join(', ') || '(无)'}`);
const expectedRoleFields = [
  'id',
  'title',
  'description',
  'provider',
  'agentProvider',
  'agentModel',
  'model',
  'effort',
  'instructions',
  'readOnly',
  'backend',
  'allowNestedDispatch',
  // cli 后端的字段。放在角色顶层是为了让设置面板按普通标量字段渲染它们。
  'cliDriver',
  'cliCommand',
  'cliPrefixArgs',
  'cliArgs',
  'cliPromptDelivery',
  'cliCwd',
  'cliGraceMs',
  'cliMaxOutputBytes',
  'cliMaxErrorBytes',
];
for (const want of expectedRoleFields) {
  if (Object.prototype.hasOwnProperty.call(roleFields, want)) {
    console.log(`      ${want.padEnd(20)} ${describeNode(roleFields[want])}`);
  } else {
    console.error(`FAIL  roles[] 缺字段 ${want}`);
    process.exitCode = 1;
  }
}

for (const key of ['agentProvider', 'agentModel']) {
  const node = deref(roleFields[key]);
  if (node?.type === 'string' && !node.meta?.required && /继承父代理/.test(node.meta?.description ?? '')) {
    console.log(`PASS  ${key} 为可选字符串，留空继承父代理路由`);
  } else {
    console.error(`FAIL  ${key} 必须是带继承说明的可选字符串`);
    process.exitCode = 1;
  }
}

// effort / backend 必须带取值约束，否则用户能配出运行时才失败的值
for (const constrained of ['effort', 'backend']) {
  const node = deref(roleFields[constrained]);
  const hasConstraint = Boolean(node?.list || node?.inner || node?.meta?.enum || node?.enum);
  if (hasConstraint) console.log(`PASS  ${constrained} 带取值约束`);
  else {
    console.error(`FAIL  ${constrained} 没有取值约束（用户可配出非法值）`);
    process.exitCode = 1;
  }
}

if (wantJson) {
  console.log('\n=== schemastery 内部表示（原始） ===');
  console.log(JSON.stringify(root, null, 2));
}

// 用显式结果收尾，避免上面为了早退而 throw 的异常影响调用方对结果的理解。
console.log(process.exitCode ? '\n结果：有问题' : '\n结果：全部通过');
