// 默认只报告候选；PATH 发现不证明入口可执行，绝不自动执行候选。
// 执行：node scripts/probes/probe-clis.mjs --execute --cli-config <JSON.local>
// 仅执行配置中的 help.* 用例；版本/help 参数也必须由用户配置声明。
import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCliConfig } from '../lib/cli-config.mjs';
import { runProbe } from '../lib/probe-cli.mjs';
import { parsePathArgs } from '../lib/paths.mjs';

export function discoverEntries(name, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const result = execFileSync('where.exe', [name], {
      encoding: 'utf8', shell: false, windowsHide: true, env, timeout: 5000,
    });
    return [...new Set(result.split(/\r?\n/).map(line => line.trim()).filter(Boolean))]
      .map(path => ({ path, source: 'where.exe（PATH / 当前目录）' }));
  }
  const found = new Map();
  for (const directory of (env.PATH ?? '').split(':')) {
    const path = resolve(directory || '.', name);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      found.set(path, { path, source: `PATH 目录：${directory || '当前目录（空 PATH 项）'}` });
    } catch { /* 不可读、不可执行或不存在的候选不报告。 */ }
  }
  return [...found.values()];
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('用法：node scripts/probes/probe-clis.mjs [--discover] | --execute --cli-config <JSON.local> [--cwd <目录>]');
    console.log('默认只发现；--discover 与 --execute 互斥。执行仅使用配置的 help.* 用例，不使用发现结果，不读取 .env。');
    return;
  }
  const modeFlags = argv.filter(arg => arg === '--discover' || arg === '--execute');
  if (modeFlags.length > 1) throw new Error('--discover / --execute 只能选择一次且互斥');
  const pathArgs = argv.filter(arg => arg !== '--discover' && arg !== '--execute');
  parsePathArgs(pathArgs);
  if (!argv.includes('--execute')) {
    if (pathArgs.length) throw new Error('发现模式不接受配置/路径参数；执行请显式使用 --execute');
    console.log('仅发现：报告候选路径及来源，不启动候选 CLI。');
    for (const name of ['codex', 'claude', 'grok']) {
      try {
        const candidates = discoverEntries(name);
        console.log(`${name}: ${candidates.length ? '候选（未执行）' : '无候选'}`);
        for (const candidate of candidates) console.log(`  ${candidate.path} [${candidate.source}]`);
      } catch (error) {
        if (error.status === 1) console.log(`${name}: 无候选 [where.exe]`);
        else throw new Error(`发现 ${name} 失败：${error.message}`);
      }
    }
    return;
  }
  const loaded = loadCliConfig({ argv: pathArgs });
  const names = Object.keys(loaded.config.cases).filter(name => name.startsWith('help.'));
  if (!names.length) throw new Error('配置缺少 help. 开头的 CLI 用例');
  console.log(`CLI 配置：${loaded.file} [${loaded.source}]`);
  for (const name of names) {
    console.log(`\n=== ${name} ===`);
    const result = await runProbe({ loaded, pathArgs }, name, '', 20000);
    console.log(`退出=${result.status} stdout=${result.stdout.length}B stderr=${result.stderr.length}B`);
    console.log(result.stdout.slice(0, 600));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) {
    console.error(`CLI 发现/探针失败：${error.message}`);
    process.exitCode = 1;
  }
}
