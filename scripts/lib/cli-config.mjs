// 用户配置是唯一命令来源；这里只读取/校验/生成分离 argv，不执行 CLI。
import { readFileSync } from 'node:fs';
import { buildArgs, findUnknownPlaceholders, validateTemplate } from '../../src/cli/argv.js';
import { parsePathArgs, pathValue, resolvePaths, printPaths } from './paths.mjs';

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new Error(`${label} 必须是非空字符串`);
}
function array(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || /[\0\r\n]/.test(item))) {
    throw new Error(`${label} 必须是有效字符串数组`);
  }
  const unknown = findUnknownPlaceholders(value);
  if (unknown.length) throw new Error(`${label} 未知占位符：${unknown.join(', ')}`);
}
function command(value, label) {
  text(value, label);
  if (/[{}]/.test(value)) throw new Error(`${label} 不允许占位符`);
}

export function validateCliConfig(config, { cwd = process.cwd() } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('CLI 配置必须是对象');
  // 保留顶层入口格式，同时允许各用例声明自己的入口。
  if (config.command !== undefined) command(config.command, 'command');
  if (config.prefixArgs !== undefined) array(config.prefixArgs, 'prefixArgs');
  if (!config.cases || typeof config.cases !== 'object' || Array.isArray(config.cases)
    || !Object.keys(config.cases).length) throw new Error('cases 必须是非空用例对象');
  const cases = {};
  for (const [name, spec] of Object.entries(config.cases)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`cases.${name} 必须是对象`);
    const executable = Object.hasOwn(spec, 'command') ? spec.command : config.command;
    const prefixArgs = Object.hasOwn(spec, 'prefixArgs') ? spec.prefixArgs : config.prefixArgs;
    command(executable, `${name}.command`);
    array(prefixArgs, `${name}.prefixArgs`);
    array(spec.args, `${name}.args`);
    text(spec.promptDelivery, `${name}.promptDelivery`);
    // prefixArgs 也参与提示词传递一致性校验。
    const errors = validateTemplate([...prefixArgs, ...spec.args], { promptDelivery: spec.promptDelivery });
    if (errors.length) throw new Error(`${name}: ${errors.join('；')}`);
    for (const key of ['model', 'effort']) if (spec[key] !== undefined) text(spec[key], `${name}.${key}`);
    cases[name] = { command: executable, prefixArgs: [...prefixArgs],
      args: [...spec.args], promptDelivery: spec.promptDelivery,
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.effort === undefined ? {} : { effort: spec.effort }),
      ...(spec.cwd === undefined ? {} : { cwd: pathValue(spec.cwd, `${name}.cwd`, cwd) }) };
  }
  return { command: config.command, prefixArgs: config.prefixArgs === undefined ? undefined : [...config.prefixArgs], cases };
}

export function loadCliConfig({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  const options = parsePathArgs(argv);
  const explicit = Object.hasOwn(options, 'cli-config');
  if (!explicit && !Object.hasOwn(env, 'SWITCHBOARD_CLI_CONFIG')) {
    throw new Error('请提供 --cli-config 或 SWITCHBOARD_CLI_CONFIG（建议 *.local）');
  }
  const source = explicit ? '--cli-config' : 'SWITCHBOARD_CLI_CONFIG';
  const file = pathValue(explicit ? options['cli-config'] : env.SWITCHBOARD_CLI_CONFIG, source, cwd);
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`无法读取有效 CLI JSON 配置：${file}`); }
  return { file, source, config: validateCliConfig(data, { cwd }) };
}

// 调用方仅可 spawn(result.command, result.argv, result.options)，shell 恒为 false。
export function cliInvocation(loaded, caseName, values, options = {}) {
  const spec = loaded.config.cases[caseName];
  if (!spec) throw new Error(`未知 CLI 用例：${caseName}`);
  const paths = resolvePaths({ ...options, cliCwd: spec.cwd });
  printPaths(paths, options.log ?? console.log);
  const argv = buildArgs([...spec.prefixArgs, ...spec.args], {
    model: spec.model, effort: spec.effort, ...values, cwd: paths.cwd,
  });
  return { command: spec.command, argv, promptDelivery: spec.promptDelivery,
    options: { cwd: paths.cwd, shell: false } };
}
