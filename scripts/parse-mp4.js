#!/usr/bin/env node
/* 解析 MP4/3gp：box 结构、tkhd 显示宽高与旋转矩阵、avc1 编码尺寸。
 * 用法：node scripts/parse-mp4.js [视频文件]
 *   带文件参数 → 直接解析该视频（tkhd 矩阵 = (传入 rotation + sensorAngle) % 360 的落地结果）；
 *   不带参数   → 旧模式：解析 logs/mp4session.out 里 pullfile 导出的 h/t base64。 */
'use strict';
const fs = require('fs');

const argvFile = process.argv[2];
let head;
let tail = Buffer.alloc(0);

if (argvFile) {
  head = fs.readFileSync(argvFile);
  console.log('文件 ' + argvFile + ' 大小 ' + head.length + 'B（如需 moov 在尾部的完整解析，用 [偏移 长度] 参数拉尾部）');
  const tailArg = process.argv[3];
  const tailLen = parseInt(process.argv[4] || '1500', 10);
  if (tailArg) {
    const t = fs.readFileSync(tailArg);
    tail = t.slice(Math.max(0, t.length - tailLen));
  }
} else {
  const out = fs.readFileSync('logs/mp4session.out', 'utf8');
  const line = out.split('\n').find((l) => l.includes('"h\\":'));
  if (!line) { console.log('未找到 r3 输出行'); process.exit(1); }
  const braceStart = line.indexOf('{');
  const braceEnd = line.lastIndexOf('}');
  const jsonText = line.slice(braceStart, braceEnd + 1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const inner = JSON.parse(jsonText);
  head = Buffer.from(inner.h, 'base64');
  tail = Buffer.from(inner.t || '', 'base64');
  console.log('head', head.length, 'bytes | tail', tail.length, 'bytes');
}

function walk(buf, start, end, depth) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; }
    if (size === 0) size = end - off;
    if (size < 8) break;
    if (off + size > end) { console.log('  '.repeat(depth) + type + ' size=' + size + ' (截断于窗口末端)'); size = end - off; if (size < hdr) break; }
    console.log('  '.repeat(depth) + type + ' size=' + size);
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta'].includes(type) && depth < 5) {
      walk(buf, off + hdr, off + size, depth + 1);
    } else if (type === 'tkhd') {
      const wOff = off + size - 8;
      const hOff = off + size - 4;
      const w = buf.readUInt32BE(wOff) / 65536;
      const h = buf.readUInt32BE(hOff) / 65536;
      const mOff = wOff - 36;
      const a = buf.readInt32BE(mOff) / 65536;
      const b = buf.readInt32BE(mOff + 4) / 65536;
      const cc = buf.readInt32BE(mOff + 8) / 65536;
      const d = buf.readInt32BE(mOff + 16) / 65536;
      console.log('    tkhd 显示 W=' + w + ' H=' + h + ' 矩阵[a=' + a + ' b=' + b + ' c=' + cc + ' d=' + d + ']');
    } else if (type === 'avc1') {
      console.log('    avc1 编码 W=' + buf.readUInt16BE(off + hdr + 24) + ' H=' + buf.readUInt16BE(off + hdr + 26));
    }
    off += size;
  }
}
walk(head, 0, head.length, 0);
const avc1 = head.indexOf('avc1');
if (avc1 !== -1) {
  const seg = head.slice(avc1 - 4, avc1 + 86);
  let hex = '';
  let asc = '';
  for (const b of seg) {
    hex += b.toString(16).padStart(2, '0') + ' ';
    asc += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
  }
  console.log('avc1 @' + avc1);
  console.log(hex);
  console.log(asc);
} else {
  console.log('avc1 不在头部窗口（被截断）');
}
const all = Buffer.concat([head, tail]);
['rotatetransform'].forEach((tag) => {
  const i = all.indexOf(Buffer.from(tag));
  console.log(tag + ' 存在: ' + (i !== -1 ? '@' + i : '无'));
});
