/* ZY-BLE 探针：扫描智云云台 → GATT 枚举 → notify + 轮询双路监听 → 屏显原始字节。
 * 用途：确认云鹤 M2 的特征 UUID、通知可用性、各按键的命令帧。 */
(function (root) {
  'use strict';

  var U = root.KaiUtil;
  var bt = root.KaiBt;
  var Z = root.Zhiyun;

  var S = {
    devices: {},
    order: [],
    sel: 0,
    stopScan: null,
    conn: null,
    client: null,
    pollTimer: null,
    hbOn: false,
    lastVals: {},
    connected: false
  };

  function log(msg) {
    var el = U.byId('log');
    var line = root.document.createElement('div');
    line.textContent = msg;
    el.appendChild(line);
    while (el.children.length > 300) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  function setStatus(s) { U.setText('status', s); }

  function shortUuid(u) {
    u = String(u || '').toLowerCase();
    var m = u.match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/);
    return m ? m[1] : u;
  }

  function eq(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* ---------- 扫描 ---------- */

  function startScan() {
    if (S.stopScan) { S.stopScan(); S.stopScan = null; }
    S.devices = {};
    S.order = [];
    S.sel = 0;
    setStatus('扫描中…（软左=重扫）');
    log('—— 开始扫描 LE 设备 ——');
    bt.startScan(function (d) {
      var isZY = /CRANE|M2|ZY|SMOOTH|WEEBILL/i.test(d.name);
      S.devices[d.address] = d;
      S.order.push(d.address);
      log('[' + S.order.length + '] ' + (isZY ? '★' : ' ') + ' ' +
        (d.name || '(无名)') + '  ' + d.address +
        (d.rssi === undefined || d.rssi === null ? '' : '  ' + d.rssi + 'dBm'));
      if (isZY) setStatus('发现智云设备 ' + d.name + '，↑↓ 选中后按 OK');
    }).then(function (h) {
      S.stopScan = h.stop;
    }).catch(function (e) {
      log('✗ 扫描失败: ' + e.message);
    });
  }

  function selMove(d) {
    if (S.connected || !S.order.length) return;
    S.sel = Math.min(S.order.length - 1, Math.max(0, S.sel + d));
    var addr = S.order[S.sel];
    setStatus('选择 [' + (S.sel + 1) + '] ' + (S.devices[addr].name || addr));
  }

  /* ---------- 连接 + 枚举 + 监听 ---------- */

  function connectSelected() {
    var addr = S.order[S.sel];
    var d = addr && S.devices[addr];
    if (!d) { log('✗ 先 ↑/↓ 选择设备，再按 OK 连接'); return; }
    if (S.stopScan) { S.stopScan(); S.stopScan = null; }
    log('连接 ' + (d.name || d.address) + ' …');
    bt.connect(d).then(function (con) {
      S.conn = con;
      S.connected = true;
      log('✓ GATT 已连接，服务 ' + con.services.length + ' 个：');
      con.services.forEach(function (s) {
        log('SVC ' + s.uuid);
        (s.characteristics || []).forEach(function (c) {
          var tag = '';
          if (con.writeChar && c.uuid === con.writeChar.uuid) tag += ' ←智云写特征';
          if (con.notifyChar && c.uuid === con.notifyChar.uuid) tag += ' ←智云通知特征';
          log('  CHR ' + c.uuid + tag);
        });
      });
      if (con.fee9 && con.writeChar && con.notifyChar) {
        log('✓ 匹配到智云 fee9 特征对，协议与 Weebill-S 同源');
      } else {
        log('⚠ 未匹配到 fee9 写/通知特征对（M2 协议可能不同，把上面服务清单记下来）');
      }
      S.client = new Z.Client(function (buf) { return bt.write(con, buf); }, {
        onFrame: function (f) {
          log('[IN] ' + U.hex(f.raw) + (f.crcOk ? '' : '  ✗CRC') +
            '  cmd=0x' + f.cmd.toString(16) + ' type=' + f.type);
        },
        onButton: function (f) {
          log('>>> 按键事件 cmd=0x20  payload=' + U.hex(f.payload));
        }
      });
      log('现在按云台上的按键（快门/模式，短按+长按各来几次），观察 [IN] 行');
      return bt.armNotifications(con, function (v) {
        S.client.feed(v);
        log('[IN/NOTIFY] ' + U.hex(new Uint8Array(v)));
      }).then(function () {
        log('notify 已开启（若按键时无 NOTIFY 行 → 实机不支持通知，靠下方 POLL 轮询）');
      }).catch(function (e) {
        log('notify 开启失败(' + e.message + ')，仅靠 POLL 轮询');
      });
    }).then(function () {
      dumpAllChars();
      startPoll();
      log('轮询已启动(100ms)。按 5=发心跳 6=读电量 *=自动心跳 开/关');
      var addr2 = S.order[S.sel];
      setStatus('已连接 ' + (S.devices[addr2] ? (S.devices[addr2].name || addr2) : ''));
    }).catch(function (e) {
      log('✗ 连接失败: ' + (e && e.message));
      setStatus('连接失败');
    });
  }

  /* 连接后把每个特征读一遍，作为基线 */
  function dumpAllChars() {
    var con = S.conn;
    if (!con) return;
    con.services.forEach(function (s) {
      (s.characteristics || []).forEach(function (c) {
        U.prom(c.readValue()).then(function () {
          var v = new Uint8Array(c.value || []);
          log('[INIT] ' + shortUuid(c.uuid) + ' = ' + (v.length ? U.hex(v) : '(空)'));
          S.lastVals[c.uuid] = v;
        }).catch(function () { /* 不可读特征 */ });
      });
    });
  }

  /* 轮询兜底：100ms 读 fee9 特征，变化才上报 */
  function startPoll() {
    if (S.pollTimer) root.clearInterval(S.pollTimer);
    S.pollTimer = root.setInterval(function () {
      var con = S.conn;
      if (!con) return;
      if (con.gatt.connected === false) { log('✗ GATT 断开'); cleanup(); return; }
      if (!con.fee9) return;
      (con.fee9.characteristics || []).forEach(function (c) {
        U.prom(c.readValue()).then(function () {
          var v = new Uint8Array(c.value || []);
          if (!v.length) return;
          var prev = S.lastVals[c.uuid];
          if (prev && !eq(prev, v)) {
            log('[POLL] ' + shortUuid(c.uuid) + ': ' + U.hex(v));
            if (S.client) S.client.feed(v);
          }
          if (!prev || !eq(prev, v)) S.lastVals[c.uuid] = v;
        }).catch(function () { /* 不可读 */ });
      });
    }, 100);
  }

  function toggleHeartbeat() {
    if (!S.client) return;
    if (S.hbOn) {
      S.client.stopHeartbeat();
      S.hbOn = false;
      log('自动心跳已关');
    } else {
      S.client.startHeartbeat(1000);
      S.hbOn = true;
      log('自动心跳已开（1s，按 0x80/0x1815）');
    }
  }

  function cleanup() {
    if (S.pollTimer) { root.clearInterval(S.pollTimer); S.pollTimer = null; }
    if (S.client) S.client.stopHeartbeat();
    if (S.stopScan) { S.stopScan(); S.stopScan = null; }
    bt.disconnect(S.conn);
    S.conn = null;
    S.client = null;
    S.connected = false;
    setStatus('已断开（软左=重扫）');
  }

  /* ---------- 按键 ---------- */

  root.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'ArrowUp') { scrollLog(-60); selMove(-1); e.preventDefault(); return; }
    if (k === 'ArrowDown') { scrollLog(60); selMove(1); e.preventDefault(); return; }
    if (k === 'Enter') {
      if (!S.connected) connectSelected();
      return;
    }
    if (k === 'SoftLeft') { startScan(); return; }
    if (k === 'SoftRight') { U.byId('log').textContent = ''; return; }
    if (k === '5' && S.client) {
      S.client.heartbeat().then(function () { log('[OUT] 心跳帧已发'); })
        .catch(function (e2) { log('✗ 发送失败: ' + e2.message); });
      return;
    }
    if (k === '6' && S.client) {
      S.client.send(0x06, []).then(function () { log('[OUT] 电量请求(0x06)已发'); })
        .catch(function (e2) { log('✗ 发送失败: ' + e2.message); });
      return;
    }
    if (k === '*') { toggleHeartbeat(); return; }
    if (k === 'Backspace') {
      e.preventDefault();
      cleanup();
      try { root.close(); } catch (e2) { /* 非脚本可关时忽略 */ }
    }
  });

  function scrollLog(dy) {
    var el = U.byId('log');
    if (el) el.scrollTop += dy;
  }

  /* ---------- 启动 ---------- */

  root.addEventListener('load', function () {
    log('ZY-BLE 探针 — 云鹤 M2 协议抓取');
    log('1) 云台开机，靠近手机，别让 ZY Cami 占用它');
    log('2) 等待扫描列出 CRANE-M2-XXXX（★ 标记）');
    log('3) ↑/↓ 选中 → 按 OK 连接');
    log('4) 按云台按键，把 [IN] 行字节抄到 docs/protocol.md');
    bt.init().then(function () {
      return bt.ensureEnabled();
    }).then(function () {
      log('✓ 蓝牙适配器就绪');
      startScan();
    }).catch(function (e) {
      log('✗ 蓝牙初始化失败: ' + e.message);
      setStatus('蓝牙不可用');
    });
  });
})(typeof window !== 'undefined' ? window : globalThis);
