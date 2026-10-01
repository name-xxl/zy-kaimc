(function () {
  if (window.__btDiag && window.__btDiag.stage === 'running') return 'already-running';
  var D = window.__btDiag = { stage: 'running', log: [] };
  function L(m) { D.log.push(String(m)); }
  /* 实例 + 原型链属性名（WebIDL 属性在原型上） */
  function names(o) {
    var out = [], seen = {};
    for (var x = o, d = 0; x && d < 4; d++, x = Object.getPrototypeOf(x)) {
      var own;
      try { own = Object.getOwnPropertyNames(x); } catch (e) { break; }
      own.forEach(function (k) { if (!seen[k]) { seen[k] = true; out.push(k); } });
    }
    return out;
  }
  /* Promise / DOMRequest / 同步值 统一转 Promise */
  function toP(v) {
    return new Promise(function (res, rej) {
      if (v && typeof v.then === 'function') return v.then(res, rej);
      if (v && typeof v.onsuccess !== 'undefined') {
        v.onsuccess = function () { res(v.result); };
        v.onerror = function () { rej(v.error || new Error('DOMRequest 失败')); };
        return;
      }
      res(v);
    });
  }
  var FEE9 = ['0000fee9-0000-1000-8000-00805f9b34fb'];
  try {
    var M = navigator.mozBluetooth;
    L('宿主 ' + location.href);
    if (!M) { L('✗ mozBluetooth 不存在'); D.stage = 'done'; return 'fired'; }
    L('mgr[' + names(M).join('|') + ']');
    toP(M.getDefaultAdapter ? M.getDefaultAdapter() : null).then(function (a) {
      var adapter = a || M.defaultAdapter;
      if (!adapter) throw new Error('无蓝牙适配器（系统设置开蓝牙了吗？）');
      window.__btAdapter = adapter;
      L('adapter[' + names(adapter).join('|') + ']');
      var en, st;
      try { en = adapter.enabled; } catch (e) { en = 'throw'; }
      try { st = adapter.state; } catch (e) { st = 'throw'; }
      L('enabled=' + en + ' state=' + st);
      L('—— LE 扫描(fee9) ——');
      return toP(adapter.startLeScan(FEE9));
    }).then(function (h) {
      return new Promise(function (res) {
        var found = null, all = [];
        var timer = setTimeout(function () { res({ h: h, found: found, all: all }); }, 20000);
        h.ondevicefound = function (e) {
          var d = e.device;
          if (all.length < 8) all.push((d.name || '(无名)') + '@' + d.address);
          if (!found && /CRANE|M2/i.test(d.name || '')) {
            found = d;
            clearTimeout(timer);
            res({ h: h, found: found, all: all });
          }
        };
      });
    }).then(function (r) {
      try { window.__btAdapter.stopLeScan(r.h); } catch (e) { /* 已停 */ }
      if (!r.found) throw new Error('20s 未扫到云台。附近 LE: ' + (r.all.join(', ') || '无'));
      var d = r.found;
      window.__btDev = d;
      L('✓ 扫到云台 ' + d.name + ' @' + d.address);
      L('扫描设备属性[' + names(d).join('|') + ']');
      L('gatt=' + (d.gatt ? '有' : '无') + ' type=' + d.type + ' fetchUuids=' + typeof d.fetchUuids);
      var step;
      if (typeof window.__btAdapter.pair === 'function') {
        L('—— adapter.pair ——');
        step = toP(window.__btAdapter.pair(d.address)).then(
          function () { L('✓ pair 成功'); },
          function (e) { L('✗ pair 失败: ' + ((e && (e.message || e.name)) || e)); }
        );
      } else {
        L('✗ 固件无 adapter.pair');
        step = Promise.resolve();
      }
      return step.then(function () {
        if (typeof window.__btAdapter.getPairedDevices !== 'function') {
          L('✗ 无 getPairedDevices');
          return null;
        }
        return toP(window.__btAdapter.getPairedDevices()).then(function (list) {
          list = list || [];
          L('配对设备 ' + list.length + ' 个');
          var hit = null;
          list.forEach(function (p, i) {
            L('[' + (i + 1) + '] ' + (p.name || '') + ' @' + p.address +
              ' gatt=' + (p.gatt ? '有' : '无') + ' 属性[' + names(p).join('|') + ']');
            if (!hit && /CRANE|M2/i.test(p.name || '')) hit = p;
          });
          return hit;
        });
      }).then(function (hit) {
        var gatt = (hit && hit.gatt) || window.__btDev.gatt;
        if (!gatt) {
          L('★ 结论：扫描对象和配对记录都没有 gatt——这版固件没有暴露任何 GATT 入口，只能升级固件');
          D.stage = 'done';
          return;
        }
        L('—— gatt.connect() ——');
        return toP(gatt.connect()).then(function () {
          L('✓ gatt.connect 成功');
          return toP(gatt.discoverServices()).catch(function () { L('discoverServices 失败(继续)'); });
        }).then(function () {
          var svcs = gatt.services || [];
          L('服务 ' + svcs.length + ' 个');
          svcs.forEach(function (s) {
            L('SVC ' + s.uuid);
            (s.characteristics || []).forEach(function (c) { L('  CHR ' + c.uuid); });
          });
          try { gatt.disconnect(); } catch (e) { /* 已断 */ }
          L('★ 结论：GATT 链路可通！配对记录路线可用，主应用重装即可连云台');
          D.stage = 'done';
        });
      });
    }).catch(function (e) {
      L('✗ 异常: ' + ((e && (e.message || e.name)) || e));
      D.stage = 'done';
    });
  } catch (e) { L('✗ throw: ' + e.name + ':' + e.message); D.stage = 'done'; }
  return 'fired';
})()
