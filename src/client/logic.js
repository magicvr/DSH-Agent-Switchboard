/**
 * Client 半边的纯逻辑，**唯一权威来源**。
 *
 * 为什么单独放一个模块：Client 半边必须是自包含的单文件（`window.__ModuleLoader__`
 * 的 `factory` 里不能 import），因此它的代码无法被直接单测。这里把纯逻辑抽出来供
 * `scripts/check-client.mjs` 测试，并在同一个脚本里断言
 * **`src/client/index.js` 确实内联了逐字相同的实现** —— 否则抽出逻辑反而制造了
 * 两份会漂移的真相。
 *
 * 本模块不含任何 DOM / React / DSH 依赖，因此可以在 Node 里直接跑。
 */

/** 后端取值，必须与 Host 的 `z.union(['spawn', 'cli'])` 一致。 */
export const BACKENDS = ['spawn', 'cli'];

/** 思考强度取值，必须与 Host 的 `EFFORT_VALUES` 一致。 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 解析一个 JSON 字符串数组。
 *
 * 非法输入**返回 `undefined`**（而不是抛错或返回空数组）：调用方据此保留用户
 * 上一次的有效值，避免在用户打字中途把参数模板清空。
 *
 * @param {string} raw - 用户输入。
 * @returns {string[]|undefined} 解析结果，或 undefined 表示输入尚不合法。
 */
export function parseJsonArray(raw) {
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
 * 这是「UI 只给出合法值」之外的第二道防线：Host 侧的 `normalizeRole` 在装载期
 * 仍会独立校验一遍，UI 不该是唯一校验。但两边的**规则必须一致**，否则用户会遇到
 * 「界面说没问题、保存后被 Host 拒掉」这种最令人困惑的失败。
 *
 * @param {object[]} roles - 角色草稿。
 * @returns {string|null} 可读的错误信息，或 null 表示通过。
 */
export function validateRoles(roles) {
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
 * 外部 CLI 自报路由事实的键。
 *
 * ⚠️ 必须与 Host 的 `src/cli/output.js` 的 `ROUTE_FACT_KEYS` **逐项一致**。
 * 这份镜像的唯一用途：把 stderr 折叠成「过程与诊断」之后，仍能把
 * 「CLI 真的接受了本次模型/沙箱/强度参数」这一行证据**始终**显示在折叠区之外。
 * `scripts/check-client.mjs` 有键表与行为两重漂移断言锁定它。
 */
export const CLI_ROUTE_FACT_KEYS = [
  'workdir',
  'model',
  'provider',
  'approval',
  'sandbox',
  'reasoning effort',
  'reasoning summary',
];

/**
 * 从 CLI 的 stderr 里抽取路由事实行（Host `parseRouteFacts` 的镜像）。
 *
 * 只在头部有限行数内匹配，避免把正常输出里恰好形如 `model: xxx` 的行误当成事实。
 *
 * @param {string} stderr - 完整 stderr。
 * @param {number} [scanLines] - 扫描的行数上限。
 * @returns {Record<string, string>} 抽到的事实键值；无则空对象。
 */
export function parseCliRouteFacts(stderr, scanLines = 25) {
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
 * 按通道把 CLI 任务的输出片段拆成「正文」与「过程/诊断」。
 *
 * 为什么按**通道**而不是按文本内容判定：codex 非 `--json` 模式下 stdout 只有最终消息，
 * 路由事实与过程/工具轨迹都在 stderr（`docs/cli-backends.md` §2.4 有对照组实测）。
 * 因此「哪些是工具调用噪音」无需猜文本 —— 通道本身就是权威判据，也不会因为某个 CLI
 * 改了措辞而失效。
 *
 * `channel` 缺失按 `stdout` 处理，与 `makeCliStore` 的规范化一致。
 *
 * @param {object[]} chunks - 任务输出片段（`{ text, channel }`）。
 * @returns {{stdout: string, stderr: string}} 两个通道各自的正文。
 */
export function splitCliChannels(chunks) {
  const out = { stdout: '', stderr: '' };
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const text = typeof chunk?.text === 'string' ? chunk.text : '';
    if (text.length === 0) continue;
    if (chunk.channel === 'stderr') out.stderr += text;
    else out.stdout += text;
  }
  return out;
}
