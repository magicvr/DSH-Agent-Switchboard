// 只读探针：解析 Electron asar 归档并输出文件内容，不写任何临时文件。
// 用法：node inline-asar-probe.mjs <archive> <mode> [arg]
//   list-registry          列出 registry 条目
//   ls <dir>               列出目录
//   grep <regex>           在文本文件中搜索，输出 文件:行号:内容
// 注意：--eval 下 process.argv 会多一个占位 argv[1]，因此从 argv[2] 起取参数。
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const archivePath = argv[0];
const mode = argv[1];
const arg = argv[2];

const fd = readFileSync(archivePath);
const headerSize = fd.readUInt32LE(4);
const jsonSize = fd.readUInt32LE(12);
const header = JSON.parse(fd.subarray(16, 16 + jsonSize).toString('utf8'));
const dataStart = 8 + headerSize;

const entries = [];
(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, p);
    else entries.push({ path: p, offset: Number(child.offset ?? 0), size: child.size ?? 0 });
  }
})(header, '');

function readEntry(e) {
  const start = dataStart + e.offset;
  return fd.subarray(start, start + e.size);
}

switch (mode) {
  case 'list-registry': {
    for (const e of entries) {
      if (!e.path.endsWith('package.json')) continue;
      const depth = e.path.split('/').length;
      if (depth > 5) continue;
      try {
        const pkg = JSON.parse(readEntry(e).toString('utf8'));
        if (pkg.name && /dsh|deepseek/i.test(pkg.name)) {
          const dshKeys = Object.keys(pkg.dsh ?? {});
          const hasClient = pkg.dsh?.client ? 'client' : '';
          const hasBundle = pkg.dsh?.bundle ? 'bundle' : '';
          console.log(
            `${e.path.replace(/\/package\.json$/, '')}\t${pkg.name}@${pkg.version}\t` +
              `dsh:[${dshKeys.join(',')}] ${hasBundle} ${hasClient}`,
          );
        }
      } catch {}
    }
    break;
  }
  case 'ls': {
    const needle = arg.replace(/\/$/, '');
    const seen = new Set();
    for (const e of entries) {
      if (!e.path.startsWith(needle + '/')) continue;
      const rest = e.path.slice(needle.length + 1);
      const head = rest.includes('/') ? rest.split('/')[0] + '/' : rest;
      if (seen.has(head)) continue;
      seen.add(head);
      console.log(head);
    }
    break;
  }
  case 'grep': {
    const re = new RegExp(arg);
    let hits = 0;
    for (const e of entries) {
      if (!/\.(js|mjs|cjs|ts|json|md|yml|yaml)$/.test(e.path)) continue;
      if (e.size > 2_000_000) continue;
      let text;
      try {
        text = readEntry(e).toString('utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          console.log(`${e.path}:${i + 1}:${lines[i].trim().slice(0, 300)}`);
          if (++hits >= 250) {
            console.log('--- truncated at 250 hits ---');
            process.exit(0);
          }
        }
      }
    }
    if (!hits) console.log('(no hits)');
    break;
  }
  default:
    console.log(`unknown mode: ${mode}`);
}
