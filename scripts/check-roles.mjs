// 角色模块的离线验证。不依赖 dsh 运行时，因此无需重启即可跑。
// 用法：node scripts/check-roles.mjs
import {
  EFFORT_VALUES,
  ROLE_DEFINITION_FIELDS,
  ROLE_SETTING_FIELDS,
  WRITE_TOOLS,
  UNCONTROLLED_DISPATCH_TOOLS,
  absoluteDepthLimit,
  agentOptionsFor,
  canStartAtDepth,
  carriesDefinition,
  cliPersonaFor,
  cliToolName,
  dispatchPermissionsFor,
  mergeRoleLayers,
  normalizeRole,
  normalizeRoles,
  pickOverrideFields,
  planCliMounts,
  roleGuidanceText,
  rolePresetId,
  routeSummaryFor,
  toolConfigFor,
  toolDescriptionFor,
} from '../src/roles.js';
import { buildRolePreset, buildRolePresets, loadRowTemplate } from '../src/role-presets.js';
import { cliFieldsFor } from '../src/cli/drivers.js';
import { isDeepStrictEqual } from 'node:util';
import { resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent';

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

section('合法角色：规范化结果');
{
  const { role, errors } = normalizeRole(
    {
      id: 'scout',
      title: '侦察员',
      description: '只读调研',
      model: 'gpt-6-luna',
      effort: 'medium',
      instructions: 'You are SCOUT.',
      readOnly: true,
    },
    0,
    'my-provider',
  );
  check('无错误', errors.length === 0, errors.join('; '));
  check('编码了 provider 默认值', role?.provider === 'my-provider');
  check('工具名由 id 推导', role?.toolName === 'delegate_to_scout');
  check('readOnly 透传', role?.readOnly === true);
  check('backend 默认 spawn', role?.backend === 'spawn');
  check('allowNestedDispatch 默认 false', role?.allowNestedDispatch === false);
}

section('toolConfigFor：新契约（persona/toolFilter 已移入角色 preset）');
{
  const { role } = normalizeRole(
    { id: 'worker', description: 'd', model: 'gpt-6.1-sol', effort: 'high', instructions: 'i' },
    0,
    'p',
  );
  const cfg = toolConfigFor(role, { maxDepth: 3 });
  check('provider 固定为 spawn', cfg.provider === 'spawn');
  check('toolName 正确', cfg.toolName === 'delegate_to_worker');
  check('agentOptions.provider', cfg.agentOptions.provider === 'p');
  check('agentOptions.model', cfg.agentOptions.model === 'gpt-6.1-sol');
  check('agentOptions.reasoningEffort', cfg.agentOptions.reasoningEffort === 'high');
  // ⚠️ 这里**曾经**断言 `cfg.persona === instructions` 与 `cfg.backgroundMode === 'one-shot'`。
  //    0.2.1-rc.1 删除了这四个字段：前两者是装载期硬抛错（Object.hasOwn 判定），
  //    后两者已从 Config 移除。角色 persona 与工具构成改由 `agentPreset` 选中。
  check('agentPreset 由角色 id 派生', cfg.agentPreset === rolePresetId('worker'), String(cfg.agentPreset));
  check('工具 Config 的 own keys 恰为新契约的五项',
    JSON.stringify(Object.keys(cfg).sort())
      === JSON.stringify(['agentOptions', 'agentPreset', 'maxDepth', 'provider', 'toolName']),
    Object.keys(cfg).join(','));
  check(
    '禁止嵌套仍使用插件绝对上限 4（出站权限另行过滤）',
    cfg.maxDepth === 4,
    `实际 ${cfg.maxDepth}；注意 0 会连第一层派发都拒绝`,
  );
}

section('agentOptionsFor：内置用角色 route，CLI 用统一包裹路由');
{
  const builtin = normalizeRole({ id: 'a', description: 'd', model: 'm', effort: 'high', instructions: 'i' }, 0, 'p').role;
  check('内置：provider/model/effort 来自角色',
    JSON.stringify(agentOptionsFor(builtin, { provider: 'other', model: 'other', effort: 'low' }))
      === JSON.stringify({ provider: 'p', model: 'm', reasoningEffort: 'high' }));
  const noEffort = normalizeRole({ id: 'b', description: 'd', model: 'm', instructions: 'i' }, 0, 'p').role;
  check('内置：未设 effort 时不写 reasoningEffort', !('reasoningEffort' in agentOptionsFor(noEffort)));

  const { role: cli } = normalizeRole({ id: 'c', description: 'd', instructions: 'i', backend: 'cli',
    model: 'cli-model', effort: 'medium', cliCommand: 'node', cliArgs: ['exec', '-'], cliCwd: 'C:/w' }, 0);
  check('CLI：无包裹路由时返回 undefined（继承父代理）', agentOptionsFor(cli, undefined) === undefined);
  check('CLI：包裹路由空串被忽略', agentOptionsFor(cli, { provider: ' ', model: '', effort: ' ' }) === undefined);
  check('CLI：包裹路由映射为 provider/model/reasoningEffort',
    JSON.stringify(agentOptionsFor(cli, { provider: ' wp ', model: 'wrapper-model', effort: 'high' }))
      === JSON.stringify({ provider: 'wp', model: 'wrapper-model', reasoningEffort: 'high' }));
}

section('只读角色：写入能力改由 preset 行级裁剪（旧 toolFilter.deny 已删除）');
{
  const { role } = normalizeRole(
    { id: 'reviewer', description: 'd', model: 'm', instructions: 'i', readOnly: true },
    0,
    'p',
  );
  const cfg = toolConfigFor(role, { maxDepth: 3, availableToolNames: [...WRITE_TOOLS] });
  check('只读不再经 toolFilter（该 Config 字段已删除）', !Object.hasOwn(cfg, 'toolFilter'));
  check(
    '只读且禁止嵌套仍使用插件绝对上限 4',
    cfg.maxDepth === 4,
    `实际 ${cfg.maxDepth}`,
  );
  // 只读的实际落点在 buildRolePreset 小节：fs 行关掉 write/edit，其余写入行整行移除。
}

section('深度语义：绝对深度而非相对层数');
{
  // 依据 dsh-subagent 的 resolveChildDepth：childDepth = parentDepth + 1，
  // 顶层代理 parentDepth 为 0，故第一个子代理深度为 1。
  // 这条断言锁住「maxDepth 不能为 0」这个曾被写错、且实测会拒绝派发的语义。
  const mk = (allowNestedDispatch) =>
    normalizeRole({ id: 'r', description: 'd', model: 'm', instructions: 'i', allowNestedDispatch }, 0, 'p')
      .role;

  const noNest = toolConfigFor(mk(false), { maxDepth: 3 });
  check('禁止嵌套不降低入站上限 → 4', noNest.maxDepth === 4, `实际 ${noNest.maxDepth}`);
  check('禁止嵌套时绝不为 0（0 会拒绝第一层派发）', noNest.maxDepth !== 0);

  const nest = toolConfigFor(mk(true), { maxDepth: 5 });
  check('允许嵌套 → 1 + maxDepth = 6', nest.maxDepth === 6, `实际 ${nest.maxDepth}`);

  const nestZero = toolConfigFor(mk(true), { maxDepth: 0 });
  check('允许嵌套但 maxDepth 为 0 → 仍为 1', nestZero.maxDepth === 1, `实际 ${nestZero.maxDepth}`);
}

section('省略 effort 时不写入 reasoningEffort');
{
  const { role } = normalizeRole({ id: 'x', description: 'd', model: 'm', instructions: 'i' }, 0, 'p');
  const cfg = toolConfigFor(role, { maxDepth: 1 });
  check('agentOptions 无 reasoningEffort 键', !('reasoningEffort' in cfg.agentOptions));
}

section('非法输入：逐条报错');
{
  const cases = [
    ['缺 id', { description: 'd', model: 'm', instructions: 'i' }, 'id'],
    ['id 非法字符', { id: 'Bad_ID', description: 'd', model: 'm', instructions: 'i' }, 'id'],
    ['缺 description', { id: 'a', model: 'm', instructions: 'i' }, 'description'],
    ['缺 model', { id: 'a', description: 'd', instructions: 'i' }, 'model'],
    ['缺 instructions', { id: 'a', description: 'd', model: 'm' }, 'instructions'],
    ['effort 非法', { id: 'a', description: 'd', model: 'm', instructions: 'i', effort: 'turbo' }, 'effort'],
    ['backend 非法', { id: 'a', description: 'd', model: 'm', instructions: 'i', backend: 'acp' }, 'backend'],
  ];
  for (const [label, input, expectField] of cases) {
    const { role, errors } = normalizeRole(input, 0, 'p');
    check(
      `${label} → 报错且定位到 ${expectField}`,
      role === null && errors.some((e) => e.includes(expectField)),
      errors.join('; ') || '(无错误)',
    );
  }
}

section('缺省 provider：全局也没有时报错');
{
  const { role, errors } = normalizeRole(
    { id: 'a', description: 'd', model: 'm', instructions: 'i' },
    0,
    undefined,
  );
  check('报 provider 错', role === null && errors.some((e) => e.includes('provider')));
}

section('normalizeRoles：唯一性与整体拒绝');
{
  const good = normalizeRoles(
    [
      { id: 'a', description: 'd', model: 'm', instructions: 'i' },
      { id: 'b', description: 'd', model: 'm', instructions: 'i' },
    ],
    'p',
  );
  check('两条合法角色通过', good.roles.length === 2 && good.errors.length === 0);

  const dup = normalizeRoles(
    [
      { id: 'a', description: 'd', model: 'm', instructions: 'i' },
      { id: 'a', description: 'd', model: 'm', instructions: 'i' },
    ],
    'p',
  );
  check('重复 id 被拦下', dup.errors.some((e) => e.includes('重复')) && dup.roles.length === 0);

  const bad = normalizeRoles(
    [
      { id: 'a', description: 'd', model: 'm', instructions: 'i' },
      { id: 'b', description: 'd', model: 'm' },
    ],
    'p',
  );
  check('一条出错则整份拒绝（不半挂载）', bad.roles.length === 0 && bad.errors.length > 0);

  check('undefined → 空且无错', normalizeRoles(undefined, 'p').errors.length === 0);
  check('非数组 → 报错', normalizeRoles({}, 'p').errors.length === 1);
  check('空数组 → 空且无错', normalizeRoles([], 'p').errors.length === 0);
}

section('toolDescriptionFor：包含用途与事实标签');
{
  const { role } = normalizeRole(
    {
      id: 'scout',
      title: '侦察员',
      description: '只读调研',
      model: 'm',
      // 用一个绝不可能出现在描述里的哨兵串，才能真正验证 instructions 没被带进工具描述。
      instructions: 'SENTINEL_INSTRUCTIONS_MUST_NOT_APPEAR',
      readOnly: true,
      allowNestedDispatch: true,
    },
    0,
    'p',
  );
  const desc = toolDescriptionFor(role, dispatchPermissionsFor(role, { delegateToolNames: ['delegate_to_scout'] }));
  check('含用途', desc.includes('只读调研'));
  check('含角色名', desc.includes('侦察员'));
  check('标注只读', desc.includes('只读'));
  check('标注后端', desc.includes('spawn'));
  check('含有效受控派发状态', desc.includes('可通过受控工具继续派发'));
  check(
    '不含 instructions 正文',
    !desc.includes('SENTINEL_INSTRUCTIONS_MUST_NOT_APPEAR'),
    'instructions 被泄漏进工具描述',
  );
}

section('toolDescriptionFor：禁止嵌套时的措辞');
{
  const { role } = normalizeRole(
    { id: 'x', description: 'd', model: 'm', instructions: 'i', allowNestedDispatch: false },
    0,
    'p',
  );
  const desc = toolDescriptionFor(role);
  check('标注不可继续派发', desc.includes('不可继续派发'));
}

section('枚举一致性');
{
  check('EFFORT_VALUES 与 DSH 取值一致', EFFORT_VALUES.join(',') === 'low,medium,high,xhigh,max');
}

section('routeSummaryFor：派发线路必须在**决策前**可见');
{
  // ⚠️ 背景：工具描述里有「后端：cli」，但那要调用时才进上下文；主代理在**选择**派给谁
  //    时看不到任何线路信息。跨 CLI 端到端实验暴露了这个不对称，本组断言锁住修复。
  const builtin = { id: 'a', backend: 'spawn', model: 'gpt-6-astra', effort: 'medium' };
  const s1 = routeSummaryFor(builtin);
  check('内置角色含 backend', s1.includes('backend=spawn'), s1);
  check('内置角色含 model', s1.includes('model=gpt-6-astra'), s1);
  check('内置角色含 effort', s1.includes('effort=medium'), s1);

  // CLI 角色：CLI 名要从**解析后**的 command 基名推断（normalizeRole 会解析 {node}）。
  const grok = { id: 'b', backend: 'cli', model: 'grok-4.7', effort: 'low', cli: { command: 'grok', prefixArgs: [] } };
  check('CLI 角色标注 cli(grok)', routeSummaryFor(grok).includes('backend=cli(grok)'), routeSummaryFor(grok));

  const codex = {
    id: 'c',
    backend: 'cli',
    model: 'gpt-6-luna',
    effort: 'high',
    // 实测形态：{node} 被解析成绝对路径，脚本名在 prefixArgs 里。
    cli: { command: 'C:\\Program Files\\nodejs\\node.EXE', prefixArgs: ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'] },
  };
  const s3 = routeSummaryFor(codex);
  check(
    'node + codex.js 形态标注 cli(codex)，而不是 cli(node)',
    s3.includes('backend=cli(codex)'),
    s3,
  );
  check('不把 node 当成 CLI 名（误导性路由信息）', !s3.includes('cli(node)'), s3);

  // 推断不出时只显示 backend=cli —— 宁可不说，也不要显示可能错的名字。
  const unknown = { id: 'd', backend: 'cli', cli: { command: 'C:\\x\\mystery.exe', prefixArgs: [] } };
  check('带路径的未知命令用其基名', routeSummaryFor(unknown).includes('backend=cli(mystery)'), routeSummaryFor(unknown));
  const nodeNoScript = { id: 'e', backend: 'cli', cli: { command: 'node', prefixArgs: [] } };
  check(
    'node 且无脚本名时只给 backend=cli（不猜）',
    routeSummaryFor(nodeNoScript).includes('backend=cli') && !routeSummaryFor(nodeNoScript).includes('('),
    routeSummaryFor(nodeNoScript),
  );

  // 退化输入不得抛错。
  for (const bad of [null, undefined, 42, 'x', {}]) {
    let threw = false;
    try {
      routeSummaryFor(bad);
    } catch {
      threw = true;
    }
    check(`退化输入 ${JSON.stringify(bad) ?? 'undefined'} 不抛错`, !threw);
  }
}

section('roleGuidanceText：每个角色必须带线路信息，且不泄漏 instructions');
{
  check('无角色时返回空串（不注册空提示）', roleGuidanceText([]) === '');

  const { roles } = normalizeRoles(
    [
      {
        id: 'scout',
        title: '侦察员',
        description: 'Find facts about the repository.',
        model: 'm',
        instructions: 'SENTINEL_SCOUT_BODY',
        readOnly: true,
      },
      {
        id: 'worker',
        title: '实现者',
        description: 'Implement an accepted direction.',
        model: 'm',
        instructions: 'SENTINEL_WORKER_BODY',
        allowNestedDispatch: true,
      },
    ],
    'p',
  );
  const text = roleGuidanceText(roles, { delegateToolNames: roles.map((role) => role.toolName) });

  check('含章节标题', text.includes('Subagent roles'));
  check('声明主代理是 switchboard', text.includes('switchboard'));
  check('含 scout 的 id', text.includes('**scout**'));
  check('含 worker 的 id', text.includes('**worker**'));
  check('含 scout 的工具名', text.includes('delegate_to_scout'));
  check('含 worker 的工具名', text.includes('delegate_to_worker'));
  check('含角色用途描述', text.includes('Find facts about the repository.'));
  check('标注只读', text.includes('read-only'));
  check('标注可继续派发', text.includes('may delegate further'));
  check('标注不可继续派发', text.includes('cannot delegate further'));
  check('要求不改写模型', /never attempt to choose or override/.test(text));
  check(
    '不泄漏 roles 的 instructions 正文',
    !text.includes('SENTINEL_SCOUT_BODY') && !text.includes('SENTINEL_WORKER_BODY'),
    'instructions 被带进了路由指引',
  );
}

section('CLI 后端角色');
{
  const base = {
    id: 'codex-worker',
    description: 'd',
    instructions: 'i',
    backend: 'cli',
    // ⚠️ CLI 角色**必须显式给模型**：实测 codex 在不传 `-m` 时会静默使用它自己
    // `~/.codex/config.toml` 的模型，角色配置被悄悄架空（`docs/cli-backends.md`）。
    model: 'gpt-6-luna',
    cliCommand: 'node',
    cliArgs: ['exec', '-'],
    cliCwd: 'C:/w',
  };

  const ok = normalizeRole(base, 0, undefined, 'C:/fallback');
  check('合法 CLI 角色通过', ok.role !== null, ok.errors.join('; '));
  // ⚠️ 本条曾写「CLI 角色不需要 DSH model」，那是**错的**。实测：codex 不传 `-m` 时会
  //    静默使用 `~/.codex/config.toml` 里的模型，外观上与传了参数毫无区别，角色配置被
  //    悄悄架空。因此 CLI 角色**必须**显式给模型（`normalizeRole` 缺它就报错）。
  check('CLI 角色显式携带模型（否则 CLI 会静默用自己配置）', ok.role?.model === 'gpt-6-luna', String(ok.role?.model));
  {
    const noModel = normalizeRole({ ...base, model: undefined }, 0, undefined, 'C:/fallback');
    check('CLI 角色缺 model 时报错', noModel.role === null, JSON.stringify(noModel.errors));
    check(
      '报错信息说明原因（静默使用 CLI 自身配置）',
      (noModel.errors ?? []).some((e) => /静默/.test(e)),
      JSON.stringify(noModel.errors),
    );
  }
  check(
    'cli 配置被规范化',
    ok.role?.cli?.command === 'node' && ok.role?.cli?.promptDelivery === 'stdin',
    JSON.stringify(ok.role?.cli),
  );
  check('cliArgs 被复制为独立数组', JSON.stringify(ok.role?.cli?.args) === JSON.stringify(['exec', '-']));
  check('cwd 取自角色配置', ok.role?.cli?.cwd === 'C:/w', String(ok.role?.cli?.cwd));

  const noCmd = normalizeRole({ ...base, cliCommand: undefined }, 0, undefined, 'C:/w');
  check(
    '缺 cliCommand 报错',
    noCmd.role === null && noCmd.errors.some((e) => e.includes('cliCommand')),
    noCmd.errors.join('; '),
  );

  const noArgs = normalizeRole({ ...base, cliArgs: undefined }, 0, undefined, 'C:/w');
  check(
    '缺 cliArgs 报错',
    noArgs.role === null && noArgs.errors.some((e) => e.includes('cliArgs')),
    noArgs.errors.join('; '),
  );

  const badArgs = normalizeRole({ ...base, cliArgs: 'exec -' }, 0, undefined, 'C:/w');
  check('cliArgs 非数组报错', badArgs.role === null, badArgs.errors.join('; '));

  // 模板错误必须在装载期报出，而不是等第一次派发才失败。
  const badPlaceholder = normalizeRole({ ...base, cliArgs: ['exec', '{nope}'] }, 0, undefined, 'C:/w');
  check(
    '模板里的未知占位符在装载期报错',
    badPlaceholder.role === null && badPlaceholder.errors.some((e) => e.includes('nope')),
    badPlaceholder.errors.join('; '),
  );

  const missingCwd = normalizeRole({ ...base, cliCwd: undefined }, 0, undefined, undefined);
  check(
    'cliCwd 与全局都缺时报错',
    missingCwd.role === null && missingCwd.errors.some((e) => e.includes('cliCwd')),
    missingCwd.errors.join('; '),
  );

  const cfg = toolConfigFor(ok.role, { maxDepth: 3 });
  const cliPreset = buildRolePreset(ok.role, { platform: 'win32', maxDepth: 3, roles: [ok.role] });
  check('CLI provider 使用内置 spawn', cfg.provider === 'spawn', cfg.provider);
  check('CLI 叶子默认深度使用插件绝对上限 4', cfg.maxDepth === 4);
  // ⚠️ CLI 角色**不再产出角色 preset**：顶层与嵌套都直接派发后台任务，没有任何东西会 spawn
  //    它们 —— 「专属 CLI 工具行」与「包裹 persona」随中继子代理一起退役。
  check('CLI 角色不再产出角色 preset（没有 agent 需要组合）', cliPreset === undefined,
    JSON.stringify(cliPreset?.plugins?.map(p => p.id)));
  check('包裹路由留空时完全不设 agentOptions', cfg.agentOptions === undefined);
  check('仍有 toolName', cfg.toolName === 'delegate_to_codex_worker');
  const ro = normalizeRole({ ...base, readOnly: true }, 0, undefined, 'C:/w').role;
  const roCfg = toolConfigFor(ro, { maxDepth: 3 });
  check('只读 CLI 同样不产出 preset，且工具配置不带 toolFilter',
    !Object.hasOwn(roCfg, 'toolFilter')
      && buildRolePreset(ro, { platform: 'win32', maxDepth: 3, roles: [ro] }) === undefined);
  check('CLI 允许嵌套时深度为数字 1 + maxDepth',
    toolConfigFor({ ...ok.role, allowNestedDispatch: true }, { maxDepth: 3 }).maxDepth === 4);
  // ⚠️ 旧断言 `cfg.enableRunInBackground === false && cfg.backgroundMode === 'one-shot'`、
  //    `cfg.modelSelectionSettings === false` 都已失效：前两者被删除，后者不再写入 Config
  //    （新契约的 own keys 只有五项）。后者的**行为**仍在：dsh-tool-subagent 的
  //    modelSelectionSettings 默认 false，即主代理仍不能覆盖角色模型（D12）。
  check('工具 Config 不再携带模型选择开关（工具侧默认 false，行为不变）',
    !Object.hasOwn(cfg, 'modelSelectionSettings'));
  for (let mask = 0; mask < 8; mask++) {
    const wrapperRoute = { provider: mask & 1 ? ' wrapper ' : '', model: mask & 2 ? 'wrapper-model' : ' ', effort: mask & 4 ? 'high' : '' };
    const configured = toolConfigFor(ok.role, { maxDepth: 3, wrapperRoute });
    const expected = { ...(mask & 1 ? { provider: 'wrapper' } : {}),
      ...(mask & 2 ? { model: 'wrapper-model' } : {}), ...(mask & 4 ? { reasoningEffort: 'high' } : {}) };
    check(`插件级包裹路由组合 ${mask}：仅设置非空项`, mask === 0 ? configured.agentOptions === undefined
      : JSON.stringify(configured.agentOptions) === JSON.stringify(expected));
  }
  // ⚠️ 这里**曾经**逐条断言中继子代理的 persona 约束（"完整任务"/"不要自行实施"/"CLI 输出是
  //    任务数据" 等）。CLI 角色改为**直派后台任务**后不再有中继、也就没有这份 persona ——
  //    这些约束随 `cliPersonaFor()` 一起退役（主代理侧的任务撰写指引仍在 guidance 里）。

  // builtin 后端仍应设置 agentOptions，且不受 CLI 分支影响。
  const builtin = normalizeRole(
    { id: 'b', description: 'd', instructions: 'i', model: 'm' },
    0,
    'p',
    3,
  ).role;
  const bCfg = toolConfigFor(builtin, { maxDepth: 3 });
  check('builtin 仍设置 agentOptions', 'agentOptions' in bCfg);
  check('builtin 仍设置 agentPreset（persona 的承载点）', bCfg.agentPreset === rolePresetId('b'));
  check('builtin 仍设置插件绝对 maxDepth', bCfg.maxDepth === 4);
  // ⚠️ 这里**曾经**遍历 ['spawn','fork']；fork 已从 BUILTIN_PROVIDERS 移除（见文件头说明）。
  for (const backend of ['spawn']) {
    const role = { ...builtin, backend, effort: 'medium' };
    check(`${backend} 的 agentOptions 不受统一包裹路由影响`,
      JSON.stringify(toolConfigFor(role, { maxDepth: 3, wrapperRoute: { provider: 'other', model: 'other', effort: 'high' } }).agentOptions)
      === JSON.stringify({ provider: 'p', model: 'm', reasoningEffort: 'medium' }));
  }
}

section('包裹强度：生产 toolConfigFor → 真实 resolveChildAgentOptions');
{
  const { role } = normalizeRole({
    id: 'wrapper-effort', backend: 'cli', description: 'd', instructions: 'i',
    model: 'cli-model', effort: 'xhigh', readOnly: true,
    cliDriver: 'grok', ...cliFieldsFor('grok', true), cliCwd: 'C:/w',
  }, 0);
  // 仅构造解析器所读的父 options / requestHeader；不创建会话、不调用 CLI 或 LLM。
  const parent = {
    options: { provider: 'created', model: 'created-model', reasoningEffort: 'low' },
    session: { requestHeader: () => ({ config: { provider: 'p', model: 'm1', reasoningEffort: 'high' } }) },
  };
  const empty = { provider: '', model: '', effort: '' };
  const cases = [
    ['三项全空沿用父最新 p/m1/high', parent, empty,
      { provider: 'p', model: 'm1', reasoningEffort: 'high' }],
    ['显式相同 p/m1 且 effort 空保留 high', parent, { ...empty, provider: 'p', model: 'm1' },
      { provider: 'p', model: 'm1', reasoningEffort: 'high' }],
    ['仅改 model=m2 删除父 reasoningEffort', parent, { ...empty, model: 'm2' },
      { provider: 'p', model: 'm2' }],
    ['仅改 provider=q 删除父 reasoningEffort', parent, { ...empty, provider: 'q' },
      { provider: 'q', model: 'm1' }],
    ['显式 p/m2/low 使用 low', parent, { provider: 'p', model: 'm2', effort: 'low' },
      { provider: 'p', model: 'm2', reasoningEffort: 'low' }],
    ['父最新请求无 effort 不恢复创建 high', {
      options: { provider: 'p', model: 'm1', reasoningEffort: 'high' },
      session: { requestHeader: () => ({ config: { provider: 'p', model: 'm1' } }) },
    }, empty, { provider: 'p', model: 'm1' }],
    ['尚无请求时回落创建 p/m1/high', {
      options: { provider: 'p', model: 'm1', reasoningEffort: 'high' },
      session: { requestHeader: () => undefined },
    }, empty, { provider: 'p', model: 'm1', reasoningEffort: 'high' }],
    ['不同模型标识不按别名等价处理', parent, { ...empty, model: 'm1-alias' },
      { provider: 'p', model: 'm1-alias' }],
  ];
  for (const [label, callingParent, wrapperRoute, expected] of cases) {
    const config = toolConfigFor(role, { maxDepth: 3, wrapperRoute });
    const resolved = resolveChildAgentOptions(callingParent, config.agentOptions, 1);
    check(label, isDeepStrictEqual(resolved, { ...expected, subagentDepth: 1 }), JSON.stringify(resolved));
  }
}

section('回归：入站深度独立于目标出站权限');
{
  // ⚠️ fork 已从 BUILTIN_PROVIDERS 移除（0.2.1-rc.1 起无法承载独立 preset），
  //    因此只遍历仍然有效的两个后端。
  for (const backend of ['cli', 'spawn']) {
    for (const maxDepth of [0, 1, 3]) {
      const leaf = { id: 'leaf', backend, instructions: 'i', allowNestedDispatch: false };
      const limit = toolConfigFor(leaf, { maxDepth }).maxDepth;
      check(`${backend} 预算 ${maxDepth}：绝对上限为 ${1 + maxDepth}`, limit === 1 + maxDepth);
      check(`${backend} 预算 ${maxDepth}：目标是否允许出站不改变入站上限`,
        limit === toolConfigFor({ ...leaf, allowNestedDispatch: true }, { maxDepth }).maxDepth);
      for (let parentDepth = 0; parentDepth <= 1 + maxDepth; parentDepth++) {
        check(`${backend} 预算 ${maxDepth}：父深度 ${parentDepth} 的入站边界`,
          canStartAtDepth(parentDepth, limit) === (parentDepth + 1 <= 1 + maxDepth));
      }
    }
  }
  const limit = toolConfigFor({ id: 'cli-leaf', backend: 'cli', allowNestedDispatch: false }, { maxDepth: 1 }).maxDepth;
  check('回归：父深度 1 可调用叶子 CLI 角色（预算 1）', canStartAtDepth(1, limit));
  check('绝对上限纯函数：预算 0/1/3 对应 1/2/4', [0, 1, 3].map(absoluteDepthLimit).join(',') === '1,2,4');
  check('深度越过安全整数范围时拒绝', !canStartAtDepth(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
}

section('出站权限与三种提示使用同一有效结果（权限仍是纯函数，只是不再进工具 Config）');
{
  const delegateToolNames = ['delegate_to_self', 'delegate_to_other'];
  const availableToolNames = ['read', ...WRITE_TOOLS, 'run_code', ...delegateToolNames, 'delegate_to_unmanaged',
    'switchboard_cli_run_self', 'switchboard_cli_run_other', ...UNCONTROLLED_DISPATCH_TOOLS];
  for (const backend of ['cli', 'spawn']) {
    for (const allowNestedDispatch of [false, true]) {
      const role = normalizeRole({ id: 'self', backend, instructions: 'i', description: 'd', model: 'm', allowNestedDispatch,
        ...(backend === 'cli' ? { cliDriver: 'grok', effort: 'medium', cliCwd: 'C:/w', ...cliFieldsFor('grok', false) } : {}) }, 0, 'p').role;
      const options = { maxDepth: 3, delegateToolNames, availableToolNames };
      const permissions = dispatchPermissionsFor(role, options);
      const config = toolConfigFor(role, options);
      const allowed = new Set(availableToolNames.filter(name => permissions.toolFilter.allow !== undefined
        ? permissions.toolFilter.allow.includes(name) : !permissions.toolFilter.deny.includes(name)));
      const tag = `${backend} ${allowNestedDispatch}`;
      check(`${tag}：受控 delegate 权限精确符合开关`,
        delegateToolNames.every((name) => allowed.has(name) === allowNestedDispatch));
      check(`${tag}：不开放其他角色底层 CLI 工具`, !allowed.has('switchboard_cli_run_other'));
      check(`${tag}：自身 CLI 工具仅 CLI 包裹可用`, allowed.has(cliToolName(role.id)) === (backend === 'cli'));
      check(`${tag}：全部非受控派发入口与未知 delegate 被排除`,
        [...UNCONTROLLED_DISPATCH_TOOLS, 'delegate_to_unmanaged'].every((name) => !allowed.has(name)));
      check(`${tag}：普通工具保留在内置角色，保留传输不写入过滤`,
        allowed.has('read') === (backend !== 'cli')
          && ![...(permissions.toolFilter.allow ?? []), ...(permissions.toolFilter.deny ?? [])].includes('run_code'));
      // ⚠️ 旧断言在这里比对 `config.toolFilter === permissions.toolFilter`。0.2.1-rc.1 起
      //    权限过滤不再进入工具 Config（字段已删除）；它现在的落点是角色 preset 的插件行，
      //    由 buildRolePreset 小节完整覆盖。这里只确认 Config 已改用 agentPreset 选中角色组合。
      check(`${tag}：工具 Config 改为 agentPreset 选中角色组合，不再携带过滤`,
        !Object.hasOwn(config, 'toolFilter') && config.agentPreset === rolePresetId(role.id));
      const description = toolDescriptionFor(role, permissions);
      const guidance = roleGuidanceText([role], options);
      const persona = cliPersonaFor(role, permissions);
      check(`${tag}：description 与实际权限一致`,
        allowNestedDispatch ? description.includes('可通过受控工具') && description.includes('剩余深度预算')
          : description.includes('不可继续派发') && !description.includes('可通过受控工具'));
      check(`${tag}：guidance 与实际权限一致`,
        guidance.includes('may delegate further') === allowNestedDispatch
          && guidance.includes('cannot delegate further') === !allowNestedDispatch);
      check(`${tag}：persona 与实际权限一致`, allowNestedDispatch
        ? persona.includes(delegateToolNames.join('、')) && persona.includes('剩余深度预算')
          && !persona.includes('不要调用其他角色的工具')
        : persona.includes('不可继续派发') && !persona.includes('可按任务需要'));
      // ⚠️ 这里**曾经**在 CLI 分支断言「preset persona 使用同一权限结果」——那验证的是
      //    中继子代理的 persona 落点。CLI 角色不再产出 preset（见上面 buildRolePreset 小节），
      //    该断言随中继退役；CLI 的权限文案只体现在主代理 guidance 里（上行已覆盖）。
      // 只读：旧断言比对 toolFilter.deny；现在只读是 preset 行级裁剪（另见 buildRolePreset 小节）。
      const readOnly = toolConfigFor({ ...role, readOnly: true }, options);
      check(`${tag}：只读不再经 toolFilter，Config 保持同一 agentPreset`,
        !Object.hasOwn(readOnly, 'toolFilter') && readOnly.agentPreset === rolePresetId(role.id));
      const empty = { ...options, delegateToolNames: [], availableToolNames: ['read'] };
      const unavailable = dispatchPermissionsFor(role, empty);
      check(`${tag}：无已挂载 delegate 时三种提示都不许宣称可继续派发`,
        !toolDescriptionFor(role, unavailable).includes('可通过受控工具')
          && !roleGuidanceText([role], empty).includes('may delegate further')
          && !cliPersonaFor(role, unavailable).includes('可按任务需要'));
    }
  }
  const sparse = dispatchPermissionsFor({ backend: 'spawn', readOnly: true, allowNestedDispatch: false }, {
    delegateToolNames: ['delegate_to_self'],
    availableToolNames: ['read', 'write', 'workflow', 'switchboard_cli_run_other', 'delegate_to_self'],
  }).toolFilter;
  check('内置 deny 只列可用名，不加入未注册的写工具与非受控入口',
    !sparse.deny.includes('pwsh') && !sparse.deny.includes('subagent')
      && sparse.deny.every(name => ['write', 'workflow', 'switchboard_cli_run_other', 'delegate_to_self'].includes(name)));
  check('内置 deny 四部分合成且 workflow 重叠去重', sparse.deny.length === 4
    && ['write', 'workflow', 'switchboard_cli_run_other', 'delegate_to_self'].every(name => sparse.deny.includes(name)));
}

section('backend 取值校验');
{
  const bad = normalizeRole(
    { id: 'x', description: 'd', instructions: 'i', model: 'm', backend: 'acp' },
    0,
    'p',
  );
  check(
    '未知 backend 被拒',
    bad.role === null && bad.errors.some((e) => e.includes('acp')),
    bad.errors.join('; '),
  );
  check(
    '错误信息列出可用后端',
    bad.errors.some((e) => e.includes('cli') && e.includes('spawn')),
    bad.errors.join('; '),
  );

  // ⚠️ 回归：fork 已在 0.2.1-rc.1 从 BUILTIN_PROVIDERS 移除（fork 子代理无法拥有
  //    独立 Agent Preset，因此无法承载角色 persona 与工具构成）。它必须被当成非法后端，
  //    而不是留成一个静默失效的选项。
  const fork = normalizeRole(
    { id: 'legacy-fork', description: 'd', instructions: 'i', model: 'm', backend: 'fork' },
    0,
    'p',
  );
  check('已移除的 fork 后端被拒', fork.role === null && fork.errors.some((e) => e.includes('fork')), fork.errors.join('; '));
  check(
    'fork 的报错列出允许的后端（spawn / cli）',
    fork.errors.some((e) => e.includes('spawn') && e.includes('cli')),
    fork.errors.join('; '),
  );
  const forkSet = normalizeRoles(
    [
      { id: 'ok', description: 'd', model: 'm', instructions: 'i' },
      { id: 'legacy', description: 'd', model: 'm', instructions: 'i', backend: 'fork' },
    ],
    'p',
  );
  check('normalizeRoles：含 fork 角色时整份拒绝且报错列出允许后端',
    forkSet.roles.length === 0
      && forkSet.errors.some((e) => e.includes('fork') && e.includes('spawn') && e.includes('cli')),
    forkSet.errors.join('; '));
}

section('planCliMounts：有效 CLI 预设挂载（无全局闸门）');
{
  const { cliFieldsFor } = await import('../src/cli/drivers.js');
  const mk = (id, backend) => normalizeRole({
    id, backend, description: 'd', instructions: 'i', model: 'm', provider: 'p',
    readOnly: true, effort: 'medium', cliDriver: 'grok', ...cliFieldsFor('grok', true), cliCwd: 'C:/w',
  }, 0).role;
  // ⚠️ `mk('d','fork')` 曾经在这里，用于证明非 CLI 角色不进挂载计划。
  //    fork 已从 BUILTIN_PROVIDERS 移除，`normalizeRole` 会返回 null；改用 spawn 表达同一不变式。
  const roles = [mk('a', 'spawn'), mk('b', 'cli'), mk('c', 'cli'), mk('d', 'spawn')];

  const plan = planCliMounts(roles);
  check(
    '只有 CLI 角色被挂载',
    plan.active.map((r) => r.id).join(',') === 'b,c',
    JSON.stringify(plan.active.map((r) => r.id)),
  );
  check('有效预设的 blocked 为空（不再有全局闸门）', plan.blocked.length === 0, JSON.stringify(plan.blocked));

  const noCli = planCliMounts([mk('a', 'spawn'), mk('b', 'spawn')]);
  check('没有 CLI 角色时 active 与 blocked 都为空', noCli.active.length === 0 && noCli.blocked.length === 0);

  // ⚠️ 回归断言：这里**曾经**有一个 `allowCrossCli` 全局闸门，关闭时把所有 CLI 角色
  //    挡在挂载之外。它后来在面板上被移除、却仍在执行期拦截，于是 CLI 角色永远挂不上、
  //    界面只显示「工具不存在」（实测：`scout=失败(allowCrossCli 未开启…)`）。
  //
  //    因此这里断言**签名里不再接受开关**：函数只认一个参数，任何额外传入的值都不得
  //    改变结果。这能防止「闸门被重新加回来」而测试却跟不上。
  for (const stray of [false, undefined, null, 0, '', 'true', 1, {}]) {
    const p = planCliMounts(roles, stray);
    check(
      `多余参数 ${JSON.stringify(stray) ?? 'undefined'} 不影响挂载（闸门已删）`,
      p.active.length === 2 && p.blocked.length === 0,
      `active=${p.active.length} blocked=${p.blocked.length}`,
    );
  }

  // 不变式：一个角色不可能既 active 又 blocked（曾是真实 bug：provider 与工具分开 gate）。
  const mixed = [mk('s1', 'spawn'), mk('c1', 'cli'), mk('s2', 'spawn'), mk('c2', 'cli')];
  const mixedPlan = planCliMounts(mixed);
  const activeIds = new Set(mixedPlan.active.map((r) => r.id));
  const blockedIds = new Set(mixedPlan.blocked.map((b) => b.id));
  const overlap = [...activeIds].filter((id) => blockedIds.has(id));
  check('active 与 blocked 无交集', overlap.length === 0, overlap.join(','));
  check('两个 CLI 角色都被挂载', activeIds.size === 2, String(activeIds.size));
  check(
    '非 CLI 角色永不出现在 blocked',
    ![...blockedIds].some((id) => id.startsWith('s')),
    [...blockedIds].join(','),
  );
}


section('buildRolePreset：角色 persona 与工具构成的唯一承载点');
{
  // DSH 0.2.1-rc.1 把 persona/toolFilter 从 dsh-tool-subagent 的 Config 删除，
  // 角色组合改由「每个角色一个 Agent Preset」承载。本小节是该机制的核心覆盖。
  const template = loadRowTemplate();
  check('行模板来自生成物且含 persona 行与 delegation 组',
    Array.isArray(template.rows) && template.rows.some((row) => row.id === 'persona')
      && template.rows.some((row) => row.id === 'delegation'));

  const builtin = normalizeRole({ id: 'builder', title: '构建者', description: 'd',
    instructions: 'BUILTIN-INSTRUCTIONS', model: 'm', allowNestedDispatch: true }, 0, 'p').role;
  const readOnlyRole = normalizeRole({ id: 'reviewer', title: '审查者', description: 'd',
    instructions: 'RO-INSTRUCTIONS', model: 'm', readOnly: true }, 0, 'p').role;
  const cli = normalizeRole({ id: 'codex-worker', description: 'd', instructions: 'CLI-INSTRUCTIONS', backend: 'cli',
    model: 'gpt-6-luna', effort: 'medium', cliDriver: 'grok', ...cliFieldsFor('grok', false), cliCwd: 'C:/w' }, 0).role;
  const cliLeaf = { ...cli, allowNestedDispatch: false };
  const cliNested = { ...cli, allowNestedDispatch: true };
  const roles = [builtin, readOnlyRole, cli];

  const rowIds = (definition) => definition.plugins.map((plugin) => plugin.id);
  const rowById = (definition, id) => definition.plugins.find((plugin) => plugin.id === id);
  const personaRows = (definition) => definition.plugins.filter((plugin) => plugin.name === '@deepseek-ai/dsh-persona');
  const uncontrolled = ['tool-subagent', 'tool-subagent-fork', 'tool-ralph', 'tool-workflow', 'workflow-ptc'];

  for (const platform of ['win32', 'posix']) {
    const definition = buildRolePreset(builtin, { platform, maxDepth: 3, roles });
    check(`${platform}：id 为 rolePresetId（角色组合的稳定标识）`, definition.id === rolePresetId('builder'));
    // 关键性质：persona 行是**替换**模板那一行，而不是并列追加 —— 两行 dsh-persona 会
    // 重复注册 deployment:persona-prefix（该行刻意 fails loud）。
    check(`${platform}：恰好一行 persona 且前缀为角色 instructions`,
      personaRows(definition).length === 1
        && rowById(definition, 'persona')?.config?.prefix === builtin.instructions);
    check(`${platform}：模板自带的 persona 文案未残留（确为替换而非并列）`,
      !definition.plugins.some((plugin) => String(plugin.config?.prefix).includes('coding agent powered by')));
    check(`${platform}：始终排除非受控派发与 workflow 行`,
      uncontrolled.every((id) => !rowIds(definition).includes(id)));
    check(`${platform}：组行内部的非受控入口同样被剔除`,
      (rowById(definition, 'delegation')?.config ?? [])
        .every((child) => !uncontrolled.includes(child.id)));
    check(`${platform}：平台行只保留本平台`,
      rowIds(definition).includes(platform === 'win32' ? 'tool-pwsh' : 'tool-bash')
        && !rowIds(definition).includes(platform === 'win32' ? 'tool-bash' : 'tool-pwsh'));
    check(`${platform}：非只读的 fs 行无写入裁剪`, rowById(definition, 'tool-fs')?.config === undefined);
    check(`${platform}：非只读保留 goal/todo/plugin 管理行`,
      ['command-goal', 'tool-goal', 'tool-todo', 'tool-plugin-manager', 'tool-plugin-market']
        .every((id) => rowIds(definition).includes(id)));
    check(`${platform}：行 id 唯一`, new Set(rowIds(definition)).size === rowIds(definition).length);
    const delegates = definition.plugins.filter((plugin) => plugin.name === '@deepseek-ai/dsh-tool-subagent');
    const spawnTargets = roles.filter((role) => role.id !== builtin.id && role.backend !== 'cli');
    const cliTargets = roles.filter((role) => role.id !== builtin.id && role.backend === 'cli');
    check(`${platform}：允许嵌套时为每个 **spawn** 目标生成一行受控委派并指向对方 preset`,
      JSON.stringify(delegates.map((plugin) => plugin.config.toolName).sort())
        === JSON.stringify(spawnTargets.map((role) => role.toolName).sort())
        && delegates.every((plugin) => plugin.config.provider === 'spawn'
          && plugin.config.agentPreset
            === rolePresetId(spawnTargets.find((role) => role.toolName === plugin.config.toolName).id))
        && delegates.every((plugin) => plugin.config.maxDepth === 4));
    // CLI 目标不再产生 spawn 行（那正是中继子代理），改由本插件的宿主行直派。
    check(`${platform}：CLI 目标改用直派宿主行，不产生 spawn 行`,
      JSON.stringify(rowById(definition, `switchboard-cli-dispatch-${builtin.id}`)?.config?.cliDispatchFor)
        === JSON.stringify(cliTargets.map((role) => role.id))
        && !delegates.some((plugin) => cliTargets.some((role) => role.toolName === plugin.config.toolName)));
  }

  {
    const definition = buildRolePreset(readOnlyRole, { platform: 'win32', maxDepth: 3, roles });
    check('只读：fs 行保留读取与读图、关掉写入与编辑（替代旧 WRITE_TOOLS deny）',
      JSON.stringify(rowById(definition, 'tool-fs')?.config)
        === JSON.stringify({ read: true, readImage: true, write: false, edit: false }));
    check('只读：shell/goal/todo/plugin 管理行被整行移除',
      ['tool-bash', 'tool-pwsh', 'command-goal', 'tool-goal', 'tool-todo',
        'tool-plugin-manager', 'tool-plugin-market'].every((id) => !rowIds(definition).includes(id)));
    check('只读：persona 仍是角色自己的指令',
      rowById(definition, 'persona')?.config?.prefix === readOnlyRole.instructions);
    check('只读：未开启嵌套时没有委派行',
      !definition.plugins.some((plugin) => plugin.name === '@deepseek-ai/dsh-tool-subagent'));
    check('只读：行 id 唯一', new Set(rowIds(definition)).size === rowIds(definition).length);
  }

  {
    // ⚠️ 这里**曾经**断言 CLI 叶子 preset 与「CLI 嵌套」preset 的行构成：包裹 persona 的文案、
    //    `cliToolFor` 只含自己、以及**用统一包裹路由作为 CLI 目标的子代理 agentOptions**。
    //    CLI 角色改为**直派后台任务**后，CLI 角色不再产出 preset、CLI 目标也不再产生 spawn 行
    //    —— 那层中继子代理整体退役，包裹路由随之失去消费者（见上面循环里的 cliDispatchFor 断言）。
    check('CLI 角色不再产出 preset（顶层与嵌套都走直派，没有 agent 需要组合）',
      buildRolePreset(cliLeaf, { platform: 'win32', maxDepth: 3, roles }) === undefined
        && buildRolePreset(cliNested, { platform: 'win32', maxDepth: 2, roles }) === undefined);
  }

  {
    const definitions = buildRolePresets(roles, { platform: 'win32', maxDepth: 1 });
    // ⚠️ CLI 角色**不产出** preset（顶层与嵌套都直派后台任务），因此是「每个 spawn 角色一个」。
    const spawnRoles = roles.filter((role) => role.backend !== 'cli');
    check('buildRolePresets 为每个 spawn 角色生成一个 preset，CLI 角色不生成',
      definitions.length === spawnRoles.length
        && definitions.every((definition, index) => definition.id === rolePresetId(spawnRoles[index].id))
        && definitions.every((definition) => !roles.some((role) => role.backend === 'cli'
          && definition.id === rolePresetId(role.id))),
      JSON.stringify(definitions.map((definition) => definition.id)));
  }
}

section('回归守卫：已删除的 dsh-tool-subagent Config 字段不得回流');
{
  // ⚠️ 精确锁死本次升级事故：0.2.1-rc.1 对 `persona` / `toolFilter` 做 `Object.hasOwn`
  //    判定，**键存在即装载期硬抛错**（值为 undefined 也算）；`backgroundMode` /
  //    `enableRunInBackground` 已从 Config 删除。这里用 Object.hasOwn（而非取值判断）
  //    断言四种角色形态都不再带这些字段。
  const removed = ['persona', 'toolFilter', 'backgroundMode', 'enableRunInBackground'];
  const builtin = normalizeRole({ id: 'guard', description: 'd', instructions: 'i', model: 'm' }, 0, 'p').role;
  const readOnlyRole = normalizeRole({ id: 'guard-ro', description: 'd', instructions: 'i', model: 'm', readOnly: true }, 0, 'p').role;
  const cli = normalizeRole({ id: 'guard-cli', description: 'd', instructions: 'i', backend: 'cli',
    model: 'm', effort: 'medium', cliDriver: 'grok', ...cliFieldsFor('grok', false), cliCwd: 'C:/w' }, 0).role;
  const shapes = [['builtin', builtin], ['readOnly', readOnlyRole], ['cli', cli],
    ['cli 嵌套', { ...cli, allowNestedDispatch: true }]];
  for (const [label, role] of shapes) {
    const cfg = toolConfigFor(role, { maxDepth: 3, wrapperRoute: { provider: 'p', model: 'm', effort: 'low' } });
    for (const field of removed) {
      check(`${label}：toolConfigFor 没有 own ${field}`, !Object.hasOwn(cfg, field));
    }
    check(`${label}：own keys 恰为新契约五项`,
      JSON.stringify(Object.keys(cfg).sort())
        === JSON.stringify(['agentOptions', 'agentPreset', 'maxDepth', 'provider', 'toolName']),
      Object.keys(cfg).join(','));
    // persona 并未消失，只是换了承载点：在角色 preset 里恰好出现一次。
    // ⚠️ CLI 角色不产出 preset（直派后台任务），因此**没有** persona 承载点 —— 它不需要
    //    任何「转交指令」，主代理侧的撰写指引在 guidance 里。
    const preset = buildRolePreset(role, { platform: 'win32', maxDepth: 3, roles: [role] });
    if (role.backend === 'cli') {
      check(`${label}：CLI 角色不产出 preset（无 persona 承载点）`, preset === undefined);
    } else {
      check(`${label}：persona 改由 preset 承载且恰好一行`,
        preset.plugins.filter((plugin) => plugin.name === '@deepseek-ai/dsh-persona').length === 1);
    }
  }
}

section('回归守卫：真实 dsh-tool-subagent apply 必须接受新契约、拒绝旧字段');
{
  // ⚠️ 这条是本次升级事故的**可证伪**守卫。前一小节只能证明我们**产出的配置**没有旧字段；
  //    这里把真实插件拉进来，证明「新配置不抛错」且「旧字段确实抛错」——
  //    如果谁把 persona/toolFilter 重新塞回 toolConfigFor，本小节会立刻失败。
  //
  // 桩只需要真实 apply 在**无作用域**（compositionScope === undefined）下的直接安装路径：
  // agentPresets 服务（register/readDocument 前置校验）、tools / subagents / systemPrompt /
  // sessionProjections / agents、effect 与 logger。
  const makeToolPluginCtx = (presetIds) => {
    const registered = [];
    const tools = {
      register(definition) {
        registered.push(definition.name);
        return () => {};
      },
    };
    const provider = { name: 'spawn', inheritsParentContext: false,
      capabilities: { depthLimit: true, agentOptions: true, agentPreset: true } };
    const subagents = { getProvider: (name) => (name === 'spawn' ? provider : undefined),
      resolveMaxDepth: (depth) => depth, async startActivation() { return { childId: 'fixture' }; } };
    const systemPrompt = { section: () => () => {}, context: () => () => {},
      getContextOrder: () => 0, getSectionOrder: () => 0 };
    const agentPresets = {
      async register(definition) { presetIds.add(definition.id); return () => {}; },
      async readDocument(id) {
        if (!presetIds.has(id)) throw new Error(`agentPresets: 未注册的 preset "${id}"`);
        return { id };
      },
    };
    // 官方 apply 同时用 `ctx.get('x')` 与 `ctx.x`（真实 Cordis 把服务同时暴露为属性）。
    return {
      registered,
      tools, subagents, systemPrompt,
      agents: { list: () => [] },
      sessionProjections: { register() {} },
      get(key) {
        if (key === 'tools') return tools;
        if (key === 'agentPresets') return agentPresets;
        if (key === 'agents') return { list: () => [] };
        if (key === 'sessionProjections') return { register() {} };
        if (key === 'subagents') return subagents;
        if (key === 'systemPrompt') return systemPrompt;
        return undefined;
      },
      on() { return () => {}; },
      effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {}; },
      logger: { info() {}, warn() {}, error() {} },
    };
  };

  const toolModule = await import('@deepseek-ai/dsh-tool-subagent');
  const guardBuiltin = normalizeRole({ id: 'guard-real', description: 'd', instructions: 'GUARD', model: 'm' }, 0, 'p').role;
  const guardCli = normalizeRole({ id: 'guard-real-cli', description: 'd', instructions: 'i', backend: 'cli',
    model: 'm', effort: 'medium', cliDriver: 'grok', ...cliFieldsFor('grok', false), cliCwd: 'C:/w' }, 0).role;
  for (const [label, role] of [['builtin', guardBuiltin], ['cli', guardCli]]) {
    const config = toolConfigFor(role, { maxDepth: 3 });
    const presetIds = new Set([rolePresetId(role.id)]);
    const ctx = makeToolPluginCtx(presetIds);
    let threw = null;
    try { await toolModule.apply(ctx, config); } catch (error) { threw = error; }
    check(`${label}：真实 dsh-tool-subagent apply 接受新契约配置（不抛错）`, threw === null, String(threw));
    check(`${label}：真实 apply 后委派工具已注册且选中角色 preset`,
      ctx.registered.includes(role.toolName) && config.agentPreset === rolePresetId(role.id));
  }
  for (const field of ['persona', 'toolFilter']) {
    const config = toolConfigFor(guardBuiltin, { maxDepth: 3 });
    const presetIds = new Set([rolePresetId(guardBuiltin.id)]);
    let threw = null;
    try { await toolModule.apply(makeToolPluginCtx(presetIds), { ...config, [field]: 'fixture-value' }); }
    catch (error) { threw = error; }
    check(`正向对照：把 ${field} 塞回去后真实 apply 抛错（守卫有齿）`,
      threw !== null && String(threw?.message).includes(field), String(threw));
  }
  // 另外两种已删除字段即使取值 undefined 也必须被拒（Object.hasOwn 判定）。
  for (const field of ['persona', 'toolFilter']) {
    const config = toolConfigFor(guardBuiltin, { maxDepth: 3 });
    const presetIds = new Set([rolePresetId(guardBuiltin.id)]);
    let threw = null;
    try { await toolModule.apply(makeToolPluginCtx(presetIds), { ...config, [field]: undefined }); }
    catch (error) { threw = error; }
    check(`正向对照：${field} 取 undefined 仍然抛错（键存在即失败）`, threw !== null, String(threw));
  }
}

section('F2 / F3 回归');
{
  const ro = { id: 'ro', backend: 'spawn', readOnly: true };
  check('只读拒绝 bash 与 plugin_manager',
    JSON.stringify(dispatchPermissionsFor(ro, { availableToolNames: ['bash', 'plugin_manager'] }).toolFilter.deny) === '["bash","plugin_manager"]');
  check('Windows 清单不添加未知 bash', !dispatchPermissionsFor(ro, { availableToolNames: ['pwsh'] }).toolFilter.deny.includes('bash'));
  for (const driver of ['codex', 'grok']) {
    const base = { id: driver, description: 'd', instructions: 'i', backend: 'cli', model: 'm', cliCwd: 'C:/w', cliDriver: driver, ...cliFieldsFor(driver, true), readOnly: true };
    const missing = normalizeRole(base, 0);
    check(`${driver} 缺强度在装载期报错`, missing.errors.some(e => e.includes('模板使用了 {effort}')));
    check(`${driver} 显式合法强度通过`, normalizeRole({ ...base, effort: 'medium' }, 0).errors.length === 0);
    const custom = { ...base, cliDriver: undefined, cliPromptDelivery: 'stdin', cliArgs: ['exec', '-'] };
    check('未引用 effort 的自定义模板可省略', normalizeRole(custom, 0).errors.length === 0);
    const cwd = normalizeRole({ ...custom, cliCwd: undefined, cliArgs: ['exec', '{cwd}'] }, 0);
    check('引用 cwd 却不可得在装载期报错', cwd.errors.some(e => e.includes('{cwd}')));
  }
}

// --- 设置层与定义层的划分、以及三层合并 ---------------------------------------
//
// 设计：角色的**定义**（身份 / persona / CLI argv 契约）住在插件自己的 roles.json；
// DSH 设置页只承载**旋钮**（backend / model / effort / provider / readOnly /
// allowNestedDispatch）。split 模式下生效角色 = 文件定义 ⨝ 文件覆盖层 ⨝ 旋钮层。
{
  section('设置层与定义层的字段划分');
  check('两个字段集不相交',
    ROLE_SETTING_FIELDS.filter(field => ROLE_DEFINITION_FIELDS.includes(field)).length === 0);
  check('定义集含 persona 与 CLI 契约',
    ['instructions', 'description', 'cliArgs', 'cliCommand'].every(f => ROLE_DEFINITION_FIELDS.includes(f)));
  check('旋钮集含 backend / model / effort / readOnly / allowNestedDispatch',
    ['backend', 'model', 'effort', 'readOnly', 'allowNestedDispatch'].every(f => ROLE_SETTING_FIELDS.includes(f)));
  // `cli*` 是安全敏感面（模型只能填受限占位符、命令与参数来自用户配置），
  // 明确断言它属于定义、不进设置表单。
  check('cli* 全部属定义、不在旋钮集',
    ROLE_DEFINITION_FIELDS.filter(f => f.startsWith('cli')).length === 6
      && ROLE_SETTING_FIELDS.every(f => !f.startsWith('cli')));

  section('carriesDefinition / pickOverrideFields');
  check('带 persona 的条目算定义', carriesDefinition({ id: 'a', instructions: 'i' }) === true);
  check('只带旋钮的条目不算定义',
    carriesDefinition({ id: 'a', model: 'm', backend: 'cli', readOnly: true }) === false);
  check('非对象不算定义', carriesDefinition(null) === false && carriesDefinition('a') === false);
  check('投影只保留 id 与旋钮，丢掉定义字段',
    isDeepStrictEqual(pickOverrideFields({ id: 'a', title: 't', instructions: 'i', model: 'm',
      cliArgs: ['x'], readOnly: true }), { id: 'a', model: 'm', readOnly: true }));
  check('投影对无 id 条目返回 undefined', pickOverrideFields({ model: 'm' }) === undefined);

  section('mergeRoleLayers 三层合并（仅 split 模式调用）');
  const definitions = [{ id: 'a', title: 'A', description: 'd', instructions: 'i', model: 'm0',
    backend: 'spawn', readOnly: false }];
  const overrides = [{ id: 'a', model: 'm1', readOnly: true }];
  const configured = [{ id: 'a', effort: 'high' }];
  const mergedOne = mergeRoleLayers({ definitions, overrides, configured });
  check('文件定义 < 文件覆盖 < 旋钮，逐字段合并',
    mergedOne.length === 1 && mergedOne[0].model === 'm1' && mergedOne[0].readOnly === true
      && mergedOne[0].effort === 'high' && mergedOne[0].instructions === 'i'
      && mergedOne[0].title === 'A' && mergedOne[0].backend === 'spawn', JSON.stringify(mergedOne));
  check('文件侧无信息时原样返回旋钮层',
    mergeRoleLayers({ definitions: [], overrides: [], configured }) === configured);
  check('文件侧与旋钮层都空时返回空数组',
    isDeepStrictEqual(mergeRoleLayers({ definitions: [], overrides: [], configured: undefined }), []));
  check('旋钮层字段级胜出定义与覆盖',
    mergeRoleLayers({ definitions, overrides, configured: [{ id: 'a', model: 'mx', instructions: 'ix' }] })[0]
      .instructions === 'ix');
  check('旋钮层未提及的角色由文件定义补上',
    mergeRoleLayers({ definitions: [...definitions, { id: 'b', instructions: 'ib' }], overrides: [], configured })
      .map(r => r.id).join(',') === 'a,b');
  check('顺序以旋钮层为准，文件侧新增追加在后',
    mergeRoleLayers({ definitions: [{ id: 'b' }, { id: 'a' }], overrides: [], configured: [{ id: 'a' }] })
      .map(r => r.id).join(',') === 'a,b');
  check('只在覆盖层出现的角色也并入',
    mergeRoleLayers({ definitions: [], overrides: [{ id: 'c', model: 'm' }], configured: [] })
      .map(r => r.id).join(',') === 'c');
  check('无 id 的条目原样保留，交给字段级校验报错而不是静默丢弃',
    mergeRoleLayers({ definitions: [{ title: 'x' }], overrides: [], configured: [] }).length === 1);
  // ⚠️ 这条锁住 R2 / M2 的根因：本函数**只**服务 split 模式。legacy 的 `roles` 是完整
  //    列表，显式 `[]` 必须清空、非法值必须报错，**不能**被文件内容顶掉。调用点在
  //    `createRoleResolver` 里先判模式，所以这里只需保证函数本身不越权。
  check('非数组旋钮层不参与合并（非法值由调用点原样交给字段级校验）',
    isDeepStrictEqual(mergeRoleLayers({ definitions: [{ id: 'a' }], overrides: [], configured: null })
      .map(r => r.id), ['a']));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
