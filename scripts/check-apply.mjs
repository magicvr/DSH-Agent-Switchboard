// 离线模拟 apply 的两条路径，找出崩溃点。
//
// 为什么必须做：本插件曾让应用无法启动。必须在不重启的前提下，用假 ctx 把
// 根路径与 preset 路径都真跑一遍 —— 重启一次的成本太高，而且失败会让用户进不去。
// 覆盖边界：派发使用真实 Config / 工具插件，start 是含真实 resolveChildDepth 的桩。
// 另用真实 Cordis + ToolRuntime + applyChildComposition 验证 child 工具过滤执行；
// 不是真实 spawn 集成，未验证 preset 继承与完整上下文隔离，见 D21。
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createScope, scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { applyChildComposition, delegationDepthOf, resolveChildDepth } from '@deepseek-ai/dsh-subagent';
import { apply, Config, liveRoleTools, selftestTool } from '../src/index.js';
import { toolConfigFor } from '../src/roles.js';
import { configPathFor, initialConfig, readConfigFile, writeConfigFile } from '../src/config-file.js';

const fixtureHome = mkdtempSync(join(tmpdir(), 'switchboard-check-apply-'));
const previousDshHome = process.env.DSH_HOME;
const fixtureRole = { id: 'fixture', description: '离线测试角色', instructions: '只用于测试', model: 'test-model' };

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

/**
 * 造一个足够真的假 Cordis ctx。
 *
 * 只实现本插件实际用到的东西：`get` / `tools.register` / `plugin` / `subagents` /
 * `systemPrompt` / `subprocess` / `profileContext`。刻意保持最小，这样任何「用到别的东西」
 * 都会立刻暴露成错误，而不是被一个过宽的桩掩盖。
 *
 * @param {object} options - 选项。
 * @param {boolean} options.provideProfileContext - 是否提供 profileContext。
 * @param {boolean} options.provideReflect - 是否提供 reflect.provide。
 * @param {object} [options.scope] - 注册工具的 scope；省略时写入 global。
 * @returns {object} 假 ctx。
 */
function makeCtx({ provideProfileContext = true, provideReflect = true, scope } = {}) {
  const registered = [];
  const provided = [];
  const globalTools = new Map();
  const scopedTools = new Map();
  const services = new Map();
  const toolFaces = new WeakMap();
  let ctx = {
    registered,
    provided,
    // Cordis 的 ctx.provide 混入入口与 reflect.provide 共用同一调用记录。
    provide(name, instance) {
      this.reflect.provide(name, instance);
      return () => {};
    },
    get(key) {
      if (key === 'tools') {
        if (!toolFaces.has(this)) toolFaces.set(this, Object.create(services.get('tools'), { ctx: { value: this } }));
        return toolFaces.get(this);
      }
      if (key === 'profileContext') {
        return provideProfileContext ? { home: fixtureHome, dir: join(fixtureHome, 'profiles', 'desktop') } : undefined;
      }
      return services.get(key);
    },
    // ⚠️ 必须存在：`RoleConfigService extends TypertRemoteService`，其构造会经由
    //    `Service` 同步调用 `ctx.reflect.provide()`。缺了它就会走「注册失败」的降级路径
    //    —— 那本身也是我们要测的一种情况，因此不能把它变成永远成功的桩。
    reflect: provideReflect
      ? {
          props: {},
          provide(name, instance) {
            provided.push(name);
            return instance;
          },
        }
      : undefined,
    tools: {
      get ctx() { return ctx; },
      register(def) {
        const key = scopeOf(this.ctx);
        if (key !== undefined && !scopedTools.has(key)) scopedTools.set(key, new Map());
        const layer = key === undefined ? globalTools : scopedTools.get(key);
        if (layer.has(def.name)) throw new Error(`重复工具：${def.name}`);
        layer.set(def.name, def);
        registered.push(def?.name);
        return () => layer.delete(def.name);
      },
      get(name, viewingScope) {
        for (const key of scopeChainOf(viewingScope)) {
          const found = scopedTools.get(key)?.get(name);
          if (found) return found;
        }
        return globalTools.get(name);
      },
      schemas(viewingScope) {
        const visible = new Map(globalTools);
        for (const key of scopeChainOf(viewingScope).reverse()) {
          for (const [name, tool] of scopedTools.get(key) ?? []) visible.set(name, tool);
        }
        return [...visible.values()];
      },
    },
    // createScope 借助 extend 写入真实的私有 scope 标签；角色插件只模拟注册副作用。
    extend(properties) {
      const child = Object.defineProperties(Object.create(this), Object.getOwnPropertyDescriptors(properties));
      if (!Object.hasOwn(properties, 'get')) {
        const parent = this;
        let tools;
        Object.defineProperty(child, 'get', { configurable: true, writable: true, value(key) {
          const service = parent.get(key);
          if (key !== 'tools' || !service) return service;
          tools ??= Object.create(service, { ctx: { value: child } });
          return tools;
        } });
      }
      for (const key of ['tools', 'subagents', 'agents', 'systemPrompt', 'subprocess', 'jobs', 'profileContext']) {
        if (Object.hasOwn(properties, key)) continue;
        Object.defineProperty(child, key, { configurable: true, get() {
          throw new Error(`cannot get property "${key}" without inject`);
        } });
      }
      return child;
    },
    plugin(_module, config) {
      if (config?.toolName) this.get('tools').register({ name: config.toolName });
      return { ctx: this, dispose() {} };
    },
    subagents: {
      registerProvider() {
        return { dispose() {} };
      },
    },
    systemPrompt: {
      section() {
        return { dispose() {} };
      },
    },
    subprocess: {
      spawn() {
        throw new Error('不应在装载期 spawn');
      },
      resolveExecutable() {
        return Promise.resolve('C:/fake/node.exe');
      },
    },
  };
  for (const key of ['tools', 'subagents', 'systemPrompt', 'subprocess']) services.set(key, ctx[key]);
  if (scope !== undefined) ctx = createScope(ctx, scope).ctx;
  // makeCtx 返回插件实例；扩展/私有 scope 没有声明 inject，实例声明依赖可直接读取。
  for (const key of services.keys()) Object.defineProperty(ctx, key, {
    configurable: true, value: ctx.get(key), writable: true,
  });
  return ctx;
}

try {
const writtenFixture = writeConfigFile(configPathFor(fixtureHome), initialConfig([fixtureRole], { provider: 'self' }));
if (!writtenFixture.ok) throw new Error(writtenFixture.error);
process.env.DSH_HOME = fixtureHome; // headless 路径也只读临时 home，不改 USERPROFILE。

section('夹具保真：未 inject 抛错、服务按私有 scope 绑定、初始失败响亮');
{
  const ctx = makeCtx();
  const privateScope = createScope(ctx, {});
  for (const key of ['tools', 'subagents', 'agents', 'systemPrompt', 'subprocess', 'jobs', 'profileContext']) {
    let error;
    try { void privateScope.ctx[key]; } catch (caught) { error = caught; }
    check(`未 inject 的私有 ctx 直接访问 ${key} 抛错`, error?.message === `cannot get property "${key}" without inject`);
  }
  const privateTools = privateScope.ctx.get('tools');
  const undo = privateTools.register({ name: 'private-fixture' });
  check('私有 tools face 与实例分层绑定，私有注册不污染实例', privateTools !== ctx.get('tools')
    && privateTools.get('private-fixture', scopeOf(privateScope.ctx)) != null
    && ctx.get('tools').get('private-fixture', scopeOf(ctx)) === undefined);
  undo();
  await privateScope.dispose();
  apply(ctx, { mount: true, roles: [fixtureRole], provider: 'self' });
  await import('@deepseek-ai/dsh-tool-subagent');
  await new Promise(setImmediate);
  const healthy = await ctx.tools.get('switchboard_selftest').execute({});
  check('inject 强制下初始私有构建确实挂出角色工具', healthy.ok && healthy.roleCount === 1
    && healthy.mounted === 'fixture=OK', JSON.stringify(healthy));

  const broken = makeCtx();
  const originalExtend = broken.extend;
  broken.extend = function (properties) {
    const child = originalExtend.call(this, properties);
    if (scopeOf(child) !== scopeOf(this)) child.get = key => {
      if (key === 'tools') throw new Error('fixture-private-tools-unavailable');
      return this.get(key);
    };
    return child;
  };
  apply(broken, { mount: true, roles: [fixtureRole], provider: 'self' });
  await new Promise(setImmediate);
  const failed = await broken.tools.get('switchboard_selftest').execute({});
  check('初始私有构建异常使健康门禁失败且显式记录 configErrors/fatal', !failed.ok && failed.roleCount === 0
    && failed.configErrors.includes('初始挂载失败') && failed.fatal.includes('fixture-private-tools-unavailable'), JSON.stringify(failed));
}

section('Config：mount 字段与内置 roles 字段是否冲突');
{
  const a = Config({ provider: 'self' });
  check('空配置可解析', a !== undefined);
  check('mount 默认 false', a.mount === false, String(a.mount));
  const b = Config({ provider: 'self', mount: true });
  check('mount:true 可解析', b.mount === true, String(b.mount));
  const c = Config({ provider: 'self', roles: [] });
  check('旧字段 roles 仍可解析（兼容旧配置）', c !== undefined);
  const d = Config({ provider: 'self', roles: [{ id: 'x', description: 'd', instructions: 'i', model: 'm' }] });
  check('带角色的旧配置可解析', d !== undefined);
}

section('根条目路径（无 mount）：只注册自检工具，不注册服务');
{
  const ctx = makeCtx();
  let threw = false;
  let error;
  try {
    apply(ctx, { provider: 'self', cwd: 'C:/w' });
  } catch (e) {
    threw = true;
    error = e;
  }
  check('apply 不抛错', !threw, error?.message);
  check('注册了自检工具', ctx.registered.includes('switchboard_selftest'), ctx.registered.join(','));
  check('未注册任何角色工具', !ctx.registered.some((n) => String(n).startsWith('delegate_to')), ctx.registered.join(','));
  // 根条目已不再注册任何 Cordis 服务；直接检查实际副作用，不使用恒真兜底。
  check(
    '根条目装载期未调用服务注册',
    ctx.provided.length === 0,
    ctx.provided.join(','),
  );
}

section('profileContext 缺失时也必须能装载（headless/sdk/acp）');
{
  const ctx = makeCtx({ provideProfileContext: false });
  let threw = false;
  let error;
  try {
    apply(ctx, { provider: 'self', cwd: 'C:/w' });
  } catch (e) {
    threw = true;
    error = e;
  }
  check('apply 不抛错', !threw, error?.message);
  check('仍注册了自检工具', ctx.registered.includes('switchboard_selftest'));
}

section('preset 路径（mount:true）：读角色文件并挂载工具，不该抛错');
{
  const ctx = makeCtx();
  let threw = false;
  let error;
  try {
    apply(ctx, { provider: 'self', cwd: 'C:/w', mount: true });
  } catch (e) {
    threw = true;
    error = e;
  }
  check('apply 不抛错', !threw, error?.message);
  check('注册了自检工具', ctx.registered.includes('switchboard_selftest'), ctx.registered.join(','));
  await import('@deepseek-ai/dsh-tool-subagent');
  await new Promise(setImmediate);
  const mounted = await ctx.tools.get('switchboard_selftest').execute({});
  check('确实读取并挂载了 fixture 角色', ctx.registered.includes('delegate_to_fixture')
    && mounted.roleCount === 1 && mounted.mounted === 'fixture=OK', JSON.stringify(mounted));
  console.log(`       注册的工具：${ctx.registered.join(', ')}`);

  // mount:true 的作用域**不得**注册服务（那是根条目的职责，避免每个会话都冒注册风险）。
  check(
    'preset 作用域未尝试注册 roleConfig 服务',
    !ctx.registered.includes('roleConfig'),
    ctx.registered.join(','),
  );
}

section('同步到文件失败时必须降级而不是抛出');
{
  // 用文件占据配置目录，确定性制造同步写入失败。
  const brokenHome = join(fixtureHome, 'blocked-home');
  mkdirSync(brokenHome);
  writeFileSync(dirname(configPathFor(brokenHome)), '阻碍目录创建');
  const ctx = makeCtx();
  ctx.get = (key) =>
    key === 'profileContext' ? { home: brokenHome, dir: join(brokenHome, 'profiles', 'desktop') } : undefined;
  let threw = false;
  let error;
  try {
    apply(ctx, { provider: 'self', cwd: 'C:/w', roles: [{ id: 'scout', description: 'd', instructions: 'i', model: 'gpt-6-luna' }] });
  } catch (e) {
    threw = true;
    error = e;
  }
  check('同步路径出问题时 apply 仍不抛错', !threw, error?.message);
}

section('异常输入不得让 apply 抛出（兜底边界）');
{
  for (const [label, cfg] of [
    ['undefined', undefined],
    ['null', null],
    ['空对象', {}],
    ['mount 为非布尔', { mount: 'yes' }],
    ['roles 为字符串（旧字段残留）', { roles: 'nope' }],
    ['profileContext 抛错', { mount: true }],
  ]) {
    let threw = false;
    let error;
    try {
      apply(makeCtx(), cfg);
    } catch (e) {
      threw = true;
      error = e;
    }
    check(`apply(${label}) 不抛错`, !threw, error?.message);
  }

  // ctx 本身残缺时也不得抛出（兜底 try/catch 的存在意义）。
  for (const [label, brokenCtx] of [
    ['无 tools', {}],
    ['get 抛错', { get() { throw new Error('boom'); }, tools: { register() {} } }],
    ['tools.register 抛错', { get() { return undefined; }, tools: { register() { throw new Error('boom'); } } }],
  ]) {
    let threw = false;
    let error;
    try {
      apply(brokenCtx, { provider: 'self' });
    } catch (e) {
      threw = true;
      error = e;
    }
    check(`apply 在「${label}」时不抛错（降级为日志）`, !threw, error?.message);
  }
}

section('本插件不再注册任何 Cordis 服务（消除启动风险面）');
{
  // ⚠️ 这条锁死一次真实启动失败 + 一次方案返工：
  //     1. 曾注册一个 `roleConfig` 远程服务给客户端设置页用，而客户端把
  //        `remote.roleConfig` 写成**必需注入** → 注册时机不匹配 → 客户端永远 pending →
  //        `web boot: 1 entry did not activate`，整页起不来。
  //     2. 后来查明：客户端只装载**构建期生成的静态远程贡献清单**，且没有 Proxy，
  //        因此**外部插件根本无法新增客户端可调用的远程命名空间** —— 那个服务就算
  //        注册成功，客户端也调不到（`remote.roleConfig` 会是 undefined）。
  //     现在客户端改走 `settings`（唯一可写通道），Host 侧不再需要任何自建服务。
  const ctx = makeCtx();
  apply(ctx, { provider: 'self', cwd: 'C:/w' });
  check(
    '根条目装载后未注册任何服务',
    ctx.provided.length === 0,
    `实际注册：${ctx.provided.join(', ') || '（无）'}`,
  );
}

section('客户端必需注入只许声明内核保证存在的服务');
{
  // 客户端的 `inject` 是**必需**依赖：声明了就必须在装载期存在，否则客户端永远 pending、
  // 整页启动失败（实测：`web boot: 1 entry did not activate`）。
  //
  // 判据**不是**「不许出现 remote.*」—— `remote.settings` 由内核插件
  // `dsh-api-settings-controller` 提供，每次启动都在，官方 `ui-settings-general` 也注入它。
  // 真正的判据是：**只许注入内核保证存在的依赖，不许注入我们自己提供的服务**
  // （曾把自建且延迟注册的 `remote.roleConfig` 写成必需注入，直接导致整页起不来）。
  const clientSrc = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8');
  const m = /inject:\s*\[([^\]]*)\]/.exec(clientSrc);
  const declared = (m?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0);
  console.log(`       客户端 inject = ${JSON.stringify(declared)}`);
  check('客户端 inject 含 slots', declared.includes('slots'), declared.join(','));
  check('客户端 inject 含 configForms（读配置的镜像）', declared.includes('configForms'), declared.join(','));
  check(
    '客户端 inject 含 remote.settings（UI 唯一可写通道）',
    declared.includes('remote.settings'),
    declared.join(','),
  );
  check(
    '客户端 inject 里没有自建的 remote 命名空间',
    !declared.includes('remote.roleConfig'),
    declared.join(','),
  );

  // 读走 configForms 镜像（官方「模型」页的做法），写走 remote.settings。
  // 只用 `remote.settings.describe()` 读是错的路子 —— 实测报「取不到 remote.settings 通道」。
  check(
    '客户端读配置走 configForms 镜像（ensure/getSnapshot）',
    /configForms\?\.describe|configForms\.describe/.test(clientSrc) && /\.ensure\(\)/.test(clientSrc),
    '未找到对 configForms.describe().ensure() 的引用',
  );
  check(
    '客户端写配置走 remote.settings.mutate',
    /remote\?\.settings|remote\.settings/.test(clientSrc) && /\.mutate\(/.test(clientSrc),
    '未找到对 remote.settings.mutate 的引用',
  );
}

section('自检必须「实时查询」工具注册表，不能只读异步快照');
{
  // ⚠️ 锁死一个实测 bug：挂载走 `import(...).then(...)`，是**异步**的，而自检可以被
  //    更早调用 —— 于是它读到的快照是空的，报告「已挂载角色工具：0」，
  //    **尽管 4 个 `delegate_to_*` 全部可用**（实验会话实测：报告 0，工具全在）。
  //    另外同一插件会被多次激活，在别的作用域读快照也会得到误导性结果。
  //
  //    「工具到底在不在」本来就能当场查到，因此断言必须基于**实时查询**。
  const ctx = makeCtx();

  const roles = [
    { id: 'worker', toolName: 'delegate_to_worker' },
    { id: 'scout', toolName: 'delegate_to_scout' },
  ];

  check('一个都没装时报告缺失', liveRoleTools(ctx, roles).every((m) => m.ok === false));

  ctx.tools.register({ name: 'delegate_to_worker' });
  ctx.tools.register({ name: 'delegate_to_scout' });
  const live = liveRoleTools(ctx, roles);
  check('装上后实时查询报告 OK', live.every((m) => m.ok === true), JSON.stringify(live));
  check('实时结果按角色给出 id', live.map((m) => m.id).join(',') === 'worker,scout', JSON.stringify(live));

  // 工具服务不可查询时，必须逐角色标为未核实，而不是抛错或返回空数组。
  const noTools = makeCtx();
  noTools.get = () => undefined;
  let threw = false;
  try {
    liveRoleTools(noTools, roles);
  } catch {
    threw = true;
  }
  check('工具服务不可用时不抛错', !threw);
  check('工具服务不可用时逐角色报告未核实',
    liveRoleTools(noTools, roles).length === roles.length
      && liveRoleTools(noTools, roles).every((m) => m.ok === false && m.unverified === true));

  // 查询本身抛错时按「该角色失败」处理，不影响其它角色。
  const throwing = makeCtx();
  throwing.get = () => ({
    get: (name) => {
      if (name === 'delegate_to_worker') throw new Error('boom');
      return { name };
    },
  });
  const mixed = liveRoleTools(throwing, roles);
  check('单个角色查询抛错不影响其它', mixed[0].ok === false && mixed[1].ok === true, JSON.stringify(mixed));
}

section('scope 层注册成功时，自检与挂载核验必须使用同一视图');
{
  const home = mkdtempSync(join(tmpdir(), 'switchboard-check-scope-'));
  try {
    const roles = [{ id: 'scout', description: '侦察', instructions: '核实事实', model: 'test-model' }];
    const written = writeConfigFile(configPathFor(home), initialConfig(roles, { provider: 'self' }));
    if (!written.ok) throw new Error(written.error);
    const scope = {};
    const ctx = makeCtx({ scope });
    const get = ctx.get.bind(ctx);
    ctx.get = (key) => key === 'profileContext' ? { home, dir: home } : get(key);
    apply(ctx, { provider: 'self', mount: true });
    // 等待动态 import 与 mountRoleTool 的微任务核验完成，不能只测 live 查询绕过快照失败。
    await import('@deepseek-ai/dsh-tool-subagent');
    await new Promise(setImmediate);

    const name = 'delegate_to_scout';
    check('假工具注册写入 scope 层', ctx.tools.get(name, scope)?.name === name);
    check('无 scope 查询看不到 scope 层工具', ctx.tools.get(name) === undefined);
    check('其它 scope 查询看不到本层工具', ctx.tools.get(name, {}) === undefined);
    const live = liveRoleTools(ctx, [{ id: 'scout', toolName: name }]);
    check('无 scope 的缺失不能作为实时挂载判据', live[0]?.ok === true, JSON.stringify(live));
    const selftest = ctx.tools.get('switchboard_selftest', scope);
    const result = await selftest.execute({});
    check('scope 注册成功时自检报告已挂载一个角色', result.roleCount === 1, JSON.stringify(result));
    check('scope 注册成功时自检角色标为 OK 而非失败', result.mounted === 'scout=OK', result.mounted);
    check('scope 注册成功时挂载核验快照不产生假失败', result.ok === true, JSON.stringify(result));

    const global = makeCtx();
    const definition = { name };
    global.tools.register(definition);
    check('scope 为 undefined 时查询与原 global 查询一致',
      global.tools.get(name) === definition && global.tools.get(name, undefined) === definition
        && liveRoleTools(global, [{ id: 'scout', toolName: name }])[0]?.ok === true);
    check('带 scope 的视图仍能看到 global 工具', global.tools.get(name, scope) === definition);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

section('首次核验失败后 provider 延迟就绪：当前健康覆盖失败快照');
{
  const home = mkdtempSync(join(tmpdir(), 'switchboard-check-delayed-'));
  try {
    const written = writeConfigFile(configPathFor(home), initialConfig([
      { id: 'scout', description: '侦察', instructions: '核实事实', model: 'test-model' },
    ], { provider: 'self' }));
    if (!written.ok) throw new Error(written.error);
    const scope = {};
    const ctx = makeCtx({ scope });
    const get = ctx.get.bind(ctx);
    ctx.get = (key) => key === 'profileContext' ? { home, dir: home } : get(key);
    let providerReady;
    const scopePlugin = ctx.plugin;
    ctx.plugin = function (_module, config) {
      if (!config) return scopePlugin.call(this, _module, config);
      // 模拟真实插件等待 provider-added 后才注册工具；首次微任务核验必定看不到它。
      const tools = this.get('tools');
      providerReady = () => tools.register({ name: config.toolName });
      return { ctx: this, dispose() {} };
    };
    apply(ctx, { provider: 'self', mount: true });
    await import('@deepseek-ai/dsh-tool-subagent');
    await new Promise(setImmediate);
    const selftest = ctx.tools.get('switchboard_selftest', scope);
    const before = await selftest.execute({});
    check('延迟注册前自检失败且已挂载数为零', before.ok === false && before.roleCount === 0, JSON.stringify(before));
    check('延迟注册前保留首次核验失败原因', before.mounted.includes('首次核验：工具尚未出现在工具注册表中'), before.mounted);
    if (typeof providerReady !== 'function') throw new Error('未启动角色插件');
    const unregister = providerReady();
    const after = await selftest.execute({});
    check('provider 就绪后自检恢复健康', after.ok === true, JSON.stringify(after));
    check('provider 就绪后角色计为已挂载', after.roleCount === 1, JSON.stringify(after));
    check('provider 就绪后角色标为已挂载而非失败', after.mounted.startsWith('scout=OK') && !after.mounted.includes('=失败'), after.mounted);
    check('恢复健康后仍记录曾延迟注册', after.mounted.includes('曾延迟注册：工具尚未出现在工具注册表中'), after.mounted);
    const rendered = selftest.output.render({}, after).map((block) => block.text).join('\n');
    check('自检渲染展示当前状态与延迟历史', rendered.includes('明细（当前挂载状态）：scout=OK') && rendered.includes('曾延迟注册'), rendered);
    // 反向保护：成功快照/恢复历史都不能让后来消失的工具继续 OK。
    unregister();
    const removed = await selftest.execute({});
    check('provider 再移除后自检重新失败', removed.ok === false && removed.roleCount === 0, JSON.stringify(removed));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

section('工具始终未注册：不抛错的 fiber 不能被当作可用工具');
{
  const home = mkdtempSync(join(tmpdir(), 'switchboard-check-missing-'));
  try {
    const written = writeConfigFile(configPathFor(home), initialConfig([
      { id: 'worker', description: '执行', instructions: '完成任务', model: 'test-model' },
    ], { provider: 'self' }));
    if (!written.ok) throw new Error(written.error);
    const scope = {};
    const ctx = makeCtx({ scope });
    const get = ctx.get.bind(ctx);
    ctx.get = (key) => key === 'profileContext' ? { home, dir: home } : get(key);
    ctx.plugin = function () { return { ctx: this, dispose() {} }; };
    apply(ctx, { provider: 'self', mount: true });
    await import('@deepseek-ai/dsh-tool-subagent');
    await new Promise(setImmediate);
    const result = await ctx.tools.get('switchboard_selftest', scope).execute({});
    check('工具始终未注册时自检仍失败', result.ok === false, JSON.stringify(result));
    check('工具始终未注册时已挂载数仍为零', result.roleCount === 0, JSON.stringify(result));
    check('真实缺失角色同时标为失败与实时缺失', result.mounted.startsWith('worker=失败(工具未注册') && result.liveTools === 'worker=缺失', JSON.stringify(result));
    check('真实缺失角色保留首次核验诊断', result.mounted.includes('首次核验：工具尚未出现在工具注册表中'), result.mounted);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

section('根实例只报告配置数量：不挂载与未配置分别表达');
{
  const home = mkdtempSync(join(tmpdir(), 'switchboard-check-root-'));
  try {
    const path = configPathFor(home);
    const written = writeConfigFile(path, initialConfig([
      { id: 'scout', description: '侦察', instructions: '核实事实', model: 'test-model' },
      { id: 'worker', description: '执行', instructions: '完成任务', model: 'test-model' },
    ], { provider: 'self' }));
    if (!written.ok) throw new Error(written.error);
    const original = readFileSync(path, 'utf8');
    const ctx = makeCtx();
    const get = ctx.get.bind(ctx);
    ctx.get = (key) => key === 'profileContext' ? { home, dir: home } : get(key);
    apply(ctx, { provider: 'self', mount: false });
    const selftest = ctx.tools.get('switchboard_selftest');
    const result = await selftest.execute({});
    check('根实例不挂载配置角色且健康', result.roleCount === 0 && result.ok === true && !ctx.registered.some((n) => n.startsWith('delegate_to')), JSON.stringify(result));
    check('根实例显示不挂载及文件中的两个角色', result.mounted === '（本作用域不挂载角色工具；配置中有 2 个角色）', result.mounted);
    check('根实例已有角色时不声称未配置', !result.mounted.includes('尚未配置'), result.mounted);
    check('根实例实时查询说明不负责挂载', result.liveTools === '（本作用域不挂载角色工具）', result.liveTools);
    const rendered = selftest.output.render({}, result).map((block) => block.text).join('\n');
    check('根实例渲染同时展示零挂载和两个配置角色', rendered.includes('已挂载角色工具：0') && rendered.includes('配置中有 2 个角色'), rendered);
    check('根实例只读现有角色文件未改变内容', readFileSync(path, 'utf8') === original);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

section('根实例配置桥：缺文件、读取失败、同步失败与恢复');
{
  const home = mkdtempSync(join(tmpdir(), 'switchboard-check-root-gates-'));
  try {
    const roles = [{ id: 'scout', description: '侦察', instructions: '核实事实', model: 'test-model' }];
    // 每次 apply 都是一轮激活；恢复使用新 ctx，避免假注册表的重复名称干扰结果。
    const activate = async (fixtureHome, extra = {}) => {
      const ctx = makeCtx();
      const get = ctx.get.bind(ctx);
      ctx.get = (key) => key === 'profileContext' ? { home: fixtureHome, dir: fixtureHome } : get(key);
      let threw = false;
      try {
        apply(ctx, { provider: 'self', mount: false, ...extra });
      } catch {
        threw = true;
      }
      const tool = ctx.tools.get('switchboard_selftest');
      return { ctx, threw, result: tool ? await tool.execute({}) : {} };
    };

    const missingHome = join(home, 'missing');
    const missing = (await activate(missingHome)).result;
    check('J1：缺文件是合法初始状态且不写入文件',
      missing.ok === true && missing.configErrors === '' && !existsSync(configPathFor(missingHome)), JSON.stringify(missing));
    check('J2：missing 透传后同步文案明确尚未创建而非已有或损坏',
      missing.roleConfigStatus?.includes('同步=根条目无角色（未提供 roles），文件尚未创建')
        && !missing.roleConfigStatus.includes('文件已有') && !missing.roleConfigStatus.includes('失败'), JSON.stringify(missing));

    const jsonHome = join(home, 'json');
    const jsonPath = configPathFor(jsonHome);
    mkdirSync(dirname(jsonPath), { recursive: true });
    const brokenJson = '{invalid-json';
    writeFileSync(jsonPath, brokenJson);
    const bad = (await activate(jsonHome)).result;
    check('J3：根实例依赖坏 JSON 时配置错误阻止健康',
      bad.ok === false && bad.configErrors?.includes('JSON 解析失败'), JSON.stringify(bad));
    check('J4：坏 JSON 的同步文案说明读取失败且原文件保持不变',
      bad.roleConfigStatus?.includes('同步=根条目无角色（未提供 roles）；文件读取失败，未同步：')
        && !bad.roleConfigStatus.includes('文件也没有') && !bad.roleConfigStatus.includes('文件尚未创建')
        && readFileSync(jsonPath, 'utf8') === brokenJson, JSON.stringify(bad));

    // 目标是目录，实际 readFileSync 必须失败；不依赖本机权限或非法路径猜测。
    const ioHome = join(home, 'io');
    mkdirSync(configPathFor(ioHome), { recursive: true });
    const unreadable = (await activate(ioHome, { roles: [] })).result;
    check('J5：显式空 Cordis 角色依赖不可写文件时不健康并明确同步失败',
      unreadable.ok === false && unreadable.configErrors?.includes('同步失败：')
        && unreadable.roleConfigStatus?.includes('同步=同步失败：')
        && !unreadable.roleConfigStatus.includes('文件尚未创建'), JSON.stringify(unreadable));

    // 私有目录的位置放一个普通文件，真实 mkdir/write 必须失败；apply 仍返回。
    const syncHome = join(home, 'sync');
    mkdirSync(syncHome);
    const blocker = dirname(configPathFor(syncHome));
    writeFileSync(blocker, 'block-directory-creation');
    const failedSync = await activate(syncHome, { roles });
    check('J6：真实同步写入失败进入配置错误并阻止健康',
      failedSync.result.ok === false && failedSync.result.configErrors?.includes('同步失败：')
        && failedSync.result.roleConfigStatus?.includes('同步=同步失败：'), JSON.stringify(failedSync.result));
    check('J7：真实同步失败时 apply 不抛错且自检仍可调用',
      !failedSync.threw && failedSync.ctx.registered.includes('switchboard_selftest')
        && failedSync.result.phase === 'phase-3', JSON.stringify(failedSync.result));

    const repaired = writeConfigFile(jsonPath, initialConfig([], { provider: 'self' }));
    if (!repaired.ok) throw new Error(repaired.error);
    const legal = (await activate(jsonHome)).result;
    check('J8：坏文件修为合法空文件后重新激活恢复健康',
      legal.ok === true && legal.configErrors === ''
        && legal.roleConfigStatus?.includes('文件已有 0 个，保持不变'), JSON.stringify(legal));

    rmSync(blocker);
    const synced = (await activate(syncHome, { roles })).result;
    check('J9：移除写入阻碍后同步成功恢复健康且角色落盘',
      synced.ok === true && synced.configErrors === ''
        && synced.roleConfigStatus?.includes('已把 1 个角色从配置同步到文件')
        && JSON.stringify(JSON.parse(readFileSync(configPathFor(syncHome), 'utf8')).roles) === JSON.stringify(roles), JSON.stringify(synced));

    writeFileSync(jsonPath, brokenJson);
    const recovered = (await activate(jsonHome, { roles })).result;
    check('J10：同次激活成功同步修复坏文件时历史读取错误不锁存不健康',
      recovered.ok === true && recovered.configErrors === ''
        && recovered.roleConfigStatus?.includes('JSON 解析失败')
        && recovered.roleConfigStatus?.includes('已把 1 个角色从配置同步到文件')
        && JSON.stringify(JSON.parse(readFileSync(jsonPath, 'utf8')).roles) === JSON.stringify(roles), JSON.stringify(recovered));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

section('诊断边界：不可查询、零角色、非法配置与服务注册 spy');
{
  // 直接给自检传入快照，避免动态 import 的微任务时序决定边界测试是否命中。
  const roles = ['scout', 'worker', 'architect', 'reviewer']
    .map((id) => ({ id, toolName: `delegate_to_${id}` }));
  const diagnostics = (mounts) => ({
    mountHere: true,
    configuredRoles: roles,
    configuredRoleCount: roles.length,
    mounts,
    configErrors: [],
    providers: [],
    executables: [],
    blocked: [],
  });
  const noTools = makeCtx();
  noTools.get = () => undefined;
  const empty = await selftestTool(noTools, diagnostics([])).execute({});
  check('F1-a：有角色但工具不可查询且快照为空时失败并说明未核实',
    empty.ok === false && empty.roleCount === 0
      && roles.every((r) => empty.mounted.includes(`${r.id}=失败(无法核实：工具服务不可查询`))
      && empty.liveTools.includes('未核实'), JSON.stringify(empty));

  const partialTools = makeCtx();
  partialTools.get = (key) => key === 'tools' ? { register() {} } : undefined;
  const partial = await selftestTool(partialTools, diagnostics([
    { id: 'scout', ok: true, detail: '已挂载并核实' },
    { id: 'worker', ok: true, detail: '已挂载并核实' },
  ])).execute({});
  check('F1-b：四角色不可查询时两个成功快照不能证明当前健康',
    partial.ok === false && partial.roleCount === 0
      && roles.every((r) => partial.mounted.includes(`${r.id}=失败(无法核实：工具服务不可查询`))
      && partial.mounted.includes('历史快照：成功') && !partial.mounted.includes('=OK'), JSON.stringify(partial));

  const home = mkdtempSync(join(tmpdir(), 'switchboard-check-boundaries-'));
  try {
    const path = configPathFor(home);
    const withHome = () => {
      const ctx = makeCtx();
      const get = ctx.get.bind(ctx);
      ctx.get = (key) => key === 'profileContext' ? { home, dir: home } : get(key);
      return ctx;
    };
    const write = (rawRoles) => {
      const written = writeConfigFile(path, initialConfig(rawRoles, { provider: 'self' }));
      if (!written.ok) throw new Error(written.error);
    };
    write([]);
    const zeroCtx = withHome();
    apply(zeroCtx, { mount: true, provider: 'self' });
    const zeroTool = zeroCtx.tools.get('switchboard_selftest');
    zeroCtx.get = () => undefined;
    const zero = await zeroTool.execute({});
    check('F1-c：零角色 preset 即使工具不可查询也保持健康',
      zero.ok === true && zero.roleCount === 0 && zero.mounted === '（本插件尚未配置任何角色）', JSON.stringify(zero));

    write([
      { id: 'scout', description: '侦察', instructions: '核实事实', model: 'test-model' },
      { id: 'worker', description: '执行', instructions: '完成任务' },
    ]);
    const original = readFileSync(path, 'utf8');
    const root = withHome();
    apply(root, { mount: false, provider: 'self' });
    const rootTool = root.tools.get('switchboard_selftest');
    const invalid = await rootTool.execute({});
    const rendered = rootTool.output.render({}, invalid).map((block) => block.text).join('\n');
    check('F2：根实例保留两个原始角色并显示 model 错误且不健康',
      invalid.ok === false && invalid.mounted.includes('配置中有 2 个角色')
        && !invalid.mounted.includes('配置中有 0 个角色')
        && invalid.configErrors.includes('roles[1].model 必填')
        && rendered.includes('roles[1].model 必填') && readFileSync(path, 'utf8') === original, JSON.stringify(invalid));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const spy = makeCtx();
  const instance = {};
  let disposer;
  let threw = false;
  try {
    disposer = spy.provide('testService', instance);
    spy.reflect.provide('reflectService', instance);
  } catch {
    threw = true;
  }
  check('F3：ctx.provide 与 reflect.provide 共用 spy 且返回 disposer',
    !threw && spy.provided.join(',') === 'testService,reflectService' && typeof disposer === 'function',
    spy.provided.join(','));
}

section('CLI 逐角色阻塞：未知配置不注册工具、不解析命令、不执行');
{
  const { cliFieldsFor } = await import('../src/cli/drivers.js');
  const ctx = makeCtx();
  const providers = [];
  const resolved = [];
  let spawned = 0;
  let guidance = '';
  ctx.subagents.registerProvider = (provider) => { providers.push(provider); return { dispose() {} }; };
  ctx.subprocess.resolveExecutable = (command) => { resolved.push(command); return Promise.resolve('C:/fake/grok.exe'); };
  ctx.subprocess.spawn = () => { spawned++; throw new Error('离线测试禁止启动 CLI'); };
  ctx.systemPrompt.section = (section) => { guidance = section.text; return { dispose() {} }; };
  const base = { description: 'd', instructions: 'i', backend: 'cli', model: 'external-model', readOnly: true, cliCwd: 'C:/w' };
  const legacy = { ...base, id: 'legacy', cliDriver: 'custom', ...cliFieldsFor('codex', true), cliCommand: 'unknown-executable' };
  const valid = { ...base, id: 'valid', cliDriver: 'custom', ...cliFieldsFor('grok', true) };
  const before = JSON.stringify([legacy, valid]);
  apply(ctx, { mount: true, provider: 'self', cwd: 'C:/w', roles: [legacy, valid, { ...fixtureRole, id: 'builtin' }] });
  await import('@deepseek-ai/dsh-tool-subagent');
  await new Promise(setImmediate);
  check('未知配置不注册工具且不解析/启动其命令，旧 provider 不再注册',
    providers.length === 0 && resolved.join(',') === 'grok' && spawned === 0
      && !ctx.registered.includes('switchboard_cli_run_legacy') && ctx.registered.includes('switchboard_cli_run_valid'));
  check('旧 custom 阻塞不影响有效 CLI 和内置角色工具',
    !ctx.registered.includes('delegate_to_legacy') && ctx.registered.includes('delegate_to_valid') && ctx.registered.includes('delegate_to_builtin'));
  const result = await ctx.tools.get('switchboard_selftest').execute({});
  check('自检与主代理指引都显示旧配置待迁移',
    result.blocked.includes('legacy') && result.blocked.includes('待迁移') && guidance().includes('不得派发'));
  check('装载后旧 custom 原始配置保持不变', JSON.stringify([legacy, valid]) === before);
}

section('专属 CLI 工具生命周期：先注册、失败阻断、实时缺失不可冒充健康');
{
  const { cliFieldsFor } = await import('../src/cli/drivers.js');
  const role = { id: 'cli-worker', description: 'd', instructions: 'i', backend: 'cli', model: 'external-model',
    cliDriver: 'grok', cliCwd: 'C:/w', ...cliFieldsFor('grok', false) };
  for (const mode of ['success', 'throw', 'missing', 'delegate-missing']) {
    const scope = {};
    const ctx = makeCtx({ scope });
    const originalRegister = ctx.tools.register;
    const originalGet = ctx.tools.get.bind(ctx.tools);
    const configs = [];
    let boundCliTool;
    let registeredBeforeDelegate = false;
    ctx.tools.register = function (def) {
      if (def.name === 'switchboard_cli_run_cli_worker') {
        boundCliTool ??= def;
        if (mode === 'throw') throw new Error('fixture-cli-register-failed');
        if (mode === 'missing') return () => {};
      }
      return originalRegister.call(this, def);
    };
    const originalPlugin = ctx.plugin;
    ctx.plugin = function (module, config) {
      if (!config) return originalPlugin.call(this, module, config);
      configs.push(config);
      registeredBeforeDelegate = originalGet('switchboard_cli_run_cli_worker', scope) != null;
      return mode === 'delegate-missing' ? { ctx: this, dispose() {} } : originalPlugin.call(this, module, config);
    };
    apply(ctx, { mount: true, roles: [role, { ...fixtureRole, id: 'independent' }], provider: 'self' });
    await import('@deepseek-ai/dsh-tool-subagent');
    await new Promise(setImmediate);
    const selftest = ctx.tools.get('switchboard_selftest', scope);
    const result = await selftest.execute({});
    if (mode === 'success') {
      check('CLI 专属工具与委派工具都在 preset 层注册', ctx.tools.get('switchboard_cli_run_cli_worker', scope)
        && ctx.tools.get('delegate_to_cli_worker', scope) && !ctx.tools.get('switchboard_cli_run_cli_worker'));
      check('专属 CLI 工具先于角色插件挂载', registeredBeforeDelegate
        && ctx.registered.indexOf('switchboard_cli_run_cli_worker') < ctx.registered.indexOf('delegate_to_cli_worker'));
      check('apply 的 CLI 配置使用 spawn 和自身 allow', configs[0].provider === 'spawn'
        && JSON.stringify(configs[0].toolFilter.allow) === '["switchboard_cli_run_cli_worker"]');
      check('CLI 两个工具齐全时自检健康', result.ok && result.roleCount === 2);
      // 在 apply 后才出现的可选 Jobs 服务也应被工具读取，而非注册时固定快照。
      const listeners = new Set();
      const starts = [], removed = [];
      let jobsAvailable = true;
      const jobs = {
        events: { subscribe(_filter, listener) { listeners.add(listener); return () => listeners.delete(listener); } },
        start(spec) {
          starts.push(spec);
          const hooks = spec.run({ append() {} });
          hooks.done.then(() => {
            for (const listener of listeners) listener({ type: 'settled', job: { id: 'cli-private-apply' } });
          });
          return 'cli-private-apply';
        },
        remove(id, owner) { removed.push({ id, owner }); },
      };
      const contextGet = ctx.get.bind(ctx);
      ctx.get = key => key === 'jobs' ? (jobsAvailable ? jobs : undefined) : contextGet(key);
      ctx.subprocess.spawn = () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {}, waitForExit: async () => true });
      const exec = { agent: { id: 'fixture-child', session: { header: { origin: 'subagent' } } } };
      // Jobs/owner 断言执行私有配置快照；公开入口的包裹身份由热重载集成段验证。
      const cliTool = boundCliTool;
      const cliResult = await cliTool.execute({ prompt: 'T' }, exec);
      check('apply 将 ctx 传给专属工具，运行时读取 Jobs 与正确 owner', starts.length === 1
        && starts[0].kind === 'cli' && starts[0].owner === 'fixture-child' && cliResult.outputFeedback === 'jobs');
      check('apply 路径不主动 remove，jobId 不进结果且无结算订阅', removed.length === 0
        && starts[0].owner === 'fixture-child' && listeners.size === 0 && !JSON.stringify(cliResult).includes('cli-private-apply'));
      jobsAvailable = false;
      const degraded = await cliTool.execute({ prompt: 'T' }, exec);
      check('apply 路径 Jobs 卸载后照常执行并报告降级', degraded.status === 'completed'
        && degraded.outputFeedback === 'unavailable' && starts.length === 1);
      check('generation ctx 的 safeSpawn 与 resolveExecutable 均可用', degraded.status === 'completed'
        && (await selftest.execute({})).executables.includes('C:/fake/node.exe'));
      ctx.subprocess.resolveExecutable = () => { throw new Error('fixture-runtime-resolution-failed'); };
      const fallback = await cliTool.execute({ prompt: 'T' }, exec);
      const fallbackHealth = await selftest.execute({});
      check('运行期解析失败即使裸命令启动成功，自检仍记录本次未解析', fallback.status === 'completed'
        && fallbackHealth.executables.includes('本次未解析可执行文件')
        && fallbackHealth.executables.includes('fixture-runtime-resolution-failed'));
      ctx.tools.get = (name, viewingScope) => name === 'switchboard_cli_run_cli_worker' ? undefined : originalGet(name, viewingScope);
      const absent = await selftest.execute({});
      check('CLI 工具后来缺失时自检失败且不计入角色数量', !absent.ok && absent.roleCount === 1);
      check('委派工具存在也如实报告专属工具缺失', absent.mounted.includes('专属 CLI 工具未注册'));
    } else {
      check(`${mode}：角色不可用时自检失败`, !result.ok && !result.mounted.includes('cli-worker=OK'));
      if (mode !== 'delegate-missing') {
        check(`${mode}：不挂载依赖失败 CLI 工具的 delegate`, !configs.some(c => c.toolName === 'delegate_to_cli_worker'));
        check(`${mode}：自检保留注册失败或未注册原因`, result.blocked.includes(mode === 'throw'
          ? 'fixture-cli-register-failed' : '专属 CLI 工具未注册'));
        check(`${mode}：失败不阻断无关内置角色`, result.roleCount === 1 && result.mounted.includes('independent=OK'));
      } else check('CLI 工具存在但委派工具缺失仍失败', ctx.tools.get('switchboard_cli_run_cli_worker', scope)
        && result.mounted.includes('工具未注册'));
    }
  }
}

section('契约模拟（真实 Config / 工具插件，start 为桩）：按已挂载清单生成出站权限');
{
  const { cliFieldsFor } = await import('../src/cli/drivers.js');
  const ctx = makeCtx({ scope: {} });
  const requests = [], validatedConfigs = [], events = new Map();
  const fixtureGet = ctx.get.bind(ctx);
  // 仅通过内置角色的路由预检，不调用模型；本节验证权限而非 LLM 线路。
  ctx.get = key => key === 'llm' ? { async resolveCallConfig(config) { return config; } } : fixtureGet(key);
  let guidance = '';
  ctx.on = (name, handler) => {
    if (!events.has(name)) events.set(name, []);
    events.get(name).push(handler);
    return () => {};
  };
  ctx.sessionProjections = { register() {} };
  ctx.subagents.resolveMaxDepth = depth => depth;
  const providers = new Map(['spawn', 'fork'].map(name => [name, { name, inheritsParentContext: false,
    capabilities: { depthLimit: true, agentOptions: true, persona: true, toolFilter: true } }]));
  ctx.subagents.getProvider = name => providers.get(name);
  // 不创建 spawn child；入站边界由真实 DSH 函数执行，不能让记录桩放过超界请求。
  ctx.subagents.start = async (_provider, request) => {
    resolveChildDepth(request.parent, request.maxDepth);
    requests.push(request);
    return { id: 'fixture-run', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose() {} };
  };
  ctx.systemPrompt.section = section => {
    if (section.name === 'agent-switchboard:roles') guidance = section.text;
    return () => {};
  };
  // 真实 Config 的 standard-schema 校验先物化输入；再执行真实工具插件的 apply。
  const scopePlugin = ctx.plugin;
  ctx.plugin = function (module, config) {
    if (!config) return scopePlugin.call(this, module, config);
    const validated = module.Config['~standard'].validate(config);
    if (validated.issues) throw new Error(JSON.stringify(validated.issues));
    validatedConfigs.push(validated.value);
    module.apply(this, validated.value);
    return { dispose() {} };
  };
  ctx.tools.register({ name: 'read' });
  ctx.tools.register({ name: 'workflow' });
  ctx.tools.register({ name: 'subagent' });
  const cli = { description: 'd', instructions: 'i', backend: 'cli', model: 'external', cliDriver: 'grok',
    cliCwd: 'C:/w', ...cliFieldsFor('grok', false) };
  apply(ctx, { mount: true, maxDepth: 1, provider: 'self', roles: [
    { ...cli, id: 'organizer', allowNestedDispatch: true },
    { ...cli, id: 'leaf' },
    { ...fixtureRole, id: 'builtin-leaf' },
    { ...fixtureRole, id: 'builtin-organizer', allowNestedDispatch: true },
  ] });
  await import('@deepseek-ai/dsh-tool-subagent');
  await new Promise(setImmediate);
  const scope = scopeOf(ctx);
  const parent = { id: 'fixture-parent', options: { provider: 'self', model: 'm', subagentDepth: 1 },
    session: { requestHeader: () => undefined, header: { origin: 'subagent' } } };
  check('真实 delegationDepthOf：旧 options.delegationDepth 夹具为 0', delegationDepthOf({
    options: { delegationDepth: 1 }, session: { header: { origin: 'subagent' } },
  }) === 0);
  check('真实 delegationDepthOf：修正的父代理夹具深度确为 1', delegationDepthOf(parent) === 1);
  check('真实 delegationDepthOf：session.header.delegationDepth 也读取为 1', delegationDepthOf({
    options: {}, session: { header: { delegationDepth: 1 } },
  }) === 1);
  const exec = { agent: parent, signal: new AbortController().signal };
  const organizer = ctx.tools.get('delegate_to_organizer', scope);
  await organizer.execute({ prompt: 'T', description: 'fixture' }, exec);
  const first = requests.at(-1);
  check('真实插件校验后：CLI true 能看到后挂载的全部受控 delegate',
    ['organizer', 'leaf', 'builtin_leaf', 'builtin_organizer'].every(id => first.toolFilter.allow.includes(`delegate_to_${id}`)));
  check('真实插件请求不开放 workflow、通用 subagent 和其他角色 CLI 工具',
    !first.toolFilter.allow.includes('workflow') && !first.toolFilter.allow.includes('subagent')
      && !first.toolFilter.allow.includes('switchboard_cli_run_leaf'));
  check('真实插件 persona 使用同一有效清单，保留预算提示', first.persona.includes('delegate_to_leaf')
    && first.persona.includes('剩余深度预算') && !first.persona.includes('不要调用其他角色的工具'));
  check('guidance 用实际挂载清单生成有效出站提示', guidance().includes('may delegate further')
    && guidance().includes('cannot delegate further'));
  const beforeLeaf = requests.length;
  let leafResult, leafError;
  try { leafResult = await ctx.tools.get('delegate_to_leaf', scope).execute({ prompt: 'T', description: 'fixture' }, exec); }
  catch (caught) { leafError = caught; }
  const leafRequest = requests.at(-1);
  check('真实插件叶子 CLI 入站使用插件上限 2，出站只有专属 CLI 工具', leafRequest.maxDepth === 2
    && JSON.stringify(leafRequest.toolFilter.allow) === '["switchboard_cli_run_leaf"]');
  check('真实插件父深度 1 调用叶子 CLI 成功，真实 DSH 解析 child 深度为 2',
    !leafError && requests.length === beforeLeaf + 1 && leafResult?.kind === 'foreground'
      && resolveChildDepth(parent, leafRequest.maxDepth) === 2, leafError?.message);
  check('真实 Config 中所有目标角色都使用插件上限 2', validatedConfigs.length === 4
    && validatedConfigs.every(config => config.maxDepth === 2));
  const toolModule = await import('@deepseek-ai/dsh-tool-subagent');
  for (const maxDepth of [0, 1, 3]) {
    const config = toolConfigFor({ id: `budget-${maxDepth}`, backend: 'cli', instructions: 'i',
      toolName: `delegate_to_budget_${maxDepth}`, allowNestedDispatch: false }, { maxDepth });
    const validated = toolModule.Config['~standard'].validate(config);
    if (validated.issues) throw new Error(JSON.stringify(validated.issues));
    toolModule.apply(ctx, validated.value);
    for (let parentDepth = 0; parentDepth <= 1 + maxDepth; parentDepth++) {
      const depthParent = { ...parent, options: { ...parent.options, subagentDepth: parentDepth } };
      const before = requests.length;
      let result, error;
      try { result = await ctx.tools.get(config.toolName, scope).execute({ prompt: 'T', description: 'boundary' }, { ...exec, agent: depthParent }); }
      catch (caught) { error = caught; }
      const allowed = parentDepth <= maxDepth;
      check(`真实插件预算 ${maxDepth}：父深度 ${parentDepth} → child ${parentDepth + 1} ${allowed ? '成功' : '超界拒绝'}`,
        delegationDepthOf(depthParent) === parentDepth && (allowed
          ? !error && result?.kind === 'foreground' && requests.length === before + 1 && requests.at(-1).maxDepth === 1 + maxDepth
          : error?.name === 'SubagentDepthError' && error.attemptedDepth === parentDepth + 1
            && error.maxDepth === 1 + maxDepth && requests.length === before));
    }
  }

  // 把真实工具插件生成的请求交给真实 child composition；不使用假 tools.restrict。
  section('真实 Cordis + ToolRuntime + applyChildComposition：动态可见性与隔离');
  const runtimeCtx = new Context();
  runtimeCtx.provide('systemPrompt', { tools() {}, context() {}, section() {},
    getContextOrder() { return 0; }, getSectionOrder() { return 0; } });
  new ToolRuntime(runtimeCtx);
  const register = (name, target = runtimeCtx) => target.tools.register({ name,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] }, execute: async () => name });
  for (const name of ctx.tools.schemas(scope).map(tool => tool.name)) register(name);
  register('write');
  register('delegate_to_unmanaged');
  const compose = (toolFilter) => {
    const child = {};
    const childCtx = createScope(runtimeCtx, child).ctx;
    applyChildComposition(childCtx, { ctx: runtimeCtx }, { toolFilter });
    return { child, childCtx, names: () => runtimeCtx.tools.schemas(child).map(tool => tool.name) };
  };
  for (const id of ['builtin-leaf', 'builtin-organizer']) {
    await ctx.tools.get(`delegate_to_${id.replace(/-/g, '_')}`, scope).execute({ prompt: 'T', description: 'runtime' }, exec);
    const request = requests.at(-1);
    const child = compose(request.toolFilter);
    check(`${id} 真实运行时：普通 read 工具仍可见`, child.names().includes('read'));
    check(`${id} 真实运行时：看不到其他角色的全部底层 CLI 工具`,
      !child.names().some(name => name.startsWith('switchboard_cli_run_')));
    check(`${id} 真实运行时：workflow 与通用 subagent 被拒绝`,
      !child.names().includes('workflow') && !child.names().includes('subagent'));
    check(`${id} 真实运行时：受控委派符合开关`,
      ['delegate_to_leaf', 'delegate_to_organizer'].every(name => child.names().includes(name) === (id === 'builtin-organizer')));
    const late = `ordinary_late_${id.replace(/-/g, '_')}`;
    register(late); // 采集与 child 创建之后注册，判别固定 allow 回归。
    check(`${id} 真实运行时：既有 child 的后注册普通工具不因白名单冻结而丢失`, child.names().includes(late));
    ctx.tools.register({ name: late });
    await ctx.tools.get(`delegate_to_${id.replace(/-/g, '_')}`, scope).execute({ prompt: 'T', description: 'fresh' }, exec);
    check(`${id} 真实运行时：后注册普通工具对新派发 child 可见`, compose(requests.at(-1).toolFilter).names().includes(late));
  }
  const names = runtimeCtx.tools.schemas().map(tool => tool.name);
  const readOnly = compose(toolConfigFor({ backend: 'spawn', readOnly: true, allowNestedDispatch: true }, {
    maxDepth: 1, availableToolNames: names, delegateToolNames: names.filter(name => name.startsWith('delegate_to_') && name !== 'delegate_to_unmanaged'),
  }).toolFilter);
  check('真实运行时：只读 deny 拒绝 write，保留 read 与受控 delegate',
    !readOnly.names().includes('write') && readOnly.names().includes('read') && readOnly.names().includes('delegate_to_leaf'));
  check('真实运行时：未纳入角色清单的 delegate_to_* 也被拒绝', !readOnly.names().includes('delegate_to_unmanaged'));
  for (const [tag, request] of [['leaf', leafRequest], ['organizer', first]]) {
    const child = compose(request.toolFilter);
    const expected = [`switchboard_cli_run_${tag}`, ...(tag === 'organizer'
      ? ['delegate_to_organizer', 'delegate_to_leaf', 'delegate_to_builtin_leaf', 'delegate_to_builtin_organizer'] : [])];
    check(`CLI ${tag} 真实运行时：仅自身 CLI 工具与允许的 delegates`,
      JSON.stringify(child.names().sort()) === JSON.stringify([...expected].sort()));
    check(`CLI ${tag} 真实运行时：拿不到其他角色 CLI 工具`,
      !child.names().includes(`switchboard_cli_run_${tag === 'leaf' ? 'organizer' : 'leaf'}`));
  }
  const empty = compose({ allow: [] });
  check('真实运行时：allow: [] 拒绝全部继承工具', empty.names().length === 0);
  register('child_owned', empty.childCtx);
  check('真实运行时：allow: [] 不屏蔽 child 自注册工具', empty.names().join(',') === 'child_owned');
  register('edit'); // 采集后新增危险名：记录 deny 可用名过滤的 fail-open 代价。
  check('真实运行时：采集后新增写工具缺失于只读 deny，确为 fail-open', readOnly.names().includes('edit'));
  const originalGet = ctx.tools.get.bind(ctx.tools);
  const originalSchemas = ctx.tools.schemas.bind(ctx.tools);
  ctx.tools.get = (name, viewingScope) => name.startsWith('delegate_to_') && name !== 'delegate_to_organizer'
    ? undefined : originalGet(name, viewingScope);
  ctx.tools.schemas = viewingScope => originalSchemas(viewingScope)
    .filter(tool => !tool.name.startsWith('delegate_to_') || tool.name === 'delegate_to_organizer');
  await organizer.execute({ prompt: 'T', description: 'fixture' }, exec);
  check('delegate 卸载后运行时清单同步移除，persona 同步移除',
    !requests.at(-1).toolFilter.allow.includes('delegate_to_leaf') && !requests.at(-1).persona.includes('delegate_to_leaf'));
  ctx.tools.get = (name, viewingScope) => name.startsWith('delegate_to_') ? undefined : originalGet(name, viewingScope);
  ctx.tools.schemas = viewingScope => originalSchemas(viewingScope).filter(tool => !tool.name.startsWith('delegate_to_'));
  await organizer.execute({ prompt: 'T', description: 'fixture' }, exec);
  for (const refresh of events.get('tools/change') ?? []) refresh();
  check('全部 delegate 卸载后 persona、guidance 不再宣称可继续派发',
    requests.at(-1).persona.includes('不可继续派发') && !guidance().includes('may delegate further'));
}

section('隔离 DSH_HOME：残留运行期限不影响配置加载或健康状态');
{
  const legacy = initialConfig([fixtureRole], { provider: 'self', volatile: { cliTimeoutSec: 'invalid-old-value' } });
  const path = configPathFor(fixtureHome);
  writeConfigFile(path, legacy);
  const before = readFileSync(path, 'utf8');
  const loaded = Config['~standard'].validate({ provider: 'self', volatile: { cliTimeoutSec: 'invalid-old-value' } });
  check('Cordis standard-schema 加载路径接受旧期限字段', !loaded.issues && loaded.value !== undefined);
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  const results = [];
  try {
    for (const mount of [false, true]) {
      const ctx = makeCtx();
      let resolved;
      try { resolved = Config({ provider: 'self', mount, volatile: { cliTimeoutSec: 'invalid-old-value' } }); }
      catch { /* 由下面断言报告兼容性回归 */ }
      check(`${mount ? 'preset' : '根'}：旧期限字段仍可穿过 Config`, resolved !== undefined);
      if (resolved) {
        apply(ctx, resolved);
        await import('@deepseek-ai/dsh-tool-subagent');
        await new Promise(setImmediate);
        results.push(await ctx.tools.get('switchboard_selftest').execute({}));
      }
    }
    // 单独覆盖仅文件残留的路径，不让 Cordis 原值掩盖文件诊断遗漏。
    const ctx = makeCtx();
    apply(ctx, Config({ provider: 'self' }));
    results.push(await ctx.tools.get('switchboard_selftest').execute({}));
  } finally { console.error = originalError; }
  check('根与 preset 兼容加载成功且自检健康', results.length === 3 && results.every(r => r.ok));
  check('各作用域自检可见弃用诊断（含仅文件残留）', results.length === 3
    && results.every(r => r.roleConfigStatus.includes('cliTimeoutSec 已废弃并忽略')));
  check('弃用日志只打印一次', logs.filter(line => line.includes('cliTimeoutSec 已废弃并忽略')).length === 1);
  check('加载不改写残留旧配置文件', readFileSync(path, 'utf8') === before);
  check('残留旧字段不造成配置错误', results.length === 3 && results.every(r => r.configErrors === '' && r.fatal === ''));
}

section('统一包裹路由：根配置桥接、preset 优先级、清空与非法强度');
{
  const { cliFieldsFor } = await import('../src/cli/drivers.js');
  const role = { id: 'cli-route', description: 'd', instructions: 'i', backend: 'cli',
    model: 'external', effort: 'low', cliCwd: 'C:/w', cliDriver: 'codex', ...cliFieldsFor('codex', false) };
  const path = configPathFor(fixtureHome);
  const originalFile = initialConfig([role], { provider: 'self', cwd: 'C:/preserved', maxDepth: 7,
    volatile: { cliTimeoutSec: 'legacy' } });
  originalFile.formatVersion = 9;
  originalFile.custom = { keep: true };
  writeConfigFile(path, originalFile);
  const mount = async (config) => {
    const ctx = makeCtx();
    const configs = [];
    const plugin = ctx.plugin;
    ctx.plugin = function (module, cfg) { if (cfg) configs.push(cfg); return plugin.call(this, module, cfg); };
    apply(ctx, Config({ mount: true, provider: 'self', ...config }));
    await import('@deepseek-ai/dsh-tool-subagent');
    await new Promise(setImmediate);
    return { configs, result: await ctx.tools.get('switchboard_selftest').execute({}), ctx };
  };
  const rootRoute = { wrapperProvider: ' root-route ', wrapperModel: 'root-model', wrapperEffort: 'high' };
  apply(makeCtx(), Config({ volatile: rootRoute }));
  let file = JSON.parse(readFileSync(path, 'utf8'));
  check('根实例无 roles 也同步统一三字段，并保留现有角色与兼容字段',
    file.roles[0].id === role.id && file.volatile.wrapperProvider === 'root-route' &&
    file.volatile.wrapperModel === 'root-model' && file.volatile.wrapperEffort === 'high' && file.volatile.cliTimeoutSec === 'legacy');
  check('包裹同步完整保留 roles/provider/cwd/maxDepth/formatVersion 与其它顶层字段',
    ['roles', 'provider', 'cwd', 'maxDepth', 'formatVersion', 'custom'].every(key =>
      JSON.stringify(file[key]) === JSON.stringify(originalFile[key])));
  const explicitlyEmpty = await mount({ roles: [] });
  check('R2：非空文件 + preset 显式 [] 不挂载旧角色，且保持文件角色',
    explicitlyEmpty.configs.length === 0 && explicitlyEmpty.result.roleCount === 0 && explicitlyEmpty.result.ok &&
    JSON.parse(readFileSync(path, 'utf8')).roles[0].id === role.id);
  for (const [label, configFor] of [
    ['Config 解引用', (mount) => Config({ mount, roles: null, volatile: { wrapperModel: 'must-not-write' } })],
    ['普通对象', (mount) => ({ mount, roles: null, volatile: { wrapperModel: 'must-not-write' } })],
  ]) {
    for (const mountHere of [false, true]) {
      const bytes = readFileSync(path);
      const ctx = makeCtx();
      apply(ctx, configFor(mountHere));
      await new Promise(setImmediate);
      const result = await ctx.tools.get('switchboard_selftest').execute({});
      check(`M2：${label} roles:null ${mountHere ? 'preset' : '根'} 原文件字节不变`, readFileSync(path).equals(bytes));
      check(`M2：${label} roles:null ${mountHere ? 'preset' : '根'} 自检不健康且明确诊断`,
        !result.ok && result.configErrors.includes('roles 必须是数组') && result.roleCount === 0);
    }
  }
  for (const bad of ['not-array', 17, {}]) {
    for (const ref of [false, true]) {
      const bytes = readFileSync(path);
      const ctx = makeCtx();
      apply(ctx, { roles: ref ? { get: () => bad } : bad, volatile: { wrapperModel: 'must-not-write' } });
      const result = await ctx.tools.get('switchboard_selftest').execute({});
      check(`M2：非法 ${JSON.stringify(bad)} ${ref ? '引用' : '普通值'} 拒绝写盘并进入健康门禁`,
        !result.ok && result.configErrors.includes('roles 必须是数组') && readFileSync(path).equals(bytes));
    }
  }
  const updateCtx = makeCtx();
  let update;
  updateCtx.on = (_event, callback) => { update = callback; return () => {}; };
  updateCtx.effect = callback => callback();
  const beforeInvalidUpdate = readFileSync(path);
  apply(updateCtx, Config({ roles: null }));
  let updateThrew = false;
  try { update(Config({ roles: null, volatile: { wrapperModel: 'must-not-write' } }), false, () => {}); }
  catch { updateThrew = true; }
  check('M2：非法 roles 就地更新仍不写盘、不伪健康', !updateThrew && readFileSync(path).equals(beforeInvalidUpdate) &&
    !(await updateCtx.tools.get('switchboard_selftest').execute({})).ok);
  update(Config({ roles: [role], volatile: rootRoute }), false, () => {});
  check('M2：非法 roles 可经合法数组就地修复，清除诊断并恢复健康',
    (await updateCtx.tools.get('switchboard_selftest').execute({})).ok);
  const beforeOmittedRoles = JSON.parse(readFileSync(path, 'utf8'));
  apply(makeCtx(), Config({ provider: 'self' }));
  const afterOmittedRoles = JSON.parse(readFileSync(path, 'utf8'));
  check('未提供 roles 不改动文件中的角色与顶层字段',
    JSON.stringify(afterOmittedRoles.roles) === JSON.stringify(beforeOmittedRoles.roles) &&
      afterOmittedRoles.formatVersion === beforeOmittedRoles.formatVersion &&
      JSON.stringify(afterOmittedRoles.custom) === JSON.stringify(beforeOmittedRoles.custom));
  apply(makeCtx(), Config({ provider: 'self', roles: [] }));
  file = JSON.parse(readFileSync(path, 'utf8'));
  check('显式清空 roles 真正清空文件角色', file.roles.length === 0);
  check('角色写入完成后 volatile 兼容字段仍保留', file.volatile.cliTimeoutSec === 'legacy');
  const cleared = await mount({});
  check('显式清空后新 preset 不再挂载旧角色', cleared.configs.length === 0 && cleared.result.roleCount === 0,
    JSON.stringify(cleared.result));
  apply(makeCtx(), Config({ provider: 'self', roles: [role] }));
  file = JSON.parse(readFileSync(path, 'utf8'));
  const beforeContinuous = JSON.stringify(file);
  apply(makeCtx(), Config({ volatile: { wrapperModel: 'continuous-model', wrapperEffort: 'medium' } }));
  file = JSON.parse(readFileSync(path, 'utf8'));
  check('角色同步与包裹路由连续执行互不破坏',
    file.roles[0].id === role.id && file.custom.keep === true && file.formatVersion === 9 &&
      file.volatile.wrapperModel === 'continuous-model' && file.volatile.wrapperEffort === 'medium' &&
      JSON.parse(beforeContinuous).roles[0].id === file.roles[0].id);
  apply(makeCtx(), Config({ provider: 'self', roles: [role], volatile: rootRoute }));
  file = JSON.parse(readFileSync(path, 'utf8'));
  const scoped = { ...role, id: 'preset-role', model: 'preset-external' };
  let outcome = await mount({ roles: [scoped], volatile: { wrapperProvider: 'preset-route', wrapperModel: 'preset-model', wrapperEffort: 'low' } });
  check('preset 角色优先，但统一包裹路由取根文件而非 preset', outcome.configs.length === 1 &&
    outcome.configs[0].toolName === 'delegate_to_preset_role' &&
    JSON.stringify(outcome.configs[0].agentOptions) === JSON.stringify({ provider: 'root-route', model: 'root-model', reasoningEffort: 'high' }));
  apply(makeCtx(), Config({ provider: 'self', roles: [role] }));
  file = JSON.parse(readFileSync(path, 'utf8'));
  check('根清空统一路由后文件保存三个空值，避免回落旧 preset',
    ['wrapperProvider', 'wrapperModel', 'wrapperEffort'].every(key => file.volatile[key] === ''));
  outcome = await mount({ volatile: { wrapperProvider: 'preset-route' } });
  check('根三个空值优先：CLI 不设置 agentOptions', outcome.configs.length === 1 && !('agentOptions' in outcome.configs[0]));
  outcome = await mount({ volatile: { wrapperEffort: 'invalid' } });
  check('有效根空路由覆盖非法 preset，仍健康挂载', outcome.configs.length === 1 && outcome.result.ok &&
    !('agentOptions' in outcome.configs[0]));
  writeConfigFile(path, initialConfig([role], { provider: 'self', volatile: { wrapperModel: 'partial-root' } }));
  outcome = await mount({ volatile: { wrapperProvider: 'preset-route', wrapperEffort: 'invalid' } });
  check('部分文件路由仍对象级优先，不补入 preset provider/非法 effort', outcome.configs.length === 1 && outcome.result.ok &&
    JSON.stringify(outcome.configs[0].agentOptions) === JSON.stringify({ model: 'partial-root' }));
  writeFileSync(path, '{broken');
  outcome = await mount({ roles: [role], volatile: { wrapperModel: 'local-fallback' } });
  check('坏文件但本地角色非空：回落本地角色与路由并正常挂载', outcome.configs.length === 1 && outcome.result.ok &&
    JSON.stringify(outcome.configs[0].agentOptions) === JSON.stringify({ model: 'local-fallback' }));
  writeConfigFile(path, initialConfig([role], { provider: 'self' }));
  outcome = await mount({ volatile: { wrapperModel: 'fallback-model' } });
  check('文件尚无统一路由时回落当前实例，仅设置非空模型',
    JSON.stringify(outcome.configs[0]?.agentOptions) === JSON.stringify({ model: 'fallback-model' }));
  for (const effort of ['', ' ', 'low', 'medium', 'high', 'xhigh', 'max']) {
    outcome = await mount({ volatile: { wrapperEffort: effort } });
    check(`统一强度 ${JSON.stringify(effort)} 合法且能挂载`, outcome.configs.length === 1 && outcome.result.ok);
  }
  const before = readFileSync(path, 'utf8');
  const invalidRoot = makeCtx();
  apply(invalidRoot, Config({ volatile: { wrapperEffort: 'invalid' } }));
  const rootHealth = await invalidRoot.tools.get('switchboard_selftest').execute({});
  check('根非法 wrapperEffort 明确报错且不写文件', !rootHealth.ok && /wrapperEffort.*非法/.test(rootHealth.configErrors) && readFileSync(path, 'utf8') === before);
  outcome = await mount({ volatile: { wrapperEffort: 'invalid' } });
  check('preset 非法 wrapperEffort 阻止全部角色与 CLI 工具挂载', outcome.configs.length === 0 &&
    !outcome.ctx.registered.some(name => name.startsWith('switchboard_cli_run_')) && /wrapperEffort.*非法/.test(outcome.result.configErrors));
  writeConfigFile(path, initialConfig([role], { volatile: { wrapperEffort: 'invalid' } }));
  outcome = await mount({});
  check('桥接文件非法 wrapperEffort 也阻止挂载', outcome.configs.length === 0 && /wrapperEffort.*非法/.test(outcome.result.configErrors));
  writeConfigFile(path, initialConfig([role], { volatile: { wrapperEffort: 123 } }));
  outcome = await mount({});
  check('桥接文件非字符串 wrapperEffort 明确报错并阻止挂载',
    outcome.configs.length === 0 && outcome.result.configErrors.includes('wrapperEffort 必须是字符串'));
  rmSync(path);
  const pendingCtx = makeCtx();
  let pendingUpdate;
  pendingCtx.on = (_event, listener) => { pendingUpdate = listener; return () => {}; };
  pendingCtx.effect = execute => execute();
  apply(pendingCtx, Config({ volatile: { wrapperProvider: 'only-route' } }));
  const bridge = readConfigFile(path);
  check('R1：首次仅保存包裹设置创建合法空角色桥接文件', bridge.ok && !bridge.missing &&
    bridge.value.formatVersion === 1 && JSON.stringify(bridge.value.roles) === '[]' &&
    JSON.stringify(bridge.value.volatile) === JSON.stringify({ wrapperProvider: 'only-route', wrapperModel: '', wrapperEffort: '' }));
  const bridgeHealth = await pendingCtx.tools.get('switchboard_selftest').execute({});
  check('R1：创建成功清除 pending 且诊断说明桥接已建立', bridgeHealth.ok &&
    bridgeHealth.roleConfigStatus.includes('已创建空角色文件以桥接根包裹路由') &&
    !bridgeHealth.roleConfigStatus.includes('根设置尚未桥接'));
  outcome = await mount({ roles: [role], volatile: { wrapperProvider: 'preset-route', wrapperModel: 'preset-model', wrapperEffort: 'low' } });
  check('R1：空角色桥接文件路由覆盖 preset 自身整套 wrapper', outcome.configs.length === 1 && outcome.result.ok &&
    JSON.stringify(outcome.configs[0].agentOptions) === JSON.stringify({ provider: 'only-route' }));
  pendingUpdate(Config({ volatile: {} }), false, () => {});
  file = JSON.parse(readFileSync(path, 'utf8'));
  check('R1：桥接后就地清空保留空 roles 并写三空值', JSON.stringify(file.roles) === '[]' &&
    ['wrapperProvider', 'wrapperModel', 'wrapperEffort'].every(key => file.volatile[key] === ''));

  writeConfigFile(path, initialConfig([], { formatVersion: 9, custom: { keep: true }, volatile: { other: 'keep' } }));
  apply(makeCtx(), Config({ volatile: rootRoute }));
  file = JSON.parse(readFileSync(path, 'utf8'));
  check('R1：已有空 roles 更新 wrapper 且保留其它字段与版本', JSON.stringify(file.roles) === '[]' &&
    file.formatVersion === 9 && file.custom.keep === true && file.volatile.other === 'keep' &&
    file.volatile.wrapperProvider === 'root-route' && file.volatile.wrapperModel === 'root-model' && file.volatile.wrapperEffort === 'high');

  rmSync(path);
  const freshCtx = makeCtx();
  apply(freshCtx, Config({ volatile: {} }));
  const freshHealth = await freshCtx.tools.get('switchboard_selftest').execute({});
  check('R1：首次无 wrapper 不建桥接文件且健康', !existsSync(path) && freshHealth.ok && freshHealth.configErrors === '' &&
    !freshHealth.roleConfigStatus.includes('根设置尚未桥接'));
  outcome = await mount({ roles: [role], volatile: { wrapperModel: 'fresh-preset' } });
  check('R1：首次无根 wrapper 时 preset 仍取自身路由', !existsSync(path) && outcome.result.ok &&
    JSON.stringify(outcome.configs[0]?.agentOptions) === JSON.stringify({ model: 'fresh-preset' }));

  const failedCtx = makeCtx();
  const originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (target, ...args) => {
      if (String(target).startsWith(`${path}.`)) throw Object.assign(new Error('fixture-bridge-EACCES'), { code: 'EACCES' });
      return originalWrite(target, ...args);
    };
    syncBuiltinESMExports();
    apply(failedCtx, Config({ volatile: rootRoute }));
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
  }
  const failedHealth = await failedCtx.tools.get('switchboard_selftest').execute({});
  check('R1：创建失败不健康并报告同步错误与 pending', !existsSync(path) && !failedHealth.ok &&
    failedHealth.configErrors.includes('包裹路由同步失败：fixture-bridge-EACCES') && failedHealth.roleConfigStatus.includes('根设置尚未桥接'));
  const pendingOnly = await selftestTool(makeCtx(), { mountHere: false, configuredRoles: [], configuredRoleCount: 0,
    mounts: [], configErrors: [], providers: [], executables: [], blocked: [], wrapperSyncPending: true }).execute({});
  check('R1：pending 独立进入健康门禁，不依赖 configErrors', !pendingOnly.ok && pendingOnly.configErrors === '');
  const missingInvalid = makeCtx();
  apply(missingInvalid, Config({ volatile: { wrapperEffort: 'invalid' } }));
  const invalidHealth = await missingInvalid.tools.get('switchboard_selftest').execute({});
  check('R1：缺文件根非法 wrapper 不建文件且配置错误不健康', !existsSync(path) && !invalidHealth.ok &&
    /wrapperEffort.*非法/.test(invalidHealth.configErrors));
  apply(makeCtx(), Config({ provider: 'self', roles: [role], volatile: { wrapperProvider: 'only-route' } }));
  file = JSON.parse(readFileSync(path, 'utf8'));
  check('后续写入角色一并同步此前保留的根包裹设置', file.roles[0].id === role.id &&
    file.volatile.wrapperProvider === 'only-route');
}

section('真实 Cordis 更新瀑布：volatile 不重挂载时仍同步根包裹路由');
{
  const path = configPathFor(fixtureHome);
  writeConfigFile(path, initialConfig([fixtureRole], { provider: 'self' }));
  const root = new Context();
  let applies = 0;
  let continued = 0;
  let ctx;
  let currentHome = fixtureHome;
  const restartHome = mkdtempSync(join(tmpdir(), 'switchboard-restart-'));
  const fiber = root.plugin({
    Config,
    apply(actual, config) {
      applies++;
      ctx = makeCtx();
      ctx.get = key => key === 'profileContext' ? { home: currentHome } : undefined;
      ctx.fiber = actual.fiber;
      ctx.on = actual.on.bind(actual);
      ctx.effect = actual.effect.bind(actual);
      apply(ctx, config);
      // 模拟 Loader 的 volatile 就地更新：下游不调用 next，不重新 apply。
      actual.effect(() => actual.on('internal/update', () => { continued++; }));
    },
  }, { provider: 'self', volatile: { wrapperEffort: 'invalid' } });
  try {
    await fiber.await();
    const initialHealth = await ctx.tools.get('switchboard_selftest').execute({});
    check('初始非法路由仍注册一个插件更新钩子并可诊断', !initialHealth.ok &&
      /wrapperEffort.*非法/.test(initialHealth.configErrors) && fiber._hooks['internal/update'].length === 1 && root.events._hooks['internal/update'].length === 2);
    fiber.update({ provider: 'self', volatile: { wrapperModel: 'live-model', wrapperEffort: 'high' } });
    await new Promise(setImmediate);
    let file = JSON.parse(readFileSync(path, 'utf8'));
    check('真实 update 钩子同步新模型/强度并继续瀑布，不依赖重挂载', applies === 1 && continued === 1 &&
      file.volatile?.wrapperModel === 'live-model' && file.volatile?.wrapperEffort === 'high');
    check('初始非法改合法后不重挂载也同步且清除错误', applies === 1 &&
      (await ctx.tools.get('switchboard_selftest').execute({})).ok);
    fiber.update({ provider: 'self', volatile: {} });
    await new Promise(setImmediate);
    file = JSON.parse(readFileSync(path, 'utf8'));
    check('真实 update 清空统一路由，仍不重挂载', applies === 1 && continued === 2 &&
      ['wrapperProvider', 'wrapperModel', 'wrapperEffort'].every(key => file.volatile?.[key] === ''));
    const before = readFileSync(path, 'utf8');
    fiber.update({ provider: 'self', volatile: { wrapperEffort: 'invalid' } });
    await new Promise(setImmediate);
    const health = await ctx.tools.get('switchboard_selftest').execute({});
    check('就地更新非法强度进入诊断且不覆盖有效文件', !health.ok && /wrapperEffort.*非法/.test(health.configErrors) &&
      readFileSync(path, 'utf8') === before && continued === 3);
    fiber.update({ provider: 'self', volatile: { wrapperEffort: 'low' } });
    await new Promise(setImmediate);
    const recovered = await ctx.tools.get('switchboard_selftest').execute({});
    check('就地修正强度后清除本次路由错误并恢复同步', recovered.ok &&
      JSON.parse(readFileSync(path, 'utf8')).volatile.wrapperEffort === 'low');
    const oldCtx = ctx;
    const oldBytes = readFileSync(path, 'utf8');
    currentHome = restartHome;
    writeConfigFile(configPathFor(restartHome), initialConfig([fixtureRole], { provider: 'self' }));
    await fiber.restart();
    await fiber.restart();
    check('两次 restart 仅保留一个插件钩子和一个 Loader 钩子', applies === 3 &&
      fiber._hooks['internal/update'].length === 1 && root.events._hooks['internal/update'].length === 2);
    fiber.update({ provider: 'self', volatile: { wrapperModel: 'new-path', wrapperEffort: 'high' } });
    await new Promise(setImmediate);
    check('restart 后只写新路径，旧闭包不再写原路径', readFileSync(path, 'utf8') === oldBytes &&
      JSON.parse(readFileSync(configPathFor(restartHome), 'utf8')).volatile?.wrapperModel === 'new-path');
    fiber.update({ provider: 'self', volatile: { wrapperEffort: 'invalid' } });
    await new Promise(setImmediate);
    check('restart 后旧诊断闭包不再受更新影响', (await oldCtx.tools.get('switchboard_selftest').execute({})).ok &&
      !(await ctx.tools.get('switchboard_selftest').execute({})).ok);
  } finally {
    await fiber.dispose();
    rmSync(restartHome, { recursive: true, force: true });
  }
  check('卸载后 internal/update 钩子全部释放', fiber._hooks['internal/update'].length === 0 && root.events._hooks['internal/update'].length === 1);
}

section('包裹路由同步失败：当前错误去重、日志与修复恢复');
{
  const path = configPathFor(fixtureHome);
  writeConfigFile(path, initialConfig([fixtureRole], { provider: 'self' }));
  const root = new Context();
  let ctx;
  const fiber = root.plugin({
    Config,
    apply(actual, config) {
      ctx = makeCtx();
      ctx.fiber = actual.fiber;
      ctx.on = actual.on.bind(actual);
      ctx.effect = actual.effect.bind(actual);
      apply(ctx, config);
      actual.effect(() => actual.on('internal/update', () => {}));
    },
  }, { provider: 'self', volatile: { wrapperModel: 'before-failure' } });
  const logs = [];
  const originalError = console.error;
  try {
    await fiber.await();
    console.error = (...args) => logs.push(args.join(' '));
    // 用目录占据目标文件，稳定触发真实读写错误，避免平台权限差异。
    rmSync(path);
    mkdirSync(path);
    const update = async () => {
      fiber.update({ provider: 'self', volatile: { wrapperModel: 'after-repair' } });
      await new Promise(setImmediate);
      return ctx.tools.get('switchboard_selftest').execute({});
    };
    const failed = await update();
    const repeated = await update();
    check('同步失败进入健康诊断，重复失败仅一个当前同步错误', !failed.ok && !repeated.ok &&
      repeated.configErrors.split('\n').filter(line => line.startsWith('包裹路由同步失败')).length === 1);
    check('相同同步失败主动记日志但不重复追加', logs.filter(line => line.includes('包裹路由同步失败')).length === 1);
    rmSync(path, { recursive: true });
    writeConfigFile(path, initialConfig([fixtureRole], { provider: 'self' }));
    const recovered = await update();
    check('同步失败修复后当前错误清除且健康恢复', recovered.ok && recovered.configErrors === '' &&
      JSON.parse(readFileSync(path, 'utf8')).volatile.wrapperModel === 'after-repair');
    const rename = fs.renameSync;
    try {
      fs.renameSync = (source, target) => {
        if (target === path) throw Object.assign(new Error('fixture-wrapper-write'), { code: 'EIO' });
        return rename(source, target);
      };
      syncBuiltinESMExports();
      for (let i = 0; i < 2; i++) {
        fiber.update({ provider: 'self', volatile: { wrapperModel: 'write-recovered' } });
        await new Promise(setImmediate);
      }
      const failedWrite = await ctx.tools.get('switchboard_selftest').execute({});
      check('原子写失败重复发生仍仅一个当前同步错误并主动日志', !failedWrite.ok &&
        failedWrite.configErrors.split('\n').filter(line => line.startsWith('包裹路由同步失败')).length === 1 &&
        logs.filter(line => line.includes('包裹路由同步失败：fixture-wrapper-write')).length === 1 &&
        JSON.parse(readFileSync(path, 'utf8')).volatile.wrapperModel === 'after-repair');
    } finally {
      fs.renameSync = rename;
      syncBuiltinESMExports();
    }
    fiber.update({ provider: 'self', volatile: { wrapperModel: 'write-recovered' } });
    await new Promise(setImmediate);
    const writeRecovered = await ctx.tools.get('switchboard_selftest').execute({});
    check('原子写失败解除后同步成功清除旧错误', writeRecovered.ok && writeRecovered.configErrors === '' &&
      JSON.parse(readFileSync(path, 'utf8')).volatile.wrapperModel === 'write-recovered');
  } finally {
    console.error = originalError;
    await fiber.dispose();
  }
}

section('残留角色包裹路由：兼容加载与模块级一次性诊断');
{
  const legacyRole = { ...fixtureRole, agentProvider: { obsolete: true }, agentModel: 123 };
  const legacy = initialConfig([legacyRole], { provider: 'self' });
  const path = configPathFor(fixtureHome);
  writeConfigFile(path, legacy);
  const before = readFileSync(path, 'utf8');
  const loaded = Config['~standard'].validate({ provider: 'self', roles: [legacyRole] });
  check('Config standard-schema 接受任意类型的残留 agentProvider/agentModel', !loaded.issues && loaded.value !== undefined);
  const logs = [];
  const originalError = console.error;
  const results = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    for (const config of [{}, { mount: true, roles: [legacyRole] }, { mount: true }]) {
      const ctx = makeCtx();
      apply(ctx, Config({ provider: 'self', ...config }));
      await import('@deepseek-ai/dsh-tool-subagent');
      await new Promise(setImmediate);
      results.push(await ctx.tools.get('switchboard_selftest').execute({}));
    }
  } finally { console.error = originalError; }
  check('根、preset 与仅文件残留均健康且自检含弃用诊断', results.length === 3 && results.every(r =>
    r.ok && r.roleConfigStatus.includes('角色 agentProvider / agentModel 已废弃并忽略')));
  check('角色包裹字段弃用日志每次模块加载只打印一次',
    logs.filter(line => line.includes('角色 agentProvider / agentModel 已废弃并忽略')).length === 1);
  check('残留角色字段加载不改写原文件', readFileSync(path, 'utf8') === before);
  writeConfigFile(path, { ...legacy, volatile: { cliTimeoutSec: 'legacy' } });
  const ctx = makeCtx();
  apply(ctx, Config({ provider: 'self' }));
  const combined = await ctx.tools.get('switchboard_selftest').execute({});
  check('两种旧配置同时残留时弃用诊断互不覆盖', combined.roleConfigStatus.includes('cliTimeoutSec 已废弃并忽略') &&
    combined.roleConfigStatus.includes('角色 agentProvider / agentModel 已废弃并忽略'));
}

section('根同步：先注册的就地更新钩子消费瀑布');
{
  const root = new Context();
  const path = configPathFor(fixtureHome);
  const role = { ...fixtureRole, model: 'root-old' };
  writeConfigFile(path, initialConfig([role], { provider: 'self' }));
  let ctx, consumed = 0, applies = 0, writes = 0, notices = 0;
  const rename = fs.renameSync;
  const fiber = root.plugin({ Config, apply(actual, config) {
    applies++;
    // 模拟 Loader 先注册，消费 volatile 更新而不调用 next。
    actual.effect(() => actual.on('internal/update', () => { consumed++; }));
    ctx = makeCtx();
    ctx.fiber = actual.fiber;
    ctx.on = actual.on.bind(actual);
    ctx.effect = actual.effect.bind(actual);
    ctx.emit = actual.emit.bind(actual);
    apply(ctx, config);
  } }, { provider: 'self', roles: [role] });
  root.on('agent-switchboard/config-changed', () => { notices++; });
  try {
    await fiber.await();
    fs.renameSync = (source, target) => {
      if (target === path) writes++;
      return rename(source, target);
    };
    syncBuiltinESMExports();
    const save = model => fiber.update({ provider: 'self', roles: [{ ...role, model }] });
    check('B01：事件前仍为旧模型且未写入', JSON.parse(readFileSync(path)).roles[0].model === 'root-old' && writes === 0);
    save('root-new');
    check('B02：根保存事件返回前文件立即写入新模型', JSON.parse(readFileSync(path)).roles[0].model === 'root-new' && writes === 1);
    check('B03：同步先于消费钩子且继续瀑布，无重新 apply', consumed === 1 && applies === 1 && notices === 2);
    save('root-new');
    check('B04：相同值保存不原子重写', writes === 1);
    save('root-latest');
    check('B05：连续保存用当次配置而非闭包旧值', JSON.parse(readFileSync(path)).roles[0].model === 'root-latest' && writes === 2);
    fs.renameSync = (source, target) => {
      if (target === path) throw new Error('fixture-root-sync-failure');
      return rename(source, target);
    };
    syncBuiltinESMExports();
    save('root-failed');
    const health = await ctx.tools.get('switchboard_selftest').execute({});
    check('B06：角色同步失败自检不健康并显示错误', !health.ok && health.configErrors.includes('fixture-root-sync-failure') && health.roleConfigStatus.includes('同步失败'));
    check('B07：失败保留旧文件且不广播成功', JSON.parse(readFileSync(path)).roles[0].model === 'root-latest' && notices === 4);
    fs.renameSync = rename;
    syncBuiltinESMExports();
    save('root-recovered');
    check('B08：再次保存修复同步错误恢复健康', JSON.parse(readFileSync(path)).roles[0].model === 'root-recovered' && (await ctx.tools.get('switchboard_selftest').execute({})).ok);
    await fiber.restart();
    check('B09：重挂不积累更新钩子', fiber._hooks['internal/update'].length === 1 && root.events._hooks['internal/update'].length === 2);
    const beforeRestartSave = notices;
    save('root-after-restart');
    check('B11：重挂后的全局监听仅广播一次', notices === beforeRestartSave + 1 && JSON.parse(readFileSync(path)).roles[0].model === 'root-after-restart');
    const foreign = root.plugin({ Config, apply(actual) {
      actual.effect(() => actual.on('internal/update', () => {}));
    } }, {});
    await foreign.await();
    const ownBytes = readFileSync(path);
    foreign.update({ roles: [{ ...role, model: 'foreign-model' }] });
    check('B12：全局前置监听拒绝其它 Fiber 的配置事件', readFileSync(path).equals(ownBytes) && notices === beforeRestartSave + 1);
    await foreign.dispose();
    const emit = ctx.emit;
    const beforeEventConsumed = consumed;
    ctx.emit = () => { throw new Error('fixture-root-event-failure'); };
    save('root-event-failed');
    const eventHealth = await ctx.tools.get('switchboard_selftest').execute({});
    check('B17：同步链意外异常进入可见诊断且继续更新瀑布', !eventHealth.ok && eventHealth.configErrors.includes('根配置同步异常：fixture-root-event-failure') && consumed === beforeEventConsumed + 1);
    ctx.emit = emit;
    save('root-event-recovered');
    check('B18：同步链异常恢复后清除当前错误', (await ctx.tools.get('switchboard_selftest').execute({})).ok);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
    await fiber.dispose();
  }
  check('B10：卸载释放全部根更新钩子', fiber._hooks['internal/update'].length === 0 && root.events._hooks['internal/update'].length === 1);
}

section('热重载：真实 Cordis 跨 scope 广播、代际回滚与在途保护（preset 只 apply 一次）');
{
  const { cliFieldsFor } = await import('../src/cli/drivers.js');
  const home = mkdtempSync(join(tmpdir(), 'switchboard-hot-reload-'));
  const path = configPathFor(home);
  const root = new Context();
  const sections = new Map();
  const generations = new Set();
  const requests = [], runs = [], pendingJobs = [];
  const rapidGuidance = [];
  let recordRapid = false;
  let preflight;
  let holdRun = false;
  let missingProvider = false;
  let rootApplies = 0, presetApplies = 0, broadcasts = 0, guidanceRegisters = 0;
  root.provide('profileContext', { home, dir: home });
  root.provide('systemPrompt', {
    tools() {}, context() {}, getContextOrder() { return 0; }, getSectionOrder() { return 0; },
    section(section) {
      if (section.name === 'agent-switchboard:roles') guidanceRegisters++;
      sections.set(section.name, section);
      return () => { if (sections.get(section.name) === section) sections.delete(section.name); };
    },
  });
  new ToolRuntime(root);
  root.tools.register({ name: 'write', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'fixture' });
  root.provide('agents', { list: () => [] });
  root.provide('sessionProjections', { register() { return () => {}; } });
  root.provide('llm', { async resolveCallConfig(config) { if (preflight) await preflight.promise; return config; } });
  root.provide('subprocess', {
    resolveExecutable: async () => 'fixture-executable',
    spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {}, waitForExit: async () => true }),
  });
  const providers = new Map(['spawn', 'fork'].map(name => [name, { name, inheritsParentContext: false,
    capabilities: { depthLimit: true, agentOptions: true, persona: true, toolFilter: true } }]));
  root.provide('subagents', {
    resolveMaxDepth: depth => depth,
    getProvider: name => missingProvider ? undefined : providers.get(name),
    async start(provider, request) {
      resolveChildDepth(request.parent, request.maxDepth);
      requests.push({ provider, request });
      const completion = Promise.withResolvers();
      const localAgent = { id: `hot-child-${runs.length}`, session: { header: { origin: 'subagent' } } };
      const run = { id: localAgent.id, localAgent, result: completion.promise, disposed: 0,
        dispose() { this.disposed++; }, finish: () => completion.resolve({ stopReason: 'completed', output: [] }) };
      runs.push(run);
      if (!holdRun) run.finish();
      return run;
    },
  });
  root.provide('jobs', { start(spec) { pendingJobs.push(spec); return `hot-job-${pendingJobs.length}`; } });
  root.on('agent-switchboard/config-changed', payload => { if (payload.roleConfigPath === path) broadcasts++; });
  root.on('tools/change', () => {
    if (recordRapid) rapidGuidance.push(sections.get('agent-switchboard:roles')?.text({}) ?? '');
  });
  root.on('internal/status', fiber => {
    const generation = fiber.ctx[Symbol.for('agent-switchboard.generation')];
    if (generation) generations.add(generation);
  });
  const role = { ...fixtureRole, id: 'hot', model: 'first-model', allowNestedDispatch: true };
  writeConfigFile(path, initialConfig([role], { provider: 'self', maxDepth: 2 }));
  const rootFiber = root.plugin({ Config, apply(actual, config) {
    rootApplies++;
    actual.effect(() => actual.on('internal/update', () => {}));
    apply(actual, config);
  } }, { provider: 'self' });
  const presetScope = createScope(root, {});
  const presetFiber = presetScope.ctx.plugin({ Config, apply(actual, config) {
    presetApplies++;
    apply(actual, config);
  } }, { mount: true, provider: 'self', maxDepth: 7 });
  const scope = scopeOf(presetScope.ctx);
  const getTool = name => root.tools.get(name, scope);
  const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
  const save = (roles, options = {}) => rootFiber.update({ provider: 'self', roles, maxDepth: 2, ...options });
  const parent = { id: 'hot-parent', ctx: presetScope.ctx, options: { provider: 'self', model: 'parent-model' },
    session: { header: { origin: 'user' }, requestHeader: () => undefined } };
  const controller = new AbortController();
  const exec = { agent: parent, signal: controller.signal };
  const call = name => getTool(name).execute({ prompt: 'T', description: '热重载测试' }, exec);
  const guidance = () => sections.get('agent-switchboard:roles')?.text({ scope }) ?? '';
  try {
    await rootFiber.await();
    await presetFiber.await();
    await tick();
    check('H01：真实 preset 首次挂载工具且只有一次 apply', !!getTool('delegate_to_hot') && presetApplies === 1);
    await call('delegate_to_hot');
    check('H02：真实 Config/文件/工具插件的首派发 maxDepth 文件 2 优先于 preset 7',
      requests.at(-1).request.maxDepth === 3 && requests.at(-1).request.agentOptions.model === 'first-model');

    const firstGeneration = [...generations].find(g => g.roles.some(r => r.model === 'first-model'));
    preflight = Promise.withResolvers();
    const inFlight = call('delegate_to_hot');
    await tick();
    save([{ ...role, model: 'second-model', description: '更新后的热角色', instructions: '新规则',
      backend: 'fork', provider: 'new-provider', effort: 'high', readOnly: true, allowNestedDispatch: false },
      { ...fixtureRole, id: 'added' }], { maxDepth: 4 });
    await tick();
    check('H03：根更新跨 scope 广播驱动替换，不重新 apply preset 或根',
      broadcasts >= 1 && rootApplies === 1 && presetApplies === 1 && !!getTool('delegate_to_added'));
    check('B13：热重挂前根事件已把新模型写到真实文件', JSON.parse(readFileSync(path)).roles[0].model === 'second-model');
    check('H04：预检租约保留旧 scope/Fiber，原 signal 不 abort 且会话未销毁',
      firstGeneration?.active > 0 && !firstGeneration?.released && firstGeneration.scope.ctx.fiber.uid !== null
      && firstGeneration.fibers.length > 0 && firstGeneration.fibers.every(fiber => fiber.uid !== null) && !controller.signal.aborted && runs.every(run => run.disposed === 1));
    check('H05：guidance 只注册一次且不发 tools/change 就读取新角色说明',
      guidanceRegisters === 1 && guidance().includes('更新后的热角色') && guidance().includes('delegate_to_added'));
    preflight.resolve();
    preflight = undefined;
    await inFlight;
    await tick();
    check('H06：跨重挂预检任务用旧模型正常完成，活跃归零后释放旧 scope',
      requests.at(-1).request.agentOptions.model === 'first-model' && firstGeneration?.released === true
      && firstGeneration.scope.ctx.fiber.uid === null && !controller.signal.aborted);
    await call('delegate_to_hot');
    const routed = await getTool('switchboard_selftest').execute({});
    check('B14：自检报告已提交角色 provider/model/effort', routed.roleRoutes.includes('provider=new-provider model=second-model effort=high'));
    check('B15：自检文本渲染路由对主代理可见', getTool('switchboard_selftest').output.render({}, routed).some(block => block.text.includes(routed.roleRoutes)));
    check('H07：改 backend/model/effort/provider/instructions/maxDepth 后新派发全部取新快照',
      requests.at(-1).provider === 'fork' && requests.at(-1).request.agentOptions.model === 'second-model'
      && requests.at(-1).request.agentOptions.provider === 'new-provider'
      && requests.at(-1).request.agentOptions.reasoningEffort === 'high'
      && requests.at(-1).request.persona === '新规则' && requests.at(-1).request.maxDepth === 5
      && requests.at(-1).request.toolFilter.deny.includes('write')
      && requests.at(-1).request.toolFilter.deny.includes('delegate_to_added'));

    recordRapid = true;
    save([{ ...role, model: 'third-model' }]);
    save([{ ...role, model: 'fourth-model' }, { ...fixtureRole, id: 'rapid' }]);
    save([{ ...role, model: 'latest-model' }]);
    await tick();
    recordRapid = false;
    await call('delegate_to_hot');
    check('H08：连续快速保存只公开最新一代，无旧角色/重名/准备代残留',
      requests.at(-1).request.agentOptions.model === 'latest-model' && !getTool('delegate_to_added') && !getTool('delegate_to_rapid')
      && root.tools.schemas(scope).filter(tool => tool.name === 'delegate_to_hot').length === 1
      && [...generations].filter(g => !g.released).length === 1
      && !rapidGuidance.some(text => text.includes('third-model') || text.includes('fourth-model')));

    const oldTool = getTool('delegate_to_hot');
    save([{ ...role, model: '' }]);
    await tick();
    const health = await getTool('switchboard_selftest').execute({});
    await call('delegate_to_hot');
    check('H09：非法文件回滚保留旧入口可派发且自检诊断可见',
      getTool('delegate_to_hot') === oldTool && requests.at(-1).request.agentOptions.model === 'latest-model'
      && !health.ok && health.configErrors.includes('热重载失败') && health.configErrors.includes('model'));
    check('B16：重载失败路由报告上一有效代而非磁盘坏值', health.roleRoutes.includes('model=latest-model'));
    save([role]);
    await tick();
    check('H10：修正配置后诊断恢复健康', (await getTool('switchboard_selftest').execute({})).ok);
    const beforeMissingProvider = getTool('delegate_to_hot');
    missingProvider = true;
    save([{ ...role, model: 'provider-not-ready' }]); await tick();
    missingProvider = false;
    if (getTool('delegate_to_hot')) await call('delegate_to_hot');
    check('H22：准备代无自己的工具时不能借祖先旧定义假成功，保留旧入口及诊断',
      getTool('delegate_to_hot') === beforeMissingProvider && requests.at(-1).request.agentOptions.model === 'first-model'
      && (await getTool('switchboard_selftest').execute({})).configErrors.includes('工具尚未出现在工具注册表'));

    // 公开注册失败发生在旧入口注销之后；旧私有 Fiber 必须保持可用以恢复入口。
    const layers = root.tools.layers;
    const originalEffect = layers.effect;
    let rejectPublic = true;
    layers.effect = function (actual, callback, options) {
      if (rejectPublic && scopeOf(actual) === scope && options?.label === 'tools.register()') {
        rejectPublic = false;
        throw new Error('hot-public-commit-failed');
      }
      return originalEffect.call(this, actual, callback, options);
    };
    try { save([{ ...role, model: 'commit-rejected' }]); await tick(); }
    finally { layers.effect = originalEffect; }
    if (getTool('delegate_to_hot')) await call('delegate_to_hot');
    check('H11：同步公开替换失败恢复旧工具及旧 Fiber，无需重启它',
      !!getTool('delegate_to_hot') && requests.at(-1).request.agentOptions.model === 'first-model'
      && (await getTool('switchboard_selftest').execute({})).configErrors.includes('hot-public-commit-failed'));

    save([role]); await tick();
    const backgroundGeneration = [...generations].find(g => !g.released);
    const background = await getTool('delegate_to_hot').execute({ prompt: 'BG', description: '延迟后台', run_in_background: true }, exec);
    save([{ ...fixtureRole, id: 'replacement' }]); await tick();
    check('H12：后台 Job 入队即持租约，重挂后尚未启动也不会销毁旧 scope',
      background.kind === 'background' && backgroundGeneration?.active === 1 && !backgroundGeneration?.released
      && backgroundGeneration.scope.ctx.fiber.uid !== null && backgroundGeneration.fibers.every(fiber => fiber.uid !== null)
      && !getTool('delegate_to_hot') && !!getTool('delegate_to_replacement'));
    holdRun = true;
    const jobHooks = pendingJobs.shift().run({ append() {} });
    await tick();
    const backgroundRun = runs.at(-1);
    check('H13：重挂之后旧后台启动链正常，独立 signal 未 abort、run 未 dispose',
      requests.at(-1).request.agentOptions.model === 'first-model' && backgroundRun.disposed === 0
      && !requests.at(-1).request.signal.aborted);
    backgroundRun.finish(); await jobHooks.done; await tick(); holdRun = false;
    check('H14：后台自然结算后旧代归零并释放，无提前销毁', backgroundGeneration?.released && backgroundRun.disposed === 1);

    const cliRole = { id: 'hot-cli', description: 'CLI', instructions: 'CLI 规则', backend: 'cli', model: 'external-old',
      cliDriver: 'grok', cliCwd: 'C:/fixture', ...cliFieldsFor('grok', false) };
    save([cliRole], { volatile: { wrapperModel: 'wrapper-old', wrapperEffort: 'low' } }); await tick();
    holdRun = true;
    const cliCall = call('delegate_to_hot_cli'); await tick();
    const wrapper = runs.at(-1);
    const cliGeneration = [...generations].find(g => !g.released);
    save([{ ...cliRole, model: 'external-new', description: '新 CLI' }],
      { volatile: { wrapperProvider: 'route-new', wrapperModel: 'wrapper-new', wrapperEffort: 'high' } }); await tick();
    check('H15：CLI 包裹在途不被重挂误杀，旧快照、signal 与 run 保持有效',
      !cliGeneration?.released && wrapper.disposed === 0 && !requests.at(-1).request.signal.aborted
      && requests.at(-1).request.agentOptions.model === 'wrapper-old');
    let wrongIdentity;
    try { await getTool('switchboard_cli_run_hot_cli').execute({ prompt: 'T' },
      { agent: { id: 'old-builtin', session: { header: { origin: 'subagent' } } }, signal: controller.signal }); }
    catch (error) { wrongIdentity = error; }
    check('H16：旧 builtin deny 快照漏掉新增 CLI 名也被包裹身份校验拒绝', /包裹身份/.test(wrongIdentity?.message ?? ''));
    // 移除 Jobs 桩，CLI 执行用假进程；没有调用外部 CLI。
    // 真实工具读取的是构造时 buildCtx：通过临时释放可选 Jobs 服务测执行器降级路径。
    const removeJobs = root.get('jobs');
    removeJobs.start = () => { throw new Error('offline CLI jobs disabled'); };
    const cliResult = await getTool('switchboard_cli_run_hot_cli').execute({ prompt: 'T' },
      { agent: wrapper.localAgent, signal: controller.signal });
    check('H17：旧包裹经当前公开 CLI 入口仍使用旧外部模型快照',
      cliResult.status === 'completed' && cliResult.routeSummary.includes('external-old') && !cliResult.routeSummary.includes('external-new')
      && cliGeneration.definitions.has('switchboard_cli_run_hot_cli'));
    wrapper.finish(); await cliCall; await tick(); holdRun = false;
    await call('delegate_to_hot_cli');
    check('H18：新 CLI 派发采用新包裹路由，旧代际自然释放',
      requests.at(-1).request.agentOptions.provider === 'route-new'
      && requests.at(-1).request.agentOptions.model === 'wrapper-new'
      && requests.at(-1).request.agentOptions.reasoningEffort === 'high' && cliGeneration?.released);
    let invocation;
    root.get('subprocess').spawn = spec => {
      invocation = spec;
      return { done: Promise.resolve({ exitCode: 0 }), collected: {}, waitForExit: async () => true };
    };
    save([{ ...cliRole, cliDriver: 'codex', ...cliFieldsFor('codex', false), model: 'external-codex', effort: 'high' }]);
    await tick(); await call('delegate_to_hot_cli');
    const newCliResult = await getTool('switchboard_cli_run_hot_cli').execute({ prompt: '新预设' },
      { agent: runs.at(-1).localAgent, signal: controller.signal });
    check('H24：后续 CLI 执行采用新预设/参数模板/模型/强度，无真实进程调用',
      newCliResult.status === 'completed' && invocation.argv.includes('external-codex')
      && invocation.argv.includes('model_reasoning_effort=high') && invocation.argv.includes('exec'));
    holdRun = true;
    const executingWrapper = call('delegate_to_hot_cli'); await tick();
    const executingRun = runs.at(-1);
    const executingGeneration = [...generations].find(g => !g.released);
    const processDone = Promise.withResolvers();
    let processSignal, killed = 0;
    const subprocess = root.get('subprocess');
    subprocess.spawn = spec => {
      processSignal = spec.signal;
      return { done: processDone.promise, collected: {}, waitForExit: async () => true, terminate() { killed++; } };
    };
    const executingCli = getTool('switchboard_cli_run_hot_cli').execute({ prompt: '正在运行' },
      { agent: executingRun.localAgent, signal: controller.signal });
    await tick();
    save([]); await tick();
    check('H20：删角色时正在执行的 CLI 进程、包裹和调用 signal 均未误杀',
      executingGeneration?.active > 0 && !executingGeneration?.released && executingRun.disposed === 0
      && !controller.signal.aborted && processSignal instanceof AbortSignal && !processSignal.aborted && killed === 0);
    processDone.resolve({ exitCode: 0 });
    const executingResult = await executingCli;
    executingRun.finish(); await executingWrapper; await tick(); holdRun = false;
    check('H21：跨重挂 CLI 正常完成后释放旧 scope/Fiber，旧专属入口消失',
      executingResult.status === 'completed' && executingGeneration?.released && executingGeneration.scope.ctx.fiber.uid === null
      && executingGeneration.fibers.every(fiber => fiber.uid === null) && killed === 0 && !getTool('switchboard_cli_run_hot_cli'));
    check('H19：删光角色注销所有入口，guidance 不再列旧角色，自检仍仅一个',
      !getTool('delegate_to_hot_cli') && !getTool('switchboard_cli_run_hot_cli') && !guidance().includes('delegate_to_hot_cli')
      && root.tools.schemas(scope).filter(tool => tool.name === 'switchboard_selftest').length === 1);

    // 显式数组与 undefined 必须跨同一广播保留各自来源，包括显式清空。
    for (const localRoles of [[{ ...fixtureRole, id: 'local', model: 'local-model' }], []]) {
      const localScope = createScope(root, {});
      const known = new Set(generations);
      const localKey = scopeOf(localScope.ctx);
      const privateFibers = [];
      const unwatch = root.on('internal/plugin', fiber => {
        if (fiber.uid !== null && fiber.parent.fiber === root.fiber && scopeOf(fiber.parent) === localKey) privateFibers.push(fiber);
      });
      const localFiber = localScope.ctx.plugin({ Config, apply }, { mount: true, provider: 'self', roles: localRoles });
      const localTool = name => root.tools.get(name, localKey);
      try {
        await localFiber.await(); await tick();
        const initialLocal = [...generations].find(g => !known.has(g));
        const empty = localRoles.length === 0;
        check(empty ? 'H26：preset 显式空 roles 初始清空' : 'H25：preset 显式 local roles 初始优先',
          empty ? !localTool('delegate_to_local') : !!localTool('delegate_to_local'));
        save([{ ...fixtureRole, id: 'file-only' }]); await tick();
        const nextLocal = [...generations].find(g => !known.has(g) && g !== initialLocal && !g.released
          && scopeOf(g.scope.ctx.fiber.parent) === localKey);
        check(empty ? 'H28：preset 显式空 roles 跨广播仍清空，不被文件覆盖' : 'H27：preset local roles 跨广播仍优先，不消失',
          privateFibers.length === 2 && privateFibers[0].uid === null && privateFibers[1].uid !== null
          && !localTool('delegate_to_file_only')
          && (empty ? !localTool('delegate_to_local')
            : initialLocal?.released && nextLocal?.roles.length === 1 && nextLocal.roles[0].model === 'local-model' && !!localTool('delegate_to_local')));
      } finally {
        await localFiber.dispose(); await localScope.dispose(); unwatch(); await tick();
        check(localRoles.length ? 'H33：显式角色实例卸载无私有 Fiber 泄漏' : 'H34：空角色实例卸载无私有 Fiber 泄漏',
          privateFibers.length === 2 && privateFibers.every(fiber => fiber.uid === null));
      }
    }

    save([role]); await tick();
    holdRun = true;
    const unloadingCall = call('delegate_to_hot'); await tick();
    const unloadingRun = runs.at(-1);
    const unloadingGeneration = [...generations].find(g => !g.released);
    const privateKey = scopeOf(unloadingGeneration.scope.ctx);
    check('H29：父卸载夹具确实持有在途租约及私有注册', unloadingGeneration.active > 0
      && root.tools.get('delegate_to_hot', privateKey) !== undefined);
    await presetFiber.dispose(); await presetScope.dispose(); await tick();
    check('H30：父实例卸载触发 teardown，但在途私有 scope/Fiber 与工具仍在',
      presetFiber.uid === null && unloadingGeneration.retired && unloadingGeneration.active > 0
      && !unloadingGeneration.released && unloadingGeneration.scope.ctx.fiber.uid !== null
      && unloadingGeneration.fibers.length > 0 && unloadingGeneration.fibers.every(fiber => fiber.uid !== null)
      && unloadingGeneration.definitions.has('delegate_to_hot') && root.tools.get('delegate_to_hot', privateKey) !== undefined
      && !getTool('delegate_to_hot') && getTool('switchboard_selftest') === root.tools.get('switchboard_selftest')
      && !sections.has('agent-switchboard:roles') && unloadingRun.disposed === 0 && !controller.signal.aborted);
    const countAfterUnload = generations.size;
    root.emit('agent-switchboard/config-changed', { roleConfigPath: path }); await tick();
    check('H31：父卸载注销更新监听，后续广播不新建代际', generations.size === countAfterUnload);
    unloadingRun.finish(); await unloadingCall; await tick(); holdRun = false;
    check('H32：父卸载后自然结束仍显式释放所有代际，无私有 scope/Fiber 或工具泄漏',
      unloadingGeneration.active === 0 && unloadingGeneration.released
      && [...generations].every(g => g.released && g.scope.ctx.fiber.uid === null && g.fibers.every(fiber => fiber.uid === null))
      && !root.tools.layers.scoped.has(privateKey) && unloadingRun.disposed === 1);
  } finally {
    await presetFiber.dispose();
    await presetScope.dispose();
    await rootFiber.dispose();
    const generationCount = generations.size;
    root.emit('agent-switchboard/config-changed', { roleConfigPath: path }); await tick();
    check('H23：实例释放后监听和 guidance 注销，不残留重载或私有 scope/Fiber',
      generations.size === generationCount && !sections.has('agent-switchboard:roles')
      && [...generations].every(g => g.released && g.scope.ctx.fiber.uid === null) && root.tools.layers.scoped.size === 0);
    rmSync(home, { recursive: true, force: true });
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  rmSync(fixtureHome, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
