/** 配置格式版本与纯迁移链；不负责 roles 形状或字段级校验。 */
export const CONFIG_FORMAT_VERSION = 1;

// 后续步骤只能追加；from/to 必须连续递增，已发布步骤不得重排或删除。
export const CONFIG_MIGRATIONS = Object.freeze([
  Object.freeze({
    from: 0, to: 1, describe: '补齐配置格式版本',
    migrate: value => ({ ...value, formatVersion: 1 }),
  }),
]);

/** 不抛错：非法输入/版本与缺失迁移路径均为 unsupported，不做数值强转。 */
export function inspectConfigFormat(rawValue) {
  const result = { onDiskVersion: null, currentVersion: CONFIG_FORMAT_VERSION,
    status: 'unsupported', applied: [], needsWrite: false, reason: '' };
  if (rawValue === null || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    return { ...result, reason: '配置文件的顶层必须是一个对象' };
  }
  const version = Object.hasOwn(rawValue, 'formatVersion') ? rawValue.formatVersion : 0;
  result.onDiskVersion = version;
  if (!Number.isSafeInteger(version) || version < 0) {
    return { ...result, reason: 'formatVersion 必须是非负安全整数，不能转换或猜测版本' };
  }
  if (version > CONFIG_FORMAT_VERSION) {
    return { ...result, status: 'future', reason: `磁盘配置版本 ${version} 高于支持版本 ${CONFIG_FORMAT_VERSION}；拒绝派发和覆盖，请升级插件` };
  }
  if (version === CONFIG_FORMAT_VERSION) return { ...result, status: 'current' };
  let cursor = version;
  for (const step of CONFIG_MIGRATIONS) {
    if (step.from !== cursor) continue;
    if (step.to !== cursor + 1 || step.to > CONFIG_FORMAT_VERSION) break;
    result.applied.push({ from: step.from, to: step.to, describe: step.describe });
    cursor = step.to;
    if (cursor === CONFIG_FORMAT_VERSION) break;
  }
  if (cursor !== CONFIG_FORMAT_VERSION) {
    return { ...result, reason: `配置版本 ${version} 到支持版本 ${CONFIG_FORMAT_VERSION} 缺少连续迁移路径；拒绝覆盖` };
  }
  return { ...result, status: 'migrated', needsWrite: true,
    reason: `配置版本 ${version} 已在内存迁移到 ${CONFIG_FORMAT_VERSION}；磁盘迁移待完成，可显式迁移，或在保存设置时备份并自动迁移` };
}

/** 返回新对象（浅复制并保留其它字段）；future/unsupported 抛错。
 * 版本 1 不代表 shape 合法：roles 数组仍由 config-file.js 独立校验。
 */
export function migrateConfig(rawValue) {
  const format = inspectConfigFormat(rawValue);
  if (format.status === 'future' || format.status === 'unsupported') throw new Error(format.reason);
  let value = { ...rawValue };
  for (const applied of format.applied) {
    value = CONFIG_MIGRATIONS.find(step => step.from === applied.from).migrate(value);
  }
  return value;
}
