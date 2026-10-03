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
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config } from '../src/index.js';
import { configPathFor, initialConfig, readConfigFile, writeConfigFile } from '../src/config-file.js';
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
// 执行真实客户端源码，仅在测试副本中暴露内部函数；生产模块不增加测试导出。
const clientWindow = { __ModuleLoader__: { load: (spec) => { clientWindow.spec = spec; } } };
new Function('window', CLIENT_SRC.replace(/    return \{\s*\/\/ \*\*读\*\*走/, '    return { RoleCard, RoleRow, WrapperSettings, makeRoleStore, SwitchboardSettings, selectCliComposer, makeCliStore, CliReadOnlyComposer, CliOutputPanel, CliJobOutput, isAtScrollBottom, // **读**走'))(clientWindow);
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
      check('父 inject 保持三个内核依赖，不含 remote/job', JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'configForms', 'remote.settings']));
      check('apply 注册了恰好 2 个 slot', registered.length === 2, `实际 ${registered.length}`);
      const composer = registered.find(({ options }) => options.name === 'conversation.composer');
      check('CLI slot：conversation.composer / agent-switchboard-cli-observer / priority -20',
        composer?.options.id === 'agent-switchboard-cli-observer' && composer.options.priority === -20);
      check('CLI slot：绑定真实选择器及 cliStore，不注入 ctx', composer?.options.select === undefined ? false :
        composer.options.select({ session: { subagent: { address: { mode: 'one-shot' } } } })?.reason === 'one-shot' &&
        typeof composer.options.inject().cliStore?.watch === 'function' && composer.options.inject().ctx === undefined);
      const settings = registered.find(({ options }) => options.name === 'settings.section');
      if (settings) {
        const { options, component } = settings;
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
  check('统一思考强度下拉含空不指定项与全部 EFFORT_VALUES', select?.props.value === 'high' &&
    JSON.stringify(select.children.flat().map(n => n.props.value)) === JSON.stringify(['', ...EFFORT_VALUES]) &&
    select.children.flat()[0]?.children.includes('留空：不指定强度'));
  check('强度帮助说明限定最终同路由与父未指定时的默认处理',
    all.some(n => n.type === 'span' && n.children.includes('留空时不指定思考强度：包裹子代理最终使用的 Provider 和模型均与父代理一致时，沿用父代理当前强度；否则按目标模型的默认设置处理。父代理未指定强度时，也按模型默认设置处理。')));
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
  check('保存按角色及各包裹字段 dirty 提交，未改 roles 传 undefined',
    CLIENT_SRC.includes('JSON.stringify(roles) !== JSON.stringify(saved.roles)') &&
    CLIENT_SRC.includes(".filter((key) => (wrapper[key] ?? '') !== (saved.wrapper?.[key] ?? ''))") &&
    CLIENT_SRC.includes('store.write(forceRoles || rolesDirty ? nextRoles : undefined, revision, wrapperChanges)'));
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
  const home = mkdtempSync(join(tmpdir(), 'switchboard-client-save-'));
  const path = configPathFor(home);
  const role = { id: 'preserved', description: '保留角色', instructions: '保留指令', model: 'test-model' };
  writeConfigFile(path, initialConfig([role], { provider: 'self', volatile: { other: 'keep' } }));
  let wrapper = { wrapperProvider: '', wrapperModel: '', wrapperEffort: '' };
  let revision = 31;
  const mirror = { volatile: wrapper }; // 根未提供 roles，但有效角色存在于文件。
  const store = makeRoleStore({
    configForms: { describe: () => ({ ensure: async () => {}, getSnapshot: () => ({ view: { namespaces: [
      { ns: 'agent-switchboard', value: mirror, revision, writable: true },
    ] } }) }) },
    remote: { settings: { mutate: async (ns, ops, rev) => {
      calls.push({ ns, ops, rev });
      for (const op of ops) {
        if (op.path[0] === 'roles') mirror.roles = op.value;
        else mirror.volatile[op.path[1]] = op.value;
      }
      wrapper = mirror.volatile;
      revision++;
      // 真正调用根同步和原子文件写入；仅 settings 传输与 ctx 服务被桩化。
      apply({ tools: { register() {} }, get: key => key === 'profileContext' ? { home } : undefined }, Config(mirror));
      return { ok: true };
    } } },
  });
  try {
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
  check('保存真实回调只提交已改包裹字段及原读取 revision', calls.length === 1 && calls[0].rev === 31 &&
    JSON.stringify(calls[0].ops) === JSON.stringify([
      { op: 'set', path: ['volatile', 'wrapperModel'], value: 'new-model' },
      { op: 'set', path: ['volatile', 'wrapperEffort'], value: 'high' },
    ]));
  check('M1：非空文件 + 根未提供 roles，客户端仅改 wrapper 保存仍保留文件角色',
    JSON.stringify(readConfigFile(path).value?.roles) === JSON.stringify([role]) && mirror.roles === undefined);
  check('M1：wrapper-only 保存不提交 roles，不把未提供折叠为显式清空',
    calls[0].ops.every(op => op.path[0] !== 'roles'));
  nodes = render();
  check('保存后刷新统一字段与 revision，dirty 清除', saveButton(nodes)?.props.disabled &&
    nodes.find(n => n.type?.name === 'WrapperSettings')?.props.wrapper.wrapperModel === 'new-model');
  nodes.find(n => n.type?.name === 'WrapperSettings').props.onChange({ wrapperProvider: '', wrapperModel: '', wrapperEffort: '' });
  nodes = render(); await saveButton(nodes).props.onClick(); await new Promise(setImmediate);
  check('清空后仍能保存，使用刷新后的 revision', calls.length === 2 && calls[1].rev === 32 &&
    calls[1].ops.length === 2 && calls[1].ops.every(op => op.value === '' && op.path[0] === 'volatile'));
  nodes = render();
  nodes.find(n => n.type?.name === 'WrapperSettings').props.onChange({ ...wrapper, wrapperEffort: 'invalid' });
  nodes = render(); await saveButton(nodes).props.onClick();
  check('非法包裹强度不调用写通道并给错误提示', calls.length === 2 &&
    render().some(n => n.children.includes('包裹子代理思考强度非法')));
  mirror.roles = [role];
  render().find(n => n.type === 'button' && n.children.includes('放弃改动')).props.onClick();
  await new Promise(setImmediate);
  nodes = render();
  await nodes.find(n => n.type?.name === 'RoleCard').props.onRemove();
  await new Promise(setImmediate);
  check('确认删除全部角色直接提交而非等待全局保存', calls.length === 3);
  check('删除全部角色明确提交 []，不提交未改包裹字段，并真正清空文件',
    JSON.stringify(calls[2]?.ops) === JSON.stringify([{ op: 'set', path: ['roles'], value: [] }]) &&
    readConfigFile(path).value?.roles.length === 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

section('角色卡片：真实编辑、草稿、校验、并发与增删回调');
{
  const contexts = new Map(); let active, used;
  const react = { ...rowReact,
    useState(initial) { const at = active.index++; if (!(at in active.states)) active.states[at] = typeof initial === 'function' ? initial() : initial;
      const current = active; return [current.states[at], value => { current.states[at] = typeof value === 'function' ? value(current.states[at]) : value; }]; },
    useRef(initial) { const at = active.refIndex++; return active.refs[at] ?? (active.refs[at] = { current: initial }); },
    useCallback: fn => fn, useEffect: effect => { active.effects.push(effect); },
  };
  const api = clientWindow.spec.factory(() => react);
  const good = { id: 'scout', title: '侦察员', backend: 'spawn', description: '描述', instructions: '指令', model: 'm', readOnly: true };
  const cli = { ...good, id: 'worker', title: '执行员', backend: 'cli', effort: 'medium', cliDriver: 'codex', ...clientData.cliFieldsFor('codex', true) };
  const mirror = { roles: [good, cli], volatile: {} }; let revision = 71, reject = false, readFails = false;
  const calls = [];
  const store = makeRoleStore({ configForms: { describe: () => ({ ensure: async () => { if (readFails) throw new Error('fixture read failure'); }, getSnapshot: () => ({ view: { namespaces: [
    { ns: 'agent-switchboard', value: mirror, revision, writable: true },
  ] } }) }) }, remote: { settings: { mutate: async (ns, ops, rev) => {
    calls.push({ ns, ops: structuredClone(ops), rev });
    if (reject) return { ok: false, error: { message: 'revision conflict' } };
    for (const op of ops) if (op.path[0] === 'roles') mirror.roles = structuredClone(op.value); else mirror.volatile[op.path[1]] = op.value;
    revision++; return { ok: true };
  } } } });
  function component(fn, props, key) {
    used.add(key); const prior = active;
    active = contexts.get(key) ?? { states: [], refs: [], effects: [] }; contexts.set(key, active);
    active.index = 0; active.refIndex = 0; active.effects = [];
    const tree = fn(props); active = prior; return tree;
  }
  function render() {
    used = new Set(); const nodes = [];
    const walk = node => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (typeof node.type === 'function') return walk(component(node.type, node.props, node.type.name + ':' + (node.props.key ?? 'singleton')));
      nodes.push(node); node.children?.forEach(walk);
    };
    walk(component(api.SwitchboardSettings, { store }, 'root'));
    for (const key of contexts.keys()) if (!used.has(key)) contexts.delete(key);
    return nodes;
  }
  const allOf = tree => { const nodes = []; const walk = n => { if (Array.isArray(n)) return n.forEach(walk); if (!n || typeof n !== 'object') return; nodes.push(n); n.children?.forEach(walk); }; walk(tree); return nodes; };
  const cards = nodes => nodes.filter(n => n.props?.className === 'rowCard');
  const buttonOf = (nodes, label) => nodes.find(n => n.type === 'button' && n.children.includes(label));
  const inCard = (nodes, id) => allOf(cards(nodes).find(n => n.props['data-role-id'] === id));
  const fieldOf = (nodes, label) => nodes.find(n => n.type === 'label' && n.children[0]?.children.includes(label))?.children[1];
  const settle = () => new Promise(setImmediate);
  render(); contexts.get('root').effects[0](); await settle();
  let nodes = render();
  check('卡片：每角色一张 li 卡片且带 rowHead', cards(nodes).length === 2 && cards(nodes).every(c => c.type === 'li' && allOf(c).some(n => n.props?.className === 'rowHead')));
  const headerText = nodes.filter(n => n.props?.className === 'rowHead').map(n => allOf(n).flatMap(x => x.children ?? []).filter(x => typeof x === 'string').join('|')).join('|');
  check('卡片头：标题、id、内置机制、外部 preset 与只读徽标', ['侦察员', 'scout', '内置 · spawn', '外部 · codex', '只读'].every(t => headerText.includes(t)));
  check('卡片状态：合法配置为 8px 成功态且有 aria-label', nodes.filter(n => n.props?.['data-state']).length === 2 && nodes.filter(n => n.props?.['data-state']).every(n => n.props['data-state'] === 'success' && n.props['aria-label'] === '配置完整有效' && n.props.style.width === '8px' && n.props.style.background === 'var(--dsw-alias-state-success-primary)'));
  check('卡片：初始折叠，无字段编辑器', !nodes.some(n => n.props?.className === 'rowEditor'));
  buttonOf(inCard(nodes, 'scout'), '编辑').props.onClick(); nodes = render();
  check('卡片聚焦：仅第一卡展开且 aria-expanded 同步', nodes.filter(n => n.props?.className === 'rowEditor').length === 1 && buttonOf(inCard(nodes, 'scout'), '收起').props['aria-expanded'] === true && buttonOf(inCard(nodes, 'worker'), '编辑').props['aria-expanded'] === false);
  fieldOf(nodes, '角色标题').props.onChange({ target: { value: '未保存草稿' } }); nodes = render();
  buttonOf(inCard(nodes, 'scout'), '取消').props.onClick(); nodes = render();
  buttonOf(inCard(nodes, 'scout'), '编辑').props.onClick(); nodes = render();
  check('卡片取消：重新展开丢弃本地草稿，未写入', fieldOf(nodes, '角色标题').props.value === '侦察员' && calls.length === 0);
  fieldOf(nodes, '角色指令（必填，发送给子代理）').props.onChange({ target: { value: '' } }); nodes = render();
  await buttonOf(inCard(nodes, 'scout'), '保存').props.onClick(); nodes = render();
  check('卡片校验：空指令禁止写入且卡片内红色 alert', calls.length === 0 && inCard(nodes, 'scout').some(n => n.props?.role === 'alert' && n.props.style.color === 'var(--dsw-alias-state-error-primary)'));
  fieldOf(nodes, '角色指令（必填，发送给子代理）').props.onChange({ target: { value: '新指令' } }); nodes = render();
  await buttonOf(inCard(nodes, 'scout'), '保存').props.onClick(); await settle(); nodes = render();
  check('卡片保存：恰好一次 mutate，roles 路径与读取 revision', calls.length === 1 && calls[0].ns === 'agent-switchboard' && calls[0].rev === 71 && calls[0].ops.length === 1 && JSON.stringify(calls[0].ops[0].path) === '["roles"]' && mirror.roles[0].instructions === '新指令' && mirror.roles[0].title === '侦察员');
  buttonOf(inCard(nodes, 'scout'), '编辑').props.onClick(); nodes = render();
  fieldOf(nodes, '角色标题').props.onChange({ target: { value: '切换焦点丢弃' } }); nodes = render();
  buttonOf(inCard(nodes, 'worker'), '编辑').props.onClick(); nodes = render();
  check('卡片聚焦：切换第二卡只展开一张，CLI 隐藏 Provider，包裹小节仍显示', nodes.filter(n => n.props?.className === 'rowEditor').length === 1 && !fieldOf(nodes, 'Provider') && Boolean(fieldOf(nodes, 'Provider（LLM route）')) && Boolean(fieldOf(nodes, '模型（非外部 CLI 模型）')));
  buttonOf(inCard(nodes, 'scout'), '编辑').props.onClick(); nodes = render();
  check('卡片聚焦：回到内置显示 Provider，切换时丢弃旧草稿', Boolean(fieldOf(nodes, 'Provider')) && fieldOf(nodes, '角色标题').props.value === '侦察员');
  reject = true;
  await buttonOf(inCard(nodes, 'scout'), '保存').props.onClick(); nodes = render();
  check('卡片失败：revision 冲突留在卡片并显示失败，不收起', inCard(nodes, 'scout').some(n => n.props?.role === 'alert' && n.children.some(t => typeof t === 'string' && t.includes('revision conflict'))) && Boolean(fieldOf(nodes, '角色 id')));
  reject = false; buttonOf(inCard(nodes, 'scout'), '取消').props.onClick(); nodes = render();
  buttonOf(nodes, '+ 新增角色').props.onClick(); nodes = render();
  check('卡片新增：原位新卡片，未保存不提交', cards(nodes).length === 3 && calls.length === 2);
  for (const [label, value] of [['角色 id', 'new-role'], ['描述（主代理据此判断何时派给谁）', '新描述'], ['角色指令（必填，发送给子代理）', '新指令'], ['模型', 'new-model']]) {
    fieldOf(nodes, label).props.onChange({ target: { value } }); nodes = render();
  }
  await buttonOf(inCard(nodes, ''), '保存').props.onClick(); await settle(); nodes = render();
  check('卡片新增：显式保存后 roles 长度加一', mirror.roles.length === 3 && calls.length === 3 && calls[2].rev === 72);
  buttonOf(inCard(nodes, 'new-role'), '删除').props.onClick(); nodes = render();
  check('卡片删除：第一步仅出现确认，不提交', calls.length === 3 && Boolean(buttonOf(inCard(nodes, 'new-role'), '确认删除')));
  buttonOf(inCard(nodes, 'new-role'), '取消').props.onClick(); nodes = render();
  check('卡片删除：取消确认不写入且保留角色', calls.length === 3 && !buttonOf(inCard(nodes, 'new-role'), '确认删除') && cards(nodes).length === 3);
  buttonOf(inCard(nodes, 'new-role'), '删除').props.onClick(); nodes = render();
  await buttonOf(inCard(nodes, 'new-role'), '确认删除').props.onClick(); await settle(); nodes = render();
  check('卡片删除：第二步恰好一次提交并使用新 revision', calls.length === 4 && mirror.roles.length === 2 && calls[3].rev === 73);
  mirror.roles = [{ ...good, instructions: '' }, { ...cli, cliArgs: ['unknown'] }];
  buttonOf(nodes, '放弃改动').props.onClick(); await settle(); nodes = render();
  check('卡片状态：缺必填与未知 CLI 预设均为错误态及可读原因', nodes.filter(n => n.props?.['data-state']).every(n => n.props['data-state'] === 'error' && n.props['aria-label'].startsWith('配置错误：') && n.props.style.background === 'var(--dsw-alias-state-error-primary)') && nodes.some(n => n.props?.['aria-label']?.includes('需重选预设')));
  mirror.roles[0] = good;
  buttonOf(nodes, '放弃改动').props.onClick(); await settle(); nodes = render();
  buttonOf(inCard(nodes, 'worker'), '编辑').props.onClick(); nodes = render();
  await buttonOf(inCard(nodes, 'worker'), '保存').props.onClick(); nodes = render();
  check('卡片校验：未识别预设独立阻止提交并显示需重选预设', calls.length === 4 && inCard(nodes, 'worker').some(n => n.props?.role === 'alert' && n.children.some(t => typeof t === 'string' && t.includes('需重选预设'))));
  check('卡片无障碍：所有按钮 type=button', nodes.filter(n => n.type === 'button').every(n => n.props.type === 'button'));

  // 批次 2：使用同一组件实例与按 key 复用的卡片，覆盖实际用户回调。
  mirror.roles = [{ ...good, title: '' }, cli, { ...good, id: 'last', title: '末行' }];
  buttonOf(nodes, '放弃改动').props.onClick(); await settle(); nodes = render();
  check('F9：空标题的卡片头部回退显示角色 id',
    inCard(nodes, 'scout').find(n => n.props?.className === 'rowName')?.children.includes('scout'));
  buttonOf(inCard(nodes, 'worker'), '删除').props.onClick(); nodes = render();
  const beforeDelete = calls.length;
  check('F4：三角色中间行先原位确认，尚未写入',
    cards(nodes).length === 3 && Boolean(buttonOf(inCard(nodes, 'worker'), '确认删除')));
  await buttonOf(inCard(nodes, 'worker'), '确认删除').props.onClick();
  nodes = render();
  check('F4：第二步清除确认状态，写入进行时不保留确认',
    !buttonOf(nodes, '确认删除'));
  await settle(); nodes = render();
  check('F4：删除中间行后位移卡片不继承确认态',
    calls.length === beforeDelete + 1 && cards(nodes).length === 2 &&
    cards(nodes)[1].props['data-role-id'] === 'last' && !buttonOf(inCard(nodes, 'last'), '确认删除'));
  buttonOf(inCard(nodes, 'last'), '删除').props.onClick(); nodes = render();
  buttonOf(inCard(nodes, 'scout'), '编辑').props.onClick(); nodes = render();
  check('F4：beginEdit 清除删除确认', !buttonOf(nodes, '确认删除'));
  buttonOf(inCard(nodes, 'last'), '删除').props.onClick(); nodes = render();
  buttonOf(inCard(nodes, 'scout'), '收起').props.onClick(); nodes = render();
  check('F4：cancelEdit 清除删除确认', !buttonOf(nodes, '确认删除'));

  mirror.roles = [cli];
  buttonOf(nodes, '放弃改动').props.onClick(); await settle(); nodes = render();
  buttonOf(inCard(nodes, 'worker'), '编辑').props.onClick(); nodes = render();
  const roleEffortOf = nodes => nodes.filter(n => n.type === 'label' && n.children[0]?.children.includes('思考强度')).at(-1)?.children[1];
  const effortSelect = roleEffortOf(nodes);
  check('F3-GUI：角色强度含可选的（未指定）空项',
    allOf(effortSelect).some(n => n.type === 'option' && n.props.value === '' && n.children.includes('（未指定）')));
  effortSelect.props.onChange({ target: { value: '' } }); nodes = render();
  const editingDraft = [...contexts.entries()].find(([key]) => key === 'RoleCard:0:true')?.[1].states[0];
  check('F3-GUI：选空从草稿删除 effort 键，显示未指定',
    editingDraft !== undefined && !Object.hasOwn(editingDraft, 'effort') && roleEffortOf(nodes).props.value === '');
  const beforeInvalid = calls.length;
  await buttonOf(inCard(nodes, 'worker'), '保存').props.onClick(); nodes = render();
  check('F3-GUI：引用 {effort} 的 CLI 草稿选空后被保存校验拦下',
    calls.length === beforeInvalid && inCard(nodes, 'worker').some(n => n.props?.role === 'alert' &&
      n.children.some(t => typeof t === 'string' && t.includes('{effort}'))));
  const absentWrites = [];
  const absentSelect = rowElements(good, absentWrites).find(n => n.type === 'select' &&
    allOf(n).some(o => o.type === 'option' && o.children.includes('（未指定）')));
  check('F3-GUI：原本缺省 effort 显示空项，不伪装 low', absentSelect?.props.value === '');

  buttonOf(inCard(nodes, 'worker'), '删除').props.onClick(); nodes = render();
  readFails = true;
  buttonOf(nodes, '放弃改动').props.onClick(); nodes = render();
  check('F1：重读进行中禁止保存', buttonOf(nodes, '保存')?.props.disabled === true);
  await settle(); nodes = render();
  check('F1：读取失败保存按钮 disabled，dirty 为 false（无保存 *）',
    buttonOf(nodes, '保存')?.props.disabled === true && !buttonOf(nodes, '保存 *'));
  check('F4：refresh 清除删除确认', !buttonOf(nodes, '确认删除'));
  check('F1：读取失败放弃改动可用以重试', buttonOf(nodes, '放弃改动')?.props.disabled === false);
  const beforeFailedRead = calls.length;
  await buttonOf(nodes, '保存').props.onClick(); nodes = render();
  check('F1：绕过 disabled 直接保存也不调用 store.write，提示不能写入',
    calls.length === beforeFailedRead && nodes.some(n => n.children.includes('读取失败，不能写入。点「放弃改动」可重试。')));
  // 控制两次重读的完成顺序，执行真实 refresh 回调而非仅检查源码守卫。
  const originalRead = store.read;
  const pendingReads = [];
  store.read = () => new Promise(resolve => pendingReads.push(resolve));
  const successfulRead = (id, rev) => ({ ok: true, roles: [{ ...good, id }],
    wrapper: { wrapperModel: id }, revision: rev });
  const rootSnapshot = () => JSON.stringify({ states: contexts.get('root').states, refs: contexts.get('root').refs });
  for (const [label, latest, stale] of [
    ['新成功后旧失败', successfulRead('latest', 901), { ok: false, error: 'stale failure' }],
    ['新成功后旧成功', successfulRead('latest', 902), successfulRead('stale', 801)],
    ['新失败后旧成功', { ok: false, error: 'latest failure' }, successfulRead('stale', 802)],
  ]) {
    buttonOf(nodes, '放弃改动').props.onClick(); nodes = render();
    buttonOf(nodes, '放弃改动').props.onClick(); nodes = render();
    const [resolveOld, resolveLatest] = pendingReads.splice(0);
    resolveLatest(latest); await settle(); nodes = render();
    const latestSnapshot = rootSnapshot();
    resolveOld(stale); await settle(); nodes = render();
    const errorVisible = nodes.some(n => n.children.some(t => typeof t === 'string' && t.startsWith('读取角色配置失败：')));
    // useState 顺序中的第 4 项是 readSucceeded；同时验证用户可见闸门。
    const readSucceeded = contexts.get('root').states[3];
    check(`F1-并发：${label}，旧响应不覆盖最新状态且读取闸门自洽`,
      rootSnapshot() === latestSnapshot && readSucceeded === latest.ok && errorVisible === !latest.ok &&
      buttonOf(nodes, '保存')?.props.disabled === true &&
      buttonOf(nodes, '放弃改动')?.props.disabled === latest.ok &&
      (latest.ok ? cards(nodes).length === 1 && cards(nodes)[0].props['data-role-id'] === 'latest' : cards(nodes).length === 0));
  }
  const beforeConcurrentFailureSave = calls.length;
  await buttonOf(nodes, '保存').props.onClick(); nodes = render();
  check('F1-并发：最新读取失败后直接保存仍不写入，放弃改动可重试',
    calls.length === beforeConcurrentFailureSave && buttonOf(nodes, '放弃改动')?.props.disabled === false);
  store.read = originalRead;
  // 验证失败后的成功读取空数组仍允许新增，且新角色默认 medium 不变。
  readFails = false;
  for (const missing of [false, true]) {
    if (missing) delete mirror.roles; else mirror.roles = [];
    buttonOf(nodes, '放弃改动').props.onClick(); await settle(); nodes = render();
    buttonOf(nodes, '+ 新增角色').props.onClick(); nodes = render();
    check(`F1/F3-GUI：${missing ? 'missing' : 'empty'} 成功读取可新增，默认强度 medium`,
      roleEffortOf(nodes)?.props.value === 'medium');
    for (const [label, value] of [['角色 id', 'recovered'], ['描述（主代理据此判断何时派给谁）', '描述'], ['角色指令（必填，发送给子代理）', '指令'], ['模型', 'm']]) {
      fieldOf(nodes, label).props.onChange({ target: { value } }); nodes = render();
    }
    const beforeRecover = calls.length;
    await buttonOf(inCard(nodes, ''), '保存').props.onClick(); await settle(); nodes = render();
    check(`F1：${missing ? 'missing' : 'empty'} 成功读取后新增可保存`,
      calls.length === beforeRecover + 1 && mirror.roles[0]?.id === 'recovered');
  }
}
check('面板无定时器：客户端无 setInterval/setTimeout', !/\b(?:setInterval|setTimeout)\s*\(/.test(CLIENT_SRC));

// 可控远程流：不启动 CLI，不访问安装目录；保留迟到帧以验证清理后的隔离。
const cliReact = { ...rowReact, useState: init => [typeof init === 'function' ? init() : init, () => {}], useRef: init => ({ current: init }), useEffect: () => {} };
const cliApi = clientWindow.spec.factory(() => cliReact);
const settleCli = () => new Promise(setImmediate);
function makeBoundCliStore(remote) {
  const store = cliApi.makeCliStore();
  store.bind({ $stream: options => remote.$stream(options), job: remote.job });
  return store;
}
// 子 inject 的激活由测试控制；缺失服务时回调不执行，父 slot 仍必须注册。
function fakeCliApply() {
  const registered = [], injections = [];
  const ctx = {
    configForms: { describe: () => ({ ensure: async () => {}, getSnapshot: () => ({ view: { namespaces: [], writable: false } }), subscribe: () => () => {} }) },
    remote: { settings: { mutate: async () => ({ ok: true }) } },
    inject: (deps, callback) => { injections.push({ deps, callback }); },
    slots: { inject: (_name, callback) => callback(), register: (options, component) => registered.push({ options, component }) },
  };
  const dispose = cliApi.apply(ctx);
  const composer = registered.find(entry => entry.options.name === 'conversation.composer');
  return { registered, injections, dispose, store: composer.options.inject().cliStore, composer };
}
function cliNodes(tree) {
  const nodes = [];
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'function') return walk(cliApi[node.type.name](node.props));
    nodes.push(node); node.children?.forEach(walk);
  };
  walk(tree);
  return nodes;
}
const cliText = tree => cliNodes(tree).flatMap(node => node.children.filter(child => typeof child === 'string')).join('\n');
function fakeCliRemote() {
  const streams = [], calls = [], counters = { kill: 0, model: 0, readAt: 0 };
  const remote = {
    job: {
      list: (request, signal) => { calls.push({ method: 'list', request, signal }); },
      follow: (request, signal) => { calls.push({ method: 'follow', request, signal }); },
      kill: () => { counters.kill++; }, readAt: () => { counters.readAt++; },
    },
    model: () => { counters.model++; },
    llm: { generate: () => { counters.model++; } },
    $stream: options => {
      const pending = [], queued = [];
      const stream = {
        options, accepted: 0, disposed: 0, restarted: 0,
        restart() { stream.restarted++; options.open({ tag: 'restart-signal' }); },
        carrierFailed: error => options.carrierFailed(error),
        push(value) {
          const result = { value: { value, accept: () => { stream.accepted++; } }, done: false };
          if (pending.length) pending.shift().resolve(result); else queued.push(result);
        },
        end() { const result = { done: true }; if (pending.length) pending.shift().resolve(result); else queued.push(result); },
        reject(error) { if (pending.length) pending.shift().reject(error); else queued.push({ error }); },
        reopen: () => options.open({ tag: 'reconnect-signal' }),
        dispose: () => { stream.disposed++; },
        [Symbol.asyncIterator]() { return this; },
        next() {
          if (queued.length) { const item = queued.shift(); return item.error ? Promise.reject(item.error) : Promise.resolve(item); }
          return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        },
        return: () => Promise.resolve({ done: true }),
      };
      streams.push(stream);
      options.open({ tag: 'initial-signal' });
      return stream;
    },
  };
  return { remote, streams, calls, counters };
}
const cliRow = (id, owner = 'session-A', patch = {}) => ({ id, owner, kind: 'cli', label: id, status: 'running', startedAt: 1, ...patch });
const openedCli = (job, from = 0, earliest = 0) => ({ type: 'opened', job: { ...job, output: { earliest } }, from });
const outputCli = (chunks, next, patch = {}) => ({ type: 'output', chunks, next, ...patch });

section('CLI composer：one-shot 选择、官方只读占位与无 turn 输出');
{
  const { selectCliComposer, CliReadOnlyComposer, CliOutputPanel, CliJobOutput } = cliApi;
  check('粘底判定：底部及 8px 容差边界为 true', cliApi.isAtScrollBottom(100, 300, 200) && cliApi.isAtScrollBottom(92, 300, 200));
  check('粘底判定：超过容差为 false', !cliApi.isAtScrollBottom(90, 300, 200));
  check('CLI 面板不含定时器', !/setInterval|setTimeout/.test(CLIENT_SRC.slice(CLIENT_SRC.indexOf('function CliJobOutput'), CLIENT_SRC.indexOf('function CliOutputPanel'))));
  const scrollPropsTree = CliJobOutput({ job: cliRow('running', 's', { chunks: [{ channel: 'stdout', text: 'x' }] }) });
  const scrollNodes = cliNodes(scrollPropsTree);
  check('滚动容器携带 ref 与滚动状态回调', scrollNodes.some(node => node.type === 'pre' && node.props.ref && typeof node.props.onScroll === 'function'));
  check('回底按钮中文标签清晰', CLIENT_SRC.includes("'aria-label': '滚动到最下'"));
  check('CLI select：仅 session.subagent.address.mode one-shot 被选中',
    selectCliComposer({ session: { subagent: { address: { mode: 'one-shot' } } } })?.reason === 'one-shot');
  for (const [name, owner] of Object.entries({ main: { session: {} }, continuable: { session: { subagent: { address: { mode: 'continuable' } } } },
    unknown: { session: { subagent: { address: { mode: 'unknown' } } } }, missing: {}, decoy: { session: { mode: 'one-shot', subagent: { mode: 'one-shot' } } } })) {
    check(`CLI select：${name} 不接管`, selectCliComposer(owner) === null);
  }
  const tree = CliReadOnlyComposer({ sessionId: 'other-one-shot', cliStore: {} });
  const nodes = cliNodes(tree), placeholder = nodes.find(node => node.props?.role === 'status');
  check('CLI 占位：无 CLI 的其它 one-shot 保留官方标题与正文', cliText(tree).includes('一次性子智能体记录') &&
    cliText(tree).includes('一次性任务不支持后续消息，可在这里查看完整执行记录。'));
  check('CLI 占位：官方 role status 与相同 style', JSON.stringify(placeholder?.props.style) === JSON.stringify({
    border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-lg)', background: 'var(--dsw-alias-bg-layer-1)',
    minHeight: 54, color: 'var(--dsw-alias-label-tertiary)', justifyContent: 'center', alignItems: 'center', gap: 8,
    margin: '0 24px 20px', padding: '10px 16px', fontSize: 13, lineHeight: '20px', display: 'flex',
  }) && nodes.find(node => node.type === 'strong')?.props.style.fontWeight === 510);
  check('CLI 占位：没有输入、发送或 continuation 控件', !nodes.some(node => ['input', 'textarea', 'button', 'form'].includes(node.type)));
  const keys = [];
  const translated = CliReadOnlyComposer({ sessionId: 's', cliStore: {}, t: key => { keys.push(key); return `translated:${key}`; } });
  check('CLI 占位：沿用官方翻译 keys', keys.join(',') === 'readonly.oneShot.title,readonly.oneShot.body' && cliText(translated).includes('translated:readonly.oneShot.body'));
  check('CLI 占位：翻译抛错仍安全回落', cliText(CliReadOnlyComposer({ sessionId: 's', cliStore: {}, t: () => { throw new Error('translation'); } })).includes('一次性子智能体记录'));
  check('CLI panel：没有 job 返回 null', CliOutputPanel({ snapshot: { jobs: [], error: null } }) === null);
  const errorTree = CliOutputPanel({ snapshot: { jobs: [], error: 'offline' } });
  check('CLI panel：error 不能伪装无 job 的 null', errorTree !== null && cliNodes(errorTree).some(node => node.props?.role === 'alert') && cliText(errorTree).includes('offline'));
  for (const [status, label] of [['completed', '已结算'], ['failed', '失败'], ['killed', '被终止']]) {
    const result = CliJobOutput({ job: cliRow(status, 's', { status, gap: true, error: 'follow offline' }) });
    check(`CLI 渲染：${status} 状态、gap 和订阅错误可见`, cliText(result).includes(label) && cliText(result).includes('gap') && cliText(result).includes('follow offline') && !result.props.open);
  }
}

section('CLI apply：可选子注入、作用域捕获与服务重绑');
{
  const applied = fakeCliApply(), snapshots = [];
  check('CLI apply：子 inject 真正声明 remote 和 remote.job', applied.injections.length === 1 && JSON.stringify(applied.injections[0].deps) === JSON.stringify(['remote', 'remote.job']));
  check('CLI apply：未激活子注入也注册 settings/composer', applied.registered.length === 2 && applied.registered.some(entry => entry.options.name === 'settings.section'));
  const stop = applied.store.watch('session-A', snapshot => snapshots.push(snapshot));
  const unavailable = cliApi.CliOutputPanel({ snapshot: snapshots.at(-1) });
  const readonly = applied.composer.component({ sessionId: 'session-A', cliStore: applied.store });
  check('CLI apply：服务未出现为极简 status，readonly 占位仍存在', snapshots.at(-1).unavailable === true && snapshots.at(-1).error === null && cliText(unavailable) === 'CLI 实时输出暂不可用。' && cliNodes(unavailable).some(node => node.props?.role === 'status') && cliText(readonly).includes('一次性子智能体记录'));
  const first = fakeCliRemote(), second = fakeCliRemote();
  let activeScope = false, remoteReads = 0, jobReads = 0;
  const face = { $stream: options => first.remote.$stream(options), get job() {
    jobReads++; if (!activeScope) throw new Error('job read outside injection'); return first.remote.job;
  } };
  const scope = { get remote() {
    remoteReads++; if (!activeScope) throw new Error('remote read outside injection'); return face;
  } };
  check('CLI apply：子作用域激活前不访问 remote/job getter', remoteReads === 0 && jobReads === 0);
  activeScope = true;
  const oldUnbind = applied.injections[0].callback(scope);
  activeScope = false;
  check('CLI apply：服务迟出现主动重启已有 watch，无需重新挂载', first.streams.length === 1 && remoteReads === 1 && jobReads === 1);
  first.streams[0].push({ type: 'rows', jobs: [cliRow('old-binding')] }); await settleCli();
  first.streams[1].push(openedCli(cliRow('old-binding')));
  first.streams[1].push(outputCli([{ text: 'OLD BINDING' }], 321)); await settleCli();
  first.streams[0].reopen(); first.streams[1].reopen();
  const reopenedFrom = first.calls.at(-1).request.from;
  const extraWatch = applied.store.watch('session-B', () => {}); extraWatch();
  check('CLI apply：后续 watch/follow/reopen 不重读 scope 命名空间', remoteReads === 1 && jobReads === 1 && reopenedFrom === 321);
  const newUnbind = applied.injections[0].callback({ remote: second.remote });
  check('CLI apply：重绑立即释放旧 list/follow，重启现有 watch', first.streams.every(stream => stream.disposed === 1) && second.streams.length === 1);
  oldUnbind(); oldUnbind();
  check('CLI apply：旧 token unbind 不撤销新 binding', second.streams[0].disposed === 0 && !snapshots.at(-1).unavailable);
  second.streams[0].push({ type: 'rows', jobs: [cliRow('new-binding')] }); await settleCli();
  second.streams[1].push(openedCli(cliRow('new-binding')));
  second.streams[1].push(outputCli([{ text: 'NEW BINDING' }], 654)); await settleCli();
  const beforeLate = snapshots.length;
  first.streams[0].push({ type: 'rows', jobs: [cliRow('late-binding')] });
  first.streams[1].push(outputCli([{ text: 'PRIVATE LATE' }], 900)); await settleCli();
  check('CLI apply：重绑后旧流迟到不串新输出或创建 follow', snapshots.length === beforeLate && snapshots.at(-1).jobs[0].chunks[0].text === 'NEW BINDING' && !first.calls.some(call => call.request.jobId === 'late-binding'));
  newUnbind(); newUnbind();
  check('CLI apply：服务消失主动释放流并显示 unavailable', second.streams.every(stream => stream.disposed === 1) && snapshots.at(-1).unavailable && snapshots.at(-1).jobs.length === 0);
  const restoredUnbind = applied.injections[0].callback({ remote: second.remote });
  second.streams[2].push({ type: 'rows', jobs: [] }); await settleCli();
  check('CLI apply：服务恢复主动重启同一 watch 并刷新 unavailable', second.streams.length === 3 && !snapshots.at(-1).unavailable && snapshots.at(-1).error === null);
  applied.dispose(); applied.dispose();
  const afterDispose = snapshots.length, streamsAfterDispose = second.streams.length;
  restoredUnbind(); applied.injections[0].callback({ remote: second.remote });
  const closedWatch = applied.store.watch('session-B', snapshot => snapshots.push(snapshot));
  second.streams.at(-1).push({ type: 'rows', jobs: [cliRow('after-close')] }); await settleCli();
  check('CLI apply：父 dispose 幂等无 kill，闭店不重启/通知', second.streams.every(stream => stream.disposed === 1) && second.streams.length === streamsAfterDispose && snapshots.length === afterDispose && [...Object.values(first.counters), ...Object.values(second.counters)].every(value => value === 0));
  stop(); closedWatch();
}

section('CLI store：会话归属、帧确认、游标复用与快速结算');
{
  const fake = fakeCliRemote(), snapshots = [];
  const stop = makeBoundCliStore(fake.remote).watch('session-A', snapshot => snapshots.push(snapshot));
  const list = fake.streams[0];
  const rows = [cliRow('first'), cliRow('second'), cliRow('foreign', 'session-B'), cliRow('unowned', undefined, { owner: undefined }), cliRow('builtin', 'session-A', { kind: 'spawn' })];
  list.push({ type: 'rows', jobs: rows }); await settleCli();
  check('CLI store：list/follow 都传当前 sessionId 和 signal', fake.calls.length === 3 && fake.calls.every(call => call.request.sessionId === 'session-A' && call.signal.tag === 'initial-signal'));
  check('CLI store：仅 kind cli 且 owner===sessionId，不观察 foreign/unowned', snapshots.at(-1).jobs.map(job => job.id).join(',') === 'first,second' && fake.calls.filter(call => call.method === 'follow').map(call => call.request.jobId).join(',') === 'first,second');
  check('CLI store：rows item.value 被消费并 accept', list.accepted === 1);
  const first = fake.streams[1], second = fake.streams[2];
  first.push(openedCli(rows[0])); second.push(openedCli(rows[1]));
  first.push(outputCli([{ channel: 'stdout', text: '你好😀' }, { channel: 'stderr', text: 'warning' }], 917));
  second.push(outputCli([{ channel: 'stderr', text: 'second-error' }], 41)); await settleCli();
  check('CLI store：多个 CLI stdout/stderr 保持各任务隔离', snapshots.at(-1).jobs[0].chunks.map(chunk => chunk.text).join('|') === '你好😀|warning' && snapshots.at(-1).jobs[1].chunks[0].text === 'second-error');
  check('CLI store：opened 被 accept，output 不被当作锚点确认', first.accepted === 1 && second.accepted === 1);
  first.reopen();
  check('CLI store：follow 重连 from 原样复用 frame.next，不算文本偏移', fake.calls.at(-1).request.from === 917 && fake.calls.at(-1).request.jobId === 'first');
  first.push({ type: 'status', job: { status: 'completed' } }); second.push({ type: 'status', job: { status: 'failed' } }); await settleCli();
  check('CLI store：opened/output/status 快速完成保留输出，无意外结束错误', snapshots.at(-1).jobs[0].status === 'completed' && snapshots.at(-1).jobs[0].chunks.length === 2 && !snapshots.at(-1).jobs[0].error && snapshots.at(-1).jobs[1].status === 'failed' && !snapshots.at(-1).jobs[1].error);
  check('CLI store：terminal status 释放 follow 流', first.disposed === 1 && second.disposed === 1 && list.disposed === 0);
  stop(); stop();
  check('CLI store：dispose 幂等，只释放流，kill/model/readAt 计数为 0', fake.streams.every(stream => stream.disposed === 1) && Object.values(fake.counters).every(value => value === 0));
  const killed = fakeCliRemote(), killedSnapshots = [];
  const stopKilled = makeBoundCliStore(killed.remote).watch('session-A', snapshot => killedSnapshots.push(snapshot));
  killed.streams[0].push({ type: 'rows', jobs: [cliRow('killed', 'session-A', { status: 'killed' })] }); await settleCli();
  killed.streams[1].push(openedCli(cliRow('killed')));
  killed.streams[1].push(outputCli([{ text: 'final output' }], 500));
  killed.streams[1].push({ type: 'status', job: { status: 'killed' } }); await settleCli();
  check('CLI store：已快速 killed 任务仍 follow 并显示最终输出', killedSnapshots.at(-1).jobs[0].status === 'killed' && killedSnapshots.at(-1).jobs[0].chunks[0].text === 'final output' && !killedSnapshots.at(-1).jobs[0].error);
  stopKilled();
}

section('CLI store：缺失服务、抛错、reject 与意外结束显式错误');
{
  for (const [label, face, expected] of [
    ['job 缺失', { $stream() {} }, '任务观察服务不可用'],
    ['$stream 缺失', { job: { list() {}, follow() {} } }, '任务观察服务不可用'],
    ['list 缺失', { $stream() {}, job: { follow() {} } }, '任务观察服务不可用'],
    ['follow 缺失', { $stream() {}, job: { list() {} } }, '任务观察服务不可用'],
    ['方法 getter 抛错', { $stream() {}, job: { get list() { throw new Error('list getter failed'); }, follow() {} } }, 'list getter failed'],
    ['$stream 同步抛错', { $stream() { throw new Error('stream sync failed'); }, job: { list() {}, follow() {} } }, 'stream sync failed'],
  ]) {
    const snapshots = [], store = cliApi.makeCliStore();
    store.bind(face);
    let stop, thrown;
    try { stop = store.watch('s', snapshot => snapshots.push(snapshot)); } catch (error) { thrown = error; }
    check(`CLI 错误：${label} 显式提示而非 throw/空面板`, !thrown && snapshots.at(-1)?.error.includes(expected) && cliNodes(cliApi.CliOutputPanel({ snapshot: snapshots.at(-1) })).some(node => node.props?.role === 'alert'));
    stop?.(); store.dispose();
  }
  for (const [label, scope] of [
    ['remote getter', { get remote() { throw new Error('remote getter failed'); } }],
    ['job getter', { remote: { get job() { throw new Error('job getter failed'); } } }],
  ]) {
    const applied = fakeCliApply(), snapshots = [];
    const stop = applied.store.watch('s', snapshot => snapshots.push(snapshot));
    let unbind, thrown;
    try { unbind = applied.injections[0].callback(scope); } catch (error) { thrown = error; }
    check(`CLI apply：${label} 抛错降级 unavailable status，不阻断父 slots`, !thrown && applied.registered.length === 2 && snapshots.at(-1).unavailable && cliNodes(cliApi.CliOutputPanel({ snapshot: snapshots.at(-1) })).some(node => node.props?.role === 'status'));
    unbind?.(); stop(); applied.dispose();
  }
  for (const scope of ['list', 'follow']) for (const ending of ['reject', 'end']) {
    const fake = fakeCliRemote(), snapshots = [];
    const stop = makeBoundCliStore(fake.remote).watch('session-A', snapshot => snapshots.push(snapshot));
    if (scope === 'follow') { fake.streams[0].push({ type: 'rows', jobs: [cliRow('broken')] }); await settleCli(); }
    const stream = fake.streams[scope === 'list' ? 0 : 1];
    check(`CLI 流契约：${scope}/${ending} 提供 ended 错误`, stream.options.ended(false) instanceof Error && stream.restarted === 0);
    if (ending === 'reject') stream.reject(new Error(`${scope} rejection`)); else stream.end();
    await settleCli();
    const error = scope === 'list' ? snapshots.at(-1)?.error : snapshots.at(-1)?.jobs[0].error;
    check(`CLI 错误：${scope} 流 ${ending} 显式错误并释放流`, Boolean(error?.includes(ending === 'reject' ? `${scope} rejection` : '订阅意外结束')) && stream.disposed === 1);
    stop();
  }
}

section('CLI stream：carrierFailed 与 accepted EOF 公开 restart 恢复');
{
  for (const scope of ['list', 'follow']) {
    const fake = fakeCliRemote(), snapshots = [], store = makeBoundCliStore(fake.remote);
    const stop = store.watch('session-A', snapshot => snapshots.push(snapshot));
    fake.streams[0].push({ type: 'rows', jobs: [cliRow('recover')] }); await settleCli();
    const stream = fake.streams[scope === 'list' ? 0 : 1];
    if (scope === 'follow') {
      stream.push(openedCli(cliRow('recover')));
      stream.push(outputCli([{ text: 'before restart' }], 8123)); await settleCli();
    }
    const errorOf = () => scope === 'list' ? snapshots.at(-1).error : snapshots.at(-1).jobs[0].error;
    const panel = () => cliApi.CliOutputPanel({ snapshot: snapshots.at(-1) });
    stream.carrierFailed(new Error(`${scope} carrier lost`));
    check(`CLI carrier：${scope} 显式 alert 而非静默`, errorOf()?.includes('carrier lost') && cliText(panel()).includes('carrier lost') && cliNodes(panel()).some(node => node.props?.role === 'alert'));
    if (scope === 'list') stream.push({ type: 'rows', jobs: [cliRow('recover')] });
    else stream.push(openedCli(cliRow('recover'), 8123));
    await settleCli();
    check(`CLI carrier：${scope} rows/opened 清理错误并恢复显示`, errorOf() === null && !cliNodes(panel()).some(node => node.props?.role === 'alert'));
    const priorCalls = fake.calls.length;
    const endedError = stream.options.ended(true);
    check(`CLI ended(true)：${scope} 调用公开 restart 重新 open`, endedError instanceof Error && stream.restarted === 1 && fake.calls.length === priorCalls + 1 && fake.calls.at(-1).method === scope && fake.calls.at(-1).signal.tag === 'restart-signal');
    check(`CLI ended(true)：${scope} 重订阅期间明确失败提示`, errorOf()?.includes('正在重新订阅') && cliText(panel()).includes('正在重新订阅'));
    if (scope === 'follow') check('CLI restart：follow 原样携带 frame.next 游标', fake.calls.at(-1).request.from === 8123 && fake.calls.at(-1).request.jobId === 'recover');
    if (scope === 'list') stream.push({ type: 'rows', jobs: [cliRow('recover')] });
    else { stream.push(openedCli(cliRow('recover'), 8123)); stream.push(outputCli([{ channel: 'stderr', text: 'after restart' }], 9000)); }
    await settleCli();
    check(`CLI ended(true)：${scope} 锚点恢复清除失败提示`, errorOf() === null && !cliNodes(panel()).some(node => node.props?.role === 'alert') && (scope === 'list' || snapshots.at(-1).jobs[0].chunks.map(chunk => chunk.text).join('|') === 'before restart|after restart'));
    stop(); store.dispose();
    check(`CLI restart：${scope} 清理无 kill/model/readAt`, fake.streams.every(item => item.disposed === 1) && Object.values(fake.counters).every(value => value === 0));
  }
}

// 官方 gateway RemoteStream.read 的关键控制流形态：ended 返回普通 Error，
// 但公开 restart 改 revision，catch 在判别错误类型之前 continue 下一 generation。
// 对应 @deepseek-ai/dsh-api-gateway/lib/types/client/remote-stream.js；无安装路径依赖。
section('Gateway read 形态：revision catch 继续下一代（无需私有 carrier error）');
{
  class GatewayReadShape {
    revision = 0;
    restarted = 0;
    generation = 0;
    accepted = 0;
    disposed = 0;
    closed = false;
    constructor(options) { this.options = options; }
    restart() { if (!this.closed) { this.restarted++; this.revision++; } }
    dispose() { if (!this.closed) { this.closed = true; this.disposed++; } }
    async *read() {
      while (!this.closed) {
        const revision = this.revision, generation = ++this.generation;
        let accepted = false;
        try {
          for await (const value of this.options.open({ tag: `gateway-generation-${generation}` })) {
            if (this.closed) return;
            if (revision !== this.revision) break;
            yield { value, generation, accept: () => { if (revision === this.revision) { accepted = true; this.accepted++; } } };
          }
          if (this.closed) return;
          if (revision !== this.revision) continue;
          throw this.options.ended(accepted);
        } catch (error) {
          if (this.closed) return;
          if (revision !== this.revision) continue;
          throw error;
        }
      }
    }
    [Symbol.asyncIterator]() { return this.read(); }
  }
  const streams = [], calls = [], snapshots = [];
  let release;
  const parked = new Promise(resolve => { release = resolve; });
  const remote = {
    job: {
      async *list(request, signal) {
        calls.push({ method: 'list', request, signal });
        yield { type: 'rows', jobs: [cliRow('gateway-job')] };
        await parked;
      },
      async *follow(request, signal) {
        calls.push({ method: 'follow', request, signal });
        yield openedCli(cliRow('gateway-job'), request.from ?? 0);
        yield outputCli([{ text: request.from === undefined ? 'first generation' : 'second generation' }], request.from === undefined ? 7654 : 9876);
        if (request.from !== undefined) await parked;
      },
    },
    $stream(options) { const stream = new GatewayReadShape(options); streams.push(stream); return stream; },
  };
  const store = makeBoundCliStore(remote), stop = store.watch('session-A', snapshot => snapshots.push(snapshot));
  await settleCli();
  const follow = streams[1];
  check('Gateway revision：accepted EOF 普通 Error 被 revision catch 越过', follow.restarted === 1 && follow.generation === 2 && follow.accepted === 2 && follow.disposed === 0);
  check('Gateway revision：真实 store 第二代 open 保留 next，不丢已收输出', calls.filter(call => call.method === 'follow').map(call => call.request.from).join(',') === ',7654' && snapshots.at(-1).jobs[0].chunks.map(chunk => chunk.text).join('|') === 'first generation|second generation');
  check('Gateway revision：先发布重订阅错误，opened 后恢复', snapshots.some(snapshot => snapshot.jobs[0]?.error?.includes('正在重新订阅')) && snapshots.at(-1).jobs[0].error === null);
  stop(); store.dispose(); release(); await settleCli();
  check('Gateway revision：无遗漏流且 cleanup 幂等', streams.every(stream => stream.disposed === 1));
}

section('CLI store：32k chars / 256 chunks / 8 jobs 与 gap');
{
  const fake = fakeCliRemote(), snapshots = [];
  const stop = makeBoundCliStore(fake.remote).watch('session-A', snapshot => snapshots.push(snapshot));
  const rows = Array.from({ length: 10 }, (_, index) => cliRow(`bounded-${index}`, 'session-A', { startedAt: index, status: index === 0 ? 'running' : 'completed' }));
  fake.streams[0].push({ type: 'rows', jobs: rows }); await settleCli();
  check('CLI 有界：最多 8 jobs，优先运行任务，其次最新结算任务，omitted=2', snapshots.at(-1).jobs.map(job => job.id).join(',') === 'bounded-0,bounded-9,bounded-8,bounded-7,bounded-6,bounded-5,bounded-4,bounded-3' && snapshots.at(-1).omitted === 2 && fake.streams.length === 9);
  check('CLI 有界：panel 显示 omitted 提示', cliText(cliApi.CliOutputPanel({ snapshot: snapshots.at(-1) })).includes('另 2 个未显示'));
  const follow = fake.streams[1]; follow.push(openedCli(rows[0]));
  follow.push(outputCli([{ text: 'x'.repeat(40000) + 'TAIL' }], 100000)); await settleCli();
  let job = snapshots.at(-1).jobs[0];
  check('CLI 有界：32k chars 上限保留尾部并标记 gap', job.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) === 32768 && job.chunks.at(-1).text.endsWith('TAIL') && job.gap);
  follow.push(outputCli(Array.from({ length: 300 }, (_, index) => ({ text: `${index},` })), 200000)); await settleCli();
  job = snapshots.at(-1).jobs[0];
  check('CLI 有界：256 chunks 上限保留最新 256 个片段', job.chunks.length === 256 && job.chunks[0].text === '44,' && job.chunks.at(-1).text === '299,' && job.gap);
  const cases = [['lossy', openedCli(rows[1]), outputCli([{ text: 'lossy' }], 1, { lossy: true })],
    ['gapBefore', openedCli(rows[2]), outputCli([{ text: 'gap', gapBefore: true }], 1)],
    ['earliest', openedCli(rows[3], 2, 20), outputCli([{ text: 'tail' }], 99)],
    ['from>0', openedCli(rows[4], 20, 0), outputCli([{ text: 'tail' }], 99)]];
  for (const [index, [label, open, output]] of cases.entries()) {
    const stream = fake.streams[index + 2]; stream.push(open); stream.push(output); await settleCli();
    check(`CLI gap：${label} 明确标记而非伪装完整输出`, snapshots.at(-1).jobs[index + 1].gap === true);
  }
  fake.streams[0].push({ type: 'rows', jobs: [rows[0]] }); await settleCli();
  check('CLI 有界：列表移除任务仅释放其观察流', fake.streams.slice(2).every(stream => stream.disposed === 1) && follow.disposed === 0 && snapshots.at(-1).jobs.length === 1 && Object.values(fake.counters).every(value => value === 0));
  stop();
}

section('CLI composer 生命周期：首帧隔离、会话切换与卸载');
{
  const states = [], effects = []; let index = 0;
  const react = { ...rowReact,
    useState: initial => { const at = index++; if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial;
      return [states[at], value => { states[at] = typeof value === 'function' ? value(states[at]) : value; }]; },
    useEffect: (effect, deps) => { effects.push({ effect, deps }); },
  };
  const { CliReadOnlyComposer } = clientWindow.spec.factory(() => react);
  const fake = fakeCliRemote(), realStore = makeBoundCliStore(fake.remote), callbacks = [];
  const store = { watch: (id, notify) => { callbacks.push(notify); return realStore.watch(id, notify); } };
  let cleanup, priorDeps;
  const sessions = new Map(['session-A', 'session-B'].map(id => [id, { id, subagent: { address: { mode: 'one-shot' } } }]));
  const render = sessionId => { index = 0; effects.length = 0; return CliReadOnlyComposer({ sessionId, session: sessions.get(sessionId), cliStore: store }); };
  const commit = () => { const { effect, deps } = effects[0]; if (!priorDeps || deps.some((value, at) => value !== priorDeps[at])) {
    cleanup?.(); cleanup = effect(); priorDeps = deps;
  } };
  render('session-A'); commit();
  fake.streams[0].push({ type: 'rows', jobs: [cliRow('old-job')] }); await settleCli();
  fake.streams[1].push(openedCli(cliRow('old-job'))); fake.streams[1].push(outputCli([{ text: 'OLD PRIVATE OUTPUT' }], 70)); await settleCli();
  check('CLI 生命周期：挂载订阅输出真实进入组件', cliText(render('session-A')).includes('OLD PRIVATE OUTPUT'));
  const noTurnSession = sessions.get('session-A');
  fake.streams[1].push(outputCli([{ channel: 'stderr', text: 'diagnostic without turn/end' }], 71)); await settleCli();
  const noTurnTree = render('session-A'), noTurnNodes = cliNodes(noTurnTree);
  check('CLI 渲染：真实挂载 session 无 turn/end，rows/output 实时渲染 stdout/stderr', !('turn' in noTurnSession) && !('end' in noTurnSession) && cliText(noTurnTree).includes('[stdout] OLD PRIVATE OUTPUT') && cliText(noTurnTree).includes('[stderr] diagnostic without turn/end'));
  check('CLI 渲染：真实订阅 stderr 通道样式与 running 默认展开', noTurnNodes.some(node => node.props?.['data-channel'] === 'stderr' && node.props.style.color === 'var(--dsw-alias-label-error)') && noTurnNodes.some(node => node.type === 'details' && node.props.open));
  check('CLI 渲染：实时输出也绝对 readonly，不出现输入/发送/continuation 控件', !noTurnNodes.some(node => ['input', 'textarea', 'button', 'form'].includes(node.type)) && cliText(noTurnTree).includes('一次性任务不支持后续消息，可在这里查看完整执行记录。'));
  const firstNewTree = render('session-B');
  check('CLI 生命周期：新会话 commit 前首帧 mask 旧 state', !cliText(firstNewTree).includes('OLD PRIVATE OUTPUT') && firstNewTree.children[0].props.snapshot.sessionId === 'session-B' && firstNewTree.children[0].props.snapshot.jobs.length === 0);
  commit();
  check('CLI 生命周期：会话切换释放旧 list/follow，订阅新 sessionId', fake.streams[0].disposed === 1 && fake.streams[1].disposed === 1 && fake.calls.at(-1).request.sessionId === 'session-B');
  const newList = fake.streams[2];
  newList.push({ type: 'rows', jobs: [] }); await settleCli();
  const emptyTree = render('session-B'), emptyNodes = cliNodes(emptyTree);
  const emptyPlaceholder = emptyNodes.find(node => node.props?.role === 'status');
  check('CLI 生命周期：其它 one-shot 真实空 rows 保留官方占位 fidelity，无 CLI 面板/控件', emptyTree.children[0].props.snapshot.jobs.length === 0 && !emptyNodes.some(node => node.props?.['aria-label'] === 'CLI 实时输出' || ['input', 'textarea', 'button', 'form'].includes(node.type)) && cliText(emptyTree).includes('一次性子智能体记录') && cliText(emptyTree).includes('一次性任务不支持后续消息，可在这里查看完整执行记录。') && emptyPlaceholder.props.style.margin === '0 24px 20px' && emptyNodes.find(node => node.type === 'strong')?.props.style.fontWeight === 510);
  newList.push({ type: 'rows', jobs: [cliRow('new-job', 'session-B')] }); await settleCli();
  fake.streams[3].push(openedCli(cliRow('new-job', 'session-B'))); fake.streams[3].push(outputCli([{ text: 'NEW OUTPUT' }], 90)); await settleCli();
  const beforeLate = states[0];
  fake.streams[0].push({ type: 'rows', jobs: [cliRow('late-job')] }); fake.streams[1].push(outputCli([{ text: 'LATE OLD OUTPUT' }], 80)); await settleCli();
  check('CLI 生命周期：旧流迟到回调不串新会话', states[0] === beforeLate && cliText(render('session-B')).includes('NEW OUTPUT') && !cliText(render('session-B')).includes('LATE OLD OUTPUT') && fake.calls.filter(call => call.request.jobId === 'late-job').length === 0);
  callbacks[0]({ sessionId: 'session-A', error: 'OLD ERROR', jobs: [cliRow('stale', 'session-A', { chunks: [{ text: 'STALE', channel: 'stdout' }] })] });
  check('CLI 生命周期：旧 notify 快照也被 sessionId mask', !cliText(render('session-B')).includes('STALE') && !cliText(render('session-B')).includes('OLD ERROR'));
  cleanup(); const afterUnmount = states[0];
  newList.push({ type: 'rows', jobs: [cliRow('after-unmount', 'session-B')] }); await settleCli();
  check('CLI 生命周期：卸载仅 dispose 流，无新回调且 kill/model/readAt=0', fake.streams.every(stream => stream.disposed === 1) && states[0] === afterUnmount && Object.values(fake.counters).every(value => value === 0));
}
// 静态断言仅补充观察路径的禁用 API，主要契约均在上面真实运行验证。
const cliObserverSource = CLIENT_SRC.slice(CLIENT_SRC.indexOf('    function makeCliStore('), CLIENT_SRC.indexOf('    return {\n      // **读**走'));
check('CLI 静态补充：观察路径没有 readAt / kill / model 调用', !/\.(?:readAt|kill|model|generate)\s*\(/.test(cliObserverSource));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
