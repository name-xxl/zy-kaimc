#!/usr/bin/env node
/* 在运行中的 KaiOS 应用上下文里执行 JS（经 webappsActor.getAppActor → consoleActor.evaluateJS）。
 * 用法：node scripts/rdd-console.js "js 表达式" [manifestURL]
 * 不带表达式则进入交互 REPL（逐行求值，exit 退出）。 */
'use strict';
const net = require('net');
const readline = require('readline');

const PORT = parseInt(process.env.RDD_PORT || '6000', 10);
const expr = process.argv[3] || process.argv[2];
const manifestArg = (expr && process.argv[3]) ? process.argv[3] : null;

const sock = net.connect({ host: '127.0.0.1', port: PORT });
sock.setNoDelay(true);

let buf = Buffer.alloc(0);
let actors = null;
const waiters = [];

function send(o) {
  const j = JSON.stringify(o);
  if (process.env.RDD_DEBUG) console.error('SEND ' + j.slice(0, 120));
  sock.write(j.length + ':' + j);
}

function request(o) {
  return new Promise((resolve) => { waiters.push(resolve); send(o); });
}

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

function fatal(e) {
  console.error('FAIL: ' + (e && e.message || e));
  process.exit(1);
}

async function unlongify(v) {
  if (!v || typeof v !== 'object') return v;
  if (v.type !== 'longString') return v;
  let out = v.initial || '';
  while (out.length < v.length) {
    const r = await request({ to: v.actor, type: 'substring', start: out.length, end: Math.min(out.length + 1000000, v.length) });
    if (r.error) throw new Error('substring failed');
    out += (typeof r.substring === 'string') ? r.substring : await unlongify(r.value);
  }
  try { send({ to: v.actor, type: 'release' }); } catch (e) { /* 忽略 */ }
  return out;
}

/* grip 概述化：对象只打印类名/键，避免海量输出 */
function describe(grip, depth) {
  if (grip === null || grip === undefined) return String(grip);
  if (Array.isArray(grip)) return '[' + grip.map(g => describe(g, 1)).join(',') + ']';
  if (typeof grip !== 'object') return String(grip);
  if (grip.type === 'longString') return grip.initial || '(longString)';
  if (grip.type === 'object' || grip.class) {
    const keys = (grip.ownProperties ? Object.keys(grip.ownProperties) : (grip.preview && grip.preview.ownProperties ? Object.keys(grip.preview.ownProperties) : []));
    return '<' + (grip.class || grip.type) + (keys.length ? ' keys:' + keys.slice(0, 12).join(',') : '') + '>';
  }
  if (grip.type === 'number' || grip.type === 'string' || grip.type === 'boolean') return String(grip.value);
  return JSON.stringify(grip).slice(0, 200);
}

async function evaluate(text) {
  const app = await request({ to: actors.webappsActor, type: 'getAppActor', manifestURL: manifestArg || currentManifest });
  if (!app.actor || !app.actor.consoleActor) throw new Error(' getAppActor 失败: ' + JSON.stringify(app).slice(0, 200));
  const r = await request({ to: app.actor.consoleActor, type: 'evaluateJS', text: text, frameActor: null });
  if (r.error) return 'PROTOCOL ERROR: ' + r.error + ' ' + (r.message || '');
  if (r.exception) {
    const ex = await unlongify(r.exception);
    return 'EXCEPTION: ' + (typeof ex === 'object' ? describe(ex, 0) : ex);
  }
  const v = await unlongify(r.value !== undefined ? r.value : r.result);
  return formatResult(r, v);
}

function formatResult(r, v) {
  const grip = r.value !== undefined ? r.value : r.result;
  if (typeof v === 'string' && (!grip || grip.type === 'string' || (typeof grip === 'string'))) return v;
  return describe(grip, 0) + (typeof v === 'object' && v !== null && grip && grip.type === 'object' ? ' :: ' + JSON.stringify(v).slice(0, 120) : '');
}

let currentManifest = null;

async function main() {
  /* 默认找 ZY-KaiCam（或第一个运行中的 App） */
  const r = await request({ to: actors.webappsActor, type: 'listRunningApps' });
  const apps = r.apps || [];
  if (!apps.length) throw new Error('没有正在运行的应用');
  currentManifest = manifestArg || apps.find(a => true);
  if (expr) {
    const out = await evaluate(expr);
    console.log(out);
    process.exit(0);
  }
  console.log('REPL 连接: ' + currentManifest + '（exit 退出）');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('kaios> ');
  rl.prompt();
  rl.on('line', async (line) => {
    const t = line.trim();
    if (!t) { rl.prompt(); return; }
    if (t === 'exit' || t === 'quit') { process.exit(0); }
    try {
      console.log(await evaluate(t));
    } catch (e) { console.log('ERR ' + (e.message || e)); }
    rl.prompt();
  });
}

sock.on('data', (d) => { buf = Buffer.concat([buf, d]); feed(); });
sock.on('error', (e) => fatal(e));
sock.on('connect', () => send({ to: 'root', type: 'listTabs' }));
setTimeout(() => fatal(new Error('超时')), 60000);
