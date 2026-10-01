/* 主逻辑：相机取景 + 云台 BLE 连接 + 按键映射 + 键盘操作 + 屏幕调试面板 */
(function (root) {
  'use strict';

  var U = root.KaiUtil;
  var t = root.Strings.t;
  var UI = root.KaiUI;
  var bt = root.KaiBt;
  var cam = root.KaiCam;
  var Z = root.Zhiyun;

  /* 云台按键 → 动作。探针（tools/probe）确认 M2 实际字节后在此扩充 */
  var BUTTON_MAP = {
    0x20: 'shutter'
  };

  var APP_VERSION = 'v6';
  var GIMBAL_NAME_RE = /CRANE[-_ ]?M2/i;

  var state = {
    mode: 'picture',
    conn: null,
    client: null,
    stopScan: null,
    pollTimer: null,
    reconnectTimer: null,
    lastPollVal: null,
    gimbalBatt: null,
    rxCount: 0,
    recTimer: null,
    recSecs: 0,
    zoomRatios: [],
    zoomIdx: 0,
    ecList: [],
    ecNow: 0,
    debugOn: false,
    appLog: []
  };

  root.addEventListener('load', boot);
  /* KaiOS HAL 泄漏防护：退出/刷新前必须 release，否则相机将挂起直到重启 */
  root.addEventListener('unload', releaseHal);
  root.addEventListener('beforeunload', releaseHal);

  function releaseHal() {
    try { if (cam.control) cam.control.release(); } catch (e) { /* 已释放 */ }
  }

  /* 满屏：收复系统状态栏区域（240x294 → 240x320）。切回前台后需重新请求 */
  function goFullscreen() {
    try {
      if (document.mozFullScreenEnabled && !document.mozFullScreen &&
          document.documentElement.mozRequestFullScreen) {
        document.documentElement.mozRequestFullScreen();
      }
    } catch (e) { /* 不支持就维持普通布局 */ }
  }

  /* ---------- 调试面板（取景界面按 # 开关） ---------- */

  function dlog(msg) {
    state.appLog.push(fmtClock() + ' ' + msg);
    if (state.appLog.length > 60) state.appLog.shift();
    try { root.console.log('[app] ' + msg); } catch (e) { /* 无 console */ }
    renderDebug();
  }

  function renderDebug() {
    var el = U.byId('debug');
    if (!el) return;
    if (!state.debugOn) { el.textContent = ''; U.show('debug', false); return; }
    U.show('debug', true);
    var lines = cam.getLog().concat(state.appLog);
    el.textContent = lines.slice(-10).join('\n');
  }

  function fmtClock() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ---------- 启动 ---------- */

  function boot() {
    UI.init();
    goFullscreen();
    U.lockPortrait();
    setFinderKeys();
    UI.toast('ZY-KaiCam ' + APP_VERSION, 2500);
    UI.hud({ ble: t('camInit'), mode: t('modePhoto') });
    root.addEventListener('keydown', onKey);
    root.document.addEventListener('visibilitychange', onVis);
    probeAppIdentity();

    cam.init().then(function () {
      return cam.startPreview(U.byId('preview'));
    }).then(function () {
      dlog('✓ 相机就绪');
      setupZoomAndEc();
      renderHudParams();
      UI.hud({ ble: t('scan') });
      connectGimbal();
    }).catch(function (err) {
      dlog('✗ 相机初始化失败: ' + (err && err.message));
      UI.toast(cam.control ? t('previewFail') : t('camAllFail'), 5000);
      UI.hud({ ble: t('scan') });
      connectGimbal(); /* 相机失败不影响连云台 */
    });
  }

  /* App 身份与权限环境探测：确认是否 privileged、蓝牙/存储 API 是否可用 */
  function probeAppIdentity() {
    try {
      var m = root.navigator.mozApps;
      if (m && m.getSelf) {
        var req = m.getSelf();
        req.onsuccess = function () {
          var a = req.result;
          dlog('app type=' + (a && a.manifest ? a.manifest.type : '?') +
            ' origin=' + ((a && a.installOrigin) || '?'));
        };
        req.onerror = function () { dlog('app getSelf 失败'); };
      }
    } catch (e) { /* 无 mozApps */ }
    try {
      var ds = root.navigator.getDeviceStorage ? root.navigator.getDeviceStorage('pictures') : null;
      dlog('priv: storage=' + (ds ? 'ok' : 'null') +
        ' bt=' + (root.navigator.mozBluetooth ? 'ok' : 'null'));
    } catch (e) { /* 无 deviceStorage */ }
  }

  function retryCamera() {
    UI.toast(t('retrying'));
    dlog('手动重试相机(' + state.mode + ')…');
    if (cam.control) {
      try { cam.control.release(); } catch (e) { /* 继续 */ }
      cam.control = null;
    }
    cam.mode = state.mode;
    cam.init().then(function () {
      return cam.startPreview(U.byId('preview'));
    }).then(function () {
      dlog('✓ 相机重试成功');
      setupZoomAndEc();
      renderHudParams();
    }).catch(function (err) {
      dlog('✗ 相机重试失败: ' + (err && err.message));
      UI.toast(cam.control ? t('previewFail') : t('camAllFail'), 4000);
      renderDebug();
    });
  }

  /* ---------- 云台连接（扫描→连接→订阅，断线自动重连） ---------- */

  function connectGimbal() {
    bt.init().then(function () {
      dlog('BT: ' + bt.radioProbe());
      /* 状态检测失败不阻断——直接试扫描，扫描会给出真实错误 */
      return bt.ensureEnabled().catch(function (e) {
        dlog('BT 开启存疑仍尝试扫描: ' + e.message);
      });
    }).then(function () {
      dlog('扫描 ' + GIMBAL_NAME_RE);
      UI.hud({ ble: t('scan') });
      return waitForGimbal();
    }).then(function (dev) {
      dlog('发现云台 ' + dev.name + ' @' + dev.address);
      UI.hud({ ble: t('connecting') });
      return bt.connect(dev);
    }).then(function (con) {
      if (!con.writeChar || !con.notifyChar) {
        dlog('✗ fee9 特征不完整: write=' + !!con.writeChar + ' notify=' + !!con.notifyChar);
        UI.toast(t('gattPoor'), 4000);
        scheduleReconnect(8000);
        return;
      }
      dlog('✓ GATT 连接，服务 ' + con.services.length + ' 个');
      state.conn = con;
      state.rxCount = 0;
      state.client = new Z.Client(function (buf) { return bt.write(con, buf); }, {
        onFrame: onGimbalFrame,
        onButton: onGimbalButton
      });
      return bt.armNotifications(con, function (val) { state.client.feed(val); })
        .then(function (ni) {
          ni = ni || {};
          var s = 'notify: props=' + (typeof ni.props === 'number' ? '0x' + ni.props.toString(16) : '?') +
            ' descs=' + ni.descs + ' cccd=' + ni.cccd;
          if (ni.wrote) s += ' 写=' + ni.wrote;
          if (ni.note) s += ' (' + ni.note + ')';
          if (ni.startErr) s += ' startErr=' + ni.startErr;
          dlog(s);
        })
        .catch(function (e) { dlog('notify 检查异常(' + ((e && e.message) || e) + ')'); })
        .then(function () {
          startPolling();
          /* 首拍心跳单独发，记录写通道结果（周期性心跳的错误被静默） */
          state.client.heartbeat().then(function () {
            dlog('[OUT] 心跳 ok');
          }, function (e) {
            dlog('[OUT] 心跳失败: ' + ((e && (e.message || e.name)) || e));
          });
          state.client.startHeartbeat(1000);
          dlog('✓ 云台就绪(心跳1s)');
          UI.hud({ ble: t('connected') });
          UI.toast(t('connected'));
          /* 主动探测：照抄官方 App 帧形 + 官方初始化序列（0x02→0x04→0x05 等应答） */
          root.setTimeout(function () { sayHello(); }, 2000);
          root.setTimeout(function () { initSequence(); }, 3500);
        });
    }).catch(function (err) {
      dlog('✗ 云台连接失败: ' + (err && err.message));
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

  /* 通知特征大多没有 READ 属性；对它 readValue 会被 Gecko 直接拒绝
   * （ReadValue: BT_ENSURE_TRUE_REJECT(mProperties & GATT_CHAR_PROP_BIT_READ) failed），
   * 旧逻辑连错 4 次（约 400ms）就判"断线"→ 连接后必然立刻重连的死循环。
   * GATT_CHAR_PROP_BIT_READ = 0x02 */
  function canReadChar(ch) {
    try {
      if (typeof ch.properties === 'number') return (ch.properties & 0x02) !== 0;
    } catch (e) { /* 无 properties 属性 */ }
    return true; /* 拿不到属性时维持旧行为 */
  }

  /* 链路是否已断：connected / connectionState 两个口径都试（不同固件暴露不同） */
  function linkDown(gatt) {
    try { if (gatt.connected === false) return true; } catch (e) { /* 无该属性 */ }
    try {
      var s = gatt.connectionState;
      if (s === 'disconnected' || s === 0) return true;
    } catch (e) { /* 无该属性 */ }
    return false;
  }

  function startPolling() {
    stopPolling();
    state.lastPollVal = null;
    var canRead = canReadChar(state.conn.notifyChar);
    if (!canRead) dlog('通知特征不可读：跳过 POLL，接收靠 notify');
    var readErrs = 0;
    state.pollTimer = root.setInterval(function () {
      var con = state.conn;
      if (!con || !con.notifyChar) return;
      if (linkDown(con.gatt)) { onDisconnected('链路断开'); return; }
      if (!canRead) return;
      U.prom(con.notifyChar.readValue(), 'readValue').then(function () {
        readErrs = 0;
        var v = new Uint8Array(con.notifyChar.value || []);
        if (v.length && (!state.lastPollVal || !bytesEqual(state.lastPollVal, v))) {
          state.lastPollVal = new Uint8Array(v);
          state.client.feed(v);
        }
      }).catch(function () {
        /* 读失败不再直接断线；连着 2 次失败说明该特征根本不可读（本机不暴露 properties 位），关掉 POLL */
        if (linkDown(con.gatt)) { onDisconnected('链路断开'); return; }
        if (++readErrs >= 2) {
          stopPolling();
          dlog('POLL 关闭（特征不可读），接收靠 notify');
        }
      });
    }, 100);
  }

  function stopPolling() {
    if (state.pollTimer) { root.clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function onDisconnected(reason) {
    dlog('云台断线' + (reason ? '(' + reason + ')' : '') + '，3s 后重连');
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

  /* 官方帧形探测（见 Zhiyun.buildOfficialFrame）：照抄官方 App 的 app→gimbal 帧形与参数长度。
   * 我们的旧帧形（16 位序号 + TYPE）可能不被云台接受，这里是关键对照实验 */
  function probeOfficial(cmd, tag) {
    if (!state.conn) return;
    var frame = Z.buildOfficialFrame(cmd);
    bt.write(state.conn, frame.buffer).then(function () {
      dlog('[OUT] ' + tag + ' 官方帧 ' + U.hex(frame));
    }).catch(function (e) {
      dlog('[OUT] ' + tag + ' 失败: ' + ((e && (e.message || e.name)) || e));
    });
  }

  function askBattery() { probeOfficial(0x06, '电量查询'); }
  function sayHello() { probeOfficial(0x02, 'hello'); }

  /* 官方初始化序列（来自真机验证过的开源客户端 bleebil 的 init 代码：
   *   awaitResponse(0x02, 000000) → awaitResponse(0x04, 000000) → awaitResponse(0x05, 000000)
   * 每条等应答、最多重试 5 次——与"官方 App 连发 5 次才放弃"的抓包现象一致。
   * 之后顺带试几个查询命令。任何一次收到云台回包立即停止 */
  var INIT_SEQ = [
    [0x02, 5], [0x04, 5], [0x05, 5],
    [0x06, 2], [0x68, 1], [0x24, 1], [0x22, 1]
  ];
  function initSequence() {
    if (!state.conn) return;
    var i = 0, tries = 0;
    dlog('初始化序列: 0x02/0x04/0x05 各等应答最多 5 次');
    function next() {
      if (!state.conn) return;
      if (state.rxCount > 0) { dlog('初始化停止：已收到云台数据'); return; }
      if (i >= INIT_SEQ.length) { dlog('初始化序列跑完：仍无任何回包'); return; }
      var cmd = INIT_SEQ[i][0], max = INIT_SEQ[i][1];
      tries++;
      probeOfficial(cmd, '初始化 0x' + cmd.toString(16) + ' #' + tries);
      root.setTimeout(function () {
        if (state.rxCount > 0) { dlog('初始化停止：已收到云台数据'); return; }
        if (tries >= max) { i++; tries = 0; }
        next();
      }, 600);
    }
    next();
  }

  /* ---------- 云台事件 ---------- */

  function onGimbalFrame(f) {
    state.rxCount++;
    /* 抓字段：前 8 帧 + 之后每 25 帧打原始字节，确认云台实际发出什么 */
    if (state.rxCount <= 8 || state.rxCount % 25 === 0) {
      dlog('[IN#' + state.rxCount + '] ' + U.hex(f.raw) + ' cmd=0x' + f.cmd.toString(16) +
        (f.crcOk ? '' : ' CRC✗'));
    }
    if (!f.crcOk) return;
    /* 心跳/状态帧 payload 首字节常为电量（0-100），探针确认后可精修 */
    if (f.cmd === 0x80 && f.payload.length >= 1 && f.payload[0] <= 100) {
      state.gimbalBatt = f.payload[0];
      renderHudParams();
    }
  }

  function onGimbalButton(f) {
    dlog('云台按键 cmd=0x20 payload=' + U.hex(f.payload));
    var action = BUTTON_MAP[f.cmd] || 'shutter';
    if (action === 'shutter') shutter();
    else if (action === 'mode') switchMode();
  }

  /* ---------- 快门 ---------- */

  function shutter() {
    U.lockPortrait();
    if (state.mode === 'picture') takePhoto();
    else toggleRecord();
  }

  function takePhoto() {
    if (!cam.control || cam.recording) return;
    UI.flash();
    cam.takePicture().then(function (blob) {
      return cam.saveBlob(blob, 'pictures', cam.photoFilename());
    }).then(function () {
      dlog('✓ 照片已存 ' + cam.photoFilename());
      UI.toast(t('saved'));
    }).catch(function (err) {
      dlog('✗ 拍照/保存: ' + (err && err.message));
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
        dlog('✗ 录像: ' + (err && err.message));
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
    dlog('切换模式 → ' + target);
    cam.switchMode(target, U.byId('preview')).then(function () {
      dlog('✓ 模式已切换');
      setupZoomAndEc();
      renderHudParams();
    }).catch(function (err) {
      dlog('✗ 切换失败: ' + (err && err.message));
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
      zoom: ((state.zoomRatios.length > 1 ? ('×' + state.zoomRatios[state.zoomIdx]) : '') + ' ' + APP_VERSION).trim()
    });
  }

  /* ---------- 参数菜单 ---------- */

  function openMenu() {
    if (!cam.control) { UI.toast(t('camAllFail')); return; }
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
      if (UI.menuActive()) { closeMenu(); }
      else { exitApp(); }
      return;
    }
    if (k === '#') {
      state.debugOn = !state.debugOn;
      renderDebug();
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
      case '0': askBattery(); break;
      case '5': sayHello(); break;
      case '9': retryCamera(); break;
    }
  }

  /* 取景界面按返回键退出应用 */
  function exitApp() {
    stopPolling();
    if (state.client) state.client.stopHeartbeat();
    if (state.conn) bt.disconnect(state.conn);
    if (cam.recording) { cam.stopRecording(); stopRecTimer(); }
    try { root.close(); } catch (e) { /* 非脚本可关时忽略 */ }
    root.setTimeout(function () {
      try { root.close(); } catch (e) { /* 二次尝试 */ }
    }, 250);
  }

  function onVis() {
    if (root.document.hidden) {
      if (cam.recording) {
        cam.stopRecording();
        stopRecTimer();
        UI.hud({ rec: '' });
      }
      cam.stopPreview();
    } else {
      goFullscreen();
      U.lockPortrait();
      if (cam.control) {
        cam.startPreview(U.byId('preview')).catch(function () {});
      }
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
