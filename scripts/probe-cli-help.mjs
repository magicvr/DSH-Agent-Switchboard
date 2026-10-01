// 从 --help 里抽取「非交互调用形态」与「模型/强度 flag」候选行，便于人工核实。
//
// ⚠️ 本脚本只**筛选** help 文本，不推断行为。按 `decisions.md` D12 的教训，help 里有
// 不等于真的生效（codex 的 `model_reasoning_effort` 在 help 里完全没出现）。
// 因此这里的输出只是**候选**，是否生效必须靠真实调用验证（见 scripts/probe-cli-run.mjs）。
//
// 用法：node scripts/probe-cli-help.mjs
import { spawnSync } from 'node:child_process';

/** 入口（与本机实测一致，见 scripts/probe-clis.mjs 的输出）。 */
const ENTRIES = {
  codex: [process.execPath, `${process.env.APPDATA}\\npm\\node_modules\\@openai\\codex\\bin\\codex.js`],
  claude: ['C:\\Users\\magicvr\\.local\\bin\\claude.exe'],
  grok: ['C:\\Users\\magicvr\\.grok\\bin\\grok.exe'],
};

/**
 * 跑一次 help。
 *
 * @param {string[]} argv - argv 前缀。
 * @param {string[]} args - 参数。
 * @returns {string} stdout+stderr。
 */
function run(argv, args) {
  const r = spawnSync(argv[0], [...argv.slice(1), ...args], {
    encoding: 'utf8',
    timeout: 25000,
    shell: false,
    windowsHide: true,
  });
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
}

/** 关心的关键字。 */
const KEYS = [
  /--print\b|-p,|non-?interactive|Non-interactive/i,
  /--model\b|-m,|--model </i,
  /effort|reasoning/i,
  /--output-format|--input-format/i,
  /--permission-mode|--sandbox|--allowedTools|--disallowedTools|--allow\b|--deny\b|--always-approve/i,
  /--cwd\b|--cd\b|--add-dir|worktree/i,
  /stdin|pipe/i,
];

for (const [name, argv] of Object.entries(ENTRIES)) {
  console.log(`\n${'='.repeat(64)}\n${name}\n${'='.repeat(64)}`);
  const text = run(argv, ['--help']);
  const lines = text.split('\n');
  const hits = new Set();
  lines.forEach((l, i) => {
    if (KEYS.some((re) => re.test(l))) {
      // 取该行及后续两行（help 常有换行续写）
      for (let k = i; k < Math.min(lines.length, i + 3); k++) hits.add(k);
    }
  });
  const sorted = [...hits].sort((a, b) => a - b);
  if (sorted.length === 0) {
    console.log('  （无匹配行）');
    continue;
  }
  let prev = -2;
  for (const i of sorted) {
    if (i > prev + 1) console.log('  ---');
    console.log(`  ${lines[i].trimEnd()}`);
    prev = i;
  }
}
