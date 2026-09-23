/* 主逻辑：相机取景 + 云台 BLE 连接 + 按键映射 + 键盘操作 */
(function (root) {
  'use strict';

  var U = root.KaiUtil;
  var t = root.Strings.t;
  var UI = root.KaiUI;
  var bt = root.KaiBt;
  var cam = root.KaiCam;
  var Z = root.Zhiyun;

  /* 云台按键 → 动作。探针（tools/probe）确认 M2 实际字节后在此扩充，
   * 例如模式键若是独立 cmd，可加一行 '0x??: mode'。 */
  var BUTTON_MAP = {
    0x20: 'shutter'
  };

  var GIMBAL_NAME_RE = /CRANE[-_ ]?M2/i;

  var state = {
    mode: 'picture',
    conn: null,
    client: null,
    stopScan: null,
    pollTimer: null,
    reconnectTimer: null,
    lastPollVal: null,
    pollErr: 0,
    gimbalBatt: null,
    recTimer: null,
    recSecs: 0,
    zoomRatios: [],
    zoomIdx: 0,
    ecList: [],
    ecNow: 0
  };

  root.addEventListener('load', boot);

  function boot() {
    UI.init();
    setFinderKeys();
    UI.hud({ ble: t('camInit'), mode: t('modePhoto') });
    root.addEventListener('keydown', onKey);
    root.document.addEventListener('visibilitychange', onVis);

    cam.init().then(function () {
      return cam.startPreview(U.byId('preview'));
    }).then(function () {
      setupZoomAndEc();
      renderHudParams();
      UI.hud({ ble: t('scan') });
      connectGimbal();
    }).catch(function (err) {
      UI.toast(err.message || t('camFail'), 4000);
      UI.hud({ param: t('camFail'), ble: t('scan') });
      connectGimbal(); /* 相机失败不影响连云台探路 */
    });
  }

  /* ---------- 云台连接（扫描→连接→订阅，断线自动重连） ---------- */

  function connectGimbal() {
    bt.init().then(function () {
      return bt.ensureEnabled();
    }).then(function () {
      return waitForGimbal();
    }).then(function (dev) {
      UI.hud({ ble: t('connecting') });
      return bt.connect(dev);
    }).then(function (con) {
      if (!con.writeChar || !con.notifyChar) {
        UI.toast(t('gattPoor'), 4000);
        scheduleReconnect(8000);
        return;
      }
      state.conn = con;
      state.client = new Z.Client(function (buf) { return bt.write(con, buf); }, {
        onFrame: onGimbalFrame,
        onButton: onGimbalButton
      });
      return bt.armNotifications(con, function (val) { state.client.feed(val); })
        .catch(function () { /* 实机不支持通知时靠轮询 */ })
        .then(function () {
          startPolling();
          state.client.startHeartbeat(1000);
          UI.hud({ ble: t('connected') });
          UI.toast(t('connected'));
        });
    }).catch(function (err) {
      UI.hud({ ble: 'BT ✗' });
      UI.toast(err.message || t('btFail'), 3000);
      scheduleReconnect(6000);
    });
  }

  function waitForGimbal() {
    return new Promise(function (resolve, reject) {
      var found = false;
      bt.startScan(function (dev) {
        if (found || !GIMBAL_NAME_RE.test(dev.name)) return;
        found = true;
        if (state.stopScan) state.stopScan();
        resolve(dev);
      }).then(function (h) {
        state.stopScan = h.stop;
        if (found) h.stop();
      }).catch(reject);
    });
  }

  function startPolling() {
    stopPolling();
    state.lastPollVal = null;
    state.pollErr = 0;
    state.pollTimer = root.setInterval(function () {
      var con = state.conn;
      if (!con || !con.notifyChar) return;
      if (con.gatt.connected === false) { onDisconnected(); return; }
      U.prom(con.notifyChar.readValue(), 'readValue').then(function () {
        var v = new Uint8Array(con.notifyChar.value || []);
        state.pollErr = 0;
        if (v.length && (!state.lastPollVal || !bytesEqual(state.lastPollVal, v))) {
          state.lastPollVal = new Uint8Array(v);
          state.client.feed(v);
        }
      }).catch(function () {
        if (++state.pollErr >= 4) onDisconnected();
      });
    }, 100);
  }

  function stopPolling() {
    if (state.pollTimer) { root.clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function onDisconnected() {
    stopPolling();
    if (state.client) state.client.stopHeartbeat();
    bt.disconnect(state.conn);
    state.conn = null;
    state.client = null;
    state.gimbalBatt = null;
    UI.hud({ ble: t('disconnected') });
    scheduleReconnect(3000);
  }

  function scheduleReconnect(ms) {
    root.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = root.setTimeout(connectGimbal, ms || 5000);
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* ---------- 云台事件 ---------- */

  function onGimbalFrame(f) {
    if (!f.crcOk) return;
    /* 心跳/状态帧 payload 首字节常为电量（0-100），探针确认后可精修 */
    if (f.cmd === 0x80 && f.payload.length >= 1 && f.payload[0] <= 100) {
      state.gimbalBatt = f.payload[0];
      renderHudParams();
    }
  }

  function onGimbalButton(f) {
    var action = BUTTON_MAP[f.cmd] || 'shutter';
    if (action === 'shutter') shutter();
    else if (action === 'mode') switchMode();
  }

  /* ---------- 快门 ---------- */

  function shutter() {
    if (state.mode === 'picture') takePhoto();
    else toggleRecord();
  }

  function takePhoto() {
    if (!cam.control || cam.recording) return;
    UI.flash();
    cam.takePicture().then(function (blob) {
      return cam.saveBlob(blob, 'pictures', cam.photoFilename());
    }).then(function () {
      UI.toast(t('saved'));
    }).catch(function (err) {
      UI.toast(err.message || t('saveFail'), 2500);
    });
  }

  function toggleRecord() {
    if (!cam.control) return;
    if (!cam.recording) {
      cam.startRecording().then(function () {
        state.recSecs = 0;
        UI.hud({ rec: '● REC 00:00' });
        state.recTimer = root.setInterval(function () {
          state.recSecs++;
          UI.hud({ rec: '● REC ' + fmtTime(state.recSecs) });
        }, 1000);
      }).catch(function (err) {
        UI.toast(err.message || t('recFail'));
      });
    } else {
      cam.stopRecording();
      stopRecTimer();
      UI.hud({ rec: '' });
      UI.toast(t('saved'), 1200);
    }
  }

  function stopRecTimer() {
    if (state.recTimer) { root.clearInterval(state.recTimer); state.recTimer = null; }
  }

  function fmtTime(s) {
    var m = Math.floor(s / 60);
    var r = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }

  /* ---------- 模式切换 / 变焦 / 曝光补偿 ---------- */

  function switchMode() {
    if (cam.recording) { UI.toast(t('recording')); return; }
    var target = (state.mode === 'picture') ? 'video' : 'picture';
    var prev = state.mode;
    state.mode = target;
    cam.mode = target;
    UI.hud({ mode: target === 'video' ? t('modeVideo') : t('modePhoto') });
    cam.switchMode(target, U.byId('preview')).then(function () {
      setupZoomAndEc();
      renderHudParams();
    }).catch(function () {
      /* 视频模式打不开时回退拍照模式 */
      state.mode = prev;
      cam.mode = prev;
      UI.hud({ mode: prev === 'video' ? t('modeVideo') : t('modePhoto') });
      cam.switchMode(prev, U.byId('preview')).catch(function () {});
      UI.toast(t('switchFail'));
    });
  }

  function setupZoomAndEc() {
    var caps = cam.capabilities();
    state.zoomRatios = caps.zoomRatios || [];
    state.zoomIdx = 0;
    if (state.zoomRatios.length) {
      var best = 0, bd = Infinity;
      state.zoomRatios.forEach(function (r, i) {
        var d = Math.abs(Number(r) - 1);
        if (d < bd) { bd = d; best = i; }
      });
      state.zoomIdx = best;
    }
    state.ecList = [];
    if (caps.ecMax > caps.ecMin) {
      var step = caps.ecStep || 1;
      for (var v = caps.ecMin; v <= caps.ecMax + 1e-9; v += step) {
        state.ecList.push(Math.round(v * 100) / 100);
      }
      state.ecNow = 0;
    }
  }

  function zoomStep(d) {
    if (state.zoomRatios.length < 2) { UI.toast(t('zoom') + ': N/A'); return; }
    state.zoomIdx = Math.min(state.zoomRatios.length - 1, Math.max(0, state.zoomIdx + d));
    var r = state.zoomRatios[state.zoomIdx];
    cam.setParam('zoom', r);
    renderHudParams();
  }

  function ecStep(d) {
    if (!state.ecList.length) { UI.toast(t('pEc') + ': N/A'); return; }
    var idx = state.ecList.indexOf(state.ecNow);
    if (idx === -1) idx = state.ecList.indexOf(0);
    if (idx === -1) idx = 0;
    idx = Math.min(state.ecList.length - 1, Math.max(0, idx + d));
    state.ecNow = state.ecList[idx];
    cam.setParam('ec', state.ecNow);
    renderHudParams();
  }

  function cycleQuickParam(key) {
    var caps = cam.capabilities();
    var list = (key === 'whiteBalance') ? caps.whiteBalanceModes : caps.isoModes;
    if (!list || list.length < 2) return;
    var cur = cam.getParam(key);
    var idx = list.indexOf(cur);
    idx = (idx === -1) ? 0 : (idx + 1) % list.length;
    cam.setParam(key, list[idx]);
    renderHudParams();
  }

  function renderHudParams() {
    var caps = cam.capabilities();
    var parts = [];
    if (caps.whiteBalanceModes.length) {
      var wb = cam.getParam('whiteBalance');
      if (wb !== undefined && wb !== null) parts.push('WB:' + wb);
    }
    if (caps.isoModes.length) {
      var iso = cam.getParam('iso');
      if (iso !== undefined && iso !== null) parts.push('ISO:' + iso);
    }
    if (state.ecList.length) {
      parts.push('EC:' + (state.ecNow > 0 ? '+' : '') + state.ecNow);
    }
    if (state.gimbalBatt !== null) parts.push(t('gimbalBatt') + ' ' + state.gimbalBatt + '%');
    UI.hud({
      param: parts.join('  '),
      zoom: state.zoomRatios.length > 1 ? ('×' + state.zoomRatios[state.zoomIdx]) : ''
    });
  }

  /* ---------- 参数菜单 ---------- */

  function openMenu() {
    if (!cam.control) { UI.toast(t('camFail')); return; }
    var caps = cam.capabilities();
    var items = [];

    function addCycle(labelKey, values, paramKey) {
      if (!values || !values.length) return;
      var item = {
        label: t(labelKey),
        valueText: textOf(cam.getParam(paramKey)),
        cycle: function (d) {
          var cur = cam.getParam(paramKey);
          var idx = values.indexOf(cur);
          idx = (idx === -1) ? 0 : (idx + d + values.length) % values.length;
          cam.setParam(paramKey, values[idx]);
          item.valueText = textOf(values[idx]);
          UI.refreshMenu();
        }
      };
      items.push(item);
    }

    function textOf(v) {
      if (v === undefined || v === null || v === '') return '-';
      if (v.width) return v.width + '×' + v.height;
      return String(v);
    }

    addCycle('pWhiteBalance', caps.whiteBalanceModes, 'whiteBalance');
    addCycle('pIso', caps.isoModes, 'iso');
    addCycle('pScene', caps.sceneModes, 'scene');
    addCycle('pEffect', caps.effects, 'effect');
    addCycle('pFlash', caps.flashModes, 'flash');
    addCycle('pFocus', caps.focusModes, 'focus');
    addCycle('pProfile', caps.recorderProfiles, 'recorderProfile');
    if (caps.pictureSizes.length) {
      var sizes = caps.pictureSizes;
      var item = {
        label: t('pSize'),
        valueText: textOf(cam.getParam('pictureSize')),
        cycle: function (d) {
          var cur = cam.getParam('pictureSize');
          var curStr = textOf(cur);
          var idx = 0;
          for (var i = 0; i < sizes.length; i++) {
            if (sizes[i].width + '×' + sizes[i].height === curStr) { idx = i; break; }
          }
          idx = (idx + d + sizes.length) % sizes.length;
          cam.setParam('pictureSize', sizes[idx]);
          item.valueText = textOf(sizes[idx]);
          UI.refreshMenu();
        }
      };
      items.push(item);
    }
    if (state.ecList.length) {
      var ecItem = {
        label: t('pEc'),
        valueText: (state.ecNow > 0 ? '+' : '') + state.ecNow,
        cycle: function (d) {
          var idx = state.ecList.indexOf(state.ecNow);
          if (idx === -1) idx = state.ecList.indexOf(0);
          if (idx === -1) idx = 0;
          idx = (idx + d + state.ecList.length) % state.ecList.length;
          state.ecNow = state.ecList[idx];
          cam.setParam('ec', state.ecNow);
          ecItem.valueText = (state.ecNow > 0 ? '+' : '') + state.ecNow;
          UI.refreshMenu();
        }
      };
      items.push(ecItem);
    }
    if (!items.length) items.push({ label: t('noParams'), valueText: '' });

    UI.openMenu(items);
    UI.setSoftkeys(t('skBack'), 'OK', t('skMode'));
  }

  function closeMenu() {
    UI.closeMenu();
    setFinderKeys();
    renderHudParams();
  }

  /* ---------- 按键 ---------- */

  function setFinderKeys() {
    UI.setSoftkeys(t('skParams'), t('skShutter'), t('skMode'));
  }

  function onKey(e) {
    var k = e.key;
    if (k === 'Backspace') {
      e.preventDefault();
      if (UI.menuActive()) closeMenu();
      return;
    }
    if (UI.menuActive()) {
      if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
        UI.menuKey(k);
        e.preventDefault();
        return;
      }
      if (k === 'Enter' || k === 'SoftLeft') { closeMenu(); return; }
      if (k === 'SoftRight') { switchMode(); return; }
      return;
    }
    switch (k) {
      case 'SoftLeft': openMenu(); break;
      case 'SoftRight': switchMode(); break;
      case 'Enter': shutter(); break;
      case 'ArrowUp': case '2': zoomStep(1); e.preventDefault(); break;
      case 'ArrowDown': case '8': zoomStep(-1); e.preventDefault(); break;
      case 'ArrowLeft': case '4': ecStep(-1); e.preventDefault(); break;
      case 'ArrowRight': case '6': ecStep(1); e.preventDefault(); break;
      case '1': cycleQuickParam('whiteBalance'); break;
      case '3': cycleQuickParam('iso'); break;
    }
  }

  function onVis() {
    if (root.document.hidden) {
      if (cam.recording) {
        cam.stopRecording();
        stopRecTimer();
        UI.hud({ rec: '' });
      }
      cam.stopPreview();
    } else if (cam.control) {
      cam.startPreview(U.byId('preview')).catch(function () {});
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
