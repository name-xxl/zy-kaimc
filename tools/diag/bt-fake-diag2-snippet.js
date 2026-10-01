(function () {
  if (window.__fakeDiag2 && window.__fakeDiag2.stage === 'running') return 'already-running';
  var D = window.__fakeDiag2 = { stage: 'running', log: [], rx: [] };
  function L(m) { D.log.push(String(m)); }
  var bt = window.KaiBt, Z = window.Zhiyun, U = window.KaiUtil;
  if (!bt || !Z || !U) { L('FAIL modules missing'); D.stage = 'done'; return 'fired'; }

  bt.init().then(function () {
    L('adapter ok');
    return U.prom(bt.adapter.startLeScan([]), 'scan').then(function (h) {
      D.handle = h;
      D.seen = {};
      h.ondevicefound = function (e) {
        var d = e.device;
        if (!D.seen[d.address]) { D.seen[d.address] = 1; L('dev ' + (d.name || '(noname)') + ' @' + d.address); }
        if (D.dev) return;
        if (/FAKE|CRANE|M2/i.test(d.name || '')) { D.dev = d; L('PICK ' + d.name); }
        else if (!D.anyDev) { D.anyDev = d; }
      };
      return new Promise(function (res) { setTimeout(res, 12000); });
    });
  }).then(function () {
    try { bt.adapter.stopLeScan(D.handle); } catch (e) { /* stopped */ }
    var dev = D.dev || D.anyDev;
    if (!dev) { L('FAIL no device'); D.stage = 'done'; return; }
    L('connect ' + (dev.name || '?') + ' @' + dev.address);
    return bt.connect(dev).then(function (con) {
      D.conn = con;
      L('connected svcs=' + con.services.length + ' write=' + !!con.writeChar + ' notify=' + !!con.notifyChar);
      var ch = con.notifyChar;
      var handler = function (e) {
        if (e && e.value) {
          var u8 = new Uint8Array(e.value);
          D.rx.push(U.hex(u8));
          L('RX ' + U.hex(u8));
        }
      };
      try { con.gatt.oncharacteristicchanged = handler; } catch (e) { /* readonly */ }
      try { con.gatt.addEventListener('characteristicchanged', handler); } catch (e) { /* nope */ }
      L('call startNotifications only (no manual CCCD write)');
      return U.prom(ch.startNotifications(), 'startNotifications').then(
        function () { L('startNotifications RESOLVED'); },
        function (e) { L('startNotifications REJECTED: ' + ((e && (e.message || e.name)) || e)); });
    }).then(function () {
      var seq = [0x04, 0x7C, 0x7D, 0x7E, 0x7F, 0x06];
      var i = 0;
      function step() {
        if (i >= seq.length) {
          L('init sent, wait 14s (watch RX)');
          return new Promise(function (res) { setTimeout(res, 14000); });
        }
        var f = Z.buildOfficialFrame(seq[i++], [0, 0, 0]);
        return bt.write(D.conn, f.buffer).then(function () {
          L('TX ' + U.hex(f));
          return new Promise(function (res) { setTimeout(res, 300); });
        }).then(step);
      }
      return step();
    });
  }).then(function () {
    L('DONE rxCount=' + D.rx.length);
    D.stage = 'done';
  }).catch(function (e) {
    L('FAIL ' + ((e && (e.message || e.name)) || e));
    D.stage = 'done';
  });
  return 'fired';
})()
