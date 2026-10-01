// 受限沙箱不允许管道捕获：stdin/stdout/stderr 均通过临时文件描述符传递。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, writeFileSync, readFileSync, fstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function cleanup(files) {
  let error;
  try {
    for (const fd of files.fds) {
      try { closeSync(fd); } catch (cause) { error ??= cause; }
    }
    if (error) throw error;
  } finally { rmSync(files.dir, { recursive: true, force: true }); }
}

function prepare(input) {
  const files = { dir: mkdtempSync(join(tmpdir(), 'switchboard-capture-')), fds: [] };
  try {
    files.stdout = join(files.dir, 'stdout');
    files.stderr = join(files.dir, 'stderr');
    let stdin = 'ignore';
    if (input !== undefined) {
      const path = join(files.dir, 'stdin');
      writeFileSync(path, input);
      stdin = openSync(path, 'r');
      files.fds.push(stdin);
    }
    const stdout = openSync(files.stdout, 'w');
    files.fds.push(stdout);
    const stderr = openSync(files.stderr, 'w');
    files.fds.push(stderr);
    files.stdio = [stdin, stdout, stderr];
    return files;
  } catch (error) {
    cleanup(files);
    throw error;
  }
}

function output(files) {
  return { stdout: readFileSync(files.stdout, 'utf8'), stderr: readFileSync(files.stderr, 'utf8') };
}

function sizes(files) {
  return [fstatSync(files.stdio[1]).size, fstatSync(files.stdio[2]).size];
}

function outputError(maxBuffer) {
  return Object.assign(new Error(`CLI 输出超过 ${maxBuffer} 字节`), { code: 'ENOBUFS' });
}

// 同步形式保留真实退出码、信号与启动错误；maxBuffer 按单个输出文件在结束后判定。
// fd 不受 spawnSync 的管道缓冲上限约束，因此这里的上限不能在运行中限制磁盘写入。
export function captureSync(command, argv, { cwd, env, input, timeout, maxBuffer = Infinity } = {}) {
  const files = prepare(input);
  try {
    const result = spawnSync(command, argv, {
      cwd, env, timeout, shell: false, windowsHide: true, stdio: files.stdio,
    });
    const error = result.error ?? (sizes(files).some(size => size > maxBuffer) ? outputError(maxBuffer) : undefined);
    return { status: result.status, signal: result.signal, error, ...output(files) };
  } finally { cleanup(files); }
}

// 异步形式每 25ms 检查 stdout + stderr 合计字节数，超限时终止；结束时补查短进程。
// 轮询间隙可能超写；返回已写入的完整输出，不丢弃触发超限的部分。
export async function captureAsync(command, argv, { cwd, env, input, timeout, maxBuffer = Infinity } = {}) {
  const files = prepare(input);
  let timer;
  let monitor;
  try {
    const result = await new Promise(resolve => {
      const child = spawn(command, argv, {
        cwd, env, shell: false, windowsHide: true, stdio: files.stdio,
      });
      let error;
      const stop = cause => {
        if (error) return;
        error = cause;
        child.kill();
      };
      const checkSize = () => {
        try {
          if (sizes(files).reduce((sum, size) => sum + size, 0) > maxBuffer) stop(outputError(maxBuffer));
        } catch (cause) { stop(cause); }
      };
      if (timeout !== undefined && timeout > 0) {
        timer = setTimeout(() => stop(Object.assign(new Error(`CLI 超时 (${timeout}ms)`), { code: 'ETIMEDOUT' })), timeout);
      }
      if (Number.isFinite(maxBuffer)) monitor = setInterval(checkSize, 25);
      child.on('error', cause => { error ??= cause; });
      child.on('close', (status, signal) => {
        clearTimeout(timer);
        clearInterval(monitor);
        checkSize();
        resolve({ status, signal, error });
      });
    });
    return { ...result, ...output(files) };
  } finally {
    clearTimeout(timer);
    clearInterval(monitor);
    cleanup(files);
  }
}
