/* 主逻辑：相机取景 + 云台 BLE 连接 + 按键映射 + 键盘操作 + 屏幕调试面板 */
(function (root) {
  'use strict';

  var U = root.KaiUtil;
  var t = root.Strings.t;
  var tval = root.Strings.val;   /* 相机 HAL 取值汉化（auto→自动 等） */
  var UI = root.KaiUI;
  var bt = root.KaiBt;
  var cam = root.KaiCam;
  var AppCfg = root.AppCfg;
  var Buttons = root.KaiButtons;
  var Session = root.KaiSession;

  /* 本文件只做编排：相机 + UI/键位 + 云台会话(KaiSession) + 按键分发(KaiButtons)。
   * 键码与时序常量见 config.js（AppCfg.KEY / AppCfg.*_MS） */

  var APP_VERSION = 'v7.7';
  var GIMBAL_NAME_RE = /CRANE[-_ ]?M2/i;

  var state = {
    mode: 'picture',
    stopScan: null,
    reconnectTimer: null,
    reconnectStep: 0,
    cdTimer: null,
    gimbalBatt: null,
    gimbalBattRaw: null,
    gimbalMode: null,
    gimbalConnected: false,
    bleText: '',
    battTimer: null,
    modeTimer: null,
    rxCount: 0,
    recTimer: null,
    recSecs: 0,
    zoomRatios: [],
    zoomIdx: 0,
    zoomHoldTimer: null,
    ecList: [],
    ecNow: 0,
    debugOn: false,
    debugScroll: 0,
    appLog: []
  };

  /* 把动作注入按键分发层（依赖倒置：buttons.js 只认动作名，不依赖本文件） */
  Buttons.bind({
    shutter: shutter,
    photo: takePhoto,
    zoomStart: zoomHoldStart,
    zoomStop: zoomHoldStop,
    mode: switchMode
  });

  root.addEventListener('load', boot);
  /* KaiOS HAL 泄漏防护：退出/刷新前必须 release，否则相机将挂起直到重启 */
  root.addEventListener('unload', releaseHal);
  root.addEventListener('beforeunload', releaseHal);

  function releaseHal() {
    try { if (cam.control) cam.control.release(); } catch (e) { /* 已释放 */ }
  }

  /* 满屏：manifest 已声明 "fullscreen": "true"（启动即全屏、状态栏不出现、不受息屏影响）；
   * 这里只做兜底重请求——JS Fullscreen API 在息屏（有锁屏）或合盖后会失效（240x294 → 240x320） */
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

  /* 调试面板：只显示最近 DEBUG_PAGE 条，**最新的在最上面**（240×320 装不下 10 行，
   * 之前最新的日志被 max-height 裁掉）；面板打开时 ↑ 往旧翻、↓ 往回翻 */
  var DEBUG_PAGE = 7;

  function debugMaxScroll(total) {
    return Math.max(0, Math.ceil(total / DEBUG_PAGE) - 1);
  }

  function renderDebug() {
    var el = U.byId('debug');
    if (!el) return;
    if (!state.debugOn) { el.textContent = ''; U.show('debug', false); return; }
    U.show('debug', true);
    var lines = cam.getLog().concat(state.appLog);
    var off = Math.min(state.debugScroll || 0, debugMaxScroll(lines.length));
    state.debugScroll = off;
    var end = Math.max(0, lines.length - off * DEBUG_PAGE);
    var start = Math.max(0, end - DEBUG_PAGE);
    var head = '# 日志' + (off ? ' -' + off + '页' : '') + '（↑旧 ↓新 #关）';
    el.textContent = head + '\n' + lines.slice(start, end).reverse().join('\n');
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
    setHudBle(t('camInit'));
    UI.hud({ mode: t('modePhoto') });
    root.addEventListener('keydown', onKey);
    root.document.addEventListener('visibilitychange', onVis);
    probeAppIdentity();

    cam.init().then(function () {
      return cam.startPreview(U.byId('preview'));
    }).then(function () {
      dlog('✓ 相机就绪');
      setupZoomAndEc();
      renderHudParams();
      setHudBle(t('scan'));
      connectGimbal();
    }).catch(function (err) {
      dlog('✗ 相机初始化失败: ' + (err && err.message));
      UI.toast(cam.control ? t('previewFail') : t('camAllFail'), 5000);
      setHudBle(t('scan'));
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

  /* ---------- 云台连接（连接/订阅/初始化/接收 都交给 KaiSession，这里只做编排与重连） ---------- */

  var session = null;

  function connectGimbal() {
    bt.init().then(function () {
      dlog('BT: ' + bt.radioProbe());
      /* 状态检测失败不阻断——直接试扫描，扫描会给出真实错误 */
      return bt.ensureEnabled().catch(function (e) {
        dlog('BT 开启存疑仍尝试扫描: ' + e.message);
      });
    }).then(function () {
      dlog('扫描 ' + GIMBAL_NAME_RE);
      setHudBle(t('scan'));
      return waitForGimbal();
    }).then(function (dev) {
      dlog('发现云台 ' + dev.name + ' @' + dev.address);
      setHudBle(t('connecting'));
      session = new Session({
        onFrame: onGimbalFrame,
        onButton: onGimbalButton,
        onState: function (st, reason) { if (st === 'disconnected') onDisconnected(reason); },
        onLog: dlog
      });
      return session.open(dev);
    }).then(function () {
      dlog('✓ 云台就绪');
      state.gimbalConnected = true;
      setHudBle(t('connected'));
      UI.toast(t('connected'));
      state.reconnectStep = 0;          /* 连上即重置重连退避 */
      stopCountdown();
      startQueries();
    }).catch(function (err) {
      dlog('✗ 云台连接失败: ' + (err && err.message));
      state.gimbalConnected = false;
      setHudBle('BT ✗');
      UI.toast(err.message || t('btFail'), 3500);
      scheduleReconnect();
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

  /* 断线/连接失败 → 退避重连（config.RECONNECT_MS）+ HUD 倒计时；连上后重置步数 */
  function scheduleReconnect() {
    var seq = AppCfg.RECONNECT_MS;
    var step = state.reconnectStep || 0;
    var ms = seq[Math.min(step, seq.length - 1)];
    state.reconnectStep = step + 1;
    root.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = root.setTimeout(connectGimbal, ms);
    if (state.cdTimer) root.clearInterval(state.cdTimer);
    var left = Math.round(ms / 1000);
    setHudBle(t('disconnected') + ' ' + left + 's');
    state.cdTimer = root.setInterval(function () {
      left--;
      if (left <= 0) { root.clearInterval(state.cdTimer); state.cdTimer = null; return; }
      setHudBle(t('disconnected') + ' ' + left + 's');
    }, 1000);
  }

  function stopCountdown() {
    if (state.cdTimer) { root.clearInterval(state.cdTimer); state.cdTimer = null; }
  }

  /* ---------- 周期查询：电量（0x06）/ 云台状态（0x1817）---------- */

  function queryBattery() {
    if (!session) return;
    session.send(0x06, [0x00, 0x00, 0x00]).catch(function () { /* 失败忽略 */ });
  }

  function startQueries() {
    stopQueries();
    if (AppCfg.BATTERY_QUERY_MS) {
      queryBattery();                                   /* 连上先查一次 */
      state.battTimer = root.setInterval(queryBattery, AppCfg.BATTERY_QUERY_MS);
    }
    if (AppCfg.MODE_QUERY_MS) {
      state.modeTimer = root.setInterval(function () {
        if (session) session.sendRaw(AppCfg.FRAME_MODE_QUERY, true).catch(function () { /* 忽略 */ });
      }, AppCfg.MODE_QUERY_MS);
    }
  }

  function stopQueries() {
    if (state.battTimer) { root.clearInterval(state.battTimer); state.battTimer = null; }
    if (state.modeTimer) { root.clearInterval(state.modeTimer); state.modeTimer = null; }
  }

  function onDisconnected(reason) {
    dlog('云台断线' + (reason ? '(' + reason + ')' : '') + '，重连中');
    zoomHoldStop();
    stopQueries();
    if (session) { session.close(); session = null; }
    state.gimbalBatt = null;
    state.gimbalBattRaw = null;
    state.gimbalMode = null;
    state.gimbalConnected = false;
    renderHudParams();
    scheduleReconnect();
  }

  /* ---------- 诊断键工具（config.DEBUG=true 时才会被按键调用） ---------- */

  function diagSend(cmd, args, tag) {
    if (!session) { dlog('未连接，无法发送 ' + tag); return; }
    session.send(cmd, args).then(function () {
      dlog('[OUT] ' + tag);
    }, function (e) {
      dlog('[OUT] ' + tag + ' 失败: ' + ((e && (e.message || e.name)) || e));
    });
  }

  function askBattery() { diagSend(0x06, [0x00, 0x00, 0x00], '电量查询'); }

  /* 0x02 是历史资料里的探测帧，**不是**官方初始化序列的一部分（官方首个命令是 0x04） */
  function sayHello() { diagSend(0x02, [0x00, 0x00, 0x00], '0x02 探测帧'); }

  /* 可见写入测试：ZY Play 抓包里的运动指令，云台应出现可见转动（证明写入真的到达云台） */
  var MOTION_FRAMES = [
    [0x01, [0x10, 0xD4, 0x0E]],
    [0x02, [0x10, 0x00, 0x08]],
    [0x03, [0x10, 0xD4, 0x0E]]
  ];
  function motionTest() {
    if (!session) { dlog('未连接，无法做可见测试'); return; }
    var round = 0;
    dlog('可见测试开始：看云台会不会动（共 6 轮）');
    var timer = root.setInterval(function () {
      if (!session || round >= 6) {
        root.clearInterval(timer);
        dlog('可见测试结束：云台动了=我们的写入有效；没动=写没出去');
        return;
      }
      MOTION_FRAMES.forEach(function (mf) { diagSend(mf[0], mf[1], '运动 0x' + mf[0].toString(16)); });
      round++;
    }, 200);
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

    /* 电量应答（cmd 0x06）：args = 00 <lo> <hi>，值是电池组电压×10mV（见 config.BATT_CELL_CURVE） */
    if (f.cmd === 0x06 && f.payload.length >= 3) {
      var raw = f.payload[1] | (f.payload[2] << 8);
      if (raw !== state.gimbalBattRaw) {
        state.gimbalBattRaw = raw;
        var pct = battPct(raw);
        dlog('电量 ' + (raw / 100).toFixed(2) + 'V ≈ ' + pct + '%');
        state.gimbalBatt = pct;
        renderHudBle();
      }
    }

    /* 云台模式应答（0x27 查询）：ARGS = 00 <模式> 00；变化才记 + 顶部状态行显示 */
    if (f.cmd === 0x27 && f.payload.length >= 2) {
      var mode = f.payload[1];
      if (mode !== state.gimbalMode) {
        state.gimbalMode = mode;
        dlog('云台模式 0x' + mode.toString(16) + (modeName(mode) ? ' = ' + modeName(mode) : '（未登记）'));
        renderHudBle();
      }
    }

    /* 心跳帧（0x1815）：payload 首字节旧口径当过"电量百分比"，但样例 0x50=80 与 0x06 电压口径
     * 对不上（0x06 才是权威电量），已弃用，避免污染电量显示 */
  }

  function onGimbalButton(f) {
    /* 键码在 payload 第二字节（格式 C0 <码> 00）；未登记的键码只记日志不动作 */
    var code = Buttons.codeOf(f);
    dlog('云台按键 code=' + (code === null ? '??' : '0x' + code.toString(16)) + ' payload=' + U.hex(f.payload));
    Buttons.handle(code);
  }

  /* 连续变焦：按下启动（先立即走一档，再按周期）；松开即停；到顶/到底自动停 */
  function zoomHoldStart(dir) {
    zoomHoldStop();
    zoomStep(dir);
    state.zoomHoldTimer = root.setInterval(function () {
      var before = state.zoomIdx;
      zoomStep(dir);
      if (state.zoomIdx === before) zoomHoldStop();
    }, AppCfg.ZOOM_HOLD_MS);
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
    if (!cam.control) return;
    if (cam.recording) { UI.toast(t('recPhoto'), 2000); return; }   /* HAL 不支持边录边拍 */
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
    var NB = '\u00A0';   /* 标签与取值之间用不换行空格：折行只发生在 · 分隔处 */
    var parts = [];
    if (caps.whiteBalanceModes.length) {
      var wb = cam.getParam('whiteBalance');
      if (wb !== undefined && wb !== null) parts.push(t('hudWb') + NB + tval(wb));
    }
    if (caps.isoModes.length) {
      var iso = cam.getParam('iso');
      if (iso !== undefined && iso !== null) parts.push(t('hudIso') + NB + tval(iso));
    }
    if (state.ecList.length) {
      parts.push(t('hudEc') + NB + fmtEc(state.ecNow));
    }
    UI.hud({
      param: parts.join(' · '),
      zoom: ((state.zoomRatios.length > 1 ? ('×' + state.zoomRatios[state.zoomIdx]) : '') + ' ' + APP_VERSION).trim()
    });
  }

  /* 电量换算：raw = 电池组电压×10mV（3S 18650）→ 单节电压查放电曲线得剩余百分比 */
  function battPct(raw) {
    var curve = AppCfg.BATT_CELL_CURVE;
    if (!curve || !curve.length) return 0;
    var mv = raw * 10 / 3;                     /* 单节电压（mV） */
    if (mv >= curve[0][0]) return curve[0][1];
    for (var i = 1; i < curve.length; i++) {
      if (mv >= curve[i][0]) {
        var hi = curve[i - 1], lo = curve[i];
        var k = (mv - lo[0]) / (hi[0] - lo[0]);
        return Math.round(lo[1] + k * (hi[1] - lo[1]));
      }
    }
    return 0;
  }

  /* 模式码 → 名称（PF/L/F/POV/GO；未登记的返回 null） */
  function modeName(code) {
    var names = AppCfg.MODE_NAMES || [];
    return (code >= 0 && code < names.length) ? names[code] : null;
  }

  /* 顶部状态行：连接状态文本 +（连上且已知时）云台电量与模式，如「云台已连接 10% F」 */
  function setHudBle(txt) {
    state.bleText = txt;
    renderHudBle();
  }

  function renderHudBle() {
    var txt = state.bleText || '';
    if (state.gimbalConnected && state.gimbalBatt !== null) txt += ' ' + state.gimbalBatt + '%';
    var m = (state.gimbalConnected && state.gimbalMode !== null) ? modeName(state.gimbalMode) : null;
    if (m) txt += ' ' + m;
    UI.hud({ ble: txt });
  }

  /* 曝光补偿显示：最多两位小数并去掉尾零（0.5 → +0.5，-1 → -1），避免浮点长串 */
  function fmtEc(v) {
    var n = Math.round(Number(v) * 100) / 100;
    var s = String(n).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return (n > 0 ? '+' : '') + s;
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
      return tval(v);
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
        valueText: fmtEc(state.ecNow),
        cycle: function (d) {
          var idx = state.ecList.indexOf(state.ecNow);
          if (idx === -1) idx = state.ecList.indexOf(0);
          if (idx === -1) idx = 0;
          idx = (idx + d + state.ecList.length) % state.ecList.length;
          state.ecNow = state.ecList[idx];
          cam.setParam('ec', state.ecNow);
          ecItem.valueText = fmtEc(state.ecNow);
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
      state.debugScroll = 0;
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
    /* 面板打开时 ↑↓ 翻日志历史（不切变焦），否则还是变焦 */
    if (state.debugOn && (k === 'ArrowUp' || k === 'ArrowDown')) {
      var lines = cam.getLog().concat(state.appLog);
      var max = debugMaxScroll(lines.length);
      var next = state.debugScroll + (k === 'ArrowUp' ? 1 : -1);
      state.debugScroll = Math.max(0, Math.min(max, next));
      renderDebug();
      e.preventDefault();
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
      case '0': if (AppCfg.DEBUG) askBattery(); break;
      case '5': if (AppCfg.DEBUG) sayHello(); break;
      case '7': if (AppCfg.DEBUG) motionTest(); break;
      case '9': retryCamera(); break;
    }
  }

  /* 取景界面按返回键退出应用 */
  function exitApp() {
    zoomHoldStop();
    stopQueries();
    stopCountdown();
    if (session) { session.close(); session = null; }
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
