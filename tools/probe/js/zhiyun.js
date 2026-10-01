/* 智云(Zhiyun)云台 BLE 私有协议层。
 *
 * 帧格式（依据 Weebill-S / Crane 2S 逆向资料，云鹤 M2 待探针实测确认）：
 *   0x24 <DIR> <LEN:2B 小端> <FMT:2B> <SEQ:2B 大端> <TYPE> <CMD> <PAYLOAD…> <CRC16:2B 小端>
 *
 *   DIR  0x3C = App→云台；0x3E = 云台→App
 *   FMT  0x1812 普通命令帧；0x1815 心跳帧
 *   TYPE 0x01 命令；0x10 响应
 *   LEN  从 FMT 字节起至 PAYLOAD 末尾的字节数（不含 4 字节帧头，不含 CRC）；**小端**：
 *        实测抓包为 24 3C 08 00 …（App 帧）与 24 3E 0C 00 …（云台心跳），曾按大端理解，已纠正
 *   CRC  CRC16/XMODEM（init 0x0000，poly 0x1021，MSB first），对 FMT..PAYLOAD 计算，
 *        按小端存放（低字节在前；由 Weebill-S 实测心跳帧 24 3E 0C 00 18 15 08 00 01 80
 *        50 10 C2 01 00 00 98 4B 验证：CRC=0x4B98，帧内为 98 4B）。
 *        解析端兼容另一口径（从 LEN 起算），任一匹配即视为 CRC 通过。
 *
 * 已知命令（Weebill-S 实测，M2 待核对）：0x20 按键事件、0x80 心跳、0x06 电量、
 *   0x27 模式、0x01/02/03 轴速度、0x68 相机品牌、0x7C-7F 序列号。
 */
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint16Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i << 8;
      for (var j = 0; j < 8; j++) {
        c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1);
        c &= 0xFFFF;
      }
      t[i] = c;
    }
    return t;
  })();

  /* CRC16/XMODEM，对 u8[start, end) 计算，缺省整段 */
  function crc16(u8, start, end) {
    var c = 0x0000;
    var s = (start === undefined) ? 0 : start;
    var e = (end === undefined) ? u8.length : end;
    for (var i = s; i < e; i++) {
      c = ((c << 8) & 0xFFFF) ^ CRC_TABLE[((c >> 8) ^ u8[i]) & 0xFF];
    }
    return c;
  }

  var DIR_APP2G = 0x3C, DIR_G2APP = 0x3E;
  var FMT_CMD = 0x1812, FMT_HB = 0x1815;
  var TYPE_CMD = 0x01, TYPE_RSP = 0x10;

  function buildFrame(dir, format, seq, type, cmd, payload) {
    payload = payload || [];
    var bodyLen = 2 + 2 + 1 + 1 + payload.length; /* FMT+SEQ+TYPE+CMD+PAYLOAD */
    var total = 4 + bodyLen + 2;
    var out = new Uint8Array(total);
    out[0] = 0x24;
    out[1] = dir & 0xFF;
    out[2] = bodyLen & 0xFF;                       /* LEN 小端：实测帧 24 3C 08 00 / 24 3E 0C 00 */
    out[3] = (bodyLen >> 8) & 0xFF;
    out[4] = (format >> 8) & 0xFF;
    out[5] = format & 0xFF;
    out[6] = (seq >> 8) & 0xFF;
    out[7] = seq & 0xFF;
    out[8] = type & 0xFF;
    out[9] = cmd & 0xFF;
    for (var i = 0; i < payload.length; i++) out[10 + i] = payload[i] & 0xFF;
    var crc = crc16(out, 4, 10 + payload.length);
    out[10 + payload.length] = crc & 0xFF;          /* 小端：低字节在前 */
    out[11 + payload.length] = (crc >> 8) & 0xFF;
    return out;
  }

  /* 字节流 → 完整帧；脏数据按字节前移重同步，半帧留待下次 push */
  function Parser() { this.buf = new Uint8Array(0); }
  Parser.MAX_BODY = 256;

  Parser.prototype.push = function (u8) {
    var merged = new Uint8Array(this.buf.length + u8.length);
    merged.set(this.buf);
    merged.set(u8, this.buf.length);
    this.buf = merged;

    var frames = [];
    var n = this.buf.length;
    var i = 0;
    var keepFrom = 0;
    while (i + 6 <= n) {
      if (this.buf[i] !== 0x24 ||
          (this.buf[i + 1] !== DIR_APP2G && this.buf[i + 1] !== DIR_G2APP)) {
        i++; keepFrom = i; continue;
      }
      if (i + 4 > n) break;
      /* LEN 实测为小端（24 3C 08 00 / 24 3E 0C 00）；兼容历史上按大端理解的数据，两者都试 */
      var leLen = this.buf[i + 2] | (this.buf[i + 3] << 8);
      var beLen = (this.buf[i + 2] << 8) | this.buf[i + 3];
      var cand = null, alt = null;
      if (leLen >= 6 && leLen <= Parser.MAX_BODY) {
        cand = leLen;
        if (beLen >= 6 && beLen <= Parser.MAX_BODY) alt = beLen;
      } else if (beLen >= 6 && beLen <= Parser.MAX_BODY) {
        cand = beLen;
      }
      if (cand === null) { i++; keepFrom = i; continue; }
      var total = 4 + cand + 2;
      if (i + total > n) break;
      var f = this.buf.subarray(i, i + total);
      var endPayload = 4 + cand;
      var crcGot = f[endPayload] | (f[endPayload + 1] << 8); /* 小端 */
      var okA = crc16(f, 4, endPayload) === crcGot;  /* FMT..PAYLOAD（实测口径） */
      var okB = crc16(f, 2, endPayload) === crcGot;  /* LEN..PAYLOAD（兼容口径） */
      if (!okA && !okB && alt !== null && i + 4 + alt + 2 <= n) {
        /* 小端候选 CRC 不过，试大端候选 */
        var f2 = this.buf.subarray(i, i + 4 + alt + 2);
        var end2 = 4 + alt;
        var crc2 = f2[end2] | (f2[end2 + 1] << 8);
        if (crc16(f2, 4, end2) === crc2 || crc16(f2, 2, end2) === crc2) {
          cand = alt; f = f2; endPayload = end2; okA = true;
        }
      }
      frames.push({
        dir: f[1],
        len: cand,
        format: (f[4] << 8) | f[5],
        seq: (f[6] << 8) | f[7],
        type: f[8],
        cmd: f[9],
        payload: new Uint8Array(f.subarray(10, endPayload)),
        raw: new Uint8Array(f),
        crcOk: okA || okB
      });
      i += 4 + cand + 2;
      keepFrom = i;
    }
    if (keepFrom > 0) this.buf = new Uint8Array(this.buf.subarray(keepFrom));
    return frames;
  };

  /* 官方 App 抓包实测的 app→gimbal 帧形（与本文件 buildFrame 的差异：序号只有 1 字节，后随固定 0x01）：
   *   24 3C <LEN:2B> 18 12 <inc:1B> 01 <cmd> <data…> <CRC16 小端>
   * 依据：petermaguire.xyz 抓包样例 24 3C 08 00 18 12 01 01 02 00 00 00 6F 76
   * （本仓库 crc16 对 FMT..data 计算 = 0x766F 已验证）+ bleebil 客户端同形构造 */
  var officialInc = 0;
  function buildOfficialFrame(cmd, data) {
    data = data || [0x00, 0x00, 0x00];   /* 官方帧的参数常为 3 字节（NO_ARGUMENT） */
    officialInc = (officialInc + 1) & 0xFF;
    var body = 2 + 1 + 1 + 1 + data.length;   /* FMT + inc + 0x01 + cmd + data */
    var out = new Uint8Array(4 + body + 2);
    out[0] = 0x24;
    out[1] = DIR_APP2G;
    out[2] = body & 0xFF;                       /* LEN 小端（同实测抓包 24 3C 08 00） */
    out[3] = (body >> 8) & 0xFF;
    out[4] = 0x18;
    out[5] = 0x12;
    out[6] = officialInc;
    out[7] = 0x01;
    out[8] = cmd & 0xFF;
    for (var i = 0; i < data.length; i++) out[9 + i] = data[i] & 0xFF;
    var crc = crc16(out, 4, 9 + data.length);
    out[9 + data.length] = crc & 0xFF;
    out[10 + data.length] = (crc >> 8) & 0xFF;
    return out;
  }
  /* 会话层：发命令、心跳保活、帧/按键事件分发（含重复包去重） */
  function Client(writeFn, opts) {
    opts = opts || {};
    this.writeFn = writeFn;               /* function(ArrayBuffer) -> Promise */
    this.onFrame = opts.onFrame || null;  /* function(frame) */
    this.onButton = opts.onButton || null;
    this.seq = (Math.random() * 0xFFFF) | 0;
    this.parser = new Parser();
    this._lastSig = null;
    this._lastSigAt = 0;
    this._hbTimer = null;
  }

  Client.prototype.send = function (cmd, payload, format) {
    this.seq = (this.seq + 1) & 0xFFFF;
    var frame = buildFrame(DIR_APP2G, format || FMT_CMD, this.seq, TYPE_CMD, cmd, payload);
    return this.writeFn(frame.buffer);
  };

  Client.prototype.heartbeat = function () {
    return this.send(0x80, [0, 0, 0, 0, 0, 0], FMT_HB);
  };

  Client.prototype.startHeartbeat = function (ms) {
    var self = this;
    this.stopHeartbeat();
    this._hbTimer = root.setInterval(function () {
      self.heartbeat().catch(function () {});
    }, ms || 1000);
  };

  Client.prototype.stopHeartbeat = function () {
    if (this._hbTimer) { root.clearInterval(this._hbTimer); this._hbTimer = null; }
  };

  Client.prototype.feed = function (data) {
    var u8 = (data instanceof Uint8Array) ? data : new Uint8Array(data);
    if (u8.length === 0) return [];
    /* notify 与轮询可能重复投递同一段字节，600ms 内去重 */
    var now = Date.now();
    var head = u8.length > 16 ? u8.subarray(0, 16) : u8;
    var sig = Array.prototype.join.call(head, ',');
    if (this._lastSig === sig && (now - this._lastSigAt) < 600) return [];
    this._lastSig = sig;
    this._lastSigAt = now;

    var frames = this.parser.push(u8);
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (this.onFrame) this.onFrame(f);
      if (this.onButton && f.dir === DIR_G2APP && f.cmd === 0x20) this.onButton(f);
    }
    return frames;
  };

  root.Zhiyun = {
    crc16: crc16,
    buildFrame: buildFrame,
    buildOfficialFrame: buildOfficialFrame,
    Parser: Parser,
    Client: Client,
    DIR_APP2G: DIR_APP2G,
    DIR_G2APP: DIR_G2APP,
    FMT_CMD: FMT_CMD,
    FMT_HB: FMT_HB,
    TYPE_CMD: TYPE_CMD,
    TYPE_RSP: TYPE_RSP
  };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).Zhiyun;
}
