/**
 * Agent Switchboard 的 Client 半边。
 *
 * 硬性约束（已核实，见 docs/architecture.md 第 3 节）：
 *   1. 必须是单文件，并调用 `window.__ModuleLoader__.load(...)`；
 *   2. `id` 必须**严格等于包名**，否则 DSH 报 `loaded without registering "<id>"`；
 *   3. **禁止 import 任何 Harness Client 包**——它们随时会变，且 Client 半边崩溃会让
 *      整个 slot 空掉（`slot entry crashed in '<slot>'`）；
 *   4. 只能使用 `--dsw-alias-*` 主题 token，不碰 app root / document.body / 别人的 DOM。
 *
 * Phase 1 只做只读状态指示：官方 decoration 模板与 `conversation.composer.dock`
 * 的实时 Slot 树均已核实该 slot 存在、`kind` 为 `list`、`id` 是区分键。
 */
window.__ModuleLoader__.load({
  id: '@magicvr/dsh-agent-switchboard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * 只读状态条。刻意保持最小：一段文本 + 一个状态点。
     * 不注册任何事件、不发任何请求，因此不可能拖垮所在 slot。
     */
    function SwitchboardStatus() {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '11px',
            lineHeight: '16px',
            color: 'var(--dsw-alias-label-secondary)',
            userSelect: 'none',
            pointerEvents: 'none',
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            flex: '0 0 auto',
            // Phase 1 尚未接入配置，故用 idle 色表示「未启用跨 CLI」。
            background: 'var(--dsw-alias-state-idle-primary)',
          },
        }),
        h('span', null, 'Switchboard · phase 1'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              // 用自己的 id，避免占用 shipped 的条目（该 slot 现有条目 id 为 `stats`）。
              id: 'agent-switchboard',
              order: 5,
              label: 'Agent Switchboard',
            },
            SwitchboardStatus,
          ),
        );
      },
    };
  },
});
