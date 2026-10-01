#!/usr/bin/env node
/* 从真机 DeviceStorage 分块拉取文件到本地（经调试口，base64 分段）。
 * 用法：node scripts/pullfile.js <设备存储路径> <本地输出> [起始偏移] [长度]
 * 例：node scripts/pullfile.js "/sdcard/DCIM/100KAIOS/VID_0010.3gp" logs/sys.3gp */
'use strict';
const net = require('net');
const fs = require('fs');

const PORT = parseInt(process.env.RDD_PORT || '6000', 10);
const APP = 'app://33daac74-00f5-4d53-bf47-3fc53103a55f/manifest.webapp';
const remotePath = process.argv[2];
const outFile = process.argv[3];
const startOff = parseInt(process.argv[4] || '0', 10);
const lengthArg = process.argv[5];
const CHUNK = 140000;

if (!remotePath || !outFile) { console.error('用法: node pullfile.js <存储路径> <输出> [偏移] [长度]'); process.exit(1); }

const sock = net.connect({ host: '127.0.0.1', port: PORT });
sock.setNoDelay(true);
let buf = Buffer.alloc(0);
let actors = null;
const waiters = [];

function send(o) { const j = JSON.stringify(o); sock.write(j.length + ':' + j); }
function request(o) { return new Promise((res) => { waiters.push(res); send(o); }); }

function feed() {
  for (;;) {
    const colon = buf.indexOf(':');
    if (colon === -1) return;
    const len = parseInt(buf.slice(0, colon).toString(), 10);
    if (Number.isNaN(len)) return;
    if (buf.length < colon + 1 + len) return;
    const p = buf.slice(colon + 1, colon + 1 + len).toString();
    buf = buf.slice(colon + 1 + len);
    let o;
    try { o = JSON.parse(p); } catch (e) { continue; }
    if (!actors && o.from === 'root' && o.webappsActor) { actors = o; main().catch(fatal); continue; }
    const w = waiters.shift();
    if (w) w(o);
  }
}

function fatal(e) { console.error('FAIL: ' + (e && e.message || e)); process.exit(1); }

async function evalNow(text) {
  let r = await request({ to: actors.webappsActor, type: 'getAppActor', manifestURL: APP });
  if (!r.actor) throw new Error('getAppActor 失败');
  r = await request({ to: r.actor.consoleActor, type: 'evaluateJS', text: text, frameActor: null });
  if (process.env.PULL_DEBUG) console.error('RAW ' + JSON.stringify(r).slice(0, 200));
  if (r.error) throw new Error('eval ' + r.error);
  if (r.exception) throw new Error('页面异常');
  let v = (r.result !== undefined) ? r.result : r.value;
  if (v && typeof v === 'object' && v.type === 'longString') {
    let out = v.initial || '';
    while (out.length < v.length) {
      const rr = await request({ to: v.actor, type: 'substring', start: out.length, end: Math.min(out.length + 1000000, v.length) });
      if (rr.error) throw new Error('substring failed');
      out += (typeof rr.substring === 'string') ? rr.substring : '';
    }
    v = out;
  }
  if (v && typeof v === 'object' && v.type === 'string') return v.value;
  const s = JSON.stringify(v);
  if (typeof v === 'string') return s.slice(1, -1); /* 去掉 JSON 引号 */
  return s.slice(0, 250);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function main() {
  await request({ to: actors.webappsActor, type: 'close', manifestURL: APP });
  await sleep(1500);
  await request({ to: actors.webappsActor, type: 'launch', manifestURL: APP });
  await sleep(11000);
  await evalNow('1+1');

  const parts = [];
  /* enumerate 游标定位文件（get() 跨应用会被权限拒绝，但游标句柄可读） */
  const findExpr = `(function(){ try { var st = navigator.getDeviceStorage("videos"); var cur = st.enumerate(); var found = null; var done = false; cur.onsuccess = function () { var f = cur.result; if (done) return; if (f) { if (f.name === "${remotePath}" || f.name === "${remotePath.replace(/^\/sdcard\//, '')}") { found = f; done = true; window.__f = "found"; window.__fsize = f.size; return; } cur.continue(); } else if (!found) { done = true; window.__f = "notfound"; } }; cur.onerror = function () { if (!done) { done = true; window.__f = "err"; } }; } catch (e) { window.__f = "throw " + e.name; } return "started"; })()`;
  await evalNow(findExpr);
  await sleep(4000);
  const fFlag = await evalNow('window.__f + ""');
  const fsizeRaw = await evalNow('String(window.__fsize)');
  const fsize = parseInt(fsizeRaw.replace(/[^0-9-]/g, ''), 10);
  if (fFlag !== 'found' || Number.isNaN(fsize) || fsize < 0) throw new Error('文件未找到或读取失败: ' + remotePath + ' (' + fFlag + ')');
  const usePath = remotePath;
  const end = lengthArg ? Math.min(startOff + parseInt(lengthArg, 10), fsize) : fsize;
  console.log('FILE ' + usePath + ' size=' + fsize + ' 拉取范围 [' + startOff + ', ' + end + ') flag=' + fFlag);

  /* 分块：每次重新枚举定位到目标文件后读一段（游标句柄不跨 eval 保留） */
  for (let off = startOff; off < end; off += CHUNK) {
    const to = Math.min(off + CHUNK, end);
    await evalNow(`(function(){ try { var st = navigator.getDeviceStorage("videos"); var cur = st.enumerate(); cur.onsuccess = function () { var f = cur.result; if (!f) { window.__chunk = "notfound"; return; } if (f.name === "${remotePath}" || f.name === "${remotePath.replace(/^\/sdcard\//, '')}") { var fr = new FileReader(); fr.onload = function () { var u = new Uint8Array(fr.result); var s = ""; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); window.__chunk = btoa(s); }; fr.onerror = function () { window.__chunk = "fr-err"; }; fr.readAsArrayBuffer(f.slice(${off}, ${to})); return; } cur.continue(); }; cur.onerror = function () { window.__chunk = "err"; }; } catch (e) { window.__chunk = "throw " + e.name; } return "fired"; })()`);
    await sleep(1500);
    let b64 = '';
    for (let tries = 0; tries < 10; tries++) {
      b64 = await evalNow('window.__chunk || ""');
      if (b64 && b64 !== 'err' && b64.indexOf('throw') !== 0) break;
      await sleep(800);
    }
    if (!b64 || b64 === 'err') throw new Error('chunk@' + off + ' 读取失败');
    const piece = Buffer.from(b64, 'base64');
    parts.push(piece);
    process.stdout.write('chunk ' + off + '-' + to + ' (' + piece.length + 'B)\n');
  }
  fs.writeFileSync(outFile, Buffer.concat(parts));
  console.log('SAVED ' + outFile + ' (' + Buffer.concat(parts).length + 'B)');
  process.exit(0);
}

sock.on('data', (d) => { buf = Buffer.concat([buf, d]); feed(); });
sock.on('error', (e) => fatal(e));
sock.on('connect', () => send({ to: 'root', type: 'listTabs' }));
setTimeout(() => fatal(new Error('总超时')), 600000);
