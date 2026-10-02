/**
 * 角色配置的**文件存储**。
 *
 * ## 为什么角色不放在 Cordis 配置里（关键架构决策，见 D13）
 *
 * 本插件的角色列表一度放在 profile patch 的 `config.roles`。但实测发现两条互相冲突的约束：
 *
 * 1. **`settings.describe()` 按 `ns` 去重，只报告根条目的配置。** preset 里的那份插件声明
 *    是 agent-presets 在运行时挂载的，不在 `configEditor.entries()` 里，因此设置页读到的
 *    永远是根条目那份**空的** config —— UI 无法配置实际生效的角色。
 * 2. **把 roles 移到根条目就会污染。** 根作用域注册的工具对其他 preset 的会话可见
 *    （实测：一个 `standard` 会话的子代理能看到根注册的 `switchboard_selftest`），
 *    于是所有会话都会冒出一批 `delegate_to_*`。
 *
 * 换成插件自己的文件后，这两条同时解开：
 *   - 配置不再经过 `settings`，因此不受 `ns` 去重与 volatile/数组限制；
 *   - 角色工具是否可见，只取决于**插件在哪个会话作用域被激活**（即 preset 选择），
 *     与配置存在哪里无关 —— 所以可以做到「配置随处可编辑，工具不外溢」。
 *
 * ## 文件位置与格式
 *
 * 优先 `~/.dsh/agent-switchboard/roles.json`（home 级）。
 *
 * 这个选址有官方先例：`dsh-llm-deepseek` 把自己的索引放在
 * `$DSH_HOME/llm-deepseek/files-v3.json`。**不用** per-profile 的
 * `profiles/<name>/.agent-switchboard/`，因为实测发现 `ctx.profileContext` 只在
 * profile 启动路径存在 —— `dsh-base` 里 settings / config-editor / plugin-manager /
 * hmr 这些行都写成 `disabled: !!js "!ctx.get('profileContext')"`，即 headless / sdk /
 * acp 启动下它是 `undefined`。角色列表是用户级配置，不该只在某个启动形态下可用。
 *
 * 原子写入**自己实现**（见下），不用 `@deepseek-ai/dsh-atomic-write`。
 *
 * 那个包确实存在于 DSH 安装里，而且实现更好（含 Windows 瞬时占用重试）。但它
 * **不在 npm registry 上**（`npm install` 报 `up to date`，即解析不到），因此无法作为
 * peerDependency 装进本仓库；而本仓库的插件是通过 **junction 链接**安装的，
 * Node 会从**仓库**解析依赖，所以运行时也 import 不到它（实测 `ERR_MODULE_NOT_FOUND`）。
 *
 * 结论：与其依赖一个装不上的包，不如自己实现同样的语义 —— 下面补上了 Windows
 * 重试，与官方实现的差别只在「不 fsync」这一条（官方 README 亦明示它不保证
 * crash durability）。
 *
 * 本模块只依赖 `node:fs`，不依赖任何 DSH 运行时服务，因此可在 Node 里离线测试。
 */
import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** 插件在 `$DSH_HOME` 下的私有目录名。 */
export const CONFIG_DIR_NAME = 'agent-switchboard';

/** 配置文件名。 */
export const CONFIG_FILE_NAME = 'roles.json';

/** 配置文件的当前格式版本。将来改结构时用来做迁移判据。 */
export const CONFIG_FORMAT_VERSION = 1;

/**
 * 解析配置文件路径。
 *
 * @param {string} dshHome - `$DSH_HOME`（来自 `ctx.profileContext.home` 或 `dshHomePath()`）。
 * @returns {string} 绝对路径。
 */
export function configPathFor(dshHome) {
  return join(dshHome, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/** 文件权限：仅属主可读写。配置里可能含本机路径，不宜更宽。 */
export const FILE_MODE = 0o600;

/** 目录权限：仅属主可进入。 */
export const DIR_MODE = 0o700;

/**
 * 读取并解析配置文件。
 *
 * 返回值区分三种情况，调用方据此决定是「用默认值」还是「报错」：
 *   - `{ ok: true, value }` —— 文件存在且可解析（`value` 已做形状校验）
 *   - `{ ok: true, value: undefined, missing: true }` —— 文件不存在（首次运行）
 *   - `{ ok: false, error }` —— 文件存在但读不了或坏了（**不能**静默用默认值覆盖）
 *
 * ⚠️ 「文件不存在」与「文件损坏」必须分开：前者应当播种默认值，后者必须报错并保留
 * 原文件 —— 否则一次解析失败就会把用户的配置静默清空。
 *
 * @param {string} path - 配置文件绝对路径。
 * @returns {{ok: boolean, value?: object, missing?: boolean, error?: string}} 读取结果。
 */
export function readConfigFile(path) {
  if (!existsSync(path)) return { ok: true, value: undefined, missing: true };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, error: `读取失败：${error instanceof Error ? error.message : String(error)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '配置文件的顶层必须是一个对象' };
  }
  if (!Array.isArray(parsed.roles)) {
    return { ok: false, error: '配置文件缺少 roles 数组' };
  }
  return { ok: true, value: parsed };
}

/**
 * 创建一个按文件 mtime/size 缓存的读取器。
 * 文件损坏时保留上次成功快照，但显式标记 stale；从未成功读取则返回不可派发状态。
 */
export function createConfigFileResolver(path) {
  let fingerprint;
  let cached;
  let lastError;
  return {
    read() {
      let stat;
      try {
        stat = statSync(path);
      } catch (error) {
        if (error?.code === 'ENOENT') return { ok: true, missing: true, value: undefined, source: 'file', stale: false, cached: false };
        lastError = `配置文件状态读取失败：${error instanceof Error ? error.message : String(error)}`;
        return cached ? { ok: true, value: cached, source: 'file', stale: true, cached: true, error: lastError }
          : { ok: false, error: lastError, source: 'file', stale: true, cached: false };
      }
      const next = `${stat.mtimeMs}:${stat.size}`;
      if (next === fingerprint && cached) return { ok: true, value: cached, source: 'file', stale: Boolean(lastError), cached: true };
      const result = readConfigFile(path);
      fingerprint = next;
      if (result.ok && !result.missing) {
        cached = result.value;
        lastError = undefined;
        return { ok: true, value: cached, source: 'file', stale: false, cached: false };
      }
      if (result.missing) return { ok: true, missing: true, value: undefined, source: 'file', stale: false, cached: false };
      lastError = result.error;
      return cached ? { ok: true, value: cached, source: 'file', stale: true, cached: true, error: lastError }
        : { ok: false, error: lastError, source: 'file', stale: true, cached: false };
    },
    get cache() { return cached; },
  };
}

/**
 * Windows 上 `rename` 会因瞬时占用（杀毒、索引、另一个句柄未释放）失败。
 * 这些错误码重试即可成功，属可恢复；其它错误立即抛出，不掩盖真实问题。
 */
const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

/** 重试的初始间隔（毫秒），指数退避到 {@link RENAME_RETRY_MAX_MS}。 */
const RENAME_RETRY_INITIAL_MS = 20;

/** 重试间隔上限（毫秒）。 */
const RENAME_RETRY_MAX_MS = 200;

/** 重试次数上限。超过即抛出，避免无限等待。 */
const RENAME_RETRY_LIMIT = 8;

/** 同步睡眠（本模块刻意保持全同步：调用点都在装载期与远程方法内，不值得引入 Promise 传染）。 */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * 原子写入配置文件。
 *
 * 做法：在**同一目录**写临时文件（`flag: 'wx'`，避免复用残留文件），再 `rename` 覆盖
 * 目标。同文件系统的 rename 是原子的，因此不会出现「写到一半被中断、留下半截 JSON」。
 * 失败时清理临时文件；Windows 的瞬时占用错误按指数退避重试。
 *
 * 语义边界如实记录：这是「原子但不 fsync」，防的是写到一半被中断，**不**防刚写完就断电。
 * 对一份可由界面重新生成的配置来说，这个取舍是合适的。
 *
 * @param {string} path - 目标绝对路径。
 * @param {object} value - 要写入的对象。
 * @returns {{ok: boolean, error?: string}} 结果。
 */
export function writeConfigFile(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
    writeFileSync(temp, text, { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' });
    let delay = RENAME_RETRY_INITIAL_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temp, path);
        return { ok: true };
      } catch (error) {
        const code = error?.code ?? '';
        if (!TRANSIENT_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_LIMIT) throw error;
        sleepSync(delay);
        delay = Math.min(delay * 2, RENAME_RETRY_MAX_MS);
      }
    }
  } catch (error) {
    // 清理临时文件；清理本身失败不应掩盖原始错误。
    try {
      rmSync(temp, { force: true });
    } catch {
      /* 尽力而为 */
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 把一份配置文件内容归一化为「可安全交给 normalizeRoles」的形状。
 *
 * 这里只保证**结构**（roles 是数组），字段级校验交给 `normalizeRole` —— 不重复实现
 * 一套规则，否则界面说合法、装载期又报错，用户会得到最困惑的失败。
 *
 * @param {object} value - 已解析的配置。
 * @returns {{roles: unknown[], provider?: string, cwd?: string, maxDepth?: number}} 归一化结果。
 */
export function normalizeConfigShape(value) {
  const out = { roles: Array.isArray(value?.roles) ? value.roles : [] };
  if (typeof value?.provider === 'string') out.provider = value.provider;
  if (typeof value?.cwd === 'string') out.cwd = value.cwd;
  if (typeof value?.maxDepth === 'number') out.maxDepth = value.maxDepth;
  if (typeof value?.volatile === 'object' && value.volatile !== null) {
    out.volatile = value.volatile;
  }
  return out;
}

/**
 * 构造一份初始配置文件内容。
 *
 * `seedRoles` 用于**首次迁移**：把原先写在 profile patch 里的角色搬进文件，避免用户
 * 升级后角色「消失」。`formatVersion` 让将来的结构变更可被识别。
 *
 * @param {object[]} [seedRoles] - 初始角色（通常来自旧配置）。
 * @param {object} [extra] - 额外的顶层字段（provider / cwd / maxDepth / volatile）。
 * @returns {object} 配置文件内容。
 */
export function initialConfig(seedRoles = [], extra = {}) {
  return {
    formatVersion: CONFIG_FORMAT_VERSION,
    roles: Array.isArray(seedRoles) ? seedRoles : [],
    ...extra,
  };
}
