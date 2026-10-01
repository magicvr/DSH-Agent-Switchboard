/**
 * 角色配置的**远程服务**：给 Client 半边的设置页读写配置文件。
 *
 * ## 为什么需要它
 *
 * 设置页要读写角色配置，而配置已经不从 `settings` 走（见 `config-file.js` 顶部的
 * 架构说明）。因此这里用 DSH 的 **Typert Remote** 通道自建一对方法，
 * 与官方 `dsh-agent-preset-registry` 的 `read` / `select` 是同一条路。
 *
 * ## 零转译是怎么做到的（已实测）
 *
 * 官方包用标准装饰器语法 `@Remote('list')`，但那需要 TypeScript 编译；
 * Node 24.19 原生**不支持**装饰器语法（实测 `SyntaxError`）。
 *
 * 但装饰器的效果很朴素：它只是往原型上写一个 symbol 属性
 * （`Object.defineProperty(prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', …)`），
 * 而网关发现远程方法用的 `remoteMethods(service)` 就是读那个属性。
 *
 * 因此这里按标准装饰器的公开 `(value, context)` 契约**手工施加**它：
 * 构造一个最小 context、收集初始化器、以实例为 `this` 调用一次。
 * 实测 `remoteMethods(实例)` 能正确发现，且方法照常调用。
 *
 * ⚠️ 网关靠 `collectSrcClaims()` **运行时枚举**服务来发现（遍历 reflect 属性，
 * 找带 `typertRemote` 绑定的服务），**不是**静态注册表。所以外部插件无需任何
 * 代码生成即可参与，这也正是本文件能成立的原因。
 *
 * ⚠️ 另一个硬约束（源码报错信息逐字）：「SRC method … must use unique identifier
 * parameters without destructuring, defaults, or rest」。即**参数名是从函数源码里
 * 抠出来的**，因此远程方法不能有解构、默认值或剩余参数。本文件的两个方法都只接受
 * 一个普通形参，符合这条约束。
 */
import { Remote, TypertRemoteService, RemoteError, remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { readConfigFile, writeConfigFile, normalizeConfigShape } from './config-file.js';
import { normalizeRoles } from './roles.js';

/** Cordis 服务键，同时也是远程命名空间（客户端按 `ctx.remote.roleConfig` 访问）。 */
export const ROLE_CONFIG_SERVICE = 'roleConfig';

/**
 * 手工把 `Remote(...)` 标记施加到某个类的原型方法上（零转译）。
 *
 * 等价于标准装饰器写法 `class S { @Remote('read') read() {} }`。
 *
 * @param {Function} ctor - 目标类。
 * @param {string} method - 方法名；必须是**公开实例方法**（协议对此有硬要求）。
 * @param {string} [exportName] - 线上导出名，省略则等于方法名。
 * @throws {Error} 当方法不存在、或装饰器没有登记初始化器时。
 */
export function applyRemoteMarker(ctor, method, exportName) {
  if (typeof ctor?.prototype?.[method] !== 'function') {
    throw new Error(`applyRemoteMarker: ${ctor?.name ?? '?'}.${method} 不是公开实例方法`);
  }
  const decorator = exportName === undefined ? Remote : Remote(exportName);
  let initializer;
  decorator(ctor.prototype[method], {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    metadata: undefined,
    addInitializer(fn) {
      initializer = fn;
    },
  });
  if (typeof initializer !== 'function') {
    throw new Error(`applyRemoteMarker: ${method} 的装饰器没有登记初始化器`);
  }
  // 初始化器的契约是「以实例为 this 调用」；它写的是原型，因此任意实例即可。
  initializer.call(Object.create(ctor.prototype));
}

/**
 * 角色配置服务。
 *
 * 两个远程方法都**不抛业务异常**，而是返回 `{ok, …}` 结构：客户端要能把
 * 「文件坏在哪」如实显示给用户，而不是收到一个失去上下文的错误。
 *
 * 刻意**不做首次播种**：本服务在根作用域也会注册（这样设置页在任何会话里都能用），
 * 若在首读时用空角色播种，会在用户还没操作之前就凭空写出一份空配置。改为由界面
 * 显式「新增角色 → 保存」来创建文件，语义更清楚。
 */
export class RoleConfigService extends TypertRemoteService {
  /**
   * @param {object} ctx - Cordis 上下文。
   * @param {object} options - 构造选项。
   * @param {string} options.path - 配置文件绝对路径。
   * @param {string} [options.provider] - 角色默认 provider。
   * @param {string} [options.cwd] - 默认工作目录。
   * @param {number} [options.maxDepth] - 嵌套派发深度上限。
   * @param {(msg: string) => void} [options.log] - 诊断输出。
   */
  constructor(ctx, options) {
    super(ctx, ROLE_CONFIG_SERVICE);
    this.path = options.path;
    this.defaults = {
      provider: options.provider,
      cwd: options.cwd,
      maxDepth: options.maxDepth,
    };
    this.log = options.log ?? (() => {});
  }

  /**
   * 读取角色配置（远程方法 `read`）。
   *
   * 三种结果都对客户端可读：
   *   - 文件不存在 → `{ok:true, roles:[], missing:true}`（界面显示「尚未配置」，非错误）
   *   - 文件损坏 → `{ok:false, error}`（**必须**报错：静默当作空会把用户配置弄丢）
   *   - 正常 → `{ok:true, roles, provider?, cwd?, maxDepth?}`
   *
   * 这里不做字段级校验：那是 `normalizeRoles` 的职责，在 `apply` 里统一执行，
   * 避免两处规则说法不一。
   *
   * @returns {{ok: boolean, roles: unknown[], path: string, missing?: boolean, error?: string}} 读取结果。
   */
  read() {
    const read = readConfigFile(this.path);
    if (!read.ok) {
      return { ok: false, roles: [], path: this.path, error: read.error };
    }
    if (read.missing) {
      return { ok: true, roles: [], path: this.path, missing: true };
    }
    const shape = normalizeConfigShape(read.value);
    return { ok: true, path: this.path, ...shape };
  }

  /**
   * 写入角色配置（远程方法 `write`）。
   *
   * 写入前**先用 `normalizeRoles` 校验**：宁可拒绝保存，也不要写进一份装载期才报错的
   * 配置 —— 那会让用户在「保存成功」之后遇到插件不加载，且难以关联因果。
   *
   * @param {object} payload - `{roles, provider?, cwd?, maxDepth?, volatile?}`。
   * @returns {{ok: boolean, path: string, error?: string, roleCount?: number}} 写入结果。
   */
  write(payload) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, path: this.path, error: '写入内容必须是一个对象' };
    }
    const shape = normalizeConfigShape(payload);
    // 与装载期共用同一套校验实现，规则不会说法不一。
    const { roles, errors } = normalizeRoles(
      shape.roles,
      shape.provider ?? this.defaults.provider,
      shape.cwd ?? this.defaults.cwd,
    );
    if (errors.length > 0) {
      return { ok: false, path: this.path, error: errors.join('；') };
    }
    const next = {
      formatVersion: 1,
      roles: shape.roles,
      ...(shape.provider === undefined ? {} : { provider: shape.provider }),
      ...(shape.cwd === undefined ? {} : { cwd: shape.cwd }),
      ...(shape.maxDepth === undefined ? {} : { maxDepth: shape.maxDepth }),
      ...(shape.volatile === undefined ? {} : { volatile: shape.volatile }),
    };
    const written = writeConfigFile(this.path, next);
    if (!written.ok) {
      return { ok: false, path: this.path, error: written.error };
    }
    return { ok: true, path: this.path, roleCount: roles.length };
  }
}

/**
 * 给服务类的远程方法打标记。
 *
 * 单独一个函数是为了让「哪些方法是远程的」一目了然，也便于离线测试断言
 * `remoteMethods()` 真的发现了它们。
 *
 * @returns {string[]} 已标记的导出名。
 */
export function markRemoteMethods() {
  applyRemoteMarker(RoleConfigService, 'read', 'read');
  applyRemoteMarker(RoleConfigService, 'write', 'write');
  return remoteMethods(Object.create(RoleConfigService.prototype)).map((m) => m.exportName ?? m.method);
}

// 模块加载时即标记：类定义与标记在同一步完成，避免「忘了标记」这种静默失效。
const MARKED = markRemoteMethods();

/** 已标记的远程方法名（供自检与测试断言）。 */
export const REMOTE_METHODS = MARKED;

export { RemoteError, remoteMethods };
