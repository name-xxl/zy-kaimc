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

  /* 给 Promise 加超时（DOMRequest 可能永久挂起，如权限弹窗未应答） */
  U.withTimeout = function (p, ms, label) {
    return Promise.race([p, new Promise(function (_, reject) {
      root.setTimeout(function () { reject(new Error((label || '操作') + ' 超时(' + ms + 'ms)')); }, ms);
    })]);
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

  root.KaiUtil = U;
})(typeof window !== 'undefined' ? window : globalThis);
