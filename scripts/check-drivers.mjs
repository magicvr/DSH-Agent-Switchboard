// CLI 驱动预设的离线验证。
//
// 为什么需要：驱动表是「界面一键填好」与「实际调用」共用的同一份数据。它一旦有错，
// 用户点一下就会得到一条**看起来对、实际跑不通**的命令 —— 而这类错误在真机上表现为
// 「派发失败」，很难定位到预设本身。因此这里把每条驱动的形状钉死。
//
// ⚠️ 本文件**不声称**这些命令在本机一定能跑通：那属于真机验证，见
// `docs/cli-backends.md` 与 `scripts/probe-cli-run*.mjs`。这里只验证**结构不变量**。
//
// 用法：node scripts/check-drivers.mjs
import {
  CLI_DRIVERS,
  CLI_DRIVER_IDS,
  cliDriverFor,
  cliFieldsFor,
  inferCliDriver,
  resolveDriverPlaceholders,
  DRIVER_PLACEHOLDERS,
} from '../src/cli/drivers.js';
import { validateTemplate, buildInvocation } from '../src/cli/argv.js';

let pass = 0;
let fail = 0;
/**
 * 断言。
 *
 * @param {string} label - 说明。
 * @param {boolean} condition - 条件。
 * @param {string} [detail] - 失败详情。
 */
function check(label, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
/** @param {string} title - 小节标题。 */
function section(title) {
  console.log(`\n=== ${title} ===`);
}

section('驱动表结构');
{
  // ⚠️ 断言的是**当前实际提供的集合**，不是「越多越好」。
  //    Claude Code 预设已移除（用户长期不用，明确要求排除），因此不在列。
  //    日后若要恢复，连同本行与 `check-client.mjs` 的数量断言一起改。
  check(
    '驱动集合恰为 codex / grok / custom',
    CLI_DRIVER_IDS.slice().sort().join(',') === 'codex,custom,grok',
    CLI_DRIVER_IDS.join(','),
  );
  check('不含 claude（已按用户要求排除）', !CLI_DRIVER_IDS.includes('claude'), CLI_DRIVER_IDS.join(','));
  check('custom 始终在表内（自定义兜底）', CLI_DRIVER_IDS.includes('custom'));
  const ids = new Set();
  for (const d of CLI_DRIVERS) {
    check(`${d.id}：id 唯一`, !ids.has(d.id));
    ids.add(d.id);
    check(`${d.id}：有 label`, typeof d.label === 'string' && d.label.length > 0);
    check(`${d.id}：有 description`, typeof d.description === 'string' && d.description.length > 0);
    check(`${d.id}：args 是函数`, typeof d.args === 'function');
    check(
      `${d.id}：promptDelivery 合法`,
      d.promptDelivery === 'stdin' || d.promptDelivery === 'argv',
      String(d.promptDelivery),
    );
  }
}

section('`{prompt}` 与传递方式必须自洽');
{
  // `argv` 传递要求模板里**必须**有 `{prompt}`，否则提示词永远不会被传给子进程；
  // `stdin` 传递要求**不能**把 `{prompt}` 放进参数（会变成空参数或被误拼）。
  for (const d of CLI_DRIVERS) {
    if (d.id === 'custom') continue;
    for (const readOnly of [true, false]) {
      const args = d.args(readOnly);
      const hasPrompt = args.some((a) => a.includes('{prompt}'));
      if (d.promptDelivery === 'argv') {
        check(
          `${d.id}(readOnly=${readOnly})：argv 传递时模板含 {prompt}`,
          hasPrompt,
          JSON.stringify(args),
        );
      } else {
        check(
          `${d.id}(readOnly=${readOnly})：stdin 传递时模板不含 {prompt}`,
          !hasPrompt,
          JSON.stringify(args),
        );
      }
    }
  }
}

section('模板必须通过 argv.js 的既有校验（占位符契约不许被扩张）');
{
  // 驱动不得引入 `args.js` 不认识的占位符 —— 这是 AGENTS.md 硬规则 4
  //「模型只能填充受限占位符」的具体落点。
  for (const d of CLI_DRIVERS) {
    if (d.id === 'custom') continue;
    for (const readOnly of [true, false]) {
      const args = d.args(readOnly);
      const errors = validateTemplate(args, { promptDelivery: d.promptDelivery });
      check(`${d.id}(readOnly=${readOnly})：模板合法`, errors.length === 0, errors.join('; '));
    }
  }
  // 用一个「不该被接受」的占位符做反例，证明上面的断言不是恒真。
  const bogus = validateTemplate(['--x', '{nope}'], { promptDelivery: 'stdin' });
  check('未知占位符 {nope} 会被拒绝（反例，证明断言有效）', bogus.length > 0, JSON.stringify(bogus));
}

section('只读状态必须真的改变参数（否则 readOnly 对 CLI 无效）');
{
  for (const d of CLI_DRIVERS) {
    if (d.id === 'custom') continue;
    const a = JSON.stringify(d.args(true));
    const b = JSON.stringify(d.args(false));
    check(`${d.id}：readOnly 会改变参数`, a !== b, '两种只读状态产出相同参数，readOnly 形同虚设');
  }
}

section('cliFieldsFor：产出完整且可用的四件套');
{
  for (const d of CLI_DRIVERS) {
    if (d.id === 'custom') continue;
    for (const readOnly of [true, false]) {
      const f = cliFieldsFor(d.id, readOnly);
      check(`${d.id}(readOnly=${readOnly})：产出非空`, f !== undefined);
      if (f === undefined) continue;
      check(`${d.id}(readOnly=${readOnly})：command 非空`, f.cliCommand.length > 0, f.cliCommand);
      check(`${d.id}(readOnly=${readOnly})：args 非空`, f.cliArgs.length > 0);
      check(
        `${d.id}(readOnly=${readOnly})：promptDelivery 与驱动一致`,
        f.cliPromptDelivery === d.promptDelivery,
      );
      // 产出必须能直接通过校验 —— 「界面填好的」与「Host 接受的」不能是两回事。
      const errors = validateTemplate(f.cliArgs, { promptDelivery: f.cliPromptDelivery });
      check(`${d.id}(readOnly=${readOnly})：产出可直接通过校验`, errors.length === 0, errors.join('; '));
    }
  }
  check('custom 不产出字段（让用户自己填）', cliFieldsFor('custom', true) === undefined);
  check('未知 id 不产出字段', cliFieldsFor('nope', true) === undefined);
}

section('占位符解析：{node} / {npmRoot} 必须变成真实路径，且不得残留');
{
  check('{node} 解析为 node 可执行文件', resolveDriverPlaceholders('{node}') === process.execPath);
  check('{npmRoot} 解析为非空路径', resolveDriverPlaceholders('{npmRoot}').length > 0);
  for (const [key] of Object.entries(DRIVER_PLACEHOLDERS)) {
    check(`解析后不残留 {${key}}`, !resolveDriverPlaceholders(`x{${key}}y`).includes(`{${key}}`));
  }
  // codex 的可用入口形态：`node <codex.js>`，因此 prefixArgs 解析后必须是一个绝对路径。
  const codex = CLI_DRIVERS.find((d) => d.id === 'codex');
  const resolved = codex.prefixArgs.map(resolveDriverPlaceholders);
  check('codex 前缀参数解析后是绝对路径', resolved.every((p) => /^[A-Za-z]:\\/.test(p)), JSON.stringify(resolved));
  check(
    'codex 前缀参数指向 codex.js（而非 .ps1 / .cmd）',
    resolved.some((p) => p.endsWith('codex.js')),
    JSON.stringify(resolved),
  );

  // ⚠️ 非字符串输入必须原样降级，不得抛错：本函数会被 `normalizeRole` 对用户配置的
  //    任意值调用，抛错会把「配置错误」升级成「装载失败」。实测踩到过。
  for (const bad of [undefined, null, 42, {}, []]) {
    let threw = false;
    try {
      resolveDriverPlaceholders(bad);
    } catch {
      threw = true;
    }
    check(`非字符串输入（${JSON.stringify(bad)}）不抛错`, !threw);
  }
}

section('inferCliDriver：反推必须与选择一致，自定义不得被误认');
{
  for (const d of CLI_DRIVERS) {
    if (d.id === 'custom') continue;
    for (const readOnly of [true, false]) {
      const f = cliFieldsFor(d.id, readOnly);
      const role = { ...f, readOnly };
      check(`${d.id}(readOnly=${readOnly})：反推回自身`, inferCliDriver(role) === d.id, inferCliDriver(role));
    }
  }
  // 手工改过一个字段 → 必须落到 custom，否则界面会把用户的配置**显示**成某个预设。
  const modified = { ...cliFieldsFor('grok', true), cliArgs: ['--custom'] };
  check('参数被改过 → 反推为 custom', inferCliDriver(modified) === 'custom', inferCliDriver(modified));
  const wrongCmd = { ...cliFieldsFor('codex', true), cliCommand: 'something-else' };
  check('命令被改过 → 反推为 custom', inferCliDriver(wrongCmd) === 'custom', inferCliDriver(wrongCmd));
}

section('端到端拼装：驱动产出的字段经 buildInvocation 得到正确 argv');
{
  const codex = cliFieldsFor('codex', true);
  const argv = buildInvocation({
    command: resolveDriverPlaceholders(codex.cliCommand),
    prefixArgs: codex.cliPrefixArgs.map(resolveDriverPlaceholders),
    args: codex.cliArgs,
    values: { model: 'gpt-6-luna', effort: 'medium', cwd: 'C:/w', prompt: 'P' },
  }).argv;
  check('codex：argv[0] 是 node', argv[0] === process.execPath, String(argv[0]));
  check('codex：argv[1] 是 codex.js', String(argv[1]).endsWith('codex.js'), String(argv[1]));
  check('codex：含 exec 子命令', argv.includes('exec'));
  check('codex：只读时含 -s read-only', argv.includes('-s') && argv.includes('read-only'), JSON.stringify(argv));
  check('codex：模型已填充', argv.includes('gpt-6-luna'));
  check('codex：强度已填充', argv.includes('model_reasoning_effort=medium'));
  check('codex：提示词不进 argv（走 stdin）', !argv.includes('P'));

  const grok = cliFieldsFor('grok', false);
  const gArgv = buildInvocation({
    command: grok.cliCommand,
    prefixArgs: grok.cliPrefixArgs,
    args: grok.cliArgs,
    values: { model: 'grok-4.7', effort: 'low', cwd: 'C:/w', prompt: 'P' },
  }).argv;
  check('grok：提示词在 argv 里（该 CLI 只接受参数形式）', gArgv.includes('P'), JSON.stringify(gArgv));
  check('grok：非只读用 acceptEdits', gArgv.includes('acceptEdits'), JSON.stringify(gArgv));
  check('grok：模型已填充', gArgv.includes('grok-4.7'), JSON.stringify(gArgv));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
