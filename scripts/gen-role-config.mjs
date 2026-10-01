// 把 raw/agents/*.toml 的角色定义转换成插件 Config 所需的 YAML 片段。
// 产物写入 raw/roles-block.yml，供人工过目后再并入 profile 的 cordis.patch.yml。
// 用法：node scripts/gen-role-config.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parsePathArgs, pathValue, resolvePaths, printPaths } from './lib/paths.mjs';

const pathFlags = ['home', 'profile', 'patch', 'roles-file'];
const options = parsePathArgs(process.argv.slice(2).filter(a => a !== '--dry-run'), [...pathFlags, 'agents-dir', 'output', 'inject']);
const pathArgv = Object.entries(options).filter(([k]) => pathFlags.includes(k)).flatMap(([k, v]) => [`--${k}`, v]);
if (options.inject !== undefined) {
  if (options.patch !== undefined && pathValue(options.patch, '--patch', process.cwd()) !== pathValue(options.inject, '--inject', process.cwd())) {
    throw new Error('--patch 与 --inject 指向不同目标');
  }
  if (options.patch === undefined) pathArgv.push('--patch', options.inject);
}
const paths = resolvePaths({ argv: pathArgv });
if (options.inject !== undefined && options.patch === undefined) paths.sources.patch = '--inject';
printPaths(paths);
const ROOT = paths.repoRoot;
const AGENTS_DIR = options['agents-dir'] === undefined ? join(ROOT, 'raw', 'agents') : pathValue(options['agents-dir'], '--agents-dir', process.cwd());
const OUTPUT = options.output === undefined ? join(ROOT, 'raw', 'roles-block.yml') : pathValue(options.output, '--output', process.cwd());
const dryRun = process.argv.includes('--dry-run');
console.log(`agents: ${AGENTS_DIR} [${options['agents-dir'] === undefined ? '仓库根推导' : '--agents-dir'}]`);
console.log(`output: ${OUTPUT} [${options.output === undefined ? '仓库根推导' : '--output'}]`);
// 注入目标必须先读成功，不能在失败前留下生成产物。
const injectOriginal = options.inject === undefined ? undefined : readFileSync(paths.patch, 'utf8');

/** 角色 TOML 里的模型名 → DSH 的 LLM route。经与 profile 的 llm-pi-ai 模型列表核对。 */
const ROUTE = { provider: 'self' };

/** 角色的展示名与只读判定来自设计意图，不来自 TOML（TOML 里没有这些字段）。 */
const PRESENTATION = {
  scout: { title: '侦察员', readOnly: true },
  worker: { title: '实现者', readOnly: false },
  architect: { title: '架构师', readOnly: true },
  reviewer: { title: '审查员', readOnly: true },
};

const ORDER = ['scout', 'worker', 'architect', 'reviewer'];

/**
 * 极简 TOML 读取：只处理本项目里实际用到的形态
 * —— 顶层的 `key = "..."` 与 `key = """..."""` 多行字符串。
 * 刻意不引 TOML 依赖（decisions.md 的格式决策是「只用 JSON/YAML」）。
 *
 * @param {string} text - TOML 文件内容。
 * @returns {Record<string, string>} 顶层键值。
 */
function parseToml(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const basic = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (basic) {
      out[basic[1]] = basic[2];
      i++;
      continue;
    }
    const multi = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"""\s*$/.exec(line);
    if (multi) {
      const key = multi[1];
      const body = [];
      i++;
      while (i < lines.length && !/^"""\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // 跳过结束的 """
      out[key] = body.join('\n');
      continue;
    }
    i++;
  }
  return out;
}

/** 把一段文本渲染成 YAML 的 `|` 字面块标量（保留换行）。 */
function blockScalar(text, indent) {
  const pad = ' '.repeat(indent);
  const lines = text.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  return ['|', ...lines.map((l) => (l.length > 0 ? pad + l : ''))].join('\n');
}

const roles = [];
for (const name of ORDER) {
  const toml = readFileSync(join(AGENTS_DIR, `${name}.toml`), 'utf8');
  const parsed = parseToml(toml);
  if (!parsed.model || !parsed.developer_instructions) {
    console.error(`[gen-role-config] ${name}.toml 缺少 model 或 developer_instructions`);
    process.exit(1);
  }
  roles.push({
    id: name,
    title: PRESENTATION[name]?.title,
    description: parsed.description ?? '',
    model: parsed.model,
    effort: parsed.model_reasoning_effort ?? 'medium',
    readOnly: PRESENTATION[name]?.readOnly === true,
    instructions: parsed.developer_instructions,
    /**
     * 嵌套派发策略：只有 worker 允许（它需要能派发 scout 去查资料）。
     * 其余角色默认关闭（decisions.md D11）。
     */
    allowNestedDispatch: name === 'worker',
  });
}

// ---------------------------------------------------------------------------
// 追加一个 CLI 后端的角色，用来验证 Phase 3 的跨 CLI 派发。
//
// `cliCommand` 用 PATH 里的 `node`（而非 `C:\Program Files\nodejs\node.exe`）：
// 绝对路径在仓库配置里不可移植，而 `node` 由 `ctx.subprocess.resolveExecutable`
// 解析。`codex.js` 的路径必须绝对，因为它是 node 的脚本参数。
// ---------------------------------------------------------------------------
const roaming = Object.hasOwn(process.env, 'APPDATA')
  ? pathValue(process.env.APPDATA, 'APPDATA', process.cwd())
  : process.platform === 'win32' ? join(homedir(), 'AppData', 'Roaming') : undefined;
if (roaming === undefined) throw new Error('请设置 APPDATA 以指定 Codex npm 安装目录');
console.log(`npm roaming: ${roaming} [${Object.hasOwn(process.env, 'APPDATA') ? 'APPDATA' : 'os.homedir() 推导'}]`);
const CODEX_JS = join(
  roaming,
  'npm',
  'node_modules',
  '@openai',
  'codex',
  'bin',
  'codex.js',
);

roles.push({
  id: 'codex-scout',
  title: 'Codex 侦察员',
  description:
    'Read-only exploration and evidence gathering, delegated to the local Codex CLI instead of a DSH subagent. ' +
    'Use for repository search, wide reading, symbol discovery and factual verification when you specifically want ' +
    'the Codex agent (its own model and tooling) rather than the built-in scout. Read-only.',
  model: 'gpt-6-astra',
  effort: 'medium',
  readOnly: true,
  backend: 'cli',
  allowNestedDispatch: false,
  cli: {
    command: 'node',
    prefixArgs: [CODEX_JS],
    // 提示词走 stdin（codex exec - 即从此读取），因此模板里没有 {prompt}。
    // `-s read-only` 是 codex 自己的沙箱参数 —— CLI 后端的「只读」只能这样实现
    // （toolFilter 只对 builtin provider 有效，见 D7）。
    args: ['exec', '-s', 'read-only', '--skip-git-repo-check', '-m', '{model}', '-c', 'model_reasoning_effort={effort}', '-'],
    promptDelivery: 'stdin',
    cwd: ROOT,
    graceMs: 3000,
  },
  instructions:
    'You are a read-only exploration agent working through the Codex CLI. ' +
    'Answer the delegated question directly and concisely, with file paths and line references as evidence. ' +
    'Report facts and their evidence; do not modify any file.',
});

// 手工渲染 YAML：字符串用双引号转义，长文本用块标量。
const q = (s) => JSON.stringify(s);
const out = [];
out.push('  provider: self');
out.push('  maxDepth: 3');
out.push(`  cwd: ${q(ROOT)}`);
out.push('  roles:');
for (const r of roles) {
  out.push(`    - id: ${q(r.id)}`);
  if (r.title) out.push(`      title: ${q(r.title)}`);
  out.push(`      description: ${q(r.description)}`);
  out.push(`      model: ${q(r.model)}`);
  out.push(`      effort: ${q(r.effort)}`);
  out.push(`      readOnly: ${r.readOnly}`);
  out.push(`      backend: ${r.backend ?? 'spawn'}`);
  out.push(`      allowNestedDispatch: ${r.allowNestedDispatch}`);
  if (r.cli) {
    out.push(`      cliCommand: ${q(r.cli.command)}`);
    out.push(`      cliPrefixArgs: [${r.cli.prefixArgs.map(q).join(', ')}]`);
    out.push(`      cliArgs: [${r.cli.args.map(q).join(', ')}]`);
    out.push(`      cliPromptDelivery: ${q(r.cli.promptDelivery)}`);
    out.push(`      cliCwd: ${q(r.cli.cwd)}`);
    out.push(`      cliGraceMs: ${r.cli.graceMs}`);
  }
  out.push(`      instructions: ${blockScalar(r.instructions, 8)}`);
}

const body = out.join('\n') + '\n';
if (!dryRun) writeFileSync(OUTPUT, body, 'utf8');

console.log(dryRun ? '--dry-run：未写入配置块。' : `已生成 ${OUTPUT}`);
console.log(`角色数：${roles.length}`);
for (const r of roles) {
  console.log(
    `  ${r.id.padEnd(12)} backend=${String(r.backend ?? 'spawn').padEnd(6)} model=${String(r.model).padEnd(14)} ` +
      `effort=${String(r.effort).padEnd(7)} readOnly=${String(r.readOnly).padEnd(5)} ` +
      `nested=${String(r.allowNestedDispatch).padEnd(5)} instructions=${r.instructions.length} 字符`,
  );
}

// ---------------------------------------------------------------------------
// 可选：把配置块注入某个 profile 的 cordis.patch.yml
// 用法：node scripts/gen-role-config.mjs --inject <patch 路径> [--dry-run]
// 会先备份为 <patch>.bak-<时间戳>。只替换 agent-switchboard 条目的 config。
// ---------------------------------------------------------------------------
if (options.inject !== undefined) {
  const patchPath = paths.patch;

  const original = injectOriginal;
  const lines = original.replace(/\r\n/g, '\n').split('\n');

  // 定位我们的条目，并圈定它所属的顶层条目范围。
  const entryStart = lines.findIndex((l) => /^-\s+id:\s*agent-switchboard\s*$/.test(l));
  if (entryStart === -1) {
    console.error(`在 ${patchPath} 中找不到 "- id: agent-switchboard" 条目`);
    process.exit(1);
  }
  let entryEnd = lines.length;
  for (let i = entryStart + 1; i < lines.length; i++) {
    if (/^-\s/.test(lines[i])) {
      entryEnd = i;
      break;
    }
  }

  const entryLines = lines.slice(entryStart, entryEnd);
  // 条目级字段（disabled / name / inject）必须排在 `config:` **之前**：
  // YAML 里同缩进的键属于同一个映射，把 disabled 放在 config 之后会被吞进 config。
  const beforeConfig = entryLines
    .filter((l) => /^\s+(disabled|name|inject):/.test(l))
    .map((l) => l.trimEnd());
  const disabledLine = beforeConfig.find((l) => /disabled:/.test(l));

  const indented = body
    .replace(/\n+$/, '')
    .split('\n')
    .map((l) => (l.length > 0 ? '  ' + l : ''));

  const rebuilt = [lines[entryStart], ...beforeConfig, '  config:', ...indented];

  const next = [...lines.slice(0, entryStart), ...rebuilt, ...lines.slice(entryEnd)];
  const serialized = next.join('\n').replace(/\n*$/, '\n');

  console.log('');
  console.log(`目标条目：第 ${entryStart + 1}–${entryEnd} 行 → 重建为 ${rebuilt.length} 行`);
  console.log(`保留的字段：${beforeConfig.map((l) => l.trim()).join(', ') || '(无)'}`);
  if (disabledLine) console.log(`注意：保留了你手写的 "${disabledLine.trim()}"，置于 config 之前`);

  if (dryRun) {
    console.log('\n--dry-run：未写入。');
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${patchPath}.bak-${stamp}`;
    writeFileSync(backup, original, 'utf8');
    writeFileSync(patchPath, serialized, 'utf8');
    console.log(`\n已备份原文件到 ${backup}`);
    console.log(`已写入 ${patchPath}`);
  }

  // 权威校验：用真正的 YAML 解析器确认合并后的文件可解析且结构正确。
  // 这一步在写盘**之后**执行，因此即使校验失败也留有备份。
  try {
    const { parse } = await import('yaml');
    const doc = parse(serialized);
    const entry = Array.isArray(doc)
      ? doc.find((row) => row && row.id === 'agent-switchboard')
      : undefined;
    if (!entry) {
      console.error('校验失败：解析结果里找不到 agent-switchboard 条目');
      process.exitCode = 1;
    } else {
      const cfg = entry.config ?? {};
      const roleList = Array.isArray(cfg.roles) ? cfg.roles : [];
      console.log('\n=== YAML 校验（用 yaml 解析合并结果） ===');
      console.log(`顶层条目数：${doc.length}`);
      console.log(`条目字段：${Object.keys(entry).join(', ')}`);
      console.log(`disabled = ${JSON.stringify(entry.disabled)}`);
      console.log(`config.provider = ${JSON.stringify(cfg.provider)}`);
      console.log(`config.maxDepth = ${JSON.stringify(cfg.maxDepth)}`);
      console.log(`config.cwd = ${JSON.stringify(cfg.cwd)}`);
      console.log(`config.roles 数量 = ${roleList.length}`);
      for (const r of roleList) {
        console.log(
          `  ${String(r.id).padEnd(12)} backend=${String(r.backend ?? 'spawn').padEnd(6)} ` +
            `model=${String(r.model).padEnd(14)} effort=${String(r.effort).padEnd(7)} ` +
            `instructions=${typeof r.instructions === 'string' ? r.instructions.length : 'INVALID'} 字符`,
        );
      }

      const problems = [];
      for (const r of roleList) {
        if (typeof r.instructions !== 'string' || r.instructions.length < 100) {
          problems.push(`${r.id}: instructions 不完整`);
        }
        if (r.backend === 'cli') {
          // CLI 角色的关键字段必须被解析成正确类型，否则装载期才会报错。
          if (typeof r.cliCommand !== 'string' || r.cliCommand.length === 0) {
            problems.push(`${r.id}: cliCommand 缺失或类型错误`);
          }
          if (!Array.isArray(r.cliArgs) || r.cliArgs.length === 0) {
            problems.push(`${r.id}: cliArgs 不是非空数组`);
          } else if (!r.cliArgs.every((a) => typeof a === 'string')) {
            problems.push(`${r.id}: cliArgs 含非字符串元素`);
          }
          if (r.cliPromptDelivery === 'stdin' && r.cliArgs.some((a) => a.includes('{prompt}'))) {
            problems.push(`${r.id}: stdin 模式下 cliArgs 含 {prompt}（提示词会被传两次）`);
          }
          if (typeof r.cliCwd !== 'string') problems.push(`${r.id}: cliCwd 缺失`);
        }
      }
      if (problems.length > 0) {
        console.error(`校验失败（${problems.length} 处）：`);
        for (const p of problems) console.error(`  - ${p}`);
        process.exitCode = 1;
      } else {
        console.log(`结构校验通过：${roleList.length} 个角色的关键字段均为正确类型`);
      }
    }
  } catch (error) {
    console.error(`YAML 校验无法执行（缺 yaml 包或解析失败）：${error.message}`);
    process.exitCode = 1;
  }
}
