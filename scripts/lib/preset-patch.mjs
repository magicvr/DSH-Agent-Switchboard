// preset 块的唯一剥离与结构校验实现；严格保留行首 guard。
import { parse, parseDocument, LineCounter, isMap, isSeq, isScalar, isAlias } from 'yaml';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// 生命周期只接受独立且带生成器标记的块；剥离仍唯一委托给历史 guard。
// 同时比较解析后的其它操作，防止剥离误吞相邻用户配置。
export function planInjectedPreset(original, block, { remove = false } = {}) {
  const doc = parse(original);
  const valid = operations => Array.isArray(operations) && operations.every(op => op && typeof op === 'object'
    && !Array.isArray(op) && Object.keys(op).length > 0
    && (!Object.hasOwn(op, 'insert') || (Array.isArray(op.insert) && op.insert.length > 0
      && op.insert.every(row => row && typeof row === 'object' && !Array.isArray(row)))));
  if (!valid(doc)) throw new Error('profile patch 结构无效，拒绝写入');
  const hits = doc.filter(op => op.id === 'preset-switchboard'
    || op.insert?.some(row => row.id === 'preset-switchboard'));
  if (hits.length > 1 || (hits.length && (Object.keys(hits[0]).length !== 1
    || hits[0].insert?.length !== 1 || !/^# Switchboard/m.test(original))))
    throw new Error('preset 块未标记或有歧义，拒绝写入');
  if (hits.length) {
    const markers = [...original.matchAll(/^# Switchboard.*$/gm)];
    const tail = original.slice(markers[0].index);
    const boundaries = [...tail.matchAll(/^- /gm)];
    const marked = parse(tail.slice(0, boundaries[1]?.index ?? tail.length));
    if (markers.length !== 1 || !isDeepStrictEqual(marked, hits))
      throw new Error('preset 标记未对应唯一独立操作，拒绝写入');
  }
  const cleaned = stripInjectedPreset(original);
  const remaining = cleaned.trim() ? parse(cleaned) ?? [] : [];
  if (!valid(remaining) || !isDeepStrictEqual(remaining, doc.filter(op => !hits.includes(op))))
    throw new Error('preset 剥离会改变其它操作或留下残留，拒绝写入');
  if (remove) return hits.length ? (remaining.length ? cleaned : `${cleaned.replace(/\n*$/, '')}\n[]\n`) : original;
  const generated = parse(block);
  if (!valid(generated) || generated.length !== 1 || generated[0].insert?.length !== 1
    || generated[0].insert[0].id !== 'preset-switchboard') throw new Error('仓库 preset 结构无效');
  // 已同步时保留所有原始字节，第二次运行不再改动换行或备份。
  if (hits.length && isDeepStrictEqual(hits[0], generated[0])) return original;
  // 空序列不能和块式序列拼接；只移除 [] 本身，保留用户注释。
  const base = remaining.length === 0 ? cleaned.replace(/^\s*\[\]\s*(?=#|$)/m, '') : cleaned;
  const next = `${base.replace(/\n*$/, '\n')}\n${block.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')}`;
  if (!valid(parse(next))) throw new Error('注入产物结构无效');
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
  const doc = parseDocument(text, { lineCounter });
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
  return { status: 'drifted', offset, reason: `profile 已过期，需重新注入；长度（UTF-16）：profile=${profileRules.length}，生成物=${repoRules.length}；首个不同位置（从 0 起）=${offset}，附近 profile=${snippet(profileRules)}，生成物=${snippet(repoRules)}` };
}


const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readDocument(path, parser) {
  try { return { data: parser(readFileSync(path, 'utf8')) }; } catch (error) {
    return { error: `无法读取或解析文件：${error.message}` };
  }
}

// 结构错误保留为失败原因，不能靠空数组回退掩盖或接受单个 insert 对象。
export function readPatch(path) {
  const result = readDocument(path, parse);
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

export function presetConfig(patch, packageName) {
  if (patch.error) return { error: patch.error };
  const preset = patch.entries.find(row => row.id === 'preset-switchboard');
  if (!preset) return { error: '缺少 preset-switchboard 声明' };
  if (!isObject(preset.config)) return { preset, error: 'preset-switchboard 的 config 必须是对象' };
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
    const document = parseDocument(text);
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
    doc = parse(text);
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
