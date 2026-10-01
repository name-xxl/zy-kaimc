/* 通用工具：DOMRequest→Promise、十六进制、DOM 快捷操作 */
(function (root) {
  'use strict';

  var U = {};

  /* DOMRequest / Promise / 同步值 统一转 Promise */
  U.prom = function (req, label) {
    return new Promise(function (resolve, reject) {
      if (req === undefined || req === null) { resolve(undefined); return; }
      if (typeof req.then === 'function') { req.then(resolve, reject); return; }
      if (typeof req.onsuccess !== 'undefined' || typeof req.onerror !== 'undefined') {
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () {
          var why = req.error ? (req.error.message || req.error.name || String(req.error)) : 'unknown';
          reject(new Error((label || 'DOMRequest') + ' 失败: ' + why));
        };
        return;
      }
      resolve(req);
    });
  };

  U.hex = function (u8, max) {
    if (!u8) return '';
    var n = Math.min(u8.length, max || 64);
    var s = [];
    for (var i = 0; i < n; i++) {
      s.push(('0' + u8[i].toString(16)).slice(-2).toUpperCase());
    }
    return s.join(' ') + (u8.length > n ? ' …(' + u8.length + 'B)' : '');
  };

  U.byId = function (id) { return root.document.getElementById(id); };
  U.setText = function (id, text) {
    var el = U.byId(id);
    if (el) el.textContent = text;
  };
  U.show = function (id, on) {
    var el = U.byId(id);
    if (el) el.classList.toggle('hidden', !on);
  };

  /* 锁定竖屏方向并等待锁定完成（最长 800ms 兜底）。返回 Promise。
   * 仅为竖屏 UI 方向稳定保险——录像 tkhd 矩阵 = (传入 rotation + sensorAngle) % 360，
   * 与本锁无关（VID_rot0 未锁仍得正确 270° 矩阵）。 */
  U.lockPortrait = function () {
    return new Promise(function (resolve) {
      try {
        var sc = root.screen;
        if (sc && sc.orientation && sc.orientation.lock) {
          var p = sc.orientation.lock('portrait');
          if (p && typeof p.then === 'function') {
            p.then(function () { resolve(true); }, function () { resolve(false); });
            root.setTimeout(function () { resolve(false); }, 800);
            return;
          }
        }
        resolve(false); /* 无 API：拍不了也不阻塞，方向旋转交由上层处理 */
      } catch (e) { resolve(false); }
    });
  };

  root.KaiUtil = U;
})(typeof window !== 'undefined' ? window : globalThis);
