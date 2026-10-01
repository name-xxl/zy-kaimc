#!/usr/bin/env node
/* 注入一段 JS 到运行中的应用并轮询结果变量。
 * 用法：node scripts/tmp-run-snippet.js <片段文件> [轮询表达式] [秒数]
 * 默认轮询表达式：JSON.stringify(window.__fakeDiag) */
'use strict';
const net = require('net');
const fs = require('fs');

const PORT = parseInt(process.env.RDD_PORT || '6000', 10);
const APP = process.env.APP_MANIFEST || 'app://33daac74-00f5-4d53-bf47-3fc53103a55f/manifest.webapp';
const file = process.argv[2];
const pollExpr = process.argv[3] || 'JSON.stringify(window.__fakeDiag)';
const seconds = parseInt(process.argv[4] || '40', 10);
if (!file) { console.error('用法: node scripts/tmp-run-snippet.js <片段文件> [轮询表达式] [秒数]'); process.exit(1); }
const code = fs.readFileSync(file, 'utf8');

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
async function unlongify(v) {
  if (!v || typeof v !== 'object' || v.type !== 'longString') return v;
  let out = v.initial || '';
  while (out.length < v.length) {
    const r = await request({ to: v.actor, type: 'substring', start: out.length, end: Math.min(out.length + 1000000, v.length) });
    if (r.error) throw new Error('substring failed');
    out += (typeof r.substring === 'string') ? r.substring : '';
  }
  try { send({ to: v.actor, type: 'release' }); } catch (e) { /* ignore */ }
  return out;
}
async function main() {
  const app = await request({ to: actors.webappsActor, type: 'getAppActor', manifestURL: APP });
  if (!app.actor || !app.actor.consoleActor) throw new Error('getAppActor 失败');
  const ca = app.actor.consoleActor;
  let r = await request({ to: ca, type: 'evaluateJS', text: code, frameActor: null });
  console.log('INJECT -> ' + JSON.stringify(r.result !== undefined ? r.result : r.value).slice(0, 120));
  let last = '';
  const t0 = Date.now();
  while ((Date.now() - t0) < seconds * 1000) {
    r = await request({ to: ca, type: 'evaluateJS', text: pollExpr, frameActor: null });
    let v = await unlongify(r.value !== undefined ? r.value : r.result);
    if (typeof v === 'object' && v && v.type === 'string') v = v.value;
    const s = String(v);
    if (s !== last) { last = s; console.log(s); }
    await new Promise((res) => setTimeout(res, 2500));
  }
  console.log('SNIPPET POLL DONE');
  process.exit(0);
}
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); feed(); });
sock.on('error', (e) => fatal(e));
sock.on('connect', () => send({ to: 'root', type: 'listTabs' }));
setTimeout(() => fatal(new Error('总超时')), (seconds + 40) * 1000);
