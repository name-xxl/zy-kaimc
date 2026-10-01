/* 主逻辑：相机取景 + 云台 BLE 连接 + 按键映射 + 键盘操作 + 屏幕调试面板 */
(function (root) {
  'use strict';

  var U = root.KaiUtil;
  var t = root.Strings.t;
  var UI = root.KaiUI;
  var bt = root.KaiBt;
  var cam = root.KaiCam;
  var Z = root.Zhiyun;

  /* 云台按键上报 → 动作（2026-10-01 真机实测键码，与 M2 说明书一致）：
   *   0x3D = 拍照/录像键【单击】→ 录像起停（App 里随当前模式=拍照/录像）
   *   0x3C = 拍照/录像键【双击】→ 拍照（官方协议里 App 让云台拍照用的就是 C0 3C 00）
   *   变焦杆（左侧）：T 上推 = 0x18 按 / 0x28 松；W 下推 = 0x17 按 / 0x27 松
   *     → 按住连续变焦、松开即停（短拨一下也至少走一档）
   *   M 键（模式）、扳机键实测不上报 BLE（纯本地动作）→ 无事件可映射 */
  var BUTTON_MAP = {
    0x3D: 'shutter',
    0x3C: 'photo',
    0x18: 'zoom-in',
    0x17: 'zoom-out',
    0x28: 'zoom-stop',
    0x27: 'zoom-stop'
  };
  var ZOOM_HOLD_MS = 180;

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
    zoomHoldTimer: null,
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
          dlog('✓ 云台就绪（官方 App 不发心跳，已停用；按键靠 notify 上报）');
          UI.hud({ ble: t('connected') });
          UI.toast(t('connected'));
          /* 官方初始化：抓包显示官方 App 在写完 CCCD 后 5ms 内就发第一条，这里不再延迟 */
          runOfficialInit();
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

  /* 链路是否已断：connected / connectionState 两个口径都试（不同固件暴露不同） */
  function linkDown(gatt) {
    try { if (gatt.connected === false) return true; } catch (e) { /* 无该属性 */ }
    try {
      var s = gatt.connectionState;
      if (s === 'disconnected' || s === 0) return true;
    } catch (e) { /* 无该属性 */ }
    return false;
  }

  /* 接收靠"轮询 .value"——2026-10-01 真机实测（假云台对照实验）：
   * 1) startNotifications() 不写 CCCD，也不会派发任何 JS 事件；
   * 2) 手动写 CCCD 0x2902=0001 后云台会推送，通知值确实同步进特征对象的 .value（本地缓存）；
   * 3) 但 oncharacteristicchanged / addEventListener 永远不触发。
   * 所以：轮询 .value（本地读、无 ATT 往返）→ 差分 → 喂协议层。实测 1s 内必到，100ms 轮询足够 */
  function startPolling() {
    stopPolling();
    state.lastPollVal = null;
    state.pollTimer = root.setInterval(function () {
      var con = state.conn;
      if (!con || !con.notifyChar) return;
      if (linkDown(con.gatt)) { onDisconnected('链路断开'); return; }
      var v;
      try { v = new Uint8Array(con.notifyChar.value || []); } catch (e) { return; }
      if (!v.length) return;
      if (state.lastPollVal && bytesEqual(state.lastPollVal, v)) return;
      state.lastPollVal = v;
      state.client.feed(v);
    }, 100);
  }

  function stopPolling() {
    if (state.pollTimer) { root.clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function onDisconnected(reason) {
    dlog('云台断线' + (reason ? '(' + reason + ')' : '') + '，3s 后重连');
    stopPolling();
    zoomHoldStop();
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
  function probeOfficial(cmd, tag) { sendCmd(cmd, [0x00, 0x00, 0x00], tag); }

  function sendCmd(cmd, args, tag) {
    if (!state.conn) return;
    var frame = Z.buildOfficialFrame(cmd, args);
    bt.write(state.conn, frame.buffer).then(function () {
      dlog('[OUT] ' + tag + ' ' + U.hex(frame));
    }, function (e) {
      dlog('[OUT] ' + tag + ' 失败: ' + ((e && (e.message || e.name)) || e));
    });
  }

  /* 可见写入测试：ZY Play 抓包里的运动指令（cmd 0x01/0x02/0x03 + 参数 10 xx xx）。
   * 按 7 连发 6 轮：云台应出现可见转动 → 证明我们的写入真的到达云台（而非只在本地"成功"） */
  var MOTION_FRAMES = [
    [0x01, [0x10, 0xD4, 0x0E]],
    [0x02, [0x10, 0x00, 0x08]],
    [0x03, [0x10, 0xD4, 0x0E]]
  ];
  function motionTest() {
    if (!state.conn) { dlog('未连接，无法做可见测试'); return; }
    var round = 0;
    dlog('可见测试开始：看云台会不会动（共 6 轮）');
    var timer = root.setInterval(function () {
      if (!state.conn || round >= 6) {
        root.clearInterval(timer);
        dlog('可见测试结束：云台动了=我们的写入有效；没动=写没出去');
        return;
      }
      MOTION_FRAMES.forEach(function (mf) { sendCmd(mf[0], mf[1], '运动 0x' + mf[0].toString(16)); });
      round++;
    }, 200);
  }

  function askBattery() { probeOfficial(0x06, '电量查询'); }
  function sayHello() { probeOfficial(0x02, 'hello'); }

  /* 官方初始化序列 —— 2026-10-01 ZY Play 抓包实锤（logs/zyplay-cap1.txt）：
   *   0x04 连发最多 3 次直到云台应答 → 读序列号 0x7C/0x7D/0x7E/0x7F →
   *   固定帧 FMT 0x1818 → 0x06 电量。每条等应答，超时重试；跑完后云台才会
   *   以 notify 主动上报按键（cmd 0x20 / 参数 C0 xx 00） */
  var INIT_1818 = [0x24, 0x3C, 0x05, 0x00, 0x18, 0x18, 0x09, 0x00, 0x01, 0xA3, 0x16];
  /* 时序对齐官方 App（抓包：写完 CCCD 后 ~5ms 就发第一条，后续命令间隔 ~100ms） */
  var OFFICIAL_INIT = [
    { cmd: 0x04, wait: 150, tries: 3 },
    { cmd: 0x7C, wait: 100, tries: 1 },
    { cmd: 0x7D, wait: 100, tries: 1 },
    { cmd: 0x7E, wait: 100, tries: 1 },
    { cmd: 0x7F, wait: 100, tries: 1 },
    { raw: INIT_1818, tag: '0x1818', wait: 100, tries: 1 },
    { cmd: 0x06, wait: 100, tries: 2 }
  ];

  function sendRawFrame(bytes, tag) {
    if (!state.conn) return;
    var u8 = new Uint8Array(bytes);
    bt.write(state.conn, u8.buffer).then(function () {
      dlog('[OUT] ' + tag + ' ' + U.hex(u8));
    }, function (e) {
      dlog('[OUT] ' + tag + ' 失败: ' + ((e && (e.message || e.name)) || e));
    });
  }

  function runOfficialInit() {
    if (!state.conn) return;
    var i = 0, tries = 0;
    var start = state.rxCount;
    dlog('官方初始化: 0x04 → 0x7C-0x7F → 0x1818 → 0x06');
    function step() {
      if (!state.conn) return;
      if (i >= OFFICIAL_INIT.length) {
        dlog('初始化完成（收到 ' + (state.rxCount - start) + ' 个回包）');
        return;
      }
      var it = OFFICIAL_INIT[i];
      tries++;
      var seen = state.rxCount;
      if (it.raw) sendRawFrame(it.raw, '初始化 ' + it.tag + ' #' + tries);
      else probeOfficial(it.cmd, '初始化 0x' + it.cmd.toString(16) + ' #' + tries);
      root.setTimeout(function () {
        if (!state.conn) return;
        if (state.rxCount > seen) { i++; tries = 0; }       /* 有应答 → 下一条 */
        else if (tries >= it.tries) { i++; tries = 0; }     /* 试满无应答 → 跳过 */
        step();
      }, it.wait);
    }
    step();
  }

  /* ---------- 云台事件 ---------- */

  function onGimbalFrame(f) {
    state.rxCount++;
    /* 抓字段：前 14 帧 + 之后每 10 帧打原始字节（含初始化应答与按键帧） */
    if (state.rxCount <= 14 || state.rxCount % 10 === 0) {
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
    /* 键码在 payload 第二字节（格式 C0 <码> 00）；未登记的键码只记日志不动作 */
    var code = (f.payload && f.payload.length >= 2 && f.payload[0] === 0xC0) ? f.payload[1] : null;
    dlog('云台按键 code=' + (code === null ? '??' : '0x' + code.toString(16)) + ' payload=' + U.hex(f.payload));
    var action = code === null ? null : BUTTON_MAP[code];
    if (action === 'shutter') shutter();
    else if (action === 'photo') takePhoto();
    else if (action === 'zoom-in') zoomHoldStart(1);
    else if (action === 'zoom-out') zoomHoldStart(-1);
    else if (action === 'zoom-stop') zoomHoldStop();
    else if (action === 'mode') switchMode();
  }

  /* 连续变焦：按下启动（先立即走一档，再按周期）；松开即停；到顶/到底自动停 */
  function zoomHoldStart(dir) {
    zoomHoldStop();
    zoomStep(dir);
    state.zoomHoldTimer = root.setInterval(function () {
      var before = state.zoomIdx;
      zoomStep(dir);
      if (state.zoomIdx === before) zoomHoldStop();
    }, ZOOM_HOLD_MS);
  }

  function zoomHoldStop() {
    if (state.zoomHoldTimer) { root.clearInterval(state.zoomHoldTimer); state.zoomHoldTimer = null; }
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
      case '7': motionTest(); break;
      case '9': retryCamera(); break;
    }
  }

  /* 取景界面按返回键退出应用 */
  function exitApp() {
    stopPolling();
    zoomHoldStop();
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
