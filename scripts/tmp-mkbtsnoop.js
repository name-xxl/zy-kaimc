#!/usr/bin/env node
/* 临时工具：造一个 btsnoop_hci.log 测试样本，验证 parse-btsnoop.js。
 * 用法：node scripts/tmp-mkbtsnoop.js logs/test-btsnoop.log */
'use strict';
const fs = require('fs');
const path = require('path');
const Z = require(path.join(__dirname, '..', 'app', 'js', 'zhiyun.js'));

const out = process.argv[2] || 'logs/test-btsnoop.log';
const chunks = [];
const hdr = Buffer.alloc(16);
hdr.write('btsnoop\0', 0, 'latin1');
hdr.writeUInt32BE(1, 8);       /* version */
hdr.writeUInt32BE(1002, 12);   /* HCI UART (H4) */
chunks.push(hdr);

let t = Math.floor(Date.now() / 1000);

function pkt(dirRecv, att) {
  const l2cap = Buffer.alloc(4 + att.length);
  l2cap.writeUInt16LE(att.length, 0);
  l2cap.writeUInt16LE(0x0004, 2);        /* ATT */
  att.copy(l2cap, 4);
  const acl = Buffer.alloc(4 + l2cap.length);
  acl.writeUInt16LE(0x0000, 0);          /* handle 0 (随便) */
  acl.writeUInt16LE(l2cap.length, 2);
  l2cap.copy(acl, 4);
  const data = Buffer.concat([Buffer.from([0x02]), acl]);
  const p = Buffer.alloc(24);
  p.writeUInt32BE(data.length, 0);
  p.writeUInt32BE(data.length, 4);
  p.writeUInt32BE(dirRecv ? 1 : 0, 8);
  p.writeUInt32BE(0, 12);
  const usec = 123456;
  p.writeUInt32BE(t, 16);
  p.writeUInt32BE(usec, 20);
  t += 1;
  chunks.push(p, data);
}

function attNotify(handle, value) {
  const b = Buffer.alloc(3 + value.length);
  b[0] = 0x1b;
  b.writeUInt16LE(handle, 1);
  Buffer.from(value).copy(b, 3);
  return b;
}
function attWriteCmd(handle, value) {
  const b = Buffer.alloc(3 + value.length);
  b[0] = 0x52;
  b.writeUInt16LE(handle, 1);
  Buffer.from(value).copy(b, 3);
  return b;
}

/* 1) 云台心跳（Weebill-S 实测样例） */
pkt(true, attNotify(0x0016, [0x24, 0x3E, 0x00, 0x0C, 0x18, 0x15, 0x08, 0x00, 0x01, 0x80, 0x50, 0x10, 0xC2, 0x01, 0x00, 0x00, 0x98, 0x4B]));
/* 2) App 发心跳（0x80） */
pkt(false, attWriteCmd(0x0014, Z.buildFrame(Z.DIR_APP2G, Z.FMT_HB, 1, Z.TYPE_CMD, 0x80, [0, 0, 0, 0, 0, 0])));
/* 3) 云台按键帧（0x20 / c0 3c 00） */
pkt(true, attNotify(0x0016, Z.buildFrame(Z.DIR_G2APP, Z.FMT_CMD, 0x20, Z.TYPE_RSP, 0x20, [0xC0, 0x3C, 0x00])));

fs.writeFileSync(out, Buffer.concat(chunks));
console.log('WROTE ' + out + ' (' + Buffer.concat(chunks).length + ' B)');
