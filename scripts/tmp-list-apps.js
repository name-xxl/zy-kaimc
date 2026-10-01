#!/usr/bin/env node
/* 一次性工具：列出已安装应用（过滤出带 bluetooth 权限/名字含 ZY|probe 的）。
 * 用法：先 adb forward tcp:6000 ...，再 node scripts/tmp-list-apps.js */
'use strict';
const net = require('net');

const PORT = parseInt(process.env.RDD_PORT || '6000', 10);
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

async function main() {
  const r = await request({ to: actors.webappsActor, type: 'getAll' });
  const apps = r.apps || [];
  console.log('TOTAL ' + apps.length);
  apps.forEach(function (a) {
    const perms = Object.keys((a.manifest && a.manifest.permissions) || {}).join(',');
    if (!/bluetooth/.test(perms) && !/ZY|probe|KaiCam|探针/i.test(a.name || '')) return;
    console.log('- ' + (a.name || '?') + ' | status=' + a.appStatus + ' | ' +
      a.manifestURL + ' | type=' + ((a.manifest && a.manifest.type) || '?') + ' | perms=' + perms);
  });
  process.exit(0);
}

sock.on('data', (d) => { buf = Buffer.concat([buf, d]); feed(); });
sock.on('error', (e) => fatal(e));
sock.on('connect', () => send({ to: 'root', type: 'listTabs' }));
setTimeout(() => fatal(new Error('总超时')), 60000);
