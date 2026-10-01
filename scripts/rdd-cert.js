#!/usr/bin/env node
/* 在 certified 应用上下文里执行 JS：launch → getAppActor → evaluateJS。
 * 用法：node scripts/rdd-cert.js <cert应用的manifestURL> <js表达式文件或"js...">
 * 表达式最后一条语句的值作为结果返回（保持字符串形式输出）。 */
'use strict';
const net = require('net');
const fs = require('fs');

const PORT = parseInt(process.env.RDD_PORT || '6000', 10);
const cert = process.argv[2];
const exprArg = process.argv[3];
let text;
if (!exprArg) { console.error('用法: node rdd-cert.js <manifestURL> <表达式|@文件>'); process.exit(1); }
text = exprArg.startsWith('@') ? fs.readFileSync(exprArg.slice(1), 'utf8') : exprArg;

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

async function evalIn(certUrl, code) {
  let r = await request({ to: actors.webappsActor, type: 'getAppActor', manifestURL: certUrl });
  if (!r.actor) throw new Error('getAppActor 失败: ' + JSON.stringify(r).slice(0, 200));
  const consoleActor = r.actor.consoleActor;
  r = await request({ to: consoleActor, type: 'evaluateJS', text: code, frameActor: null });
  if (r.error) return 'PROTOCOL-ERROR ' + r.error + ': ' + (r.message || '');
  if (r.exception) {
    let ex = r.exception;
    if (ex && ex.type === 'object') {
      return 'EXCEPTION ' + (ex.class || 'Object') + ' ' + (ex.preview && ex.preview.ownProperties ?
        Object.keys(ex.preview.ownProperties).map(k => k + '=' + JSON.stringify(ex.preview.ownProperties[k].value)).join(' ') : '');
    }
    return 'EXCEPTION ' + JSON.stringify(ex).slice(0, 200);
  }
  let v = (r.result !== undefined) ? r.result : r.value;
  if (v && v.type === 'longString') {
    let out = v.initial || '';
    while (out.length < v.length) {
      const rr = await request({ to: v.actor, type: 'substring', start: out.length, end: Math.min(out.length + 1000000, v.length) });
      if (rr.error) throw new Error('substring failed');
      out += (typeof rr.substring === 'string') ? rr.substring : '';
    }
    v = out;
  }
  if (v && typeof v === 'object') {
    if (v.type === 'string' || v.type === 'number' || v.type === 'boolean' || v.type === 'null' || v.type === 'undefined') return JSON.stringify(v.value);
    return '<' + (v.class || v.type) + '> ' + JSON.stringify(v).slice(0, 250);
  }
  return JSON.stringify(v);
}

async function main() {
  await request({ to: actors.webappsActor, type: 'launch', manifestURL: cert });
  await new Promise((res) => setTimeout(res, 2000));
  console.log(await evalIn(cert, text));
  process.exit(0);
}

sock.on('data', (d) => { buf = Buffer.concat([buf, d]); feed(); });
sock.on('error', (e) => fatal(e));
sock.on('connect', () => send({ to: 'root', type: 'listTabs' }));
setTimeout(() => fatal(new Error('超时')), 60000);
