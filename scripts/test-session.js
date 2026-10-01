#!/usr/bin/env node
/* 会话层仿真回归（不碰真机）：用假 KaiBt 驱动 app/js/session.js，验证
 *   1) 官方初始化序列按序发出（0x04 → 0x7C-0x7F → 0x1818 固定帧 → 0x06）
 *   2) 无应答时按 config.INIT_TRIES 重试后继续
 *   3) 应答经"轮询 .value"被收到（rxCount 增长 → '初始化完成（收到 N 个回包）'）
 * 用法：node scripts/test-session.js */
'use strict';
const path = require('path');
const root = globalThis;

['config.js', 'util.js', 'zhiyun.js', 'ble.js', 'session.js'].forEach(function (f) {
  require(path.join(__dirname, '..', 'app', 'js', f));
});

const C = root.AppCfg;
const Z = root.Zhiyun;
const bt = root.KaiBt;
const Session = root.KaiSession;

let fail = 0;
function check(ok, msg) {
  console.log((ok ? '✓ ' : '✗ ') + msg);
  if (!ok) fail = 1;
}

/* 假连接与假适配器 */
let valueBox = new Uint8Array(0);
let writes = [];
let logs = [];
let replyMode = 'echo';   /* echo=每条写都回；quiet=不回 */

const notifyChar = {
  get value() { return valueBox; },
  descriptors: [],
  startNotifications: function () { return Promise.resolve(); }
};
const con = {
  gatt: { connected: true, oncharacteristicchanged: null, addEventListener: function () {}, disconnect: function () {} },
  services: [], fee9: {}, writeChar: {}, notifyChar: notifyChar
};
bt.connect = function () { return Promise.resolve(con); };
bt.armNotifications = function () { return Promise.resolve({ cccd: '01', descs: 0, wrote: '0x1 ok', props: null, note: '' }); };
bt.write = function (c, buf) {
  const u8 = new Uint8Array(buf);
  writes.push(u8);
  if (replyMode === 'echo') {
    /* 造云台应答：同 inc 同 cmd，dir 改 3E、flag 改 0x10，参数换 00 11 22 —— 延后 30ms 给出 */
    const f = Z.Parser.prototype ? null : null;
    const parsed = new Z.Parser().push(u8);
    if (parsed.length) {
      const p = parsed[0];
      const reply = Z.buildFrame(Z.DIR_G2APP, p.format, p.seq & 0xFF, 0x10, p.cmd, [0x00, 0x11, 0x22]);
      setTimeout(function () { valueBox = reply; }, 30);
    }
  }
  return Promise.resolve();
};
bt.disconnect = function () {};

function cmdSeq() {
  const out = [];
  writes.forEach(function (u8) {
    const f = new Z.Parser().push(u8);
    if (!f.length) { out.push('?raw'); return; }
    if (f[0].format === 0x1818) { out.push('1818'); return; }
    out.push(f[0].cmd);
  });
  return out;
}

function run(quiet) {
  valueBox = new Uint8Array(0);
  writes = [];
  logs = [];
  replyMode = quiet ? 'quiet' : 'echo';
  const s = new Session({ onLog: function (m) { logs.push(m); }, onFrame: function () {}, onButton: function () {}, onState: function () {} });
  return s.open({ address: 'aa:bb:cc:dd:ee:ff', name: 'CRANE-M2-TEST' }).then(function () {
    return s;
  });
}

(async function () {
  /* 场景 1：有应答 → 序列一次走完，收到 6 个回包（含 0x1818 回显） */
  const s1 = await run(false);
  const seq = cmdSeq();
  check(seq.slice(0, 5).join(',') === '4,124,125,126,127', '初始化前五步 0x04→0x7C→0x7D→0x7E→0x7F（实际 ' + seq.slice(0, 5).map(function (c) { return '0x' + c.toString(16); }) + '）');
  check(seq.slice(5, 7).join(',') === '1818,6', '第五步后为 0x1818 固定帧 → 0x06');
  check(logs.some(function (m) { return /初始化完成（收到 [1-9]/.test(m); }), '有应答场景：收到回包（' + (logs.filter(function (m) { return /初始化完成/.test(m); })[0] || '无') + '）');
  s1.close();

  /* 场景 2：无应答 → 每步重试 INIT_TRIES 次后推进，最终仍跑完 */
  const s2 = await run(true);
  const seq2 = cmdSeq();
  const tries04 = seq2.filter(function (c) { return c === 4; }).length;
  check(tries04 === (C.INIT_TRIES || 3), '无应答场景：0x04 重试 ' + tries04 + ' 次（config.INIT_TRIES=' + C.INIT_TRIES + '）');
  check(seq2[seq2.length - 1] === 6, '无应答场景：序列仍走完（最后一步 0x06）');
  check(logs.some(function (m) { return /初始化完成（收到 0 个回包）/.test(m); }), '无应答场景：报告收到 0 个回包');
  s2.close();

  console.log(fail ? '✗ 会话层仿真回归失败' : '✓ 会话层仿真回归通过');
  process.exit(fail);
})();
