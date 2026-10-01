#!/usr/bin/env node
/* 面板监视器：单连接内每 2.5s 读一次应用屏上面板，文本变化就整段打印（带本地时间）。
 * 用法：node scripts/tmp-watch-panel.js [秒数]
 * 默认目标 app://33daac74-00f5-4d53-bf47-3fc53103a55f/manifest.webapp（可用 APP_MANIFEST 覆盖）。 */
'use strict';
const net = require('net');
const fs = require('fs');

const PORT = parseInt(process.env.RDD_PORT || '6000', 10);
const APP = process.env.APP_MANIFEST || 'app://33daac74-00f5-4d53-bf47-3fc53103a55f/manifest.webapp';
const SECONDS = parseInt(process.argv[2] || '300', 10);
const OUT = process.env.WATCH_OUT || ('logs/panel-watch-' + Date.now() + '.txt');

const EXPR = "(function(){function g(id){var e=document.getElementById(id);return e?e.textContent:'';}return encodeURIComponent('DEBUG['+g('debug')+'] LOG['+g('log')+']');})()";

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

let last = null;

async function main() {
  const app = await request({ to: actors.webappsActor, type: 'getAppActor', manifestURL: APP });
  if (!app.actor || !app.actor.consoleActor) throw new Error('getAppActor 失败');
  const t0 = Date.now();
  while ((Date.now() - t0) < SECONDS * 1000) {
    const r = await request({ to: app.actor.consoleActor, type: 'evaluateJS', text: EXPR, frameActor: null });
    let v = await unlongify(r.value !== undefined ? r.value : r.result);
    if (typeof v === 'object' && v && v.type === 'string') v = v.value;
    let text = '';
    try { text = decodeURIComponent(String(v)); } catch (e) { text = String(v); }
    if (text !== last) {
      last = text;
      const stamp = new Date().toISOString().slice(11, 19);
      const block = '===== ' + stamp + ' =====\n' + text + '\n';
      fs.appendFileSync(OUT, block);
      console.log(block);
    }
    await new Promise((res) => setTimeout(res, 2500));
  }
  console.log('WATCH DONE -> ' + OUT);
  process.exit(0);
}

sock.on('data', (d) => { buf = Buffer.concat([buf, d]); feed(); });
sock.on('error', (e) => fatal(e));
sock.on('connect', () => send({ to: 'root', type: 'listTabs' }));
setTimeout(() => fatal(new Error('总超时')), (SECONDS + 30) * 1000);
