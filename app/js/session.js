/* 云台会话层：连接 → 订阅(CCCD) → 官方初始化序列 → 100ms 轮询 .value 接收 → 断线回调。
 * 依赖：KaiUtil / Zhiyun / AppCfg / KaiBt。**不含** UI、相机、按键语义（那些在上层）。
 *
 *   var s = new KaiSession({ onFrame, onButton, onState, onLog });
 *   s.open(dev).then(...);   s.send(cmd, args);   s.close();
 *   onState('disconnected', reason) 后由上层决定何时重连（本层不自动重连）
 */
(function (root) {
  'use strict';

  var U = root.KaiUtil;
  var Z = root.Zhiyun;
  var C = root.AppCfg;
  var bt = root.KaiBt;

  function Session(opts) {
    opts = opts || {};
    this.onFrame = opts.onFrame || null;
    this.onButton = opts.onButton || null;
    this.onState = opts.onState || function () {};
    this.log = opts.onLog || function () {};
    this.conn = null;
    this.client = null;
    this.pollTimer = null;
    this.lastVal = null;
    this.rxCount = 0;
    this.initTimer = null;
    this.closing = false;
  }

  /* 连接 + 订阅 + 初始化 + 开始接收；resolve 后会话可用 */
  Session.prototype.open = function (dev) {
    var self = this;
    this.closing = false;
    this.rxCount = 0;
    return bt.connect(dev).then(function (con) {
      if (!con.writeChar || !con.notifyChar) {
        bt.disconnect(con);
        throw new Error('fee9 特征不完整: write=' + !!con.writeChar + ' notify=' + !!con.notifyChar);
      }
      self.conn = con;
      self.log('connected svcs=' + con.services.length + ' write=' + !!con.writeChar + ' notify=' + !!con.notifyChar);
      self.client = new Z.Client(function (buf) { return bt.write(con, buf); }, {
        onFrame: function (f) { self.rxCount++; if (self.onFrame) self.onFrame(f); },
        onButton: function (f) { if (self.onButton) self.onButton(f); }
      });
      return bt.armNotifications(con, function (val) { self.client.feed(val); });
    }).then(function (ni) {
      ni = ni || {};
      self.log('notify: cccd=' + ni.cccd + ' wrote=' + (ni.wrote || '-') + ' startErr=' + (ni.startErr || '-'));
      self.rxCount = 0;
      self.startPoll();
      return self.runInit();
    }).then(function () {
      return self.conn;
    });
  };

  /* 官方初始化序列（ZY Play 抓包实锤）：0x04 → 0x7C/0x7D/0x7E/0x7F → 固定 0x1818 帧 → 0x06
   * 每步等应答、超时重试；跑完后云台才开始上报按键 */
  Session.prototype.runInit = function () {
    var self = this;
    var SEQ = [
      { cmd: 0x04 }, { cmd: 0x7C }, { cmd: 0x7D }, { cmd: 0x7E }, { cmd: 0x7F },
      { raw: C.FRAME_1818 }, { cmd: 0x06 }
    ];
    var i = 0, tries = 0;
    var startRx = this.rxCount;
    this.log('官方初始化: 0x04 → 0x7C-0x7F → 0x1818 → 0x06');
    return new Promise(function (resolve) {
      function step() {
        if (self.closing || !self.conn) { resolve(); return; }
        if (i >= SEQ.length) {
          self.log('初始化完成（收到 ' + (self.rxCount - startRx) + ' 个回包）');
          resolve();
          return;
        }
        var it = SEQ[i];
        tries++;
        var seen = self.rxCount;
        if (it.raw) self.sendRaw(it.raw).catch(function () { /* 失败也继续 */ });
        else self.send(it.cmd, [0, 0, 0]).catch(function () { /* 失败也继续 */ });
        self.initTimer = root.setTimeout(function () {
          self.initTimer = null;
          if (self.closing) { resolve(); return; }
          if (self.rxCount > seen) { i++; tries = 0; }        /* 有应答 → 下一条 */
          else if (tries >= C.INIT_TRIES) { i++; tries = 0; }  /* 试满无应答 → 跳过 */
          step();
        }, C.INIT_WAIT_MS);
      }
      step();
    });
  };

  /* 发一条官方帧形命令；resolve 表示栈已接收（writeWithoutResponse 无对端 ACK） */
  Session.prototype.send = function (cmd, args) {
    if (!this.client) return Promise.reject(new Error('未连接'));
    return this.client.send(cmd, args);
  };

  /* 发原始字节帧（如 FRAME_1818 / FRAME_1817）；quiet=true 时不打 TX 日志（周期查询用） */
  Session.prototype.sendRaw = function (bytes, quiet) {
    var self = this;
    if (!this.conn) return Promise.reject(new Error('未连接'));
    var u8 = new Uint8Array(bytes);
    return bt.write(this.conn, u8.buffer).then(function () {
      if (!quiet) self.log('TX ' + U.hex(u8));
    });
  };

  /* 接收：100ms 轮询特征对象 .value（本地缓存读，无 ATT 往返）→ 差分 → 喂协议层。
   * 真机实测：通知进栈、.value 更新，但 oncharacteristicchanged 永不触发 */
  Session.prototype.startPoll = function () {
    var self = this;
    this.stopPoll();
    this.lastVal = null;
    this.pollTimer = root.setInterval(function () {
      var con = self.conn;
      if (!con || !con.notifyChar) return;
      if (linkDown(con.gatt)) { self.stopPoll(); self.onState('disconnected', '链路断开'); return; }
      var v;
      try { v = new Uint8Array(con.notifyChar.value || []); } catch (e) { return; }
      if (!v.length) return;
      if (self.lastVal && bytesEqual(self.lastVal, v)) return;
      self.lastVal = v;
      if (self.client) self.client.feed(v);
    }, C.POLL_MS);
  };

  Session.prototype.stopPoll = function () {
    if (this.pollTimer) { root.clearInterval(this.pollTimer); this.pollTimer = null; }
  };

  Session.prototype.close = function () {
    this.closing = true;
    if (this.initTimer) { root.clearTimeout(this.initTimer); this.initTimer = null; }
    this.stopPoll();
    if (this.client) this.client.stopHeartbeat();
    bt.disconnect(this.conn);
    this.conn = null;
    this.client = null;
  };

  /* 链路是否已断：connected / connectionState 两个口径都试（不同固件暴露不同） */
  function linkDown(gatt) {
    try { if (gatt.connected === false) return true; } catch (e) { /* 无该属性 */ }
    try {
      var s = gatt.connectionState;
      if (s === 'disconnected' || s === 0) return true;
    } catch (e) { /* 无该属性 */ }
    return false;
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  root.KaiSession = Session;
})(typeof window !== 'undefined' ? window : globalThis);
