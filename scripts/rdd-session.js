#!/usr/bin/env node
/* KaiOS 远程调试协议会话客户端：listTabs → 按队列依次发请求并打印响应。
 * 用法：node scripts/rdd-session.js [截图保存路径]
 * 探测序列放在 PROBES 中，服务器对缺参数请求会报 missingParameter，从而摸清参数格式。 */
'use strict';
const net = require('net');
const fs = require('fs');

const PORT = parseInt(process.argv[2] || '6000', 10);
const shotFile = process.argv[3] || null;

const sock = net.connect({ host: '127.0.0.1', port: PORT });
sock.setNoDelay(true);

let buf = Buffer.alloc(0);
const queue = [];
let actors = {};
let step = 0;

const PROBES = [
  { name: 'webapps.upload', req: { actor: 'webappsActor', type: 'upload' } },
  { name: 'webapps.install', req: { actor: 'webappsActor', type: 'install' } },
  { name: 'webapps.listRunningApps', req: { actor: 'webappsActor', type: 'listRunningApps' } },
  { name: 'webapps.getAppActor', req: { actor: 'webappsActor', type: 'getAppActor' } },
  { name: 'device.getDescription', req: { actor: 'deviceActor', type: 'getDescription' } },
  { name: 'device.screenshotToDataURL', req: { actor: 'deviceActor', type: 'screenshotToDataURL' }, save: 'shot' }
];

function send(obj) {
  const json = JSON.stringify(obj);
  console.log('-->', json.length + ':' + json.slice(0, 160));
  sock.write(json.length + ':' + json);
}

function pump() {
  while (queue.length) {
    const q = queue.shift();
    send(q);
  }
}

function nextStep() {
  if (step >= PROBES.length) {
    console.log('--- probes done ---');
    sock.end();
    setTimeout(() => process.exit(0), 300);
    return;
  }
  const p = PROBES[step++];
  console.log('== probe ' + p.name);
  const to = actors[p.req.actor];
  if (!to) { console.log('!! no actor ' + p.req.actor); nextStep(); return; }
  queue.push({ to: to, type: p.req.type });
  pump();
}

function feed() {
  for (;;) {
    const colon = buf.indexOf(':');
    if (colon === -1) return;
    const len = parseInt(buf.slice(0, colon).toString(), 10);
    if (Number.isNaN(len) || len < 0 || len > 64 * 1024 * 1024) return;
    if (buf.length < colon + 1 + len) return;
    const payload = buf.slice(colon + 1, colon + 1 + len).toString();
    buf = buf.slice(colon + 1 + len);
    let o;
    try { o = JSON.parse(payload); } catch (e) { console.log('<-- (raw)', payload.slice(0, 200)); continue; }
    if (o.from === 'root' && o.webappsActor) {
      actors = o;
      console.log('== actors: webapps=' + o.webappsActor + ' device=' + o.deviceActor);
      nextStep();
      continue;
    }
    const text = JSON.stringify(o);
    if (o.error) {
      console.log('<-- ERROR', text.slice(0, 300));
    } else if (o.from && o.from.indexOf('deviceActor') !== -1 && o.value && o.value.indexOf('data:image') === 0) {
      console.log('<-- screenshot data URL, ' + o.value.length + ' chars');
      if (shotFile) {
        const b64 = o.value.slice(o.value.indexOf(',') + 1);
        fs.writeFileSync(shotFile, Buffer.from(b64, 'base64'));
        console.log('saved -> ' + shotFile);
      }
    } else {
      console.log('<--', text.slice(0, 400));
    }
    if (queue.length) { const q = queue.shift(); setTimeout(() => send(q), 200); }
    else setTimeout(nextStep, 250);
  }
}

sock.on('connect', () => {
  const m = JSON.stringify({ to: 'root', type: 'listTabs' });
  console.log('--> listTabs');
  sock.write(m.length + ':' + m);
});
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); feed(); });
sock.on('error', (e) => { console.error('SOCKET ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.log('--- timeout ---'); process.exit(0); }, 30000);
