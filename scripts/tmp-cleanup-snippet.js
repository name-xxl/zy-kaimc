(function () {
  var out = [];
  var keys = ['__fakeDiag', '__fakeDiag2', '__fakeDiag3', '__fakeDiag4'];
  keys.forEach(function (k) {
    var D = window[k];
    if (!D) return;
    try {
      if (D.conn && D.conn.gatt) { D.conn.gatt.disconnect(); out.push(k + ':disconnected'); }
    } catch (e) { out.push(k + ':disc-err'); }
    try {
      if (D.handle) {
        if (typeof D.handle.stop === 'function') D.handle.stop();
        else if (window.KaiBt && window.KaiBt.adapter) window.KaiBt.adapter.stopLeScan(D.handle);
        out.push(k + ':scan-stopped');
      }
    } catch (e) { out.push(k + ':scan-err'); }
    D.conn = null;
    D.handle = null;
    D.stage = 'cleaned';
  });
  try {
    if (window.KaiBt && window.KaiBt.adapter && window.KaiBt.adapter.stopLeScan) {
      window.KaiBt.adapter.stopLeScan();
      out.push('adapter:stopLeScan-called');
    }
  } catch (e) { out.push('adapter:stop-err'); }
  return out.join(' | ') || 'nothing-to-clean';
})()
