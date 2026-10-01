(function () {
  if (window.__btDiag && window.__btDiag.stage === 'running') return 'already-running';
  var D = window.__btDiag = { stage: 'running', log: [] };
  function L(m) { D.log.push(String(m)); }
  /* instance + prototype chain property names (WebIDL props live on the prototype) */
  function names(o) {
    var out = [], seen = {};
    for (var x = o, d = 0; x && d < 4; d++, x = Object.getPrototypeOf(x)) {
      var own;
      try { own = Object.getOwnPropertyNames(x); } catch (e) { break; }
      own.forEach(function (k) { if (!seen[k]) { seen[k] = true; out.push(k); } });
    }
    return out;
  }
  /* Promise / DOMRequest / sync value -> Promise */
  function toP(v) {
    return new Promise(function (res, rej) {
      if (v && typeof v.then === 'function') return v.then(res, rej);
      if (v && typeof v.onsuccess !== 'undefined') {
        v.onsuccess = function () { res(v.result); };
        v.onerror = function () { rej(v.error || new Error('DOMRequest failed')); };
        return;
      }
      res(v);
    });
  }
  var FEE9 = ['0000fee9-0000-1000-8000-00805f9b34fb'];
  try {
    var M = navigator.mozBluetooth;
    L('host ' + location.href);
    if (!M) { L('FAIL mozBluetooth missing'); D.stage = 'done'; return 'fired'; }
    L('mgr[' + names(M).join('|') + ']');
    toP(M.getDefaultAdapter ? M.getDefaultAdapter() : null).then(function (a) {
      var adapter = a || M.defaultAdapter;
      if (!adapter) throw new Error('no bt adapter (is BT on in settings?)');
      window.__btAdapter = adapter;
      L('adapter[' + names(adapter).join('|') + ']');
      var en, st;
      try { en = adapter.enabled; } catch (e) { en = 'throw'; }
      try { st = adapter.state; } catch (e) { st = 'throw'; }
      L('enabled=' + en + ' state=' + st);
      L('-- LE scan(fee9) --');
      return toP(adapter.startLeScan(FEE9));
    }).then(function (h) {
      return new Promise(function (res) {
        var found = null, all = [];
        var timer = setTimeout(function () { res({ h: h, found: found, all: all }); }, 20000);
        h.ondevicefound = function (e) {
          var d = e.device;
          if (all.length < 8) all.push((d.name || '(no name)') + '@' + d.address);
          if (!found && /CRANE|M2/i.test(d.name || '')) {
            found = d;
            clearTimeout(timer);
            res({ h: h, found: found, all: all });
          }
        };
      });
    }).then(function (r) {
      try { window.__btAdapter.stopLeScan(r.h); } catch (e) { /* stopped */ }
      if (!r.found) throw new Error('no gimbal in 20s. nearby LE: ' + (r.all.join(', ') || 'none'));
      var d = r.found;
      window.__btDev = d;
      L('FOUND gimbal ' + d.name + ' @' + d.address);
      L('scan-device props[' + names(d).join('|') + ']');
      L('gatt=' + (d.gatt ? 'yes' : 'no') + ' type=' + d.type + ' fetchUuids=' + typeof d.fetchUuids);
      var step;
      if (typeof window.__btAdapter.pair === 'function') {
        L('-- adapter.pair --');
        step = toP(window.__btAdapter.pair(d.address)).then(
          function () { L('OK pair success'); },
          function (e) { L('FAIL pair: ' + ((e && (e.message || e.name)) || e)); }
        );
      } else {
        L('FAIL no adapter.pair in firmware');
        step = Promise.resolve();
      }
      return step.then(function () {
        if (typeof window.__btAdapter.getPairedDevices !== 'function') {
          L('FAIL no getPairedDevices');
          return null;
        }
        return toP(window.__btAdapter.getPairedDevices()).then(function (list) {
          list = list || [];
          L('paired devices: ' + list.length);
          var hit = null;
          list.forEach(function (p, i) {
            L('[' + (i + 1) + '] ' + (p.name || '') + ' @' + p.address +
              ' gatt=' + (p.gatt ? 'yes' : 'no') + ' props[' + names(p).join('|') + ']');
            if (!hit && /CRANE|M2/i.test(p.name || '')) hit = p;
          });
          return hit;
        });
      }).then(function (hit) {
        var gatt = (hit && hit.gatt) || window.__btDev.gatt;
        if (!gatt) {
          L('VERDICT: neither scan object nor paired record has gatt - this firmware exposes NO GATT entry, firmware upgrade required');
          D.stage = 'done';
          return;
        }
        L('-- gatt.connect() --');
        return toP(gatt.connect()).then(function () {
          L('OK gatt.connect success');
          return toP(gatt.discoverServices()).catch(function () { L('discoverServices failed (continue)'); });
        }).then(function () {
          var svcs = gatt.services || [];
          L('services: ' + svcs.length);
          svcs.forEach(function (s) {
            L('SVC ' + s.uuid);
            (s.characteristics || []).forEach(function (c) { L('  CHR ' + c.uuid); });
          });
          try { gatt.disconnect(); } catch (e) { /* already off */ }
          L('VERDICT: GATT link WORKS via paired record - reinstall main app and it will connect');
          D.stage = 'done';
        });
      });
    }).catch(function (e) {
      L('FAIL exception: ' + ((e && (e.message || e.name)) || e));
      D.stage = 'done';
    });
  } catch (e) { L('FAIL throw: ' + e.name + ':' + e.message); D.stage = 'done'; }
  return 'fired';
})()
