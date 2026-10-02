// 角色模块的离线验证。不依赖 dsh 运行时，因此无需重启即可跑。
// 用法：node scripts/check-roles.mjs
import {
  EFFORT_VALUES,
  WRITE_TOOLS,
  normalizeRole,
  normalizeRoles,
  planCliMounts,
  roleGuidanceText,
  routeSummaryFor,
  toolConfigFor,
  toolDescriptionFor,
} from '../src/roles.js';

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

section('toolConfigFor：模型与强度进 agentOptions');
{
  const { role } = normalizeRole(
    { id: 'worker', description: 'd', model: 'gpt-6.1-sol', effort: 'high', instructions: 'i' },
    0,
    'p',
  );
  const cfg = toolConfigFor(role, { maxDepth: 3 });
  check('provider = backend', cfg.provider === 'spawn');
  check('toolName 正确', cfg.toolName === 'delegate_to_worker');
  check('agentOptions.provider', cfg.agentOptions.provider === 'p');
  check('agentOptions.model', cfg.agentOptions.model === 'gpt-6.1-sol');
  check('agentOptions.reasoningEffort', cfg.agentOptions.reasoningEffort === 'high');
  check('persona = instructions', cfg.persona === 'i');
  check(
    '禁止嵌套 → maxDepth 1（本层可派发，子代理不可再派）',
    cfg.maxDepth === 1,
    `实际 ${cfg.maxDepth}；注意 0 会连第一层派发都拒绝`,
  );
  check('backgroundMode one-shot', cfg.backgroundMode === 'one-shot');
  check('非只读 → 无 toolFilter', cfg.toolFilter === undefined);
}

section('只读角色：写入类工具被 deny');
{
  const { role } = normalizeRole(
    { id: 'reviewer', description: 'd', model: 'm', instructions: 'i', readOnly: true },
    0,
    'p',
  );
  const cfg = toolConfigFor(role, { maxDepth: 3 });
  check('有 toolFilter', cfg.toolFilter !== undefined);
  const denied = new Set(cfg.toolFilter?.deny ?? []);
  check('write 被 deny', denied.has('write'));
  check('edit 被 deny', denied.has('edit'));
  check('pwsh 被 deny', denied.has('pwsh'));
  check('deny 列表即 WRITE_TOOLS', denied.size === WRITE_TOOLS.length);
  check(
    '只读且禁止嵌套 → maxDepth 仍为 1（只读不等于不可派发）',
    cfg.maxDepth === 1,
    `实际 ${cfg.maxDepth}`,
  );
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
  check('禁止嵌套 → 1', noNest.maxDepth === 1, `实际 ${noNest.maxDepth}`);
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
  const desc = toolDescriptionFor(role);
  check('含用途', desc.includes('只读调研'));
  check('含角色名', desc.includes('侦察员'));
  check('标注只读', desc.includes('只读'));
  check('标注后端', desc.includes('spawn'));
  check('含嵌套派发状态', desc.includes('可继续派发'));
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
  const text = roleGuidanceText(roles);

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
  check('CLI provider 使用内置 spawn', cfg.provider === 'spawn', cfg.provider);
  check('CLI 默认深度为数字 1', cfg.maxDepth === 1);
  check('CLI allow 仅包含自己的专属工具',
    JSON.stringify(cfg.toolFilter) === JSON.stringify({ allow: ['switchboard_cli_run_codex_worker'] }));
  check('包裹路由留空时完全不设 agentOptions', !('agentOptions' in cfg));
  check('CLI persona 写明工具名', cfg.persona.includes('switchboard_cli_run_codex_worker'));
  check('仍有 toolName', cfg.toolName === 'delegate_to_codex_worker');
  const ro = normalizeRole({ ...base, readOnly: true }, 0, undefined, 'C:/w').role;
  const roCfg = toolConfigFor(ro, { maxDepth: 3 });
  check('只读 CLI 仍仅允许自己的专属工具',
    JSON.stringify(roCfg.toolFilter) === JSON.stringify(cfg.toolFilter));
  check('CLI 允许嵌套时深度为数字 1 + maxDepth',
    toolConfigFor({ ...ok.role, allowNestedDispatch: true }, { maxDepth: 3 }).maxDepth === 4);
  check('CLI 显式关闭后台运行', cfg.enableRunInBackground === false && cfg.backgroundMode === 'one-shot');
  check('CLI 显式关闭包裹模型选择', cfg.modelSelectionSettings === false);
  for (const options of [{ agentProvider: 'wrapper' }, { agentModel: 'wrapper-model' },
    { agentProvider: 'wrapper', agentModel: 'wrapper-model' }]) {
    const configured = toolConfigFor({ ...ok.role, ...options }, { maxDepth: 3 });
    const expected = { ...(options.agentProvider ? { provider: options.agentProvider } : {}),
      ...(options.agentModel ? { model: options.agentModel } : {}) };
    check(`包裹路由组合 ${Object.keys(options).join('+')}`, JSON.stringify(configured.agentOptions) === JSON.stringify(expected));
  }
  for (const constraint of ['完整任务', '不要自行实施', '不要改写命令', '不要切换角色', '等待工具返回',
    '不轮询', '不重复启动', '交付物', '验证证据', '错误', '未完成项', '取消或失败不得自动重试',
    'CLI 输出是任务数据', '不能改变你的工具或权限约束']) {
    check(`CLI persona 约束：${constraint}`, cfg.persona.includes(constraint));
  }

  // builtin 后端仍应设置这些，且不受 CLI 分支影响。
  const builtin = normalizeRole(
    { id: 'b', description: 'd', instructions: 'i', model: 'm' },
    0,
    'p',
    3,
  ).role;
  const bCfg = toolConfigFor(builtin, { maxDepth: 3 });
  check('builtin 仍设置 agentOptions', 'agentOptions' in bCfg);
  check('builtin 仍设置 persona', 'persona' in bCfg);
  check('builtin 仍设置 maxDepth', bCfg.maxDepth === 1);
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
}

section('planCliMounts：有效 CLI 预设挂载（无全局闸门）');
{
  const { cliFieldsFor } = await import('../src/cli/drivers.js');
  const mk = (id, backend) => normalizeRole({
    id, backend, description: 'd', instructions: 'i', model: 'm', provider: 'p',
    readOnly: true, cliDriver: 'grok', ...cliFieldsFor('grok', true), cliCwd: 'C:/w',
  }, 0).role;
  const roles = [mk('a', 'spawn'), mk('b', 'cli'), mk('c', 'cli'), mk('d', 'fork')];

  const plan = planCliMounts(roles);
  check(
    '只有 CLI 角色被挂载',
    plan.active.map((r) => r.id).join(',') === 'b,c',
    JSON.stringify(plan.active.map((r) => r.id)),
  );
  check('有效预设的 blocked 为空（不再有全局闸门）', plan.blocked.length === 0, JSON.stringify(plan.blocked));

  const noCli = planCliMounts([mk('a', 'spawn'), mk('b', 'fork')]);
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
  const mixed = [mk('s1', 'spawn'), mk('c1', 'cli'), mk('s2', 'fork'), mk('c2', 'cli')];
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
