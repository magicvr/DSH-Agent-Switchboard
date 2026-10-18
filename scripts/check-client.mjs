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
import { CLI_ROUTE_FACT_KEYS, parseCliRouteFacts, parseJsonArray, splitCliChannels, validateRoles } from '../src/client/logic.js';
import { parseRouteFacts, ROUTE_FACT_KEYS } from '../src/cli/output.js';

/**
 * 真机 codex 头部（codex v0.159.2，本机实测，形态见 `docs/cli-backends.md` §2.2）。
 *
 * 只保留**结构**：`workdir` 与会话 id 换成占位值，避免把本机绝对路径写进仓库（AGENTS.md 硬规则 5）。
 * 它比合成样本多两行（`reasoning summaries` / `session id`）与尾部 `--------`，
 * 因此能证明抽取器不会被「形如事实的额外行」带偏。
 */
const CODEX_ROUTE_HEADER = 'OpenAI Codex v0.159.2\n--------\nworkdir: <cwd>\nmodel: gpt-6.1-sol\n' +
  'provider: openai\napproval: never\nsandbox: read-only\nreasoning effort: low\n' +
  'reasoning summaries: none\nsession id: 00000000-0000-4000-8000-000000000000\n--------\n';
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
new Function('window', CLIENT_SRC.replace(/    return \{\s*\/\/ \*\*读\*\*走/, '    return { RoleCard, RoleRow, makeRoleStore, SwitchboardSettings, makeModelCatalog, // **读**走'))(clientWindow);
const clientData = new Function(`${CLIENT_SRC.slice(0, CLIENT_SRC.indexOf('\nwindow.__ModuleLoader__.load'))}\nreturn { CLI_DRIVER_OPTIONS, DEFAULT_CLI_DRIVER, cliFieldsFor, inferCliDriver };`)();
const rowReact = { createElement: (type, props, ...children) => ({ type, props, children }) };
const { RoleRow, makeRoleStore } = clientWindow.spec.factory(() => rowReact);
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
  // 0.2.1 的加载判据（`@deepseek-ai/dsh-client-modules/lib/index.js`）：
  //   - 声明了 `dsh.client` 却**没有** `exports["./client"]` → 组合期直接抛
  //     `declares dsh.client but exports no "./client" bundle`；
  //   - `dsh.client.platform !== "web"` → 该包被**静默跳过**（缓存 null，零诊断），
  //     现象是设置页整个消失，最难排查；
  //   - `dsh.client.inject` 必须是字符串数组（`optionalStringArray` 会抛错）。
  // 三条都只在真实启动时才暴露，因此必须在这里逐项锁死，而不是只判断「声明了」。
  const clientDeclaration = pkg.dsh?.client;
  check(
    'dsh.client 已声明为对象（否则产物不会被加载）',
    clientDeclaration !== null && typeof clientDeclaration === 'object' && !Array.isArray(clientDeclaration),
    `实际 ${JSON.stringify(clientDeclaration)}`,
  );
  const clientExport = typeof pkg.exports === 'object' && pkg.exports !== null
    ? pkg.exports['./client'] : undefined;
  // 与 DSH 的 `clientExportOf()` 同义：字符串，或带字符串 default 的对象。
  const clientExportTarget = typeof clientExport === 'string'
    ? clientExport
    : clientExport !== null && typeof clientExport === 'object' ? clientExport.default : undefined;
  check(
    'exports["./client"] 已声明且解析为字符串（声明 dsh.client 却缺失会抛错）',
    typeof clientExportTarget === 'string' && clientExportTarget.length > 0,
    `实际 ${JSON.stringify(clientExport)}`,
  );
  check(
    'dsh.client.platform 严格等于字符串 "web"（其它值是静默跳过，无诊断）',
    clientDeclaration?.platform === 'web',
    `实际 ${JSON.stringify(clientDeclaration?.platform)}`,
  );
  check(
    'dsh.client.inject 是字符串数组',
    Array.isArray(clientDeclaration?.inject) &&
      clientDeclaration.inject.every((item) => typeof item === 'string'),
    `实际 ${JSON.stringify(clientDeclaration?.inject)}`,
  );
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
              // 0.2.1 `SettingsController.namespaceView()` 的行形态是
              // `{ ns, autoGenerate, schema, value, applies, secrets, revision }`；
              // `writable` 只在 `describe()`/view 根上，**不在**每行上。
              { ns: 'agent-switchboard', value: { roles: [] }, revision: 1 },
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
      // ⚠️ 面板槽位（`conversation.composer`）已随 CLI 输出面板一起删除，因此现在只剩 1 个：
      //    设置页那一格。这条断言原先数的是 2。
      check('apply 注册了恰好 1 个 slot（只剩设置页）', registered.length === 1, `实际 ${registered.length}`);
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
  check('合法 backend 通过', validateRoles([{ ...good, backend: 'spawn' }]) === null);
  // `fork` 在 0.2.1-rc.1 被移除：它无法承载独立 Agent Preset，保留只会是静默失效的选项。
  check('已移除的 fork 后端被拒', /派发机制|backend/.test(validateRoles([{ ...good, backend: 'fork' }]) ?? ''));
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
  for (const name of ['parseJsonArray', 'validateRoles', 'parseCliRouteFacts', 'splitCliChannels']) {
    const a = extractFunction(logicSrc, name);
    const b = extractFunction(CLIENT_SRC, name);
    check(`${name} 在两处都存在`, a !== undefined && b !== undefined);
    check(`${name} 两处实现逐字相同`, a !== undefined && a === b, a === b ? '' : '存在漂移');
  }
}

section('CLI 路由事实与通道拆分：Client 镜像必须与 Host 一致');
{
  // Client 半边无法 import Host 的 `src/cli/output.js`，只能内联一份事实键表与抽取函数。
  // 漂移的后果很具体：界面会把「CLI 究竟接受了哪些参数」显示错、或干脆显示不出来，
  // 而这条证据正是本项目「配置真的生效」的验收依据。
  const codexHeader = `${CODEX_ROUTE_HEADER}\n正文第一行`;
  const noise = 'model: 只是正文里的一行\nnot a fact: 1\n\n';
  // 超出扫描窗口（25 行）的事实不能被采信 —— 窗口本身就是「别把正文误当事实」的防线。
  const beyond = `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}\nmodel: too-late\n`;
  check('路由事实键表与 Host 逐项一致',
    JSON.stringify(CLI_ROUTE_FACT_KEYS) === JSON.stringify(ROUTE_FACT_KEYS),
    `Client=${JSON.stringify(CLI_ROUTE_FACT_KEYS)} Host=${JSON.stringify(ROUTE_FACT_KEYS)}`);
  for (const [name, input] of Object.entries({ codexHeader, noise, beyond, empty: '' })) {
    const mine = JSON.stringify(parseCliRouteFacts(input)), host = JSON.stringify(parseRouteFacts(input));
    check(`抽取行为与 Host 一致（${name}）`, mine === host, `Client=${mine} Host=${host}`);
  }
  check('真机头部确实抽到关键事实', parseCliRouteFacts(codexHeader).model === 'gpt-6.1-sol'
    && parseCliRouteFacts(codexHeader).sandbox === 'read-only'
    && parseCliRouteFacts(codexHeader)['reasoning effort'] === 'low'
    && parseCliRouteFacts(beyond).model === undefined);
  check('真机头部：形如事实的额外行不被误采信',
    parseCliRouteFacts(CODEX_ROUTE_HEADER)['reasoning summaries'] === undefined
      && parseCliRouteFacts(CODEX_ROUTE_HEADER)['session id'] === undefined
      && Object.keys(parseCliRouteFacts(CODEX_ROUTE_HEADER)).join(',')
        === 'workdir,model,provider,approval,sandbox,reasoning effort');
  const channels = splitCliChannels([
    { channel: 'stderr', text: 'model: gpt-6-luna\n' },
    { channel: 'stdout', text: '最终回答' },
    { text: '缺通道按 stdout' },
    { channel: 'stderr', text: '' },
    { channel: 'stdout', text: '' },
  ]);
  check('通道拆分：stdout 只收正文，缺通道归 stdout', channels.stdout === '最终回答缺通道按 stdout', channels.stdout);
  check('通道拆分：stderr 独立保留且空片段不入账', channels.stderr === 'model: gpt-6-luna\n', channels.stderr);
  check('通道拆分：空输入安全', JSON.stringify(splitCliChannels(undefined)) === '{"stdout":"","stderr":""}');
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

section('预设反推：客户端镜像与 Host 必须对同一批配置给出同一结论');
{
  // ⚠️ 这条断言对应一次真机故障：codex 的 `cliPrefixArgs` 模板从旧 Windows 形态
  //    `{npmRoot}\@openai\codex\bin\codex.js` 改成 `/` 分隔时，**只有 Host 一侧**加了
  //    `canonical()` 归一化，客户端镜像仍是严格比较。后果是「Host 接受、界面判未知」：
  //    卡片显示「需重选预设」，而保存闸门检查的是整份角色列表，于是任何一次保存都被拦下
  //    （实测：三个 CLI 角色全部反推为 undefined，Host 对应全部 codex、零错误）。
  //
  //    这里不再逐条复刻规则，而是**同一批 fixture 喂两边**：任何一侧单方面变严/变松都会失败。
  const { cliFieldsFor, inferCliDriver: hostInfer, validateCliPreset } = await import('../src/cli/drivers.js');
  const base = { id: 'r', backend: 'cli', model: 'm', cliCwd: 'C:/w' };
  /** 同一批输入两边判定的对照。 */
  const parity = (label, role, expected) => {
    const host = hostInfer(role);
    const client = clientData.inferCliDriver(role);
    check(`${label}：两边一致且为 ${String(expected)}`,
      host === expected && client === expected, `Host=${String(host)} / 客户端=${String(client)}`);
  };
  for (const driver of ['codex', 'grok']) {
    for (const readOnly of [true, false]) {
      const fields = cliFieldsFor(driver, readOnly);
      parity(`${driver}/readOnly=${readOnly} 当前模板`, { ...base, ...fields, readOnly }, driver);
    }
  }
  // 旧 Windows 形态：分隔符是 `\`。fixture 必须**真的含反斜杠**，否则这条断言恒真。
  const legacyFields = cliFieldsFor('codex', true);
  const legacy = {
    ...base, ...legacyFields, readOnly: true,
    cliPrefixArgs: legacyFields.cliPrefixArgs.map((arg) => arg.replace(/\//g, '\\')),
  };
  check('旧 Windows 模板 fixture 确实含反斜杠（断言非恒真）',
    legacy.cliPrefixArgs.some((arg) => arg.includes('\\')));
  check('旧 Windows 模板：Host 仍然接受（兼容的前提）', validateCliPreset(legacy).errors.length === 0);
  parity('旧 Windows 模板（Host 接受，界面曾判未知）', legacy, 'codex');
  // 缺省 `cliPrefixArgs`：Host 的 `matchesList` 把 `null`/`undefined` 当作空数组，
  // 因此 grok（prefixArgs 为空）缺省是合法的；镜像曾用 JSON.stringify 比较而判未知。
  parity('grok 缺省 cliPrefixArgs（空数组语义）', { ...base, ...cliFieldsFor('grok', true), cliPrefixArgs: undefined }, 'grok');
  const writes = [];
  const legacyElements = rowElements(legacy, writes);
  check('旧 Windows 模板在卡片里不再显示「需重选预设」',
    legacyElements.some((n) => n.type === 'select' && n.props.value === 'codex') &&
    !legacyElements.some((n) => n.children.includes('需重选预设：当前配置无法识别为 codex / grok')));
  // 真正未知的形态仍然必须拒绝：不得为了兼容而猜测。
  parity('参数被改过', { ...base, ...legacyFields, readOnly: true, cliArgs: ['exec', '-'] }, undefined);
  parity('命令被改过', { ...base, ...legacyFields, readOnly: true, cliCommand: 'some-other-cli' }, undefined);
  parity('提示词传递方式被改过', { ...base, ...legacyFields, readOnly: true, cliPromptDelivery: 'argv' }, undefined);
}

section('面板字段：源码结构与桩化 RoleRow（不替代真机验收）');
{
  const rowSource = CLIENT_SRC.slice(CLIENT_SRC.indexOf('    function RoleRow('), CLIENT_SRC.indexOf('    /**\n     * 设置页主组件。'));
  const renderSource = rowSource.slice(rowSource.indexOf('      return h('));
  // 用条件分支锚点约束控件位置；再对 spawn / cli 的元素树验证显示条件。
  check('Provider 输入位于 builtin 条件分支',
    rowSource.includes("const isBuiltin = ['spawn'].includes(role.backend ?? 'spawn');") &&
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
  // ⚠️ 这里**曾经**同时断言「包裹模型」标签（`模型（非外部 CLI 模型）`）以区分两种模型。
  //    包裹路由已随中继子代理删除，只剩角色自己的模型标签。
  check('外部 CLI 模型标签明确区分', renderSource.includes("isCli ? '外部 CLI 模型' : '模型'"));
  for (const backend of ['spawn', 'cli']) {
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
  // ⚠️ 这里**曾经**逐控件断言 `WrapperSettings`（包裹子代理的 Provider / 模型 / 思考强度）：
  //    小节标题、两个文本框的已保存值/空白草稿、强度下拉含空项与全部 EFFORT_VALUES、帮助文案、
  //    清空强度不连带改其它字段。那三个字段是**中继子代理**的 LLM 路由，已随中继子代理退役 ——
  //    整节 UI 从面板删除，check-config-schema 里有「不再存在」的正向守卫。
  const wrapper = { wrapperProvider: '', wrapperModel: '', wrapperEffort: '' };
  const calls = [];
  const store = makeRoleStore({
    configForms: { describe: () => ({ ensure: async () => {}, getSnapshot: () => ({ view: { namespaces: [
      { ns: 'agent-switchboard', value: { roles: [], volatile: wrapper }, revision: 23 },
    ] } }) }) },
    remote: { settings: { mutate: async (...args) => { calls.push(args); return { ok: true }; } } },
  });
  const read = await store.read();
  // ⚠️ 这里**曾经**断言「镜像读取统一三字段（包裹路由）」并比对其值。包裹路由已删除，
  //    读取只剩 roles + revision。
  check('镜像读取保留同一 revision', read.ok === true && read.revision === 23
    && Array.isArray(read.roles), JSON.stringify(read));
  // ⚠️ split 模式：设置里只有旋钮层 `roleSettings`（角色定义住在 roles.json）。此时**不得**
  //    渲染可编辑的空角色列表 —— 那既让人以为角色丢了，一次保存又会写回 `roles: []`，
  //    把刚迁移好的设置退回「roles 与 roleSettings 并存」的回退陷阱。
  const splitCalls = [];
  const splitStore = makeRoleStore({
    configForms: { describe: () => ({ ensure: async () => {}, getSnapshot: () => ({ view: { namespaces: [
      { ns: 'agent-switchboard', value: { roleSettings: [{ id: 'scout', backend: 'spawn' }], volatile: wrapper }, revision: 24 },
    ] } }) }) },
    remote: { settings: { mutate: async (...args) => { splitCalls.push(args); return { ok: true }; } } },
  });
  const splitRead = await splitStore.read();
  check('split 模式：读回旋钮层与 revision（面板据此渲染旋钮表单，而不是空的角色列表）',
    splitRead.ok === true && splitRead.mode === 'split' && Array.isArray(splitRead.settings)
      && splitRead.settings.length === 1 && splitRead.settings[0]?.id === 'scout'
      && splitRead.revision === 24, JSON.stringify(splitRead));
  await splitStore.write([], splitRead.revision, {});
  check('split 模式下 write 不产生任何 roles 写入（store 自保，不依赖界面）',
    splitCalls.every(args => !JSON.stringify(args).includes('"roles"')), JSON.stringify(splitCalls));
  // 「用哪个外部 CLI」必须在旋钮表单里可选，且**只在 backend=cli 时出现**；值只写驱动 id ——
  // 命令与参数由 Host 按策展表派生，面板不提供 argv 编辑入口。
  {
    const splitForm = CLIENT_SRC.slice(CLIENT_SRC.indexOf("if (status === 'split')"),
      CLIENT_SRC.indexOf("if (status.startsWith('error:'))"));
    check('split 旋钮表单：外部 CLI 选择只在 backend=cli 时渲染',
      splitForm.includes("entry.backend === 'cli'") && splitForm.includes("'外部 CLI'"));
    check('split 旋钮表单：选择只写 cliDriver（不写 argv），并保留「沿用角色定义」项',
      splitForm.includes("patch(index, 'cliDriver'") && splitForm.includes("'（沿用角色定义）'")
        && !/patch\(index, 'cli(Command|Args|PrefixArgs|PromptDelivery)'/.test(splitForm));
    check('split 旋钮表单：驱动选项来自与 Host 对齐的策展表',
      splitForm.includes('CLI_DRIVER_OPTIONS.map') && !splitForm.includes('cliCommand'));
    // ⚠️ 「只读」与「允许嵌套派发」已**整体移出面板**（D34）：它们是组合期事实、属于角色的
    //    固有属性，住在 roles.json 的定义层。这里断言它们**不再**是旋钮（没有任何 patch 路径），
    //    但当前值仍如实**显示**出来（只读/可写、可继续派发/不再派发）。
    check('split 旋钮表单：只读与嵌套派发不再是旋钮（只在文案里如实显示当前值）',
      !splitForm.includes("patch(index, 'readOnly'")
        && !splitForm.includes("patch(index, 'allowNestedDispatch'")
        && splitForm.includes('属角色定义，改动请编辑 roles.json')
        && /只读角色|可写角色/.test(splitForm),
      '只读/嵌套仍在表单里，或当前值没有显示');
  }
  const splitSaved = await splitStore.writeSettings([{ id: 'scout', backend: 'cli' }], splitRead.revision);
  check('split 模式下 writeSettings 只写 roleSettings，绝不写 roles',
    splitSaved.ok && JSON.stringify(splitCalls.at(-1)) === JSON.stringify(['agent-switchboard',
      [{ op: 'set', path: ['roleSettings'], value: [{ id: 'scout', backend: 'cli' }] }], 24]),
    JSON.stringify(splitCalls.at(-1)));
  const saved = await store.write([], read.revision);
  check('角色写入只提交 roles 一条路径，并使用读取 revision', saved.ok && calls.length === 1 &&
    JSON.stringify(calls[0]) === JSON.stringify(['agent-switchboard', [
      { op: 'set', path: ['roles'], value: [] },
    ], 23]));
  // ⚠️ 这里**曾经**断言「小节位于角色列表之前」「保存按角色及各包裹字段 dirty 提交」。包裹路由
  //    （`wrapperProvider/Model/Effort`）已随中继子代理删除，dirty 判据只剩角色一项。
  check('保存按角色 dirty 提交，未改 roles 传 undefined',
    CLIENT_SRC.includes('JSON.stringify(roles) !== JSON.stringify(saved.roles)') &&
    CLIENT_SRC.includes('store.write(forceRoles || rolesDirty ? nextRoles : undefined, revision)'));
}

// ⚠️ 这里**曾经**有整节「统一包裹草稿：组件编辑、保存、清空与非法值的真实回调」——
//    覆盖包裹小节在真实组件里的编辑/保存/清空/非法值回调，以及「仅改包裹字段也能保存」。
//    包裹路由（中继子代理的 LLM 路由）已随中继一起删除，那节 UI 与判据都不复存在。
//    等价的「dirty → 只提交改动」覆盖仍在：见上面 store.write 的 roles 断言与角色卡片小节。

section('模型供应商目录：remote.llm 的信封、失败降级与同步读取');
{
  const { makeModelCatalog } = clientWindow.spec.factory(() => rowReact);
  const calls = [];
  const catalog = makeModelCatalog();
  await catalog.bind({
    // ⚠️ 用**真机形状**：`listProviders()` 返回信封，且条目里 id 叫 `provider`、`name` 是显示名。
    //    第一版按「裸数组 + id」写，真机目录永远是空的（面板一直退回文本框 ✗）。
    //    这条断言就是防复发：不拆信封 ⇒ providers 为空 ⇒ 下面第一条立刻红。
    listProviders: () => ({ ok: true, value: [
      { provider: 'deepseek-official', name: 'DeepSeek', settingsNs: 'llm-deepseek' },
    ] }),
    discoverModels: (ns, request) => {
      calls.push({ ns, request });
      return Promise.resolve({ ok: true, value: ['gpt-6.1-sol', { id: 'grok-4.7', label: 'Grok 4.7' }] });
    },
  });
  await new Promise(setImmediate);
  check('供应商目录：信封 ok=true 才取 value；条目 id 取 `provider`（不是显示名 name）',
    catalog.getProviders().length === 1 && catalog.getProviders()[0].id === 'deepseek-official'
      && catalog.getProviders()[0].settingsNs === 'llm-deepseek',
    JSON.stringify(catalog.getProviders()));
  check('模型目录：按该供应商自己的 settingsNs 发现，请求是 `{provider}`（与官方模型页一致）',
    calls.length === 1 && calls[0].ns === 'llm-deepseek' && calls[0].request.provider === 'deepseek-official',
    JSON.stringify(calls));
  check('模型目录：信封 ok=true 才取 value，字符串与对象两种形态都收',
    JSON.stringify(catalog.getModels('deepseek-official').map(model => model.id))
      === JSON.stringify(['gpt-6.1-sol', 'grok-4.7']));
  // 失败/缺失一律记空数组 —— 面板据此退回文本框，而不是抛错或往下拉框里塞空值。
  const failing = makeModelCatalog();
  await failing.bind({ listProviders: () => [{ id: 'p1', settingsNs: 'ns1' }, { id: 'p2' }],
    discoverModels: () => Promise.reject(new Error('boom')) });
  await new Promise(setImmediate);
  check('模型目录：发现失败记空数组、缺 settingsNs 不发请求',
    failing.getModels('p1').length === 0 && failing.getModels('p2').length === 0);
  const refused = makeModelCatalog();
  await refused.bind({ listProviders: () => ['p1'],
    discoverModels: () => Promise.resolve({ ok: false, error: { message: 'refused' } }) });
  await new Promise(setImmediate);
  check('模型目录：信封 ok=false 不取 value（拒绝时也退回文本框）', refused.getModels('p1').length === 0);
  // 拿不到 `remote.llm`、或 `listProviders` 直接抛错 ⇒ 空目录，绝不把设置页拖垮。
  const none = makeModelCatalog();
  await none.bind(null);
  await none.bind({ listProviders: () => { throw new Error('unavailable'); } });
  check('供应商目录：没有 remote.llm / 调用抛错时为空且不抛错', none.getProviders().length === 0);
  const strings = makeModelCatalog();
  await strings.bind({ listProviders: () => ['self', 'llm-pi-ai'] });
  check('供应商目录：字符串数组形态也收', JSON.stringify(strings.getProviders().map(item => item.id))
    === JSON.stringify(['self', 'llm-pi-ai']));
}

section('split 旋钮表单：操作区的启用/取消是真实行为');{
  // ⚠️ 这一节的存在本身就是教训：split 分支原先**没有自己的 dirty 判据**，我给它接上了
  //    roles 列表的 `dirty`（split 下恒为 false），于是「取消 / 保存」**永久禁用** ——
  //    真机上表现为「点取消毫无反应」。只断言源码形状挡不住这类 bug，所以这里**渲染真组件**：
  //    改一个旋钮 → 两个按钮必须变可用 → 点取消 → 值回到快照且**没有**写盘。
  const contexts = new Map(); let active, used;
  const react = { ...rowReact,
    useState(initial) { const at = active.index++; if (!(at in active.states)) active.states[at] = typeof initial === 'function' ? initial() : initial;
      const current = active; return [current.states[at], value => { current.states[at] = typeof value === 'function' ? value(current.states[at]) : value; }]; },
    useRef(initial) { const at = active.refIndex++; return active.refs[at] ?? (active.refs[at] = { current: initial }); },
    useCallback: fn => fn, useEffect: effect => { active.effects.push(effect); },
  };
  const api = clientWindow.spec.factory(() => react);
  const settings = [{ id: 'worker', backend: 'cli', cliDriver: 'codex', model: 'gpt-6-luna', effort: 'high' }];
  const writes = [];
  const store = makeRoleStore({ configForms: { describe: () => ({ ensure: async () => {}, getSnapshot: () => ({ view: { namespaces: [
    { ns: 'agent-switchboard', value: { roleSettings: structuredClone(settings) }, revision: 91 },
  ] } }) }) }, remote: { settings: { mutate: async (ns, ops, rev) => { writes.push({ ns, ops: structuredClone(ops), rev }); return { ok: true }; } } } });
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
  const pageButton = (nodes, which) => nodes.find(n => n.type === 'button'
    && n.props?.className === ['pageAction', which].join(''));
  const settle = () => new Promise(setImmediate);
  render();
  // 组件用 useEffect 触发首次读取；桩不会自动跑，必须显式执行一次（与角色卡片那节同法）。
  contexts.get('root').effects[0]();
  await settle();
  let nodes = render();
  check('split：未改动时操作区两个按钮都禁用（没有可保存/可取消的东西）',
    pageButton(nodes, 'Save')?.props.disabled === true && pageButton(nodes, 'Cancel')?.props.disabled === true,
    JSON.stringify({ save: pageButton(nodes, 'Save')?.props.disabled, cancel: pageButton(nodes, 'Cancel')?.props.disabled }));
  // 改一个旋钮：模型输入框
  const model = nodes.find(n => n.type === 'input' && n.props.value === 'gpt-6-luna');
  check('split：旋钮表单渲染出模型输入框（用来改一个值）', model !== undefined);
  model?.props.onChange({ target: { value: 'changed-model' } });
  nodes = render();
  check('split：改动后两个按钮都可用，且保存键显示星号',
    pageButton(nodes, 'Save')?.props.disabled === false && pageButton(nodes, 'Cancel')?.props.disabled === false
      && pageButton(nodes, 'Save')?.children.includes('保存 *'),
    JSON.stringify({ save: pageButton(nodes, 'Save')?.children, cancelDisabled: pageButton(nodes, 'Cancel')?.props.disabled }));
  pageButton(nodes, 'Cancel')?.props.onClick();
  nodes = render();
  check('split：取消把值还原到读取时的快照，且**没有**写盘',
    nodes.some(n => n.type === 'input' && n.props.value === 'gpt-6-luna')
      && !nodes.some(n => n.type === 'input' && n.props.value === 'changed-model')
      && writes.length === 0,
    JSON.stringify({ writes: writes.length }));
  // 夹具里那条是 **cli** 角色：按用户明确要求，外部 CLI **不指定供应商** ——
  // 既没有「供应商」这一行，模型也保持自由文本（CLI 的模型 id 不在 DSH 目录里）。
  const cliEntrySpans = nodes.filter(n => n.type === 'span'
    && n.children.some(t => typeof t === 'string' && (t === '供应商' || t === '外部 CLI')));
  check('split：cli 角色不显示「供应商」（只显示「外部 CLI」）',
    !cliEntrySpans.some(span => span.children.includes('供应商'))
      && cliEntrySpans.some(span => span.children.includes('外部 CLI')),
    JSON.stringify(cliEntrySpans.map(span => span.children)));
  check('split：cli 角色的模型仍是自由文本（不是下拉）',
    nodes.some(n => n.type === 'input' && n.props.value === 'gpt-6-luna')
      && !nodes.some(n => n.type === 'select' && n.props.value === 'gpt-6-luna'));
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
    // 行形态与 Host 的 `namespaceView()` 一致：无 per-namespace `writable`。
    { ns: 'agent-switchboard', value: mirror, revision },
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
  // ⚠️ 页面级操作区的按钮按 className 定位（D34 起操作区统一移到底部，且标签与卡片内的「保存/取消」重名）。
  const pageButton = (nodes, which) => nodes.find(n => n.type === 'button'
    && n.props?.className === ['pageAction', which].join(''));
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
  check('卡片聚焦：切换第二卡只展开一张，CLI 隐藏 Provider', nodes.filter(n => n.props?.className === 'rowEditor').length === 1
    && Boolean(fieldOf(nodes, '角色标题')) && !fieldOf(nodes, 'Provider'));
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
  pageButton(nodes, 'Cancel').props.onClick(); await settle(); nodes = render();
  check('卡片状态：缺必填与未知 CLI 预设均为错误态及可读原因', nodes.filter(n => n.props?.['data-state']).every(n => n.props['data-state'] === 'error' && n.props['aria-label'].startsWith('配置错误：') && n.props.style.background === 'var(--dsw-alias-state-error-primary)') && nodes.some(n => n.props?.['aria-label']?.includes('需重选预设')));
  mirror.roles[0] = good;
  pageButton(nodes, 'Cancel').props.onClick(); await settle(); nodes = render();
  buttonOf(inCard(nodes, 'worker'), '编辑').props.onClick(); nodes = render();
  await buttonOf(inCard(nodes, 'worker'), '保存').props.onClick(); nodes = render();
  check('卡片校验：未识别预设独立阻止提交并显示需重选预设', calls.length === 4 && inCard(nodes, 'worker').some(n => n.props?.role === 'alert' && n.children.some(t => typeof t === 'string' && t.includes('需重选预设'))));
  check('卡片无障碍：所有按钮 type=button', nodes.filter(n => n.type === 'button').every(n => n.props.type === 'button'));

  // 批次 2：使用同一组件实例与按 key 复用的卡片，覆盖实际用户回调。
  mirror.roles = [{ ...good, title: '' }, cli, { ...good, id: 'last', title: '末行' }];
  pageButton(nodes, 'Cancel').props.onClick(); await settle(); nodes = render();
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
  pageButton(nodes, 'Cancel').props.onClick(); await settle(); nodes = render();
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
  pageButton(nodes, 'Cancel').props.onClick(); nodes = render();
  check('F1：重读进行中禁止保存', pageButton(nodes, 'Save')?.props.disabled === true);
  await settle(); nodes = render();
  check('F1：读取失败保存按钮 disabled，dirty 为 false（无保存 *）',
    pageButton(nodes, 'Save')?.props.disabled === true
      && !pageButton(nodes, 'Save')?.children.includes('保存 *'));
  check('F4：refresh 清除删除确认', !buttonOf(nodes, '确认删除'));
  check('F1：读取失败放弃改动可用以重试', pageButton(nodes, 'Cancel')?.props.disabled === false);
  const beforeFailedRead = calls.length;
  await pageButton(nodes, 'Save').props.onClick(); nodes = render();
  check('F1：绕过 disabled 直接保存也不调用 store.write，提示不能写入',
    calls.length === beforeFailedRead && nodes.some(n => n.children.includes('读取失败，不能写入。点「取消」可重试。')));
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
    pageButton(nodes, 'Cancel').props.onClick(); nodes = render();
    pageButton(nodes, 'Cancel').props.onClick(); nodes = render();
    const [resolveOld, resolveLatest] = pendingReads.splice(0);
    resolveLatest(latest); await settle(); nodes = render();
    const latestSnapshot = rootSnapshot();
    resolveOld(stale); await settle(); nodes = render();
    const errorVisible = nodes.some(n => n.children.some(t => typeof t === 'string' && t.startsWith('读取角色配置失败：')));
    // useState 顺序中的第 4 项是 readSucceeded；同时验证用户可见闸门。
    const readSucceeded = contexts.get('root').states[3];
    check(`F1-并发：${label}，旧响应不覆盖最新状态且读取闸门自洽`,
      rootSnapshot() === latestSnapshot && readSucceeded === latest.ok && errorVisible === !latest.ok &&
      pageButton(nodes, 'Save')?.props.disabled === true &&
      pageButton(nodes, 'Cancel')?.props.disabled === latest.ok &&
      (latest.ok ? cards(nodes).length === 1 && cards(nodes)[0].props['data-role-id'] === 'latest' : cards(nodes).length === 0));
  }
  const beforeConcurrentFailureSave = calls.length;
  await pageButton(nodes, 'Save').props.onClick(); nodes = render();
  check('F1-并发：最新读取失败后直接保存仍不写入，放弃改动可重试',
    calls.length === beforeConcurrentFailureSave && pageButton(nodes, 'Cancel')?.props.disabled === false);
  store.read = originalRead;
  // 验证失败后的成功读取空数组仍允许新增，且新角色默认 medium 不变。
  readFails = false;
  for (const missing of [false, true]) {
    if (missing) delete mirror.roles; else mirror.roles = [];
    pageButton(nodes, 'Cancel').props.onClick(); await settle(); nodes = render();
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
