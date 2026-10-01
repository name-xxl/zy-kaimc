(function () {
  if (window.__fakeDiag3 && window.__fakeDiag3.stage === 'running') return 'already-running';
  var D = window.__fakeDiag3 = { stage: 'running', log: [], rx: [] };
  function L(m) { D.log.push(String(m)); }
  var bt = window.KaiBt, U = window.KaiUtil;
  if (!bt || !U) { L('FAIL modules missing'); D.stage = 'done'; return 'fired'; }

  function findChar(con, uuidPart) {
    var hit = null;
    (con.services || []).forEach(function (s) {
      (s.characteristics || []).forEach(function (c) {
        if (String(c.uuid || '').toLowerCase().indexOf(uuidPart) !== -1) hit = hit || c;
      });
    });
    return hit;
  }
  function readVal(label, ch) {
    return U.prom(ch.readValue(), label).then(function () {
      var v = new Uint8Array(ch.value || []);
      L(label + ' = ' + U.hex(v) + (v.length ? ' ascii=' + String.fromCharCode.apply(null, v) : ''));
    }, function (e) {
      L(label + ' FAILED ' + ((e && (e.message || e.name)) || e));
    });
  }

  bt.init().then(function () {
    L('adapter ok');
    return bt.startScan(function (dev) {
      if (D.dev) return;
      if (/CRANE/i.test(dev.name || '')) { D.dev = dev; L('PICK ' + dev.name); }
      else if (!D.anyDev) { D.anyDev = dev; }
    });
  }).then(function (h) {
    return new Promise(function (res) { setTimeout(function () { try { h.stop(); } catch (e) {} res(); }, 10000); });
  }).then(function () {
    var dev = D.dev || D.anyDev;
    if (!dev) { L('FAIL no device'); D.stage = 'done'; return; }
    L('connect ' + (dev.name || '?') + ' @' + dev.address);
    return bt.connect(dev).then(function (con) {
      D.conn = con;
      L('connected svcs=' + con.services.length);
      var nameCh = findChar(con, '2a00');
      var cccd = null;
      try {
        (con.notifyChar.descriptors || []).forEach(function (d) {
          if (String(d.uuid || '').toLowerCase().indexOf('2902') !== -1) cccd = d;
        });
      } catch (e) { /* none */ }
      L('nameChar=' + !!nameCh + ' cccdDesc=' + !!cccd);
      var chain = Promise.resolve();
      if (nameCh) chain = chain.then(function () { return readVal('READ 2A00 name', nameCh); });
      if (cccd) chain = chain.then(function () { return readVal('CCCD before', cccd); });
      chain = chain.then(function () {
        L('call startNotifications');
        return U.prom(con.notifyChar.startNotifications(), 'startNotifications').then(
          function () { L('startNotifications RESOLVED'); },
          function (e) { L('startNotifications REJECTED ' + ((e && (e.message || e.name)) || e)); });
      });
      if (cccd) chain = chain.then(function () { return readVal('CCCD after startNotifications', cccd); });
      if (cccd) {
        chain = chain.then(function () {
          L('manual write CCCD 01 00');
          return U.prom(cccd.writeValue(new Uint8Array([1, 0]).buffer), 'cccd.write').then(
            function () { L('CCCD write RESOLVED'); },
            function (e) { L('CCCD write REJECTED ' + ((e && (e.message || e.name)) || e)); });
        }).then(function () { return readVal('CCCD after manual write', cccd); });
      }
      chain = chain.then(function () {
        var gatt = con.gatt;
        try { gatt.oncharacteristicchanged = function (e) { if (e && e.value) { D.rx.push(U.hex(new Uint8Array(e.value))); L('RX ' + U.hex(new Uint8Array(e.value))); } }; } catch (e) {}
        L('listen 10s');
        return new Promise(function (res) { setTimeout(res, 10000); });
      });
      return chain;
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
