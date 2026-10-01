#!/usr/bin/env node
/* 持久调试会话：close→launch→按序列对运行中的 App 求值（单连接内多次 evaluateJS 稳定）。
 * 用法：node scripts/live.js <snippet文件1> <间隔秒> <snippet文件2> ...
 * 每个片段执行后打印结果；专用变量窗口 __x 供片段间传递。 */
'use strict';
const net = require('net');
const fs = require('fs');

const PORT = parseInt(process.env.RDD_PORT || '6000', 10);
const APP = process.env.APP_MANIFEST || 'app://33daac74-00f5-4d53-bf47-3fc53103a55f/manifest.webapp';
const args = process.argv.slice(2);

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
  if (r.error) return 'ERR ' + r.error;
  if (r.exception) return 'EXC ' + JSON.stringify(r.exception).slice(0, 150);
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
  if (v && typeof v === 'object' && v.type !== undefined) {
    if (['string', 'number', 'boolean'].includes(v.type)) return JSON.stringify(v.value);
    return JSON.stringify(v).slice(0, 300);
  }
  return JSON.stringify(v);
}

async function main() {
  console.log('== close+launch');
  await request({ to: actors.webappsActor, type: 'close', manifestURL: APP });
  await new Promise((res) => setTimeout(res, 1500));
  await request({ to: actors.webappsActor, type: 'launch', manifestURL: APP });
  await new Promise((res) => setTimeout(res, 6000));
  console.log('SANITY: ' + await evalNow('1+1'));
  for (let i = 0; i < args.length; i += 2) {
    const file = args[i];
    const waitSec = parseFloat(args[i + 1] || '3');
    const code = fs.readFileSync(file, 'utf8');
    console.log('== RUN ' + file);
    console.log('  -> ' + await evalNow(code));
    if (waitSec > 0) {
      await new Promise((res) => setTimeout(res, waitSec * 1000));
      console.log('  ... ' + await evalNow('window.__x !== undefined ? JSON.stringify(window.__x).slice(0,400) : "(no __x)"'));
    }
  }
  process.exit(0);
}

sock.on('data', (d) => { buf = Buffer.concat([buf, d]); feed(); });
sock.on('error', (e) => fatal(e));
sock.on('connect', () => send({ to: 'root', type: 'listTabs' }));
setTimeout(() => fatal(new Error('总超时')), 120000);
