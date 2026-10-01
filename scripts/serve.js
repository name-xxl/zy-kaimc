#!/usr/bin/env node
/* 极简静态服务器（本地调试用，仓库根为根目录）。
 * 用法：node scripts/serve.js [端口]   → 打开 http://localhost:8080/tools/ble-hound/
 * 用途：Web Bluetooth 需要安全上下文（localhost 满足），用 file:// 打不开蓝牙。 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '8080', 10);
const ROOT = path.resolve(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.zip': 'application/zip'
};

http.createServer(function (req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/tools/ble-hound/';
  let file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 ' + p);
  }
}).listen(PORT, function () {
  console.log('serving ' + ROOT + ' at http://localhost:' + PORT + '/tools/ble-hound/');
});
