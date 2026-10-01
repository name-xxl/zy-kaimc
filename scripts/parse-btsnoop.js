#!/usr/bin/env node
/* 解析安卓"蓝牙 HCI 监听日志"（btsnoop_hci.log）：
 *  - 提取 ATT 层：Handle Value Notification/Indication（云台→App）、Write Command/Request（App→云台）
 *  - 对智云特征（fee9 的 129600/129601）上的字节用本仓库协议层解码出帧（cmd/按键/CRC）
 *
 * 用法：node scripts/parse-btsnoop.js <btsnoop_hci.log> [--all]
 *   --all  连非智云句柄的 ATT 读写也打印（默认只显示含 24 3E/24 3C 开头帧的）
 *
 * 生成方式（安卓手机）：开发者选项 → 启用蓝牙 HCI 监听日志 → 复现操作 →
 *   日志在 /sdcard/btsnoop_hci.log（或 bugreport 里），adb pull 出来。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Z = require(path.join(__dirname, '..', 'app', 'js', 'zhiyun.js'));

const file = process.argv[2];
const showAll = process.argv.indexOf('--all') !== -1;
const peerIdx = process.argv.indexOf('--peer');
const peerFilter = peerIdx !== -1 ? String(process.argv[peerIdx + 1] || '').toLowerCase() : null;
if (!file) {
  console.error('用法: node scripts/parse-btsnoop.js <btsnoop_hci.log> [--all] [--peer <地址片段>]');
  process.exit(1);
}
const buf = fs.readFileSync(file);
if (buf.length < 16 || buf.slice(0, 8).toString('latin1') !== 'btsnoop\0') {
  console.error('不是 btsnoop 文件（magic 不符）');
  process.exit(1);
}
const datalink = buf.readUInt32BE(12); /* 1002=HCI UART(每包带 1 字节 type) 1001=unencapsulated */

function tsStr(sec, usec) {
  if (sec > 1000000000 && sec < 4000000000) {
    const d = new Date(sec * 1000 + Math.floor(usec / 1000));
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(usec).padStart(6, '0').slice(0, 3);
  }
  return '(' + sec + 's+' + usec + 'us)';
}

const hex = (u8) => Array.prototype.map.call(u8, (b) => ('0' + b.toString(16)).slice(-2).toUpperCase()).join(' ');

function attOpName(op) {
  return {
    0x1b: 'NOTIFY', 0x1d: 'INDICATE', 0x52: 'WRITE_CMD', 0x12: 'WRITE_REQ',
    0x08: 'READ_RSP', 0x0a: 'READ_REQ', 0x0b: 'READ_BLOB_REQ', 0x0c: 'READ_BLOB_RSP',
    0x16: 'PREP_WRITE_REQ', 0x18: 'EXEC_WRITE_REQ', 0x01: 'ERROR_RSP',
    0x03: 'EXCH_MTU_REQ', 0x02: 'EXCH_MTU_RSP'
  }[op] || ('0x' + op.toString(16));
}

/* SMP（配对/绑定）——判断官方 App 是否与云台绑定/加密 */
function smpOpName(op) {
  return {
    0x01: 'PairingRequest', 0x02: 'PairingResponse', 0x03: 'PairingConfirm',
    0x04: 'PairingRandom', 0x05: 'PairingFailed', 0x06: 'EncryptionInformation',
    0x07: 'MasterIdentification', 0x08: 'IdentityInformation', 0x09: 'IdentityAddressInformation',
    0x0a: 'SigningInformation', 0x0b: 'SecurityRequest', 0x0c: 'PairingPublicKey',
    0x0d: 'PairingDHKeyCheck', 0x0e: 'PairingKeypress'
  }[op] || ('smp0x' + op.toString(16));
}

/* HCI 命令里与加密/绑定相关的（type=0x01） */
function hciCmdName(op) {
  return {
    0x2019: 'LE_Start_Encryption', 0x201a: 'LE_LTK_Request_Reply', 0x200b: 'LE_Enable_Encryption',
    0x0405: 'Create_Connection', 0x2016: 'LE_Read_Remote_Features'
  }[op] || null;
}

const parsers = {};   /* 每句柄一个协议 Parser（分帧用） */
const stats = {};
const handlePeer = {}; /* ACL 句柄 → 对端地址（来自 LE Connection Complete 事件） */
let off = 16, packets = 0, attShown = 0;

while (off + 24 <= buf.length) {
  const incLen = buf.readUInt32BE(off + 4);
  const flags = buf.readUInt32BE(off + 8);
  const sec = buf.readUInt32BE(off + 16);
  const usec = buf.readUInt32BE(off + 20);
  off += 24;
  const data = buf.slice(off, off + incLen);
  off += incLen;
  packets++;

  let payload;
  if (datalink === 1002) {
    if (data.length < 1) continue;
    if (data[0] === 0x01) {              /* HCI 命令：只挑加密/连接相关打印 */
      const op = data.length >= 3 ? (data[1] | (data[2] << 8)) : 0;
      const name = hciCmdName(op);
      if (name) console.log(tsStr(sec, usec) + ' -> HCI_CMD ' + name + ' ' + hex(data.slice(3, 20)));
      continue;
    }
    if (data[0] === 0x02) {              /* ACL */
      payload = data.slice(1);
    } else if (data[0] === 0x04) {       /* HCI 事件：[04][evt][plen][params…]；LE Meta 子事件在 data[3] */
      const evt = data[1];
      if (evt === 0x3E && data.length >= 6) {
        const sub = data[3];
        const p = data.slice(4);
        if (sub === 0x01 && p.length >= 18) {   /* LE Connection Complete */
          const h = p.readUInt16LE(1) & 0x0FFF;
          const addr = Array.prototype.map.call(p.slice(5, 11).reverse(),
            (b) => ('0' + b.toString(16)).slice(-2)).join(':');
          handlePeer[h] = addr;
          console.log(tsStr(sec, usec) + ' EVENT LE_ConnComplete h=0x' + h.toString(16).padStart(4, '0') +
            ' peer=' + addr + ' role=' + p[3] +
            ' interval=' + (p.readUInt16LE(11) * 1.25) + 'ms latency=' + p.readUInt16LE(13) +
            ' timeout=' + (p.readUInt16LE(15) * 10) + 'ms');
        } else if (sub === 0x0A && p.length >= 29) { /* LE Enhanced Connection Complete */
          const h = p.readUInt16LE(1) & 0x0FFF;
          const mac = (s) => Array.prototype.map.call(p.slice(s, s + 6).reverse(),
            (b) => ('0' + b.toString(16)).slice(-2)).join(':');
          handlePeer[h] = mac(5);
          console.log(tsStr(sec, usec) + ' EVENT LE_EnhancedConnComplete h=0x' + h.toString(16).padStart(4, '0') +
            ' peer=' + mac(5) + ' role=' + p[3] +
            ' interval=' + (p.readUInt16LE(23) * 1.25) + 'ms latency=' + p.readUInt16LE(25) +
            ' timeout=' + (p.readUInt16LE(27) * 10) + 'ms');
        } else if (sub === 0x03 && p.length >= 9) { /* LE Connection Update Complete */
          const h = p.readUInt16LE(1) & 0x0FFF;
          console.log(tsStr(sec, usec) + ' EVENT LE_ConnUpdate h=0x' + h.toString(16).padStart(4, '0') +
            ' peer=' + (handlePeer[h] || '?') +
            ' interval=' + (p.readUInt16LE(3) * 1.25) + 'ms latency=' + p.readUInt16LE(5) +
            ' timeout=' + (p.readUInt16LE(7) * 10) + 'ms');
        }
      }
      continue;
    } else {
      continue;
    }
  } else if (datalink === 1001) {
    payload = data;                       /* 无 type 字节，假定 ACL */
  } else {
    console.error('未知 datalink 类型 ' + datalink);
    process.exit(1);
  }
  if (payload.length < 8) continue;
  const aclHandle = payload.readUInt16LE(0) & 0x0FFF;
  const l2len = payload.readUInt16LE(4);
  const cid = payload.readUInt16LE(6);
  const l2 = payload.slice(8, 8 + l2len);
  const peer = handlePeer[aclHandle] || '?';
  if (peerFilter && peer.indexOf(peerFilter) === -1) continue;

  if (cid === 0x0006) {                   /* SMP：配对/绑定 */
    const st = stats.SMP = (stats.SMP || 0) + 1;
    const dirS = (flags & 1) ? '<-' : '->';
    console.log(tsStr(sec, usec) + ' ' + dirS + ' SMP ' + (l2.length ? smpOpName(l2[0]) : '?') +
      ' ' + hex(l2.slice(0, 12)));
    continue;
  }
  if (cid !== 0x0004) {                   /* 非 ATT 通道计入统计 */
    const key = 'cid0x' + cid.toString(16);
    stats[key] = (stats[key] || 0) + 1;
    continue;
  }
  if (l2.length < 3) continue;

  const op = l2[0];
  let handle = -1, value = null;
  if (op === 0x1b || op === 0x1d) {       /* 通知/指示：句柄 + 值 */
    handle = l2.readUInt16LE(1); value = l2.slice(3);
  } else if (op === 0x52 || op === 0x12) {/* 写命令/写请求 */
    handle = l2.readUInt16LE(1); value = l2.slice(3);
  } else if (op === 0x08) {               /* 读响应 */
    handle = l2.readUInt16LE(1); value = l2.slice(3);
  } else {
    continue;
  }

  const dir = (flags & 1) ? '<-' : '->';  /* bit0=1: 收到(外设→手机) */
  const st = stats[attOpName(op)] = (stats[attOpName(op)] || 0) + 1;

  /* 判断是否智云帧：值以 0x24 开头且第 2 字节为 3C/3E */
  const isZhiyun = value.length >= 2 && value[0] === 0x24 && (value[1] === 0x3C || value[1] === 0x3E);
  if (!showAll && !isZhiyun && op !== 0x1b && op !== 0x1d) continue;

  attShown++;
  let line = tsStr(sec, usec) + ' ' + dir + ' ' + attOpName(op) + ' h=0x' + handle.toString(16).padStart(4, '0') +
    ' (' + value.length + 'B) ' + hex(value);
  console.log(line);

  if (isZhiyun) {
    const p = parsers[handle] || (parsers[handle] = new Z.Parser());
    p.push(new Uint8Array(value)).forEach((f) => {
      const tag = f.dir === Z.DIR_G2APP ? 'G2APP' : 'APP2G';
      console.log('      FRAME ' + tag + ' fmt=0x' + f.format.toString(16) + ' seq=' + f.seq +
        ' type=0x' + f.type.toString(16) + ' cmd=0x' + f.cmd.toString(16) +
        ' payload[' + f.payload.length + ']=' + hex(f.payload) + (f.crcOk ? '' : '  CRC✗'));
    });
  }
}

console.log('---');
console.log('包总数 ' + packets + '，命中 ATT ' + attShown + ' 条；按类型：' +
  Object.keys(stats).map((k) => k + '=' + stats[k]).join(' '));
