/**
 * Agent Switchboard 的 Client 半边。
 *
 * 提供一个 `settings.section` 页面：**角色与派发机制编辑器**（见 `docs/decisions.md` D13）。
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

/** 已知的后端取值（必须与 Host 的 `z.union(['spawn','fork','cli'])` 一致）。 */
const BACKENDS = ['spawn', 'fork', 'cli'];

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
  fork: '内置 · fork（继承上下文）',
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
    prefixArgs: ['{npmRoot}\\@openai\\codex\\bin\\codex.js'],
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
 * @param {object} role - 角色。
 * @returns {string|undefined} 驱动 id。
 */
function inferCliDriver(role) {
  for (const d of CLI_DRIVER_OPTIONS) {
    if (role?.cliCommand !== d.command) continue;
    if (JSON.stringify(role.cliPrefixArgs) !== JSON.stringify(d.prefixArgs)) continue;
    if (role.cliPromptDelivery !== d.promptDelivery) continue;
    const args = role.cliArgs ?? [];
    for (const readOnly of [true, false]) {
      if (JSON.stringify(args) === JSON.stringify(d.args(readOnly))) return d.id;
    }
  }
  return undefined;
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
        return {
          ok: true,
          roles,
          revision: row.revision,
          writable: row.writable,
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
     * @param {object[]} roles - 角色数组。
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
          return { channel: value, tried };
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
     * @param {object[]} roles - 角色数组。
     * @param {number|undefined} revision - 读取时拿到的 revision，用于并发保护。
     * @returns {Promise<{ok: boolean, message: string}>} 结果。
     */
    async function saveRoles(ctx, roles, revision) {
      const { channel, tried } = writeChannel(ctx, CONFIG_NS);
      if (channel === undefined) {
        return {
          ok: false,
          message:
            '取不到可写的 settings 通道（这不是配置文件的问题）。' +
            `诊断：${tried.join(' | ')}。`,
        };
      }
      try {
        const response = await channel.mutate(
          CONFIG_NS,
          [{ op: 'set', path: ['roles'], value: roles }],
          revision,
        );
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
      return {
        /** 读角色。 */
        read: () => fetchRoles(ctx),
        /** 写角色；`revision` 来自上一次读。 */
        write: (roles, revision) => saveRoles(ctx, roles, revision),
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
          style: {
            padding: '4px 12px',
            fontSize: '12px',
            cursor: opts.disabled ? 'default' : 'pointer',
            color: 'var(--dsw-alias-label-primary)',
            background: opts.primary ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '4px',
          },
        },
        label,
      );
    }

    /**
     * 一个角色编辑行。
     *
     * @param {object} props - 组件属性。
     * @returns {object} React 元素。
     */
    function RoleRow(props) {
      const { role, index, onChange, onRemove, disabled } = props;
      const isCli = role.backend === 'cli';
      const isBuiltin = ['spawn', 'fork'].includes(role.backend ?? 'spawn');
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

      /** 带标签的字段容器。 */
      const field = (label, control) =>
        h(
          'label',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px' } },
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
          control,
        );

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
      const select = (key, options, labels) =>
        h(
          'select',
          {
            value: role[key] ?? options[0],
            disabled,
            onChange: (e) => set(key, e.target.value),
            style: selectStyle(),
          },
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
          { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
          h('strong', { style: { fontSize: '12px' } }, role.id || '(未命名)'),
          h(
            'span',
            {
              style: {
                fontSize: '11px',
                color: 'var(--dsw-alias-label-secondary)',
                flex: '1 1 auto',
              },
            },
            `${BACKEND_LABEL[role.backend] ?? role.backend ?? 'spawn'} · ${role.model || '（未设模型）'}`,
          ),
          button('删除', () => onRemove(index), { disabled }),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } },
          h('div', { style: { flex: '0 0 130px' } }, field('角色 id', text('id', 'scout'))),
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
          h('div', { style: { flex: '0 0 100px' } }, field('思考强度', select('effort', EFFORTS))),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '16px', marginBottom: '8px' } },
          checkbox('readOnly', '只读'),
          checkbox('allowNestedDispatch', '允许再派发'),
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
              field('包裹会话 Provider（LLM route）', text('agentProvider', '留空继承父代理路由', true)),
              field('包裹会话模型（非外部 CLI 模型）', text('agentModel', '留空继承父代理模型', true)),
              h(
                'span',
                { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' } },
                '⚠️ 外部 CLI 会在本机真的执行命令。只读约束由 CLI 自身的沙箱参数实现，插件无法越过 CLI 强制。',
              ),
            )
          : null,
      );
    }

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
      const [draft, setDraft] = useState(null);
      const [status, setStatus] = useState('loading');
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);
      // 读取时拿到的 revision 必须留到写回时使用，否则并发保护无从谈起。
      const [revision, setRevision] = useState(undefined);
      const savedRef = useRef(null);

      /** 重新读取本插件的配置。 */
      const refresh = useCallback(() => {
        if (store === undefined || typeof store.read !== 'function') {
          setStatus('error:未取到插件操作回调（插件的 apply 未注入 store）');
          return;
        }
        setStatus('loading');
        void store.read().then((result) => {
          if (!result.ok) {
            // 读取失败必须如实显示：静默当作空会把用户配置「藏起来」。
            setDraft([]);
            savedRef.current = JSON.stringify([]);
            setRevision(undefined);
            setStatus(`error:${result.error}`);
            return;
          }
          setDraft(cloneRoles(result.roles));
          savedRef.current = JSON.stringify(result.roles);
          // revision 用于并发保护：写回时必须带上读取时的那一个。
          setRevision(result.revision);
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
      const dirty = draft !== null && JSON.stringify(roles) !== savedRef.current;

      /** 改某一行。 */
      const changeRole = (index, next) =>
        setDraft((prev) => {
          const copy = cloneRoles(prev ?? []);
          copy[index] = next;
          return copy;
        });

      /** 删某一行。 */
      const removeRole = (index) => setDraft((prev) => (prev ?? []).filter((_, i) => i !== index));

      /** 追加一行空白角色（只改本地草稿，保存时统一写）。 */
      const addRole = () =>
        setDraft((prev) => [
          ...(prev ?? []),
          {
            id: '',
            description: '',
            instructions: '',
            backend: 'spawn',
            model: '',
            effort: 'medium',
            readOnly: false,
            allowNestedDispatch: false,
          },
        ]);

      /**
       * 校验草稿是否可提交。
       *
       * 直接复用模块作用域的 `validateRoles`，其实现与 `src/client/logic.js`
       * 逐字一致（有断言锁定）。
       *
       * @returns {string|null} 错误信息，或 null 表示通过。
       */
      const validate = () => validateRoles(roles);

      /** 保存角色列表。 */
      const save = async () => {
        if (store === undefined || typeof store.write !== 'function' || busy) return;
        const problem = validate();
        if (problem) {
          setNotice({ kind: 'error', text: problem });
          return;
        }
        setBusy(true);
        // 角色是变长数组，整体提交语义明确 —— 不必算易错的逐字段 diff。
        const result = await store.write(roles, revision);
        setBusy(false);
        if (result.ok) {
          savedRef.current = JSON.stringify(roles);
          setNotice({
            kind: 'ok',
            text: `已保存 ${roles.length} 个角色。选中 Switchboard preset 的新会话会使用它们。`,
          });
          refresh();
        } else {
          setNotice({ kind: 'error', text: `保存失败：${result.message}` });
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
        button('新增角色', addRole, { disabled: busy || draft === null }),
        button(dirty ? '保存 *' : '保存', save, { disabled: busy || !dirty, primary: dirty }),
        button('放弃改动', refresh, { disabled: busy || !dirty }),
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
                        ? 'var(--dsw-alias-label-error, var(--dsw-alias-label-secondary))'
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
      if (status.startsWith('error:')) {
        // 读取失败必须显式呈现原因，而不是显示成「尚未配置」——后者会让用户以为配置丢了。
        // ⚠️ 这里只显示 `fetchRoles` 给出的**具体**原因，不再附一句猜测性的通用建议：
        //    曾经写死「这通常是配置文件损坏」，而真实原因是远程通道取不到，把排查方向
        //    完全带偏（实测教训）。宁可少说，也不要说不符合实际的话。
        return wrap(
          h(
            'div',
            { style: { color: 'var(--dsw-alias-label-error, var(--dsw-alias-label-secondary))' } },
            `读取角色配置失败：${status.slice('error:'.length)}`,
            h('br'),
            '点「放弃改动」可重试。',
          ),
        );
      }
      if (roles.length === 0) {
        return wrap(
          h(
            'div',
            { style: { color: 'var(--dsw-alias-label-secondary)' } },
            status === 'missing'
              ? '尚未配置任何角色。点「新增角色」开始；每个角色会变成主代理可用的一个委派工具。'
              : '角色列表为空。点「新增角色」开始。',
          ),
        );
      }
      return wrap(
        h(
          'div',
          null,
          roles.map((role, index) =>
            h(RoleRow, {
              key: `${role.id || 'new'}-${index}`,
              role,
              index,
              onChange: changeRole,
              onRemove: removeRole,
              disabled: busy,
            }),
          ),
        ),
      );
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
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              // 用自己的 id：新 id 会与既有条目并列，复用已占用的 id 会**替换**该格。
              id: 'agent-switchboard',
              order: 25,
              label: '角色与派发',
              inject: () => ({ store }),
            },
            SwitchboardSettings,
          ),
        );
      },
    };
  },
});
