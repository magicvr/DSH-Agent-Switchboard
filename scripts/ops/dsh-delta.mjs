// 只读判定：本机 DSH 运行时相对「仓库 pin 的版本」是**纯版本坐标变更**，还是接口真的变了。
//
// 为什么需要它：本插件把 DSH 版本精确 pin 在 `peerDependencies` 上（理由见 docs/decisions.md
// D32）。代价是每次 DSH 发版都被版本门禁拒载，必须重 pin；而重 pin 之前必须确认「这次改的
// 只是版本号，还是连接口一起改了」——后者直接重 pin 会让插件加载到一个已破坏 API 的运行时上，
// 正是本项目一直在防的静默失效。
//
// 本命令**只读、不改任何仓库文件**：它把 pin 的版本与本机运行时版本都从 npm 取下来，
// 逐包做逐字节比对，然后给出结论。它刻意**不**替你改 package.json——判定与改动分开，
// 判定可以自动化，改动要人看过结论。
//
// 用法：
//   node scripts/ops/dsh-delta.mjs            人类可读报告
//   node scripts/ops/dsh-delta.mjs --json     机器可读
//
// 退出码（只由「阻塞面」决定，见 SURFACES）：
//   0  阻塞面只改版本坐标（可安全重 pin）；或两边版本已相同
//   1  阻塞面有非本地化的代码差异（必须先核对，可能要改代码）
//   2  无法判定（归档不可用、网络取不到、包缺失）
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSync } from '../lib/capture.mjs';
import { openAsar, readJson } from '../lib/asar.mjs';
import { resolveAsar, REPO_ROOT } from '../lib/paths.mjs';

/**
 * 要比对的三张「面」。
 *
 * 分组不是为了好看：**判定强度不同**。`blocking` 为真的面一旦有非本地化代码差异，就必须先核对
 * 再重 pin；不阻塞的面只把变化列出来——本工具没有能力把那里的「UI 改动」与「契约改动」区分开，
 * 假装能判就是在制造它本该防的那种静默失效。
 *
 * 刻意不是归档里全部 `@deepseek-ai/dsh*`（两百多个）：逐包下载两版代价过高，而这批包覆盖了
 * 本插件全部接触点。新增对某个 DSH 包的依赖、或新增一处对 DSH 服务语义的镜像时，往对应面加一行。
 */
const SURFACES = [
  {
    id: 'contract',
    label: '契约面',
    blocking: true,
    note: '插件运行时真正 import / 编排的包与其声明 peer。',
    packages: [
      ['dsh-app-boot', '版本门禁本身（unmetRequirements / getDshRuntimeVersion）'],
      ['dsh-tools', 'defineTool / ToolRuntime / schema DSL'],
      ['dsh-scope', 'scopeOf'],
      ['dsh-tool-subagent', '委派工具 Config、装载期 preset 校验、persona/toolFilter 硬拒'],
      ['dsh-subagent', 'provider 契约与 SubagentStartRequest'],
      ['dsh-subagent-spawn-in-process', 'provider 能力位（agentPreset / depthLimit）'],
      ['dsh-agent-preset-registry', 'agentPresets.register / readDocument'],
      ['dsh-persona', '角色 persona 行（config.prefix）'],
      ['dsh-system-prompt', 'section 注册与渲染'],
      ['dsh-agent', 'assembleContextFor'],
      ['dsh-web-app', '上游 standard preset（决定生成物是否需要重新生成）'],
      ['dsh-typert-protocol', '声明的 peer'],
    ],
  },
  {
    id: 'lifecycle',
    label: '安装/更新/卸载服务面',
    blocking: true,
    note: 'DSH 自己执行包管理；本仓库的生命周期工具镜像它的门禁语义、CLI 语法与 profile 布局，'
      + '这一面变了，提示文案与文档证据就过期了。',
    packages: [
      ['dsh-plugin-manager', '插件服务、兼容性门禁、plugin 子命令共用实现'],
      ['dsh-package-manifest', '插件 manifest 解析'],
      ['dsh-host-plugin-inventory', '已安装插件清单'],
      ['dsh-cmdline', 'dsh CLI 子命令与参数'],
      ['dsh', '启动器（含 plugin 子命令转发）'],
      ['dsh-home-paths', 'profile / home 路径布局'],
      ['dsh-client-ui-plugin-manager', 'Plugins 页（人工安装/卸载通道）'],
      ['dsh-client-ui-settings-plugins', '设置页插件段'],
      ['dsh-client-ui-plugin-market', '插件市场'],
    ],
  },
  {
    id: 'client',
    label: '客户端半边',
    blocking: false,
    note: '静态 inject 目标、slot 宿主、remote 通道与 __ModuleLoader__ 加载契约。'
      + '客户端包几乎每个版本都会改 UI bundle，本工具区分不了 UI 与契约，因此只报告、不参与判定。',
    reviewHint: '这些包里的 slot 名 / remote 方法 / __ModuleLoader__ 载荷字段有没有被改',
    packages: [
      ['dsh-client-modules', '__ModuleLoader__ 加载契约'],
      ['dsh-client-ui-conversation', '静态 inject 目标与 slot 宿主'],
      ['dsh-client-ui-settings', 'remote.settings API 宿主'],
      ['dsh-settings', 'volatile 字段暴露与写入'],
      ['dsh-client-connection', 'remote 通道'],
    ],
  },
];

/** 版本坐标（`package.json` 的版本号与依赖 pin）不是接口差异，单列出来。 */
const COORDINATE_ONLY_FILES = new Set(['package.json']);

/** 本地化文案变化不构成接口变化。 */
const isLocaleFile = (path) => path.startsWith('locale/') || path.includes('/locale/');

/**
 * 是否是**接口/实现**文件。
 *
 * 只有这类差异才要求先核对代码；预设 YAML、文档之类的资产变化不影响本插件能否加载，
 * 混在一起判会把无害差异报成阻塞项（反之也会让人以为「都一样」）。
 */
const isCodeFile = (path) => /\.(js|mjs|cjs|ts|mts|cts)$/.test(path);

/** 我们真正复制进 preset 的上游文件：它一变，生成物就必须重新生成。 */
const UPSTREAM_STANDARD_PRESET = 'presets/standard.patch.yml';

const EXIT = { COORDINATE_ONLY: 0, CODE_CHANGED: 1, UNDECIDABLE: 2 };

/**
 * 把目录下所有文件的相对路径映射到内容哈希（跳过 `package.json`）。
 *
 * @param {string} root - 目录绝对路径。
 * @returns {Map<string, string>} 相对路径（POSIX 分隔）→ sha256。
 */
function hashTree(root) {
  const out = new Map();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, path); continue; }
      if (COORDINATE_ONLY_FILES.has(path)) continue;
      out.set(path, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(root, '');
  return out;
}

/**
 * 取一个包某个版本的 npm 包体 URL。
 *
 * @param {string} name - 不带 scope 的包名。
 * @param {string} version - 精确版本。
 * @param {string} registry - registry 基址（无尾斜杠）。
 * @returns {string} tarball URL。
 */
function tarballUrl(name, version, registry) {
  return `${registry}/@deepseek-ai/${name}/-/${name}-${version}.tgz`;
}

/**
 * 下载并解包一个包的指定版本到 `<workDir>/<name>@<version>`。
 *
 * @param {string} name - 包名。
 * @param {string} version - 精确版本。
 * @param {string} registry - registry 基址。
 * @param {string} workDir - 临时工作目录。
 * @returns {Promise<string>} 解包后的目录。
 */
async function fetchPackage(name, version, registry, workDir) {
  const target = join(workDir, `${name}@${version}`);
  const url = tarballUrl(name, version, registry);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`取包失败 ${url}：HTTP ${response.status}`);
  const tarball = join(workDir, `${name}-${version}.tgz`);
  writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
  mkdirSync(target, { recursive: true });
  // 只用 POSIX/bsdtar 都支持的基础选项：`--one-top-level` 是 GNU 扩展，Windows 自带
  // 的 bsdtar 不认，因此显式建目录再 `--strip-components=1` 解进去。
  const extracted = captureSync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1'],
    { maxBuffer: 4 * 1024 * 1024 });
  if (extracted.status !== 0) {
    throw new Error(`解包失败 ${tarball}：${extracted.error?.message ?? (extracted.stderr.trim() || `退出码 ${extracted.status}`)}`);
  }
  return target;
}

/**
 * 比较两棵文件树的哈希。
 *
 * @param {Map<string, string>} pinned - pin 版本一侧。
 * @param {Map<string, string>} runtime - 运行时版本一侧。
 * @returns {{changed: string[], added: string[], removed: string[]}} 分类后的路径。
 */
function compareTrees(pinned, runtime) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [path, hash] of runtime) {
    if (!pinned.has(path)) added.push(path);
    else if (pinned.get(path) !== hash) changed.push(path);
  }
  for (const path of pinned.keys()) if (!runtime.has(path)) removed.push(path);
  return { changed, added, removed };
}

/**
 * 读取仓库 pin 的 DSH 版本：四个 dsh peers 必须是同一个精确版本。
 *
 * @returns {{version: string, peers: Record<string, string>}} pin 结果。
 * @throws 当 peers 不是同一个精确 SemVer 时。
 */
function pinnedVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const peers = Object.fromEntries(Object.entries(pkg.peerDependencies ?? {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')));
  const versions = [...new Set(Object.values(peers))];
  const exact = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
  if (versions.length !== 1 || !exact.test(versions[0] ?? '')) {
    throw new Error(`peerDependencies 里的 DSH 版本不是同一个精确版本：${JSON.stringify(peers)}；` +
      '本命令只在「精确 pin」前提下有意义（见 docs/decisions.md D32）');
  }
  return { version: versions[0], peers };
}

/**
 * 比对一张面里的全部包。
 *
 * @param {object} surface - SURFACES 的一项。
 * @param {{pinned: string, runtime: string, registry: string, workDir: string}} run - 本次运行参数。
 * @returns {Promise<object[]>} 每个包的比对结果。
 */
async function compareSurface(surface, run) {
  const results = [];
  for (const [name, why] of surface.packages) {
    let pinnedDir;
    let runtimeDir;
    try {
      [pinnedDir, runtimeDir] = await Promise.all([
        fetchPackage(name, run.pinned, run.registry, run.workDir),
        fetchPackage(name, run.runtime, run.registry, run.workDir),
      ]);
    } catch (error) {
      // 单个包取不到（例如该版本未发布该包）不算致命，如实记为无法判定。
      results.push({ name, why, status: 'unavailable', detail: error.message });
      continue;
    }
    const diff = compareTrees(hashTree(pinnedDir), hashTree(runtimeDir));
    const all = [...diff.changed, ...diff.added, ...diff.removed];
    const code = all.filter((path) => isCodeFile(path) && !isLocaleFile(path));
    const asset = all.filter((path) => !isCodeFile(path) && !isLocaleFile(path));
    const localeCount = all.length - code.length - asset.length;
    results.push({
      name, why,
      status: code.length > 0 ? 'code-changed'
        : asset.length > 0 ? 'asset-only'
          : localeCount > 0 ? 'locale-only' : 'identical',
      code,
      asset,
      localeCount,
      // 上游 standard preset 是否变化，决定生成物要不要重新生成。
      standardPresetChanged: name === 'dsh-web-app' && all.includes(UPSTREAM_STANDARD_PRESET),
    });
  }
  return results;
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const unknown = args.filter((arg) => arg !== '--json');
if (unknown.length > 0) {
  console.error(`未知参数：${unknown.join(' ')}；用法：node scripts/ops/dsh-delta.mjs [--json]`);
  process.exit(EXIT.UNDECIDABLE);
}

let archivePath;
try {
  archivePath = resolveAsar().archive;
} catch (error) {
  console.error(`无法判定：${error.message}`);
  process.exit(EXIT.UNDECIDABLE);
}

const archive = openAsar(archivePath);
const runtimeManifest = readJson(archive, 'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json');
if (runtimeManifest?.version === undefined) {
  console.error('无法判定：归档里读不到 dsh-app-boot 的版本（门禁的实际真源）');
  process.exit(EXIT.UNDECIDABLE);
}
const runtime = runtimeManifest.version;

let pinned;
try {
  pinned = pinnedVersion();
} catch (error) {
  console.error(`无法判定：${error.message}`);
  process.exit(EXIT.UNDECIDABLE);
}

const registry = (process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org')
  .replace(/\/+$/, '');

if (runtime === pinned.version) {
  if (asJson) console.log(JSON.stringify({ runtime, pinned: pinned.version, verdict: 'same', surfaces: [] }, null, 2));
  else {
    console.log(`运行时版本：${runtime}（来自归档 dsh-app-boot）`);
    console.log(`仓库 pin：  ${pinned.version}`);
    console.log('\nPASS  两边相同，无需任何处理。');
  }
  process.exit(EXIT.COORDINATE_ONLY);
}

// 需要下载两版做逐包比对。临时目录只放包体与解包结果，跑完即删。
const workDir = mkdtempSync(join(tmpdir(), 'dsh-delta-'));
const surfaces = [];
try {
  for (const surface of SURFACES) {
    surfaces.push({ ...surface, results: await compareSurface(surface, { pinned: pinned.version, runtime, registry, workDir }) });
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const blocking = surfaces.filter((surface) => surface.blocking);
const changedIn = (surface, status) => surface.results.filter((entry) => entry.status === status);
const codeChanged = blocking.flatMap((surface) => changedIn(surface, 'code-changed').map((entry) => ({ ...entry, surface })));
const unavailable = blocking.flatMap((surface) => changedIn(surface, 'unavailable').map((entry) => ({ ...entry, surface })));
const standardPresetChanged = surfaces.some((surface) => surface.results.some((entry) => entry.standardPresetChanged === true));
// ⚠️ 只要有一个阻塞面的包没比对上，就**不能**给出「可以放心重 pin」的结论——那是把「没看到差异」
//    当成「没有差异」。未比对的包一律计入「无法判定」，与仓库「未知不猜测」的原则一致。
const fullyCompared = unavailable.length === 0;
const verdict = codeChanged.length > 0 ? 'code-changed' : fullyCompared ? 'coordinate-only' : 'undecidable';
// 不阻塞的面：只把变化列出来。它不影响退出码，但绝不能静默——那是这次唯一需要人睁眼的部分。
const reviewSurfaces = surfaces.filter((surface) => !surface.blocking)
  .map((surface) => ({ surface, entries: surface.results.filter((entry) => entry.status !== 'identical') }))
  .filter((group) => group.entries.length > 0);

/** 一张面上单个包的一行报告；`blocking=false` 时只报告、不打 PASS/FAIL 的判定色彩。 */
function describeEntry(surface, entry, log) {
  const { name, why } = entry;
  if (entry.status === 'unavailable') { log(`  SKIP  ${name} — 取不到（${entry.detail}）`); return; }
  if (entry.status === 'identical') {
    log(`  ${surface.blocking ? 'PASS' : 'SAME'}  ${name} — 除版本坐标外逐字节相同`);
    return;
  }
  if (entry.status === 'locale-only') {
    log(`  ${surface.blocking ? 'PASS' : 'SAME'}  ${name} — 仅 ${entry.localeCount} 个本地化文案文件不同`);
    return;
  }
  const isCode = entry.status === 'code-changed';
  const label = surface.blocking ? (isCode ? 'FAIL' : 'WARN') : 'INFO';
  const kind = isCode ? '代码' : '资产/配置';
  const count = entry.code.length + entry.asset.length;
  log(`  ${label}  ${name} — ${count} 个${kind}文件不同`
    + `${entry.localeCount > 0 ? `（另有 ${entry.localeCount} 个本地化文件）` : ''}`);
  for (const path of [...entry.code, ...entry.asset].slice(0, 10)) log(`          ${path}`);
  if (count > 10) log(`          …（共 ${count} 个，已截断）`);
}

if (asJson) {
  console.log(JSON.stringify({
    runtime,
    pinned: pinned.version,
    registry,
    verdict,
    standardPresetChanged,
    surfaces: surfaces.map((surface) => ({
      id: surface.id,
      label: surface.label,
      blocking: surface.blocking,
      packages: surface.results,
    })),
  }, null, 2));
} else {
  console.log(`运行时版本：${runtime}（来自归档 dsh-app-boot）`);
  console.log(`仓库 pin：  ${pinned.version}`);
  console.log(`比对方式：  两版包体均从 ${registry} 取，逐文件 sha256（忽略 package.json；代码与资产分开判定）\n`);
  for (const surface of surfaces) {
    console.log(`=== ${surface.label}（${surface.blocking ? '阻塞' : '不参与判定'}，${surface.packages.length} 个包）===`);
    console.log(`    ${surface.note}`);
    for (const entry of surface.results) describeEntry(surface, entry, console.log);
    console.log('');
  }

  if (codeChanged.length > 0) {
    console.log(`结论：**有 ${codeChanged.length} 个包的接口/实现发生变化**，必须先核对下列包再决定改哪些代码；`);
    console.log('  直接重 pin 会让插件加载到已改变的 API 上（这正是本项目一直在防的静默失效）。');
    for (const entry of codeChanged) console.log(`  - ${entry.name}（${entry.surface.label}：${entry.why}）`);
  } else if (!fullyCompared) {
    console.log(`结论：**无法判定**——有 ${unavailable.length} 个包没比对上，不能据此断言「可以放心重 pin」。`);
    console.log('  （把「没看到差异」当成「没有差异」正是本项目一直在防的失效。）');
    for (const entry of unavailable) console.log(`  - ${entry.name}（${entry.surface.label}）：${entry.detail}`);
    console.log('  取不到多半是网络/registry 不可用，或该包在这个版本尚未发布（后者本身就是需要人看一眼的信号）。');
  } else {
    console.log(`结论：**只改版本坐标**（阻塞面 ${blocking.reduce((sum, surface) => sum + surface.results.length, 0)} 个包全部无接口/实现变化），可以放心重 pin。`);
    console.log(`  package.json 四个 dsh peers 改成 "${runtime}"，然后 npm install → npm run check → node scripts/ops/plugin-lifecycle.mjs verify。`);
    const assetChanged = blocking.flatMap((surface) => surface.results.filter((entry) => entry.status === 'asset-only'));
    if (assetChanged.length > 0) {
      console.log(`  另：${assetChanged.length} 个包有资产/配置变化（上方 WARN），不影响本插件加载。`);
    }
    if (standardPresetChanged) {
      console.log('\n⚠️ 上游 `presets/standard.patch.yml` 变了 → 生成物需要重新生成：跑 `npm run check:preset`，漂移则 `npm run gen:preset`，再用 `plugin-lifecycle upgrade --apply` 收敛（preset 由 bundle 投递，工具只剥离 profile 残留副本）并完全重启。');
    } else {
      console.log('上游 `presets/standard.patch.yml` 未变 → 生成物无需重新生成，profile 也无需改动。');
    }
  }
  for (const { surface, entries } of reviewSurfaces) {
    console.log(`\nℹ️ ${surface.label}有 ${entries.length} 个包存在实现变化（上方 INFO），**不参与上面的判定**；`);
    console.log(`   本工具分不出那里的 UI 改动与契约改动，重 pin 前请人看一眼：${surface.reviewHint}。`);
    for (const entry of entries) console.log(`   - ${entry.name}（${entry.why}）`);
  }
}

process.exit(EXIT[verdict === 'code-changed' ? 'CODE_CHANGED' : verdict === 'undecidable' ? 'UNDECIDABLE' : 'COORDINATE_ONLY']);
