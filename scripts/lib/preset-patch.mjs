// preset 块的唯一剥离与结构校验实现；严格保留行首 guard。
import { parse, parseDocument, LineCounter, isMap, isSeq, isScalar, isAlias } from 'yaml';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// `!!js` 是 Cordis Loader 的表达式标签；这些解析只读结构，不求值。
// 用 identity resolver 把它当普通字符串，避免每次 status 都刷 TAG_RESOLVE_FAILED 警告。
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: value => value };
const parsePatch = text => parse(text, { customTags: [JS_TAG] });
const parsePatchDocument = (text, options = {}) => parseDocument(text, { customTags: [JS_TAG], ...options });

/**
 * 旋钮字段：收尾迁移后住进设置的那一组（与 `src/roles.js` 的 ROLE_SETTING_FIELDS 一致）。
 *
 * ⚠️ 这里是**文本级**迁移，不经过 YAML round-trip：profile patch 里含 `!!js` 表达式标签，
 *    round-trip 会把它们降级成普通字符串（`disabled` 恒为真），那是会改变行为的数据损坏。
 *    历史教训同源：`stripInjectedPreset` 早期用宽泛匹配，剥离区间一路吃到文件末尾，
 *    **删掉近 900 行（含全部角色配置）**。因此本函数只认缩进确定的块边界。
 */
const MIGRATION_KNOB_FIELDS = Object.freeze([
  'backend', 'model', 'effort', 'provider', 'readOnly', 'allowNestedDispatch',
]);

/** 按需加引号：安全裸标量原样输出，其余用 JSON 双引号形式，避免破坏 YAML。 */
function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  return /^[A-Za-z0-9_./@+-]+$/.test(text) && !/^(true|false|null|yes|no|on|off)$/i.test(text)
    ? text : JSON.stringify(text);
}

/**
 * 把根条目里的完整 `roles` 块收尾迁移成 `roleSettings` 旋钮块（**文本级**）。
 *
 * 迁移的前提是角色**定义**已经住在插件自己的 `roles.json` 里（它由根实例同步而来），
 * 所以设置层不必再承载 persona 与 CLI 契约。本函数据此把设置层裁成旋钮，并在裁剪前
 * 用「设置里的角色 id 集合 == 文件里的角色 id 集合」做**安全闸门**：不一致就拒绝迁移，
 * 宁可不迁移也不丢角色。
 *
 * @param {string} text - profile patch 全文。
 * @param {object[]} definitions - `roles.json` 里的角色定义。
 * @returns {{ok: boolean, changed: boolean, text: string, reason?: string, error?: string, knobs?: object[]}} 计划。
 */
export function planRolesMigration(text, definitions) {
  const lines = String(text).split('\n');
  const entryAt = lines.findIndex(line => /^-\s*id:\s*agent-switchboard\s*$/.test(line));
  if (entryAt < 0) return { ok: true, changed: false, text, reason: 'profile patch 里没有根条目；无需迁移' };
  // 根条目内缩进 4 的 `roles:`；遇到下一个顶层操作（列 0 非空）即停止查找。
  let rolesAt = -1;
  for (let i = entryAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break;
    if (/^ {4}roles:\s*$/.test(line)) { rolesAt = i; break; }
  }
  if (rolesAt < 0) {
    const hasSettings = lines.some(line => /^ {4}roleSettings:/.test(line));
    return { ok: true, changed: false, text,
      reason: hasSettings ? '根条目已是 roleSettings 形态；无需迁移' : '根条目里没有完整 roles 块；无需迁移' };
  }
  // 块边界：第一个非空且缩进 ≤ 4 的行为止（保持严格，绝不越过根条目）。
  let end = lines.length;
  for (let i = rolesAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^ {0,4}\S/.test(line)) { end = i; break; }
  }
  let roles;
  try {
    // 片段化解析：去掉统一的一级缩进后交给真实解析器，仍只读这一块。
    roles = parsePatch(lines.slice(rolesAt, end).map(line => line.replace(/^ {4}/, '')).join('\n'))?.roles;
  } catch (error) {
    return { ok: false, changed: false, text, error: `角色块无法解析，拒绝迁移：${error.message}` };
  }
  // `roles:` 后面什么都没有（值为 null/undefined）是**退化但合法**的状态：没有角色可迁移，
  // 不是损坏。只有「非数组且有值」（例如字符串）才算结构错误。
  if (roles === null || roles === undefined) {
    return { ok: true, changed: false, text, reason: '根条目的 roles 为空；无需迁移' };
  }
  if (!Array.isArray(roles)) return { ok: false, changed: false, text, error: '角色块不是数组，拒绝迁移' };
  const movedIds = roles.map(role => role?.id).filter(id => typeof id === 'string').sort();
  const fileIds = (Array.isArray(definitions) ? definitions : [])
    .map(role => role?.id).filter(id => typeof id === 'string').sort();
  if (movedIds.length === 0) return { ok: true, changed: false, text, reason: '设置里的 roles 为空；无需迁移' };
  if (fileIds.length === 0) {
    return { ok: false, changed: false, text,
      error: '角色文件里没有角色定义；先把定义迁移进文件，否则收尾会丢角色' };
  }
  if (!isDeepStrictEqual(movedIds, fileIds)) {
    return { ok: false, changed: false, text,
      error: `设置里的角色与文件不一致（设置=[${movedIds.join(', ')}]，文件=[${fileIds.join(', ')}]）；`
        + '拒绝迁移以免丢角色' };
  }
  // id 集合一致还不够：设置里的 persona / CLI 契约等字段若在文件里缺失，裁掉设置就会丢数据。
  const fileById = new Map((Array.isArray(definitions) ? definitions : []).map(role => [role?.id, role]));
  for (const role of roles) {
    if (!isObject(role)) return { ok: false, changed: false, text, error: '角色项必须是对象，拒绝迁移' };
    const definition = fileById.get(role.id);
    if (!isObject(definition)) return { ok: false, changed: false, text, error: `角色 ${role.id} 在文件里不是对象，拒绝迁移` };
    for (const [field, value] of Object.entries(role)) {
      if (field === 'id' || MIGRATION_KNOB_FIELDS.includes(field)) continue;
      if (!Object.hasOwn(definition, field) || !isDeepStrictEqual(definition[field], value)) {
        return { ok: false, changed: false, text,
          error: `角色 ${role.id} 的字段 ${field} 在文件里缺失或不同；先把完整定义同步到文件，再裁剪设置` };
      }
    }
  }
  const knobs = roles.map(role => {
    const out = { id: role?.id };
    for (const field of MIGRATION_KNOB_FIELDS) if (role?.[field] !== undefined) out[field] = role[field];
    return out;
  });
  const emitted = ['    roleSettings:'];
  for (const knob of knobs) {
    emitted.push(`      - id: ${yamlScalar(knob.id)}`);
    for (const field of MIGRATION_KNOB_FIELDS) {
      if (knob[field] !== undefined) emitted.push(`        ${field}: ${yamlScalar(knob[field])}`);
    }
  }
  return { ok: true, changed: true, knobs,
    text: [...lines.slice(0, rolesAt), ...emitted, ...lines.slice(end)].join('\n') };
}

/**
 * 文本级删除本插件的**顶层根条目** `- id: agent-switchboard`。
 *
 * 卸载时这个条目会留下对已移除包的引用；但它也是用户可编辑的配置，所以只在
 * 显式 `--drop-root-entry` 时按精确边界删除，并要求 `name` 与本包一致。
 * 不经过 YAML round-trip：profile patch 含 `!!js`，序列化会把表达式降级。
 *
 * @param {string} text - profile patch 全文。
 * @param {string} packageName - 本包包名；根条目的 name 必须等于它。
 * @param {string} id - 根条目 id，默认 agent-switchboard。
 * @returns {{ok: boolean, changed: boolean, text: string, reason?: string, error?: string}} 计划。
 */
export function stripRootEntry(text, packageName, id = 'agent-switchboard') {
  const lines = String(text).split('\n');
  const matches = [];
  for (let i = 0; i < lines.length; i++)
    if (new RegExp(`^-\\s*id:\\s*["']?${id}["']?\\s*$`).test(lines[i])) matches.push(i);
  if (matches.length === 0) return { ok: true, changed: false, text, reason: '没有根条目' };
  if (matches.length > 1) return { ok: false, changed: false, text, error: `根条目 ${id} 重复，拒绝删除` };
  const start = matches[0];
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++;
  const block = lines.slice(start, end).join('\n');
  let entry;
  try {
    const parsed = parsePatch(block);
    if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('块不是单个映射');
    entry = parsed[0];
  } catch (error) {
    return { ok: false, changed: false, text, error: `根条目无法解析：${error.message}` };
  }
  if (!isObject(entry) || entry.id !== id) return { ok: false, changed: false, text, error: '根条目 id 不一致' };
  if (entry.name !== packageName) {
    return { ok: false, changed: false, text,
      error: `根条目 name=${JSON.stringify(entry.name)} 不等于本包 ${JSON.stringify(packageName)}，拒绝删除` };
  }
  const next = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
  const normalized = next.trim() === '' ? '[]\n' : next;
  try {
    if (!Array.isArray(parsePatch(normalized))) throw new Error('顶层不是操作列表');
  } catch (error) {
    return { ok: false, changed: false, text, error: `删除根条目后 patch 无效：${error.message}` };
  }
  return { ok: true, changed: true, text: normalized };
}

/**
 * 在 profile patch 中按 id 查条目，同时识别两种合法形态：
 *   1. 顶层覆盖条目 `- id: agent-switchboard`（设置页写入的根条目通常是这种）；
 *   2. `insert:` 操作里的新条目。
 *
 * ⚠️ `readPatch` 只收集 insert 行，不能拿它判断根条目配置——那会把真实 profile 的
 *    `roleSettings` 误报成“无设置层”。这里按 patch 的应用顺序取最后一个命中。
 *
 * @param {string} text - patch 全文。
 * @param {string} id - 条目 id。
 * @returns {object|undefined} 命中的条目；无法解析或没有时返回 undefined。
 */
export function findPatchEntry(text, id) {
  let doc;
  try { doc = parsePatch(text); } catch { return undefined; }
  if (!Array.isArray(doc)) return undefined;
  const rows = [];
  for (const op of doc) {
    if (!isObject(op)) continue;
    if (op.id === id) rows.push(op);
    if (Array.isArray(op.insert)) for (const row of op.insert) if (isObject(row) && row.id === id) rows.push(row);
  }
  return rows.at(-1);
}

// 生命周期只接受独立且带生成器标记的块；剥离仍唯一委托给历史 guard。
// 同时比较解析后的其它操作，防止剥离误吞相邻用户配置。
export function planInjectedPreset(original, block, { remove = false } = {}) {
  const doc = parsePatch(original);
  const valid = operations => Array.isArray(operations) && operations.every(op => op && typeof op === 'object'
    && !Array.isArray(op) && Object.keys(op).length > 0
    && (!Object.hasOwn(op, 'insert') || (Array.isArray(op.insert) && op.insert.length > 0
      && op.insert.every(row => row && typeof row === 'object' && !Array.isArray(row)))));
  if (!valid(doc)) throw new Error('profile patch 结构无效，拒绝写入');
  // ⚠️ 允许**历史单条**注入被剥离（升级路径），但新注入必须恰好包含两个 preset。
  const PRESET_ROW_IDS = ['preset-switchboard', 'preset-switchboard-solo'];
  const presetRowIds = (op) => Array.isArray(op?.insert) ? op.insert.map(row => row?.id) : [];
  const isPresetOperation = (op) => op.id === 'preset-switchboard'
    || presetRowIds(op).some(id => PRESET_ROW_IDS.includes(id));
  const hits = doc.filter(isPresetOperation);
  const hitRows = hits[0] !== undefined ? presetRowIds(hits[0]) : [];
  const hitRowsClean = hitRows.length > 0 && hitRows.every(id => PRESET_ROW_IDS.includes(id))
    && new Set(hitRows).size === hitRows.length;
  if (hits.length > 1 || (hits.length && (Object.keys(hits[0]).length !== 1
    || !hitRowsClean || !/^# Switchboard/m.test(original))))
    throw new Error('preset 块未标记或有歧义，拒绝写入');
  if (hits.length) {
    const markers = [...original.matchAll(/^# Switchboard.*$/gm)];
    const tail = original.slice(markers[0].index);
    const boundaries = [...tail.matchAll(/^- /gm)];
    const marked = parsePatch(tail.slice(0, boundaries[1]?.index ?? tail.length));
    if (markers.length !== 1 || !isDeepStrictEqual(marked, hits))
      throw new Error('preset 标记未对应唯一独立操作，拒绝写入');
  }
  const cleaned = stripInjectedPreset(original);
  const remaining = cleaned.trim() ? parsePatch(cleaned) ?? [] : [];
  if (!valid(remaining) || !isDeepStrictEqual(remaining, doc.filter(op => !hits.includes(op))))
    throw new Error('preset 剥离会改变其它操作或留下残留，拒绝写入');
  if (remove) return hits.length ? (remaining.length ? cleaned : `${cleaned.replace(/\n*$/, '')}\n[]\n`) : original;
  const generated = parsePatch(block);
  const generatedRows = generated[0]?.insert;
  if (!valid(generated) || generated.length !== 1 || !Array.isArray(generatedRows)
    || generatedRows.length !== PRESET_ROW_IDS.length
    || !PRESET_ROW_IDS.every(id => generatedRows.some(row => row?.id === id)))
    throw new Error('仓库 preset 结构无效');
  // 已同步时保留所有原始字节，第二次运行不再改动换行或备份。
  if (hits.length && isDeepStrictEqual(hits[0], generated[0])) return original;
  // 空序列不能和块式序列拼接；只移除 [] 本身，保留用户注释。
  const base = remaining.length === 0 ? cleaned.replace(/^\s*\[\]\s*(?=#|$)/m, '') : cleaned;
  const next = `${base.replace(/\n*$/, '\n')}\n${block.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')}`;
  if (!valid(parsePatch(next))) throw new Error('注入产物结构无效');
  return next;
}

// probe-preset 历史语义：仅接受 insert 数组，重复声明时取最后命中的条目。
export function findPresetDeclaration(doc, presetId = 'preset-switchboard') {
  let decl;
  for (const op of doc) {
    const inserted = Array.isArray(op?.insert) ? op.insert : [];
    const hit = inserted.find(row => row && row.id === presetId && row.config);
    if (hit) decl = hit;
  }
  return decl;
}

export function pluginsWithoutName(plugins) {
  return plugins.filter(plugin => typeof plugin.name !== 'string' || plugin.name.length === 0);
}

/** 扫描所有深度的包名值（含等价字段和 YAML alias），返回条目 id 与来源行。 */
export function scanPackageReferences(text, packageName) {
  const lineCounter = new LineCounter();
  const doc = parsePatchDocument(text, { lineCounter });
  if (doc.errors.length) throw new Error(`patch 引用扫描无法解析：${doc.errors[0].message}`);
  const references = [];
  function walk(node, id = '(无 id)', aliasLine, ancestors = new Set()) {
    if (!node || ancestors.has(node)) return;
    const seen = new Set(ancestors).add(node);
    const line = aliasLine ?? lineCounter.linePos(node.range?.[0] ?? 0).line;
    if (isAlias(node)) return walk(node.resolve(doc), id, line, seen);
    if (isScalar(node)) {
      if (node.value === packageName) references.push({ id, line });
    } else if (isMap(node)) {
      const ownId = node.get('id');
      if (typeof ownId === 'string') id = ownId;
      for (const pair of node.items) {
        walk(pair.key, id, aliasLine, seen);
        walk(pair.value, id, aliasLine, seen);
      }
    } else if (isSeq(node)) for (const item of node.items) walk(item, id, aliasLine, seen);
  }
  walk(doc.contents);
  return references;
}

// 按 wiring 的解析后字符串比较；不 trim、不归一化规则内容。
export function compareRules(profileRules, repoRules) {
  if (typeof repoRules !== 'string' || !repoRules.trim()) return { status: 'invalid', reason: '仓库生成物的 supervisorRules 缺失或非有效字符串' };
  if (typeof profileRules !== 'string' || !profileRules.trim()) return { status: 'invalid', reason: 'profile supervisorRules 缺失、类型错误或仅含空白' };
  if (Buffer.from(profileRules).equals(Buffer.from(repoRules))) return { status: 'current' };
  let offset = 0;
  while (offset < Math.min(profileRules.length, repoRules.length) && profileRules[offset] === repoRules[offset]) offset++;
  const snippet = value => JSON.stringify(value.slice(Math.max(0, offset - 12), offset + 20));
  return { status: 'drifted', offset, reason: `profile 已过期，需重新收敛（install/upgrade --apply）；长度（UTF-16）：profile=${profileRules.length}，生成物=${repoRules.length}；首个不同位置（从 0 起）=${offset}，附近 profile=${snippet(profileRules)}，生成物=${snippet(repoRules)}` };
}


const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readDocument(path, parser) {
  try { return { data: parser(readFileSync(path, 'utf8')) }; } catch (error) {
    return { error: `无法读取或解析文件：${error.message}` };
  }
}

// 结构错误保留为失败原因，不能靠空数组回退掩盖或接受单个 insert 对象。
export function readPatch(path) {
  const result = readDocument(path, parsePatch);
  if (result.error) return result;
  if (!Array.isArray(result.data)) return { error: 'patch 顶层必须是操作列表数组' };
  const entries = [];
  for (const op of result.data) {
    if (!isObject(op)) return { error: 'patch 操作必须是对象' };
    if (!Object.hasOwn(op, 'insert')) continue;
    if (!Array.isArray(op.insert)) return { error: 'patch 的 insert 必须是条目数组' };
    if (!op.insert.every(isObject)) return { error: 'insert 数组中的条目必须是对象' };
    entries.push(...op.insert);
  }
  return { entries };
}

export function presetConfig(patch, packageName, presetId = 'preset-switchboard') {
  if (patch.error) return { error: patch.error };
  const preset = patch.entries.find(row => row.id === presetId);
  if (!preset) return { error: `缺少 ${presetId} 声明` };
  if (!isObject(preset.config)) return { preset, error: `${presetId} 的 config 必须是对象` };
  if (!Array.isArray(preset.config.plugins)) return { preset, error: 'preset 的 plugins 必须是数组' };
  if (!preset.config.plugins.every(isObject)) return { preset, error: 'plugins 数组中的条目必须是对象' };
  const selfRow = preset.config.plugins.find(plugin => plugin.name === packageName);
  if (!selfRow) return { preset, error: 'preset 的 plugins 缺少本包条目' };
  if (!isObject(selfRow.config)) return { preset, selfRow, error: 'preset 里本包的 config 必须是对象' };
  return { preset, selfRow, config: selfRow.config };
}

/**
 * 判断某行是否属于「我们自己注入的 preset 块」。
 *
 * ⚠️ 这里有一个会造成**数据丢失**的陷阱，务必保持严格：
 *   配置值里也含 "Switchboard" —— 例如 `agent-switchboard` 条目的
 *   `cwd: "C:\Users\...\Code\DSH-Agent-Switchboard"`。若用宽泛的
 *   `l.includes('Switchboard')`，剥离区间会从那一行一直吃到文件末尾的
 *   preset 块，**删掉近 900 行**（含全部角色配置）。实测确实发生过，只是
 *   被写盘前的断言拦下了。
 *
 * 因此只认两种情况：
 *   1. 生成器写的**注释行**，且必须是 `#` 开头的行首形式；
 *   2. preset 声明的 id 行（`- id: preset-switchboard`）。
 *
 * @param {string} line - 单行文本。
 * @returns {boolean} 是否属于我们的块。
 */
export function isOurBlockLine(line) {
  const trimmed = line.trimStart();
  // 注释行：必须是 `#` 开头，且形如生成器写的块头注释。
  if (trimmed.startsWith('# Switchboard')) return true;
  // 声明行：`- id: preset-switchboard`（可能带缩进）。
  return /^-?\s*id:\s*preset-switchboard\s*$/.test(trimmed);
}

/**
 * 剥离此前注入过的 Switchboard preset 块，并顺带清理**空操作**。
 *
 * 需要可重复注入：早期版本的错误结构已写进过 profile，必须能被完整替换而不是
 * 叠加或留残。
 *
 * ⚠️ 为什么还要清理空操作：真实文件的形态是
 *     - insert:                      ← 独立一行
 *     # Switchboard 的 Agent preset 声明。
 *     - insert:                      ← 我们的块
 *         - id: preset-switchboard
 * 剥离只删「注释 + 我们的行」，于是第一个 `- insert:` 变成**没有内容的空操作**，
 * 解析出 `insert: null`。这不只是难看：空 insert 会让 Loader 的 patch 树多一个
 * 无意义节点。因此把「删除空 insert 操作」并入剥离流程，任何残留形态都能自愈，
 * 而不是逐个个案特判。
 *
 * @param {string} text - patch 文本。
 * @returns {string} 剥离并清理后的文本。
 */
export function stripInjectedPreset(text) {
  const lines = text.split('\n');
  const isTopLevel = (l) => /^- /.test(l);

  // 1) 删除我们自己的块。
  for (let start = 0; start < lines.length; start++) {
    if (!isOurBlockLine(lines[start])) continue;
    while (start > 0 && lines[start - 1].trimStart().startsWith('# Switchboard')) start--;
    const offset = lines.slice(0, start).reduce((size, line) => size + line.length + 1, 0);
    const document = parsePatchDocument(text);
    if (!document.errors.length && isSeq(document.contents)) {
      const operation = document.contents.items.find(node => {
        const value = node?.toJSON();
        return Array.isArray(value?.insert) && value.insert.some(row => row?.id === 'preset-switchboard')
          && node.range[1] > offset;
      });
      // range[1] 结束于 YAML 内容；range[2] 还包含尾随注释，不能用于删除。
      if (operation) return stripInjectedPreset(text.slice(0, offset) + text.slice(operation.range[1]));
    }
    let end = start + 1;
    // 标记后允许本操作的顶层 insert；操作内容只包含缩进的续行。
    if (lines[start].trimStart().startsWith('# Switchboard')) {
      while (end < lines.length && lines[end].trimStart().startsWith('# Switchboard')) end++;
      if (/^- insert:\s*$/.test(lines[end] ?? '')) end++;
    }
    while (end < lines.length && (/^\s+\S/.test(lines[end]) || !lines[end].trim())) end++;
    const stripped = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
    return stripInjectedPreset(stripped);
  }

  // 2) 删除空操作（例如只剩一个 `- insert:` 而没有列表项）。
  for (let start = 0; start < lines.length; start++) {
    if (!/^- insert:\s*$/.test(lines[start])) continue;
    let end = start + 1;
    while (end < lines.length && !isTopLevel(lines[end])) end++;
    const meaningful = lines
      .slice(start + 1, end)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    if (meaningful.length === 0) {
      // 连同其前面的空白行一起删，避免留下连续空行。
      let from = start;
      while (from > 0 && lines[from - 1].trim() === '') from--;
      // 空操作后面的用户注释也不属于操作。
      const next = [...lines.slice(0, from), ...lines.slice(start + 1)].join('\n');
      return stripInjectedPreset(next);
    }
  }

  return text;
}

/**
 * 结构化残留检查。
 *
 * ⚠️ 为什么不能只做字符串检查：我第一版的「剥离干净」断言只查文本里是否还提到
 * PRESET_ID，而残留可能是一个**孤立的 `- insert:`**（不含任何 id 文本）。
 * 它解析出来是一个空 insert 操作 —— 字符串断言看不见，实测因此漏过一次。
 * 结构问题必须用解析来判断。
 *
 * @param {string} text - 待检查的 patch 文本。
 * @param {string} label - 报告用的标签。
 * @returns {boolean} 是否干净。
 */
export function assertNoStrayOperations(text, label) {
  let doc;
  try {
    doc = parsePatch(text);
  } catch (error) {
    console.error(`FAIL  ${label} 无法解析：${error.message}`);
    return false;
  }
  const stray = [];
  doc.forEach((op, index) => {
    if (!op || typeof op !== 'object') {
      stray.push(`[${index}] 非对象操作`);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(op, 'insert')) {
      // ⚠️ YAML 会把**只有一项**的序列解析成单个对象而不是数组。若只处理
      //     `Array.isArray` 分支，单项的 insert 会被静默当成「非数组」跳过 ——
      //     那正是一次真实漏检（孤立的 `- insert:` 因此没被发现）。
      const list = Array.isArray(op.insert) ? op.insert : [op.insert];
      if (list.length === 0 || list[0] === null || list[0] === undefined) {
        stray.push(`[${index}] 空 insert 操作`);
      }
    }
    const keys = Object.keys(op);
    if (keys.length === 0) stray.push(`[${index}] 空操作`);
    if (keys.length === 1 && keys[0] === 'insert') {
      const list = Array.isArray(op.insert) ? op.insert : [op.insert];
      if (list.length === 1 && list[0] && typeof list[0] === 'object') {
        // 单项且含 id 的 insert 是正常的 plugin insert；只有缺 id 才可疑。
        if (typeof list[0].id !== 'string') stray.push(`[${index}] insert 项缺少 id`);
      }
    }
  });
  if (stray.length > 0) {
    console.error(`FAIL  ${label} 含残留操作：${stray.join('; ')}`);
    return false;
  }
  console.log(`PASS  ${label} 无空/残留操作（顶层 ${doc.length} 项）`);
  return true;
}
