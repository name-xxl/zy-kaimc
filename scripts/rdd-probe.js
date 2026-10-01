#!/usr/bin/env node
/* KaiOS (B2G/Gecko 48) 远程调试协议客户端——探针模式 v2。
 * Gecko 48 的 debugger-socket 无连接横幅，客户端连接后直接按 <len>:<json> 帧发请求。 */
'use strict';
const net = require('net');

const PORT = parseInt(process.argv[2] || '6000', 10);
const CMD = process.argv[3] || 'listTabs';
const ARGS = process.argv[4] ? JSON.parse(process.argv[4]) : null;

const sock = net.connect({ host: '127.0.0.1', port: PORT });
sock.setNoDelay(true);

let buf = Buffer.alloc(0);
const queue = [];

function feed() {
  for (;;) {
    if (!bannerDone) {
      /* 容忍可能存在的旧式横幅行 */
      const brace = buf.indexOf(0x7b); /* '{' */
      const digit = buf.indexOf(0x30);
      if (brace === -1 && digit === -1) {
        if (buf.length > 128) { console.log('RAW HEAD:', JSON.stringify(buf.slice(0, 128).toString())); process.exit(1); }
        return;
      }
      const start = (digit !== -1 && (brace === -1 || digit < brace)) ? digit : brace;
      if (start > 0) {
        console.log('LEADING BYTES:', JSON.stringify(buf.slice(0, start).toString()));
        buf = buf.slice(start);
      }
      bannerDone = true;
    }
    const colon = buf.indexOf(':');
    if (colon === -1) return;
    const len = parseInt(buf.slice(0, colon).toString(), 10);
    if (Number.isNaN(len) || len < 0 || len > 10 * 1024 * 1024) {
      console.log('BAD FRAME at:', JSON.stringify(buf.slice(0, 80).toString()));
      process.exit(1);
    }
    if (buf.length < colon + 1 + len) return;
    const payload = buf.slice(colon + 1, colon + 1 + len).toString();
    buf = buf.slice(colon + 1 + len);
    let parsed = payload;
    try { parsed = JSON.stringify(JSON.parse(payload)); } catch (e) { /* 保持原文 */ }
    console.log('<--', parsed);
    if (queue.length) {
      const next = queue.shift();
      setTimeout(() => send(next), 300);
    }
  }
}

let bannerDone = false;

function send(obj) {
  const json = JSON.stringify(obj);
  console.log('-->', json.length + ':' + json);
  sock.write(json.length + ':' + json);
}

sock.on('connect', () => {
  console.log('connected tcp:' + PORT);
  const msg = Object.assign({ to: 'root', type: CMD }, ARGS || {});
  send(msg);
});
sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  feed();
});
sock.on('error', (e) => {
  console.error('SOCKET ERROR:', e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log('--- timeout, closing ---');
  sock.end();
  setTimeout(() => process.exit(0), 300);
}, 6000);
