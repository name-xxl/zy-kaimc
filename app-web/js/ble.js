/* KaiOS mozBluetooth 封装：适配器获取、BLE 扫描、GATT 连接与发现、通知武装、写特征 */
(function (root) {
  'use strict';

  var U = root.KaiUtil;

  var FEE9_UUID = '0000fee9-0000-1000-8000-00805f9b34fb';

  function Bt() { this.adapter = null; }

  Bt.prototype.available = function () { return !!root.navigator.mozBluetooth; };

  /* 获取适配器：KaiOS 上 defaultAdapter 属性可能延迟出现，属性/DOMRequest/事件三路兜底 */
  Bt.prototype.init = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var mgr = root.navigator.mozBluetooth;
      if (!mgr) {
        reject(new Error('mozBluetooth 不可用：需要 privileged 应用权限（WebIDE/gdeploy 安装）'));
        return;
      }
      var settled = false;
      var finish = function (err, adapter) {
        if (settled) return;
        settled = true;
        try { mgr.removeEventListener('attributechanged', onAttr); } catch (e) {}
        if (err) reject(err);
        else { self.adapter = adapter; resolve(adapter); }
      };
      var tryAdapter = function (a) {
        if (!settled && a) finish(null, a);
      };
      var onAttr = function () { tryAdapter(mgr.defaultAdapter); };

      if (mgr.defaultAdapter) { tryAdapter(mgr.defaultAdapter); return; }
      try { mgr.addEventListener('attributechanged', onAttr); } catch (e) {}
      if (typeof mgr.getDefaultAdapter === 'function') {
        U.prom(mgr.getDefaultAdapter(), 'getDefaultAdapter').then(tryAdapter).catch(function () {});
      }
      root.setTimeout(function () {
        finish(new Error('获取蓝牙适配器超时（请在系统设置打开蓝牙）'));
      }, 8000);
    });
  };

  /* 原始蓝牙状态（调试面板显示用） */
  Bt.prototype.radioProbe = function () {
    var a = this.adapter;
    var en = '?', st = '?';
    try { en = a.enabled; } catch (e) { en = '抛异常'; }
    try { st = a.state; } catch (e) { st = '抛异常'; }
    return 'enabled=' + en + ' state=' + st;
  };

  /* 是否已开启。优先读 B2G 标准的 enabled 布尔；都读不到时乐观放行，
   * 让后续 startLeScan 给出真实错误，而不是在这里瞎等 */
  Bt.prototype.isEnabled = function () {
    var a = this.adapter;
    var en;
    try { en = a.enabled; } catch (e) { en = undefined; }
    if (typeof en === 'boolean') return en;
    var st;
    try { st = a.state; } catch (e) { st = undefined; }
    if (st) return (st === 'enabled' || st === 'on');
    return true;
  };

  Bt.prototype.ensureEnabled = function () {
    var self = this;
    var adapter = this.adapter;
    if (self.isEnabled()) return Promise.resolve(true);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var finish = function (err) {
        if (settled) return;
        settled = true;
        root.clearInterval(poll);
        try { adapter.removeEventListener('attributechanged', onAttr); } catch (e) { /* 已移除 */ }
        if (err) reject(err); else resolve(true);
      };
      var onAttr = function () { /* 由 poll 统一判定状态 */ };
      try { adapter.addEventListener('attributechanged', onAttr); } catch (e) { /* 无事件 */ }
      var poll = root.setInterval(function () {
        if (self.isEnabled()) finish(null);
      }, 500);
      try {
        var p = adapter.enable();
        if (p && typeof p.catch === 'function') {
          p.catch(function (e) {
            finish(new Error('蓝牙 enable() 被拒: ' + ((e && (e.message || e.name)) || e)));
          });
        } else if (p && 'onsuccess' in p) {
          p.onerror = function () { finish(new Error('蓝牙 enable() 被拒（请在系统设置手动打开）')); };
        }
      } catch (e) { /* 有的固件无 enable()，只能等系统开关 */ }
      root.setTimeout(function () {
        finish(new Error('蓝牙开启超时(' + self.radioProbe() + ')，请在系统设置打开蓝牙'));
      }, 12000);
    });
  };

  /* LE 扫描，onDevice({address, name, rssi, device})；resolve {stop()} */
  Bt.prototype.startScan = function (onDevice) {
    var adapter = this.adapter;
    var run = function (uuids) {
      return U.prom(adapter.startLeScan(uuids), 'startLeScan').then(function (handle) {
        var seen = {};
        handle.ondevicefound = function (e) {
          var d = e.device;
          if (!d || !d.address || seen[d.address]) return;
          seen[d.address] = true;
          onDevice({ address: d.address, name: d.name || '', rssi: e.rssi, device: d });
        };
        return {
          stop: function () {
            try { adapter.stopLeScan(handle); } catch (e) { /* 已停止 */ }
          }
        };
      });
    };
    return run([]).catch(function () {
      /* 有的固件要求至少一个 service UUID */
      return run([FEE9_UUID]);
    });
  };

  /* GATT 连接 + 服务发现；resolve {gatt, services, fee9, writeChar, notifyChar} */
  Bt.prototype.connect = function (device) {
    var gatt = device.gatt;
    if (!gatt) return Promise.reject(new Error('设备没有 GATT 接口'));
    return U.prom(gatt.connect(), 'gatt.connect').then(function () {
      return U.prom(gatt.discoverServices(), 'discoverServices').catch(function () {
        /* 有的栈 connect 后服务已就绪 */
      });
    }).then(function () {
      var services = gatt.services || [];
      var res = { gatt: gatt, services: services, fee9: null, writeChar: null, notifyChar: null };
      services.forEach(function (s) {
        var su = (s.uuid || '').toLowerCase();
        if (su.indexOf('fee9') === -1) return;
        res.fee9 = s;
        (s.characteristics || []).forEach(function (c) {
          var cu = (c.uuid || '').toLowerCase();
          if (cu.indexOf('129600') !== -1) res.writeChar = c;
          if (cu.indexOf('129601') !== -1) res.notifyChar = c;
        });
      });
      return res;
    });
  };

  /* 尽力打开通知。KaiOS 实机可能不派发事件（kaios.dev 实测），调用方必须做 readValue 轮询兜底 */
  Bt.prototype.armNotifications = function (con, onValue) {
    var gatt = con.gatt;
    var handler = function (e) {
      if (e && e.value) onValue(e.value, 'NOTIFY');
    };
    try { gatt.oncharacteristicchanged = handler; } catch (e) { /* 属性只读等情况 */ }
    try { gatt.addEventListener('characteristicchanged', handler); } catch (e) {}
    return U.prom(con.notifyChar.startNotifications(), 'startNotifications');
  };

  Bt.prototype.write = function (con, arrayBuffer) {
    return U.prom(con.writeChar.writeValue(arrayBuffer), 'writeValue');
  };

  Bt.prototype.disconnect = function (con) {
    if (con && con.gatt && con.gatt.disconnect) {
      try { con.gatt.disconnect(); } catch (e) { /* 已断开 */ }
    }
  };

  root.KaiBt = new Bt();
})(typeof window !== 'undefined' ? window : globalThis);
