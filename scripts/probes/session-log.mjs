// 现场探针：读某个 DSH 会话的事件日志（多帧 zstd 的 JSONL），按窗口/关键字打印时间线。
//
// 用途：会话日志是**权威时间源**。界面上的记时可能挂在别的对象上（实测：轨迹面板把
// `job_output` 那一步的耗时挂在 job 标签下，于是显示成「5 毫秒」——任务其实跑了 17.5 秒）。
// 要判断「谁在什么时候做了什么」，都应以本日志为准。
//
// 用法：
//   node scripts/probes/session-log.mjs                       # 列出可读会话（按最近写入排序）
//   node scripts/probes/session-log.mjs <id 前缀>              # 打印该会话全部事件
//   node scripts/probes/session-log.mjs <id 前缀> --grep=<子串> # 只看含该子串的事件
//   node scripts/probes/session-log.mjs <id 前缀> --from=21:20 --to=21:30   # 只看时间窗口
//
// 实现要点：日志是**多帧拼接**的 zstd（每次追加一帧），Node 的 `zstdDecompressSync` 只解
// **第一帧**，所以必须先按 zstd 魔数（0x28B52FFD）与 skippable 帧魔数（0x184D2A5x）切帧、
// 再逐帧解。（二分法定位帧边界不可靠 —— 实测会切在错的位置。）
//
// 会话目录布局：`$DSH_HOME/sessions/<工作区目录名>/<session-id>/session.v4.jsonl.zstd`；
// 子代理（`send_message` 的目标）也各有一份，目录名就是它的 id。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const sessionsRoot = join(home, 'sessions');
const LOG_NAME = join('session.v4.jsonl.zstd');

/** 列出所有可读会话：{ id, file, size, mtime }，按最近写入排序。 */
export function listSessions() {
  const found = [];
  for (const workspace of readdirSync(sessionsRoot)) {
    const dir = join(sessionsRoot, workspace);
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const id of entries) {
      const file = join(dir, id, LOG_NAME);
      if (!existsSync(file)) continue;
      const stat = statSync(file);
      found.push({ id, file, size: stat.size, mtime: stat.mtime });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** 解出会话日志的全部事件（对象数组）。坏帧跳过，不因此中断。 */
export function readSessionEvents(file) {
  const buf = readFileSync(file);
  const offsets = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) offsets.push(i);
    else if (buf[i] === 0x50 && buf[i + 1] === 0x2A && buf[i + 2] === 0x4D && buf[i + 3] === 0x18) offsets.push(i);
  }
  if (offsets.length === 0) offsets.push(0);
  let text = '';
  for (let k = 0; k < offsets.length; k++) {
    const slice = buf.subarray(offsets[k], offsets[k + 1] ?? buf.length);
    try { text += zstdDecompressSync(slice).toString('utf8'); } catch { /* 跳过坏帧 */ }
  }
  return text.split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

const stampOf = (event) => event.time ?? event.timestamp ?? event.ts ?? event.at ?? event.createdAt;
const localTime = (event) => {
  const value = stampOf(event);
  return value === undefined ? '(无时间戳)'
    : new Date(value).toLocaleString('sv-SE', { timeZone: process.env.TZ ?? 'Asia/Shanghai' });
};

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/probes/session-log.mjs');
if (invokedDirectly) {
  const prefix = process.argv[2];
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const all = listSessions();
  if (prefix === undefined) {
    for (const session of all.slice(0, 20)) {
      console.log(`${session.mtime.toISOString()} ${String(Math.round(session.size / 1024)).padStart(5)}KB ${session.id}`);
    }
  } else {
    const found = all.find((session) => session.id.includes(prefix));
    if (found === undefined) throw new Error(`找不到会话：${prefix}`);
    const events = readSessionEvents(found.file);
    const grep = arg('grep');
    const from = arg('from');
    const to = arg('to');
    console.log(`会话 ${found.id}｜事件 ${events.length}｜${Math.round(found.size / 1024)}KB`);
    for (const event of events) {
      const body = JSON.stringify(event);
      if (grep !== undefined && !body.includes(grep)) continue;
      if (from !== undefined || to !== undefined) {
        const hhmm = localTime(event).slice(11, 16);
        if (from !== undefined && hhmm < from) continue;
        if (to !== undefined && hhmm > to) continue;
      }
      console.log(`${localTime(event)} | ${(event.type ?? event.kind ?? '?').padEnd(22)} | ${body.slice(0, 260)}`);
    }
  }
}
