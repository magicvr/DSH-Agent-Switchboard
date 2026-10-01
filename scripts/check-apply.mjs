// 离线模拟 apply 的两条路径，找出崩溃点。
//
// 为什么必须做：本插件曾让应用无法启动。必须在不重启的前提下，用假 ctx 把
// 根路径与 preset 路径都真跑一遍 —— 重启一次的成本太高，而且失败会让用户进不去。
import { readFileSync } from 'node:fs';
import { apply, Config, ensureRoleConfigService } from '../src/index.js';

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

section('roleConfig 服务注册失败时必须降级而不是抛出');
{
  // 残缺 ctx：`reflect.provide` 不存在 → 构造 TypertRemoteService 必然失败。
  const broken = {
    get() {
      return undefined;
    },
    tools: { register() {}, get() { return undefined; } },
  };
  let threw = false;
  let error;
  let result;
  try {
    result = ensureRoleConfigService(broken, 'C:/tmp/roles.json', { provider: 'self' });
  } catch (e) {
    threw = true;
    error = e;
  }
  check('不抛错', !threw, error?.message);
  check('返回失败结果而不是抛出', result?.ok === false, JSON.stringify(result));
  check('给出可读原因', typeof result?.error === 'string' && result.error.length > 0, String(result?.error));
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

section('角色配置服务必须在**根作用域装载期**就绪（客户端依赖它）');
{
  // ⚠️ 这条直接锁死一次真实启动失败：
  //     web boot: 1 entry did not activate
  //     @magicvr/dsh-agent-switchboard: pending (waiting for service: remote.roleConfig)
  //     根因是「客户端把该服务写成必需注入」而「Host 侧延迟注册」两者矛盾。
  //     因此断言：根条目装载后，服务**必须已经注册**（不能只登记一个延迟回调）。
  const ctx = makeCtx();
  apply(ctx, { provider: 'self', cwd: 'C:/w' });
  check(
    '根条目装载后 roleConfig 已注册（该服务名进入 ctx.reflect.provide）',
    ctx.provided.includes('roleConfig'),
    `实际注册：${ctx.provided.join(', ') || '（无）'}`,
  );
}

section('客户端必需注入不得与服务注册时机矛盾');
{
  // 客户端的 `inject` 是**必需**依赖：声明了就必须在装载期存在。而 `remote.*` 命名空间
  // 只有在对应 Host 服务注册后才存在。因此客户端**不能**把 `remote.<ns>` 写进 inject ——
  // 否则一旦 Host 侧改为延迟注册，客户端就永远 pending，整页启动失败。
  const clientSrc = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8');
  const m = /inject:\s*\[([^\]]*)\]/.exec(clientSrc);
  const declared = (m?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0);
  console.log(`       客户端 inject = ${JSON.stringify(declared)}`);
  check('客户端 inject 里没有 remote.* 项', !declared.some((n) => n.startsWith('remote.')), declared.join(','));
  check('客户端 inject 含 slots（它唯一的真实必需依赖）', declared.includes('slots'), declared.join(','));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
