/**
 * Agent Switchboard 的 Client 半边。
 *
 * **本半边目前不贡献任何 UI。**
 *
 * 为什么不删掉它、而是留一个空壳：
 *   `package.json` 声明了 `dsh.client`（含 `inject: ['@deepseek-ai/dsh-client-ui-conversation']`），
 *   浏览器产物因此仍须调用 `window.__ModuleLoader__.load(...)` 并完成注册，否则 DSH 会报
 *   `loaded without registering "<id>"`。删掉文件或让 id 对不上都会引入装载错误。
 *
 * 原先这里会在 `conversation.composer.dock` 注册一个只读状态条（输入框下方的
 * 「Switchboard · phase 1」小圆点）。它已被移除，理由是：
 *   1. 那是 Phase 1 用来**验证 Client 半边注册成功**的脚手架，不是产品功能；
 *   2. DSH **原生就有**子代理展示位（`conversation.session.header.lineage` 血缘、
 *      `subagent-catalog` 操作入口、`sidebar.right.pane.tab` 子代理会话面板），
 *      插件再塞一个指示器属于重复实现；
 *   3. 它显示的信息（固定文本）没有任何诊断价值。
 *   诊断信息现在只走 `switchboard_selftest` 工具与插件设置页。
 *
 * 若将来要加真正的 UI，请先读 docs/architecture.md 第 3 节与
 * `references/ui-plugin.md` 的约束，并注意：
 *   - 禁止 import 任何 Harness Client 包；
 *   - 只用 `--dsw-alias-*` 主题 token；
 *   - 不碰 app root / document.body / 别的插件 DOM；
 *   - Client 半边抛错会让整个 slot 空掉（`slot entry crashed in '<slot>'`）。
 */
window.__ModuleLoader__.load({
  id: '@magicvr/dsh-agent-switchboard',
  factory() {
    return {
      // 不注册任何 slot。保留 `slots` 注入以便日后扩展，且它不影响本半边的注册。
      inject: ['slots'],
      apply() {},
    };
  },
});
