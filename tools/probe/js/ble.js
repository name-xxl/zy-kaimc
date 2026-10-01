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
    /* 先带 FEE9 过滤：扫到的设备栈已确认为 LE，记录归类正确 gatt 才不为 null；
     * 有的固件 UUID 过滤扫不到，退回全量扫描 */
    return run([FEE9_UUID]).catch(function () {
      return run([]);
    });
  };

  /* 设备形状诊断串：gatt 拿不到时，用 in 探测原型链属性（WebIDL 属性不在 Object.keys 里） */
  function describeDevice(d) {
    var parts = [];
    var probe = ['address', 'name', 'type', 'paired', 'uuids', 'gatt', 'fetchUuids'];
    var has = [];
    probe.forEach(function (k) {
      try { if (k in d) has.push(k); } catch (e) { /* 原型链抛异常也当没有 */ }
    });
    parts.push('has=' + (has.join('|') || 'none'));
    try { parts.push('type=' + d.type); } catch (e) { /* 无该属性 */ }
    try { if (d.uuids) parts.push('uuids=' + d.uuids.length); } catch (e) { /* 无该属性 */ }
    return parts.join(' ');
  }

  /* 配对记录兜底：系统设置里配对过的设备记录 type 正确、gatt 通常可用。
   * 失败时把配对路径的结局也报出来（apiMissing/err/数量/noGATT/noMatch），便于真机定位 */
  Bt.prototype.gattFromPaired = function (device, hint) {
    var adapter = this.adapter;
    if (!adapter || typeof adapter.getPairedDevices !== 'function') {
      return Promise.reject(new Error('设备没有 GATT 接口(' + hint + ' paired=apiMissing)'));
    }
    return U.prom(adapter.getPairedDevices(), 'getPairedDevices').catch(function (e) {
      throw new Error('设备没有 GATT 接口(' + hint + ' paired=err:' +
        ((e && (e.message || e.name)) || 'unknown') + ')');
    }).then(function (list) {
      list = list || [];
      var tag = String(list.length);
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p || p.address !== device.address) continue;
        if (p.gatt) return p.gatt;
        tag += ' noGATT';
      }
      if (list.length && tag.indexOf(' ') === -1) tag += ' noMatch';
      throw new Error('设备没有 GATT 接口(' + hint + ' paired=' + tag +
        ')。云台是 BLE-only，系统设置搜不到，用探针按 8 程序配对后重试');
    });
  };

  /* 拿可用的 gatt：直取 → fetchUuids 刷新记录 → 系统配对记录。
   * 官方文档 gatt 对 classic/unknown 类型设备返回 null，扫描记录可能尚未归类为 LE */
  Bt.prototype.acquireGatt = function (device) {
    var self = this;
    /* startScan 给上层的是 {address,name,rssi,device} 包装，真 BluetoothDevice 在 .device 里 */
    var dev = device && device.device && device.device.gatt !== undefined ? device.device : device;
    if (dev.gatt) return Promise.resolve(dev.gatt);
    var hint = describeDevice(dev);
    if (typeof dev.fetchUuids !== 'function') return self.gattFromPaired(dev, hint);
    return U.prom(dev.fetchUuids(), 'fetchUuids').catch(function () { /* 刷新失败继续兜底 */ })
      .then(function () {
        if (dev.gatt) return dev.gatt;
        return self.gattFromPaired(dev, hint);
      });
  };

  /* GATT 连接 + 服务发现；resolve {gatt, services, fee9, writeChar, notifyChar} */
  Bt.prototype.connect = function (device) {
    var self = this;
    return self.acquireGatt(device).then(function (gatt) {
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
    });
  };

  /* 检查并（必要时）手动打开通知 CCCD(0x2902)。
   * KaiOS 的 startNotifications() 可能是空壳：CCCD 不写 0x0001，云台永远不会发通知 */
  Bt.prototype.ensureNotifyCccd = function (con) {
    var ch = con.notifyChar;
    var info = { props: null, desc: false, cccd: '', wrote: '' };
    try { info.props = ch.properties; } catch (e) { /* 无该属性 */ }
    var d = null, ds = [];
    try { ds = ch.descriptors || []; } catch (e) { ds = []; }
    for (var i = 0; i < ds.length; i++) {
      if (String(ds[i].uuid || '').toLowerCase().indexOf('2902') !== -1) { d = ds[i]; break; }
    }
    if (!d) { info.cccd = 'no-2902'; return Promise.resolve(info); }
    info.desc = true;
    var readBack = function () {
      return U.prom(d.readValue(), 'cccd.readValue').then(function () {
        var v = new Uint8Array(d.value || []);
        info.cccd = v.length ? U.hex(v) : '(empty)';
      }, function (e) {
        info.cccd = 'read-err:' + ((e && (e.message || e.name)) || 'unknown');
      });
    };
    return readBack().then(function () {
      if (info.cccd === '01' || info.cccd === '02') return info;
      /* 有通知属性(0x10)写 0x0001；只有指示(0x20)写 0x0002 */
      var enable = (typeof info.props === 'number' && (info.props & 0x20) && !(info.props & 0x10)) ? 2 : 1;
      var buf = new Uint8Array([enable, 0x00]).buffer;
      return U.prom(d.writeValue(buf), 'cccd.writeValue').then(function () {
        info.wrote = '0x' + enable;
        return readBack();
      }, function (e) {
        info.wrote = 'err:' + ((e && (e.message || e.name)) || 'unknown');
      });
    });
  };

  /* 尽力打开通知。KaiOS 实机可能不派发事件（kaios.dev 实测），调用方必须做 readValue 轮询兜底。
   * resolve 通知状态 info：{props, desc, cccd, wrote, startErr?}（不再 reject，交给调用方展示） */
  Bt.prototype.armNotifications = function (con, onValue) {
    var self = this;
    var gatt = con.gatt;
    var handler = function (e) {
      if (e && e.value) onValue(e.value, 'NOTIFY');
    };
    try { gatt.oncharacteristicchanged = handler; } catch (e) { /* 属性只读等情况 */ }
    try { gatt.addEventListener('characteristicchanged', handler); } catch (e) {}
    var started = U.prom(con.notifyChar.startNotifications(), 'startNotifications')
      .then(function () { return null; },
        function (e) { return (e && (e.message || e.name)) || 'unknown'; });
    return started.then(function (startErr) {
      return self.ensureNotifyCccd(con).then(function (info) {
        if (startErr) info.startErr = startErr;
        return info;
      });
    });
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
