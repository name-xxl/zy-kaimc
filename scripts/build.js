#!/usr/bin/env node
/* 构建：语法检查 → manifest 校验 → 协议自测 → 同步共享 JS 到探针 → 打包 zip。
 * 纯 Node，无第三方依赖。zip 用 Windows 自带 bsdtar（条目名为正斜杠）。 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const rootDir = path.resolve(__dirname, '..');

let fail = 0;
function check(ok, msg) {
  console.log((ok ? '✓ ' : '✗ ') + msg);
  if (!ok) fail = 1;
}

function listJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).forEach((f) => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile() && f.endsWith('.js')) out.push(p);
  });
  return out;
}

/* 1) 语法检查 */
[...listJs(path.join(rootDir, 'app/js')), ...listJs(path.join(rootDir, 'tools/probe/js'))]
  .forEach((f) => {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
      console.log('✓ 语法 ' + path.relative(rootDir, f));
    } catch (e) {
      check(false, '语法 ' + path.relative(rootDir, f) + '\n' + e.stderr);
    }
  });

/* 2) manifest JSON 校验 */
['app/manifest.webapp', 'tools/probe/manifest.webapp'].forEach((rel) => {
  try {
    JSON.parse(fs.readFileSync(path.join(rootDir, rel), 'utf8'));
    console.log('✓ manifest ' + rel);
  } catch (e) {
    check(false, 'manifest ' + rel + ': ' + e.message);
  }
});

/* 3) 协议自测 */
try {
  const Z = require(path.join(rootDir, 'app/js/zhiyun.js'));
  const v = new Uint8Array(Buffer.from('123456789', 'utf8'));
  check(Z.crc16(v) === 0x31C3, 'CRC16/XMODEM 标准向量 "123456789" → 0x31C3');

  /* Weebill-S 实测心跳帧样例（petermaguire.xyz 逆向文档）：CRC=0x4B98，帧内小端存放 98 4B */
  const sample = [0x24, 0x3E, 0x00, 0x0C, 0x18, 0x15, 0x08, 0x00, 0x01, 0x80, 0x50, 0x10, 0xC2, 0x01, 0x00, 0x00, 0x98, 0x4B];
  const gotA = Z.crc16(new Uint8Array(sample.slice(4, 16)));
  check(gotA === 0x4B98 && sample[16] === 0x98 && sample[17] === 0x4B,
    '心跳样例 CRC（FMT..PAYLOAD=0x' + gotA.toString(16) + '，小端应存 98 4B）');
  const parsed = new Z.Parser().push(new Uint8Array(sample));
  check(parsed.length === 1 && parsed[0].crcOk && parsed[0].cmd === 0x80 &&
    parsed[0].format === Z.FMT_HB && parsed[0].payload.length === 6,
    '真实心跳样例经 Parser 解析（crcOk、cmd=0x80）');

  const f = Z.buildOfficialFrame(0x20, [0xC0, 0x3C, 0x00]);
  const frames = new Z.Parser().push(f);
  check(frames.length === 1 && frames[0].cmd === 0x20 && frames[0].crcOk &&
    frames[0].payload[0] === 0xC0 && frames[0].payload[2] === 0x00,
    '帧编解码回环（按键帧 0x20 / c0 3c 00）');
  check(frames[0].type === 0x01 && frames[0].format === Z.FMT_CMD,
    '官方帧字段（flag=0x01, FMT=0x1812）');

  /* 抓包回归：云台按键上报帧与初始化应答帧（ZY Play btsnoop 实录） */
  const capBtn = new Uint8Array([0x24, 0x3C, 0x08, 0x00, 0x18, 0x12, 0x01, 0x10, 0x20, 0xC0, 0x3D, 0x00, 0x7C, 0x57]);
  const cb = new Z.Parser().push(capBtn);
  check(cb.length === 1 && cb[0].crcOk && cb[0].cmd === 0x20 && cb[0].type === 0x10 &&
    cb[0].payload[0] === 0xC0 && cb[0].payload[1] === 0x3D,
    '抓包按键帧解析（cmd=0x20 flag=0x10 c0 3d 00）');
  let btnHits = 0;
  const cli = new Z.Client(function () { return Promise.resolve(); }, { onButton: function () { btnHits++; } });
  cli.feed(capBtn);
  check(btnHits === 1, 'onButton 触发（cmd=0x20，忽略 dir=0x3C）');

  const p2 = new Z.Parser();
  const a = p2.push(f.subarray(0, 5));
  const b = p2.push(f.subarray(5));
  check(b.length === 1 && b[0].cmd === 0x20 && a.length === 0, '半帧分包解析');

  const garbage = new Uint8Array([0x00, 0x99, 0x24, 0x3C, 0x00, 0x06, 0x18, 0x12]);
  const p3 = new Z.Parser();
  p3.push(garbage);
  const c3 = p3.push(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xAA, 0xBB, 0x24, 0x3E]));
  check(Array.isArray(c3), '脏数据重同步不抛异常');
} catch (e) {
  check(false, '协议自测异常: ' + e.message);
}

/* 4) 共享 JS 同步到探针（逐字节一致由这里保证） */
['config.js', 'util.js', 'ble.js', 'session.js', 'buttons.js', 'zhiyun.js'].forEach((f) => {
  fs.copyFileSync(path.join(rootDir, 'app/js', f), path.join(rootDir, 'tools/probe/js', f));
});
console.log('✓ 共享 JS 已同步到 tools/probe/js');

/* 5) 图标缺失时生成 */
if (!fs.existsSync(path.join(rootDir, 'app/icons/icon112.png'))) {
  execFileSync(process.execPath, [path.join(rootDir, 'scripts/make-icons.js')], { stdio: 'inherit' });
}

/* 6) 打包 */
fs.mkdirSync(path.join(rootDir, 'dist'), { recursive: true });
function zipApp(appDir, zipName, entries) {
  const zip = path.join(rootDir, 'dist', zipName);
  try { fs.unlinkSync(zip); } catch (e) { /* 首次无文件 */ }
  execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-c', '-f', zip, ...entries], {
    cwd: path.join(rootDir, appDir)
  });
  const size = fs.statSync(zip).size;
  console.log('✓ 打包 ' + appDir + ' → dist/' + zipName + ' (' + size + ' B)');
}

if (!fail) {
  try {
    zipApp('app', 'zy-kaimc.zip', ['manifest.webapp', 'index.html', 'css', 'js', 'icons']);
    zipApp('tools/probe', 'zy-probe.zip', ['manifest.webapp', 'index.html', 'css', 'js', 'icons']);
  } catch (e) {
    check(false, '打包失败: ' + e.message);
  }
}

console.log(fail ? '✗ 构建失败' : '✓ 构建完成');
process.exit(fail);
