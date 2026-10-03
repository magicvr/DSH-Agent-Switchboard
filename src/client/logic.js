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

/** 后端取值，必须与 Host 的 `z.union(['spawn', 'fork', 'cli'])` 一致。 */
export const BACKENDS = ['spawn', 'fork', 'cli'];

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
