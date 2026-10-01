/* 云台按键码 → 动作分发：动作由调用方注入（依赖倒置，便于替换与测试）。
 * 键码与语义见 AppCfg.KEY（2026-10-01 真机实测：单击 0x3D / 双击 0x3C / 变焦杆 0x18·0x17 按、0x28·0x27 松）。 */
(function (root) {
  'use strict';

  var C = root.AppCfg;
  var B = {};

  /* 注入动作表：{shutter, photo, zoomStart(dir), zoomStop, mode} */
  B.bind = function (actions) { B.actions = actions || null; };

  /* 从 cmd=0x20 的按键帧里取键码：payload = C0 <code> 00 */
  B.codeOf = function (frame) {
    var p = frame && frame.payload;
    return (p && p.length >= 2 && p[0] === 0xC0) ? p[1] : null;
  };

  /* 执行一个键码；返回动作名（未登记返回 null，仅记日志不动作） */
  B.handle = function (code) {
    var a = B.actions;
    if (code === null || !a) return null;
    var K = C.KEY;
    if (code === K.SHUTTER) { a.shutter(); return 'shutter'; }
    if (code === K.PHOTO) { a.photo(); return 'photo'; }
    if (code === K.ZOOM_IN) { a.zoomStart(1); return 'zoom-in'; }
    if (code === K.ZOOM_OUT) { a.zoomStart(-1); return 'zoom-out'; }
    if (code === K.ZOOM_REL_A || code === K.ZOOM_REL_B) { a.zoomStop(); return 'zoom-stop'; }
    return null;
  };

  root.KaiButtons = B;
})(typeof window !== 'undefined' ? window : globalThis);
