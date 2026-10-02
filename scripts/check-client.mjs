// Client 半边的离线冒烟测试。
//
// 为什么需要：Client 半边出错会让**整个 slot 空掉**（`slot entry crashed in '<slot>'`），
// 而且它只能在浏览器里运行 —— 一次重启就是一次昂贵的试错。因此用一个桩化的
// `window` / `require` 在 Node 里把模块真跑一遍，把「加载即崩」和明显的逻辑错误
// 提前挡掉。
//
// 这里能验的：注册契约（id 必须等于包名）、`apply` 是否注册了正确的 slot、
// 渲染函数在与真机不同的输入下是否抛错、以及 `normalizeRole` 那条前置校验的
// 一致性（合法性规则不能和 Host 侧说两样）。
// 这里**不能**验的：真实 React 渲染结果、真实 `ctx.remote.settings.mutate` 往返 ——
// 那些仍需一次重启 + 人工查看。
import { readFileSync } from 'node:fs';
import { parseJsonArray, validateRoles } from '../src/client/logic.js';
import { normalizeRoles } from '../src/roles.js';

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

const CLIENT_SRC = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8');
// 执行真实客户端源码，仅在测试副本中暴露 RoleRow；生产模块不增加测试导出。
const clientWindow = { __ModuleLoader__: { load: (spec) => { clientWindow.spec = spec; } } };
new Function('window', CLIENT_SRC.replace(/    return \{\s*\/\/ \*\*读\*\*走/, '    return { RoleRow, WrapperSettings, makeRoleStore, SwitchboardSettings, // **读**走'))(clientWindow);
const clientData = new Function(`${CLIENT_SRC.slice(0, CLIENT_SRC.indexOf('\nwindow.__ModuleLoader__.load'))}\nreturn { CLI_DRIVER_OPTIONS, DEFAULT_CLI_DRIVER, cliFieldsFor, inferCliDriver };`)();
const rowReact = { createElement: (type, props, ...children) => ({ type, props, children }) };
const { RoleRow, WrapperSettings, makeRoleStore } = clientWindow.spec.factory(() => rowReact);
function rowElements(role, writes) {
  const tree = RoleRow({ role, index: 3, onChange: (index, value) => writes.push({ index, value }), onRemove: () => {}, disabled: false });
  const all = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    all.push(node);
    node.children?.forEach(walk);
  };
  walk(tree);
  return all;
}

section('注册契约：必须调用 __ModuleLoader__.load 且 id 严格等于包名');
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  check('源码里出现 __ModuleLoader__.load', /__ModuleLoader__\.load\(/.test(CLIENT_SRC));
  // ⚠️ 必须锚定到 `__ModuleLoader__.load({ ... id: ... })` 那一处。
  //    曾写成「全文件第一个 `id:`」，而文件里还有别的带 id 的表（例如 CLI 驱动表里的
  //    `id: 'codex'`），于是断言被无关代码干扰而假失败。**断言要锚定到它真正要验的位置。**
  const m = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(CLIENT_SRC);
  check('load 的 id 存在', m !== null);
  check(
    `load 的 id 等于包名（${pkg.name}）`,
    m !== null && m[1] === pkg.name,
    m ? `实际 ${m[1]}` : '未取到',
  );
  check('dsh.client 已声明（否则产物不会被加载）', pkg.dsh?.client !== undefined);
}

section('模块可被真跑：桩化 window/require 后 factory 返回合法插件对象');
{
  /** 收集注册进来的 slot。 */
  const registered = [];
  /** 桩化的 cordis ctx。 */
  const fakeCtx = {
    // **读**走 configForms 镜像（官方「模型」页的做法）：`describe()` 返回一个面，
    // 提供 `ensure()`（异步补全）/ `getSnapshot()`（`view.namespaces` 与 `view.writable`）
    // / `subscribe()`。只靠 `remote.settings.describe()` 读是错的路子。
    configForms: {
      describe: () => ({
        ensure: () => Promise.resolve(),
        getSnapshot: () => ({
          view: {
            writable: true,
            namespaces: [
              { ns: 'agent-switchboard', value: { roles: [] }, revision: 1, writable: true },
            ],
          },
        }),
        subscribe: () => () => {},
      }),
    },
    // **写**走 remote.settings.mutate。
    remote: { settings: { mutate: () => Promise.resolve({ ok: true }) } },
    slots: {
      inject: (_slot, fn) => {
        fn();
      },
      register: (options, component) => {
        registered.push({ options, component });
      },
    },
  };

  let loaded;
  /** 极简 React 桩：只够让组件函数与 createElement 不抛错。 */
  const ReactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (init) => ({ current: init }),
    useCallback: (fn) => fn,
  };

  globalThis.window = {
    __ModuleLoader__: {
      load: (spec) => {
        loaded = spec;
      },
    },
  };

  try {
    // 用动态 import 跑真实源码（它是 ESM，顶层就调用 load）。
    await import(`../src/client/index.js?t=${Date.now()}`);
  } catch (error) {
    check('模块可被 import 且不抛错', false, error.message);
  }

  if (loaded === undefined) {
    check('模块调用了 load', false);
  } else {
    check('模块调用了 load', true);
    check('load 提供了 factory', typeof loaded.factory === 'function');
    let plugin;
    try {
      plugin = loaded.factory((name) => {
        if (name === 'react') return ReactStub;
        throw new Error(`未预期的 require(${name})`);
      });
      check('factory 只用 require("react")，未引入 Harness Client 包', true);
    } catch (error) {
      check('factory 只用 require("react")', false, error.message);
    }
    if (plugin) {
      check('插件导出了 inject', Array.isArray(plugin.inject));
      check('inject 含 slots', plugin.inject.includes('slots'), plugin.inject.join(','));
      // `remote.settings` 由内核插件 `dsh-api-settings-controller` 提供，客户端每次启动
      // 都有，官方 `ui-settings-general` 同样把它写进 inject。它是 UI 写入角色数据的
      // **唯一**通道（客户端没有写文件能力）。
      check(
        'inject 含 configForms（读配置的镜像）',
        plugin.inject.includes('configForms'),
        plugin.inject.join(','),
      );
      check(
        'inject 含 remote.settings（UI 唯一的写入通道）',
        plugin.inject.includes('remote.settings'),
        plugin.inject.join(','),
      );
      // ⚠️ 这条锁死一次真实启动失败：客户端曾把 `remote.roleConfig`（我们自己延迟注册的
      //    服务）写成必需注入 → 客户端永远 pending → 整页启动失败
      //    （`web boot: 1 entry did not activate`）。
      //    判据不是「不许有 remote.*」，而是「**只许注入内核保证存在的那些**」。
      check(
        'inject 里没有自建的 remote 命名空间',
        !plugin.inject.includes('remote.roleConfig'),
        plugin.inject.join(','),
      );
      check('插件导出了 apply', typeof plugin.apply === 'function');
      try {
        plugin.apply(fakeCtx);
        check('apply 不抛错', true);
      } catch (error) {
        check('apply 不抛错', false, error.message);
      }
      check('apply 注册了恰好 1 个 slot', registered.length === 1, `实际 ${registered.length}`);
      if (registered.length === 1) {
        const { options, component } = registered[0];
        check('注册的 slot 是 settings.section', options.name === 'settings.section', String(options.name));
        check('注册 id 是自己的（agent-switchboard）', options.id === 'agent-switchboard', String(options.id));
        check('组件是函数', typeof component === 'function');
        // ⚠️ 组件**不得**接收 ctx，只接收插件 `apply` 里绑定好的操作回调（`store`）。
        //    这与官方「模型」页一致：「Cards receive these **instead of a context** … so the
        //    failure codes and Remote namespaces stay in the **apply world**」。
        //    原因：slot 的组件侧上下文与插件上下文**不是同一个**，直接读 `props.ctx.remote`
        //    拿不到远程命名空间 —— 实测表现为「读得到 configForms、写不到 remote.settings」。
        const injected = typeof options.inject === 'function' ? options.inject() : {};
        check('inject 回调注入 store（而不是 ctx）', injected.store !== undefined, Object.keys(injected).join(','));
        check('inject 回调不注入 ctx', injected.ctx === undefined, Object.keys(injected).join(','));
        check(
          'store 提供 read / write 两个操作',
          typeof injected.store?.read === 'function' && typeof injected.store?.write === 'function',
          Object.keys(injected.store ?? {}).join(','),
        );
        // 渲染一次：用桩 React 走完整个组件体，验证不抛错且能返回元素。
        try {
          const tree = component({ store: injected.store });
          check('组件在「空角色」输入下可渲染且不抛错', tree !== null && tree !== undefined);
        } catch (error) {
          check('组件在「空角色」输入下可渲染且不抛错', false, error.message);
        }
      }
    }
  }
  delete globalThis.window;
}

section('parseJsonArray：只接受字符串数组，非法输入返回 undefined');
{
  check('正常数组', JSON.stringify(parseJsonArray('["a","b"]')) === '["a","b"]');
  check('空数组', JSON.stringify(parseJsonArray('[]')) === '[]');
  check('非数组 → undefined', parseJsonArray('{"a":1}') === undefined);
  check('含非字符串 → undefined', parseJsonArray('["a",1]') === undefined);
  check('非法 JSON → undefined', parseJsonArray('[a,b') === undefined);
  check('空串 → undefined', parseJsonArray('') === undefined);
}

section('validateRoles：与 Host 的 normalizeRole 规则一致，且能给出可读错误');
{
  const good = {
    id: 'scout',
    description: 'd',
    instructions: 'i',
    model: 'm',
    provider: 'self',
    backend: 'spawn',
  };
  check('合法角色通过', validateRoles([good]) === null, String(validateRoles([good])));
  check('空列表通过（允许清空角色）', validateRoles([]) === null);
  check(
    'id 含大写被拒',
    /小写/.test(validateRoles([{ ...good, id: 'Scout' }]) ?? ''),
    String(validateRoles([{ ...good, id: 'Scout' }])),
  );
  check('id 重复被拒', /重复/.test(validateRoles([good, { ...good }]) ?? ''));
  check('缺描述被拒', /描述/.test(validateRoles([{ ...good, description: '' }]) ?? ''));
  check('缺指令被拒', /指令/.test(validateRoles([{ ...good, instructions: '' }]) ?? ''));
  check('缺模型被拒', /模型/.test(validateRoles([{ ...good, model: '' }]) ?? ''));
  // ⚠️ 这条断言**曾经是反的**：原先要求「内置后端缺 provider 被拒」，而 Host 侧的规则是
  //    `read('provider') ?? defaultProvider`（留空就用插件级默认值）。客户端比 Host 严
  //    会造成**假失败** —— 实测踩到：角色从 CLI 切回内置后保存被拦下，提示一句自相矛盾的话。
  //    现在断言「留空必须通过」，并反向确认它**不是**被别的原因放过去的。
  check(
    '内置后端留空 provider 必须通过（跟随插件级默认值）',
    validateRoles([{ ...good, provider: undefined }]) === null,
    String(validateRoles([{ ...good, provider: undefined }])),
  );
  check(
    '内置后端 provider 为空串也通过（Host 回落默认 provider）',
    validateRoles([{ ...good, provider: '' }]) === null,
    String(validateRoles([{ ...good, provider: '' }])),
  );
  // 反例：确保上面的「通过」不是因为校验整个失效了。
  check(
    '校验仍然有效（同一份数据把描述清空必须被拒）',
    validateRoles([{ ...good, provider: undefined, description: '' }]) !== null,
  );
  const cli = { ...good, provider: undefined, backend: 'cli', cliCommand: 'node', cliArgs: ['x'], cliPromptDelivery: 'stdin' };
  check('合法 CLI 角色通过', validateRoles([cli]) === null, String(validateRoles([cli])));
  check(
    'CLI 缺命令被拒',
    /命令/.test(validateRoles([{ ...cli, cliCommand: '' }]) ?? ''),
  );
  check(
    'CLI 缺参数模板被拒',
    /参数模板/.test(validateRoles([{ ...cli, cliArgs: [] }]) ?? ''),
  );
  // ⚠️ 这条断言**曾经是反的**：原先要求「CLI 缺提示词传递方式被拒」，而 Host 侧是
  //    `read('cliPromptDelivery') ?? 'stdin'`（留空取默认值）。客户端比 Host 严会造成
  //    假失败。现在断言「留空必须通过」——与 Host 一致。
  check(
    'CLI 留空 cliPromptDelivery 必须通过（Host 默认 stdin）',
    validateRoles([{ ...cli, cliPromptDelivery: undefined }]) === null,
    String(validateRoles([{ ...cli, cliPromptDelivery: undefined }])),
  );
  check(
    'CLI 留空 cliPromptDelivery 时 Host 也用 stdin（两边同义）',
    normalizeRoles([{ ...cli, cliPromptDelivery: undefined }], 'self', 'C:/w').roles?.[0]?.cli
      ?.promptDelivery === 'stdin',
    'Host 未回落到 stdin',
  );
  // 新增：backend 取值必须被校验（原先完全漏检，非法值被 UI 放行、到 Host 才报错）。
  check(
    '非法 backend 被拒',
    /派发机制|backend/.test(validateRoles([{ ...good, backend: 'nope' }]) ?? ''),
    String(validateRoles([{ ...good, backend: 'nope' }])),
  );
  check('合法 backend 通过', validateRoles([{ ...good, backend: 'fork' }]) === null);
}

section('防漂移：Client 内联的纯逻辑与 logic.js 必须逐字相同');
{
  // Client 半边是自包含单文件，无法 import logic.js，只能内联。这就产生了
  // 「两份真相」的风险。断言两处实现一字不差 —— 否则抽出逻辑反而制造了缺陷。
  /**
   * 从源码里抽出某个顶层函数的**规范化**源码文本。
   *
   * 规范化 = 去掉行首行尾空白与空行，这样缩进差异不算漂移。
   *
   * @param {string} source - 文件内容。
   * @param {string} name - 函数名。
   * @returns {string|undefined} 归一化后的函数源码。
   */
  function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    if (start === -1) return undefined;
    // 从函数头开始做花括号配对，取到匹配的右花括号为止。
    const braceStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          return source
            .slice(start, i + 1)
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .join('\n');
        }
      }
    }
    return undefined;
  }

  const logicSrc = readFileSync(new URL('../src/client/logic.js', import.meta.url), 'utf8');
  for (const name of ['parseJsonArray', 'validateRoles']) {
    const a = extractFunction(logicSrc, name);
    const b = extractFunction(CLIENT_SRC, name);
    check(`${name} 在两处都存在`, a !== undefined && b !== undefined);
    check(`${name} 两处实现逐字相同`, a !== undefined && a === b, a === b ? '' : '存在漂移');
  }
}

section('CLI 驱动表：Client 镜像必须与 Host 权威一致');
{
  // Client 半边是自包含单文件，无法 import Host 的 `src/cli/drivers.js`，只能内联一份。
  // 两份一旦漂移，界面「一键填好」的参数就会与 Host 校验/实际调用不一致 —— 因此逐字段比对。
  const { CLI_DRIVERS } = await import('../src/cli/drivers.js');
  const driverSource = readFileSync(new URL('../src/cli/drivers.js', import.meta.url), 'utf8');

  // 从客户端源码里把 `CLI_DRIVER_OPTIONS` 那段抽出来，做结构化比对。
  // 用 `new Function` 执行是不行的（源码里有 React 依赖），因此改为**逐字段文本比对**：
  // 每个驱动必须能在客户端源码里找到同样的 id/label/command/prefixArgs/promptDelivery，
  // 且 args 的两种只读形态都必须出现。
  for (const d of CLI_DRIVERS) {
    check(`客户端含驱动 ${d.id}`, CLIENT_SRC.includes(`id: '${d.id}'`), '缺该驱动');
    check(
      `客户端 ${d.id} 的 command 与 Host 一致`,
      CLIENT_SRC.includes(`command: '${d.command}'`) || d.command === '',
      `期望 command: '${d.command}'`,
    );
    check(
      `客户端 ${d.id} 的 promptDelivery 与 Host 一致`,
      CLIENT_SRC.includes(`promptDelivery: '${d.promptDelivery}'`),
      `期望 ${d.promptDelivery}`,
    );
    // args 模板：取该驱动从 `id:` 到下一个驱动 `id:` 之间的源码段，要求**两种只读形态的
    // 全部参数字面量**都出现在这一段里。
    //
    // ⚠️ 不用「跨源码提取函数体逐字比对」：那个做法依赖花括号配对，实测会抓到错位的块而
    //    产生假失败（把 `custom` 的 args 抓成了别的对象字面量）。判据要**稳定**才有意义。
    const segmentOf = (source, driverId) => {
      const at = source.indexOf(`id: '${driverId}'`);
      if (at === -1) return '';
      const next = source.indexOf("id: '", at + 1);
      return source.slice(at, next === -1 ? source.length : next);
    };
    const segment = segmentOf(CLIENT_SRC, d.id);
    for (const readOnly of [true, false]) {
      const expected = d.args(readOnly);
      if (expected.length === 0) continue;
      const missing = expected.filter((a) => !segment.includes(`'${a}'`));
      check(
        `客户端 ${d.id} 的 args（readOnly=${readOnly}）与 Host 一致`,
        missing.length === 0,
        `缺少字面量：${JSON.stringify(missing)}`,
      );
    }
    check(
      `客户端 ${d.id} 的 prefixArgs 与 Host 一致`,
      // 源码里的字面量对反斜杠要转义（`\\`），而运行时值只有一个反斜杠，因此比较前先转义。
      d.prefixArgs.every((p) => segment.includes(`'${p.replace(/\\/g, '\\\\')}'`)),
      `期望含 ${JSON.stringify(d.prefixArgs)}`,
    );
    check(
      `客户端 ${d.id} 的 prefixArgs 与 Host 一致`,
      JSON.stringify(CLI_DRIVERS.find((x) => x.id === d.id).prefixArgs).length === 0 ||
        d.prefixArgs.every((p) => CLIENT_SRC.includes(`'${p.replace(/\\/g, '\\\\')}'`)),
      `期望含 ${JSON.stringify(d.prefixArgs)}`,
    );
  }
  check(
    '客户端驱动集合与 Host 一致且恰为 codex / grok',
    JSON.stringify(clientData.CLI_DRIVER_OPTIONS.map((d) => d.id).sort()) === JSON.stringify(CLI_DRIVERS.map((d) => d.id).sort()) &&
      clientData.CLI_DRIVER_OPTIONS.map((d) => d.id).sort().join(',') === 'codex,grok',
    JSON.stringify(clientData.CLI_DRIVER_OPTIONS.map((d) => d.id)),
  );
  // 反向断言：被移除的预设**不得**残留在客户端镜像里（漏删一半会造成「界面有、Host 没有」）。
  check('客户端不含 claude 预设', !CLIENT_SRC.includes("id: 'claude'"));
  check('客户端不含 custom 预设且不产出 custom 字段',
    !clientData.CLI_DRIVER_OPTIONS.some((d) => d.id === 'custom') && clientData.cliFieldsFor('custom', true) === undefined);
  check('客户端未知 id 不产出字段', clientData.cliFieldsFor('unknown', false) === undefined);
}

section('多字段写入必须原子（锁死「锁死在自定义命令」这个故障）');
{
  // ⚠️ `set` 的实现是 `onChange(index, { ...role, [key]: value })`，其中 `role` 是本行
  //    渲染时的**快照**。因此**连续多次 `set` 只有最后一次生效**，前面的字段被静默丢弃。
  //
  //    实测故障：驱动选择器的 onChange 连着调用 4 次 `set` 去填 command / prefixArgs /
  //    args / promptDelivery，只写进了最后一项 → 字段凑不成任何驱动 → 下拉框永远反推
  //    不中 → **无法选择 Codex/Grok，只能停在「自定义命令」**。
  //
  //    静态断言：`set` 只在 `setMany` 的定义里出现（即不允许多字段场景直接连调 `set`）。
  check('存在原子提交 helper `setMany`', /const setMany = \(patch\) => onChange\(/.test(CLIENT_SRC));
  check(
    '单字段 `set` 的定义存在（它仍用于真正的单字段编辑）',
    /const set = \(key, value\) => onChange\(/.test(CLIENT_SRC),
  );
  // 驱动选择器那一段必须用 setMany，不得用连续的 set。
  const driverOnChange = /onChange: \(e\) => \{\s*const id = e\.target\.value;[\s\S]{0,900}?\n\s*\},/.exec(CLIENT_SRC);
  check('能定位到驱动选择器的 onChange', driverOnChange !== null);
  if (driverOnChange !== null) {
    const body = driverOnChange[0];
    check('驱动选择器使用 setMany（原子提交）', /setMany\(/.test(body), body.slice(0, 200));
    check(
      '驱动选择器没有连续调用 set（那会只生效最后一次）',
      (body.match(/\bset\(/g) ?? []).length === 0,
      `出现 ${(body.match(/\bset\(/g) ?? []).length} 次 set(`,
    );
  }
  // 切到 cli 时也必须一次填好整组字段，否则新角色带着空命令进入 CLI 分支。
  check(
    '切换 backend 有专门的 handler（切到 cli 时补默认驱动）',
    /const changeBackend = \(next\) =>/.test(CLIENT_SRC) && /DEFAULT_CLI_DRIVER/.test(CLIENT_SRC),
  );
  check(
    '默认驱动为 codex 且属于允许集合',
    clientData.DEFAULT_CLI_DRIVER === 'codex' && clientData.CLI_DRIVER_OPTIONS.some((d) => d.id === clientData.DEFAULT_CLI_DRIVER),
    clientData.DEFAULT_CLI_DRIVER,
  );
  check(
    'backend 下拉不再复用通用 select（它只改一个字段）',
    !/field\('派发机制', select\('backend'/.test(CLIENT_SRC),
  );
}

section('RoleRow 真实事件回调：预设与只读切换原子更新');
{
  const { cliFieldsFor, validateCliPreset } = await import('../src/cli/drivers.js');
  for (const driver of ['codex', 'grok']) {
    for (const readOnly of [true, false]) {
      const role = { id: 'r', backend: 'cli', model: 'external-model', cliCwd: 'C:/w', cliDriver: driver, readOnly, ...cliFieldsFor(driver, readOnly) };
      const before = JSON.stringify(role);
      const writes = [];
      const inputs = rowElements(role, writes);
      inputs.find((n) => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: !readOnly } });
      check(`${driver}/${readOnly}：只读切换只提交一次且携带角色索引`, writes.length === 1 && writes[0].index === 3);
      const next = writes[0]?.value;
      check(`${driver}/${readOnly}：只读与沙箱参数同步通过 Host 校验`,
        next?.readOnly === !readOnly && validateCliPreset(next).errors.length === 0);
      check(`${driver}/${readOnly}：只读切换保留模型/cwd 且不修改旧快照`,
        next?.model === role.model && next?.cliCwd === role.cliCwd && JSON.stringify(role) === before);
      const target = driver === 'codex' ? 'grok' : 'codex';
      writes.length = 0;
      inputs.find((n) => n.type === 'select' && n.props.value === driver).props.onChange({ target: { value: target } });
      check(`${driver}/${readOnly}：预设切换一次提交完整执行字段`,
        writes.length === 1 && writes[0].value.cliDriver === target && validateCliPreset(writes[0].value).errors.length === 0);
    }
  }
  const unknown = { backend: 'cli', cliDriver: 'custom', ...cliFieldsFor('grok', true), cliArgs: ['--other'], readOnly: true };
  const writes = [];
  const elements = rowElements(unknown, writes);
  check('未知客户端配置安全渲染，空值下拉明确提示需重选预设、不伪装 codex',
    clientData.inferCliDriver(unknown) === undefined && elements.some((n) => n.type === 'select' && n.props.value === '') &&
    elements.some((n) => n.type === 'option' && n.props.value === '' && n.props.disabled && n.children.includes('需重选预设')) &&
    elements.some((n) => n.children.includes('需重选预设：当前配置无法识别为 codex / grok')));
  elements.find((n) => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: false } });
  check('未知配置切换只读不伪装有效驱动、不改写执行字段',
    writes.length === 1 && writes[0].value.readOnly === false && writes[0].value.cliDriver === 'custom' &&
    JSON.stringify(writes[0].value.cliArgs) === JSON.stringify(unknown.cliArgs) && validateCliPreset(writes[0].value).errors.length > 0);
  const builtinWrites = [];
  rowElements({ backend: 'spawn', readOnly: false }, builtinWrites)
    .find((n) => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  check('内置角色只读切换不写 CLI 执行字段',
    builtinWrites.length === 1 && builtinWrites[0].value.readOnly === true && !('cliArgs' in builtinWrites[0].value));
}

section('面板字段：源码结构与桩化 RoleRow（不替代真机验收）');
{
  const rowSource = CLIENT_SRC.slice(CLIENT_SRC.indexOf('    function RoleRow('), CLIENT_SRC.indexOf('    function WrapperSettings('));
  const renderSource = rowSource.slice(rowSource.indexOf('      return h('));
  // 用条件分支锚点约束控件位置；再对 spawn / fork / cli 的元素树验证显示条件。
  check('Provider 输入位于 builtin 条件分支',
    rowSource.includes("const isBuiltin = ['spawn', 'fork'].includes(role.backend ?? 'spawn');") &&
    /isBuiltin\s*\? h\([^\n]*field\('Provider', text\('provider', '留空使用默认 provider', true\)\)\)\s*: null/.test(renderSource));
  const cliBranch = renderSource.slice(renderSource.indexOf('        isCli\n'));
  check('CLI 分支无 provider 输入', !/text\('provider'/.test(cliBranch));
  for (const key of ['agentProvider', 'agentModel']) {
    check(`${key} 角色输入已从源码移除`, !CLIENT_SRC.includes(`text('${key}'`));
  }
  check('instructions 恒显且为多行输入',
    /h\('textarea', \{\s*rows: 5,\s*value: role\.instructions \?\? '',[\s\S]*?set\('instructions', e\.target\.value\)/.test(renderSource.slice(0, renderSource.indexOf('        isCli\n'))));
  for (const key of ['cliCommand', 'cliPrefixArgs', 'cliArgs', 'cliPromptDelivery', 'cliCwd']) {
    check(`${key} 命令编辑控件已从源码移除`,
      !new RegExp(`(?:text|select|set)\\('${key}'|value:.*role\\.${key}\\b`).test(renderSource));
  }
  check('参数占位符提示已移除', !renderSource.includes('参数（占位符：'));
  check('预设说明不再显示命令参数细节',
    !rowSource.includes('driverDef.description') && !renderSource.includes('-s read-only'));
  check('外部模型与包裹模型标签明确区分',
    renderSource.includes("isCli ? '外部 CLI 模型' : '模型'") && CLIENT_SRC.includes('模型（非外部 CLI 模型）'));
  for (const backend of ['spawn', 'fork', 'cli']) {
    const role = {
      id: 'r', backend, description: '描述', instructions: '原始指令\n第二行',
      model: 'external-model', effort: 'high', provider: 'route', agentProvider: 'wrapper-route', agentModel: 'wrapper-model',
      cliDriver: 'custom', cliCommand: 'original-command', cliPrefixArgs: ['prefix'], cliArgs: ['original-args'],
      cliPromptDelivery: 'argv', cliCwd: 'saved-cwd',
    };
    const before = JSON.stringify(role);
    const writes = [];
    const elements = rowElements(role, writes);
    const textInput = (placeholder) => elements.find((n) => n.type === 'input' && n.props.type === 'text' && n.props.placeholder === placeholder);
    check(`${backend}：model 文本输入与 effort 下拉仍可用`,
      typeof textInput('gpt-6-luna')?.props.onChange === 'function' &&
      elements.some((n) => n.type === 'select' && n.props.value === 'high' && typeof n.props.onChange === 'function'));
    const provider = textInput('留空使用默认 provider');
    check(`${backend}：provider 仅内置显示`, Boolean(provider) === (backend !== 'cli'));
    for (const [key, placeholder] of [['agentProvider', '留空继承父代理路由'], ['agentModel', '留空继承父代理模型']]) {
      const control = textInput(placeholder);
      check(`${backend}：残留 ${key} 不显示角色控件`, control === undefined);
    }
    if (provider) {
      provider.props.onChange({ target: { value: '  other-route  ' } });
      check(`${backend}：provider 输入 trim`, writes.at(-1)?.value.provider === 'other-route');
      provider.props.onChange({ target: { value: '   ' } });
      check(`${backend}：provider 空白写为未设置且保留其他字段`,
        JSON.stringify(writes.at(-1)?.value) === JSON.stringify({ ...role, provider: undefined }));
    }
    const instructions = elements.find((n) => n.type === 'textarea' && n.props.value === role.instructions);
    check(`${backend}：instructions 多行控件恒显且不以描述代填`,
      instructions?.props.rows > 1 && instructions?.props.placeholder === '填写角色职责、约束与输出要求');
    instructions?.props.onChange({ target: { value: '新指令\n保留换行' } });
    check(`${backend}：指令编辑保留换行及全部隐藏 cli 字段，不修改旧快照`,
      JSON.stringify(writes.at(-1)?.value) === JSON.stringify({ ...role, instructions: '新指令\n保留换行' }) && JSON.stringify(role) === before);
    const empty = rowElements({ ...role, instructions: '' }, []);
    check(`${backend}：空指令不自动编造，必填校验仍拒绝`,
      empty.some((n) => n.type === 'textarea' && n.props.value === '') && /指令/.test(validateRoles([{ ...role, instructions: '' }]) ?? ''));
    if (backend === 'cli') {
      const preset = elements.find((n) => n.type === 'select' && n.props.value === '');
      check('CLI 预设下拉仅 codex / grok 与禁选待重选占位',
        JSON.stringify(preset?.children.flat().filter((n) => n.type === 'option').map((n) => [n.props.value, n.props.disabled === true])) ===
        JSON.stringify([['', true], ['codex', false], ['grok', false]]));
    }
  }
}

section('统一包裹小节：真实控件、读取与原子写入');
{
  const all = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    all.push(node); node.children?.forEach(walk);
  };
  const wrapper = { wrapperProvider: 'route', wrapperModel: 'model', wrapperEffort: 'high' };
  const writes = [];
  walk(WrapperSettings({ wrapper, onChange: (next) => writes.push(next), disabled: false }));
  check('小节标题及仅 CLI 生效说明存在', all.some(n => n.children.includes('包裹子代理（外部 CLI 角色的转交代理）')) &&
    all.some(n => n.children.includes('仅对 CLI 角色生效；内置角色仍使用各自的 Provider、模型和思考强度。')));
  for (const [key, placeholder] of [['wrapperProvider', '留空继承父代理路由'], ['wrapperModel', '留空继承父代理模型']]) {
    const control = all.find(n => n.type === 'input' && n.props.placeholder === placeholder);
    check(`${key} 统一文本控件读取已保存值`, control?.props.value === wrapper[key]);
    control?.props.onChange({ target: { value: '  ' } });
    check(`${key} 空白草稿保留其他统一字段`, JSON.stringify(writes.at(-1)) === JSON.stringify({ ...wrapper, [key]: '  ' }));
  }
  const select = all.find(n => n.type === 'select');
  const { EFFORT_VALUES } = await import('../src/roles.js');
  check('统一思考强度下拉含空继承项与全部 EFFORT_VALUES', select?.props.value === 'high' &&
    JSON.stringify(select.children.flat().map(n => n.props.value)) === JSON.stringify(['', ...EFFORT_VALUES]));
  select?.props.onChange({ target: { value: '' } });
  check('强度可清空且不修改其他字段', JSON.stringify(writes.at(-1)) === JSON.stringify({ ...wrapper, wrapperEffort: '' }));
  const calls = [];
  const store = makeRoleStore({
    configForms: { describe: () => ({ ensure: async () => {}, getSnapshot: () => ({ view: { namespaces: [
      { ns: 'agent-switchboard', value: { roles: [], volatile: wrapper }, revision: 23 },
    ] } }) }) },
    remote: { settings: { mutate: async (...args) => { calls.push(args); return { ok: true }; } } },
  });
  const read = await store.read();
  check('镜像读取统一三字段并保留同一 revision', JSON.stringify(read.wrapper) === JSON.stringify(wrapper) && read.revision === 23);
  const saved = await store.write([], read.revision, { wrapperProvider: ' route ', wrapperModel: ' ', wrapperEffort: '' });
  check('角色与 volatile 三路径在同一次 mutate 提交，使用读取 revision', saved.ok && calls.length === 1 &&
    JSON.stringify(calls[0]) === JSON.stringify(['agent-switchboard', [
      { op: 'set', path: ['roles'], value: [] },
      { op: 'set', path: ['volatile', 'wrapperProvider'], value: 'route' },
      { op: 'set', path: ['volatile', 'wrapperModel'], value: '' },
      { op: 'set', path: ['volatile', 'wrapperEffort'], value: '' },
    ], 23]));
  check('小节位于角色列表之前且不以 CLI 角色数量为显示条件',
    /h\(WrapperSettings, \{ wrapper, onChange: setWrapper, disabled: busy \}\) : null,\s*children,/.test(CLIENT_SRC));
  check('保存与 dirty 比较包含包裹草稿', CLIENT_SRC.includes('JSON.stringify({ roles, wrapper }) !== savedRef.current') &&
    CLIENT_SRC.includes('store.write(roles, revision, wrapper)'));
}

section('统一包裹草稿：组件编辑、保存、清空与非法值的真实回调');
{
  const states = [], refs = [], effects = [];
  let stateIndex = 0, refIndex = 0;
  const react = {
    ...rowReact,
    useState: (initial) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef: (initial) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
    useEffect: (effect) => effects.push(effect),
    useCallback: (fn) => fn,
  };
  const { SwitchboardSettings } = clientWindow.spec.factory(() => react);
  const calls = [];
  let wrapper = { wrapperProvider: '', wrapperModel: '', wrapperEffort: '' };
  let revision = 31;
  const store = {
    read: async () => ({ ok: true, roles: [], wrapper, revision, missing: true }),
    write: async (roles, rev, next) => { calls.push({ roles, rev, next }); wrapper = next; revision++; return { ok: true }; },
  };
  const render = () => {
    stateIndex = 0; refIndex = 0;
    const all = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      all.push(node); node.children?.forEach(walk);
    };
    walk(SwitchboardSettings({ store }));
    return all;
  };
  const saveButton = all => all.find(n => n.type === 'button' && n.children.some(c => typeof c === 'string' && c.startsWith('保存')));
  render(); effects[0](); await new Promise(setImmediate);
  let nodes = render();
  let sectionNode = nodes.find(n => n.type?.name === 'WrapperSettings');
  check('没有任何 CLI 或角色时仍显示统一小节，初始保存禁用', sectionNode !== undefined && saveButton(nodes)?.props.disabled === true);
  sectionNode.props.onChange({ ...wrapper, wrapperModel: 'new-model', wrapperEffort: 'high' });
  nodes = render();
  check('仅编辑包裹字段就标记 dirty 并允许保存', saveButton(nodes)?.children.includes('保存 *') && !saveButton(nodes)?.props.disabled);
  await saveButton(nodes).props.onClick(); await new Promise(setImmediate);
  check('保存真实回调提交包裹草稿及原读取 revision', calls.length === 1 && calls[0].rev === 31 && calls[0].roles.length === 0 &&
    JSON.stringify(calls[0].next) === JSON.stringify({ wrapperProvider: '', wrapperModel: 'new-model', wrapperEffort: 'high' }));
  nodes = render();
  check('保存后刷新统一字段与 revision，dirty 清除', saveButton(nodes)?.props.disabled &&
    nodes.find(n => n.type?.name === 'WrapperSettings')?.props.wrapper.wrapperModel === 'new-model');
  nodes.find(n => n.type?.name === 'WrapperSettings').props.onChange({ wrapperProvider: '', wrapperModel: '', wrapperEffort: '' });
  nodes = render(); await saveButton(nodes).props.onClick(); await new Promise(setImmediate);
  check('清空后仍能保存，使用刷新后的 revision', calls.length === 2 && calls[1].rev === 32 &&
    Object.values(calls[1].next).every(v => v === ''));
  nodes = render();
  nodes.find(n => n.type?.name === 'WrapperSettings').props.onChange({ ...wrapper, wrapperEffort: 'invalid' });
  nodes = render(); await saveButton(nodes).props.onClick();
  check('非法包裹强度不调用写通道并给错误提示', calls.length === 2 &&
    render().some(n => n.children.includes('包裹子代理思考强度非法')));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
