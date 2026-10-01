#!/usr/bin/env node
/* 蓝牙诊断自驱动：往手机上正在运行的 privileged 应用注入 JS，
 * 自动执行 扫描→程序配对→配对记录深挖→GATT 连接尝试，回传日志存盘。
 *
 * 用法（先 adb forward tcp:6000 localfilesystem:/data/local/debugger-socket）：
 *   node scripts/bt-diag.js
 */
'use strict';
const net = require('net');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PORT = parseInt(process.env.RDD_PORT || '6000', 10);

const sock = net.connect({ host: '127.0.0.1', port: PORT });
sock.setNoDelay(true);

let buf = Buffer.alloc(0);
let actors = null;
const waiters = [];

function send(obj) {
  const json = JSON.stringify(obj);
  if (process.env.RDD_DEBUG) console.error('SEND ' + json.slice(0, 200));
  sock.write(json.length + ':' + json);
}

function request(obj) {
  return new Promise((resolve) => {
    waiters.push(resolve);
    send(obj);
  });
}

/* 此固件 longString.substring 用 start/end，且 value 可能嵌套，需递归展开 */
async function unlongify(v) {
  if (!v || typeof v !== 'object') return v;
  if (v.type !== 'longString') return v;
  let out = v.initial || '';
  while (out.length < v.length) {
    const r = await request({
      to: v.actor,
      type: 'substring',
      start: out.length,
      end: Math.min(out.length + 1000000, v.length)
    });
    const piece = (typeof r.substring === 'string') ? r.substring : await unlongify(r.value);
    if (!piece) throw new Error('substring 返回空');
    out += piece;
  }
  try { send({ to: v.actor, type: 'release' }); } catch (e) { /* 响应可能不来 */ }
  return out;
}

function feed() {
  for (;;) {
    const colon = buf.indexOf(':');
    if (colon === -1) return;
    const len = parseInt(buf.slice(0, colon).toString(), 10);
    if (Number.isNaN(len) || len < 0 || len > 256 * 1024 * 1024) return;
    if (buf.length < colon + 1 + len) return;
    const payload = buf.slice(colon + 1, colon + 1 + len).toString();
    buf = buf.slice(colon + 1 + len);
    let o;
    try { o = JSON.parse(payload); } catch (e) { continue; }
    if (process.env.RDD_DEBUG) console.error('RECV ' + payload.slice(0, 200));
    if (o.from === 'root' && o.webappsActor && !actors) {
      actors = o;
      console.log('调试通道就绪');
      main().catch((e) => { console.error('FAIL:', e.message || e); process.exit(1); });
      continue;
    }
    const w = waiters.shift();
    if (w) w(o);
  }
}

/* 在响应 JSON 里递归找第一个 key 匹配 /consoleActor/i 且值是字符串的字段 */
function findConsoleActor(obj) {
  let hit = null;
  (function walk(o) {
    if (hit || !o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (/consoleActor/i.test(k) && typeof o[k] === 'string') { hit = o[k]; return; }
      walk(o[k]);
      if (hit) return;
    }
  })(obj);
  return hit;
}

async function evalInApp(consoleActor, text) {
  const r = await request({ to: consoleActor, type: 'evaluateJS', text });
  if (r.error) throw new Error('evaluateJS: ' + JSON.stringify(r).slice(0, 300));
  if (r.exception) throw new Error('注入异常: ' + JSON.stringify(r.exception).slice(0, 300));
  return unlongify(r.result);
}

const SNIPPET = fs.readFileSync(pathJoin('bt-diag-snippet.js'), 'utf8');
function pathJoin(name) { return require('path').join(__dirname, name); }

async function main() {
  const lr = await request({ to: actors.webappsActor, type: 'listRunningApps' });
  const apps = lr.apps || [];
  console.log('RUNNING ' + apps.length);

  /* 找一个有 mozBluetooth 的宿主应用 */
  let consoleActor = null, host = null;
  for (const murl of apps) {
    const ar = await request({ to: actors.webappsActor, type: 'getAppActor', manifestURL: murl });
    const ca = findConsoleActor(ar);
    if (!ca) { console.log('  ' + murl + ' → 无 consoleActor'); continue; }
    const who = await evalInApp(ca, 'location.href + " | " + document.title + " | mozBluetooth=" + !!navigator.mozBluetooth');
    console.log('  ' + murl + ' → ' + who);
    if (!host && /mozBluetooth=true/.test(String(who))) { host = murl; consoleActor = ca; }
  }
  if (!consoleActor) throw new Error('没有找到带 mozBluetooth 的运行中应用（先打开主应用或探针）');

  console.log('宿主: ' + host);
  const fired = await evalInApp(consoleActor, SNIPPET);
  console.log('注入返回: ' + fired);

  const deadline = Date.now() + 150000;
  let last = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const s = String(await evalInApp(consoleActor, 'JSON.stringify(window.__btDiag || null)'));
    if (s !== last) { console.log('--- 进度更新 ---'); last = s; }
    if (s && s.indexOf('"stage":"done"') !== -1) {
      const out = 'logs/bt-diag-' + Date.now() + '.txt';
      const pretty = JSON.parse(s).log.join('\n');
      fs.writeFileSync(out, pretty);
      console.log('=== 诊断日志 ===');
      console.log(pretty);
      console.log('SAVED ' + out);
      break;
    }
  }

  /* 顺带抓一份底层 logcat 蓝牙片段 */
  try {
    const lc = execFileSync('adb', ['logcat', '-d', '-t', '3000'], { maxBuffer: 32 * 1024 * 1024 }).toString();
    const bt = lc.split('\n').filter((l) => /bluetooth|gatt|btle|hci/i.test(l)).join('\n');
    const out = 'logs/device-bt-' + Date.now() + '.log';
    fs.writeFileSync(out, bt);
    console.log('SAVED ' + out + ' (' + bt.split('\n').length + ' 行底层蓝牙日志)');
  } catch (e) { console.error('logcat 抓取失败: ' + e.message); }

  sock.end();
  setTimeout(() => process.exit(0), 200);
}

sock.on('connect', () => send({ to: 'root', type: 'listTabs' }));
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); feed(); });
sock.on('error', (e) => { console.error('SOCKET ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 200000);
