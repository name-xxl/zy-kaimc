/* 主逻辑：编排相机取景、云台会话、按键映射与界面状态。
 * 具体职责已外移：format.js（纯格式/换算）、grid.js（构图辅助线）、debug.js（调试面板）、
 * menu.js（参数菜单）；本文件只做启动、云台链路编排、拍摄动作与键盘分发。
 * 键码与时序常量见 config.js（AppCfg.KEY / AppCfg.*_MS） */
(function (root) {
  'use strict';

  var U = root.KaiUtil;
  var F = root.KaiFmt;
  var t = root.Strings.t;
  var tval = root.Strings.val;   /* 相机 HAL 取值汉化（auto→自动 等） */
  var UI = root.KaiUI;
  var bt = root.KaiBt;
  var cam = root.KaiCam;
  var AppCfg = root.AppCfg;
  var Buttons = root.KaiButtons;
  var Session = root.KaiSession;
  var Grid = root.KaiGrid;
  var Dbg = root.KaiDbg;
  var Menu = root.KaiMenu;

  var APP_VERSION = 'v8.7';
  var GIMBAL_NAME_RE = /CRANE[-_ ]?M2/i;

  /* 云台链路状态 */
  var link = {
    session: null,
    stopScan: null,
    reconnectTimer: null,
    reconnectStep: 0,
    cdTimer: null,
    battTimer: null,
    modeTimer: null,
    connected: false,
    alive: true,
    bleText: '',
    batt: null,
    battRaw: null,
    mode: null,
    lastKeyAt: 0,
    lastModeQuery: 0,
    lastFrameAt: 0,
    rxCount: 0
  };

  /* 拍摄（本机）状态 */
  var state = {
    recTimer: null,
    recSecs: 0,
    zoomRatios: [],
    zoomIdx: 0,
    zoomHoldTimer: null,
    ecList: [],
    ecNow: 0
  };

  /* 拍摄扩展设置（菜单里改，会话内存续）：自拍定时秒数 / 连拍张数 / 间隔定时 '间隔x张数' */
  var shoot = { delay: 0, burst: 0, interval: '0' };
  /* 进行中的拍摄序列：{ total, left, timer, cd } */
  var seq = null;

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
    zoomHoldStop();
    abortSeq();
    cam.release();
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

  /* ---------- 启动 ---------- */

  function boot() {
    UI.init();
    goFullscreen();
    U.lockPortrait();
    setFinderKeys();
    Dbg.init({ getExtra: function () { return cam.getLog(); } });
    UI.splash({ title: 'ZY-KaiCam', sub: APP_VERSION, hint: t('camInit') });
    setHudBle(t('camInit'));
    UI.hud({ mode: t('modePhoto') });
    Grid.load();
    Grid.apply();
    root.addEventListener('keydown', onKey);
    root.document.addEventListener('visibilitychange', onVis);
    probeAppIdentity();

    startCamera().then(function () {
      Dbg.log('✓ 相机就绪');
      UI.splashHide(true);
      setHudBle(t('scan'));
      connectGimbal();
    }).catch(function (err) {
      Dbg.log('✗ 相机初始化失败: ' + (err && err.message));
      UI.splash({ title: 'ZY-KaiCam', sub: APP_VERSION,
        hint: cam.control ? t('previewFail') : t('camAllFail') });
      setHudBle(t('scan'));
      connectGimbal(); /* 相机失败不影响连云台 */
    });
  }

  function startCamera() {
    return cam.init().then(function () {
      return cam.startPreview(U.byId('preview'));
    }).then(function () {
      setupZoomAndEc();
      renderHudParams();
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
          Dbg.log('app type=' + (a && a.manifest ? a.manifest.type : '?') +
            ' origin=' + ((a && a.installOrigin) || '?'));
        };
        req.onerror = function () { Dbg.log('app getSelf 失败'); };
      }
    } catch (e) { /* 无 mozApps */ }
    try {
      var ds = root.navigator.getDeviceStorage ? root.navigator.getDeviceStorage('pictures') : null;
      Dbg.log('priv: storage=' + (ds ? 'ok' : 'null') +
        ' bt=' + (root.navigator.mozBluetooth ? 'ok' : 'null'));
    } catch (e) { /* 无 deviceStorage */ }
  }

  function retryCamera() {
    UI.toast(t('retrying'));
    Dbg.log('手动重试相机(' + cam.mode + ')…');
    cam.release();
    startCamera().then(function () {
      Dbg.log('✓ 相机重试成功');
      UI.splashHide(true);
    }).catch(function (err) {
      Dbg.log('✗ 相机重试失败: ' + (err && err.message));
      UI.splash({ title: 'ZY-KaiCam', sub: APP_VERSION,
        hint: cam.control ? t('previewFail') : t('camAllFail') });
    });
  }

  /* ---------- 云台连接（连接/订阅/初始化/接收 都交给 KaiSession，这里只做编排与重连） ---------- */

  function connectGimbal() {
    bt.init().then(function () {
      Dbg.log('BT: ' + bt.radioProbe());
      /* 状态检测失败不阻断——直接试扫描，扫描会给出真实错误 */
      return bt.ensureEnabled().catch(function (e) {
        Dbg.log('BT 开启存疑仍尝试扫描: ' + e.message);
      });
    }).then(function () {
      Dbg.log('扫描 ' + GIMBAL_NAME_RE);
      setHudBle(t('scan'));
      return waitForGimbal();
    }).then(function (dev) {
      Dbg.log('发现云台 ' + dev.name + ' @' + dev.address);
      setHudBle(t('connecting'));
      link.session = new Session({
        onFrame: onGimbalFrame,
        onButton: onGimbalButton,
        onState: function (st, reason) { if (st === 'disconnected') onDisconnected(reason); },
        onLog: Dbg.log
      });
      return link.session.open(dev);
    }).then(function () {
      Dbg.log('✓ 云台就绪');
      link.connected = true;
      setHudBle(t('connected'));
      UI.toast(t('connected'));
      link.reconnectStep = 0;          /* 连上即重置重连退避 */
      stopCountdown();
      startQueries();
    }).catch(function (err) {
      Dbg.log('✗ 云台连接失败: ' + (err && err.message));
      link.connected = false;
      setHudBle(t('btBad'));
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
        if (link.stopScan) { link.stopScan(); link.stopScan = null; }
        resolve(dev);
      }).then(function (h) {
        link.stopScan = h.stop;
        if (found) { h.stop(); link.stopScan = null; }   /* 连上即释放扫描句柄 */
      }).catch(reject);
    });
  }

  /* 断线/连接失败 → 退避重连（config.RECONNECT_MS）+ HUD 倒计时；连上后重置步数 */
  function scheduleReconnect() {
    var seqMs = AppCfg.RECONNECT_MS;
    var step = link.reconnectStep || 0;
    var ms = seqMs[Math.min(step, seqMs.length - 1)];
    link.reconnectStep = step + 1;
    root.clearTimeout(link.reconnectTimer);
    link.reconnectTimer = root.setTimeout(connectGimbal, ms);
    if (link.cdTimer) root.clearInterval(link.cdTimer);
    var left = Math.round(ms / 1000);
    setHudBle(t('disconnected') + ' ' + left + 's');
    link.cdTimer = root.setInterval(function () {
      left--;
      if (left <= 0) { root.clearInterval(link.cdTimer); link.cdTimer = null; return; }
      setHudBle(t('disconnected') + ' ' + left + 's');
    }, 1000);
  }

  function stopCountdown() {
    if (link.cdTimer) { root.clearInterval(link.cdTimer); link.cdTimer = null; }
  }

  /* ---------- 周期查询：电量（0x06）/ 模式（0x27） ---------- */

  function queryBattery() {
    if (!link.session) return;
    link.session.send(0x06, [0x00, 0x00, 0x00]).catch(function () { /* 失败忽略 */ });
  }

  function startQueries() {
    stopQueries();
    if (AppCfg.BATTERY_QUERY_MS) {
      queryBattery();                                   /* 连上先查一次 */
      link.battTimer = root.setInterval(queryBattery, AppCfg.BATTERY_QUERY_MS);
    }
    /* 模式查询：M 键/扳机不上报（云台不推模式变化），只能主动问。
     * 空闲按 MODE_QUERY_MS；一旦收到云台按键（说明人正在操作）就压到 MODE_QUERY_FAST_MS，
     * 持续 MODE_FAST_TAIL_MS 无按键后回落。250ms 本地 tick 只判断"到点没"，
     * 真正发帧按上面节奏走——多几个 14 字节小包，射频开销可忽略 */
    link.lastKeyAt = 0;
    link.lastModeQuery = 0;
    link.lastFrameAt = 0;      /* 云台最后一次回包时间（待机/无应答判定用） */
    link.alive = true;
    if (AppCfg.MODE_QUERY_MS) {
      link.modeTimer = root.setInterval(function () {
        if (!link.session) return;
        var now = Date.now();
        checkGimbalSilent(now);
        if (now - link.lastModeQuery < modeQueryDelay(now)) return;
        link.lastModeQuery = now;
        link.session.sendRaw(AppCfg.FRAME_MODE_QUERY, true).catch(function () { /* 忽略 */ });
      }, 250);
    }
  }

  /* 云台待机（休眠）实测：BLE 链路仍在、但对任何命令都不应答 —— 靠"连续无应答"判定，
   * 避免把休眠前的缓存电量/模式当实时值显示。门限 = 2 个查询周期 + 3s */
  function checkGimbalSilent(now) {
    if (!link.lastFrameAt) return;
    var limit = modeQueryDelay(now) * 2 + 3000;
    var alive = (now - link.lastFrameAt) < limit;
    if (alive === link.alive) return;
    link.alive = alive;
    Dbg.log(alive ? '云台恢复应答' : '云台无应答 ' + Math.round((now - link.lastFrameAt) / 1000) + 's（待机？）');
    renderHudBle();
  }

  /* 当前该用多长的查询间隔：人刚动过云台 → 快 */
  function modeQueryDelay(now) {
    var fast = AppCfg.MODE_QUERY_FAST_MS, tail = AppCfg.MODE_FAST_TAIL_MS;
    if (fast && tail && link.lastKeyAt && (now - link.lastKeyAt) < tail) return fast;
    return AppCfg.MODE_QUERY_MS;
  }

  function stopQueries() {
    if (link.battTimer) { root.clearInterval(link.battTimer); link.battTimer = null; }
    if (link.modeTimer) { root.clearInterval(link.modeTimer); link.modeTimer = null; }
  }

  function onDisconnected(reason) {
    Dbg.log('云台断线' + (reason ? '(' + reason + ')' : '') + '，重连中');
    zoomHoldStop();
    stopQueries();
    if (link.session) { link.session.close(); link.session = null; }
    link.batt = null;
    link.battRaw = null;
    link.mode = null;
    link.connected = false;
    link.lastFrameAt = 0;
    link.alive = true;
    renderHudParams();
    scheduleReconnect();
  }

  /* ---------- 诊断键工具（config.DEBUG=true 时才会被按键调用） ---------- */

  function diagSend(cmd, args, tag) {
    if (!link.session) { Dbg.log('未连接，无法发送 ' + tag); return; }
    link.session.send(cmd, args).then(function () {
      Dbg.log('[OUT] ' + tag);
    }, function (e) {
      Dbg.log('[OUT] ' + tag + ' 失败: ' + ((e && (e.message || e.name)) || e));
    });
  }

  /* 0x02 是历史资料里的探测帧，**不是**官方初始化序列的一部分（官方首个命令是 0x04） */
  function sayHello() { diagSend(0x02, [0x00, 0x00, 0x00], '0x02 探测帧'); }

  /* 可见写入测试：ZY Play 抓包里的运动指令，云台应出现可见转动（证明写入真的到达云台） */
  var MOTION_FRAMES = [
    [0x01, [0x10, 0xD4, 0x0E]],
    [0x02, [0x10, 0x00, 0x08]],
    [0x03, [0x10, 0xD4, 0x0E]]
  ];
  function motionTest() {
    if (!link.session) { Dbg.log('未连接，无法做可见测试'); return; }
    var round = 0;
    Dbg.log('可见测试开始：看云台会不会动（共 6 轮）');
    var timer = root.setInterval(function () {
      if (!link.session || round >= 6) {
        root.clearInterval(timer);
        Dbg.log('可见测试结束：云台动了=我们的写入有效；没动=写没出去');
        return;
      }
      MOTION_FRAMES.forEach(function (mf) { diagSend(mf[0], mf[1], '运动 0x' + mf[0].toString(16)); });
      round++;
    }, 200);
  }

  /* ---------- 云台事件 ---------- */

  function onGimbalFrame(f) {
    link.rxCount++;
    link.lastFrameAt = Date.now();
    /* 抓字段：前 14 帧 + 之后每 10 帧打原始字节（含初始化应答与按键帧） */
    if (link.rxCount <= 14 || link.rxCount % 10 === 0) {
      Dbg.log('[IN#' + link.rxCount + '] ' + U.hex(f.raw) + ' cmd=0x' + f.cmd.toString(16) +
        (f.crcOk ? '' : ' CRC✗'));
    }
    if (!f.crcOk) return;

    /* 电量应答（cmd 0x06）：args = 00 <lo> <hi>，值是电池组电压×10mV（见 config.BATT_CELL_CURVE） */
    if (f.cmd === 0x06 && f.payload.length >= 3) {
      var raw = f.payload[1] | (f.payload[2] << 8);
      if (raw !== link.battRaw) {
        link.battRaw = raw;
        var pct = F.battPct(raw);
        Dbg.log('电量 ' + (raw / 100).toFixed(2) + 'V ≈ ' + pct + '%');
        link.batt = pct;
        renderHudBle();
      }
    }

    /* 云台模式应答（0x27 查询）：ARGS = 00 <模式> 00；变化才记 + 顶部状态行显示 */
    if (f.cmd === 0x27 && f.payload.length >= 2) {
      var mode = f.payload[1];
      if (mode !== link.mode) {
        link.mode = mode;
        Dbg.log('云台模式 0x' + mode.toString(16) + (modeName(mode) ? ' = ' + modeName(mode) : '（未登记）'));
        renderHudBle();
      }
    }
  }

  function onGimbalButton(f) {
    /* 键码在 payload 第二字节（格式 C0 <码> 00）；未登记的键码只记日志不动作 */
    link.lastKeyAt = Date.now();   /* 人在操作 → 模式查询提速（见 startQueries） */
    var code = Buttons.codeOf(f);
    Dbg.log('云台按键 code=' + (code === null ? '??' : '0x' + code.toString(16)) + ' payload=' + U.hex(f.payload));
    Buttons.handle(code);
  }

  /* ---------- 快门 / 拍摄序列（自拍定时 · 连拍 · 间隔定时） ---------- */

  function shutter() {
    U.lockPortrait();
    if (cam.mode !== 'picture') { toggleRecord(); return; }
    if (seq) { abortSeq(t('shotsStop')); return; }   /* 序列进行中再按快门 = 中止 */
    startSeq();
  }

  /* 本次序列的张数与张间隔：连拍优先，其次间隔定时，否则单张 */
  function seqPlan() {
    if (shoot.burst > 1) return { total: shoot.burst, gap: 600 };
    var m = /^(\d+)x(\d+)$/.exec(String(shoot.interval || ''));
    if (m) return { total: parseInt(m[2], 10), gap: parseInt(m[1], 10) * 1000 };
    return { total: 1, gap: 0 };
  }

  function startSeq() {
    var plan = seqPlan();
    seq = { total: plan.total, left: plan.total, timer: null, cd: null };
    if (shoot.delay > 0) {
      countdown(shoot.delay, function () { fireSeq(plan.gap); });
    } else {
      fireSeq(plan.gap);
    }
  }

  function countdown(secs, done) {
    var left = secs;
    var show = function () {
      UI.splash({ big: String(left), hint: t('pDelay') });
    };
    show();
    seq.cd = root.setInterval(function () {
      left--;
      if (left <= 0) {
        root.clearInterval(seq.cd);
        seq.cd = null;
        UI.splashHide(true);
        done();
        return;
      }
      show();
    }, 1000);
  }

  function fireSeq(gap) {
    takePhoto(function () {
      if (!seq) return;                 /* 已中止 */
      seq.left--;
      if (seq.left <= 0) { finishSeq(); return; }
      showSeqProgress();
      seq.timer = root.setTimeout(function () { fireSeq(gap); }, gap);
    });
  }

  function showSeqProgress() {
    if (!seq) return;
    UI.splash({
      big: (seq.total - seq.left + 1) + '/' + seq.total,
      sub: shoot.burst > 1 ? t('pBurst') : t('pInterval')
    });
  }

  function finishSeq() {
    var total = seq.total;
    clearSeqTimer();
    seq = null;
    UI.splashHide(true);
    UI.toast(t('shotsDone') + ' ' + total + t('kShots'), 1500);
  }

  function abortSeq(msg) {
    if (!seq) return;
    clearSeqTimer();
    seq = null;
    UI.splashHide(true);
    if (msg) UI.toast(msg, 1200);
  }

  function clearSeqTimer() {
    if (!seq) return;
    if (seq.cd) { root.clearInterval(seq.cd); seq.cd = null; }
    if (seq.timer) { root.clearTimeout(seq.timer); seq.timer = null; }
  }

  /* 单张拍照；done 用于序列（不逐张弹提示，改由中央块显示进度） */
  function takePhoto(done) {
    if (!cam.control) { if (done) done(); return; }
    if (cam.recording) { UI.toast(t('recPhoto'), 2000); if (done) done(); return; }   /* HAL 不支持边录边拍 */
    UI.flash();
    cam.takePicture().then(function (blob) {
      return cam.saveBlob(blob, 'pictures', cam.photoFilename());
    }).then(function () {
      Dbg.log('✓ 照片已存 ' + cam.photoFilename());
      if (done) done(); else UI.toast(t('saved'));
    }).catch(function (err) {
      Dbg.log('✗ 拍照/保存: ' + (err && err.message));
      UI.toast(err.message || t('saveFail'), 2500);
      if (done) done();
    });
  }

  function toggleRecord() {
    if (!cam.control) return;
    if (!cam.recording) {
      cam.startRecording().then(function () {
        state.recSecs = 0;
        UI.hud({ rec: t('recHud') + '00:00' });
        state.recTimer = root.setInterval(function () {
          state.recSecs++;
          UI.hud({ rec: t('recHud') + F.fmtTime(state.recSecs) });
        }, 1000);
      }).catch(function (err) {
        Dbg.log('✗ 录像: ' + (err && err.message));
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

  /* ---------- 模式切换 / 变焦 / 曝光补偿 ---------- */

  function switchMode() {
    if (cam.recording) { UI.toast(t('recording')); return; }
    var target = (cam.mode === 'picture') ? 'video' : 'picture';
    var prev = cam.mode;
    cam.setMode(target);
    UI.hud({ mode: target === 'video' ? t('modeVideo') : t('modePhoto') });
    Dbg.log('切换模式 → ' + target);
    cam.switchMode(target, U.byId('preview')).then(function () {
      Dbg.log('✓ 模式已切换');
      setupZoomAndEc();
      renderHudParams();
    }).catch(function (err) {
      Dbg.log('✗ 切换失败: ' + (err && err.message));
      cam.setMode(prev);
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

  function zoomStep(d) {
    if (state.zoomRatios.length < 2) { UI.toast(t('zoom') + ' ' + t('na')); return; }
    state.zoomIdx = Math.min(state.zoomRatios.length - 1, Math.max(0, state.zoomIdx + d));
    cam.setParam('zoom', state.zoomRatios[state.zoomIdx]);
    renderHudParams();
  }

  function ecStep(d) {
    if (!state.ecList.length) { UI.toast(t('pEc') + ' ' + t('na')); return; }
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

  /* ---------- 界面状态（顶部状态行 + 底部信息条） ---------- */

  function renderHudParams() {
    var caps = cam.capabilities();
    var NB = '\u00A0';   /* 标签与取值之间用不换行空格：折行只发生在 · 分隔处 */
    /* 只显示"改过"的值：自动/0 这类默认值不占 HUD（要看全部值去参数菜单），
     * 这样底栏通常只有右下角的变焦条 */
    var DEF = /^(auto|自动)$/i;
    var parts = [];
    if (caps.whiteBalanceModes.length) {
      var wb = cam.getParam('whiteBalance');
      if (wb !== undefined && wb !== null && !DEF.test(String(wb))) parts.push(t('hudWb') + NB + tval(wb));
    }
    if (caps.isoModes.length) {
      var iso = cam.getParam('iso');
      if (iso !== undefined && iso !== null && !DEF.test(String(iso))) parts.push(t('hudIso') + NB + tval(iso));
    }
    if (state.ecList.length && Number(state.ecNow) !== 0) {
      parts.push(t('hudEc') + NB + F.fmtEc(state.ecNow));
    }
    UI.hud({
      param: parts.join(' · '),
      zoom: (state.zoomRatios.length > 1) ? ('×' + state.zoomRatios[state.zoomIdx]) : ''
    });
  }

  /* 模式码 → 名称（PF/L/F/POV/GO；未登记的返回 null） */
  function modeName(code) {
    var names = AppCfg.MODE_NAMES || [];
    return (code >= 0 && code < names.length) ? names[code] : null;
  }

  /* 顶部状态行：连接状态文本 +（连上且已知时）云台电量与模式，如「云台已连接 10% F」 */
  function setHudBle(txt) {
    link.bleText = txt;
    renderHudBle();
  }

  function renderHudBle() {
    /* 云台休眠/无应答时不显示陈旧的缓存电量与模式，直接说明现状 */
    if (link.connected && !link.alive) {
      UI.hud({ ble: t('gimbalSilent') });
      return;
    }
    var txt = link.bleText || '';
    if (link.connected && link.batt !== null) txt += ' ' + link.batt + '%';
    if (link.connected && link.mode !== null) {
      var m = modeName(link.mode);
      txt += ' ' + (m || ('0x' + link.mode.toString(16)));   /* 未登记的码直接显示原值 */
    }
    UI.hud({ ble: txt });
  }

  /* ---------- 参数菜单（内容在 menu.js，这里只提供上下文与二级页） ---------- */

  function openMenu() {
    if (!cam.control) { UI.toast(t('camAllFail')); return; }
    Menu.open({
      cam: cam,
      caps: cam.capabilities(),
      appVersion: APP_VERSION,
      ec: {
        list: state.ecList,
        get: function () { return state.ecNow; },
        set: function (v) { state.ecNow = v; cam.setParam('ec', v); }
      },
      shoot: {
        get: function () { return shoot; },
        set: function (k, v) { shoot[k] = v; }
      },
      grid: {
        text: function () { return Grid.text(); },
        cycle: function (d) { Grid.cycle(d); }
      },
      about: { open: openAbout }
    });
  }

  function closeMenu() {
    UI.closeMenu();
    setFinderKeys();
    renderHudParams();
  }

  function openAbout() {
    UI.renderAbout(APP_VERSION);
    UI.showView('about');
    UI.setSoftkeys(t('skBack'), '', '');
  }

  function closeAbout() {
    UI.showView('menu');
    UI.setSoftkeys(t('skBack'), t('skClose'), t('skMode'));
  }

  /* ---------- 按键 ---------- */

  function setFinderKeys() {
    UI.setSoftkeys(t('skParams'), t('skShutter'), t('skMode'));
  }

  function onKey(e) {
    var k = e.key;
    /* 关于页：返回/确定回参数菜单，其它键忽略 */
    if (UI.aboutActive()) {
      if (k === 'Backspace' || k === 'Enter' || k === 'SoftLeft') { e.preventDefault(); closeAbout(); }
      return;
    }
    if (k === 'Backspace') {
      e.preventDefault();
      if (UI.menuActive()) { closeMenu(); }
      else { exitApp(); }
      return;
    }
    if (k === '#') {
      Dbg.toggle();
      return;
    }
    if (UI.menuActive()) {
      if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
        var it = UI.selectedItem();
        if (k === 'ArrowRight' && it && it.open && !it.cycle) { it.open(); e.preventDefault(); return; }  /* 二级页：→ 进入 */
        UI.menuKey(k);
        e.preventDefault();
        return;
      }
      if (k === 'Enter') {
        var sel = UI.selectedItem();
        if (sel && sel.open) { sel.open(); return; }   /* 二级页（关于） */
        closeMenu();
        return;
      }
      if (k === 'SoftLeft') { closeMenu(); return; }
      if (k === 'SoftRight') { switchMode(); return; }
      return;
    }
    /* 面板打开时 ↑↓ 翻日志历史（不切变焦），否则还是变焦 */
    if (Dbg.active() && (k === 'ArrowUp' || k === 'ArrowDown')) {
      Dbg.scrollBy(k === 'ArrowUp' ? 1 : -1);
      e.preventDefault();
      return;
    }
    switch (k) {
      case 'SoftLeft': openMenu(); break;
      case 'SoftRight': switchMode(); break;
      case 'Enter': shutter(); break;
      case '0': shutter(); break;               /* 单手位：等同快门（含定时/连拍/间隔设置） */
      case 'ArrowUp': case '2': zoomStep(1); e.preventDefault(); break;
      case 'ArrowDown': case '8': zoomStep(-1); e.preventDefault(); break;
      case 'ArrowLeft': case '4': ecStep(-1); e.preventDefault(); break;
      case 'ArrowRight': case '6': ecStep(1); e.preventDefault(); break;
      case '1': cycleQuickParam('whiteBalance'); break;
      case '3': cycleQuickParam('iso'); break;
      case '*': Grid.cycle(1); break;
      case '5': if (AppCfg.DEBUG) sayHello(); break;
      case '7': if (AppCfg.DEBUG) motionTest(); break;
      case '9': retryCamera(); break;
    }
  }

  /* 取景界面按返回键退出应用 */
  function exitApp() {
    zoomHoldStop();
    abortSeq();
    stopQueries();
    stopCountdown();
    if (link.session) { link.session.close(); link.session = null; }
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
      abortSeq();
      cam.stopPreview();
      /* 后台降级：屏幕/相机都停了，周期查询与 10Hz 收包轮询基本无意义 → 停查询、放宽轮询 */
      stopQueries();
      if (link.session) link.session.setPollMs(AppCfg.POLL_HIDDEN_MS || 500);
    } else {
      goFullscreen();
      U.lockPortrait();
      if (cam.control) {
        cam.startPreview(U.byId('preview')).catch(function () {});
      }
      if (link.session) {
        link.session.setPollMs(AppCfg.POLL_MS);
        startQueries();       /* 回前台恢复查询；lastFrameAt 会在首个回包时刷新 */
      }
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
