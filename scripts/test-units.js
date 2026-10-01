#!/usr/bin/env node
/* 纯函数单元测试：format.js / grid.js / buttons.js（不需要浏览器，也不碰真机）。
 * 由 scripts/build.js 一并执行；单独跑：node scripts/test-units.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
let fail = 0;
function check(ok, msg) {
  console.log((ok ? '✓ ' : '✗ ') + msg);
  if (!ok) fail = 1;
}

/* 用同一个沙箱上下文按 index.html 的顺序加载模块（IIFE 的 root 会落到该上下文） */
const sandbox = {};
vm.createContext(sandbox);
const fakeDoc = { createElement: () => ({ setAttribute() {}, classList: { add() {}, remove() {} } }) };
sandbox.document = fakeDoc;
sandbox.console = console;
['config.js', 'util.js', 'format.js', 'strings.js', 'grid.js', 'buttons.js'].forEach((f) => {
  const src = fs.readFileSync(path.join(rootDir, 'app/js', f), 'utf8');
  new vm.Script(src, { filename: f }).runInContext(sandbox);
});

const F = sandbox.KaiFmt;
const Grid = sandbox.KaiGrid;
const B = sandbox.KaiButtons;
const Cfg = sandbox.AppCfg;

check(!!F && !!Grid && !!B && !!Cfg, '模块加载（KaiFmt/KaiGrid/KaiButtons/AppCfg）');

/* ---- format.js ---- */
const ec = [['0.5', '+0.5'], ['-1', '-1'], ['2', '+2'], ['-0.30000000000000004', '-0.3'], ['1.6666666', '+1.67'], ['0', '0']];
ec.forEach(([inp, want]) => check(F.fmtEc(inp) === want, 'fmtEc(' + inp + ') = ' + want + '（实际 ' + F.fmtEc(inp) + '）'));

const tm = [[0, '00:00'], [9, '00:09'], [65, '01:05'], [3599, '59:59']];
tm.forEach(([inp, want]) => check(F.fmtTime(inp) === want, 'fmtTime(' + inp + ') = ' + want));
check(/^\d{2}:\d{2}:\d{2}$/.test(F.fmtClock()), 'fmtClock 形如 HH:MM:SS');

const bp = [[1260, 100], [1038, 10], [980, 1], [950, 0]];
bp.forEach(([raw, want]) => check(F.battPct(raw) === want, 'battPct(' + raw + ') = ' + want + '%（实际 ' + F.battPct(raw) + '）'));

check(/^DCIM\/ZYKaiCam\/IMG_\d{8}_\d{6}\.jpg$/.test(F.photoName()), '照片文件名规则');
const vn = F.videoName();
check(/^DCIM\/ZYKaiCam\/VID_\d{8}_\d{6}\.3gp$/.test(vn), '录像文件名规则（.3gp 为硬规则，播放器只对它应用旋转矩阵）');

/* ---- grid.js ---- */
check(Grid.next('thirds', 1) === 'golden' && Grid.next('thirds', -1) === 'off', '辅助线循环：→ 下一种、← 上一种');
check(Grid.next('off', -1) === Grid.MODES[Grid.MODES.length - 1], '辅助线循环两端绕圈');
check(Grid.next('不存在', 1) === 'thirds', '未知模式回落到第一项之后');

/* ---- buttons.js ---- */
check(B.codeOf({ payload: [0xC0, 0x3D, 0x00] }) === 0x3D, 'codeOf 取 payload[1]');
check(B.codeOf({ payload: [0x00, 0x3D, 0x00] }) === null, 'codeOf 非 C0 前缀返回 null');
check(B.codeOf(null) === null, 'codeOf 空帧不抛异常');

let hits = [];
B.bind({
  shutter: () => hits.push('shutter'),
  photo: () => hits.push('photo'),
  zoomStart: (d) => hits.push('zoom' + d),
  zoomStop: () => hits.push('zoomStop'),
  mode: () => hits.push('mode')
});
B.handle(Cfg.KEY.SHUTTER); B.handle(Cfg.KEY.PHOTO);
B.handle(Cfg.KEY.ZOOM_IN); B.handle(Cfg.KEY.ZOOM_OUT);
B.handle(Cfg.KEY.ZOOM_REL_A); B.handle(Cfg.KEY.ZOOM_REL_B);
check(hits.join(',') === 'shutter,photo,zoom1,zoom-1,zoomStop,zoomStop', 'handle 分发六个键码（实际 ' + hits.join(',') + '）');
check(B.handle(0x99) === null, '未登记键码不动作');

/* ---- 配置自洽 ---- */
check(Cfg.MODE_NAMES.length >= 6 && Cfg.MODE_NAMES[2] === 'F', '模式表含 F=0x02（实测）');
check(Array.isArray(Cfg.BATT_CELL_CURVE) && Cfg.BATT_CELL_CURVE[0][0] === 4200, '电量曲线首项为满电 4200mV');

console.log(fail ? '✗ 单元测试失败' : '✓ 单元测试通过');
process.exit(fail);
