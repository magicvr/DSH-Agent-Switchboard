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
 * 4. 读写配置走 `ctx.configForms` 与 `ctx.remote.settings`，不自行发明机制。
 *
 * ## 为什么用 `remote.settings.mutate` 而不是页面自带的 `form.set`
 *
 * 两者最终都过 `SettingsForms.write` 的 `isVolatilePath` 校验，因此**前提相同**：
 * Host 的 `roles` 必须标 `.volatile()`（已标，且有回归测试锁定）。
 * 选 `mutate` 是因为它能**一次提交多条路径操作**，从而把多处改动做成一次原子写入，
 * 并显式携带 `revision` 避免覆盖并发改动。这也是官方
 * `dsh-client-ui-permission-presets` 的写法。
 *
 * ## 本文件刻意保持「不信任输入」的姿态
 *
 * 任何读取失败都降级为可读提示，而不是抛错；渲染路径里不抛异常。
 * 一个显示不出内容的设置页是可接受的，一个让 slot 崩掉的设置页不是。
 */

/**
 * 配置命名空间的**候选**列表，按可能性排序。
 *
 * ⚠️ 为什么不写死一个：`ns` 是「profile entry id」这一事实来自文档，但确切取值由
 * 运行时决定。实测踩过：设置页读不到值（显示 `empty(form:unavailable)`），而无法从
 * 外部核对该值对不对。把已知两种形态都试一遍、并用「值里有没有 `roles`」来确认，
 * 比猜一个然后失败得莫名其妙可靠。
 *
 * 首选短的：`settings.describe()` 行的 `ns` 取的是 `entry.options.id`，
 * 而插件管理器显示的 `include:agent-switchboard` 是展示层的组合形式。
 */
const NS_CANDIDATES = ['agent-switchboard', 'include:agent-switchboard'];

/** 后端取值，与 Host 的 `z.union(['spawn', 'fork', 'cli'])` 保持一致。 */
const BACKENDS = ['spawn', 'fork', 'cli'];

/** 思考强度取值，与 Host 的 `EFFORT_VALUES` 保持一致。 */
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
     * 找出「值里含 roles 数组」的命名空间。
     *
     * ⚠️ 为什么不做成单一常量、也不只按名字匹配：
     *
     * 本插件会被**激活多次** —— profile 级的根条目一次（无 config），每个选中
     * `Switchboard` preset 的会话作用域再一次（带 roles）。而设置页面对的是
     * **根条目**那个命名空间，它的值里 `roles` 为空数组。若只认名字，读到的永远
     * 是那份空的，于是页面显示「尚未配置任何角色」——这正是实测踩到的现象
     * （命名空间对、表单 status 为 ready、但值里没有 roles）。
     *
     * 因此判据改为「**按值识别**」：遍历 `describe()` 报告的全部命名空间，挑出
     * 值里含 `roles` 数组的那些，并优先返回非空的。这样无论最终生效的是哪一个
     * 命名空间，都能找到真正的角色列表。
     *
     * 两条读取路径也互为兜底，因为首帧可用性取决于镜像是否已 `ensure()`。
     *
     * @param {object} ctx - Client 插件上下文。
     * @returns {{ns: string, roles: object[], volatile: object, revision: number|undefined, source: string, seen: string}} 读取结果。
     */
    function readState(ctx) {
      const tried = [];
      /** 命中的候选：{ns, roles, volatile, revision, source}。按 roles 长度择优选。 */
      const hits = [];

      // 读取单个命名空间的值（两条路径）。
      const valueOf = (ns) => {
        try {
          const snap = ctx.configForms.get(ns).getSnapshot();
          tried.push(`${ns}:form:${snap?.status ?? '?'}`);
          if (snap?.value) return { value: snap.value, revision: snap.revision, source: 'form' };
        } catch (error) {
          tried.push(`${ns}:form-threw:${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          const row = ctx.configForms.describe().namespace(ns);
          tried.push(`${ns}:mirror:${row === undefined ? 'absent' : 'present'}`);
          if (row?.value) return { value: row.value, revision: row.revision, source: 'mirror' };
        } catch (error) {
          tried.push(`${ns}:mirror-threw:${error instanceof Error ? error.message : String(error)}`);
        }
        return undefined;
      };

      // 候选命名空间 = 已知的两个 + describe() 报告的全部（可能含作用域变体）。
      const names = new Set(NS_CANDIDATES);
      try {
        const snap = ctx.configForms.describe().getSnapshot();
        for (const row of snap?.view?.namespaces ?? []) {
          if (typeof row?.ns === 'string') names.add(row.ns);
        }
      } catch (error) {
        tried.push(`enumerate-threw:${error instanceof Error ? error.message : String(error)}`);
      }

      for (const ns of names) {
        const got = valueOf(ns);
        if (!got) continue;
        if (Array.isArray(got.value.roles)) {
          hits.push({
            ns,
            roles: got.value.roles,
            volatile: got.value.volatile ?? {},
            revision: got.revision,
            source: got.source,
          });
        } else if (/switchboard|agent-switchboard/.test(ns)) {
          // 与插件相关但值里没有 roles：记下来，便于诊断（这是实测踩到的那种情况）。
          tried.push(`${ns}:no-roles(${Object.keys(got.value).join(',') || 'empty'})`);
        }
      }

      // 优先非空；全为空时返回空的那个（界面会显示「尚未配置」+ 诊断）。
      const best = hits.find((hit) => hit.roles.length > 0) ?? hits[0];
      if (best) return { ...best, seen: tried.join(' ') };
      return {
        ns: NS_CANDIDATES[0],
        roles: [],
        volatile: {},
        revision: undefined,
        source: tried.join(' '),
        seen: tried.join(' '),
      };
    }

    /**
     * 把一串路径操作提交到 Host。
     *
     * @param {object} ctx - Client 插件上下文。
     * @param {string} ns - 已确认可用的命名空间（由 `readState` 解析得出）。
     * @param {Array<object>} ops - `{op:'set', path, value}` 或 `{op:'unset', path}`。
     * @param {number|undefined} revision - 读取时拿到的 revision，用于并发保护。
     * @returns {Promise<{ok: boolean, message: string}>} 结果。
     */
    async function submit(ctx, ns, ops, revision) {
      try {
        const response = await ctx.remote.settings.mutate(ns, ops, revision);
        // 远程方法把失败包在 envelope 里（`{ ok: false, error }`），不抛异常。
        if (response && response.ok === false) {
          const err = response.error;
          return { ok: false, message: String(err?.message ?? err ?? '未知错误') };
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
                '⚠️ 还需在下面的总开关里打开 allowCrossCli，否则该角色既不注册 provider 也不挂载工具。',
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
      const [revision, setRevision] = useState(undefined);
      const [ns, setNs] = useState(NS_CANDIDATES[0]);
      const [status, setStatus] = useState('loading');
      const [seen, setSeen] = useState('');
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);
      const [allowCrossCli, setAllowCrossCli] = useState(false);
      const savedRef = useRef(null);

      /** 从 Host 重新读取。 */
      const refresh = useCallback(() => {
        if (!ctx) {
          setStatus('no-context');
          return;
        }
        const state = readState(ctx);
        setDraft(cloneRoles(state.roles));
        setRevision(state.revision);
        setNs(state.ns);
        setSeen(state.seen ?? state.source ?? '');
        setAllowCrossCli(state.volatile?.allowCrossCli === true);
        savedRef.current = JSON.stringify(state.roles);
        setStatus(state.roles.length > 0 ? 'ready' : `empty(${state.source})`);
      }, [ctx]);

      // 首次挂载 + 订阅镜像变化。订阅是必要的：`ensure()` 是异步的，首帧往往读不到值。
      useEffect(() => {
        if (!ctx) return undefined;
        refresh();
        const disposers = [];
        try {
          const mirror = ctx.configForms.describe();
          if (typeof mirror.subscribe === 'function') disposers.push(mirror.subscribe(() => refresh()));
          if (typeof mirror.ensure === 'function') void mirror.ensure();
        } catch {
          /* 订阅失败只是失去自动刷新，页面本身仍可用 */
        }
        return () => {
          for (const d of disposers) {
            try {
              if (typeof d === 'function') d();
            } catch {
              /* 释放失败不影响其它订阅 */
            }
          }
        };
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
        // 角色是变长数组：整块 set 语义明确，不必算易错的逐字段 diff。
        const result = await submit(ctx, ns, [{ op: 'set', path: ['roles'], value: roles }], revision);
        setBusy(false);
        if (result.ok) {
          savedRef.current = JSON.stringify(roles);
          setNotice({ kind: 'ok', text: '已保存。角色变更实时生效，无需重载插件。' });
          refresh();
        } else {
          setNotice({ kind: 'error', text: `保存失败：${result.message}` });
        }
      };

      /** 切换跨 CLI 总开关。 */
      const toggleCrossCli = async (next) => {
        if (!ctx || busy) return;
        setBusy(true);
        const result = await submit(
          ctx,
          ns,
          [{ op: 'set', path: ['volatile', 'allowCrossCli'], value: next }],
          revision,
        );
        setBusy(false);
        setAllowCrossCli(next);
        setNotice(
          result.ok
            ? { kind: 'ok', text: `已${next ? '开启' : '关闭'}跨 CLI 派发。` }
            : { kind: 'error', text: `开关写入失败：${result.message}` },
        );
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

      const switchRow = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            paddingTop: '8px',
            borderTop: '1px solid var(--dsw-alias-border-l2)',
          },
        },
        h('input', {
          type: 'checkbox',
          checked: allowCrossCli,
          disabled: busy,
          onChange: (e) => void toggleCrossCli(e.target.checked),
        }),
        h('span', { style: { fontSize: '12px' } }, '允许跨 CLI 派发（allowCrossCli）'),
        h(
          'span',
          { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
          '开启后，设为「外部 CLI」的角色才会注册 provider 并挂载工具。此开关会在本机执行外部命令。',
        ),
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
          switchRow,
        );

      if (status === 'no-context') {
        return wrap(h('div', null, '无法取得插件上下文，设置页不可用。'));
      }
      if (draft === null) {
        return wrap(h('div', null, '正在读取配置…'));
      }
      if (roles.length === 0) {
        return wrap(
          h(
            'div',
            { style: { color: 'var(--dsw-alias-label-secondary)' } },
            '尚未配置任何角色。点「新增角色」开始；每个角色会变成主代理可用的一个委派工具。',
            // ⚠️ 始终显示读取源：如果这次仍然读不到，这行就是唯一的线索。
            //    实测踩过「页面显示空、但没有任何可诊断信息」，只能靠重启去查，
            //    因此把诊断直接放到界面上。
            h(
              'div',
              {
                style: {
                  marginTop: '6px',
                  fontSize: '10px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  opacity: 0.75,
                  wordBreak: 'break-all',
                },
              },
              `读取源：${status}`,
            ),
            // 已解析到的命名空间与「看到了什么」一并显示。
            // 实测教训：只显示「读取源」不够 —— 有一次命名空间对、status 为 ready、
            // 但值里没有 roles，没有这几行就只能靠重启去查。
            h(
              'div',
              {
                style: {
                  marginTop: '2px',
                  fontSize: '10px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  opacity: 0.75,
                  wordBreak: 'break-all',
                },
              },
              `命名空间：${ns}（候选：${NS_CANDIDATES.join(' | ')}）`,
            ),
            h(
              'div',
              {
                style: {
                  marginTop: '2px',
                  fontSize: '10px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  opacity: 0.6,
                  wordBreak: 'break-all',
                },
              },
              `探到的命名空间与结果：${seen || '（无）'}`,
            ),
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
      inject: ['slots', 'configForms', 'remote.settings'],
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
