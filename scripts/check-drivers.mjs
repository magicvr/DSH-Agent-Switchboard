// CLI 驱动预设的离线验证。
//
// 为什么需要：驱动表是「界面一键填好」与「实际调用」共用的同一份数据。它一旦有错，
// 用户点一下就会得到一条**看起来对、实际跑不通**的命令 —— 而这类错误在真机上表现为
// 「派发失败」，很难定位到预设本身。因此这里把每条驱动的形状钉死。
//
// ⚠️ 本文件**不声称**这些命令在本机一定能跑通：那属于真机验证，见
// `docs/cli-backends.md` 与 `scripts/probes/probe-cli-run*.mjs`。这里只验证**结构不变量**。
//
// 用法：node scripts/check-drivers.mjs
import {
  CLI_DRIVERS,
  CLI_DRIVER_IDS,
  cliDriverFor,
  cliFieldsFor,
  inferCliDriver,
  validateCliPreset,
  resolveDriverPlaceholders,
  DRIVER_PLACEHOLDERS,
} from '../src/cli/drivers.js';
import { normalizeRoles, planCliMounts, roleGuidanceText } from '../src/roles.js';
import { validateTemplate, buildInvocation, PROMPT_DELIVERY } from '../src/cli/argv.js';

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
    '驱动集合恰为 codex / grok',
    CLI_DRIVER_IDS.slice().sort().join(',') === 'codex,grok',
    CLI_DRIVER_IDS.join(','),
  );
  check('不含 claude（已按用户要求排除）', !CLI_DRIVER_IDS.includes('claude'), CLI_DRIVER_IDS.join(','));
  check('custom 不在驱动表内（禁止自定义兜底）', !CLI_DRIVER_IDS.includes('custom') && cliDriverFor('custom') === undefined);
  const ids = new Set();
  for (const d of CLI_DRIVERS) {
    check(`${d.id}：id 唯一`, !ids.has(d.id));
    ids.add(d.id);
    check(`${d.id}：有 label`, typeof d.label === 'string' && d.label.length > 0);
    check(`${d.id}：有 description`, typeof d.description === 'string' && d.description.length > 0);
    check(`${d.id}：args 是函数`, typeof d.args === 'function');
    check(
      `${d.id}：promptDelivery 合法`,
      PROMPT_DELIVERY.includes(d.promptDelivery),
      `${String(d.promptDelivery)}（合法值：${PROMPT_DELIVERY.join(' / ')}）`,
    );
  }
}

section('`{prompt}` 与传递方式必须自洽');
{
  // - `stdin`：模板**不能**含 `{prompt}`（否则提示词会被传两次）；
  // - `argv` / `promptFile`：模板**必须**含 `{prompt}`
  //   （前者传提示词本身，后者传临时文件路径）——
  //   否则提示词永远不会到达子进程。
  for (const d of CLI_DRIVERS) {
    for (const readOnly of [true, false]) {
      const args = d.args(readOnly);
      const hasPrompt = args.some((a) => a.includes('{prompt}'));
      if (d.promptDelivery === 'stdin') {
        check(
          `${d.id}(readOnly=${readOnly})：stdin 传递时模板不含 {prompt}`,
          !hasPrompt,
          JSON.stringify(args),
        );
      } else {
        check(
          `${d.id}(readOnly=${readOnly})：${d.promptDelivery} 传递时模板含 {prompt}`,
          hasPrompt,
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
    const a = JSON.stringify(d.args(true));
    const b = JSON.stringify(d.args(false));
    check(`${d.id}：readOnly 会改变参数`, a !== b, '两种只读状态产出相同参数，readOnly 形同虚设');
  }
}

section('cliFieldsFor：产出完整且可用的四件套');
{
  for (const d of CLI_DRIVERS) {
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
  check('custom 不产出字段（旧配置只允许无损识别）', cliFieldsFor('custom', true) === undefined);
  check('未知 id 不产出字段', cliFieldsFor('nope', true) === undefined);
}

section('占位符解析：{node} / {npmRoot} 必须变成真实路径，且不得残留');
{
  // ⚠️ 断言「解析结果是一个**真实 node**」，而不是「等于 `process.execPath`」。
  //    在 DSH 里 `process.execPath` 指向 Electron 应用本体
  //    （`…\DeepSeek Harness.exe`），我们刻意改用 PATH 上的真实 node
  //    （见 drivers.js 的说明），因此写死 execPath 会假失败。
  const resolvedNode = resolveDriverPlaceholders('{node}');
  check('{node} 解析为 node 可执行文件', /(^|[\\/])node(\.exe)?$/i.test(resolvedNode), resolvedNode);
  check('{node} 不解析为 Electron/DSH 应用本体', !/DeepSeek Harness/i.test(resolvedNode), resolvedNode);
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
    for (const readOnly of [true, false]) {
      const f = cliFieldsFor(d.id, readOnly);
      const role = { ...f, readOnly };
      check(`${d.id}(readOnly=${readOnly})：反推回自身`, inferCliDriver(role) === d.id, inferCliDriver(role));
    }
  }
  // 手工改过一个字段 → 必须返回 undefined，避免误认成预设。
  const modified = { ...cliFieldsFor('grok', true), cliArgs: ['--custom'] };
  check('参数被改过 → 反推为 undefined', inferCliDriver(modified) === undefined, inferCliDriver(modified));
  const wrongCmd = { ...cliFieldsFor('codex', true), cliCommand: 'something-else' };
  check('命令被改过 → 反推为 undefined', inferCliDriver(wrongCmd) === undefined, inferCliDriver(wrongCmd));

  // ⚠️ 锁死「锁死在自定义命令」这个真实故障。
  //
  //    起因：驱动选择器的 onChange 原本连着调用 4 次基于同一份 `role` 快照的 set，
  //    只有最后一次生效 —— 写进去的字段凑不成任何驱动，于是下拉框永远反推不中，
  //    表现为**无法选择 Codex/Grok，只能停在「自定义命令」**。
  //
  //    修法：一次原子提交（客户端 `setMany`）。这里从数据侧断言「一次填好的字段必须
  //    能被反推回来」，与 `cliFieldsFor → inferCliDriver` 的往返一致。
  const partiallyWritten = { ...cliFieldsFor('codex', true) };
  delete partiallyWritten.cliArgs; // 模拟「四个字段只写进了部分」的旧 bug 产物
  check(
    '字段只写进一部分时反推为 undefined（旧 bug 产物必须可检出）',
    inferCliDriver(partiallyWritten) === undefined,
    inferCliDriver(partiallyWritten),
  );

  // 解析后形态也必须反推得中：界面拿到的值是否经过占位符解析并不确定，
  // 反推不能依赖这个前提（否则换一层投影就会重新「锁死」）。
  const resolvedForm = {
    ...cliFieldsFor('codex', true),
    cliCommand: resolveDriverPlaceholders('{node}'),
    cliPrefixArgs: cliFieldsFor('codex', true).cliPrefixArgs.map(resolveDriverPlaceholders),
  };
  check(
    '占位符已解析的形态同样反推为 codex',
    inferCliDriver(resolvedForm) === 'codex',
    inferCliDriver(resolvedForm),
  );
}

section('Host 预设一致性与旧配置逐角色阻塞');
{
  const mk = (id, driver, readOnly = true) => ({
    id, backend: 'cli', description: 'd', instructions: 'i', model: 'external-model',
    readOnly, cliCwd: 'C:/w', cliDriver: driver, ...cliFieldsFor(driver, readOnly),
  });
  for (const driver of ['codex', 'grok']) {
    for (const readOnly of [true, false]) {
      const raw = mk(`legacy-${driver}`, driver, readOnly);
      raw.cliDriver = 'custom';
      const before = JSON.stringify(raw);
      const normalized = normalizeRoles([raw]);
      check(`${driver}/${readOnly}：旧 custom 无损识别并修正规范化标签`,
        normalized.errors.length === 0 && normalized.roles[0]?.cliDriver === driver);
      check(`${driver}/${readOnly}：识别不改写原始数据`, JSON.stringify(raw) === before);
      check(`${driver}/${readOnly}：模板和解析后执行形态均可挂载`,
        validateCliPreset(raw).errors.length === 0 && planCliMounts(normalized.roles).active.length === 1);
      check(`${driver}/${readOnly}：权限反向不允许静默放行`,
        validateCliPreset({ ...raw, readOnly: !readOnly }).errors.some((e) => e.includes('readOnly')));
    }
    const raw = mk(driver, driver);
    for (const [key, value] of [
      ['cliCommand', 'unexpected-command'], ['cliPrefixArgs', ['unexpected-script']],
      ['cliArgs', [...raw.cliArgs, '--unexpected']],
      ['cliPromptDelivery', raw.cliPromptDelivery === 'stdin' ? 'promptFile' : 'stdin'],
    ]) {
      check(`${driver}：隐藏执行字段 ${key} 被篡改即阻塞`,
        validateCliPreset({ ...raw, [key]: value }).errors.some((e) => e.includes('不一致')));
    }
    const normalized = normalizeRoles([raw]).roles[0];
    normalized.cli.command = 'unexpected-command';
    check(`${driver}：挂载时复验实际执行字段`, planCliMounts([normalized]).active.length === 0);
    check(`${driver}：未知标签不按完整形态静默降级`,
      validateCliPreset({ ...raw, cliDriver: 'unknown' }).errors.length > 0);
    check(`${driver}：可执行文件名相同不代表无损匹配`,
      inferCliDriver({ ...raw, cliArgs: ['--different'] }) === undefined);
    const plain = normalizeRoles([raw]).roles[0];
    const wrapper = normalizeRoles([{ ...raw, agentProvider: 'wrapper-route', agentModel: 'wrapper-model' }]).roles[0];
    check(`${driver}：规范化结果不含角色包裹字段`,
      !('agentProvider' in plain) && !('agentModel' in plain));
    check(`${driver}：残留包裹路由忽略且不影响 CLI 执行字段`,
      !('agentProvider' in wrapper) && !('agentModel' in wrapper) &&
      wrapper.model === raw.model && JSON.stringify(wrapper.cli) === JSON.stringify(plain.cli));
    const empty = normalizeRoles([{ ...raw, agentProvider: ' ', agentModel: '' }]).roles[0];
    check(`${driver}：残留空包裹路由不填入规范化或执行字段`,
      !('agentProvider' in empty) && !('agentModel' in empty) &&
      JSON.stringify(empty.cli) === JSON.stringify(plain.cli));
  }
  const unknown = { ...mk('unknown', 'codex'), cliDriver: 'custom', cliCommand: 'arbitrary-cli' };
  const malformed = { ...unknown, id: 'malformed', cliArgs: '{nope}', model: undefined };
  const valid = mk('valid', 'grok');
  const builtin = { id: 'builtin', description: 'd', instructions: 'i', provider: 'p', model: 'm' };
  const originals = [unknown, malformed, valid, builtin];
  const before = JSON.stringify(originals);
  const normalized = normalizeRoles(originals);
  const plan = planCliMounts(normalized.roles);
  check('未知 custom 与损坏 custom 不使其他角色整体失效',
    normalized.errors.length === 0 && normalized.roles.length === 4 && plan.active.map((r) => r.id).join(',') === 'valid');
  check('未知配置不进入可执行挂载集合',
    plan.blocked.map((b) => b.id).join(',') === 'unknown,malformed' &&
    plan.blocked.every((b) => b.reason.includes('待迁移')));
  check('损坏 custom 的具体字段错误保留在阻塞原因',
    plan.blocked.find((b) => b.id === 'malformed')?.reason.includes('cliArgs 必填') &&
    plan.blocked.find((b) => b.id === 'malformed')?.reason.includes('model 必填'));
  check('无法识别的旧配置保留原始数据', JSON.stringify(originals) === before);
  check('主代理指引明确禁止派发待迁移角色',
    roleGuidanceText(normalized.roles).includes('unknown** — unavailable / 待迁移') &&
    roleGuidanceText(normalized.roles).includes('不得派发'));
  const duplicate = normalizeRoles([unknown, { ...valid, id: unknown.id }]);
  check('包含待迁移角色时重复 id 仍整体拒绝',
    duplicate.roles.length === 0 && duplicate.errors.some((e) => e.includes('重复')));
  const mismatch = normalizeRoles([{ ...mk('mismatch', 'codex'), readOnly: false }, valid]);
  check('权限不一致仅阻塞对应角色，其他预设继续可用',
    mismatch.errors.length === 0 && planCliMounts(mismatch.roles).active.map((r) => r.id).join(',') === 'valid');
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
  check(
    'codex：argv[0] 是 node',
    /(^|[\\/])node(\.exe)?$/i.test(String(argv[0])),
    String(argv[0]),
  );
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
