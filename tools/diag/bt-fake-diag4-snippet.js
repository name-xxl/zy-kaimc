(function () {
  if (window.__fakeDiag4 && window.__fakeDiag4.stage === 'running') return 'already-running';
  var D = window.__fakeDiag4 = { stage: 'running', log: [], rx: [], vals: [] };
  function L(m) { D.log.push(String(m)); }
  var bt = window.KaiBt, U = window.KaiUtil;
  if (!bt || !U) { L('FAIL modules missing'); D.stage = 'done'; return 'fired'; }

  bt.init().then(function () {
    L('adapter ok');
    return bt.startScan(function (dev) {
      if (D.dev) return;
      if (/FAKE|CRANE|M2/i.test(dev.name || '')) { D.dev = dev; L('PICK ' + dev.name); }
      else if (/CRANE/i.test(dev.name || '')) { D.anyDev = dev; }
    });
  }).then(function (h) {
    return new Promise(function (res) { setTimeout(function () { try { h.stop(); } catch (e) {} res(); }, 10000); });
  }).then(function () {
    var dev = D.dev || D.anyDev;
    if (!dev) { L('FAIL no device'); D.stage = 'done'; return; }
    L('connect ' + (dev.name || '?') + ' @' + dev.address);
    return bt.connect(dev).then(function (con) {
      D.conn = con;
      var ch = con.notifyChar;
      var cccd = null;
      try {
        (ch.descriptors || []).forEach(function (d) {
          if (String(d.uuid || '').toLowerCase().indexOf('2902') !== -1) cccd = d;
        });
      } catch (e) { /* none */ }
      L('connected svcs=' + con.services.length + ' cccd=' + !!cccd);
      try { con.gatt.oncharacteristicchanged = function (e) { if (e && e.value) { D.rx.push(U.hex(new Uint8Array(e.value))); L('EVT ' + U.hex(new Uint8Array(e.value))); } }; } catch (e) {}
      var chain = Promise.resolve();
      if (cccd) {
        chain = chain.then(function () {
          return U.prom(cccd.writeValue(new Uint8Array([1, 0]).buffer), 'cccd.write').then(
            function () { L('CCCD write RESOLVED'); },
            function (e) { L('CCCD write REJECTED ' + ((e && (e.message || e.name)) || e)); });
        });
      }
      return chain.then(function () {
        L('poll .value every 1s for 16s');
        var n = 0;
        return new Promise(function (res) {
          var timer = setInterval(function () {
            n++;
            var v = '';
            try { v = U.hex(new Uint8Array(ch.value || [])); } catch (e) { v = 'err'; }
            D.vals.push(n + ':' + v);
            if (n >= 16) { clearInterval(timer); res(); }
          }, 1000);
        });
      });
    });
  }).then(function () {
    L('DONE rxCount=' + D.rx.length + ' vals=' + D.vals.join(' | '));
    D.stage = 'done';
  }).catch(function (e) {
    L('FAIL ' + ((e && (e.message || e.name)) || e));
    D.stage = 'done';
  });
  return 'fired';
})()
