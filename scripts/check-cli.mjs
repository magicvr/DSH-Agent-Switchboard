// CLI 层的离线验证：argv 模板解析与输出解析。不依赖 dsh 运行时，无需重启。
// 用法：node scripts/check-cli.mjs
import {
  PLACEHOLDERS,
  buildArgs,
  buildInvocation,
  findUnknownPlaceholders,
  validateTemplate,
} from '../src/cli/argv.js';
import { classifyRun, formatRunResult, parseRouteFacts } from '../src/cli/output.js';
import { cliProviderNameFor } from '../src/cli/provider.js';
import { normalizeRole, toolConfigFor } from '../src/roles.js';

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
function throws(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
}

section('模板校验');
{
  // 提示词走 stdin 是首选路径（codex exec - 即如此），此时模板不该含 {prompt}。
  check('stdin 模式：合法模板通过', validateTemplate(['exec', '-', '-s', 'read-only']).length === 0);
  check('非数组被拒', validateTemplate('nope').length === 1);
  check('非字符串元素被拒', validateTemplate(['exec', 42]).length === 1);

  const stdinWithPrompt = validateTemplate(['exec', '{prompt}']);
  check(
    'stdin 模式却含 {prompt} 被拒（防提示词被传两次）',
    stdinWithPrompt.some((e) => e.includes('传两次')),
    stdinWithPrompt.join('; '),
  );

  const argvNoPrompt = validateTemplate(['exec', '-s', 'read-only'], { promptDelivery: 'argv' });
  check('argv 模式缺 {prompt} 被拒', argvNoPrompt.some((e) => e.includes('必须包含 {prompt}')), argvNoPrompt.join('; '));
  check('argv 模式含 {prompt} 通过', validateTemplate(['-p', '{prompt}'], { promptDelivery: 'argv' }).length === 0);

  const badDelivery = validateTemplate(['exec', '-'], { promptDelivery: 'carrier-pigeon' });
  check('非法 promptDelivery 被拒', badDelivery.some((e) => e.includes('carrier-pigeon')), badDelivery.join('; '));

  const unknown = validateTemplate(['exec', '{promt}']);
  check('拼错占位符被拒', unknown.some((e) => e.includes('{promt}')), unknown.join('; '));

  check('识别的占位符集合', PLACEHOLDERS.join(',') === 'prompt,cwd,model,effort');
}

section('findUnknownPlaceholders');
{
  const found = findUnknownPlaceholders(['{prompt}', '{cwd}', '{nope}', '{alsoBad}']);
  check('只报未知项', found.length === 2 && found.includes('nope') && found.includes('alsoBad'), found.join(','));
  check('无未知项时为空', findUnknownPlaceholders(['{prompt}', '{model}']).length === 0);
}

section('占位符替换：基本行为');
{
  const argv = buildArgs(['exec', '-m', '{model}', '-'], {
    prompt: 'hello',
    model: 'gpt-6-luna',
  });
  check('替换正确', JSON.stringify(argv) === JSON.stringify(['exec', '-m', 'gpt-6-luna', '-']), JSON.stringify(argv));

  const withDash = buildArgs(['exec', '-'], { prompt: 'P' });
  check('元素内 {prompt} 被替换', withDash[1] === '-');

  const inline = buildArgs(['--prompt={prompt}'], { prompt: 'XYZ' });
  check('同一元素内混合字面量与占位符', inline[0] === '--prompt=XYZ', inline[0]);

  const missing = buildArgs(['exec', '--effort', '{effort}', '-'], { prompt: 'P' });
  check('缺省值替换为空串并丢弃该元素', missing.includes('--effort') && !missing.includes(''), JSON.stringify(missing));
}

section('替换的安全性：元素边界');
{
  // 关键性质：提示词里的空格/引号不会把它裂成多个 argv 元素。
  const evil = 'a b "c" \'d\'';
  const argv = buildArgs(['exec', '{prompt}'], { prompt: evil });
  check('含空格的提示词仍是单个元素', argv.length === 2 && argv[1] === evil, JSON.stringify(argv));

  // 关键性质：无 shell，故 shell 元字符只是普通文本。
  const shellish = '; rm -rf / | cat && echo $(whoami) `id`';
  const argv2 = buildArgs(['exec', '{prompt}'], { prompt: shellish });
  check('shell 元字符不被解释、仍是单元素', argv2.length === 2 && argv2[1] === shellish);

  // 关键性质：模型无法把提示词"逃逸"成一个新选项。
  const flagish = '--dangerously-bypass-approvals-and-sandbox';
  const argv3 = buildArgs(['exec', '{prompt}'], { prompt: flagish });
  check('提示词内容是独立元素，不改变模板结构', argv3[0] === 'exec' && argv3[1] === flagish);

  // 换行会破坏"单元素"前提，必须拒绝。
  const nl = throws(() => buildArgs(['exec', '{prompt}'], { prompt: 'line1\nline2' }));
  check('含换行的值被拒绝', nl !== null && nl.includes('换行'), String(nl));

  const nul = throws(() => buildArgs(['exec', '{prompt}'], { prompt: 'a\0b' }));
  check('含 NUL 的值被拒绝', nul !== null && nul.includes('NUL'), String(nul));

  const cr = throws(() => buildArgs(['exec', '{prompt}'], { prompt: 'a\rb' }));
  check('含回车的值被拒绝', cr !== null, String(cr));

  const badType = throws(() => buildArgs(['exec', '{prompt}'], { prompt: 42 }));
  check('非字符串值被拒绝', badType !== null, String(badType));

  const unknownRun = throws(() => buildArgs(['exec', '{nope}'], { prompt: 'P' }));
  check('运行时遇未知占位符抛错（不静默当文本）', unknownRun !== null && unknownRun.includes('nope'), String(unknownRun));
}

section('buildInvocation');
{
  const inv = buildInvocation({
    command: 'C:/node.exe',
    prefixArgs: ['C:/codex.js'],
    args: ['exec', '-m', '{model}', '-'],
    values: { model: 'gpt-6-luna' },
  });
  check(
    'argv[0] 就是可执行文件',
    inv.argv[0] === 'C:/node.exe',
    JSON.stringify(inv.argv),
  );
  check(
    'argv = [command, ...prefixArgs, ...模板结果]',
    JSON.stringify(inv.argv) === JSON.stringify(['C:/node.exe', 'C:/codex.js', 'exec', '-m', 'gpt-6-luna', '-']),
    JSON.stringify(inv.argv),
  );
  check('返回的是数组而非拼接字符串', Array.isArray(inv.argv));
  check('空 command 被拒', throws(() => buildInvocation({ command: '  ', args: ['{prompt}'], values: {} })) !== null);

  // 只有一种表示：调用方不需要自己把 command 拼到前面。
  const noPrefix = buildInvocation({ command: 'codex', args: ['exec', '-'], values: {} });
  check('无 prefixArgs 时 argv 仍以 command 开头', noPrefix.argv[0] === 'codex' && noPrefix.argv.length === 3, JSON.stringify(noPrefix.argv));
}

section('parseRouteFacts：codex 的真实 stderr');
{
  const stderr = [
    'OpenAI Codex v0.159.2',
    '--------',
    'workdir: C:\\Users\\magicvr\\Documents\\Code\\DSH-Agent-Switchboard',
    'model: gpt-6-astra',
    'provider: openai',
    'approval: never',
    'sandbox: read-only',
    'reasoning effort: high',
    '',
    'some later output with model: text that must not win',
  ].join('\n');
  const facts = parseRouteFacts(stderr);
  check('抽到 model', facts.model === 'gpt-6-astra');
  check('抽到 reasoning effort', facts['reasoning effort'] === 'high');
  check('抽到 sandbox', facts.sandbox === 'read-only');
  check(
    '不误抽后文里形如 model: 的行',
    facts.model === 'gpt-6-astra',
    `实际 ${facts.model}`,
  );
  check('空 stderr 返回空对象', Object.keys(parseRouteFacts('')).length === 0);
  check('非字符串返回空对象', Object.keys(parseRouteFacts(null)).length === 0);
}

section('classifyRun');
{
  check('退出码 0 → ok', classifyRun({ exitCode: 0 }).ok === true);
  check('退出码 1 → 失败并说明', classifyRun({ exitCode: 1 }).reason === 'exit code 1');
  check('超时 → timeout', classifyRun({ exitCode: null, timedOut: true }).reason === 'timeout');
  check('信号 → 说明信号', classifyRun({ exitCode: null, signal: 'SIGTERM' }).reason === 'terminated by SIGTERM');
  check('无退出码 → 失败', classifyRun({ exitCode: null }).ok === false);
}

section('formatRunResult');
{
  const ok = formatRunResult({
    roleId: 'scout',
    command: 'C:/node.exe',
    argv: ['C:/codex.js', 'exec', '-'],
    exitCode: 0,
    stdout: 'SWITCHBOARD_PROBE_OK\n',
    stderr: 'model: gpt-6-luna\nreasoning effort: medium\n',
    durationMs: 18200,
  });
  check('成功时 ok=true', ok.ok === true);
  check('回传含角色与后端', ok.text.includes('role=scout') && ok.text.includes('backend=cli'));
  check('回传含 argv（可审计无 shell）', ok.text.includes('C:/codex.js'));
  check('回传含退出码', ok.text.includes('exit=0'));
  check('回传含耗时', ok.text.includes('duration=18.2s'));
  check('回传含 CLI 自报路由', ok.text.includes('gpt-6-luna') && ok.text.includes('medium'));
  check('回传含正文', ok.text.includes('SWITCHBOARD_PROBE_OK'));

  const bad = formatRunResult({
    roleId: 'worker',
    command: 'C:/node.exe',
    argv: ['C:/codex.js', 'exec', '-'],
    exitCode: 1,
    stdout: '',
    stderr: 'stream error: model not found\n',
  });
  check('失败时 ok=false', bad.ok === false);
  check('失败时标明原因', bad.text.includes('exit code 1'));
  check('失败时保留 stderr', bad.text.includes('model not found'));
  check('失败且无正文时明确说明', bad.text.includes('未产生标准输出'));

  const noRoute = formatRunResult({
    roleId: 'r',
    command: 'c',
    argv: [],
    exitCode: 0,
    stdout: 'x',
    stderr: '',
  });
  check('无路由事实时明确标注不臆造', noRoute.text.includes('未自报路由事实'));
  check('route 字段为空对象', Object.keys(noRoute.route).length === 0);
}

section('provider 命名一致性（跨模块）');
{
  // 工具实例的 `provider` 字段由 roles.js 的 toolConfigFor 生成，
  // 而注册名由 provider.js 的 createCliProvider 生成。两者不一致会让工具在
  // 装载期找不到 provider —— 这类跨模块契约必须有断言锁住，不能靠人记住。
  const role = normalizeRole(
    {
      id: 'codex-scout',
      description: 'd',
      instructions: 'i',
      backend: 'cli',
      // ⚠️ CLI 角色必须显式给模型：不传 `-m` 时 codex 会静默使用它自己的配置。
      model: 'gpt-6-luna',
      cliCommand: 'node',
      cliArgs: ['exec', '-'],
      cliCwd: 'C:/w',
    },
    0,
    undefined,
    'C:/w',
  ).role;

  check('cli 角色规范化成功', role !== null);
  const cfg = toolConfigFor(role, { maxDepth: 3 });
  check(
    'toolConfigFor 的 provider 名 = cliProviderNameFor 的注册名',
    cfg.provider === cliProviderNameFor(role.id),
    `tool=${cfg.provider} provider=${cliProviderNameFor(role.id)}`,
  );
  check('provider 名含角色 id', cfg.provider === 'switchboard-cli-codex-scout', cfg.provider);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);