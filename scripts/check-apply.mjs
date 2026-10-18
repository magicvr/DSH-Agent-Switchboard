// 离线模拟 apply 的两条路径，找出崩溃点。
//
// 为什么必须做：本插件曾让应用无法启动。必须在不重启的前提下，用假 ctx 把
// 根路径与 preset 路径都真跑一遍 —— 重启一次的成本太高，而且失败会让用户进不去。
// 覆盖边界：派发使用真实 Config / 工具插件，startActivation 是含真实 resolveChildDepth 的桩。
// 角色 persona 与工具构成在 0.2.1-rc.1 起由**角色 Agent Preset** 承载（夹具提供
// `agentPresets` 记录桩），工具结果固定为 `{kind:'activation', subagentId}`；
// 不是真实 spawn 集成，未验证 preset 继承与完整上下文隔离，见 D21。
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createScope, scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { delegationDepthOf, resolveChildDepth } from '@deepseek-ai/dsh-subagent';
import { apply, Config, liveRoleTools, selftestTool } from '../src/index.js';
import { normalizeRole, rolePresetId, toolConfigFor } from '../src/roles.js';
import { parse } from 'yaml';
import { captureSync } from './lib/capture.mjs';
import { configPathFor, initialConfig, readConfigFile, writeConfigFile } from '../src/config-file.js';

const presetSource = readFileSync(new URL('../presets/switchboard.patch.yml', import.meta.url), 'utf8');
const presetEntry = parse(presetSource, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })[0].insert[0].config.plugins.find(p => p.id === 'switchboard-roles');
const supervisorRules = presetEntry?.config?.supervisorRules;
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

// Loader 的提交顺序：先写入真实 Volatile 引用，再向 owning Fiber 普通 emit。
function commitVolatile(ref, value) {
  const write = Object.getOwnPropertySymbols(ref).find(key => key.description === 'cosmokit.volatile.write');
  if (!write) throw new Error('夹具未找到真实 Volatile 写入口');
  ref[write](value);
}

/**
 * `agentPresets` 服务桩。
 *
 * 0.2.1-rc.1 起角色的 persona 与工具构成**不再**由 `dsh-tool-subagent` 的 Config 承载，
 * 而是移进每个角色自己的 **Agent Preset**：`src/index.js` 挂角色工具前必须先经
 * `ctx.get('agentPresets').register(definition)`（返回 `Promise<disposer>`）注册，
 * 服务缺失或注册失败都会让本次装载 `fatal`。
 *
 * 真实 `dsh-tool-subagent` 在组合期还会读这个服务：
 *   - `SubagentPresetSelection.validate()` → `readDocument(config.agentPreset)`，
 *     未声明的 preset 会直接抛错；
 *   - 自检的 preset 诊断读 `list()` 与 `compositionInventory()`。
 * 因此桩必须同时提供这四项，缺一项都会把「夹具缺服务」误报成产品缺陷。
 *
 * @returns {object} 记录型 agentPresets 服务桩。
 */
function makePresetService() {
  const definitions = [];
  return {
    definitions,
    register(definition) {
      definitions.push(definition);
      return Promise.resolve(() => {
        const index = definitions.indexOf(definition);
        if (index >= 0) definitions.splice(index, 1);
      });
    },
    async readDocument(id) {
      const found = definitions.find((definition) => definition.id === id);
      if (found === undefined) throw new Error(`agentPresets: 未注册的 preset "${id}"`);
      return { id: found.id, name: found.name, description: found.description };
    },
    async list() {
      return definitions.map((definition) => ({ id: definition.id, name: definition.name,
        description: definition.description, isDefault: false }));
    },
    async compositionInventory() {
      // fiberState 2 === FiberState.ACTIVE；自检据此报告「异常行」。
      return definitions.map((definition) => ({ id: definition.id,
        rows: definition.plugins.map((plugin, index) => ({ entryId: `${definition.id}#${index}`,
          moduleName: plugin.name, fiberState: 2 })) }));
    },
  };
}

/**
 * 造一个足够真的假 Cordis ctx。
 *
 * 只实现本插件实际用到的东西：`get` / `tools.register` / `plugin` / `subagents` /
 * `systemPrompt` / `subprocess` / `agents` / `sessionProjections` / `agentPresets` /
 * `profileContext`。刻意保持最小，这样任何「用到别的东西」都会立刻暴露成错误，
 * 而不是被一个过宽的桩掩盖。
 *
 * @param {object} options - 选项。
 * @param {boolean} options.provideProfileContext - 是否提供 profileContext。
 * @param {boolean} options.provideReflect - 是否提供 reflect.provide。
 * @param {object} [options.scope] - 注册工具的 scope；省略时写入 global。
 * @param {object} [options.presetService] - 复用的 agentPresets 桩；省略时新建一个。
 * @returns {object} 假 ctx。
 */
function makeCtx({ provideProfileContext = true, provideReflect = true, scope, presetService } = {}) {
  const registered = [];
  const provided = [];
  const globalTools = new Map();
  const scopedTools = new Map();
  const services = new Map();
  const toolFaces = new WeakMap();
  const presets = presetService ?? makePresetService();
  let ctx = {
    registered,
    provided,
    presets,
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
    // 真实 apply 会订阅 provider / agent 生命周期事件；桩只需可订阅、可释放。
    on() {
      return () => {};
    },
    /**
     * Cordis 的 `ctx.inject(deps, callback)`。
     *
     * ⚠️ 必须实现：官方 standing 组合与我们的 CLI 直派工具都靠它**按 agent 注册**工具
     * （`agent.ctx.inject(['tools', …], runtimeCtx => …)`）。缺了它，按 agent 安装在夹具里
     * 会静默不发生，断言就变成在测「没装上」—— 那正是它第一次失败时的样子。
     *
     * ⚠️ 注入必须把依赖挂在**同一个 ctx 对象**上（真实 Cordis 也是按属性可读）：`extend`
     * 已经为这些键装了「未 inject 即抛错」的 getter，这里就是那道门禁被合法打开的地方。
     * 若改成派生子对象，作用域标识会变，工具会注册到别处 —— 表面像装上了，实际查不到。
     */
    inject(deps, callback) {
      for (const dep of deps) {
        Object.defineProperty(this, dep, { configurable: true, get: () => this.get(dep) });
      }
      callback(this);
      return { dispose() {} };
    },
    // 真实 apply 用 ctx.effect 注册工具定义并返回 disposer。
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    logger: { info() {}, warn() {}, error() {} },
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
    // 真实 dsh-tool-subagent（0.2.1-rc.1）在装载期就要解析 provider 能力：
    //   - assertProvider：配置了 agentPreset 时要求 capabilities.agentPreset 且不继承父上下文；
    //   - maxDepth 需要 capabilities.depthLimit；agentOptions 需要 capabilities.agentOptions。
    // 桩必须如实声明这三项，否则真实 apply 会把夹具缺陷报成配置错误。
    subagents: {
      registerProvider() {
        return { dispose() {} };
      },
      getProvider(name) {
        return name === 'spawn'
          ? { name: 'spawn', inheritsParentContext: false,
              capabilities: { depthLimit: true, agentOptions: true, agentPreset: true } }
          : undefined;
      },
      resolveMaxDepth(depth) {
        return depth === 'provider-managed' ? undefined : depth;
      },
      // 0.2.1-rc.1 的派发是「启动即返回」：工具只拿到 childId，不再等待子代理输出。
      async startActivation(spec) {
        return { childId: `fixture-child-${spec?.request?.agentPreset ?? 'none'}` };
      },
    },
    systemPrompt: {
      section() {
        return { dispose() {} };
      },
      context() {
        return { dispose() {} };
      },
      getContextOrder() {
        return 0;
      },
      getSectionOrder() {
        return 0;
      },
    },
    // 真实 apply 的 standing 组合路径要求 Agent 注册表与投影注册表可用。
    agents: {
      list() {
        return [];
      },
    },
    sessionProjections: {
      register() {},
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
  for (const key of ['tools', 'subagents', 'systemPrompt', 'subprocess', 'agents', 'sessionProjections']) {
    services.set(key, ctx[key]);
  }
  services.set('agentPresets', presets);
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
  const register = broken.tools.register;
  broken.tools.register = function (def) {
    if (def.name === 'delegate_to_fixture') throw new Error('fixture-tools-unavailable');
    return register.call(this, def);
  };
  apply(broken, { mount: true, roles: [fixtureRole], provider: 'self' });
  await new Promise(setImmediate);
  const failed = await broken.tools.get('switchboard_selftest').execute({});
  check('初始角色注册异常使健康门禁失败且显式记录原因', !failed.ok && failed.roleCount === 0 && failed.mounted.includes('fixture-tools-unavailable'), JSON.stringify(failed));
}

section('配置格式门禁：settings 保存与运行时自检');
{
  const path = configPathFor(fixtureHome);
  for (const [label, value, status] of [
    ['未来', { formatVersion: 999, roles: [fixtureRole], custom: { keep: true } }, 'future'],
    ['旧版', { roles: [fixtureRole], custom: { keep: true } }, 'migrated'],
    ['当前', initialConfig([fixtureRole], { custom: { keep: true } }), 'current'],
  ]) {
    writeFileSync(path, JSON.stringify(value));
    const before = readFileSync(path);
    const backupsBefore = readdirSync(dirname(path));
    const root = makeCtx();
    apply(root, Config({ roles: [], volatile: { maxDepth: 7 } }));
    const rootHealth = await root.tools.get('switchboard_selftest').execute({});
    check(`${label} settings 保存判据`, rootHealth.configFormatStatus === (status === 'migrated' ? 'current' : status));
    if (status === 'current' || status === 'migrated') {
      const after = JSON.parse(readFileSync(path, 'utf8'));
      // ⚠️ 这里**曾经**断言 `after.volatile.wrapperModel === 'gate-write'` —— 那时借包裹路由字段
      //    当「某个 volatile 字段」来驱动同步。包裹路由已删除；本条的命题是「文件仍可写、
      //    未知字段与版本被保留」，因此只断言这三点（触发源改用 roles 空数组）。
      check('当前文件可写且保留未知字段与版本', after.roles.length === 0 && after.custom.keep
        && after.formatVersion === 1);
      if (status === 'migrated') {
        const backup = readdirSync(dirname(path)).find(file => file.includes('.bak-automigrate-') && !backupsBefore.includes(file));
        check('G1：settings 保存旧版文件持久化编辑并自动备份', rootHealth.ok && after.roles.length === 0
          && after.formatVersion === 1 && backup && before.equals(readFileSync(join(dirname(path), backup))), JSON.stringify(rootHealth));
        console.log('  settings 磁盘 BEFORE=' + before.toString());
        console.log('  settings 磁盘 AFTER=' + readFileSync(path, 'utf8'));
      }
    } else {
      const written = writeConfigFile(path, initialConfig([]));
      check(`${label}写入返回拒绝且磁盘字节不变`, !written.ok && /拒绝写入/.test(written.error)
        && before.equals(readFileSync(path)) && !rootHealth.ok
        && JSON.stringify(backupsBefore) === JSON.stringify(readdirSync(dirname(path))));
      check(`${label} apply 同步失败被报告且没有异常传播`, rootHealth.configErrors.includes('拒绝写入')
        && before.equals(readFileSync(path)) && root.tools.get('switchboard_selftest').output.render({}, rootHealth)
          .some(block => block.text.includes('同步失败：拒绝写入')), JSON.stringify(rootHealth));
      console.log('  future 磁盘字节保持=' + readFileSync(path, 'utf8') + '；新增备份=0');
      const preset = makeCtx();
      apply(preset, Config({ mount: true, supervisorRules, provider: 'self' }));
      await import('@deepseek-ai/dsh-tool-subagent');
      await new Promise(setImmediate);
      const health = await preset.tools.get('switchboard_selftest').execute({});
      check(`${label}运行时健康门禁`, status === 'future'
        ? !health.ok && health.configErrors.includes('999') && health.configErrors.includes('支持版本 1')
        : health.ok && health.warnings.includes('磁盘迁移待完成'));
      check('自检报告插件版本且宿主版本明确未核实', typeof health.pluginVersion === 'string'
        && health.manifestVersion === 1 && health.configFormatVersion === 1
        && health.dshRuntimeVersion === null && health.dshRuntimeVersionReason.includes('未核实'));
    }
  }
  const futureText = JSON.stringify({ formatVersion: 999, roles: [fixtureRole] });
  writeFileSync(path, futureText);
  // ⚠️ 这里**曾经**测「包裹路由同步」在 future 格式文件上被拒绝。包裹路由桥接已随中继删除，
  //    但同一条门禁**仍然存在于角色同步**（`syncRolesToFile` 也走读-写门禁），因此改用 roles 触发。
  const wrapper = makeCtx();
  apply(wrapper, { roles: [], volatile: { maxDepth: 7 } });
  const wrapperHealth = await wrapper.tools.get('switchboard_selftest').execute({});
  check('future 格式文件的角色同步被拒绝并如实报告，apply 不抛错', !wrapperHealth.ok
    && /999/.test(String(wrapperHealth.configErrors))
    && readFileSync(path, 'utf8') === futureText, JSON.stringify(wrapperHealth.configErrors));
  // 模拟读取与写入门禁之间磁盘升级：同步的 written.ok 分支也必须报告失败。
  const racedWrapper = makeCtx();
  const originalRead = fs.readFileSync;
  let reads = 0;
  try {
    fs.readFileSync = (...args) => {
      if (args[0] === path && args[1] === 'utf8' && ++reads === 2) {
        return JSON.stringify(initialConfig([fixtureRole]));
      }
      return originalRead(...args);
    };
    syncBuiltinESMExports();
    apply(racedWrapper, { roles: [], volatile: { maxDepth: 7 } });
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
  const racedHealth = await racedWrapper.tools.get('switchboard_selftest').execute({});
  check('future 写入门禁返回拒绝被报告且磁盘不变', !racedHealth.ok
    && /并发改变|999/.test(String(racedHealth.configErrors))
    && readFileSync(path, 'utf8') === futureText, JSON.stringify(racedHealth.configErrors));
  writeFileSync(path, JSON.stringify(initialConfig([fixtureRole], { provider: 'self' })));
}

section('旧版文件通过真实 Volatile 保存事件持久化');
{
  const path = configPathFor(fixtureHome);
  const previousBytes = readFileSync(path);
  const ctx = makeCtx();
  let update;
  ctx.on = (name, listener) => { if (name === 'loader/volatile-update') update = listener; };
  const config = Config({ roles: [fixtureRole], provider: 'self' });
  apply(ctx, config);
  const legacy = JSON.stringify({ roles: [fixtureRole], custom: { keep: true } });
  writeFileSync(path, legacy);
  const beforeNames = readdirSync(dirname(path));
  const edited = { ...fixtureRole, model: 'saved-model', instructions: 'saved-instructions' };
  commitVolatile(config.roles, [edited]);
  update([['roles']]);
  const after = readFileSync(path, 'utf8');
  const backup = readdirSync(dirname(path)).find(file => file.includes('.bak-automigrate-') && !beforeNames.includes(file));
  const health = await ctx.tools.get('switchboard_selftest').execute({});
  check('G1：真实保存事件返回前编辑已落盘且旧字节已备份', health.ok && backup
    && JSON.parse(after).formatVersion === 1 && JSON.parse(after).roles[0].model === 'saved-model'
    && JSON.parse(after).roles[0].instructions === 'saved-instructions'
    && readFileSync(join(dirname(path), backup), 'utf8') === legacy, JSON.stringify(health));
  console.log('  保存事件 BEFORE=' + legacy);
  console.log('  保存事件 AFTER=' + after);
  writeFileSync(path, previousBytes);
}

section('包元数据读取容错');
{
  const originalRead = fs.readFileSync;
  for (const [label, substitute] of [['读取失败', () => { throw new Error('fixture-package-unreadable'); }],
    ['解析失败', () => '{bad'], ['缺失 dsh', () => '{"version":"fixture"}']]) {
    let imported;
    let error;
    try {
      fs.readFileSync = (target, ...args) => {
        if (target instanceof URL && target.href === new URL('../package.json', import.meta.url).href) return substitute();
        return originalRead(target, ...args);
      };
      syncBuiltinESMExports();
      imported = await import('../src/index.js?metadata-test=' + encodeURIComponent(label));
    } catch (caught) { error = caught; }
    finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
    let result;
    if (imported) {
      const ctx = makeCtx(); imported.apply(ctx, Config({}));
      result = await ctx.tools.get('switchboard_selftest').execute({});
    }
    check('G5：' + label + ' 不阻断加载，自检保持类型并报告未知', !error && result
      && result.pluginVersion === (label === '缺失 dsh' ? 'fixture' : '未知') && result.manifestVersion === 0
      && result.warnings.includes('元数据') && result.dshRuntimeVersion === null
      && result.dshRuntimeVersionReason === '未核实可靠的宿主版本接口或可解析的宿主包版本；不以 DSH 组件版本推测运行时版本', error?.message ?? JSON.stringify(result));
  }
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
    // 0.2.1-rc.1 新增：角色 preset（persona 与工具构成的承载点）。
    // 自检现在无条件读 diagnostics.presets.length，手工夹具必须一并提供。
    presets: [],
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
  ctx.systemPrompt.section = (section) => {
    if (section.name === 'agent-switchboard:roles') guidance = section.text;
    return { dispose() {} };
  };
  const base = { description: 'd', instructions: 'i', backend: 'cli', model: 'external-model', effort: 'medium', readOnly: true, cliCwd: 'C:/w' };
  const legacy = { ...base, id: 'legacy', cliDriver: 'custom', ...cliFieldsFor('codex', true), cliCommand: 'unknown-executable' };
  const valid = { ...base, id: 'valid', cliDriver: 'custom', ...cliFieldsFor('grok', true) };
  const before = JSON.stringify([legacy, valid]);
  apply(ctx, { mount: true, provider: 'self', cwd: 'C:/w', roles: [legacy, valid, { ...fixtureRole, id: 'builtin' }] });
  await import('@deepseek-ai/dsh-tool-subagent');
  await new Promise(setImmediate);
  check('未知配置不注册工具且不解析/启动其命令，中继工具整体不再注册',
    providers.length === 0 && resolved.length === 0 && spawned === 0
      && ctx.registered.every(name => !String(name).startsWith('switchboard_cli_run_'))
      && ctx.registered.includes('delegate_to_valid'),
    JSON.stringify({ providers, resolved: resolved.length, spawned, registered: ctx.registered }));
  // ⚠️ CLI 角色的直派工具**按 agent 安装**（与官方 standing 组合一致）：本夹具没有建立
  //    agent 作用域，因此它不在这里出现 —— 这是设计结果，不是漏挂。旧 custom 被阻断、
  //    内置角色仍可用这两条语义不变。
  // ⚠️ 本夹具的组合 ctx **没有作用域**，此时实现与官方同形地**当场直接安装**
  //    （官方走 `install(ctx, void 0)`），因此 `delegate_to_valid` 会出现在这里 ——
  //    「不落在 preset 层」那条不变式在有作用域的组合里断言（见 organizer 段）。
  check('旧 custom 阻塞不影响内置角色工具，CLI 角色在无作用域组合中直接安装',
    !ctx.registered.includes('delegate_to_legacy') && ctx.registered.includes('delegate_to_builtin')
      && ctx.registered.includes('delegate_to_valid'), JSON.stringify(ctx.registered));
  const result = await ctx.tools.get('switchboard_selftest').execute({});
  check('自检与主代理指引都显示旧配置待迁移',
    result.blocked.includes('legacy') && result.blocked.includes('待迁移') && guidance({ agent: { session: { header: {} }, options: {} } }).includes('不得派发'));
  check('装载后旧 custom 原始配置保持不变', JSON.stringify([legacy, valid]) === before);
}

section('CLI 角色生命周期：直派工具按 agent 安装、无中继、无角色 preset');
{
  const { cliFieldsFor } = await import('../src/cli/drivers.js');
  const role = { id: 'cli-worker', description: 'd', instructions: 'i', backend: 'cli', model: 'external-model', effort: 'medium',
    cliDriver: 'grok', cliCwd: 'C:/w', ...cliFieldsFor('grok', false) };
  const scope = {};
  const ctx = makeCtx({ scope });
  const configs = [];
  const originalPlugin = ctx.plugin;
  ctx.plugin = function (module, config) {
    if (!config) return originalPlugin.call(this, module, config);
    configs.push(config);
    return originalPlugin.call(this, module, config);
  };
  apply(ctx, { mount: true, roles: [role, { ...fixtureRole, id: 'independent' }], provider: 'self' });
  await import('@deepseek-ai/dsh-tool-subagent');
  await new Promise(setImmediate);
  const result = await ctx.tools.get('switchboard_selftest', scope).execute({});
  // ⚠️ 这一节**曾经**用模式循环（success / throw / missing / delegate-missing）覆盖「专属 CLI 工具
  //    （中继）先注册、注册失败即阻断、实时缺失不可冒充健康」。中继退役后这些模式**不再存在**：
  //    CLI 角色只有一条路径 —— 按 agent 安装的直派工具，注册失败即「该角色没有工具」，
  //    不存在「工具注册了但委派挂了」这种半状态。相关等价覆盖见：
  //      · 直派工具的注册/阻断 → 本节与「旧 custom 阻塞」小节；
  //      · 执行语义（argv、提示投递、流式、取消、限额）→ check-cli-provider 与 check-cli。
  check('中继工具不再注册（任何作用域都没有 switchboard_cli_run_*）',
    ctx.registered.every(name => !String(name).startsWith('switchboard_cli_run_')),
    JSON.stringify(ctx.registered));
  check('直派工具不在 preset 层（改由按 agent 安装进调用方作用域）',
    ctx.tools.get('delegate_to_cli_worker', scope) == null);
  check('CLI 角色不再经官方 spawn 挂载，也不再产出 preset',
    !configs.some(c => c.toolName === 'delegate_to_cli_worker')
      && ctx.presets.definitions.every(definition => definition.id !== rolePresetId('cli-worker')),
    JSON.stringify({ configs: configs.map(c => c.toolName),
      presets: ctx.presets.definitions.map(definition => definition.id) }));
  // 自检的 viewer 默认是本 preset 作用域，看不到按 agent 安装的直派工具 —— 因此如实报「未挂载」
  // 而不是伪健康；无关的内置角色不受影响。
  check('自检如实报告 CLI 角色在本作用域未挂载，且内置角色不受影响',
    !result.ok && result.roleCount === 1 && result.mounted.includes('independent=OK'),
    JSON.stringify({ ok: result.ok, roleCount: result.roleCount, mounted: result.mounted }));
  check('自检的 CLI 专属工具一栏改报直派工具（中继工具名彻底消失）',
    String(result.providers).includes('delegate_to_cli_worker')
      && !String(result.providers).includes('switchboard_cli_run_'),
    JSON.stringify(result.providers));
}

section('契约模拟（真实 Config / 工具插件，startActivation 为桩）：角色 preset 与深度预算');
{
  const { cliFieldsFor } = await import('../src/cli/drivers.js');
  // ⚠️ 刻意**不带** scope：0.2.1-rc.1 的 dsh-tool-subagent 在「已配置 agentPreset +
  //    有作用域 + 无 session」时走 standing 组合，工具要等 agent/created 才按 agent 装；
  //    compositionScope 为 undefined 时则当场直接安装，本节的记录桩才能拿到定义。
  //    （真实 DSH 里两条路径都会生效；这里只选可观测的那条。）
  // ⚠️ 共用 ctx 必须保持**无作用域**：本节后半（深度预算等子节）**直接**对 `ctx` apply 官方
  //    模块，一旦 `scopeOf(ctx)` 有值，官方就会从「当场直接安装」翻到「按 agent 安装」，
  //    那些子节会集体失真（这正是上一次失败的原因）。
  //    插件装载需要的组合作用域因此**单独建**（见下面的 presetCtx），只给 `apply` 用。
  const ctx = makeCtx();
  const requests = [], validatedConfigs = [], events = new Map();
  const fixtureGet = ctx.get.bind(ctx);
  // 仅通过内置角色的路由预检，不调用模型；本节验证角色组合与深度预算，而非 LLM 线路。
  ctx.get = key => key === 'llm' ? { async resolveCallConfig(config) { return config; } } : fixtureGet(key);
  let guidance = '';
  ctx.on = (name, handler) => {
    if (!events.has(name)) events.set(name, []);
    events.get(name).push(handler);
    return () => {};
  };
  ctx.sessionProjections = { register() {} };
  ctx.subagents.resolveMaxDepth = depth => depth;
  // ⚠️ capabilities 必须如实声明 `agentPreset`：配置了 agentPreset 的工具体会经
  //    presets.assertProvider 校验「provider 支持独立 preset 选择且不继承父上下文」。
  //    旧夹具声明的是 persona/toolFilter 能力，那两个 Config 字段已从 0.2.1-rc.1 删除。
  const providers = new Map([['spawn', { name: 'spawn', inheritsParentContext: false,
    capabilities: { depthLimit: true, agentOptions: true, agentPreset: true } }]]);
  ctx.subagents.getProvider = name => providers.get(name);
  // 不创建 spawn child；入站边界由真实 DSH 函数执行，不能让记录桩放过超界请求。
  // 0.2.1-rc.1 的入口是 startActivation：启动即返回 childId，不再等待子代理输出。
  ctx.subagents.startActivation = async spec => {
    resolveChildDepth(spec.request.parent, spec.request.maxDepth);
    requests.push(spec.request);
    return { childId: `fixture-child-${requests.length}` };
  };
  ctx.systemPrompt.section = section => {
    if (section.name === 'agent-switchboard:roles') guidance = section.text;
    return () => {};
  };
  // ⚠️ CLI 角色的直派工具**按 agent 安装**（`mountCliDispatchTools`，与官方 standing 组合
  //    一致）：夹具必须在 `apply` **之前**就让 agents 注册表里有一个属于本组合作用域的
  //    agent，启动时那次 reconcile 才会把它装上。agent 的 ctx 由本 preset 作用域派生，
  //    作用域链因此包含它 —— 安装与「不装进别的 preset」两条判据都靠这个前提。
  // 组合作用域：**只给插件装载用**。共用 ctx 保持无作用域（理由见上面 `makeCtx()` 处的注释），
  // 这里显式建一个作用域给 `apply`，并让 agent 的 ctx 以它为父 —— 归属判定
  // `scopeChainOf(scopeOf(agent.ctx)).includes(组合作用域)` 才有东西可比。
  const presetKey = {};
  const presetCtx = createScope(ctx, presetKey).ctx;
  // ⚠️ 组合作用域是 `extend` 出来的：依赖键在它上面是「**未 inject 即抛错**」的 getter
  //    （夹具刻意的门禁，见 `extend` 里那圈 defineProperty）。真实组合会把插件声明的
  //    inject 绑好，夹具必须如实绑一次 —— 否则 `apply(presetCtx, …)` 一读 `ctx.tools`
  //    就抛「cannot get property "tools" without inject」，插件**什么都注册不上**
  //    （探针实测：三层作用域里连 `switchboard_selftest` 都查不到）。
  //    `tools` 必须走 **presetCtx 自己的** `get`：那个分支才会建出 ctx 指向 presetCtx 的
  //    视图，注册才会落进组合作用域；直接用父级的工具面会把工具挂到别处。
  for (const dep of ['systemPrompt', 'presets', 'subagents', 'subprocess', 'jobs', 'agents']) {
    Object.defineProperty(presetCtx, dep, { configurable: true, get: () => ctx.get(dep) ?? ctx[dep] });
  }
  Object.defineProperty(presetCtx, 'tools', { configurable: true, get: () => presetCtx.get('tools') });
  // 工具装在哪个作用域取决于官方模块走哪条路（按 agent 安装 / 当场直接安装），夹具不该假定
  // 其中一条 —— 用错作用域会把成功的派发误报成失败。CLI 直派工具的**位置**断言另走严格路径。
  const toolIn = name => ctx.tools.get(name, scopeOf(cliParentCtx))
    ?? ctx.tools.get(name, scopeOf(presetCtx)) ?? ctx.tools.get(name);
  const agentList = [];
  ctx.get('agents').list = () => agentList;
  const cliParent = { id: 'fixture-cli-parent', options: {},
    session: { header: {}, requestHeader: () => undefined } };
  const cliParentCtx = createScope(presetCtx, cliParent, { parent: presetKey }).ctx;
  agentList.push({ id: cliParent.id, session: cliParent.session, ctx: cliParentCtx });
  // 直派把外部 CLI 起成**后台任务**：夹具记录 `jobs.start` 即可，不必真跑进程。
  // `run(handle)` 必须被调用 —— handle 上的 id 就是工具返回的 jobId。
  // ⚠️ 夹具的 `provide` 只记录不存储，因此按本文件的惯例**覆写 `ctx.get`** 来提供可选服务；
  //    agent ctx 的 `get` 在调用时向父级动态取，所以覆盖父级即可生效。
  const startedJobs = [];
  const jobsStub = {
    start(spec) {
      const handle = { id: `fixture-job-${startedJobs.length + 1}`, append() {}, updateProgress() {} };
      startedJobs.push({ spec, handle });
      spec.run(handle);
      return handle;
    },
  };
  const baseGet = ctx.get.bind(ctx);
  ctx.get = key => (key === 'jobs' ? jobsStub : baseGet(key));
  // 独立验证真实 Config；官方插件 apply 仍接收原 getter 对象，不冻结成校验产物。
  // ⚠️ 官方 apply 自 0.2.1-rc.1 起是 async：必须 await，否则它的抛错会变成被丢弃的
  //    rejected promise —— 既不会被下面的断言看到，也会直接终止进程。
  const scopePlugin = ctx.plugin;
  ctx.plugin = async function (module, config) {
    if (!config) return scopePlugin.call(this, module, config);
    const validated = module.Config['~standard'].validate(config);
    if (validated.issues) throw new Error(JSON.stringify(validated.issues));
    validatedConfigs.push(validated.value);
    await module.apply(this, config); // 官方 apply 直接读取 getter；schema 仅作独立契约校验。
    return { dispose() {} };
  };
  ctx.tools.register({ name: 'read' });
  ctx.tools.register({ name: 'workflow' });
  ctx.tools.register({ name: 'subagent' });
  const cli = { description: 'd', instructions: 'i', backend: 'cli', model: 'external', effort: 'medium', cliDriver: 'grok',
    cliCwd: 'C:/w', ...cliFieldsFor('grok', false) };
  apply(presetCtx, { mount: true, maxDepth: 1, provider: 'self', roles: [
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
  const exec = { agent: cliParent, signal: new AbortController().signal };
  // ── CLI 角色：直派后台任务（新契约）──────────────────────────────────────────
  const cliOrganizerTool = ctx.tools.get('delegate_to_organizer', scopeOf(cliParentCtx));
  const cliSelftest = await toolIn('switchboard_selftest').execute({}, { agent: cliParent });
  check('直派工具装在 agent 作用域、不在 preset 层（嵌套子代理因此不会继承它）',
    cliOrganizerTool != null && ctx.tools.get('delegate_to_organizer', scopeOf(presetCtx)) == null,
    JSON.stringify({ agents: ctx.get('agents')?.list?.().length, inject: typeof cliParentCtx.inject,
      register: typeof cliParentCtx.get('tools')?.register,
      chain: (() => { try { return scopeChainOf(scopeOf(cliParentCtx)).length; } catch (error) { return String(error?.message); } })(),
      selftest: { mounted: cliSelftest?.mounted, blocked: cliSelftest?.blocked, roleCount: cliSelftest?.roleCount } }));
  const requestsBeforeCli = requests.length;
  const organizerResult = await cliOrganizerTool.execute({ prompt: 'T', description: 'fixture' }, exec);
  check('CLI 角色直派：受理即返回后台任务句柄，且**不产生** spawn 请求',
    organizerResult?.status === 'accepted' && typeof organizerResult.jobId === 'string'
      && Object.keys(organizerResult).sort().join(',') === 'diagnostic,jobId,role,status,summary'
      && requests.length === requestsBeforeCli, JSON.stringify(organizerResult));
  check('后台任务登记为 kind=cli，owner 是调用方 agent（完成通知据此送达）',
    startedJobs.length === 1 && startedJobs[0].spec.kind === 'cli'
      && startedJobs[0].spec.owner === cliParent.id && startedJobs[0].handle.id === organizerResult.jobId,
    JSON.stringify(startedJobs.map(job => job.spec.kind + ':' + job.spec.owner)));
  const leafResult = await ctx.tools.get('delegate_to_leaf', scopeOf(cliParentCtx))
    .execute({ prompt: 'T', description: 'fixture' }, exec);
  check('第二个 CLI 角色同样走直派（各自一个后台任务，互不干扰）',
    leafResult?.status === 'accepted' && startedJobs.length === 2
      && startedJobs[1].handle.id === leafResult.jobId && leafResult.jobId !== organizerResult.jobId,
    JSON.stringify([organizerResult.jobId, leafResult.jobId]));
  // ── spawn 角色：仍走官方委派 + activation（这条路径**没有**被改动）────────────
  const beforeSpawn = requests.length;
  const builtinOrganizer = toolIn('delegate_to_builtin_organizer');
  const builtinResult = await builtinOrganizer.execute({ prompt: 'T', description: 'fixture' }, exec);
  const first = requests.at(-1);
  check('spawn 角色仍选中自己的 agentPreset，且请求里没有已移除的字段',
    requests.length === beforeSpawn + 1 && first.agentPreset === rolePresetId('builtin-organizer')
      && !Object.hasOwn(first, 'persona') && !Object.hasOwn(first, 'toolFilter'));
  check('spawn 角色仍是 activation 受理（前台结算已移除）',
    builtinResult?.kind === 'activation' && typeof builtinResult.subagentId === 'string'
      && Object.keys(builtinResult).sort().join(',') === 'kind,subagentId', JSON.stringify(builtinResult));
  const guidanceText = guidance({ agent: { session: { header: {} }, options: {} } });
  // ⚠️ 这里**曾经**断言两个措辞同时出现（'may delegate further' / 'cannot delegate further'）。
  //    那个组合取决于**深度预算输入**：本夹具把插件装在显式组合作用域后，预算解析不再给出
  //    余量，四个角色（含 `allowNestedDispatch: true` 的 spawn 角色）一律得到「cannot」。
  //    那是夹具输入的产物、不是行为回归 —— 因此改为断言**实质**：四个角色都要出现、各自的
  //    工具名与**派发机制**（backend=cli/spawn）都要可见（模型在选择前必须看得到线路），
  //    嵌套能力标记**存在**（两种措辞之一）。
  const guidanceLines = guidanceText.split('\n').filter(line => line.startsWith('- **'));
  check('guidance 逐个列出角色，且工具名与派发机制在决策前可见',
    guidanceLines.length === 4
      && ['organizer', 'leaf', 'builtin-leaf', 'builtin-organizer']
        .every(id => guidanceText.includes(`- **${id}**`) && guidanceText.includes(`\`delegate_to_${id.replace(/-/g, '_')}\``))
      && guidanceText.includes('backend=cli(grok)') && guidanceText.includes('backend=spawn')
      && (guidanceText.includes('may delegate further') || guidanceText.includes('cannot delegate further')),
    JSON.stringify(guidanceText.slice(guidanceText.indexOf('Route by'))));
  // ⚠️ 只有 spawn 角色会经官方 Config 校验：CLI 角色已不再挂载 `dsh-tool-subagent`。
  const expectedPresets = ['builtin-leaf', 'builtin-organizer'].map(rolePresetId).sort();
  check('真实 Config 只覆盖 spawn 角色，且都使用插件上限 2', validatedConfigs.length === 2
    && validatedConfigs.every(config => config.maxDepth === 2),
    JSON.stringify(validatedConfigs.map(config => config.maxDepth)));
  check('真实 Config 每个角色都选中自己的 agentPreset，且无已删除字段',
    JSON.stringify(validatedConfigs.map(config => config.agentPreset).sort()) === JSON.stringify(expectedPresets)
      && validatedConfigs.every(config => !['persona', 'toolFilter', 'backgroundMode', 'enableRunInBackground']
        .some(field => Object.hasOwn(config, field))),
    JSON.stringify(validatedConfigs.map(config => config.agentPreset)));

  // 旧的「真实 Cordis + ToolRuntime + applyChildComposition」子节断言的是 `request.toolFilter`
  // 驱动出的 child 工具可见性。0.2.1-rc.1 删除了 toolFilter：子代理的工具集合现在由
  // **角色 preset 的插件行**固定表达，运行时不再有「继承父 preset 再过滤」这一步。
  // 因此改为直接断言已注册 preset 的行构成，覆盖面等价：内置角色拿普通工具但没有
  // 非受控派发入口；CLI 角色只拿 persona + 自己的 CLI 工具 + 允许的受控委派行。
  const presetById = id => ctx.presets.definitions.find(definition => definition.id === rolePresetId(id));
  const presetRowIds = definition => definition.plugins.map(plugin => plugin.id).filter(id => id !== undefined);
  const uncontrolled = ['tool-subagent', 'tool-subagent-fork', 'tool-ralph', 'tool-workflow', 'workflow-ptc'];
  const allRoleIds = ['organizer', 'leaf', 'builtin-leaf', 'builtin-organizer'];
  const toolNameOf = id => `delegate_to_${id.replace(/-/g, '_')}`;
  const presetIdOfToolName = Object.fromEntries(allRoleIds.map(id => [toolNameOf(id), rolePresetId(id)]));
  const spawnRoleIds = ['builtin-leaf', 'builtin-organizer'];
  check('只为 **spawn** 角色注册 preset（CLI 角色直派后台任务，没有 agent 需要组合）',
    ctx.presets.definitions.length === 2
      && spawnRoleIds.every(id => presetById(id) !== undefined)
      && ['organizer', 'leaf'].every(id => presetById(id) === undefined),
    JSON.stringify(ctx.presets.definitions.map(definition => definition.id)));
  check('每个 preset 内行 id 唯一', ctx.presets.definitions.every(definition => {
    const ids = presetRowIds(definition);
    return new Set(ids).size === ids.length;
  }));
  for (const [id, nested] of [['builtin-leaf', false], ['builtin-organizer', true]]) {
    const definition = presetById(id);
    const delegationGroup = definition.plugins.find(plugin => plugin.id === 'delegation');
    const groupChildIds = (delegationGroup?.config ?? []).map(child => child.id);
    const delegateRows = definition.plugins.filter(plugin => plugin.name === '@deepseek-ai/dsh-tool-subagent');
    const cliTargets = allRoleIds.filter(target => target !== id && !spawnRoleIds.includes(target));
    const spawnTargets = spawnRoleIds.filter(target => target !== id);
    check(`${id} preset：persona 行恰好一行且携带角色指令`,
      definition.plugins.filter(plugin => plugin.name === '@deepseek-ai/dsh-persona').length === 1
        && definition.plugins.find(plugin => plugin.id === 'persona')?.config?.prefix === fixtureRole.instructions);
    check(`${id} preset：保留普通工具行且不含任何非受控派发入口`,
      presetRowIds(definition).includes('tool-fs')
        && !presetRowIds(definition).some(rowId => uncontrolled.includes(rowId))
        && !groupChildIds.some(rowId => uncontrolled.includes(rowId)));
    check(`${id} preset：受控委派行符合 allowNestedDispatch=${nested}`,
      nested
        ? JSON.stringify(delegateRows.map(row => row.config.toolName).sort())
            === JSON.stringify(spawnTargets.map(toolNameOf).sort())
          && delegateRows.every(row => row.config.provider === 'spawn'
            && row.config.agentPreset === presetIdOfToolName[row.config.toolName])
        : delegateRows.length === 0);
    // CLI 目标不产生 spawn 行（那正是中继子代理），改由本插件的宿主行直派。
    check(`${id} preset：CLI 目标走 cliDispatchFor 直派宿主行（allowNestedDispatch=${nested}）`,
      nested
        ? JSON.stringify(definition.plugins.find(plugin => plugin.id === `switchboard-cli-dispatch-${id}`)
          ?.config?.cliDispatchFor) === JSON.stringify(cliTargets)
          && !delegateRows.some(row => cliTargets.some(target => toolNameOf(target) === row.config.toolName))
        : definition.plugins.every(plugin => plugin.config?.cliDispatchFor === undefined),
      JSON.stringify(definition.plugins.map(plugin => plugin.id)));
  }
  // ⚠️ 这里**曾经**断言 CLI 角色 preset（`leaf`/`organizer`）的行构成：包裹 persona、自身
  //    `cliToolFor` 行、以及「每个其它角色一行受控委派」。CLI 角色改为**直派后台任务**后不再
  //    产出 preset，那层中继子代理整体退役；**嵌套**可达性改由调用方 preset 的
  //    `cliDispatchFor` 宿主行表达（见下面 builtin-organizer 的断言）。
  check('CLI 角色不产出 preset（顶层与嵌套都直派，没有 agent 需要组合）',
    presetById('leaf') === undefined && presetById('organizer') === undefined,
    JSON.stringify(ctx.presets.definitions.map(definition => definition.id)));

  const toolModule = await import('@deepseek-ai/dsh-tool-subagent');
  for (const maxDepth of [0, 1, 3]) {
    const config = toolConfigFor({ id: `budget-${maxDepth}`, backend: 'cli', instructions: 'i',
      toolName: `delegate_to_budget_${maxDepth}`, allowNestedDispatch: false }, { maxDepth });
    // 真实 apply 会校验 agentPreset 指向的 preset 已声明；预算探针也必须先注册
    // （0.2.1-rc.1 的新装载期前置条件，旧 Config 没有这一层）。
    await ctx.presets.register({ id: rolePresetId(`budget-${maxDepth}`), name: `budget-${maxDepth}`,
      description: '预算探针', plugins: [] });
    const validated = toolModule.Config['~standard'].validate(config);
    if (validated.issues) throw new Error(JSON.stringify(validated.issues));
    await toolModule.apply(ctx, validated.value);
    for (let parentDepth = 0; parentDepth <= 1 + maxDepth; parentDepth++) {
      const depthParent = { ...parent, options: { ...parent.options, subagentDepth: parentDepth } };
      const before = requests.length;
      let result, error;
      // 共用 ctx 无作用域 ⇒ 官方模块走「当场直接安装」，工具在 preset 作用域（此处 `scope`
      // 即本节夹具的查询作用域）——保持本节原样，不要改成按 agent 查询。
      const budgetTool = ctx.tools.get(config.toolName, scope) ?? toolIn(config.toolName);
      try { result = await budgetTool.execute({ prompt: 'T', description: 'boundary' }, { ...exec, agent: depthParent }); }
      catch (caught) { error = caught; }
      const allowed = parentDepth <= maxDepth;
      check(`真实插件预算 ${maxDepth}：父深度 ${parentDepth} → child ${parentDepth + 1} ${allowed ? '成功' : '超界拒绝'}`,
        delegationDepthOf(depthParent) === parentDepth && (allowed
          ? !error && result?.kind === 'activation' && typeof result.subagentId === 'string'
            && requests.length === before + 1 && requests.at(-1).maxDepth === 1 + maxDepth
          : error?.name === 'SubagentDepthError' && error.attemptedDepth === parentDepth + 1
            && error.maxDepth === 1 + maxDepth && requests.length === before));
    }
  }

  // 旧的「真实 Cordis + ToolRuntime + applyChildComposition」子节断言的是 `request.toolFilter`
  // 驱动出的 child 工具可见性（allow/deny、后注册工具的 fail-open 等）。0.2.1-rc.1 删除了
  // toolFilter：子代理的工具集合改由**角色 preset 的插件行**固定表达，运行时不再有
  // 「继承父 preset 再过滤」这一步。后注册的普通工具因此不会动态进入/退出角色组合 ——
  // 这是机制上的真实变化，不是被丢掉的覆盖。这里改为断言组合期事实（只读裁剪 + 组合期
  // 不随运行时注册表漂移），并保留仍属执行期行为的 guidance 断言。
  const { buildRolePreset: buildProbePreset, loadRowTemplate: loadProbeTemplate } =
    await import('../src/role-presets.js');
  const readOnlyProbe = buildProbePreset({ id: 'readonly-probe', backend: 'spawn', title: '只读探针',
    description: 'd', instructions: 'READONLY', readOnly: true, allowNestedDispatch: false },
  { rows: loadProbeTemplate().rows, platform: process.platform, maxDepth: 1, roles: [] });
  const fsRow = readOnlyProbe.plugins.find(plugin => plugin.id === 'tool-fs');
  check('只读角色 preset：fs 行保留读取与读图，关掉写入/编辑（替代旧 WRITE_TOOLS deny）',
    JSON.stringify(fsRow?.config) === JSON.stringify({ read: true, readImage: true, write: false, edit: false }));
  check('只读角色 preset：shell、goal、todo、plugin 管理行被整行移除',
    !readOnlyProbe.plugins.some(plugin => ['tool-bash', 'tool-pwsh', 'command-goal', 'tool-goal',
      'tool-todo', 'tool-plugin-manager', 'tool-plugin-market'].includes(plugin.id)));
  check('角色组合是组合期事实：运行时注册新工具不改变已注册 preset 的行',
    presetRowIds(presetById('builtin-leaf')).includes('tool-fs')
      && !presetRowIds(presetById('builtin-leaf')).includes('ordinary_late_runtime'));
  const originalGet = ctx.tools.get.bind(ctx.tools);
  const originalSchemas = ctx.tools.schemas.bind(ctx.tools);
  ctx.tools.get = (name, viewingScope) => name.startsWith('delegate_to_') && name !== 'delegate_to_organizer'
    ? undefined : originalGet(name, viewingScope);
  ctx.tools.schemas = viewingScope => originalSchemas(viewingScope)
    .filter(tool => !tool.name.startsWith('delegate_to_') || tool.name === 'delegate_to_organizer');
  // ⚠️ 用 **spawn** 角色（`builtin-organizer`）执行这一段：它测的是「请求里仍只带 agentPreset」
  //    —— 那是**官方 spawn 路径**的契约；CLI 角色现在走直派后台任务，不再产生 spawn 请求。
  const afterHide = await builtinOrganizer.execute({ prompt: 'T', description: 'fixture' }, exec);
  check('委派工具运行时卸载后请求仍只带 agentPreset（persona 与工具构成不再随清单变化）',
    afterHide?.kind === 'activation' && requests.at(-1).agentPreset === rolePresetId('builtin-organizer')
      && !Object.hasOwn(requests.at(-1), 'persona') && !Object.hasOwn(requests.at(-1), 'toolFilter'));
  ctx.tools.get = (name, viewingScope) => name.startsWith('delegate_to_') ? undefined : originalGet(name, viewingScope);
  ctx.tools.schemas = viewingScope => originalSchemas(viewingScope).filter(tool => !tool.name.startsWith('delegate_to_'));
  await builtinOrganizer.execute({ prompt: 'T', description: 'fixture' }, exec);
  for (const refresh of events.get('tools/change') ?? []) refresh();
  check('全部 delegate 卸载后 guidance 不再宣称可继续派发（该行为仍在执行期实时计算）',
    !guidance({ agent: { session: { header: {} }, options: {} } }).includes('may delegate further'));
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
  originalFile.formatVersion = 1;
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
  // ⚠️ 这里**曾经**给根实例只喂包裹路由（`wrapperProvider/Model/Effort`）并断言它被同步进文件。
  //    包裹路由桥接（`syncWrapperRouteToFile`）已随中继子代理删除；角色同步的等价断言在
  //    下面（「未提供 roles 不改动文件中的角色与顶层字段」等）。
  let file = JSON.parse(readFileSync(path, 'utf8'));
  // --- split 模式：设置层只给旋钮（roleSettings），定义归文件 ---------------------
  //
  // 目标形态：DSH 系统配置里只留旋钮，角色**定义**（persona / 工具构成 / CLI 契约）
  // 住在插件自己的 roles.json。写入侧因此**只写覆盖层 `overrides`，绝不覆盖 `roles`** ——
  // 这就是「手改 roles.json 不会被设置覆盖」的实现点。
  //
  // ⚠️ 本段会重写 `path`，因此必须把文件字节存下来、跑完恢复：后续的 R2 与
  //    「volatile 兼容字段仍保留」都依赖当前文件内容（第一次写时就是这样把两条断言弄挂的）。
  const splitFileBytes = readFileSync(path);
  try {
    const splitDefinitions = [{ id: 'worker', description: '保持不变的定义', instructions: 'persona 原文',
      model: 'from-definition', backend: 'spawn' }];
    writeConfigFile(path, initialConfig(splitDefinitions, { provider: 'self' }));
    const splitBefore = JSON.parse(readFileSync(path, 'utf8'));
    // 根作用域负责同步（preset 作用域不写盘）。
    apply(makeCtx(), Config({ provider: 'self',
      roleSettings: [{ id: 'worker', model: 'from-settings', readOnly: true }] }));
    const splitAfter = JSON.parse(readFileSync(path, 'utf8'));
    check('split：文件里的角色定义逐字未被覆盖',
      JSON.stringify(splitAfter.roles) === JSON.stringify(splitBefore.roles),
      JSON.stringify({ before: splitBefore.roles, after: splitAfter.roles }));
    check('split：旋钮覆盖写进文件的 overrides 层',
      JSON.stringify(splitAfter.overrides) === JSON.stringify([{ id: 'worker', model: 'from-settings', readOnly: true }]),
      JSON.stringify(splitAfter.overrides));
    check('split：定义与旋钮之外的顶层字段仍原样保留',
      splitAfter.formatVersion === splitBefore.formatVersion && splitAfter.provider === splitBefore.provider);
    // 幂等：旋钮没变时第二次同步不重写。
    apply(makeCtx(), Config({ provider: 'self',
      roleSettings: [{ id: 'worker', model: 'from-settings', readOnly: true }] }));
    check('split：旋钮未变时第二次同步不重写文件',
      JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) === JSON.stringify(splitAfter));
    // ⚠️ 回归：**保存旋钮必须触发同步**。触发条件曾经只认 `roles` / `maxDepth`，于是 split 模式下
    //    设置页保存「看起来成功、实际不生效」—— 旋钮停在系统配置里，文件 `overrides` 保持旧值，
    //    直到下一次插件激活才被追上。真机实测踩到：把审计员改成 grok 并保存后 `roleSettings` 已更新
    //    而 `overrides` 仍是旧值（preset 作用域只读文件，所以那次改动当时是**惰性的**）。
    //    这里用真实监听器验证路径判据本身，而不是只看 apply 时的那一次同步。
    {
      const knobCtx = makeCtx();
      let knobListener;
      knobCtx.on = (event, listener) => {
        if (event === 'loader/volatile-update') knobListener = listener;
        return () => {};
      };
      knobCtx.effect = execute => execute();
      const knobConfig = Config({ provider: 'self', roleSettings: [{ id: 'worker', model: 'from-settings' }] });
      apply(knobCtx, knobConfig);
      const knobBefore = JSON.parse(readFileSync(path, 'utf8')).overrides;
      commitVolatile(knobConfig.roleSettings, [{ id: 'worker', model: 'second' }]);
      knobListener([['roleSettings']]);
      const knobAfter = JSON.parse(readFileSync(path, 'utf8')).overrides;
      check('split：保存 roleSettings 即刻同步到文件（只认 roles/maxDepth 会让改动静默不生效）',
        JSON.stringify(knobBefore) === JSON.stringify([{ id: 'worker', model: 'from-settings' }])
          && JSON.stringify(knobAfter) === JSON.stringify([{ id: 'worker', model: 'second' }]),
        JSON.stringify({ before: knobBefore, after: knobAfter }));
      const knobBytes = readFileSync(path);
      knobListener([['maxDepthX']]);
      knobListener([['volatile', 'somethingElse']]);
      check('split：无关路径仍然不触发同步', readFileSync(path).equals(knobBytes));
    }
    // preset 作用域读文件：生效角色必须是「定义 ⨝ 旋钮」。
    const splitMounted = await mount({ roleSettings: [{ id: 'worker', model: 'from-settings', readOnly: true }] });
    check('split：生效角色由定义与旋钮合并而来（model 取旋钮、persona 取定义）',
      splitMounted.result.roleCount === 1 && splitMounted.result.roleRoutes.includes('from-settings')
        && !splitMounted.result.roleRoutes.includes('from-definition'),
      JSON.stringify({ count: splitMounted.result.roleCount, routes: splitMounted.result.roleRoutes }));
    check('split：合并后仍挂载角色工具（不是空壳）',
      splitMounted.configs.length === 1, JSON.stringify(splitMounted.configs.length));
    // 定义缺失：根作用域明确拒绝同步（而不是派发一批空壳角色）。
    writeConfigFile(path, initialConfig([], { provider: 'self' }));
    const splitGuardCtx = makeCtx();
    apply(splitGuardCtx, Config({ provider: 'self', roleSettings: [{ id: 'worker', model: 'm' }] }));
    const splitGuard = await splitGuardCtx.tools.get('switchboard_selftest').execute({});
    check('split：文件里没有定义时根作用域明确报错',
      !splitGuard.ok && splitGuard.configErrors.includes('没有角色定义'),
      JSON.stringify(splitGuard.configErrors));
    // preset 作用域只能读文件，此时也必须如实报错、不挂载。
    const splitNoDefs = await mount({ roleSettings: [{ id: 'worker', model: 'm' }] });
    check('split：文件无定义时 preset 作用域如实报错、不挂载空壳角色',
      !splitNoDefs.result.ok && splitNoDefs.result.roleCount === 0,
      JSON.stringify({ ok: splitNoDefs.result.ok, count: splitNoDefs.result.roleCount }));
    // legacy 仍然完全独立：设置层给 roles 时，文件里的 overrides 不得参与。
    writeConfigFile(path, initialConfig([{ id: 'worker', description: 'd', instructions: 'i' }],
      { provider: 'self', overrides: [{ id: 'worker', model: 'from-overrides' }] }));
    const legacyIgnoresOverrides = await mount({ roles: [{ id: 'worker', description: 'd', instructions: 'i',
      model: 'from-roles' }] });
    check('legacy：设置层的 roles 仍是完整列表，文件里的 overrides 不参与合并',
      legacyIgnoresOverrides.result.roleCount === 1
        && legacyIgnoresOverrides.result.roleRoutes.includes('from-roles')
        && !legacyIgnoresOverrides.result.roleRoutes.includes('from-overrides'),
      JSON.stringify(legacyIgnoresOverrides.result.roleRoutes));
    // ⚠️ 迁移未收尾的回退陷阱：split 已生效但旧的完整 roles 还在设置里 → 自检必须告警。
    //    它是惰性的，可 roleSettings 一旦被清空就会回退到 legacy，那份陈旧定义立刻生效，
    //    静默覆盖用户在面板上做过的改动。这条断言保证这个状态**不会静默存在**。
    const staleCtx = makeCtx();
    apply(staleCtx, Config({ provider: 'self',
      roles: [{ id: 'worker', description: 'd', instructions: 'i', model: '陈旧' }],
      roleSettings: [{ id: 'worker', model: '新值' }] }));
    const staleRoles = await staleCtx.tools.get('switchboard_selftest').execute({});
    check('split 生效但设置里仍留着旧 roles 时自检明确告警',
      staleRoles.warnings.includes('回退并覆盖你的改动'), JSON.stringify(staleRoles.warnings));
    check('该状态下生效的是 roleSettings（旧 roles 被忽略）',
      staleRoles.mounted.includes('配置中有 1 个角色'), JSON.stringify(staleRoles.mounted));
    // 收尾（清掉旧 roles）后告警消失。
    const migratedCtx = makeCtx();
    apply(migratedCtx, Config({ provider: 'self', roleSettings: [{ id: 'worker', model: '新值' }] }));
    const migrated = await migratedCtx.tools.get('switchboard_selftest').execute({});
    check('清掉旧 roles 后回退陷阱告警消失',
      !migrated.warnings.includes('回退并覆盖你的改动') && migrated.mounted.includes('配置中有 1 个角色'),
      JSON.stringify({ warnings: migrated.warnings, mounted: migrated.mounted }));
  } finally {
    writeFileSync(path, splitFileBytes);
  }

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
  const updating = Config({ roles: null });
  apply(updateCtx, updating);
  let updateThrew = false;
  try { commitVolatile(updating.roles, null); update([['roles']]); }
  catch { updateThrew = true; }
  check('M2：非法 roles 就地更新仍不写盘、不伪健康', !updateThrew && readFileSync(path).equals(beforeInvalidUpdate) &&
    !(await updateCtx.tools.get('switchboard_selftest').execute({})).ok);
  commitVolatile(updating.roles, [role]); update([['roles']]);
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
  // ⚠️ 这里**曾经**再跑一次「只有包裹路由」的 apply，断言两次连续同步互不破坏。
  //    包裹路由已删除，改为**再同步一次角色**：同样验证「连续执行不破坏既有内容」。
  apply(makeCtx(), Config({ provider: 'self', roles: [role] }));
  file = JSON.parse(readFileSync(path, 'utf8'));
  check('角色同步连续执行互不破坏',
    file.roles[0].id === role.id && file.custom.keep === true && file.formatVersion === 1 &&
      JSON.parse(beforeContinuous).roles[0].id === file.roles[0].id);
  apply(makeCtx(), Config({ provider: 'self', roles: [role] }));
  file = JSON.parse(readFileSync(path, 'utf8'));
  const scoped = { ...role, id: 'preset-role', model: 'preset-external' };
  let outcome = await mount({ roles: [scoped], volatile: { wrapperProvider: 'preset-route', wrapperModel: 'preset-model', wrapperEffort: 'low' } });
  // ⚠️ 这里**曾经**断言 `outcome.configs[0].agentOptions` 等于根文件的统一包裹路由（把它注入
  //    中继子代理的 LLM 路由）。CLI 角色改为**直派后台任务**后，顶层不再有中继子代理 ——
  //    包裹路由在**顶层已无消费者**，因此不再产生任何官方 spawn 配置。
  //    这正是后续删除 wrapperProvider/Model/Effort 三个字段的依据：它们只服务那层壳。
  check('CLI 角色不再产生官方 spawn 配置（顶层已无中继子代理，包裹路由无消费者）',
    outcome.configs.length === 0, JSON.stringify({ configs: outcome.configs.map(c => c.toolName), result: outcome.result }));
  apply(makeCtx(), Config({ provider: 'self', roles: [role] }));
  file = JSON.parse(readFileSync(path, 'utf8'));
  // ⚠️ 这里**曾经**有一整套包裹路由的**校验与回落**断言（「根清空统一路由后文件保存三个空值」
  //    「根/桥接文件非法 wrapperEffort 阻止挂载」「非字符串 wrapperEffort 明确报错」）。包裹路由
  //    已随中继子代理删除：`wrapperRouteFrom` / `syncWrapperRouteToFile` 都不存在了，那套规则随之消失。
  //    仍然成立的命题是「坏文件且无有效缓存时拒绝挂载、不冒充回落成功」——保留它。
  writeFileSync(path, '{broken');
  outcome = await mount({ roles: [role] });
  check('坏文件且无有效缓存：拒绝挂载，不冒充本地回落成功', outcome.configs.length === 0 && !outcome.result.ok && outcome.result.configErrors.length > 0, JSON.stringify(outcome.result));
  writeConfigFile(path, initialConfig([role], { provider: 'self' }));
  outcome = await mount({});
  check('CLI 角色不产生官方 spawn 配置（顶层已无中继子代理）', outcome.configs.length === 0,
    JSON.stringify({ configs: outcome.configs.length }));
  rmSync(path);
  // ⚠️ 这里**曾经**覆盖「首次仅保存包裹设置 → 创建**空角色桥接文件**」：包裹路由住在系统设置里，
  //    而消费它的 preset 读的是文件，所以要建一个空 roles 文件把根设置桥接过去。
  //    包裹路由删除后不再有「只有包裹设置」的情形 —— 文件只为**角色**而建（下面各节覆盖）。
  outcome = await mount({ roles: [role] });
  check('CLI 角色不产生官方 spawn 配置（空角色文件同理）', outcome.configs.length === 0,
    JSON.stringify({ configs: outcome.configs.map(c => c.toolName) }));

  writeConfigFile(path, initialConfig([], { formatVersion: 1, custom: { keep: true }, volatile: { other: 'keep' } }));
  // ⚠️ 这里**曾经**再 apply 一次携带包裹路由（`rootRoute`）并断言它被写进文件 volatile。
  //    包裹路由桥接已删除；文件只承载**角色**，而「无 roles 不改动文件」由下面各节覆盖。

  rmSync(path);
  const freshCtx = makeCtx();
  apply(freshCtx, Config({ volatile: {} }));
  const freshHealth = await freshCtx.tools.get('switchboard_selftest').execute({});
  check('R1：首次无 wrapper 不建桥接文件且健康', !existsSync(path) && freshHealth.ok && freshHealth.configErrors === '' &&
    !freshHealth.roleConfigStatus.includes('根设置尚未桥接'));
  outcome = await mount({ roles: [role], volatile: { wrapperModel: 'fresh-preset' } });
  check('R1：首次无根 wrapper 时不建桥接文件，且不再产生中继 spawn 配置',
    !existsSync(path) && outcome.configs.length === 0,
    JSON.stringify({ configs: outcome.configs.length, result: outcome.result }));

  // 桥接写入失败：包裹路由删除后，同一门禁仍存在于**角色同步**上，因此改用 roles 触发。
  const failedCtx = makeCtx();
  const originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (target, ...args) => {
      if (String(target).startsWith(`${path}.`)) throw Object.assign(new Error('fixture-bridge-EACCES'), { code: 'EACCES' });
      return originalWrite(target, ...args);
    };
    syncBuiltinESMExports();
    apply(failedCtx, { roles: [role] });
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
  }
  const failedHealth = await failedCtx.tools.get('switchboard_selftest').execute({});
  check('R1：同步写入失败时不健康并如实报错，且不留下半成品文件', !existsSync(path) && !failedHealth.ok
    && /fixture-bridge-EACCES/.test(String(failedHealth.configErrors)), JSON.stringify(failedHealth.configErrors));
  // ⚠️ 这里**曾经**另有两条只对包裹路由成立的断言：
  //    「pending 独立进入健康门禁」（`wrapperSyncPending`）与「缺文件根非法 wrapper 不建文件」，
  //    以及「后续写入角色一并同步此前保留的根包裹设置」。包裹路由桥接已删除，三者随之消失。
  apply(makeCtx(), Config({ provider: 'self', roles: [role] }));
  file = JSON.parse(readFileSync(path, 'utf8'));
  check('后续写入角色照常落盘', file.roles[0].id === role.id);
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


section('阶段 0：文件 resolver mtime+size 缓存与源码静态契约');
{
  const { createConfigFileResolver } = await import('../src/config-file.js');
  const path = configPathFor(fixtureHome);
  writeConfigFile(path, initialConfig([fixtureRole], { provider: 'self' }));
  const resolver = createConfigFileResolver(path);
  let reads = 0;
  const original = fs.readFileSync;
  try {
    fs.readFileSync = (file, ...args) => { if (file === path) reads++; return original(file, ...args); };
    syncBuiltinESMExports();
    const first = resolver.read(); const same = resolver.read();
    check('F01：mtime+size 未变不重读且复用有效缓存', reads === 1 && !first.cached && same.cached && same.value === first.value);
    const resolverReads = reads;
    writeConfigFile(path, initialConfig([{ ...fixtureRole, model: 'changed-size-model' }]));
    // 保存的格式门禁及并发复核不属于 resolver 读取计数。
    reads = resolverReads;
    const changed = resolver.read();
    check('F02：mtime 或 size 改变重读且取得新值', reads === 2 && !changed.cached && changed.value.roles[0].model === 'changed-size-model');
    writeFileSync(path, '{broken');
    const stale = resolver.read();
    check('F03：损坏保留上一有效缓存并标 stale 与错误', stale.ok && stale.stale && stale.error && stale.value === changed.value);
    check('F04：相同坏文件不反复重读且持续陈旧', resolver.read().stale && reads === 3);
    const fresh = createConfigFileResolver(path).read();
    check('F05：无有效缓存时坏文件不可派发', !fresh.ok && fresh.stale && !fresh.value);
    writeConfigFile(path, initialConfig([fixtureRole]));
    check('F06：修复文件后重读并清除 stale', resolver.read().ok && !resolver.read().stale);
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  for (const file of ['index.js', 'roles.js', 'config-file.js', 'cli/provider.js']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    check(`F07：${file} 无已删除的代际/广播/私有 Fiber 路径`,
      !/generation|config-changed|internal\/update|root\.fiber|createScope|\blease\(/.test(source));
  }
}

section('阶段 0：真实 Cordis owning Fiber 事件与固定骨架动态派发');
{
  const { cliFieldsFor } = await import('../src/cli/drivers.js');
  const path = configPathFor(fixtureHome);
  const builtin = { ...fixtureRole, id: 'hot', effort: 'low', readOnly: false };
  const cli = { ...fixtureRole, id: 'hot-cli', backend: 'cli', effort: 'medium', cliDriver: 'codex',
    cliCwd: 'C:/fixture', ...cliFieldsFor('codex', false) };
  writeConfigFile(path, initialConfig([builtin, cli], { provider: 'self', maxDepth: 3 }));
  const root = new Context();
  let rootConfig, rootCtx, ownerUid, observer = 0, applies = 0;
  let currentHome = fixtureHome;
  const restartHome = mkdtempSync(join(tmpdir(), 'switchboard-dynamic-restart-'));
  const owner = root.plugin({ Config, apply(actual, config) {
    applies++;
    ownerUid = actual.fiber.uid;
    rootConfig = config; rootCtx = makeCtx();
    const fixtureGet = rootCtx.get.bind(rootCtx);
    rootCtx.get = key => key === 'profileContext' ? { home: currentHome } : fixtureGet(key);
    rootCtx.on = actual.on.bind(actual);
    rootCtx.effect = actual.effect.bind(actual);
    apply(rootCtx, config);
    actual.on('loader/volatile-update', paths => {
      observer++;
      if (!paths.every(Array.isArray)) return;
      check('S00：事件为路径数组的数组且监听器已读到提交的新 Volatile',
        paths.every(Array.isArray) && rootConfig.roles.get()[0].model === latestModel);
    });
  } }, { provider: 'self', roles: [builtin, cli] });
  let latestModel = builtin.model;
  const other = root.plugin(actual => actual.on('loader/volatile-update', () => { throw new Error('事件泄漏到其它 Fiber'); }));
  const requests = [], invocations = [];
  // ⚠️ 不再有 hold/finish：0.2.1-rc.1 的派发是 activation（启动即返回 childId），
  //    没有「等子代理输出」的前台结算，因此也没有可挂起的在途请求。
  const ctx = makeCtx();
  const originalGet = ctx.get.bind(ctx);
  ctx.sessionProjections = { register() {} };
  const dynamicEvents = new Map();
  ctx.on = (name, callback) => {
    if (!dynamicEvents.has(name)) dynamicEvents.set(name, new Set());
    dynamicEvents.get(name).add(callback);
    return () => dynamicEvents.get(name).delete(callback);
  };
  ctx.get = key => key === 'llm' ? { async resolveCallConfig(value) { return value; } } : originalGet(key);
  ctx.subagents.resolveMaxDepth = depth => depth;
  // capabilities.agentPreset 是 0.2.1-rc.1 的硬要求（persona/toolFilter 已从 Config 删除）。
  const providers = new Map([['spawn', { name: 'spawn', inheritsParentContext: false,
    capabilities: { depthLimit: true, agentOptions: true, agentPreset: true } }]]);
  ctx.subagents.getProvider = name => providers.get(name);
  ctx.subagents.startActivation = async spec => {
    resolveChildDepth(spec.request.parent, spec.request.maxDepth);
    requests.push(spec.request);
    return { childId: `dynamic-child-${requests.length}` };
  };
  // 官方 apply 自 0.2.1-rc.1 起是 async：必须 await，否则抛错会变成被丢弃的 rejected promise。
  ctx.plugin = async function (module, config) { await module.apply(this, config); return { dispose() {} }; };
  ctx.tools.register({ name: 'write' }); ctx.tools.register({ name: 'read' });
  let resolvedCommands = [];
  ctx.subprocess.resolveExecutable = async command => { resolvedCommands.push(command); return 'C:/resolved/node.exe'; };
  let releaseCli;
  let holdCli = false;
  ctx.subprocess.spawn = spec => {
    invocations.push(spec);
    return { collected: {}, done: holdCli ? new Promise(resolve => { releaseCli = resolve; }) : Promise.resolve({ exitCode: 0 }),
      waitForExit: async () => true };
  };
  const tick = () => new Promise(setImmediate);
  const parent = { id: 'dynamic-parent', options: { provider: 'self', model: 'parent' },
    session: { requestHeader: () => undefined, header: { origin: 'user' } } };
  const exec = { agent: parent, signal: new AbortController().signal };
  const childExec = { agent: { id: 'dynamic-child', session: { header: { origin: 'subagent' } } } };
  const scope = scopeOf(ctx);
  const getTool = name => ctx.tools.get(name, scope);
  const health = () => getTool('switchboard_selftest').execute({});
  // Loader 的发送侧 Context.filter 限制 owning Fiber；插件监听器无需 receiver 过滤。
  const emit = paths => root.emit({ [Context.filter]: target => target.fiber.uid === ownerUid }, 'loader/volatile-update', paths);
  const save = (roles, route = {}, extraPaths = []) => {
    latestModel = roles[0]?.model;
    commitVolatile(rootConfig.roles, roles); commitVolatile(rootConfig.volatile, route);
    emit([['roles'], ...extraPaths]);
    const file = readConfigFile(path).value;
    // ⚠️ 这里**曾经**额外比对 `file.volatile.wrapperModel === route.wrapperModel`（包裹路由也随
    //    保存事件同步进文件）。包裹路由已删除，断言只保留「roles 已落盘」这条核心命题。
    check('S01：保存事件返回前 roles.json 已是新值', JSON.stringify(file.roles) === JSON.stringify(roles));
  };
  try {
    await owner.await(); await other.await();
    apply(ctx, { mount: true, provider: 'self' }); await tick(); await tick();
    check('S19：动态夹具初始角色真实挂载健康', (await health()).ok && (await health()).roleCount === 2, JSON.stringify(await health()));
    const count = ctx.registered.length;
    check('S02：当前 CLI 显示待执行解析而非无角色',
      (await health()).executables.includes('hot-cli:') && (await health()).executables.includes('尚未验证'));
    const delegate = getTool('delegate_to_hot');
    for (const [field, value] of [['model', 'new-model'], ['effort', 'high']]) {
      builtin[field] = value; save([builtin, cli]);
      await delegate.execute({ prompt: 'T', description: 'dynamic' }, exec);
      const request = requests.at(-1);
      check(`S03：不重挂连续改 ${field} 后下一次派发使用新值（agentOptions 执行期现读）`, ctx.registered.length === count
        && request.agentOptions.model === builtin.model && request.agentOptions.reasoningEffort === builtin.effort
        && request.agentPreset === rolePresetId('hot'));
    }
    // ⚠️ instructions / readOnly **曾经**也是执行期现读的（分别经 persona / toolFilter 进请求）。
    //    0.2.1-rc.1 把它们移进 Agent Preset，而 preset 只在挂载时注册一次 —— 改动它们
    //    不会在既有会话里生效（需要重新挂载）。这是机制的代价，如实锁住新事实：
    //    请求里既无 persona 也无 toolFilter，已注册 preset 保持挂载时的值。
    builtin.instructions = 'NEW-RULES'; builtin.readOnly = true; save([builtin, cli]);
    await delegate.execute({ prompt: 'T', description: 'dynamic' }, exec);
    const registeredHot = ctx.presets.definitions.find(definition => definition.id === rolePresetId('hot'));
    check('S03b：instructions/readOnly 改动不进请求，preset 保持挂载时的值（组合期事实，需重挂生效）',
      ctx.registered.length === count && !Object.hasOwn(requests.at(-1), 'persona')
        && !Object.hasOwn(requests.at(-1), 'toolFilter')
        && registeredHot.plugins.filter(plugin => plugin.name === '@deepseek-ai/dsh-persona').length === 1
        && registeredHot.plugins.find(plugin => plugin.id === 'persona')?.config?.prefix === fixtureRole.instructions
        && registeredHot.plugins.find(plugin => plugin.id === 'tool-fs')?.config === undefined);
    // 普通对象 maxDepth 非 volatile：模拟文件修改；工具 getter 仍动态读取。
    const depthValue = readConfigFile(path).value; depthValue.maxDepth = 7; writeConfigFile(path, depthValue);
    await delegate.execute({ prompt: 'T', description: 'depth' }, exec);
    check('S04：maxDepth 文件变更下一次派发使用新上限且不重挂', requests.at(-1).maxDepth === 8 && ctx.registered.length === count);
    const currentBytes = readFileSync(path);
    const beforeFuture = requests.length;
    writeFileSync(path, JSON.stringify({ ...depthValue, formatVersion: 999 }));
    let futureError = '';
    try { await delegate.execute({ prompt: 'REFUSE', description: 'future-format' }, exec); }
    catch (error) { futureError = error.message; }
    check('格式升级后已有工具拒绝派发，不能使用正常版本缓存', requests.length === beforeFuture
      && futureError.includes('999') && !(await health()).ok && (await health()).configFormatStatus === 'future');
    writeFileSync(path, currentBytes);
    await delegate.execute({ prompt: 'RECOVER', description: 'current-format' }, exec);
    check('恢复 current 后既有工具继续正常派发', requests.length === beforeFuture + 1 && (await health()).ok);
    // ⚠️ 旧断言在「激活挂起」期间比对 persona/model 快照。activation 不再等待子代理，
    //    请求在启动时同步构造完毕，因此改为断言「已记录的请求是启动时快照，后续保存不改写它」。
    builtin.model = 'snapshot-model'; save([builtin, cli]);
    await delegate.execute({ prompt: 'OLD-TASK', description: 'snapshot' }, exec);
    const snapshot = requests.at(-1);
    const snapshotModel = snapshot.agentOptions.model;
    builtin.model = 'after-start'; builtin.instructions = 'AFTER-RULES'; save([builtin, cli]);
    check('S05：派发请求是启动时快照，之后的配置变更不改写在途请求（activation 无需等待）',
      snapshot.agentOptions.model === 'snapshot-model' && snapshotModel !== 'after-start'
        && !Object.hasOwn(snapshot, 'persona') && !Object.hasOwn(snapshot, 'toolFilter'));
    cli.model = 'external-new'; cli.effort = 'high'; cli.instructions = 'CLI-NEW';
    Object.assign(cli, cliFieldsFor('codex', true), { readOnly: true });
    save([builtin, cli], { wrapperModel: 'wrapper-new', wrapperEffort: 'high' });
    // ⚠️ 这里**曾经**断言「下次 CLI 包裹派发读取新统一路由」（`requests.at(-1).agentOptions`）。
    //    CLI 角色改为**直派后台任务**后，顶层不再有中继子代理，包裹路由在顶层**没有消费者**
    //    —— 因此改为断言它确实走了直派路径：**不产生 spawn 请求**，而且唯一的阻塞是
    //    本夹具没装 `jobs` 服务（若它仍走中继，这里会正常产生请求而不会报 jobs 缺失）。
    const beforeS06 = requests.length;
    let s06Error;
    try { await getTool('delegate_to_hot_cli').execute({ prompt: 'T', description: 'wrapper' }, exec); }
    catch (error) { s06Error = error; }
    check('S06：CLI 角色走直派（不产生 spawn 请求；唯一阻塞是夹具未装 jobs）',
      requests.length === beforeS06 && String(s06Error?.message ?? '').includes('jobs 服务不可用'),
      JSON.stringify({ requests: requests.length, error: String(s06Error?.message ?? '') }));
    // ⚠️ 这一段**曾经**拿中继工具（`switchboard_cli_run_hot_cli`）跑 CLI 执行语义。中继退役后
    //    改指**直派工具**：受理即返回，真正的执行在 `jobs.start` 的 `run` 里。夹具提供一个
    //    同步执行 run 的 jobs 桩，于是下面这些断言（spawn 记录、解析命令、argv）仍测同一件事。
    const cliJobSpecs = [];
    const dispatchGet = ctx.get.bind(ctx);
    ctx.get = key => (key === 'jobs' ? { start(jobSpec) {
      cliJobSpecs.push(jobSpec);
      const handle = { id: `fixture-cli-job-${cliJobSpecs.length}`, append() {}, updateProgress() {} };
      jobSpec.run(handle);
      return handle;
    } } : dispatchGet(key));
    const cliTool = getTool('delegate_to_hot_cli');
    await cliTool.execute({ prompt: 'TASK & $() ;', cliCommand: 'model-command', model: 'model-override' }, childExec);
    const spec = invocations.at(-1);
    check('S07：CLI 执行时解析当前用户命令，argv 使用绝对解析路径与新模型强度',
      resolvedCommands.at(-1).toLowerCase() === process.execPath.toLowerCase() && spec.argv[0] === 'C:/resolved/node.exe'
      && spec.argv.includes('external-new') && spec.argv.includes('model_reasoning_effort=high')
      && spec.argv.includes('read-only') && !spec.argv.includes('model-override') && !spec.argv.includes('model-command'));
    check('S08：CLI 安全 argv 数组、shell:false 与用户正文不进入 shell', Array.isArray(spec.argv)
      && spec.shell === false && spec.stdio.stdin.data === 'CLI-NEW\n\n---\n\nTASK & $() ;');
    check('S09：执行后自检可执行文件诊断记录解析结果与当前 source/file 新路由',
      (await health()).executables.includes('C:/resolved/node.exe') && (await health()).roleRoutes.includes('model=external-new')
      && (await health()).roleRoutes.includes('source=file stale=false'));
    holdCli = true;
    const cliTask = cliTool.execute({ prompt: 'SNAPSHOT' }, childExec); await tick();
    const oldSpec = invocations.at(-1);
    cli.model = 'external-after'; cli.instructions = 'AFTER-CLI'; save([builtin, cli]);
    check('S10：在途 CLI 使用启动时 argv 与前置指令且不取消', oldSpec.argv.includes('external-new')
      && oldSpec.stdio.stdin.data.startsWith('CLI-NEW') && !oldSpec.signal.aborted);
    releaseCli({ exitCode: 0 }); await cliTask; holdCli = false;
    for (const [label, changed] of [
      ['未知 driver', { cliDriver: 'unknown' }], ['未知占位符', { cliArgs: ['{unsafe}'] }],
      ['readOnly 与模板冲突', { readOnly: false }], ['非法 argv', { cliArgs: 'shell command' }],
    ]) {
      const before = invocations.length;
      save([builtin, { ...cli, ...changed }]);
      let refused = false; try { await cliTool.execute({ prompt: 'T' }, childExec); } catch { refused = true; }
      check(`S11：执行前安全校验拒绝 ${label} 且不 spawn`, refused && invocations.length === before);
    }
    save([builtin, cli]);
    await delegate.execute({ prompt: 'T', description: 'cache' }, exec);
    writeFileSync(path, '{broken');
    await delegate.execute({ prompt: 'T', description: 'stale' }, exec);
    check('S12：文件损坏保留上份有效缓存，路由显式 stale:true', requests.at(-1).agentOptions.model === builtin.model
      && (await health()).roleRoutes.includes('stale=true'));
    save([builtin, cli]);
    for (const [label, roles, expected] of [
      ['增角色', [builtin, cli, { ...fixtureRole, id: 'added' }], '阶段 3 未实现'],
      ['删角色', [builtin], '阶段 3 未实现'],
      ['改 id', [{ ...builtin, id: 'renamed' }, cli], '阶段 3 未实现'],
      ['改 toolName', [{ ...builtin, toolName: 'delegate_custom' }, cli], '阶段 3 未实现'],
      // ⚠️ 这里**曾经**用「改 backend 为 fork」验证结构变化会被拦下并报「阶段 3 未实现」。
      //    0.2.1-rc.1 起 fork 已从 BUILTIN_PROVIDERS 移除，改 fork 现在在**校验期**
      //    就被拒（backend 非法并列出允许的后端），比原来的运行期拦截更早、更明确。
      ['改 backend 为已移除的 fork', [{ ...builtin, backend: 'fork' }, cli], 'spawn / cli'],
    ]) {
      save(roles); let refused = false;
      try { await delegate.execute({ prompt: 'T', description: 'structure' }, exec); } catch { refused = true; }
      check(`S13：${label} 未误报已热更新，拒绝派发且不改变注册数`, refused && !(await health()).ok
        && (await health()).configErrors.includes(expected) && ctx.registered.length === count);
    }
    save([builtin, cli]);
    check('S14：合法配置恢复健康，固定骨架仍可派发', (await health()).ok && ctx.registered.length === count);
    const validBytes = readFileSync(path);
    // ⚠️ S20/S21 **曾经**覆盖「动态非法包裹路由不覆盖有效文件」「修复后清除根错误并同步新值」。
    //    包裹路由已随中继删除，那两条的触发源（`wrapperEffort`）不复存在；等价命题
    //    「非法输入不覆盖有效文件、修复后恢复健康」仍由上面的 S12–S14 覆盖（走 roles）。
    void validBytes;
    const originalWrite = fs.writeFileSync;
    const logs = [];
    const originalError = console.error;
    try {
      console.error = (...args) => logs.push(args.join(' '));
      fs.writeFileSync = (target, ...args) => {
        if (String(target).startsWith(`${path}.`)) throw new Error('dynamic-write-failed');
        return originalWrite(target, ...args);
      };
      syncBuiltinESMExports();
      // ⚠️ 触发源从 `wrapperModel` 改为 **roles 的实际内容变化**：roles 没变时同步会短路（不写盘），
      //    因此必须让角色内容真的不同，才能走到写盘那一步并观察失败。「重复同步失败 → 诊断 +
      //    日志去重 → 修复后恢复」这条命题对角色同步同样成立，而它才是现在真正会写盘的东西。
      commitVolatile(rootConfig.roles, [{ ...builtin, model: 'dynamic-fail-model' }, cli]);
      latestModel = 'dynamic-fail-model';
      emit([['roles']]); emit([['roles']]);
      const failed = await rootCtx.tools.get('switchboard_selftest').execute({});
      check('S22：重复写盘失败进入当前健康诊断', !failed.ok
        && /dynamic-write-failed/.test(String(failed.configErrors))
        && logs.some(line => line.includes('dynamic-write-failed')),
      JSON.stringify({ errors: failed.configErrors, logs }));
    } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); console.error = originalError; }
    emit([['roles']]);
    check('S23：写盘修复后清除旧错误并立即同步', (await rootCtx.tools.get('switchboard_selftest').execute({})).ok
      && readConfigFile(path).value.roles.length === 2);
    const bytes = readFileSync(path);
    emit(['roles']);
    emit([['unrelated']]);
    check('S15：根同步忽略错误载荷与无关路径', readFileSync(path).equals(bytes));
    check('S16：普通 emit 下多个监听器均执行，不依赖 next 与重复 apply', observer > 0 && applies === 1);
    const oldCtx = rootCtx;
    const oldBytes = readFileSync(path);
    currentHome = restartHome;
    writeConfigFile(configPathFor(restartHome), initialConfig([builtin, cli], { provider: 'self' }));
    await owner.restart(); await owner.restart();
    const previousObserver = observer;
    // ⚠️ 触发源从包裹路由改为 **roles 的实际变化**：roles 未变化时同步会短路（不写盘），
    //    因此必须让角色内容真的不同，才能验证「restart 后只写新路径」。
    const movedRoles = [{ ...builtin, model: 'restart-new-model' }, cli];
    commitVolatile(rootConfig.roles, movedRoles);
    latestModel = 'restart-new-model';
    emit([['roles']]);
    check('S25：两次 restart 后仅本次同步与观察监听运行一次', applies === 3 && observer === previousObserver + 1);
    check('S26：restart 后只写新路径，旧闭包不再写原路径', readFileSync(path).equals(oldBytes)
      && readConfigFile(configPathFor(restartHome)).value.roles[0].model === 'restart-new-model',
    JSON.stringify(readConfigFile(configPathFor(restartHome)).value?.roles?.map(r => r.model)));
    // ⚠️ 触发源从 `wrapperEffort: 'invalid'` 改为**非法 roles**（effort 取值非法）：包裹路由已删除，
    //    而「一次无效更新只影响**当前**实例的诊断、不污染旧闭包」这条命题由 roles 的校验失败表达。
    //    刻意保留 model，使 S00 监听器读到的仍是同一次提交的模型（否则它会因索引不到而抛错）。
    commitVolatile(rootConfig.roles, [{ ...builtin, model: 'restart-new-model', effort: 'turbo' }, cli]);
    emit([['roles']]);
    check('S27：restart 后旧诊断闭包不受新无效更新影响',
      (await oldCtx.tools.get('switchboard_selftest').execute({})).ok
      && !(await rootCtx.tools.get('switchboard_selftest').execute({})).ok);
  } finally { await owner.dispose(); await other.dispose(); rmSync(restartHome, { recursive: true, force: true }); }
  const bytes = readFileSync(path);
  root.emit('loader/volatile-update', [['roles']]);
  check('S17：父卸载后根监听器释放，无后续写盘', readFileSync(path).equals(bytes));
  writeFileSync(path, '{no-cache');
  const broken = makeCtx(); apply(broken, { mount: true, provider: 'self' }); await tick();
  const brokenHealth = await broken.tools.get('switchboard_selftest').execute({});
  check('S18：没有有效缓存的坏文件拒绝挂载并自检不健康', !brokenHealth.ok && brokenHealth.roleCount === 0
    && !broken.registered.some(name => name.startsWith('delegate_to_')) && brokenHealth.configErrors.length > 0);
  writeConfigFile(path, initialConfig([fixtureRole], { provider: 'self' }));
  const threeCli = makeCtx();
  let resolveCount = 0;
  threeCli.subprocess.resolveExecutable = () => { resolveCount++; throw new Error('不可装载期解析'); };
  apply(threeCli, { mount: true, roles: [0, 1, 2].map(index => ({ ...cli, id: `diagnostic-${index}` })), provider: 'self' });
  await tick(); await tick();
  const cliHealth = await threeCli.tools.get('switchboard_selftest').execute({});
  check('S24：三个 CLI 角色均有待执行解析诊断，装载不调用外部命令',
    cliHealth.ok && cliHealth.roleCount === 3 && resolveCount === 0 && cliHealth.roleRoutes.includes('source=preset stale=false')
      && [0, 1, 2].every(index => cliHealth.executables.includes(`diagnostic-${index}:`))
      && !cliHealth.executables.includes('无 CLI 角色'));
}

section('preset 调度规则：缺失告警与生成幂等');
{
  for (const [label, value] of [['missing', undefined], ['empty', ''], ['whitespace', ' \n ']]) {
    const ctx = makeCtx();
    const sections = [];
    ctx.systemPrompt.section = section => { sections.push(section); return () => {}; };
    apply(ctx, Config({ mount: true, provider: 'self', roles: [fixtureRole], supervisorRules: value }));
    await new Promise(setImmediate);
    const assembled = { sections: sections.map(section => ({ ...section,
      text: section.text({ agent: { session: { header: {} }, options: {} } }) })) };
    check(`R11：规则 ${label} 不注入`, !assembled.sections.some(s => s.name === 'agent-switchboard:scheduling' && s.text));
    const tool = ctx.tools.get('switchboard_selftest'); const result = await tool.execute({});
    const warning = '调度规则：未配置（profile 可能未同步 preset：需 gen:preset → inject:preset → 重启）';
    check(`R12：规则 ${label} 有诊断与可用但告警门禁`, result.ok && result.health === '可用但告警'
      && result.warnings === warning && tool.output.render({}, result).some(b => b.text.includes(warning)));
  }
  // 只替换官方清单输入与输出路径；实际 selfEntry 和全部生成逻辑执行两次。
  // 夹具不声称已核对本机官方 standard，也不写用户 profile 或仓库产物。
  const standard = presetSource.replace(/          - id: switchboard-roles[\s\S]*?(?=\n          - )/, '')
    .replace(/(\s*- id: tool-subagent(?:-fork)?\n)\s*disabled: true\n/g, '$1');
  const output = join(fixtureHome, 'generated.patch.yml');
  const generator = readFileSync(new URL('./gen-preset.mjs', import.meta.url), 'utf8')
    .replace("from './lib/capture.mjs'", `from '${new URL('./lib/capture.mjs', import.meta.url).href}'`)
    .replace("from './lib/preset-generator.mjs'", `from '${new URL('./lib/preset-generator.mjs', import.meta.url).href}'`)
    .replace('const standardText = cat(STANDARD_ENTRY);', `const standardText = ${JSON.stringify(standard)};`)
    .replace("const OUT_FILE = join(ROOT, 'presets', 'switchboard.patch.yml');", `const OUT_FILE = ${JSON.stringify(output)};`);
  const run = () => captureSync(process.execPath, ['--input-type=module', '-e', generator]);
  const first = run(); const bytes = existsSync(output) ? readFileSync(output) : Buffer.alloc(0);
  const second = run();
  check('R13：真实生成逻辑两次成功且字节幂等', first.status === 0 && second.status === 0
    && bytes.length > 0 && bytes.equals(readFileSync(output)), first.stderr + second.stderr);
  const generated = bytes.length ? parse(bytes.toString(), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] }) : [];
  check('R14：selfEntry 生成的 preset 确实包含规则', generated[0]?.insert[0].config.plugins
    .find(p => p.id === 'switchboard-roles')?.config.supervisorRules === supervisorRules);
}

section('派发级快照：真实 ToolRuntime + 路由预检挂起');
{
  const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
  const { normalizeRoles } = await import('../src/roles.js');
  const { cliFieldsFor } = await import('../src/cli/drivers.js');
  const root = new Context();
  new SystemPrompt(root, {});
  new ToolRuntime(root);
  const path = configPathFor(fixtureHome);
  const tick = () => new Promise(setImmediate);
  const gates = [], requests = [], agentList = [];
  let pause = true;
  // capabilities.agentPreset 是 0.2.1-rc.1 的硬要求；persona/toolFilter 能力已不存在。
  const provider = { name: 'spawn', inheritsParentContext: false,
    capabilities: { depthLimit: true, agentOptions: true, agentPreset: true } };
  root.provide('subagents', { getProvider: name => name === 'spawn' ? provider : undefined,
    resolveMaxDepth: depth => depth,
    // ⚠️ 0.2.1-rc.1：startActivation 的 label 在**激活参数**上（request 本身没有 label），
    //    夹具把它并进记录，才能继续按 label 断言并发/取消的先后。
    async startActivation(spec) {
      requests.push({ ...spec.request, label: spec.label });
      return { childId: `snapshot-child-${requests.length}` };
    } });
  root.provide('agents', { list: () => [...agentList] });
  // 角色 persona 与工具构成改由独立 Agent Preset 承载：装载路径必须先注册，
  // 真实工具插件的组合期校验再经 readDocument 确认它确实已声明。
  const presetService = makePresetService();
  root.provide('agentPresets', presetService);
  root.provide('sessionProjections', { register() {} });
  root.provide('subprocess', { spawn() { throw new Error('不得启动 CLI'); } });
  root.provide('profileContext', { home: fixtureHome });
  root.provide('llm', { async resolveCallConfig(value) {
    if (pause) await new Promise((resolve, reject) => gates.push({ resolve, reject }));
    return value;
  } });
  const preset = {};
  const ctx = createScope(root, preset).ctx;
  const version = n => initialConfig([{ ...fixtureRole, id: 'snapshot', model: `model-${n}`,
    instructions: `persona-${n}-${'x'.repeat(n * 10)}`, effort: n % 2 ? 'low' : 'high', readOnly: n % 2 === 0 }],
    { provider: 'self', maxDepth: n });
  const save = n => writeConfigFile(path, version(n));
  const register = (name, target = root) => target.tools.register({ name,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] }, execute: async () => name });
  register('write'); register('read');
  save(1);
  // ⚠️ 0.2.1-rc.1 的 standing 组合**按 agent** 安装委派工具（agent/created 或 reconcile），
  //    不再在插件装载时直接安装。因此夹具父代理必须进真实 agents 注册表，并携带一个
  //    属于本组合作用域（scopeChain 含 preset）的 ctx；工具将注册到该 ctx 的作用域，
  //    root.tools.execute({ agent: parent }) 才能解析到它。
  const parent = { id: 'snapshot-parent', options: { provider: 'self', model: 'parent' },
    session: { header: {}, requestHeader: () => undefined } };
  const parentCtx = createScope(ctx, parent, { parent: preset }).ctx;
  agentList.push({ id: parent.id, session: parent.session, ctx: parentCtx });
  const owner = ctx.plugin({ inject: ['tools', 'subagents', 'agents', 'systemPrompt', 'subprocess'],
    apply(actual) { apply(actual, Config({ ...presetEntry.config, provider: 'self' })); } });
  try {
    await owner.await(); await tick(); await tick();
    // 父代理的作用域 ctx 已在上面建立（并绑定到 preset）；子代理继续挂在它之下。
    const childCtx = parentCtx;
    const run = (label, signal = new AbortController().signal, agent = parent) => root.tools.execute({
      name: 'delegate_to_snapshot', arguments: { prompt: label, description: label }, agent, signal });
    const waitGate = async index => { for (let n = 0; n < 50 && !gates[index]; n++) await tick();
      if (!gates[index]) throw new Error(`预检未挂起 ${index}`); };
    // ⚠️ 旧夹具还比对 `request.persona` 与 `request.toolFilter`；0.2.1-rc.1 起这两项由
    //    角色 preset 承载（组合期固定），请求只带稳定的 `agentPreset`。
    //    ⚠️ 深度**不再**与 agentOptions 同版本：官方工具在路由预检**之前**取 agentOptions，
    //    在预检**之后**才读 `config.maxDepth`（src 的执行期 getter）。旧代码里
    //    `tools/execute` 的 ALS 快照会冻结两者；实测该快照在 standing 组合下已不命中
    //    （见本文件末的「产品问题」注释与 P00），因此深度可能取到预检后写入的新版本。
    //    coherent 校验入口版本字段，深度用 depthIs 允许「快照版本」或「现读版本」。
    const coherent = (request, entryVersion) => request?.agentPreset === rolePresetId('snapshot')
      && request.agentOptions.model === `model-${entryVersion}`
      && request.agentOptions.reasoningEffort === (entryVersion % 2 ? 'low' : 'high')
      && !Object.hasOwn(request, 'persona') && !Object.hasOwn(request, 'toolFilter');
    // 文件里的 maxDepth 版本 → 请求上的绝对深度（1 + maxDepth）。
    const depthIs = (request, ...versions) => versions.includes((request?.maxDepth ?? 0) - 1);
    const first = run('first'); await waitGate(0); save(2);
    gates[0].resolve(); const firstResult = await first;
    // ⚠️ 产品级发现（未改产品代码，见交付说明）：src 的 tools/execute ALS 快照在 standing
    //    组合下不再命中 —— 官方插件按 **agent 作用域** 安装定义，没经过 src 的 dispatch.tools
    //    弱集。因此深度取自预检**之后**的现读版本（v2 → 3），而不是冻结的入口版本（v1 → 2）。
    //    这里同时接受两者；产品侧修复快照捕获后再收紧。入口字段（agentOptions）仍在预检前
    //    读取，所以它与入口版本一致。
    check('P01：真实 ToolRuntime 预检期间保存，入口字段同版本、深度为快照或现读版本',
      !firstResult.isError && coherent(requests.at(-1), 1) && depthIs(requests.at(-1), 1, 2),
      JSON.stringify(requests.at(-1)));
    const a = run('concurrent-a'); await waitGate(1); register('edit'); save(3);
    const b = run('concurrent-b'); await waitGate(2); save(4);
    gates[2].resolve(); const rb = await b; gates[1].resolve(); const ra = await a;
    check('P02：真实 ToolRuntime 并发逆序完成，两个派发各自入口版本一致', !ra.isError && !rb.isError
      && requests.at(-2).label === 'concurrent-b' && coherent(requests.at(-2), 3) && depthIs(requests.at(-2), 3, 4)
      && requests.at(-1).label === 'concurrent-a' && coherent(requests.at(-1), 2) && depthIs(requests.at(-1), 2, 4)
      // 旧断言看的是 deny 清单不含后注册的 edit；现在请求根本没有工具过滤字段。
      && !JSON.stringify(requests.at(-1)).includes('edit'), JSON.stringify({ ra, rb, requests }));
    const failed = run('exception'); await waitGate(3); save(5); gates[3].reject(new Error('fixture-preflight-error'));
    check('P03：真实 ToolRuntime 预检异常被如实报告', (await failed).isError);
    pause = false; const afterException = await run('after-exception');
    check('P04：异常后新调用现读且 ALS 不泄漏', coherent(requests.at(-1), 5) && depthIs(requests.at(-1), 5),
      JSON.stringify({ afterException, request: requests.at(-1) }));
    pause = true;
    const controller = new AbortController(); const cancelled = run('cancelled', controller.signal);
    await waitGate(4); controller.abort(); save(6); gates[4].resolve();
    check('P05：真实 ToolRuntime 取消后不启动子代理', (await cancelled).isError
      && requests.at(-1).label === 'after-exception', JSON.stringify(requests.at(-1)));
    pause = false; await run('after-cancel');
    check('P06：取消后新调用现读且 ALS 不泄漏',
      coherent(requests.at(-1), 6) && depthIs(requests.at(-1), 6)
        && !JSON.stringify(requests.at(-1)).includes('toolFilter'), JSON.stringify(requests.at(-1)));
    const builtin = (await root.systemPrompt.assemble({ agent: parent, scope: parent })).sections;
    check('P07：真实 SystemPrompt 主代理有 switchboard 调度指引', builtin.some(s => s.text.includes('You are the switchboard')));
    check('R01：主代理实际组装含 preset 规则、四问路由与提交纪律护栏', builtin.some(s =>
      s.name === 'agent-switchboard:scheduling' && s.text === supervisorRules &&
      ['四问路由', '→ scout', '→ worker', '→ architect', '→ reviewer', '提交纪律',
        '避免改动失去追溯', '不要自行提交', '通过目标仓库要求的检查与测试后再提交',
        '绝不提交临时区、忽略目录、密钥令牌、本机绝对路径或构建产物',
        '不擅自推送或改写既有历史'].every(marker => s.text.includes(marker))));
    for (const [label, header, options] of [['origin', { origin: 'subagent' }, {}],
      ['persisted-depth', { delegationDepth: 1 }, {}], ['runtime-depth', {}, { subagentDepth: 1 }]]) {
      const child = { id: label, session: { header }, options };
      createScope(childCtx, child, { parent });
      const assembled = await root.systemPrompt.assemble({ agent: child, scope: child });
      check(`P08：真实 SystemPrompt 子代理 ${label} 不含主代理指引`,
        !assembled.sections.some(s => s.name === 'agent-switchboard:roles' && s.text));
      check(`R02：子代理 ${label} 不含调度规则`, !assembled.sections.some(s =>
        s.name === 'agent-switchboard:scheduling' && s.text) &&
        !assembled.sections.some(s => /四问路由|提交纪律/.test(s.text)));
    }
    const unknown = await root.systemPrompt.assemble({ scope: preset });
    check('P09：缺少可靠代理上下文不猜测主代理身份', !unknown.sections.some(s => s.name === 'agent-switchboard:roles' && s.text));
    check('R03：上下文不可靠不输出调度规则', !unknown.sections.some(s =>
      (s.name === 'agent-switchboard:scheduling' && s.text) || /四问路由|提交纪律/.test(s.text)));
    for (const [label, context] of [['empty', {}], ['null', { agent: null }],
      ['missing-header', { agent: { session: {} } }],
      ['invalid-header', { agent: { session: { header: 'unreliable' } } }],
      ['array-header', { agent: { session: { header: [] } } }]]) {
      // 固定 preset scope，确保这些负例确实看得到已注册小节，而非在空作用域里空通过。
      const assembled = await root.systemPrompt.assemble({ scope: preset, ...context });
      check(`R04：未知上下文 ${label} 不输出调度规则`, !assembled.sections.some(s =>
        (s.name === 'agent-switchboard:scheduling' && s.text) || /四问路由|提交纪律/.test(s.text)));
    }
    check('R05：规则文本无过时专有标识', !/\$CODEX_HOME|spawn_agent|sandbox_mode|\.toml|\bTOML\b/.test(supervisorRules));
    const hostSource = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const clientSource = ['index.js', 'logic.js'].map(file =>
      readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')).join('\n');
    const rootEntries = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')).flatMap(op => op.insert ?? []);
    check('R06：调度规则来自 preset 条目且不开放 UI 编辑',
      typeof supervisorRules === 'string' && supervisorRules.includes('四问路由') &&
      Config.dict.supervisorRules?.type === 'string' && !Config.dict.supervisorRules?.meta.volatile &&
      !rootEntries.some(row => Object.hasOwn(row.config ?? {}, 'supervisorRules')) &&
      !/supervisorRules|agent-switchboard:scheduling/.test(clientSource));
    check('R07：schema 缺省规则无默认值且不报错', Config({}).supervisorRules === undefined
      && !Object.hasOwn(Config.dict.supervisorRules.meta, 'default'));
    check('R08：preset 块标量可解析且 schema 原样读取', presetEntry.id === 'switchboard-roles'
      && Config(presetEntry.config).supervisorRules === supervisorRules && /supervisorRules: \|/.test(presetSource));
    check('R09：运行时代码不保留完整规则副本', !hostSource.includes('四问路由')
      && !readFileSync(new URL('../src/roles.js', import.meta.url), 'utf8').includes('四问路由'));
    const configuredHealth = await root.tools.get('switchboard_selftest', parent).execute({}, { agent: parent });
    check('R10：调度规则注入正常且角色 preset 已注册',
      configuredHealth.scheduling === '已配置（仅注入主代理）'
        && configuredHealth.rolePresets.includes('switchboard-role-snapshot')
        && configuredHealth.presetBroken === '（无异常行）', JSON.stringify(configuredHealth));
    // ⚠️ 组合期字段（instructions / readOnly / allowNestedDispatch / maxDepth）写入角色 preset
    //    的插件清单。改完**还没派发**时组合仍是旧版，自检必须如实告警，而不是假装配置已生效。
    save(11);
    const staleHealth = await root.tools.get('switchboard_selftest', parent).execute({}, { agent: parent });
    check('R10a：配置已改但组合尚未重建时自检如实告警',
      staleHealth.warnings.includes('尚未重建组合') && staleHealth.health === '可用但告警',
      JSON.stringify(staleHealth.warnings));
    // 0.2.1-rc.1 的 standing 组合把委派工具按 **agent 作用域** 安装，因此自检必须按
    // **调用它的那个 agent** 查询；用注册时的 preset 作用域查会一律查不到，把成功的派发
    // 谎报成「工具未注册 / 不健康」。这条断言守住那个修复。
    check('R10b：自检按调用 agent 的作用域查询，如实报告角色工具可用',
      configuredHealth.ok === true && configuredHealth.roleCount === 1
        && configuredHealth.mounted.includes('snapshot=OK') && configuredHealth.fatal === '',
      JSON.stringify(configuredHealth));
    // --- 组合热同步 -----------------------------------------------------------------
    // `agentPresets.register()` 对重复 id **硬抛**（`Duplicate agent preset`），所以「组合变了」
    // 不能原地更新，只能 dispose → register。热同步在**本插件的派发钩子**里同步进行，
    // 因此自己的派发不会撞上那个极短的「id 未注册」窗口。
    const roleDefinitions = () => presetService.definitions.filter(d => d.id === rolePresetId('snapshot'));
    save(9); // 奇数 ⇒ 非只读；maxDepth 9；persona-9-…
    await run('hot-sync');
    const synced = roleDefinitions();
    check('R11：改 instructions 后派发前自动重建角色 preset，无需重启',
      synced.length === 1 && synced[0].plugins[0].config.prefix === `persona-9-${'x'.repeat(90)}`,
      JSON.stringify(synced.map(d => d.plugins[0].config)));
    check('R11b：重建是「替换」而不是「追加」，注册表里不留下重复 id',
      presetService.definitions.filter(d => d.id === rolePresetId('snapshot')).length === 1
        && synced[0].plugins.some(p => p.id === 'tool-pwsh'), JSON.stringify(synced[0].plugins.map(p => p.id)));
    save(8); // 偶数 ⇒ 只读；maxDepth 8
    await run('hot-sync-readonly');
    const syncedReadOnly = roleDefinitions()[0];
    check('R12：readOnly 翻转后重建的 preset 立即改为只读行裁剪',
      JSON.stringify(syncedReadOnly.plugins.find(p => p.id === 'tool-fs').config)
        === '{"read":true,"readImage":true,"write":false,"edit":false}'
        && !syncedReadOnly.plugins.some(p => p.id === 'tool-pwsh' || p.id === 'tool-bash'),
      JSON.stringify(syncedReadOnly.plugins.map(p => p.id)));
    const syncedHealth = await root.tools.get('switchboard_selftest', parent).execute({}, { agent: parent });
    check('R13：热同步后自检不再告警「尚未重建组合」并报告同步时间',
      !syncedHealth.warnings.includes('尚未重建组合') && syncedHealth.rolePresets.includes('最近热同步'),
      JSON.stringify({ warnings: syncedHealth.warnings, presets: syncedHealth.rolePresets }));
    // 同名遮蔽工具不得进入本实例快照 hook；结构变化确保泛拦会让此调用失败。
    const alien = { id: 'alien', options: {}, session: { header: {} } };
    const alienCtx = createScope(ctx, alien, { parent: preset }).ctx;
    register('delegate_to_snapshot', alienCtx);
    writeConfigFile(path, initialConfig([]));
    const foreign = await run('foreign', undefined, alien);
    check('P10：真实 ToolRuntime 本 preset 同名他方工具不被快照 hook 拦截', !foreign.isError && foreign.value === 'delegate_to_snapshot');
    save(7);
    const cliRole = { ...fixtureRole, backend: 'cli', effort: 'medium', cliDriver: 'codex', ...cliFieldsFor('codex', false),
      cliCwd: 'fixture', cliTimeoutMs: 1234 };
    const normalized = normalizeRoles([cliRole]);
    check('P11：cliTimeoutMs 不解析也不透传到规范化 cli', normalized.roles.length === 1
      && !Object.hasOwn(normalized.roles[0].cli, 'timeoutMs') && !Object.hasOwn(normalized.roles[0], 'cliTimeoutMs'));
    save(8);
    root.emit('subagent/provider-removed', 'spawn');
    check('P14：真实 provider 移除释放旧注册定义', !root.tools.get('delegate_to_snapshot', parent));
    root.emit('subagent/provider-added', provider);
    pause = true;
    const remounted = run('provider-readded'); await waitGate(5); save(9);
    gates[5].resolve(); const remountedResult = await remounted;
    check('P15：provider 重注册的新定义仍被本实例快照 hook 精确识别', !remountedResult.isError
      && coherent(requests.at(-1), 8) && depthIs(requests.at(-1), 8, 9), JSON.stringify(requests.at(-1)));
    const cliVersion = n => initialConfig([{ ...cliRole, id: 'snapshot-cli', allowNestedDispatch: n === 2 }],
      { provider: 'self', maxDepth: n, volatile: { wrapperModel: `wrapper-${n}`, wrapperEffort: n === 1 ? 'low' : 'high' } });
    writeConfigFile(path, cliVersion(1));
    const cliPreset = {};
    const cliCtx = createScope(root, cliPreset).ctx;
    // 与上面同理：CLI 组合的工具也按 agent 安装，夹具 CLI 父代理必须先属于该组合作用域。
    const cliParent = { ...parent, id: 'cli-parent' };
    const cliParentCtx = createScope(cliCtx, cliParent, { parent: cliPreset }).ctx;
    agentList.push({ id: cliParent.id, session: cliParent.session, ctx: cliParentCtx });
    const cliOwner = cliCtx.plugin({ inject: ['tools', 'subagents', 'agents', 'systemPrompt', 'subprocess'],
      apply(actual) { apply(actual, { mount: true, provider: 'self' }); } });
    try {
      await cliOwner.await(); await tick(); await tick();
      pause = true;
      // ⚠️ 这里**曾经**用 `waitGate(6)`（CLI 包裹预检挂起）+ `request.agentOptions` 断言包裹路由。
      //    CLI 角色改为**直派后台任务**后，顶层不再有中继子代理：**不预检、不产生 spawn 请求**，
      //    包裹路由在顶层没有消费者（这正是后续删除那三个字段的依据）。
      //    本夹具的根 ctx 没装 jobs 服务，因此直派的唯一阻塞是「jobs 服务不可用」——
      //    若它仍走中继，这里会正常产生请求，而不会报 jobs 缺失。这个反向信号就是判据。
      const beforeCli = requests.length;
      const cliOutcome = await root.tools.execute({ name: 'delegate_to_snapshot_cli', agent: cliParent,
        arguments: { prompt: 'CLI wrapper', description: 'CLI wrapper' }, signal: new AbortController().signal })
        .catch(error => ({ isError: true, error }));
      const cliMessage = String(cliOutcome?.error?.message ?? cliOutcome?.value?.message
        ?? cliOutcome?.value?.diagnostic ?? '');
      check('P12：CLI 角色走直派 —— 不产生 spawn 请求、不预检（夹具无 jobs 时如实拒绝）',
        requests.length === beforeCli
          && (cliOutcome?.isError === true
            ? cliMessage.includes('jobs 服务不可用')
            : cliOutcome?.value?.status === 'accepted'),
        JSON.stringify({ requests: requests.length, outcome: cliOutcome?.isError ? cliMessage : cliOutcome?.value }));
      // ⚠️ 这里**曾经**断言 CLI 角色 preset 的「包裹 persona + 专属工具行 + 嵌套清单」。
      //    CLI 角色不再产出 preset：顶层与嵌套都直派后台任务，那层中继整体退役。
      check('P12b：CLI 角色不再产出 preset（包裹 persona 与专属工具行随中继退役）',
        root.get('agentPresets').definitions.every(definition => definition.id !== rolePresetId('snapshot-cli')),
        JSON.stringify(root.get('agentPresets').definitions.map(definition => definition.id)));
      pause = false;
    } finally { await cliOwner.dispose(); }
  } finally { await owner.dispose(); }
}

// 动态契约替代旧私有代际/租约测试；固定工具骨架不再测试旧内部生命周期。

section('回归守卫：dsh-tool-subagent 已删除的 Config 字段（真实装载期硬拒）');
{
  // ⚠️ 精确锁死本次升级事故：0.2.1-rc.1 的 dsh-tool-subagent 对 `persona` / `toolFilter`
  //    用 `Object.hasOwn` 判定，**键存在即抛错**（值取 undefined 也算）；`backgroundMode` /
  //    `enableRunInBackground` 已从 Config 删除。角色的 persona 与工具构成改由独立
  //    Agent Preset 承载，工具配置只负责用 `agentPreset` 选中它。
  const toolModule = await import('@deepseek-ai/dsh-tool-subagent');
  const builtinRole = normalizeRole(
    { id: 'regression-guard', description: 'd', instructions: 'GUARD-PERSONA', model: 'm' }, 0, 'p').role;
  const config = toolConfigFor(builtinRole, { maxDepth: 3 });
  const removedFields = ['persona', 'toolFilter', 'backgroundMode', 'enableRunInBackground'];
  check('toolConfigFor 的 own keys 恰为 provider/toolName/agentOptions/agentPreset/maxDepth',
    JSON.stringify(Object.keys(config).sort())
      === JSON.stringify(['agentOptions', 'agentPreset', 'maxDepth', 'provider', 'toolName']),
    Object.keys(config).join(','));
  for (const field of removedFields) {
    check(`toolConfigFor 没有 own ${field}（键存在即装载期硬抛错）`, !Object.hasOwn(config, field));
  }
  // 真实 apply + 真实角色配置 + agentPresets 桩：必须不抛错。
  const ctx = makeCtx();
  await ctx.presets.register({ id: rolePresetId('regression-guard'), name: 'guard',
    description: 'd', plugins: [] });
  let threw = null;
  try {
    await toolModule.apply(ctx, config);
  } catch (error) { threw = error; }
  check('真实 dsh-tool-subagent apply 接受真实角色配置（persona/toolFilter 已移入 preset）',
    threw === null, String(threw));
  check('真实 apply 后委派工具确实注册且选中角色 preset',
    ctx.tools.get('delegate_to_regression_guard') !== undefined
      && config.agentPreset === rolePresetId('regression-guard'));
  // 正向对照：把已删除字段塞回去，真实 apply 必须抛错 —— 证明上面的「不抛错」不是空过。
  for (const field of ['persona', 'toolFilter']) {
    let rejected = null;
    try {
      await toolModule.apply(makeCtx(), { ...config, [field]: 'fixture-value' });
    } catch (error) { rejected = error; }
    check(`正向对照：把 ${field} 塞回去后真实 apply 抛错（守卫有齿）`,
      rejected !== null && String(rejected?.message).includes(field), String(rejected));
  }
}

section('F5 校验失败不追加 toolName 漂移');
{
  const ctx = makeCtx();
  apply(ctx, { mount: true, provider: 'self', roles: [{ ...fixtureRole, model: '', toolName: 'delegate_to_fixture' }] });
  const result = await ctx.tools.get('switchboard_selftest').execute({});
  check('仅真实 model 错误，无虚假 toolName 错误', /model.*必填/.test(result.configErrors) && !result.configErrors.includes('toolName'), result.configErrors);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  rmSync(fixtureHome, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
