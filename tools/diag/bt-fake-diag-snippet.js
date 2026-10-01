(function () {
  if (window.__fakeDiag && window.__fakeDiag.stage === 'running') return 'already-running';
  var D = window.__fakeDiag = { stage: 'running', log: [], rx: [] };
  function L(m) { D.log.push(String(m)); }
  var bt = window.KaiBt, Z = window.Zhiyun, U = window.KaiUtil;
  if (!bt || !Z || !U) { L('FAIL modules missing'); D.stage = 'done'; return 'fired'; }

  bt.init().then(function () {
    L('adapter ok');
    /* unfiltered scan: PC fake gimbal may not appear under the FEE9 filter */
    return U.prom(bt.adapter.startLeScan([]), 'scan').then(function (h) {
      D.handle = h;
      D.seen = {};
      h.ondevicefound = function (e) {
        var d = e.device;
        if (!D.seen[d.address]) { D.seen[d.address] = 1; L('dev ' + (d.name || '(noname)') + ' @' + d.address + ' gatt=' + (d.gatt ? 'y' : 'n') + ' type=' + d.type); }
        if (D.dev) return;
        if (/FAKE|CRANE|M2/i.test(d.name || '')) { D.dev = d; L('PICK ' + d.name); }
        else if (!D.anyDev) { D.anyDev = d; }
      };
      return new Promise(function (res) { setTimeout(res, 12000); });
    });
  }).then(function () {
    try { bt.adapter.stopLeScan(D.handle); } catch (e) { /* stopped */ }
    var dev = D.dev || D.anyDev;
    if (!dev) { L('FAIL no device in 12s'); D.stage = 'done'; return; }
    L('connect ' + (dev.name || '?') + ' @' + dev.address + ' gatt=' + (dev.gatt ? 'y' : 'n'));
    return bt.connect(dev).then(function (con) {
      D.conn = con;
      L('connected svcs=' + con.services.length + ' write=' + !!con.writeChar + ' notify=' + !!con.notifyChar);
      return bt.armNotifications(con, function (val) {
        var u8 = new Uint8Array(val);
        D.rx.push(U.hex(u8));
        L('RX ' + U.hex(u8));
      });
    }).then(function (ni) {
      ni = ni || {};
      L('notify cccd=' + ni.cccd + ' wrote=' + (ni.wrote || '-') + ' startErr=' + (ni.startErr || '-'));
      var seq = [0x04, 0x7C, 0x7D, 0x7E, 0x7F, 0x06];
      var i = 0;
      function step() {
        if (i >= seq.length) {
          L('init sent, wait 8s');
          return new Promise(function (res) { setTimeout(res, 8000); });
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
