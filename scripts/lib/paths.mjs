// 只解析路径；不创建目录、不读取角色，不在 import 时缓存环境。
import { homedir as osHomedir } from 'node:os';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { configPathFor } from '../../src/config-file.js';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PATH_FLAGS = ['home', 'profile', 'patch', 'roles-file', 'cwd', 'cli-config'];

export function pathValue(value, label, cwd) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} 必须是非空有效路径`);
  }
  return resolve(cwd, value);
}

export function parsePathArgs(argv = process.argv.slice(2), allowed = PATH_FLAGS) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!allowed.includes(key)) throw new Error(`未知参数：${argv[i]}`);
    const value = argv[++i];
    if (typeof value !== 'string' || value.startsWith('--') || !value.trim()) {
      throw new Error(`--${key} 缺少有效路径`);
    }
    if (Object.hasOwn(out, key) && out[key] !== value) throw new Error(`--${key} 重复冲突`);
    out[key] = value;
  }
  return out;
}

function userHome(homedir) {
  try {
    const value = homedir();
    if (typeof value !== 'string' || !value.trim() || !isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error();
    return value;
  } catch {
    throw new Error('无法获取用户 home；请使用 --home 或 DSH_HOME（ASAR 请设置 DSH_ASAR）');
  }
}

export function resolvePaths({ argv = process.argv.slice(2), env = process.env,
  cwd = process.cwd(), homedir = osHomedir, cliCwd } = {}) {
  const options = parsePathArgs(argv);
  const sources = {};
  const pick = (key, environment, fallback, fallbackSource) => {
    if (Object.hasOwn(options, key)) {
      sources[key] = `--${key}`;
      return pathValue(options[key], `--${key}`, cwd);
    }
    if (environment && Object.hasOwn(env, environment)) {
      sources[key] = environment;
      return pathValue(env[environment], environment, cwd);
    }
    sources[key] = fallbackSource;
    return fallback();
  };
  const home = pick('home', 'DSH_HOME', () => join(userHome(homedir), '.dsh'), 'os.homedir()');
  const profile = pick('profile', null, () => join(home, 'profiles', 'desktop'), 'home 推导');
  const patch = pick('patch', null, () => join(profile, 'cordis.patch.yml'), 'profile 推导');
  const roles = pick('roles-file', null, () => configPathFor(home), 'configPathFor(home)');
  const workdir = pick('cwd', null, () => cliCwd === undefined ? REPO_ROOT : pathValue(cliCwd, 'CLI 配置 cwd', cwd),
    cliCwd === undefined ? '仓库根（模块 URL）' : 'CLI 用例配置');
  return { repoRoot: REPO_ROOT, home, profile, patch, roles, cwd: workdir,
    sources: { home: sources.home, profile: sources.profile, patch: sources.patch,
      roles: sources['roles-file'], cwd: sources.cwd },
    explicitTarget: ['home', 'profile', 'patch', 'roles-file'].some(key => Object.hasOwn(options, key))
      || Object.hasOwn(env, 'DSH_HOME') };
}

export function printPaths(paths, log = console.log) {
  for (const key of ['home', 'profile', 'patch', 'roles', 'cwd']) log(`${key}: ${paths[key]} [${paths.sources[key]}]`);
}

export function resolveAsar({ env = process.env, cwd = process.cwd(), homedir = osHomedir,
  platform = process.platform, isFile = path => { try { return statSync(path).isFile(); } catch { return false; } } } = {}) {
  let archive;
  let source;
  if (Object.hasOwn(env, 'DSH_ASAR')) {
    archive = pathValue(env.DSH_ASAR, 'DSH_ASAR', cwd);
    source = 'DSH_ASAR';
  } else {
    if (platform !== 'win32') throw new Error('非 Windows 请显式设置 DSH_ASAR');
    const local = Object.hasOwn(env, 'LOCALAPPDATA')
      ? pathValue(env.LOCALAPPDATA, 'LOCALAPPDATA', cwd) : join(userHome(homedir), 'AppData', 'Local');
    archive = join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar');
    source = Object.hasOwn(env, 'LOCALAPPDATA') ? 'LOCALAPPDATA' : 'os.homedir() 推导';
  }
  if (!isFile(archive)) throw new Error(`找不到归档：${archive}；请设置 DSH_ASAR`);
  return { archive, source };
}
