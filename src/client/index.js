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
 * 4. 读写配置走**本插件自己的远程服务** `ctx.remote.roleConfig`（见 `src/config-service.js`），
 *    不经过 `settings` / `configForms`。
 *
 * ## 为什么配置不走 `settings`（关键架构决策，见 decisions.md D13）
 *
 * 角色列表一度放在 profile patch 的 `config.roles` 里。实测发现两条互相冲突的约束：
 *   1. `settings.describe()` 按 `ns` 去重、**只报告根条目**的配置。preset 里的那份插件
 *      声明由 agent-presets 在运行时挂载，不在 `configEditor.entries()` 里，因此设置页
 *      读到的永远是根条目那份**空的** config —— UI 无法配置实际生效的角色。
 *   2. 把 roles 移到根条目就会**污染**：根作用域注册的工具对其他 preset 的会话可见
 *      （实测：一个 `standard` 会话的子代理能看到根注册的 `switchboard_selftest`），
 *      于是所有会话都会冒出一批 `delegate_to_*`。
 *
 * 换成插件自己的文件 + 自己的远程方法后，两条同时解开：
 *   - 配置只经过我们的远程服务，不受 `ns` 去重与 volatile/数组限制；
 *   - 角色工具是否可见，只取决于**本插件在哪个会话作用域被激活**（由 preset 的
 *     `mount: true` 决定），与配置存在哪里无关。
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

/** 后端的中文说明（仅用于展示）。 */
const BACKEND_LABEL = {
  spawn: '内置 · spawn（独立上下文）',
  fork: '内置 · fork（继承上下文）',
  cli: '外部 CLI（本机命令）',
};

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
    if (r.backend === 'cli') {
      if (!r.cliCommand) return `${at}：CLI 后端需要「命令」`;
      if (!Array.isArray(r.cliArgs) || r.cliArgs.length === 0) return `${at}：CLI 后端需要参数模板`;
      if (!r.cliPromptDelivery) return `${at}：CLI 后端需要提示词传递方式`;
    } else if (!r.provider) {
      return `${at}：内置后端需要 provider（可留空以使用顶层默认值）`;
    }
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
     * 取 settings 远程通道。
     *
     * ⚠️ **必须从插件 ctx 取，不能从 slot 的 props.ctx 取**。`remote.settings` 是
     * `dsh-api-settings-controller` 生成的命名空间，挂在客户端根上下文上；slot 注入的
     * ctx 看不到它 —— 实测现象就是界面报「settings 服务尚未就绪」。
     *
     * 本插件因此把 `remote.settings` 写进了 `inject`（官方 `ui-settings-general` 也是
     * 这么做的，见其 client.js 的 `inject = [..., "remote.settings"]`）。它与之前失败的
     * `remote.roleConfig` 有本质区别：**前者由内核插件提供、每次启动都在**；后者是我们
     * 自己延迟注册的，因此会被声明成必需依赖后永远等不到。
     *
     * 这里仍做一次运行时检查而不是直接点属性：取不到时给界面一句可读诊断，比抛错好。
     *
     * @param {object} ctx - Client 插件上下文（**不是** slot props 里的那个）。
     * @returns {object|undefined} settings 远程命名空间，未就绪时返回 undefined。
     */
    function settingsChannel(ctx) {
      try {
        return ctx?.remote?.settings;
      } catch {
        return undefined;
      }
    }

    /**
     * 读出本插件的配置快照（含 roles）。
     *
     * @param {object} ctx - Client 插件上下文。
     * @returns {Promise<{ok: boolean, roles: object[], revision?: number, missing?: boolean, error?: string}>} 读取结果。
     */
    async function fetchRoles(ctx) {
      const channel = settingsChannel(ctx);
      if (channel === undefined || typeof channel.describe !== 'function') {
        return {
          ok: false,
          roles: [],
          // 这条文案必须与真实原因一致：不是「配置文件损坏」，而是**远程通道没取到**。
          // 两者混淆过一次，让排查方向完全跑偏（实测教训）。
          error:
            '取不到 remote.settings 通道（这不是配置文件的问题）。' +
            '请确认 @deepseek-ai/dsh-api-settings-controller 已启用，然后重启应用。',
        };
      }
      try {
        const rows = await channel.describe();
        const row = (Array.isArray(rows) ? rows : []).find((r) => r?.ns === CONFIG_NS);
        if (row === undefined) {
          return {
            ok: false,
            roles: [],
            error: `找不到本插件的配置行（ns=${CONFIG_NS}）。若插件条目被禁用，请先启用。`,
          };
        }
        const roles = Array.isArray(row.value?.roles) ? row.value.roles : [];
        return { ok: true, roles, revision: row.revision, missing: roles.length === 0 };
      } catch (error) {
        return { ok: false, roles: [], error: error instanceof Error ? error.message : String(error) };
      }
    }

    /**
     * 写入角色到本插件配置。
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
    async function saveRoles(ctx, roles, revision) {
      const channel = settingsChannel(ctx);
      if (channel === undefined || typeof channel.mutate !== 'function') {
        return { ok: false, message: 'settings 服务尚未就绪，无法保存。' };
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

    /** 复制一份角色数组，避免直接改读到快照里的对象。 */
    const cloneRoles = (roles) => roles.map((r) => ({ ...r }));

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

      /** 改本行某个字段。 */
      const set = (key, value) => onChange(index, { ...role, [key]: value });

      /** 带标签的字段容器。 */
      const field = (label, control) =>
        h(
          'label',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px' } },
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
          control,
        );

      /** 统一样式的文本输入。 */
      const text = (key, placeholder) =>
        h('input', {
          type: 'text',
          value: role[key] ?? '',
          placeholder,
          disabled,
          onChange: (e) => set(key, e.target.value),
          style: {
            width: '100%',
            boxSizing: 'border-box',
            padding: '3px 6px',
            fontSize: '12px',
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-base)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '4px',
          },
        });

      /** 统一样式的下拉。 */
      const select = (key, options, labels) =>
        h(
          'select',
          {
            value: role[key] ?? options[0],
            disabled,
            onChange: (e) => set(key, e.target.value),
            style: {
              width: '100%',
              padding: '3px 6px',
              fontSize: '12px',
              color: 'var(--dsw-alias-label-primary)',
              background: 'var(--dsw-alias-bg-base)',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '4px',
            },
          },
          options.map((o) => h('option', { key: o, value: o }, labels ? labels[o] ?? o : o)),
        );

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
            onChange: (e) => set(key, e.target.checked),
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
            field('派发机制', select('backend', BACKENDS, BACKEND_LABEL)),
          ),
          h('div', { style: { flex: '1 1 150px' } }, field('模型', text('model', 'gpt-6-luna'))),
          h('div', { style: { flex: '0 0 100px' } }, field('思考强度', select('effort', EFFORTS))),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '16px', marginBottom: '8px' } },
          checkbox('readOnly', '只读'),
          checkbox('allowNestedDispatch', '允许再派发'),
        ),
        field('描述（主代理据此判断何时派给谁）', text('description', '这个角色负责什么')),
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
                '外部 CLI 参数（占位符：{prompt} / {cwd} / {model} / {effort}）',
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                h('div', { style: { flex: '0 0 120px' } }, field('命令', text('cliCommand', 'node'))),
                h(
                  'div',
                  { style: { flex: '0 0 150px' } },
                  field('提示词传递', select('cliPromptDelivery', ['stdin', 'argv'])),
                ),
                h(
                  'div',
                  { style: { flex: '1 1 240px' } },
                  field('工作目录', text('cliCwd', 'C:\\path\\to\\workspace')),
                ),
              ),
              field(
                '前缀参数（JSON 字符串数组）',
                h('textarea', {
                  rows: 2,
                  value: JSON.stringify(role.cliPrefixArgs ?? []),
                  disabled,
                  onChange: (e) => {
                    const parsed = parseJsonArray(e.target.value);
                    if (parsed !== undefined) set('cliPrefixArgs', parsed);
                  },
                  style: monoStyle(),
                }),
              ),
              field(
                '参数模板（JSON 字符串数组）',
                h('textarea', {
                  rows: 3,
                  value: JSON.stringify(role.cliArgs ?? []),
                  disabled,
                  onChange: (e) => {
                    const parsed = parseJsonArray(e.target.value);
                    if (parsed !== undefined) set('cliArgs', parsed);
                  },
                  style: monoStyle(),
                }),
              ),
              h(
                'span',
                { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' } },
                '⚠️ 外部 CLI 会在本机真的执行命令。只读约束由 CLI 自身的沙箱参数实现（例如 codex 的 -s read-only），插件无法越过 CLI 强制。',
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
      const ctx = props.ctx ?? props.context;
      const [draft, setDraft] = useState(null);
      const [status, setStatus] = useState('loading');
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);
      // 读取时拿到的 revision 必须留到写回时使用，否则并发保护无从谈起。
      const [revision, setRevision] = useState(undefined);
      const savedRef = useRef(null);

      /** 重新读取本插件的配置。 */
      const refresh = useCallback(() => {
        if (!ctx) {
          setStatus('no-context');
          return;
        }
        setStatus('loading');
        void fetchRoles(ctx).then((result) => {
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
      }, [ctx]);

      // 首次挂载时读取一次。这里**不订阅** configForms 镜像：我们的可写通道是
      // `settings` 远程服务，订阅镜像只会带来无关的重渲染。外部改动由「放弃改动」按钮刷新。
      useEffect(() => {
        if (!ctx) return undefined;
        refresh();
        return undefined;
      }, [ctx, refresh]);

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
        if (!ctx || busy) return;
        const problem = validate();
        if (problem) {
          setNotice({ kind: 'error', text: problem });
          return;
        }
        setBusy(true);
        // 角色是变长数组，整体提交语义明确 —— 不必算易错的逐字段 diff。
        const result = await saveRoles(ctx, roles, revision);
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
      // `remote.settings` 由内核插件 `dsh-api-settings-controller` 提供，客户端每次启动
      // 都有；官方 `ui-settings-general` 同样把它写进 inject（见其 client.js）。
      // 它是**唯一**能让 UI 写入角色数据的通道：客户端没有写文件的能力
      // （`workspaceFiles` 只有 read/stat/list），而外部插件无法新增自己的远程命名空间
      // （客户端只装载构建期生成的静态贡献清单，且没有 Proxy）。
      //
      // ⚠️ 只声明真正必需且**由内核保证**的依赖。曾经声明的 `remote.roleConfig` 是我们
      //    自己延迟注册的服务，声明成必需依赖后客户端永远 pending，整页起不来
      //    （`web boot: 1 entry did not activate`）。不要把那种东西放进 inject。
      inject: ['slots', 'remote.settings'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              // 用自己的 id：新 id 会与既有条目并列，复用已占用的 id 会**替换**该格。
              id: 'agent-switchboard',
              order: 25,
              label: '角色与派发',
              inject: () => ({ ctx }),
            },
            SwitchboardSettings,
          ),
        );
      },
    };
  },
});
