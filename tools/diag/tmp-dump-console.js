#!/usr/bin/env node
/* 拉取运行中应用的 console 缓存消息（应用里 dlog 都写了 console.log('[app] …')）。
 * 用法：node scripts/tmp-dump-console.js [条数] */
'use strict';
const net = require('net');

const PORT = parseInt(process.env.RDD_PORT || '6000', 10);
const APP = process.env.APP_MANIFEST || 'app://33daac74-00f5-4d53-bf47-3fc53103a55f/manifest.webapp';
const LIMIT = parseInt(process.argv[2] || '120', 10);

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

function gripText(g) {
  if (g === null || g === undefined) return String(g);
  if (typeof g !== 'object') return String(g);
  if (g.type === 'string') return g.value;
  if (g.type === 'longString') return '(long)' + (g.initial || '');
  if (g.type === 'number' || g.type === 'boolean') return String(g.value);
  return JSON.stringify(g).slice(0, 120);
}

async function main() {
  const app = await request({ to: actors.webappsActor, type: 'getAppActor', manifestURL: APP });
  if (!app.actor || !app.actor.consoleActor) throw new Error('getAppActor 失败');
  const r = await request({ to: app.actor.consoleActor, type: 'getCachedMessages', messageTypes: ['ConsoleAPI', 'PageError'] });
  if (r.error) { console.log('getCachedMessages 不支持: ' + r.error + ' ' + (r.message || '')); process.exit(1); }
  const msgs = (r.messages || []).slice(-LIMIT);
  console.log('MESSAGES ' + msgs.length);
  for (const m of msgs) {
    let line = '';
    if (m.arguments) {
      for (const a of m.arguments) {
        const v = await unlongify(a);
        line += gripText(typeof v === 'object' && v && v.type === 'longString' ? { type: 'longString', initial: v } : v);
        line += ' ';
      }
    } else {
      line = m.message || (m.errorMessage || '');
    }
    const t = m.timeStamp ? new Date(m.timeStamp).toISOString().slice(11, 19) : '??:??:??';
    console.log(t + ' ' + (m.level || '') + ' ' + line.trim());
  }
  process.exit(0);
}

sock.on('data', (d) => { buf = Buffer.concat([buf, d]); feed(); });
sock.on('error', (e) => fatal(e));
sock.on('connect', () => send({ to: 'root', type: 'listTabs' }));
setTimeout(() => fatal(new Error('总超时')), 60000);
