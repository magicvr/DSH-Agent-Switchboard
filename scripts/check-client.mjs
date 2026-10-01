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

section('注册契约：必须调用 __ModuleLoader__.load 且 id 严格等于包名');
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  check('源码里出现 __ModuleLoader__.load', /__ModuleLoader__\.load\(/.test(CLIENT_SRC));
  const m = /id:\s*'([^']+)'/.exec(CLIENT_SRC);
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
    // 角色配置走**插件自己的 ctx** 上的 settings 远程命名空间（唯一可写通道）。
    remote: {
      settings: {
        describe: () => Promise.resolve([{ ns: 'agent-switchboard', value: { roles: [] }, revision: 1 }]),
        mutate: () => Promise.resolve({ ok: true }),
      },
    },
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
      check(
        'inject 不含 configForms（角色配置不走 configForms）',
        !plugin.inject.includes('configForms'),
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
        // 渲染一次：用桩 React 走完整个组件体，验证不抛错且能返回元素。
        try {
          const tree = component({ ctx: fakeCtx });
          check('组件在「空角色」输入下可渲染且不抛错', tree !== null && tree !== undefined);
          check(
            'inject 回调返回 ctx（组件的唯一依赖）',
            typeof options.inject === 'function' && options.inject().ctx === fakeCtx,
          );
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
  check(
    '内置后端缺 provider 被拒',
    /provider/.test(validateRoles([{ ...good, provider: '' }]) ?? ''),
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
  check(
    'CLI 缺提示词传递方式被拒',
    /提示词传递/.test(validateRoles([{ ...cli, cliPromptDelivery: '' }]) ?? ''),
  );
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
