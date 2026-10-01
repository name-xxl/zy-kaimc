/* 纯格式/换算工具：时间、曝光补偿、电量、文件名。无 DOM 依赖，便于单测与复用。
 * 依赖：AppCfg（电量曲线，调用时读取，可缺省传入）。 */
(function (root) {
  'use strict';

  var F = {};

  function p2(n, w) {
    var s = String(n);
    while (s.length < (w || 2)) s = '0' + s;
    return s;
  }

  /* 日志时间戳：HH:MM:SS */
  F.fmtClock = function () {
    var d = new Date();
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  };

  /* 录像计时：秒 → MM:SS */
  F.fmtTime = function (secs) {
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    return p2(m) + ':' + p2(s);
  };

  /* 曝光补偿显示：最多两位小数并去掉尾零（0.5 → +0.5，-1 → -1），避免浮点长串 */
  F.fmtEc = function (v) {
    var n = Math.round(Number(v) * 100) / 100;
    var s = String(n).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return (n > 0 ? '+' : '') + s;
  };

  /* 电量换算：raw = 电池组电压×10mV（3S 18650）→ 单节电压查放电曲线得剩余百分比。
   * curve 缺省读 AppCfg.BATT_CELL_CURVE（[[mV, %], …] 由高到低） */
  F.battPct = function (raw, curve) {
    curve = curve || (root.AppCfg && root.AppCfg.BATT_CELL_CURVE);
    if (!curve || !curve.length) return 0;
    var mv = raw * 10 / 3;                     /* 单节电压（mV） */
    if (mv >= curve[0][0]) return curve[0][1];
    for (var i = 1; i < curve.length; i++) {
      if (mv >= curve[i][0]) {
        var hi = curve[i - 1], lo = curve[i];
        var k = (mv - lo[0]) / (hi[0] - lo[0]);
        return Math.round(lo[1] + k * (hi[1] - lo[1]));
      }
    }
    return 0;
  };

  /* 文件名时间戳：YYYYMMDD_HHMMSS */
  F.stamp = function () {
    var d = new Date();
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
      '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  };

  F.photoName = function () { return 'DCIM/ZYKaiCam/IMG_' + F.stamp() + '.jpg'; };

  /* 实测（2720）：KaiOS 播放器只对 .3gp 文件应用 tkhd 旋转矩阵，.mp4 同样内容会横转 90°
   * 播放 → 与系统相机一致使用 .3gp */
  F.videoName = function () { return 'DCIM/ZYKaiCam/VID_' + F.stamp() + '.3gp'; };

  root.KaiFmt = F;
})(typeof window !== 'undefined' ? window : globalThis);
