/**
 * CLI 参数模板解析。
 *
 * 安全约束（对应 AGENTS.md 硬规则 4）：
 *   - 可执行文件与参数模板**全部来自用户配置**，模型只能填充受限占位符。
 *   - 替换**始终发生在单个 argv 元素内部**，绝不跨元素拼接，也绝不引入 shell。
 *   - 占位符值里出现换行 / NUL 会被拒绝：这类值可能被下游 CLI 当作多行参数解析，
 *     属于「单元素内逃逸」的少数真实途径，宁可报错也不放行。
 *
 * 本模块不 import 任何 DSH 运行时，因此可在 Node 里直接单测
 * （Host 半边在 link 安装下不能热加载，见 docs/architecture.md 3.3）。
 *
 * @module @magicvr/dsh-agent-switchboard/cli/argv
 */

/**
 * 支持的占位符。
 *
 * 刻意只支持这几个：每个都对应一个由配置或调度层提供、模型无法伪造的值。
 */
export const PLACEHOLDERS = Object.freeze(['prompt', 'cwd', 'model', 'effort']);

/** 占位符值的禁令：换行与 NUL 会破坏「单元素」这一前提。 */
const FORBIDDEN_IN_VALUE = /[\n\r\0]/;

/**
 * 检查一个待替换值是否安全。
 *
 * @param {string} name - 占位符名。
 * @param {string} value - 待填入的值。
 * @returns {string | null} 不安全时返回原因，安全时返回 null。
 */
function unsafeReason(name, value) {
  if (typeof value !== 'string') return `占位符 {${name}} 的值不是字符串`;
  if (FORBIDDEN_IN_VALUE.test(value)) {
    return `占位符 {${name}} 的值含换行或 NUL —— 会破坏「单 argv 元素」前提`;
  }
  return null;
}

/**
 * 找出模板里出现的、不受支持的占位符名。
 *
 * 拼错占位符（例如 `{modle}`）如果被静默当作普通文本，就会把字面量
 * `{modle}` 传给 CLI，产生难以定位的怪行为。因此这里主动报错。
 *
 * @param {readonly string[]} template - 参数模板。
 * @returns {string[]} 不受支持的占位符名（去重）。
 */
export function findUnknownPlaceholders(template) {
  const unknown = new Set();
  for (const element of template) {
    if (typeof element !== 'string') continue;
    for (const match of element.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      const name = match[1];
      if (!PLACEHOLDERS.includes(name)) unknown.add(name);
    }
  }
  return [...unknown];
}

/**
 * 提示词的传送方式。
 *
 * `stdin` 是**首选**：提示词不进入命令行，因此不受命令行长度限制、不参与任何
 * 参数解析、也不可能被误当成选项。实测 `codex exec -` 即从此路径读取。
 *
 * `argv` 仅在某个 CLI 不支持从 stdin 读取时才使用，此时模板必须含 `{prompt}`。
 */
export const PROMPT_DELIVERY = Object.freeze(['stdin', 'argv']);

/**
 * 校验参数模板本身是否可用（与具体取值无关）。
 *
 * @param {unknown} template - 候选模板。
 * @param {object} [options] - 校验选项。
 * @param {'stdin'|'argv'} [options.promptDelivery] - 提示词传送方式，默认 stdin。
 * @returns {string[]} 错误列表；空数组表示合法。
 */
export function validateTemplate(template, { promptDelivery = 'stdin' } = {}) {
  const errors = [];
  if (!PROMPT_DELIVERY.includes(promptDelivery)) {
    errors.push(`promptDelivery "${promptDelivery}" 非法：只能是 ${PROMPT_DELIVERY.join(' / ')}`);
  }
  if (!Array.isArray(template)) return [...errors, 'args 必须是字符串数组'];
  template.forEach((element, index) => {
    if (typeof element !== 'string') errors.push(`args[${index}] 必须是字符串`);
  });
  if (errors.length > 0) return errors;

  for (const name of findUnknownPlaceholders(template)) {
    errors.push(
      `args 里出现不支持的占位符 {${name}}：只支持 ${PLACEHOLDERS.map((p) => `{${p}}`).join(' / ')}`,
    );
  }

  const hasPromptPlaceholder = template.some((element) => element.includes('{prompt}'));
  if (promptDelivery === 'argv' && !hasPromptPlaceholder) {
    errors.push('promptDelivery 为 argv 时，args 必须包含 {prompt}');
  }
  if (promptDelivery === 'stdin' && hasPromptPlaceholder) {
    // 不算错误，但值得提示：两种方式同时存在会让提示词被传两次。
    errors.push('promptDelivery 为 stdin 时，args 不应包含 {prompt}（提示词会被传两次）');
  }
  return errors;
}

/**
 * 用给定值替换模板里的占位符，产出**可直接传给 spawn 的 argv 片段**。
 *
 * 替换规则：
 *   - 只在单个元素内部替换，元素之间永不合并；
 *   - 值缺失（undefined）时把该占位符替换为空串；
 *   - **替换后为空串的元素被丢弃**，这样 `['-p', '{prompt}']` 在提示词走 stdin
 *     而 prompt 为空时不会留下一个多余的 `-p`；
 *   - 值含换行 / NUL 时抛错。
 *
 * @param {readonly string[]} template - 已校验的参数模板。
 * @param {Record<string, string | undefined>} values - 占位符取值。
 * @returns {string[]} 替换后的 argv 片段。
 * @throws {Error} 模板或取值不合法时。
 */
export function buildArgs(template, values) {
  for (const name of findUnknownPlaceholders(template)) {
    throw new Error(`不支持的占位符 {${name}}`);
  }
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const reason = unsafeReason(name, value);
    if (reason) throw new Error(reason);
  }

  const out = [];
  for (const element of template) {
    const replaced = element.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => values[name] ?? '');
    // 空的 argv 元素没有意义，而且部分 CLI 会把空串当作一个真实参数处理。
    if (replaced.length > 0) out.push(replaced);
  }
  return out;
}

/**
 * 把模板与取值拼成一次完整调用。
 *
 * ⚠️ **不在这里做任何字符串拼接**：返回的是「命令 + argv 数组」两部分，
 * 调用方必须用数组形式 spawn（`shell: false`），不要join 成字符串。
 *
 * @param {object} spec - 调用规格。
 * @param {string} spec.command - 可执行文件路径或命令名（来自用户配置）。
 * @param {string[]} [spec.prefixArgs] - 命令与模板之间的固定参数
 *   （例如 codex 需要的 `node <cli.js>` 形态里，`prefixArgs` 放脚本路径）。
 * @param {readonly string[]} spec.args - 参数模板。
 * @param {Record<string, string | undefined>} spec.values - 占位符取值。
 * @returns {{ command: string, argv: string[] }} 可直接 spawn 的二元组。
 */
export function buildInvocation({ command, prefixArgs = [], args, values }) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error('command 必须是非空字符串');
  }
  const templated = buildArgs(args, values);
  return { command, argv: [...prefixArgs, ...templated] };
}
