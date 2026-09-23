#!/usr/bin/env node
/* 生成 KaiOS 图标（56/112，纯 Node 无依赖）：深蓝底 + 白色镜头环 + 中心点 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function png(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  /* bit depth */
  ihdr[9] = 6;  /* RGBA */
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; /* filter: none */
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function draw(size, bg, ring, dot) {
  const buf = Buffer.alloc(size * size * 4);
  const R = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R;
      const dy = (y + 0.5 - R) / R;
      const d = Math.sqrt(dx * dx + dy * dy);
      let c = bg;
      if (d >= 0.50 && d <= 0.74) c = ring; /* 镜头环 */
      else if (d <= 0.30) c = dot;          /* 中心点 */
      const i = (y * size + x) * 4;
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
      buf[i + 3] = 255;
    }
  }
  return png(size, size, buf);
}

const rootDir = path.resolve(__dirname, '..');
function out(file, size, ring) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, draw(size, [16, 42, 66], ring, [255, 255, 255]));
  console.log('icon:', path.relative(rootDir, file));
}

out(path.join(rootDir, 'app/icons/icon56.png'), 56, [255, 255, 255]);
out(path.join(rootDir, 'app/icons/icon112.png'), 112, [255, 255, 255]);
out(path.join(rootDir, 'tools/probe/icons/icon56.png'), 56, [120, 220, 120]);
out(path.join(rootDir, 'tools/probe/icons/icon112.png'), 112, [120, 220, 120]);
