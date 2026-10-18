/**
 * Agent Switchboard 的 Client 半边。
 *
 * 提供 `settings.section` 角色与派发编辑器（D13），以及一次性子会话的只读 CLI 观察席位（D23）。
 *
 * 用户诉求是「让用户配置**角色**使用内置代理还是外部 CLI」，即机制是角色的一个可切换
 * 属性，而不是「内置角色」与「CLI 角色」两套并列的东西。Host 半边本来就支持
 * `roles[].backend`，缺的只是编辑入口 —— 这个页面就是那个入口。
 *
 * ## 硬性约束（已核实，见 `docs/architecture.md` 第 3 节与 3.1e）
 *
 * 1. 必须调用 `window.__ModuleLoader__.load(...)`，且 `id` **严格等于包名**，
 *    否则报 `loaded without registering "<id>"`。
 * 2. **禁止 import 任何 Harness Client 包**（它们随时会变，且 Client 半边崩溃会让
 *    整个 slot 空掉：`slot entry crashed in '<slot>'`）。因此表单**自绘**，只用
 *    原生 `React.createElement`（由 `require('react')` 取得）。
 * 3. 只使用 `--dsw-alias-*` 主题 token，不碰 app root / document.body / 别人的 DOM。
 * 4. **读**走 `configForms` 镜像，**写**走 `remote.settings.mutate`；在插件上下文绑定
 *    操作后传给组件。只注入内核提供的 `slots` / `configForms` / `remote.settings`。
 *
 * ## 配置桥接与作用域隔离（见 decisions.md D13 / D14）
 *
 * 角色列表一度放在 profile patch 的 `config.roles` 里。实测发现两条互相冲突的约束：
 *   1. `settings.describe()` 按 `ns` 去重、**只报告根条目**的配置。preset 里的那份插件
 *      声明由 agent-presets 在运行时挂载，不在 `configEditor.entries()` 里，因此设置页
 *      读到的永远是根条目那份**空的** config —— UI 无法配置实际生效的角色。
 *   2. 把 roles 移到根条目就会**污染**：根作用域注册的工具对其他 preset 的会话可见
 *      （实测：一个 `standard` 会话的子代理能看到根注册的 `switchboard_selftest`），
 *      于是所有会话都会冒出一批 `delegate_to_*`。
 *
 * 当前设置页经内核 settings 通道读写根条目的 volatile `roles`（命名空间不带 `include:`），
 * Host 根实例将它同步到 `$DSH_HOME/agent-switchboard/roles.json`，preset 实例读取文件。
 * 根条目保持启用，让设置页始终可见；角色工具只在 `mount: true` 的作用域挂载。
 * 旧方案的自建 `remote.roleConfig` 服务已移除：外部插件无法新增客户端远程命名空间，
 * 把该延迟服务列为必需依赖曾导致页面永远 pending、无法启动（见本文件末尾 inject 注释）。
 *
 * ## 本文件刻意保持「不信任输入」的姿态
 *
 * 任何读取失败都降级为可读提示，而不是抛错；渲染路径里不抛异常。
 * 一个显示不出内容的设置页是可接受的，一个让 slot 崩掉的设置页不是。
 */

/**
 * 本插件的 settings 命名空间，即根条目的 `entry.options.id`。
 *
 * ⚠️ **不带 `include:` 前缀**。`plugin_manager` 显示的 `include:agent-switchboard` 是
 * 展示层的组合形式；`settings.describe()` 行的 `ns` 取的是 `entry.options.id`
 * （官方源码 `ns: entry.options.id`）。实测证据：本机 20 个 settings 命名空间全部
 * 不带前缀（`agent-switchboard`、`agent-preset-registry`、`ui-settings` …），
 * 其中 `agent-switchboard` 正是我们这一行。
 */
const CONFIG_NS = 'agent-switchboard';

/** 已知的后端取值（必须与 Host 的 `z.union(['spawn','cli'])` 一致）。 */
const BACKENDS = ['spawn', 'cli'];

/** 已知的思考强度取值（必须与 Host 的 `EFFORT_VALUES` 一致）。 */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 切换 `backend` 到 `cli` 时默认选的驱动。
 *
 * 必须是表里真实存在的驱动（`custom` 不行：它不带参数模板，会让新角色带着空命令
 * 进入 CLI 分支，界面反推不出驱动、Host 侧也会判配置错误）。
 */
const DEFAULT_CLI_DRIVER = 'codex';

/** 后端的中文说明（仅用于展示）。 */
const BACKEND_LABEL = {
  spawn: '内置 · spawn（独立上下文）',
  cli: '外部 CLI（本机命令）',
};

/**
 * 已知 CLI 驱动的**界面镜像**。
 *
 * ⚠️ 本表与 `src/cli/drivers.js` 的 `CLI_DRIVERS` **必须一致**（id / label / command /
 * prefixArgs / args / promptDelivery）。Client 半边是自包含单文件（`factory` 里不能
 * import），因此无法复用 Host 的模块，只能内联。`scripts/check-client.mjs` 会断言两处
 * 一字不差，防止漂移 —— 与 `parseJsonArray` / `validateRoles` 用的是同一套做法。
 *
 * 为什么 UI 需要**参数模板**而不只是名字：选中驱动要「一键填好」那四个字段。
 * 若只给名字、不给模板，界面就无法填入正确参数，等于没做。
 */
const CLI_DRIVER_OPTIONS = [
  {
    id: 'codex',
    label: 'Codex CLI',
    description: 'OpenAI Codex。非交互走 `codex exec`，提示词走 stdin。只读由 `-s read-only` 实现。',
    command: '{node}',
    prefixArgs: ['{npmRoot}/@openai/codex/bin/codex.js'],
    promptDelivery: 'stdin',
    modelPlaceholder: 'gpt-6-luna',
    args: (readOnly) => [
      'exec',
      '-s',
      readOnly ? 'read-only' : 'workspace-write',
      '--skip-git-repo-check',
      '-m',
      '{model}',
      '-c',
      'model_reasoning_effort={effort}',
      '-',
    ],
  },
  // 说明：**不再提供 Claude Code 预设**（用户已长期不用，明确要求排除）。
  // 取证记录保留在 `docs/cli-backends.md` §3.0。
  {
    id: 'grok',
    label: 'Grok CLI',
    description:
      'xAI Grok。非交互走 `-p/--single`；提示词写临时文件后用 `--prompt-file` 传入（`argv` 直接传多行提示词会被拒）。只读用 `--permission-mode plan`。',
    command: 'grok',
    prefixArgs: [],
    promptDelivery: 'promptFile',
    modelPlaceholder: 'grok-4.7',
    args: (readOnly) => [
      '--prompt-file',
      '{prompt}',
      '-m',
      '{model}',
      '--reasoning-effort',
      '{effort}',
      '--permission-mode',
      readOnly ? 'plan' : 'acceptEdits',
    ],
  },
];

/**
 * 产出一个驱动对应的 `cli*` 字段（与 Host 的 `cliFieldsFor` 行为一致）。
 *
 * @param {string} id - 驱动 id。
 * @param {boolean} readOnly - 角色是否只读。
 * @returns {{cliCommand: string, cliPrefixArgs: string[], cliArgs: string[], cliPromptDelivery: string}|undefined} 字段值。
 */
function cliFieldsFor(id, readOnly) {
  const d = CLI_DRIVER_OPTIONS.find((x) => x.id === id);
  if (d === undefined) return undefined;
  return {
    cliCommand: d.command,
    cliPrefixArgs: [...d.prefixArgs],
    cliArgs: d.args(readOnly),
    cliPromptDelivery: d.promptDelivery,
  };
}

/**
 * 反推角色当前属于哪个驱动（与 Host 的 `inferCliDriver` 行为一致）。
 *
 * 若用户手工改过 `cli*` 字段导致与任何驱动都不一致，返回 undefined ——
 * 避免界面把用户的自定义配置**显示**成某个预设（那会误导）。
 *
 * ⚠️ **判据必须与 Host 逐条对齐**（`src/cli/drivers.js` 的 `matchesCommandText` /
 * `matchesList`），否则会出现「Host 接受、界面判未知」这类最困惑的失败：
 *
 *   - Host 把 `{npmRoot}` 前缀模板的两种分隔符归一后比对，因此旧 Windows 形态
 *     `{npmRoot}\@openai\codex\bin\codex.js` 仍然匹配。镜像一度只做严格比较，
 *     结果**旧配置在界面里反推不出驱动**：卡片显示「需重选预设」，而保存闸门检查
 *     的是整份角色列表，于是任何一次保存都被拦下（实测：三个 CLI 角色全部
 *     undefined，Host 对应全部 codex、零错误）。
 *   - Host 的 `matchesList` 把 `null` / `undefined` 当成空数组，因此 prefixArgs 为空的
 *     grok 允许缺省该字段。
 *
 * 浏览器没有本机路径解析器，因此只做**分隔符归一**与空数组等价，不解析
 * `{node}` / `{npmRoot}`，也不按文件名猜测（见 `RoleRow` 里 `currentDriver` 的说明）。
 * 已知残余差异：Host 还额外接受**已解析的绝对路径**（它在本机跑得动解析器），
 * 浏览器无从构造那个值，因此不猜测 —— 设置镜像里存的是模板，不是解析值。
 *
 * @param {object} role - 角色。
 * @returns {string|undefined} 驱动 id。
 */
function inferCliDriver(role) {
  for (const d of CLI_DRIVER_OPTIONS) {
    if (!matchesDriverText(role?.cliCommand, d.command)) continue;
    if (!matchesDriverList(role?.cliPrefixArgs, d.prefixArgs)) continue;
    if (role?.cliPromptDelivery !== d.promptDelivery) continue;
    const args = role?.cliArgs ?? [];
    for (const readOnly of [true, false]) {
      if (JSON.stringify(args) === JSON.stringify(d.args(readOnly))) return d.id;
    }
  }
  return undefined;
}

/**
 * 单条命令文本是否匹配（模板形态，分隔符归一后比对）。
 *
 * @param {unknown} actual - 角色里的值。
 * @param {string} expected - 驱动定义里的模板。
 * @returns {boolean} 是否匹配。
 */
function matchesDriverText(actual, expected) {
  if (typeof actual !== 'string') return false;
  // 与 Host 的 `canonical()` 相同：只对 `{npmRoot}` 前缀的值归一分隔符。
  const canonical = (value) => (value.startsWith('{npmRoot}') ? value.replace(/\\/g, '/') : value);
  return canonical(actual) === canonical(expected);
}

/**
 * 字符串数组是否匹配（逐项比对；`null` / `undefined` 等价于空数组，同 Host）。
 *
 * @param {unknown} actual - 角色里的数组。
 * @param {string[]} expected - 驱动定义里的模板数组。
 * @returns {boolean} 是否匹配。
 */
function matchesDriverList(actual, expected) {
  if (actual == null) return expected.length === 0;
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((value, index) => matchesDriverText(value, expected[index]));
}

/**
 * 解析一个 JSON 字符串数组。
 *
 * ⚠️ 本函数与 `src/client/logic.js` 里的 `parseJsonArray` **必须逐字相同**：
 * Client 半边是自包含单文件（`factory` 里不能 import），因此无法复用那个模块，
 * 只能内联。`scripts/check-client.mjs` 会断言两处实现一字不差，防止漂移。
 *
 * @param {string} raw - 用户输入。
 * @returns {string[]|undefined} 解析结果，或 undefined 表示输入尚不合法。
 */
function parseJsonArray(raw) {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return undefined;
    if (!value.every((x) => typeof x === 'string')) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/**
 * 校验角色草稿。
 *
 * ⚠️ 同样与 `src/client/logic.js` 的 `validateRoles` **必须逐字相同**（见上）。
 * 规则不一致会让用户遇到「界面说没问题、保存后被 Host 拒掉」这类最困惑的失败。
 *
 * @param {object[]} roles - 角色草稿。
 * @returns {string|null} 可读的错误信息，或 null 表示通过。
 */
function validateRoles(roles) {
  const seen = new Set();
  for (const [i, r] of roles.entries()) {
    const at = `第 ${i + 1} 行`;
    if (!r.id || !/^[a-z][a-z0-9-]*$/.test(r.id)) {
      return `${at}：角色 id 必须小写字母开头，仅含小写字母/数字/连字符`;
    }
    if (seen.has(r.id)) return `${at}：角色 id "${r.id}" 重复`;
    seen.add(r.id);
    if (!r.description) return `${at}：描述不能为空（主代理据此判断何时派给它）`;
    if (!r.instructions) return `${at}：角色指令不能为空`;
    if (!r.model) return `${at}：模型不能为空`;
    // ⚠️ **backend 取值必须校验**。客户端一度完全跳过这一项，于是「backend 写成别的字符串」
    //    会被 UI 放行、到 Host 才报错，而 Host 的报错出现在装载期 —— 用户看不到它与自己
    //    操作的关联。取值与 Host 的 `[...BUILTIN_PROVIDERS, CLI_BACKEND]` 一致
    //    （`check-client.mjs` 有漂移断言锁定）。
    if (!BACKENDS.includes(r.backend ?? 'spawn')) {
      return `${at}：派发机制 "${r.backend}" 非法，只能是 ${BACKENDS.join(' / ')}`;
    }
    if (r.backend === 'cli') {
      if (!r.cliCommand) return `${at}：CLI 后端需要「命令」`;
      if (!Array.isArray(r.cliArgs) || r.cliArgs.length === 0) return `${at}：CLI 后端需要参数模板`;
      if (r.cliArgs.some(arg => typeof arg === 'string' && arg.includes('{effort}')) &&
        !EFFORTS.includes(typeof r.effort === 'string' ? r.effort.trim() : undefined)) {
        return `${at}：模板使用了 {effort}，必须显式选择思考强度`;
      }
      // 客户端无法知道插件级 cwd 默认值，有意不校验 {cwd} 的可得性。
      // ⚠️ **不校验 `cliPromptDelivery`**：Host 侧是 `read('cliPromptDelivery') ?? 'stdin'`，
      //    留空即取默认值 `stdin`。客户端若要求必填，就是把 Host 接受的配置拒掉。
    }
    // ⚠️ **不校验内置后端的 `provider`**：Host 用 `read('provider') || defaultProvider`
    //    回落插件级默认值（插件级默认 `self`），因此留空是合法的。
    //    客户端一度要求必填，导致「角色从 CLI 切回内置后保存被拦下」，还配了一句自相矛盾的
    //    提示（「可留空以使用顶层默认值」却因为留空而报错）。**实测踩到。**
    //
    // 上面几条的共性：**客户端校验不得与 Host 不一致**。逐条复刻规则很容易各自演化，
    // 因此另有 `scripts/check-validation-parity.mjs` 用同一批输入断言两边判定一致。
  }
  return null;
}

/**
 * 外部 CLI 自报路由事实的键；与 `src/client/logic.js` 的同名常量**逐项相同**。
 *
 * ⚠️ 值也必须与 Host 的 `src/cli/output.js` 的 `ROUTE_FACT_KEYS` 一致：
 * Host 用同一张表从 stderr 抽取「配置真的被 CLI 接受」的证据，Client 用它把证据
 * 显示在折叠区之外。`scripts/check-client.mjs` 对键表与抽取行为都有漂移断言。
 */
const CLI_ROUTE_FACT_KEYS = [
  'workdir',
  'model',
  'provider',
  'approval',
  'sandbox',
  'reasoning effort',
  'reasoning summary',
];

/**
 * 从 CLI 的 stderr 里抽取路由事实行；与 `src/client/logic.js` 的
 * `parseCliRouteFacts` **必须逐字相同**（见上）。
 *
 * @param {string} stderr - 完整 stderr。
 * @param {number} [scanLines] - 扫描的行数上限。
 * @returns {Record<string, string>} 抽到的事实键值；无则空对象。
 */
function parseCliRouteFacts(stderr, scanLines = 25) {
  const facts = {};
  if (typeof stderr !== 'string' || stderr.length === 0) return facts;
  const keys = CLI_ROUTE_FACT_KEYS.join('|');
  const pattern = new RegExp(`^(${keys})\\s*:\\s*(.+)$`);
  for (const line of stderr.split('\n').slice(0, scanLines)) {
    const match = pattern.exec(line.trim());
    if (match) facts[match[1]] = match[2].trim();
  }
  return facts;
}

/**
 * 按通道把 CLI 任务的输出片段拆成「正文」与「过程/诊断」；与 `src/client/logic.js`
 * 的 `splitCliChannels` **必须逐字相同**（见上）。
 *
 * @param {object[]} chunks - 任务输出片段（`{ text, channel }`）。
 * @returns {{stdout: string, stderr: string}} 两个通道各自的正文。
 */
function splitCliChannels(chunks) {
  const out = { stdout: '', stderr: '' };
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const text = typeof chunk?.text === 'string' ? chunk.text : '';
    if (text.length === 0) continue;
    if (chunk.channel === 'stderr') out.stderr += text;
    else out.stdout += text;
  }
  return out;
}

/** 滚动位置在底部容差内时视为粘底。 */
function isAtScrollBottom(scrollTop, scrollHeight, clientHeight, tolerance = 8) {
  return scrollHeight - clientHeight - scrollTop <= tolerance;
}

window.__ModuleLoader__.load({
  id: '@magicvr/dsh-agent-switchboard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    /**
     * 取「配置镜像」——**读**角色配置的正规入口。
     *
     * ⚠️ 这里曾经走 `ctx.remote.settings.describe()`，那是**错的路子**，实测现象是界面
     * 报「取不到 remote.settings 通道」。官方「模型」设置页
     * （`dsh-client-ui-settings-models`）给出的正确形态是：
     *
     *     await this.describeFace.ensure();                 // 异步补全镜像
     *     const mirrored = this.describeFace.getSnapshot();
     *     if (mirrored.view === void 0) … "settings are unavailable in this browser"
     *     const views = mirrored.view.namespaces;           // ns → view
     *     const writable = mirrored.view.writable;
     *
     * 即：**读走 `configForms` 镜像（`describe()` 返回的那个面），写才走
     * `remote.settings.mutate`**。两者都要写进 `inject`（官方 models 页的 inject 里
     * `configForms` 与 `remote.settings` 都在）。
     *
     * `ensure()` 是异步的，因此**首帧通常读不到值**，必须先 await 再取 snapshot ——
     * 这正是此前反复「读不到」的原因之一。
     *
     * @param {object} ctx - Client 插件上下文。
     * @returns {object|undefined} 镜像面，未就绪时返回 undefined。
     */
    function describeFace(ctx) {
      try {
        return ctx?.configForms?.describe?.();
      } catch {
        return undefined;
      }
    }

    /**
     * 读出本插件的配置（含 roles）。
     *
     * @param {object} ctx - Client 插件上下文。
     * @returns {Promise<{ok: boolean, roles: object[], revision?: number, missing?: boolean, writable?: boolean, error?: string}>} 读取结果。
     */
    // ⚠️ 以下两个函数**不再由组件直接调用**：它们只在插件 `apply` 里被绑定成
    //    「操作回调」，再作为 props 传给组件。理由见 `makeRoleStore` 的说明。
    async function fetchRoles(ctx) {
      const face = describeFace(ctx);
      if (face === undefined || typeof face.getSnapshot !== 'function') {
        return {
          ok: false,
          roles: [],
          error:
            '取不到 configForms 镜像（这不是配置文件的问题）。' +
            '请确认 @deepseek-ai/dsh-api-settings-controller 与界面外壳均已启用，然后重启应用。',
        };
      }
      try {
        // `ensure()` 异步补全镜像；首帧往往还没有我们的行，必须先等它。
        if (typeof face.ensure === 'function') await face.ensure();
        const snapshot = face.getSnapshot();
        const view = snapshot?.view;
        if (view === undefined) {
          return {
            ok: false,
            roles: [],
            error: snapshot?.error ?? '设置镜像不可用（settings are unavailable in this browser）。',
          };
        }
        const row = (view.namespaces ?? []).find((v) => v?.ns === CONFIG_NS);
        if (row === undefined) {
          return {
            ok: false,
            roles: [],
            error: `找不到本插件的配置行（ns=${CONFIG_NS}）。若插件条目被禁用，请先启用。`,
          };
        }
        const roles = Array.isArray(row.value?.roles) ? row.value.roles : [];
        // ⚠️ split 模式（设置里只有旋钮层 `roleSettings`，角色**定义**住在 roles.json）：
        //    本页面仍是完整角色编辑器，读不到定义只会渲染成**空列表**，而一次保存就会
        //    写回 `roles: []` —— 既误导用户，又把刚迁移好的设置退回半迁移状态（重新引入
        //    回退陷阱：`roles` 与 `roleSettings` 并存）。
        //    旋钮编辑器尚未实现，所以这里**如实拒绝**渲染可编辑列表，而不是静默显示零角色。
        if (Array.isArray(row.value?.roleSettings)) {
          return {
            ok: true,
            mode: 'split',
            roles: [],
            settings: row.value.roleSettings,
            revision: row.revision,
            writable: view.writable ?? row.writable,
            missing: false,
          };
        }
        return {
          ok: true,
          roles,
          revision: row.revision,
          // ⚠️ `writable` 在 0.2.1-rc.1 里属于**视图根**而不是每个 namespace 行：
          // `describe()` 返回 `{writable, hasDocument, namespaces:[...]}`，而
          // `namespaceView()` 的行里没有这个字段（实测）。读行的结果是恒 undefined。
          writable: view.writable ?? row.writable,
          missing: roles.length === 0,
        };
      } catch (error) {
        return { ok: false, roles: [], error: error instanceof Error ? error.message : String(error) };
      }
    }


    /**
     * 写入角色到本插件配置。
     *
     * **写**走 `remote.settings.mutate`（读走 `configForms` 镜像）—— 这是官方「模型」页的
     * 分工：`ctx.remote.settings.mutate(ns, ops, expectedRevision)`。
     *
     * `response.ok === false` 时 `response.error` 是**结构化**的（官方代码取
     * `.error.message`），因此这里先取 `.message` 再退回整体，避免界面显示 `[object Object]`。
     *
     * 整块 `set(['roles'], value)`：角色是变长数组，整体提交语义明确，不必算易错的
     * 逐字段 diff。`roles` 在 Host schema 上标了 `.volatile()`，因此这条路径操作可写
     * （`SettingsForms.write` 的 `isVolatilePath` 校验，已有回归测试锁定）。
     *
     * @param {object} ctx - Client 插件上下文。
     * @param {object[]|undefined} roles - 已改角色数组（含删空的 []），未改传 undefined。
     * @param {number|undefined} revision - 读取时拿到的 revision，用于并发保护。
     * @returns {Promise<{ok: boolean, message: string}>} 结果。
     */
    /**
     * 找出可写的 settings 通道。
     *
     * **为什么要有多个候选**：读路径走 `ctx.configForms` 成功、而写路径取
     * `ctx.remote.settings` 失败（实测现象），说明两条路并非总是同时可用。
     * 与其赌「它一定在 `ctx.remote.settings`」，不如按可能性依次尝试，并把
     * 「哪些路走通了」记下来 —— 这样失败时能给出可行动的信息，而不是一句「取不到」。
     *
     * 候选顺序与理由：
     *   1. `ctx.remote.settings` —— 官方「模型」页的写法
     *      （`dsh-client-ui-settings-models`：`ctx.remote.settings.mutate(ns, ops, rev)`）；
     *   2. `ctx.get('remote.settings')` —— 某些投影下命名空间要走 `ctx.get` 取；
     *   3. `ctx.configForms.get(ns)` 上的 `mutate` —— 读路径已经证明 `configForms` 可用
     *      （`ctx.configForms.describe().ensure()` 成功），因此同一套东西上若有 `mutate`
     *      就优先用它（读写成对，最不容易出现「读得到写不到」）。
     *
     * @param {object} ctx - Client 插件上下文。
     * @param {string} ns - 命名空间（`entry.options.id`）。
     * @returns {{channel: object|undefined, tried: string[]}} 通道与尝试过的路径。
     */
    function writeChannel(ctx, ns) {
      const tried = [];
      const candidates = [];

      try {
        candidates.push(['ctx.remote.settings', ctx?.remote?.settings]);
      } catch (error) {
        tried.push(`ctx.remote.settings 抛错(${error instanceof Error ? error.message : String(error)})`);
      }
      try {
        candidates.push(["ctx.get('remote.settings')", typeof ctx?.get === 'function' ? ctx.get('remote.settings') : undefined]);
      } catch (error) {
        tried.push(`ctx.get('remote.settings') 抛错(${error instanceof Error ? error.message : String(error)})`);
      }
      try {
        candidates.push(['ctx.configForms.get(ns)', ctx?.configForms?.get?.(ns)]);
      } catch (error) {
        tried.push(`ctx.configForms.get 抛错(${error instanceof Error ? error.message : String(error)})`);
      }

      for (const [label, value] of candidates) {
        if (value === undefined || value === null) {
          tried.push(`${label}=无`);
          continue;
        }
        if (typeof value.mutate === 'function') {
          tried.push(`${label}=有 mutate`);
          // ⚠️ 两个通道的 `mutate` **签名不同**，不能按同一种方式调用：
          //   - `remote.settings.mutate(ns, ops, expectedRevision)` → 返回 `{ok,...}` 信封；
          //   - `configForms.get(ns).mutate(ops, expectedRevision)` → 返回布尔。
          // 实测（DSH 0.2.1-rc.1）后者就是官方 `ConfigForm` 使用的两参形式。
          // 混用会让兜底路径**静默写失败却报成功**，因此这里显式区分。
          return { channel: value, tried, form: label.startsWith('ctx.configForms') ? 'form' : 'namespace' };
        }
        tried.push(`${label}=无 mutate(方法:[${Object.keys(value).join(',')}])`);
      }

      // 全部失败：把结构也记下来，便于判断是不是「整体没挂载」而非「名字不对」。
      const remoteKeys = (() => {
        try {
          return ctx?.remote === undefined || ctx?.remote === null ? '' : Object.keys(ctx.remote).join(',');
        } catch {
          return '(不可枚举)';
        }
      })();
      tried.push(`ctx.remote 可枚举键=[${remoteKeys}]`);
      return { channel: undefined, tried };
    }

    /**
     * 写入角色到本插件配置。
     *
     * **写**走 settings 的 `mutate`（读走 `configForms` 镜像）—— 这是官方「模型」页的分工，
     * 但实测出现过「读成功、写失败」，因此 `writeChannel` 会依次尝试多条访问路径。
     *
     * @param {object} ctx - Client 插件上下文。
     * @param {object[]|undefined} roles - 已改角色数组（含删空的 []），未改传 undefined。
     * @param {number|undefined} revision - 读取时拿到的 revision，用于并发保护。
     * @returns {Promise<{ok: boolean, message: string}>} 结果。
     */
    async function saveRoles(ctx, roles, revision, path = ['roles']) {
      const { channel, tried, form } = writeChannel(ctx, CONFIG_NS);
      if (channel === undefined) {
        return {
          ok: false,
          message:
            '取不到可写的 settings 通道（这不是配置文件的问题）。' +
            `诊断：${tried.join(' | ')}。`,
        };
      }
      const ops = roles === undefined ? [] : [{ op: 'set', path, value: roles }];
      try {
        // 两个通道的调用形态不同（见 writeChannel 的说明），必须分开调用。
        if (form === 'form') {
          const written = await channel.mutate(ops, revision);
          return written === false
            ? { ok: false, message: '写入被拒绝（configForms 通道返回 false）' }
            : { ok: true, message: '已写入' };
        }
        const response = await channel.mutate(CONFIG_NS, ops, revision);
        if (response && response.ok === false) {
          const err = response.error;
          return { ok: false, message: String(err?.message ?? err ?? '写入失败') };
        }
        return { ok: true, message: '已写入' };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }

    /**
     * 把「读配置 / 写配置」绑定到**插件的 ctx**，产出一组操作回调。
     *
     * ## 为什么必须这么做（官方模式，实测踩到后才照做）
     *
     * 官方「模型」页（`dsh-client-ui-settings-models`）的注释写得很直白：
     *
     * > Cards receive these **instead of a context**: the outcomes name what a card
     * > renders … so the failure codes and Remote namespaces stay in the **apply world**.
     *
     * 它的写法是 `createModelsOperations(ctx)` —— 传入**插件自己的 ctx**，在 `apply`
     * 里把操作绑好，再把**操作函数**注入给 React 组件。
     *
     * 我原先的做法是把 `ctx` 塞进 slot 的 `inject: () => ({ ctx })`，让组件里自己读
     * `props.ctx.remote.settings`。**那是错的**：slot 的组件侧上下文与插件上下文不是同一个，
     * 实测表现为「读得到（`configForms` 是 slot 的注入面）、写不到
     * （`remote.settings` 只在插件上下文里）」。
     *
     * 因此读与写都在这里绑定，组件只拿到两个函数，完全不需要 ctx。
     *
     * @param {object} ctx - **插件的** ctx（`apply` 收到的那个）。
     * @returns {{read: Function, write: Function}} 操作回调。
     */
    function makeRoleStore(ctx) {
      // 模式由**最近一次读**决定，写路径据此自保。
      //
      // ⚠️ 为什么需要它：split 模式下设置里只有旋钮层 `roleSettings`，若此时仍写
      //    `roles`，就会把刚迁移好的设置退回「roles 与 roleSettings 并存」的回退陷阱
      //    （roleSettings 一旦被清空，那份陈旧 roles 会静默覆盖用户在面板上的改动）。
      //    界面在 split 模式下已经不提供保存，但**守在这里**才不依赖界面行为。
      let mode = 'legacy';
      return {
        /** 读角色。 */
        read: async () => { const result = await fetchRoles(ctx); mode = result.mode ?? 'legacy'; return result; },
        /** 写角色；`revision` 来自上一次读。 */
        write: (roles, revision) => (mode === 'split'
          ? Promise.resolve({ ok: false, message: '角色设置处于「定义 + 旋钮」形态；本页面不写 roles（会退回半迁移状态）' })
          : saveRoles(ctx, roles, revision)),
        /**
         * 写**旋钮层**（split 模式专用）：只 `set(['roleSettings'])`，绝不碰 `roles`。
         *
         * 与 `write` 分开而不是重载，是为了让「split 下不写 roles」这条自保保持简单可验证。
         */
        writeSettings: (settings, revision) => (mode === 'split'
          ? saveRoles(ctx, settings, revision, ['roleSettings'])
          : Promise.resolve({ ok: false, message: '当前不是「定义 + 旋钮」形态，无需写 roleSettings' })),
      };
    }

    /** 复制一份角色数组，避免直接改读到快照里的对象。 */
    const cloneRoles = (roles) => roles.map((r) => ({ ...r }));

    /**
     * 单行输入框的统一外观。
     *
     * 抽成函数是为了让「驱动选择器」这类自绘控件与 `text()` 完全同款，
     * 不必复制一份样式（复制会漂移）。
     *
     * @returns {object} 内联样式。
     */
    function inputStyle() {
      return {
        width: '100%',
        boxSizing: 'border-box',
        padding: '3px 6px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '4px',
      };
    }

    /**
     * 下拉框的统一外观。
     *
     * @returns {object} 内联样式。
     */
    function selectStyle() {
      return {
        width: '100%',
        padding: '3px 6px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '4px',
      };
    }

    /** 文本域 / 输入框的统一外观。 */
    function monoStyle() {
      return {
        width: '100%',
        boxSizing: 'border-box',
        padding: '4px 6px',
        fontSize: '11px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '4px',
      };
    }

    /** 统一样式的小按钮。 */
    function button(label, onClick, opts = {}) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled: opts.disabled === true,
          ...(opts.expanded === undefined ? {} : { 'aria-expanded': opts.expanded }),
          // ⚠️ 可选的 className：页面级操作区的按钮靠它定位（`pageActionSave` / `pageActionCancel`）。
          //    不加会让「取消」与卡片内编辑器的「取消」在测试与可访问性上无法区分。
          ...(opts.className === undefined ? {} : { className: opts.className }),
          style: {
            padding: '4px 12px',
            fontSize: '12px',
            cursor: opts.disabled ? 'default' : 'pointer',
            color: opts.danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
            background: opts.primary ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '4px',
          },
        },
        label,
      );
    }

    /** 带标签的字段容器；角色与统一包裹设置共用。 */
    const field = (label, control) =>
      h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px' } },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
        control,
      );

    /**
     * 卡片内的角色字段表单，保留原有 CLI 与包裹路由语义。
     *
     * @param {object} props - 组件属性。
     * @returns {object} React 元素。
     */
    function RoleRow(props) {
      const { role, index, onChange, disabled } = props;
      const isCli = role.backend === 'cli';
      const isBuiltin = ['spawn'].includes(role.backend ?? 'spawn');
      // 当前驱动由**字段反推**，而不是读 `cliDriver` —— 这样即使用户手工改了参数，
      // 下拉框会如实显示「需重选预设」。浏览器无本机路径解析器，未知形态不猜测。
      const currentDriver = isCli ? inferCliDriver(role) : undefined;
      const driverDef = CLI_DRIVER_OPTIONS.find((d) => d.id === currentDriver);
      const driverHint =
        driverDef === undefined
          ? '需重选预设：当前配置无法识别为 codex / grok'
          : `${driverDef.label}${
              driverDef.modelPlaceholder ? ` 模型示例：${driverDef.modelPlaceholder}` : ''
            }`;

      /** 改本行某个字段。 */
      const set = (key, value) => onChange(index, { ...role, [key]: value });

      /**
       * 一次提交**多个**字段。
       *
       * ⚠️ 为什么不能用连续多次 `set`：`set` 每次都是 `onChange(index, { ...role, ... })`，
       * 而 `role` 是本行渲染时的那份**快照**。连续调用会各自基于**同一个旧快照**展开，
       * 因此**只有最后一次生效**，前面的字段被静默丢弃。
       *
       * 实测踩到：驱动选择器原本连着调用 4 次 `set` 去填 command / prefixArgs / args /
       * promptDelivery，结果只写进了最后一项，于是下拉框永远反推不中驱动，表现为
       * **「锁死在自定义命令」**。
       *
       * @param {object} patch - 要合并进本行的字段。
       */
      const setMany = (patch) => onChange(index, { ...role, ...patch });

      /** 统一样式的文本输入。 */
      const text = (key, placeholder, trim = false) =>
        h('input', {
          type: 'text',
          value: role[key] ?? '',
          placeholder,
          disabled,
          onChange: (e) => set(key, trim ? e.target.value.trim() || undefined : e.target.value),
          style: inputStyle(),
        });

      /** 统一样式的下拉。 */
      const select = (key, options, labels, allowUnset = false) =>
        h(
          'select',
          {
            value: role[key] ?? (allowUnset ? '' : options[0]),
            disabled,
            onChange: (e) => {
              if (allowUnset && e.target.value === '') {
                const next = { ...role };
                delete next[key];
                onChange(index, next);
              } else set(key, e.target.value);
            },
            style: selectStyle(),
          },
          allowUnset ? h('option', { value: '' }, '（未指定）') : null,
          options.map((o) => h('option', { key: o, value: o }, labels ? labels[o] ?? o : o)),
        );

      /**
       * 切换派发机制。
       *
       * ⚠️ 切到 `cli` 时**必须同时填好一组可用的 CLI 字段**，否则新角色会带着空的
       * `cliCommand` / `cliArgs` 进入 CLI 分支：界面上的驱动下拉框因为「反推不出任何驱动」
       * 而显示「自定义命令」，而 Host 侧会因为 `cliCommand` 缺失直接判配置错误。
       * 默认给第一个真实驱动（`codex`），用户再按需换。
       *
       * @param {string} next - 新的 backend。
       */
      const changeBackend = (next) => {
        if (next !== 'cli') {
          set('backend', next);
          return;
        }
        const fields = cliFieldsFor(DEFAULT_CLI_DRIVER, role.readOnly === true);
        setMany({ backend: next, cliDriver: DEFAULT_CLI_DRIVER, ...(fields ?? {}) });
      };

      /** 一个勾选框。 */
      const checkbox = (key, label) =>
        h(
          'label',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '11px',
              whiteSpace: 'nowrap',
            },
          },
          h('input', {
            type: 'checkbox',
            checked: role[key] === true,
            // ⚠️ 这里**曾经**对 CLI 角色的「允许再派发」置灰 —— 那个复选框已由显式目标清单
            //    （`canDispatch`）取代（D35），现在只剩 `readOnly` 一个复选框，不需要特例。
            disabled,
            onChange: (e) => {
              const checked = e.target.checked;
              if (key === 'readOnly' && isCli) {
                const fields = cliFieldsFor(currentDriver, checked);
                setMany({ readOnly: checked, ...(fields ? { cliDriver: currentDriver, ...fields } : {}) });
              } else set(key, checked);
            },
          }),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
        );

      return h(
        'div',
        {
          style: {
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '6px',
            padding: '10px',
            marginBottom: '10px',
          },
        },
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } },
          h('div', { style: { flex: '0 0 130px' } }, field('角色 id', text('id', 'scout'))),
          h('div', { style: { flex: '1 1 150px' } }, field('角色标题', text('title', '留空使用角色 id'))),
          h(
            'div',
            { style: { flex: '0 0 200px' } },
            field(
              '派发机制',
              h(
                'select',
                {
                  value: role.backend ?? 'spawn',
                  disabled,
                  onChange: (e) => changeBackend(e.target.value),
                  style: selectStyle(),
                },
                BACKENDS.map((b) => h('option', { key: b, value: b }, BACKEND_LABEL[b] ?? b)),
              ),
            ),
          ),
          isBuiltin
            ? h('div', { style: { flex: '1 1 150px' } }, field('Provider', text('provider', '留空使用默认 provider', true)))
            : null,
          h('div', { style: { flex: '1 1 150px' } }, field(isCli ? '外部 CLI 模型' : '模型', text('model', 'gpt-6-luna'))),
          h('div', { style: { flex: '0 0 100px' } }, field('思考强度', select('effort', EFFORTS, undefined, true))),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '16px', marginBottom: '8px', alignItems: 'center' } },
          checkbox('readOnly', '只读'),
          // ⚠️ 旧的布尔「允许再派发」已由**显式目标清单**取代（D35）：布尔的语义是「除自己以外
          //    全部」，新增角色会自动获得派发入口。这里改为逗号分隔的角色 id 清单。
          field('可派发给（角色 id，逗号分隔；留空 = 不可继续派发）',
            h('input', {
              type: 'text', disabled, style: inputStyle(),
              value: (role.canDispatch ?? []).join(', '),
              onChange: (e) => set('canDispatch', String(e.target.value ?? '')
                .split(',').map(item => item.trim()).filter(item => item.length > 0)),
            })),
        ),
        field('描述（主代理据此判断何时派给谁）', text('description', '这个角色负责什么')),
        field(
          '角色指令（必填，发送给子代理）',
          h('textarea', {
            rows: 5,
            value: role.instructions ?? '',
            placeholder: '填写角色职责、约束与输出要求',
            disabled,
            onChange: (e) => set('instructions', e.target.value),
            style: monoStyle(),
          }),
        ),
        isCli
          ? h(
              'div',
              {
                style: {
                  marginTop: '8px',
                  paddingTop: '8px',
                  borderTop: '1px dashed var(--dsw-alias-border-l2)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                },
              },
              h(
                'span',
                { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
                '外部 CLI —— 选择 Codex CLI / Grok CLI 预设',
              ),
              // ⚠️ 这里是「选**哪个** CLI」，不是笼统的「外部 CLI」。
              //    选中后会把该 CLI 的 command / prefixArgs / args / promptDelivery
              //    一键填好；命令细节隐藏，保留已保存的数据供 Host 校验。
              field(
                'CLI',
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                  h(
                    'select',
                    {
                      value: currentDriver ?? '',
                      disabled,
                      onChange: (e) => {
                        const id = e.target.value;
                        const fields = cliFieldsFor(id, role.readOnly === true);
                        // 必须**一次**提交全部字段（见 `setMany` 的说明：连续 set 只有最后一次生效）。
                        // 只填「命令形态」四件套；模型与工作目录属于用户自己的环境，不由驱动改写。
                        setMany(
                          fields === undefined
                            ? { cliDriver: id }
                            : {
                                cliDriver: id,
                                cliCommand: fields.cliCommand,
                                cliPrefixArgs: fields.cliPrefixArgs,
                                cliArgs: fields.cliArgs,
                                cliPromptDelivery: fields.cliPromptDelivery,
                              },
                        );
                      },
                      style: selectStyle(),
                    },
                    currentDriver === undefined ? h('option', { value: '', disabled: true }, '需重选预设') : null,
                    CLI_DRIVER_OPTIONS.map((d) => h('option', { key: d.id, value: d.id }, d.label)),
                  ),
                ),
              ),
              h(
                'span',
                { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
                driverHint,
              ),
              h(
                'span',
                { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' } },
                '⚠️ 外部 CLI 会在本机真的执行命令。只读约束由 CLI 自身的沙箱参数实现，插件无法越过 CLI 强制。',
              ),
            )
          : null,
      );
    }

    /** 每张卡片保留自己的草稿；切换焦点时通过 key 重新挂载，丢弃未保存内容。 */
    function RoleCard({ role, index, editing, onEdit, onCancel, onSave, onRemove, confirmDelete, onConfirmDelete, onCancelDelete, problem, disabled, roles }) {
      const [draftRole, setDraftRole] = useState(() => ({ ...role }));
      const invalid = validateRoles([role]) ||
        (roles.filter(r => r.id === role.id).length > 1 ? '角色 id 重复' : null) ||
        (role.backend === 'cli' && !inferCliDriver(role) ? '需重选预设' : null);
      const mechanism = role.backend === 'cli'
        ? '外部 · ' + (inferCliDriver(role) ?? '需重选预设')
        : '内置 · ' + (role.backend ?? 'spawn');
      const badge = text => h('span', { className: 'rowTag', style: {
        fontSize: '10px', padding: '2px 5px', borderRadius: '4px',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
      } }, text);
      return h('li', { className: 'rowCard', 'data-role-id': role.id, style: {
        listStyle: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px', padding: '10px',
      } },
        h('div', { className: 'rowHead', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('div', { className: 'rowIdentity', style: { display: 'flex', gap: '8px', alignItems: 'center', flex: '1 1 auto', flexWrap: 'wrap' } },
            h('span', { role: 'img', 'aria-label': invalid ? '配置错误：' + invalid : '配置完整有效',
              'data-state': invalid ? 'error' : 'success', style: { width: '8px', height: '8px', flex: '0 0 8px', borderRadius: '50%',
                background: invalid ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }),
            h('strong', { className: 'rowName' }, role.title?.trim() || role.id || '(未命名)'),
            h('code', { style: { fontSize: '11px' } }, role.id || '(待填写 id)'),
            badge(mechanism), role.model ? badge(role.model) : null,
            role.readOnly ? badge('只读') : null, (role.canDispatch ?? []).length > 0 ? badge('可继续派发') : null),
          h('div', { className: 'rowActions', style: { display: 'flex', gap: '6px' } },
            button(editing ? '收起' : '编辑', editing ? onCancel : onEdit, { disabled, expanded: editing }),
            index !== 'new' ? button('删除', onConfirmDelete, { disabled, danger: true }) : null)),
        confirmDelete ? h('div', { role: 'alert', style: { marginTop: '8px' } },
          '确认删除这个角色？', button('确认删除', onRemove, { disabled, danger: true }),
          button('取消', onCancelDelete, { disabled })) : null,
        editing ? h('div', { className: 'rowEditor', style: { marginTop: '10px' } },
          h(RoleRow, { role: draftRole, index, onChange: (_, next) => setDraftRole(next), disabled }),
          problem ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)' } }, problem) : null,
          button('保存', () => onSave(draftRole), { disabled, primary: true }), button('取消', onCancel, { disabled })) : null);
    }

    // ⚠️ 这里**曾经**有 `WrapperSettings`（包裹子代理的 Provider / 模型 / 思考强度）。
    // 那三个字段是**中继子代理**的 LLM 路由：旧路径要先 spawn 一个 LLM 转交代理去调 CLI 工具，
    // 才需要回答「它用哪个模型」。CLI 角色改为**直派后台任务**后没有转交代理，
    // 字段与整个小节一并从 Host schema 和本面板删除。

    /**
     * 设置页主组件。
     *
     * 刻意采用「本地草稿 + 显式保存」而不是逐字段即时写入：
     *   - 切换 backend 会连带产出多条字段变更（补 CLI 参数、清 builtin 专属字段），
     *     逐条写会产生不通过 Host 校验的中间态。
     *   - 一次 `mutate` 提交多条操作天然原子，且只需一个 revision。
     *
     * @param {object} props - Slot 注入的属性。
     * @returns {object} React 元素。
     */
    function SwitchboardSettings(props) {
      // ⚠️ 组件**不接收 ctx**，只接收插件 `apply` 里绑定好的操作回调。
      //    这与官方「模型」页一致：它把 `createModelsOperations(ctx)` 的结果注入给卡片，
      //    注释原文是「Cards receive these **instead of a context** … so the failure codes
      //    and Remote namespaces stay in the **apply world**」。
      //    原因：slot 的组件侧上下文与插件上下文不是同一个，直接读 `props.ctx.remote`
      //    会拿不到远程命名空间（实测：读得到 configForms、写不到 remote.settings）。
      const store = props.store;
      // 供应商目录（可能为 undefined：拿不到 `remote.llm` —— 那时供应商退回文本框）。
      // ⚠️ 同步读一次快照、不订阅：目录在 `apply` 阶段就已开始加载，设置页总在这之后打开，
      //    到渲染时通常已就绪；真为空也只是退化成文本框（功能不丢），不值得再加一个 effect
      //    与一轮订阅（那会打乱钩子顺序、牵连既有断言）。
      const catalog = props.catalog;
      const providers = catalog?.getProviders?.() ?? [];
      const [draft, setDraft] = useState(null);
      const [editingId, setEditingId] = useState(null);
      const [confirmingIndex, setConfirmingIndex] = useState(null);
      const [readSucceeded, setReadSucceeded] = useState(false);
      const [cardProblem, setCardProblem] = useState(null);
      const [status, setStatus] = useState('loading');
      // split 模式（设置里只有旋钮层 `roleSettings`，角色定义住在 roles.json）的旋钮草稿。
      const [splitSettings, setSplitSettings] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);
      // 读取时拿到的 revision 必须留到写回时使用，否则并发保护无从谈起。
      const [revision, setRevision] = useState(undefined);
      const savedRef = useRef(null);
      const readSequenceRef = useRef(0);
      // 旋钮层（split 模式）的已保存快照：与 `savedRef`（roles 列表）分开，因为两者是**不同**
      // 的编辑对象 —— 混用会让 split 下的 dirty 恒为 false，操作区按钮永久禁用。
      const settingsRef = useRef(null);

      /** 重新读取本插件的配置。 */
      const refresh = useCallback(() => {
        const readSequence = ++readSequenceRef.current;
        setReadSucceeded(false);
        setConfirmingIndex(null);
        if (store === undefined || typeof store.read !== 'function') {
          setStatus('error:未取到插件操作回调（插件的 apply 未注入 store）');
          return;
        }
        setStatus('loading');
        setEditingId(null);
        setCardProblem(null);
        void store.read().then((result) => {
          // 连续重读可能交错返回；旧响应不得覆盖最新请求的状态与 revision。
          if (readSequence !== readSequenceRef.current) return;
          if (!result.ok) {
            setReadSucceeded(false);
            // 读取失败必须如实显示：静默当作空会把用户配置「藏起来」。
            setDraft([]);
            savedRef.current = JSON.stringify({ roles: [] });
            setRevision(undefined);
            setStatus(`error:${result.error}`);
            return;
          }
          setDraft(cloneRoles(result.roles));
          savedRef.current = JSON.stringify({ roles: result.roles });
          // revision 用于并发保护：写回时必须带上读取时的那一个。
          setRevision(result.revision);
          setReadSucceeded(true);
          // split 模式：设置里只有旋钮层，角色**定义**住在 roles.json。
          // 这里渲染旋钮小表单，保存只写 `roleSettings`。
          if (result.mode === 'split') {
            // ⚠️ 旋钮表单需要**自己的**快照与 dirty 判据：`savedRef` 记的是 roles 列表，
            //    而 split 模式下那份列表根本不参与编辑（恒等于已保存值），拿它当判据会让
            //    「取消 / 保存」**永久禁用**（实测：用户点了没反应）。
            const snapshot = (result.settings ?? []).map((entry) => ({ ...entry }));
            settingsRef.current = snapshot;
            setSplitSettings(snapshot.map((entry) => ({ ...entry })));
            setStatus('split');
            return;
          }
          setSplitSettings(null);
          settingsRef.current = null;
          setStatus(result.roles.length > 0 ? 'ready' : result.missing === true ? 'missing' : 'empty');
        });
      }, [store]);

      // 首次挂载读一次。`ensure()` 是异步的，因此首帧通常还看不到我们的行；
      // 但 `read` 内部已经 `await ensure()`，所以这里读一次就够，不需要再订阅镜像。
      useEffect(() => {
        if (store === undefined) return undefined;
        refresh();
        return undefined;
      }, [store, refresh]);

      const roles = draft ?? [];
      const saved = savedRef.current === null ? {} : JSON.parse(savedRef.current);
      const rolesDirty = draft !== null && JSON.stringify(roles) !== JSON.stringify(saved.roles);
      const dirty = rolesDirty;

      const beginEdit = id => { setConfirmingIndex(null); setEditingId(id); setCardProblem(null); };
      const cancelEdit = () => { setConfirmingIndex(null); setEditingId(null); setCardProblem(null); };
      const newRole = { id: '', description: '', instructions: '', backend: 'spawn', model: '',
        effort: 'medium', readOnly: false, canDispatch: [] };
      const addRole = () => beginEdit('new');

      /**
       * 校验草稿是否可提交。
       *
       * 直接复用模块作用域的 `validateRoles`，其实现与 `src/client/logic.js`
       * 逐字一致（有断言锁定）。
       *
       * @returns {string|null} 错误信息，或 null 表示通过。
       */
      const validate = (nextRoles) => validateRoles(nextRoles) ||
        (nextRoles.some(r => r.backend === 'cli' && !inferCliDriver(r)) ? '需重选预设：当前配置无法识别为 codex / grok' : null);

      /** 保存角色列表。 */
      const save = async (nextRoles = roles, forceRoles = false) => {
        if (!readSucceeded) {
          setNotice({ kind: 'error', text: '读取失败，不能写入。点「取消」可重试。' });
          return;
        }
        if (store === undefined || typeof store.write !== 'function' || busy) return;
        const problem = validate(nextRoles);
        if (problem) {
          setNotice({ kind: 'error', text: problem });
          setCardProblem(problem);
          return;
        }
        setBusy(true);
        // 只提交已改草稿，避免把根未提供的 roles 误写成 []；删空仍为 dirty。
        const result = await store.write(forceRoles || rolesDirty ? nextRoles : undefined, revision);
        setBusy(false);
        if (result.ok) {
          setDraft(cloneRoles(nextRoles));
          savedRef.current = JSON.stringify({ roles: nextRoles });
          setNotice({
            kind: 'ok',
            text: `已保存 ${nextRoles.length} 个角色。Switchboard 正在应用配置，无需重启；后续派发使用新配置，应用失败请查看自检。`,
          });
          refresh();
        } else {
          setNotice({ kind: 'error', text: `保存失败：${result.message}` });
          setCardProblem(`保存失败：${result.message}`);
        }
      };

      // --- 渲染 ---
      const header = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('h3', { style: { margin: 0, fontSize: '13px' } }, '角色与派发机制'),
        h(
          'span',
          {
            style: {
              fontSize: '11px',
              color: 'var(--dsw-alias-label-secondary)',
              flex: '1 1 auto',
            },
          },
          '每个角色可独立选择走 DSH 内置子代理，还是走本机外部 CLI。',
        ),
        // ⚠️ 顶部**曾经**还有一对「保存 / 放弃改动」。操作区统一收到底部（取消在左、保存在最右），
        //    避免同一页出现两套语义相同的按钮。
      );

      // 说明性的页脚。原先这里是一个 `allowCrossCli` 总开关，现已移除：
      // 「是否挂载角色工具」由 preset 的 `mount: true` 决定（见 D13），而某个角色是否
      // 走 CLI 由它自己的 `backend` 决定 —— 那个总开关已经没有存在的必要，
      // 留着反而会让用户以为「开了它才有 CLI 角色」。
      const footer = h(
        'div',
        {
          style: {
            fontSize: '11px',
            color: 'var(--dsw-alias-label-secondary)',
            paddingTop: '8px',
            borderTop: '1px solid var(--dsw-alias-border-l2)',
          },
        },
        '角色工具只在选中 Switchboard preset 的会话里挂载；设为「外部 CLI」的角色会在本机执行外部命令。',
      );

      const wrap = (children) =>
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              fontSize: '12px',
              color: 'var(--dsw-alias-label-primary)',
              padding: '4px 2px',
            },
          },
          header,
          notice
            ? h(
                'div',
                {
                  style: {
                    fontSize: '11px',
                    color:
                      notice.kind === 'error'
                        ? 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary))'
                        : 'var(--dsw-alias-label-secondary)',
                  },
                },
                notice.text,
              )
            : null,
          children,
          footer,
        );

      if (status === 'no-context') {
        return wrap(h('div', null, '无法取得插件上下文，设置页不可用。'));
      }
      if (draft === null) {
        return wrap(h('div', null, '正在读取配置…'));
      }
      if (status === 'split') {
        // split 模式：设置里只有**旋钮层**，角色定义（persona / 工具构成 / CLI 参数）住在
        // `$DSH_HOME/agent-switchboard/roles.json`。保存只写 `roleSettings`，绝不碰 `roles`。
        const entries = splitSettings ?? [];
        const patch = (index, field, value) => setSplitSettings((current) =>
          (current ?? []).map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)));
        // 旋钮是否被改过：与**读取时**（或上次保存成功时）的快照逐字比较。
        const settingsDirty = settingsRef.current !== null
          && JSON.stringify(entries) !== JSON.stringify(settingsRef.current);
        // 「取消」= 丢弃本地编辑、回到上次读取/保存的状态。刻意**不**重新读配置：
        // 那会多发一次远程读（可能失败），而用户要的只是「撤销我刚才改的」。
        const cancelSettings = () => {
          setSplitSettings((settingsRef.current ?? []).map((entry) => ({ ...entry })));
          setNotice(null);
        };
        const saveSettings = async () => {
          if (store === undefined || typeof store.writeSettings !== 'function') return;
          setBusy(true);
          try {
            const result = await store.writeSettings(entries, revision);
            if (result.ok) settingsRef.current = entries.map((entry) => ({ ...entry }));
            setNotice({ kind: result.ok ? 'info' : 'error',
              text: result.ok ? '已保存旋钮设置。模型、强度与外部 CLI 选择下次派发即生效；只读与能否嵌套派发属角色定义（roles.json），本页不改。' : result.message });
          } finally { setBusy(false); }
        };
        // ⚠️ 这里**曾经**有一个 `checkbox` 助手，用来渲染「只读 / 允许嵌套派发」两个旋钮
        //    （还带一段「CLI 角色的嵌套开关无效」的置灰逻辑）。两者都已移出旋钮层（D34/D35），
        //    该助手随之删除 —— 留着会让人以为面板还能改这两件事。
        return wrap(h('div', null,
          h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '8px' } },
            '角色定义（persona、工具构成、CLI 参数）住在 $DSH_HOME/agent-switchboard/roles.json，'
            + '本页只调每个角色的旋钮（派发方式 / 模型 / 强度 / 外部 CLI）。'
            + '只读与能否嵌套派发属**角色定义**，不在本页编辑 —— 它们决定角色 preset 的构成，改了要重建组合。'),
          h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'flex',
            flexDirection: 'column', gap: '10px' } },
          entries.map((entry, index) => h('li', { key: String(entry.id ?? index),
            style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', padding: '8px' } },
          h('div', { style: { fontWeight: 600, fontSize: '12px', marginBottom: '6px' } }, String(entry.id ?? '（无 id）')),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' } },
            h('span', { style: { fontSize: '11px', width: '56px' } }, '派发方式'),
            h('select', { value: entry.backend ?? '', disabled: busy, style: selectStyle(),
              onChange: (event) => patch(index, 'backend', event?.target?.value || undefined) },
            h('option', { value: '' }, '（默认 spawn）'),
            BACKENDS.map((value) => h('option', { key: value, value }, BACKEND_LABEL[value] ?? value)))),
          // 「用哪个外部 CLI」——**只在 backend 是 cli 时出现**。
          //
          // ⚠️ 这里只写**驱动 id**（一次选择）；命令与参数由 Host 按 `src/cli/drivers.js` 的
          //    策展表派生（`cliFieldsFor`）。面板刻意不提供逐字段编辑 argv 的入口：
          //    「argv 来自用户配置、模型只能填受限占位符」这条约束不该被一个网页表单打开缺口。
          entry.backend === 'cli'
            ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' } },
              h('span', { style: { fontSize: '11px', width: '56px' } }, '外部 CLI'),
              h('select', { value: entry.cliDriver ?? '', disabled: busy, style: selectStyle(),
                onChange: (event) => patch(index, 'cliDriver', event?.target?.value || undefined) },
              h('option', { value: '' }, '（沿用角色定义）'),
              CLI_DRIVER_OPTIONS.map((driver) => h('option', { key: driver.id, value: driver.id },
                driver.label ?? driver.id)),
              // 现有值不在策展表里（例如手写过 custom）时原样显示，避免下拉框「锁死」成别的驱动。
              entry.cliDriver !== undefined && !CLI_DRIVER_OPTIONS.some(d => d.id === entry.cliDriver)
                ? h('option', { value: entry.cliDriver }, entry.cliDriver) : null))
            : null,
          // 「用哪个**供应商**」——只在**本地（spawn）**派发时出现。
          //
          // ⚠️ 这条原先在 split 表单里**漏了**（`provider` 一直是旋钮字段集的一员，legacy 卡片也
          //    一直在渲染它，只有 split 表单没有入口）⇒ 拆分配置的用户**无法**指定子代理的
          //    provider，只能吃默认值。CLI 角色则没有意义：它的 provider 由驱动（codex / grok）
          //    自己的登录态决定，所以这一行沿用 legacy 卡片的做法——cli 时隐藏。
          entry.backend === 'cli'
            ? null
            : h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' } },
              h('span', { style: { fontSize: '11px', width: '56px' } }, '供应商'),
              // 目录可用 → 下拉；不可用 → 文本框（**绝不**因为读不到目录就让人没法填）。
              providers.length > 0
                ? h('select', { value: entry.provider ?? '', disabled: busy, style: selectStyle(),
                  onChange: (event) => patch(index, 'provider', event?.target?.value || undefined) },
                  h('option', { value: '' }, '（跟随默认 provider）'),
                  providers.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
                  // 现值不在目录里（手写过、或在别处配的）时原样保留 —— 不锁死、不静默改值。
                  entry.provider !== undefined && entry.provider !== ''
                    && !providers.some((item) => item.id === entry.provider)
                    ? h('option', { value: entry.provider }, entry.provider) : null)
                : h('input', { type: 'text', value: entry.provider ?? '', disabled: busy, style: inputStyle(),
                  placeholder: '留空则跟随默认 provider（未读到供应商目录，可手填）',
                  // 空串写 `undefined`：让这个键**消失**，而不是在配置里留一个空字符串。
                  onChange: (event) => patch(index, 'provider', event?.target?.value || undefined) })),
          // 「模型」：**只有**在「本地派发 + 已选供应商 + 已读到该供应商的模型」时才是下拉。
          // 其余情况（外部 CLI、未选供应商、目录读不到）一律退回自由文本 ——
          // 外部 CLI 的模型 id 来自驱动自己的世界（如 `gpt-6.1-sol`），DSH 目录里根本没有。
          (() => {
            const models = entry.backend !== 'cli' && entry.provider !== undefined && entry.provider !== ''
              ? (catalog?.getModels?.(entry.provider) ?? []) : [];
            return h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' } },
              h('span', { style: { fontSize: '11px', width: '56px' } }, '模型'),
              models.length > 0
                ? h('select', { value: entry.model ?? '', disabled: busy, style: selectStyle(),
                  onChange: (event) => patch(index, 'model', event?.target?.value || undefined) },
                  h('option', { value: '' }, '（跟随默认模型）'),
                  models.map((model) => h('option', { key: model.id, value: model.id }, model.label)),
                  // 现值不在目录里（手写过、或驱动侧特有）时原样保留 —— 不锁死、不静默改值。
                  entry.model !== undefined && entry.model !== ''
                    && !models.some((model) => model.id === entry.model)
                    ? h('option', { value: entry.model }, entry.model) : null)
                : h('input', { type: 'text', value: entry.model ?? '', disabled: busy, style: inputStyle(),
                  placeholder: entry.backend === 'cli' ? '外部 CLI 自己的模型 id（如 gpt-6.1-sol）'
                    : '留空则跟随默认（未读到模型目录时会话可手填）',
                  onChange: (event) => patch(index, 'model', event?.target?.value ?? '') }));
          })(),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' } },
            h('span', { style: { fontSize: '11px', width: '56px' } }, '思考强度'),
            h('select', { value: entry.effort ?? '', disabled: busy, style: selectStyle(),
              onChange: (event) => patch(index, 'effort', event?.target?.value || undefined) },
            h('option', { value: '' }, '（不指定）'),
            EFFORTS.map((value) => h('option', { key: value, value }, value)))),
          // ⚠️ 「只读」与「能否继续派发」**不再出现在这里**（D34）：它们是组合期事实、属于
          //    角色的固有属性，住在 roles.json 的定义层。做成旋钮既让人以为「改了立刻生效」，
          //    又让每次保存都要重建组合 —— 那是设计，不是调参。这里只**如实显示**当前值。
          //    D35 起可派发目标是**显式清单**（`canDispatch`），所以这里把目标逐个列出来 ——
          //    「除自己以外全部」那种隐式语义正是要消灭的东西。
          h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
            `${entry.readOnly === true ? '只读角色' : '可写角色'} · `
            + `${Array.isArray(entry.canDispatch) && entry.canDispatch.length > 0
              ? `可派发给：${entry.canDispatch.join(' / ')}` : '不可继续派发'}`
            + '（属角色定义，改动请编辑 roles.json）')))),
          // 底部操作区：靠右，取消在左、保存在最右。
          // ⚠️ 禁用判据必须用**旋钮层自己的** `settingsDirty`（不是 roles 列表的 dirty）——
          //    用错了会让两个按钮在 split 模式下永久禁用（实测踩到：点「取消」毫无反应）。
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' } },
            button('取消', cancelSettings, { disabled: busy || !settingsDirty, className: 'pageActionCancel' }),
            button(settingsDirty ? '保存 *' : '保存', saveSettings,
              { disabled: busy || !settingsDirty, primary: settingsDirty, className: 'pageActionSave' }))));
      }
      if (status.startsWith('error:')) {
        // 读取失败必须显式呈现原因，而不是显示成「尚未配置」——后者会让用户以为配置丢了。
        // ⚠️ 这里只显示 `fetchRoles` 给出的**具体**原因，不再附一句猜测性的通用建议：
        //    曾经写死「这通常是配置文件损坏」，而真实原因是远程通道取不到，把排查方向
        //    完全带偏（实测教训）。宁可少说，也不要说不符合实际的话。
        return wrap(h('div', null,
          h(
            'div',
            { style: { color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary))' } },
            `读取角色配置失败：${status.slice('error:'.length)}`,
            h('br'),
            '点「取消」可重试。',
          ),
          // ⚠️ 错误态**必须**也有那条操作区：操作区原先在页头（对所有状态可见），收到底部后
          //    如果这里不补，错误页就会显示「点「取消」可重试」却**没有那个按钮**（实测踩到）。
          //    ⚠️ `wrap()` 只接收**一个**子节点（不是变参）—— 直接多传一个参数会被静默丢掉，
          //    这正是第一版没生效的原因（渲染出错误文字却没有按钮）。
          //    保存保持 disabled —— 读取失败时不允许写入（F1 的硬闸门）。
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' } },
            button('取消', refresh, { disabled: busy, className: 'pageActionCancel' }),
            // 按钮虽 disabled，回调仍走**真实的** save()（它自己会因 !readSucceeded 早退并给出
            // 「读取失败，不能写入」）—— 保留那道硬闸门的可验证性，而不是留一个空回调。
            button('保存', () => save(), { disabled: true, className: 'pageActionSave' })),
        ));
      }
      const cardProps = (role, index) => ({
        key: String(index) + ':' + (editingId === index), role, index, roles,
        editing: editingId === index, disabled: busy,
        confirmDelete: confirmingIndex === index,
        onConfirmDelete: () => setConfirmingIndex(index), onCancelDelete: () => setConfirmingIndex(null),
        problem: editingId === index ? cardProblem : null,
        onEdit: () => beginEdit(index), onCancel: cancelEdit,
        onSave: next => save(index === 'new' ? [...roles, next] : roles.map((r, i) => i === index ? next : r), true),
        onRemove: () => { setConfirmingIndex(null); return save(roles.filter((_, i) => i !== index), true); },
      });
      return wrap(h('div', null,
        h('ul', { className: 'rows', style: { margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' } },
          roles.map((role, index) => h(RoleCard, cardProps(role, index)))),
        h('div', { className: 'addBlock', style: { marginTop: '10px' } },
          editingId === 'new'
            ? h('ul', { style: { padding: 0 } }, h(RoleCard, cardProps(newRole, 'new')))
            : button('+ 新增角色', addRole, { disabled: busy || draft === null })),
        // 底部操作区：与 split 表单同一形态（靠右、取消在左、保存在最右）。
        // ⚠️ 这里是 legacy 模式下**唯一**的整表保存入口 —— 顶部那对按钮已移除，
        //    不加这一行就会让 legacy 用户无法保存列表级改动。
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' } },
          button('取消', refresh, { disabled: busy || !dirty, className: 'pageActionCancel' }),
          button(dirty ? '保存 *' : '保存', () => save(), { disabled: busy || !readSucceeded || !dirty, primary: dirty, className: 'pageActionSave' }))));
    }

    // 「模型供应商」目录：尽力而为地绑定 `remote.llm`（内核提供；官方「模型」设置页也用它）。
    //
    // ⚠️ 刻意**不**写进插件的 `inject`：那里是**必需**依赖，缺一个整页起不来（历史事故：
    //    注入过我们自己延迟注册的 `remote.roleConfig`，页面直接不激活）。这里在 `apply` 里用
    //    `ctx.inject(['remote'], …)` 拿到网关后再取 `.llm`，拿不到或调用失败就退化成文本框 ——
    //    供应商下拉是**增强**，不该有能力把设置页拖垮。
    function makeModelCatalog() {
      let llm = null;
      let providers = [];
      const listeners = new Set();
      const models = new Map();
      const emit = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* 单个订阅者出错不影响其它 */ } } };
      // 目录形态按「信封 / 裸数组、字符串或对象」都收 —— 真机核对结果（2026-10-19）：
      //   · `listProviders()` 返回**信封** `{ok:true, value} | {ok:false, error:{message}}`；
      //     官方模型页的写法就是 `if (!registered.ok) failLoad(registered.error.message)`。
      //     ⚠️ 第一版把整个信封当数组 ⇒ 永远得到空目录 ⇒ 面板一直退回文本框（真机踩到）。
      //   · 条目里的 **id 叫 `provider`**（如 `deepseek-official`），`name` 是显示名
      //     —— id 必须优先取 `provider`，否则会拿到「DeepSeek」这种显示名当 id。
      //   · 必须**保留 `settingsNs`**：模型发现按各供应商自己的命名空间做
      //     （`discoverModels(probe.settingsNs, { provider })`），丢了它就没有模型清单的钥匙。
      const toList = (value) => (Array.isArray(value) ? value : [])
        .map((item) => (typeof item === 'string'
          ? { id: item, label: item }
          : { id: String(item?.provider ?? item?.id ?? item?.name ?? ''),
            label: String(item?.label ?? item?.name ?? item?.provider ?? item?.id ?? ''),
            settingsNs: typeof item?.settingsNs === 'string' ? item.settingsNs : undefined }))
        .filter((item) => item.id !== '');
      // 模型可能是字符串数组、也可能是对象数组 —— 同样两种都收。
      const toModels = (value) => (Array.isArray(value) ? value : [])
        .map((item) => (typeof item === 'string'
          ? { id: item, label: item }
          : { id: String(item?.id ?? item?.name ?? ''), label: String(item?.label ?? item?.name ?? item?.id ?? '') }))
        .filter((item) => item.id !== '');
      // 某供应商的模型：没有 ns / 调用失败 / 信封 ok=false 一律记空数组（面板据此退回文本框）。
      const loadModels = (provider) => {
        if (llm === null || typeof llm.discoverModels !== 'function') return Promise.resolve([]);
        if (provider.settingsNs === undefined) return Promise.resolve([]);
        return Promise.resolve()
          .then(() => llm.discoverModels(provider.settingsNs, { provider: provider.id }))
          .then((answer) => (answer?.ok === true ? toModels(answer.value) : []))
          .catch(() => [])
          .then((list) => { models.set(provider.id, list); emit(); return list; });
      };
      return {
        bind(next) {
          llm = next === undefined || next === null || typeof next.listProviders !== 'function' ? null : next;
          models.clear();
          if (llm === null) { providers = []; emit(); return Promise.resolve([]); }
          return Promise.resolve()
            .then(() => llm.listProviders())
            .then((answer) => {
              // ⚠️ 先拆**信封**再取目录（`{ok:true, value}` / `{ok:false, error}`）；
              //    裸数组也容忍，但绝不把信封本身当成列表（那会让目录永远为空）。
              providers = answer?.ok === true ? toList(answer.value)
                : Array.isArray(answer) ? toList(answer) : [];
              emit();
              // 预取：设置页总在 `apply` 之后才打开，预取完成后面板就能**同步**读到模型清单
              // —— 不必为一个下拉再加 effect 与订阅（那会打乱钩子顺序、牵连既有断言）。
              for (const provider of providers) void loadModels(provider);
              return providers;
            })
            .catch(() => { providers = []; emit(); return providers; });
        },
        getProviders: () => providers,
        getModels: (providerId) => models.get(providerId) ?? [],
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      };
    }

    return {
      // **读**走 `configForms` 镜像，**写**走 `remote.settings` —— 这是官方「模型」设置页
      // （`dsh-client-ui-settings-models`）的分工，其 inject 里两者都在：
      //     const inject = [..., "remote.credentials", "remote.llm", "remote.settings",
      //                     "remote.session", "configForms", ...];
      //
      // `configForms.describe()` 返回的镜像面提供 `ensure()`（异步补全）/
      // `getSnapshot()`（`view.namespaces` 与 `view.writable`）/ `subscribe()`。
      // 只用 `remote.settings.describe()` 读是错的路子 —— 实测报「取不到 remote.settings 通道」。
      //
      // ⚠️ 这两个都是**内核插件提供**、每次启动都在的依赖，因此写进 inject 是安全的。
      //    曾经注入的 `remote.roleConfig` 是我们自己延迟注册的服务，声明成必需依赖后
      //    永远等不到，导致整页起不来（`web boot: 1 entry did not activate`）。
      //    判据是「由谁保证它在装载期存在」，而不是名字里有没有 `remote.`。
      inject: ['slots', 'configForms', 'remote.settings'],
      apply(ctx) {
        // ⚠️ 在**插件上下文**里绑定读写操作，再把操作注入给组件 —— 与官方「模型」页
        //    （`createModelsOperations(ctx)`）一致。不要把 `ctx` 本身注入给组件：
        //    slot 的组件侧上下文与插件上下文不是同一个，实测表现为「读得到、写不到」。
        const store = makeRoleStore(ctx);
        // 供应商目录（可能一直为空：拿不到 `remote.llm`、或调用失败 —— 面板会退回文本框）。
        const catalog = makeModelCatalog();
        if (typeof ctx.inject === 'function') {
          ctx.inject(['remote'], (scope) => {
            try { return catalog.bind(scope?.remote?.llm); } catch { return catalog.bind(null); }
          });
        }
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              // 用自己的 id：新 id 会与既有条目并列，复用已占用的 id 会**替换**该格。
              id: 'agent-switchboard',
              order: 25,
              label: '角色与派发',
              inject: () => ({ store, catalog }),
            },
            SwitchboardSettings,
          ),
        );
      },
    };
  },
});
