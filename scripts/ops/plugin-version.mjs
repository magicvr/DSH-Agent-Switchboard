// 插件版本收口。默认只读 / dry-run；永不执行 git、包管理器或 shell。
// 用法：node scripts/ops/plugin-version.mjs show
//       node scripts/ops/plugin-version.mjs bump patch [--pre rc | --finalize] [--apply]
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { REPO_ROOT } from '../lib/paths.mjs';
import { CONFIG_FORMAT_VERSION } from '../../src/config-file.js';
import { bumpVersion, validateExplicitVersion, compareVersions, rewriteChangelog, latestReleasedVersion } from '../lib/version.mjs';

function argumentsFor(argv) {
  const command = argv[0] ?? 'show';
  if (!['show', 'bump'].includes(command)) throw new Error(`未知子命令：${command}`);
  const options = { command };
  let index = 1;
  if (command === 'bump') {
    options.target = argv[index++];
    if (!options.target || options.target.startsWith('--')) throw new Error('bump 缺少类型或显式版本');
  }
  for (; index < argv.length; index++) {
    const flag = argv[index];
    if (command === 'show' || !['--pre', '--finalize', '--apply'].includes(flag)) throw new Error(`未知参数：${flag}`);
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`重复参数：${flag}`);
    if (key === 'pre') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--pre 缺少 tag');
      options.pre = value;
    } else options[key] = true;
  }
  if (options.pre !== undefined && options.finalize) throw new Error('--pre 与 --finalize 不能同时使用');
  return options;
}

function atomicWrite(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function main() {
  const options = argumentsFor(process.argv.slice(2));
  const files = ['package.json', 'package-lock.json', 'CHANGELOG.md'];
  const paths = files.map(name => join(REPO_ROOT, name));
  const original = paths.map(path => readFileSync(path, 'utf8'));
  const pkg = JSON.parse(original[0]); const lock = JSON.parse(original[1]);
  const latest = latestReleasedVersion(original[2]);
  if (options.command === 'show') {
    const sites = [['package.json.version', pkg.version], ['dsh.manifestVersion', pkg.dsh?.manifestVersion],
      ['CONFIG_FORMAT_VERSION', CONFIG_FORMAT_VERSION], ['CHANGELOG.md latest', latest],
      ['package-lock.json.version', lock.version], ['package-lock.json packages[""].version', lock.packages?.['']?.version],
      ...Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh'))];
    const width = Math.max(...sites.map(([label]) => label.length));
    for (const [label, value] of sites) console.log(`${label.padEnd(width)} : ${value ?? '(缺失)'}`);
    const disagreements = [];
    if (!validateExplicitVersion(pkg.version)) disagreements.push('package.json.version 不是合法 SemVer');
    for (const [label, value] of [sites[3], sites[4], sites[5]]) {
      if (value !== pkg.version) disagreements.push(`${label} (${value ?? '缺失'}) ≠ package.json.version (${pkg.version})`);
    }
    console.log(`\n${disagreements.length ? 'FAIL  版本不一致' : 'PASS  版本一致'}`);
    for (const detail of disagreements) console.error(`  FAIL  ${detail}`);
    return disagreements.length ? 1 : 0;
  }
  const kind = ['major', 'minor', 'patch'].includes(options.target);
  if (!kind && (options.pre !== undefined || options.finalize)) throw new Error('显式版本不能与 --pre / --finalize 混用');
  const target = kind ? bumpVersion(pkg.version, options.target, options) : validateExplicitVersion(options.target);
  if (!target) throw new Error('显式版本格式无效');
  if (compareVersions(target, pkg.version) <= 0) throw new Error(`目标版本必须严格大于当前版本：${pkg.version} → ${target}`);
  const date = new Date().toISOString().slice(0, 10);
  const changelog = rewriteChangelog(original[2], { version: target, date });
  if (!changelog.changed) throw new Error(`CHANGELOG 拒绝改写：${changelog.reason}`);
  if (!lock.packages?.['']) throw new Error('package-lock.json 缺少 packages[""]');
  console.log('将要做的改动：');
  console.log(`  package.json: version ${pkg.version} → ${target}`);
  console.log(`  package-lock.json: version ${lock.version} → ${target}; packages[""].version ${lock.packages[''].version} → ${target}`);
  console.log(`  CHANGELOG.md: [Unreleased] 正文 → [${target}] - ${date}；插入空 [Unreleased]`);
  pkg.version = target; lock.version = target; lock.packages[''].version = target;
  const next = [JSON.stringify(pkg, null, 2) + '\n', JSON.stringify(lock, null, 2) + '\n', changelog.text];
  if (!options.apply) { console.log('\n未写盘（加 --apply 才写）。'); return 0; }
  // 有意偏离 ops 的 .bak 惯例：这三个文件受 git 版本控制，使用原子写 + 复读校验。
  // 各文件原子替换，不是跨文件事务；中途失败会明确报错，可由 show 检出不一致。
  for (let i = 0; i < paths.length; i++) {
    if (readFileSync(paths[i], 'utf8') !== original[i]) throw new Error(`${files[i]} 已被并发修改，拒绝覆盖`);
  }
  for (let i = 0; i < paths.length; i++) atomicWrite(paths[i], next[i]);
  let failed = false;
  console.log('\n复核：');
  for (let i = 0; i < paths.length; i++) {
    try {
      const actual = readFileSync(paths[i], 'utf8');
      const value = i < 2 ? JSON.parse(actual) : null;
      const valid = actual === next[i] && (i === 0 ? value.version === target
        : i === 1 ? value.version === target && value.packages?.['']?.version === target
          : latestReleasedVersion(actual) === target && /^## \[Unreleased\][ \t]*\r?$/m.test(actual));
      console.log(`  ${valid ? 'PASS' : 'FAIL'}  ${files[i]} 写后复读校验`);
      failed ||= !valid;
    } catch (error) { failed = true; console.error(`  FAIL  ${files[i]} 复读失败：${error.message}`); }
  }
  if (failed) { console.error('FAIL  写后验证失败！请检查三个文件的一致性。'); return 1; }
  console.log(`\nPASS  版本已更新为 ${target}（未 commit / tag）。`);
  return 0;
}

try { process.exitCode = main(); }
catch (error) { console.error(`FAIL  ${error.message}`); process.exitCode = 1; }
