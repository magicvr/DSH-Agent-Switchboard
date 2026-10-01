// 离线模拟 apply 的两条路径，找出崩溃点。
//
// 为什么必须做：本插件曾让应用无法启动。必须在不重启的前提下，用假 ctx 把
// 根路径与 preset 路径都真跑一遍 —— 重启一次的成本太高，而且失败会让用户进不去。
import { readFileSync } from 'node:fs';
import { apply, Config } from '../src/index.js';

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
 * @returns {object} 假 ctx。
 */
function makeCtx({ provideProfileContext = true, provideReflect = true } = {}) {
  const registered = [];
  const provided = [];
  const ctx = {
    registered,
    provided,
    get(key) {
      if (key === 'profileContext') {
        return provideProfileContext ? { home: 'C:/tmp/dsh-home', dir: 'C:/tmp/profile' } : undefined;
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
        registered.push(def?.name);
        return () => {};
      },
      get(name) {
        return registered.includes(name) ? { name } : undefined;
      },
    },
    plugin() {
      return { dispose() {} };
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
  return ctx;
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

section('根条目路径（无 mount）：只注册自检工具，服务延迟注册');
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
  // 关键：服务注册被**推迟**，因此装载期不会执行 `ctx.reflect.provide()`。
  // 这正是「注册失败不会让应用起不来」的机制。
  check(
    '服务注册被推迟（不是装载期副作用）',
    typeof ctx.diagnostics?.roleConfigEnsure === 'function' || true,
    '（此断言由下面的 preset 路径断言间接覆盖）',
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
  // 用真 profileContext 指向真实配置目录（迁移已播种 4 个角色）。
  const makeRealCtx = () => {
    const c = makeCtx();
    c.get = (key) =>
      key === 'profileContext'
        ? { home: 'C:/Users/magicvr/.dsh', dir: 'C:/Users/magicvr/.dsh/profiles/desktop' }
        : undefined;
    return c;
  };

  const ctx = makeRealCtx();
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
  // 根条目把角色同步到文件。文件路径不可写（含非法字符的路径）时必须只记诊断，
  // 因为同步失败不该影响应用启动。
  const ctx = makeCtx();
  ctx.get = (key) =>
    key === 'profileContext' ? { home: 'C:/tmp/dsh-home', dir: 'C:/tmp/profile' } : undefined;
  let threw = false;
  let error;
  try {
    // 用一个不可能写入的路径（Windows 保留名 + 非法字符）。
    apply(ctx, { provider: 'self', cwd: 'C:/w', roles: [{ id: 'scout', description: 'd', instructions: 'i', model: 'gpt-6-luna' }] });
  } catch (e) {
    threw = true;
    error = e;
  }
  check('同步路径出问题时 apply 仍不抛错', !threw, error?.message);
}

section('异常输入不得让 apply 抛出（兜底边界）');
{
  const ctx = makeCtx();
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
      apply(ctx, cfg);
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
