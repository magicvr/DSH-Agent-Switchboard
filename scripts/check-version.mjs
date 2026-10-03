// 版本机制的离线检查；不写仓库、不调用外部 CLI。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/paths.mjs';
import { parseVersion, formatVersion, compareVersions, bumpVersion, validateExplicitVersion,
  rewriteChangelog, latestReleasedVersion } from './lib/version.mjs';

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}
function rejects(fn) {
  try { fn(); return false; } catch { return true; }
}

try {
  section('SemVer 解析与优先级');
  for (const value of ['0.0.1', '1.2.3', '0.2.0-rc.2', '1.0.0-alpha', '1.0.0-alpha.1',
    '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1',
    '1.0.0', '1.2.3+001.sha-abc', '1.2.3-0', '9007199254740993.0.0']) {
    const parsed = parseVersion(value);
    check(`合法版本 ${value}`, parsed !== null && formatVersion(parsed) === value && validateExplicitVersion(value) === value);
  }
  for (const value of ['01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3.4', 'v1.2.3', '1.2.x', '',
    '1.2.3-01', '1.2.3-alpha..1', '1.2.3-', '1.2.3+', '1.2.3+build..x', '1.2.3-a_b',
    '1.2.3\n', ' 1.2.3', null, undefined, 123, {}, []]) {
    check(`拒绝非法版本 ${JSON.stringify(value)}`, parseVersion(value) === null && validateExplicitVersion(value) === null);
  }
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
    '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 0; i < chain.length; i++) {
    check(`${chain[i]} 等于自身`, compareVersions(chain[i], chain[i]) === 0);
    for (let j = i + 1; j < chain.length; j++) {
      check(`${chain[i]} < ${chain[j]}`, compareVersions(chain[i], chain[j]) === -1 && compareVersions(chain[j], chain[i]) === 1);
    }
  }
  check('build 不影响优先级', compareVersions('1.2.3+one', '1.2.3+two') === 0);
  check('numeric 标识低于 alphanumeric', compareVersions('1.0.0-9', '1.0.0-a') === -1);
  check('大整数核心与预发布比较无精度丢失', compareVersions('9007199254740993.0.0', '9007199254740992.0.0') === 1
    && compareVersions('1.0.0-9007199254740993', '1.0.0-9007199254740992') === 1);
  check('parsed 对象可比较', compareVersions(parseVersion('1.0.0'), parseVersion('1.0.1')) === -1);

  section('版本 bump');
  for (const [current, kind, options, expected] of [
    ['0.0.1', 'patch', {}, '0.0.2'], ['0.0.1', 'minor', {}, '0.1.0'], ['0.0.1', 'major', {}, '1.0.0'],
    ['1.2.3', 'minor', {}, '1.3.0'], ['1.2.3', 'major', {}, '2.0.0'],
    ['0.0.1', 'minor', { pre: 'rc' }, '0.1.0-rc.0'],
    ['0.1.0-rc.0', 'minor', { pre: 'rc' }, '0.1.0-rc.1'],
    ['0.1.0-rc.9', 'major', { pre: 'rc' }, '0.1.0-rc.10'],
    ['0.1.0-rc.1.9', 'minor', { pre: 'rc' }, '0.1.0-rc.1.10'],
    ['0.1.0-rc.beta', 'minor', { pre: 'rc' }, '0.1.0-rc.beta.0'],
    ['0.1.0-alpha.1', 'minor', { pre: 'rc' }, '0.2.0-rc.0'],
    ['0.1.0-rc', 'patch', { pre: 'rc' }, '0.1.0-rc.0'],
    ['0.1.0-rc.1+build', 'patch', { finalize: true }, '0.1.0'],
    ['9007199254740993.0.0', 'major', {}, '9007199254740994.0.0'],
  ]) check(`${current} ${kind} ${JSON.stringify(options)} → ${expected}`, bumpVersion(current, kind, options) === expected);
  for (const [label, fn] of [
    ['正式版不能 finalize', () => bumpVersion('1.0.0', 'patch', { finalize: true })],
    ['拒绝畸形当前版本', () => bumpVersion('1.2', 'patch')],
    ['拒绝非法 bump 类型', () => bumpVersion('1.2.3', 'other')],
    ['拒绝非法 pre tag', () => bumpVersion('1.2.3', 'patch', { pre: 'rc.01' })],
    ['拒绝 pre tag 中的 build 元数据', () => bumpVersion('1.2.3', 'patch', { pre: 'rc+build' })],
    ['拒绝冲突选项', () => bumpVersion('1.2.3-rc.0', 'patch', { pre: 'rc', finalize: true })],
  ]) check(label, rejects(fn));

  section('CHANGELOG 收口');
  const prefix = '# Changelog\n\n其他前言。\n\n';
  const body = '\n### Added\n\n- 新功能。\n\n### Fixed\n\n- 修复。\n\n';
  const suffix = '## [0.0.1] - 2026-01-01\n\n旧版正文。\n\n[其他链接]: example\n';
  const fixture = prefix + '## [Unreleased]\n' + body + suffix;
  const result = rewriteChangelog(fixture, { version: '0.0.2', date: '2026-10-03' });
  const expected = prefix + '## [Unreleased]\n\n## [0.0.2] - 2026-10-03\n' + body + suffix;
  check('正文移动、空 Unreleased、其余字节完全保留', result.changed && result.reason === null && result.text === expected);
  check('新发布版本可读取', latestReleasedVersion(result.text) === '0.0.2');
  const repeated = rewriteChangelog(result.text, { version: '0.0.2', date: '2026-10-03' });
  check('重复发布幂等拒绝且文本不变', !repeated.changed && repeated.reason === 'version-already-exists' && repeated.text === result.text);
  check('仅 Unreleased 返回 null', latestReleasedVersion(prefix + '## [Unreleased]\n' + body) === null);
  check('按 SemVer 找到最新发布版本', latestReleasedVersion('## [1.0.0]\n\n## [2.0.0-rc.1]\n') === '2.0.0-rc.1');
  const missing = rewriteChangelog(prefix + suffix, { version: '0.0.2', date: '2026-10-03' });
  check('缺 Unreleased 拒绝且不改变文本', !missing.changed && missing.reason === 'missing-unreleased' && missing.text === prefix + suffix);
  const crlf = rewriteChangelog(fixture.replaceAll('\n', '\r\n'), { version: '0.0.2', date: '2026-10-03' });
  check('CRLF 原样保留', crlf.text === expected.replaceAll('\n', '\r\n'));

  section('仓库版本一致性与依赖约束');
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const latest = latestReleasedVersion(changelog);
  check('package.json 版本合法', validateExplicitVersion(pkg.version) !== null);
  check('lock 根版本一致', lock.version === pkg.version, `${lock.version} / ${pkg.version}`);
  check('lock packages[""] 版本一致', lock.packages?.['']?.version === pkg.version);
  check('CHANGELOG 最新版本一致或仅 Unreleased', latest === null
    ? /^## \[Unreleased\][ \t]*\r?$/m.test(changelog) && !/^## \[(?!Unreleased\])[^\]]+\]/m.test(changelog)
    : latest === pkg.version, `${latest} / ${pkg.version}`);
  check('版本机制不引入 semver 依赖', ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .every(key => !Object.hasOwn(pkg[key] ?? {}, 'semver')));
} catch (error) { check('检查执行完成', false, error.message); }

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
