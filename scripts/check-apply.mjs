// 离线模拟 apply 的两条路径，找出崩溃点。
//
// 为什么必须做：本插件曾让应用无法启动。必须在不重启的前提下，用假 ctx 把
// 根路径与 preset 路径都真跑一遍 —— 重启一次的成本太高，而且失败会让用户进不去。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import { apply, Config, liveRoleTools, selftestTool } from '../src/index.js';
import { configPathFor, initialConfig, writeConfigFile } from '../src/config-file.js';

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
  let ctx = {
    registered,
    provided,
    // Cordis 的 ctx.provide 混入入口与 reflect.provide 共用同一调用记录。
    provide(name, instance) {
      this.reflect.provide(name, instance);
      return () => {};
    },
    get(key) {
      if (key === 'tools') return this.tools;
      if (key === 'profileContext') {
        return provideProfileContext ? { home: fixtureHome, dir: join(fixtureHome, 'profiles', 'desktop') } : undefined;
      }
      return undefined;
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
      register(def) {
        const key = scopeOf(ctx);
        const layer = key === undefined ? globalTools : scopedTools;
        if (layer.has(def.name)) throw new Error(`重复工具：${def.name}`);
        layer.set(def.name, def);
        registered.push(def?.name);
        return () => layer.delete(def.name);
      },
      get(name, viewingScope) {
        return (viewingScope !== undefined && viewingScope === scopeOf(ctx) ? scopedTools.get(name) : undefined)
          ?? globalTools.get(name);
      },
    },
    // createScope 借助 extend 写入真实的私有 scope 标签；角色插件只模拟注册副作用。
    extend(properties) {
      return Object.assign(Object.create(this), properties);
    },
    plugin(_module, config) {
      if (config?.toolName) this.tools.register({ name: config.toolName });
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
  if (scope !== undefined) ctx = createScope(ctx, scope).ctx;
  return ctx;
}

try {
const writtenFixture = writeConfigFile(configPathFor(fixtureHome), initialConfig([fixtureRole], { provider: 'self' }));
if (!writtenFixture.ok) throw new Error(writtenFixture.error);
process.env.DSH_HOME = fixtureHome; // headless 路径也只读临时 home，不改 USERPROFILE。

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
    ctx.plugin = (_module, config) => {
      // 模拟真实插件等待 provider-added 后才注册工具；首次微任务核验必定看不到它。
      providerReady = () => ctx.tools.register({ name: config.toolName });
      return { ctx, dispose() {} };
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
    ctx.plugin = () => ({ ctx, dispose() {} });
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
      missing.roleConfigStatus?.includes('同步=根条目无角色，文件尚未创建')
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
      bad.roleConfigStatus?.includes('同步=根条目无角色；文件读取失败，未同步：')
        && !bad.roleConfigStatus.includes('文件也没有') && !bad.roleConfigStatus.includes('文件尚未创建')
        && readFileSync(jsonPath, 'utf8') === brokenJson, JSON.stringify(bad));

    // 目标是目录，实际 readFileSync 必须失败；不依赖本机权限或非法路径猜测。
    const ioHome = join(home, 'io');
    mkdirSync(configPathFor(ioHome), { recursive: true });
    const unreadable = (await activate(ioHome, { roles: [] })).result;
    check('J5：空 Cordis 角色依赖不可读文件时不健康并明确读取失败',
      unreadable.ok === false && unreadable.configErrors?.includes('读取失败：')
        && unreadable.roleConfigStatus?.includes('同步=根条目无角色；文件读取失败，未同步：')
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
    result.blocked.includes('legacy') && result.blocked.includes('待迁移') && guidance.includes('不得派发'));
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
    const originalRegister = ctx.tools.register.bind(ctx.tools);
    const originalGet = ctx.tools.get.bind(ctx.tools);
    const configs = [];
    let registeredBeforeDelegate = false;
    ctx.tools.register = def => {
      if (def.name === 'switchboard_cli_run_cli_worker') {
        if (mode === 'throw') throw new Error('fixture-cli-register-failed');
        if (mode === 'missing') return () => {};
      }
      return originalRegister(def);
    };
    const originalPlugin = ctx.plugin.bind(ctx);
    ctx.plugin = (module, config) => {
      configs.push(config);
      registeredBeforeDelegate = originalGet('switchboard_cli_run_cli_worker', scope) != null;
      return mode === 'delegate-missing' ? { dispose() {} } : originalPlugin(module, config);
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
      ctx.subprocess.spawn = () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} });
      const exec = { agent: { id: 'fixture-child', session: { header: { origin: 'subagent' } } } };
      const cliTool = ctx.tools.get('switchboard_cli_run_cli_worker', scope);
      const cliResult = await cliTool.execute({ prompt: 'T' }, exec);
      check('apply 将 ctx 传给专属工具，运行时读取 Jobs 与正确 owner', starts.length === 1
        && starts[0].kind === 'cli' && starts[0].owner === 'fixture-child' && cliResult.outputFeedback === 'jobs');
      check('apply 路径结算后 remove，jobId 不进结果且退订', removed.length === 1
        && removed[0].owner === 'fixture-child' && listeners.size === 0 && !JSON.stringify(cliResult).includes('cli-private-apply'));
      jobsAvailable = false;
      const degraded = await cliTool.execute({ prompt: 'T' }, exec);
      check('apply 路径 Jobs 卸载后照常执行并报告降级', degraded.status === 'completed'
        && degraded.outputFeedback === 'unavailable' && starts.length === 1);
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  rmSync(fixtureHome, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
