// 依赖无关的 SemVer 2.0.0 与 CHANGELOG 纯逻辑；不读写文件。
const numeric = /^(0|[1-9][0-9]*)$/;
const identifier = /^[0-9A-Za-z-]+$/;

export function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match || match[0] !== text) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  const build = match[5] ? match[5].split('.') : [];
  if (![...prerelease, ...build].every(part => identifier.test(part))) return null;
  if (prerelease.some(part => /^[0-9]+$/.test(part) && !numeric.test(part))) return null;
  // 超出安全整数范围时保留十进制字符串，避免舍入改变合法版本。
  const core = value => Number.isSafeInteger(Number(value)) ? Number(value) : value;
  return { major: core(match[1]), minor: core(match[2]), patch: core(match[3]), prerelease, build };
}

export function formatVersion(parsed) {
  const { major, minor, patch, prerelease = [], build = [] } = parsed;
  return `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join('.')}` : ''}${build.length ? `+${build.join('.')}` : ''}`;
}

function requireVersion(value) {
  const parsed = parseVersion(typeof value === 'string' ? value : formatVersion(value));
  if (!parsed) throw new Error('无效的 SemVer 版本');
  return parsed;
}

function compareNumeric(a, b) {
  const left = BigInt(a); const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareVersions(a, b) {
  const left = requireVersion(a); const right = requireVersion(b);
  for (const key of ['major', 'minor', 'patch']) {
    const order = compareNumeric(left[key], right[key]);
    if (order) return order;
  }
  const x = left.prerelease; const y = right.prerelease;
  if (!x.length || !y.length) return x.length ? -1 : y.length ? 1 : 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    if (x[i] === y[i]) continue;
    const xn = numeric.test(x[i]); const yn = numeric.test(y[i]);
    if (xn && yn) return compareNumeric(x[i], y[i]);
    if (xn !== yn) return xn ? -1 : 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return 0; // build 元数据不参与优先级。
}

export function bumpVersion(current, kind, options = {}) {
  const parsed = requireVersion(current);
  if (!['major', 'minor', 'patch'].includes(kind)) throw new Error('无效的 bump 类型');
  if (options.finalize && options.pre !== undefined) throw new Error('--finalize 与 --pre 不能同时使用');
  parsed.build = [];
  if (options.finalize) {
    if (!parsed.prerelease.length) throw new Error('正式版本不能 finalize');
    parsed.prerelease = [];
    return formatVersion(parsed);
  }
  if (options.pre !== undefined) {
    if (typeof options.pre !== 'string' || !options.pre.split('.').every(part =>
      identifier.test(part) && (!/^[0-9]+$/.test(part) || numeric.test(part)))) {
      throw new Error('无效的 prerelease tag：须为点分隔的 SemVer 预发布标识，不允许 build 元数据、空标识或数字前导零');
    }
    const tag = options.pre.split('.');
    const existing = parsed.prerelease;
    const tail = existing.at(-1);
    const same = existing.length > tag.length && tag.every((part, index) => part === existing[index]);
    if (same && numeric.test(tail)) {
      parsed.prerelease = [...existing.slice(0, -1), String(BigInt(tail) + 1n)];
      return formatVersion(parsed);
    }
    if (same || existing.join('.') === options.pre) {
      parsed.prerelease = [...existing, '0'];
      return formatVersion(parsed);
    }
  }
  parsed[kind] = String(BigInt(parsed[kind]) + 1n);
  if (kind === 'major') parsed.minor = 0;
  if (kind !== 'patch') parsed.patch = 0;
  parsed.prerelease = options.pre === undefined ? [] : [...options.pre.split('.'), '0'];
  return formatVersion(parsed);
}

export function validateExplicitVersion(text) {
  const parsed = parseVersion(text);
  return parsed ? formatVersion(parsed) : null;
}

export function rewriteChangelog(text, { version, date }) {
  const refuse = reason => ({ text, changed: false, reason });
  if (!validateExplicitVersion(version)) return refuse('invalid-version');
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return refuse('invalid-date');
  if ([...text.matchAll(/^## \[([^\]\r\n]+)\](?:[ \t].*)?\r?$/gm)]
    .some(match => match[1] === version)) return refuse('version-already-exists');
  const headings = [...text.matchAll(/^## \[Unreleased\][ \t]*(?:\r?\n|$)/gm)];
  if (!headings.length) return refuse('missing-unreleased');
  if (headings.length !== 1) return refuse('multiple-unreleased');
  const heading = headings[0];
  const eol = heading[0].includes('\r\n') ? '\r\n' : '\n';
  const boundary = heading.index + heading[0].length;
  // 只插入标题；原节正文、后续版本及其余文本原样保留。
  return { text: text.slice(0, boundary) + eol + `## [${version}] - ${date}` + eol + text.slice(boundary),
    changed: true, reason: null };
}

export function latestReleasedVersion(changelogText) {
  let latest = null;
  for (const match of changelogText.matchAll(/^## \[([^\]\r\n]+)\](?:[ \t].*)?\r?$/gm)) {
    const version = validateExplicitVersion(match[1]);
    if (version && (latest === null || compareVersions(version, latest) > 0)) latest = version;
  }
  return latest;
}
