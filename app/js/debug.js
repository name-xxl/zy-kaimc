/* 屏幕调试面板：环形日志（60 条）+ 面板开关 / 翻页 / 渲染。
 * 只显示最近 7 条且**最新在最上面**（240×320 装不下更多，最新的一定可见）；
 * 面板打开时 ↑ 往旧翻、↓ 往回翻。外部只需 Dbg.log(msg)。 */
(function (root) {
  'use strict';

  var U = root.KaiUtil;
  var PAGE = 7;
  var KEEP = 60;
  var HEAD = '# 日志（↑旧 ↓新 #关）';

  var buf = [];
  var on = false;
  var scroll = 0;
  var getExtra = null;   /* 额外日志来源（如相机日志），由 init 注入 */

  function maxScroll(total) {
    return Math.max(0, Math.ceil(total / PAGE) - 1);
  }

  function allLines() {
    var extra = [];
    try { extra = getExtra ? (getExtra() || []) : []; } catch (e) { /* 取不到就算 */ }
    return extra.concat(buf);
  }

  var Dbg = {
    /* opts.getExtra(): 返回一组“较早的”日志行（相机侧日志） */
    init: function (opts) {
      getExtra = (opts && opts.getExtra) || null;
    },

    log: function (msg) {
      buf.push(root.KaiFmt.fmtClock() + ' ' + msg);
      if (buf.length > KEEP) buf.shift();
      try { root.console.log('[app] ' + msg); } catch (e) { /* 无 console */ }
      Dbg.render();
    },

    active: function () { return on; },

    toggle: function () {
      on = !on;
      scroll = 0;
      Dbg.render();
    },

    /* ↑ 往旧翻（d=+1）、↓ 往回翻（d=-1） */
    scrollBy: function (d) {
      if (!on) return;
      var total = allLines().length;
      scroll = Math.max(0, Math.min(maxScroll(total), scroll + d));
      Dbg.render();
    },

    render: function () {
      var el = U.byId('debug');
      if (!el) return;
      if (!on) { el.textContent = ''; U.show('debug', false); return; }
      U.show('debug', true);
      var lines = allLines();
      var off = Math.min(scroll, maxScroll(lines.length));
      scroll = off;
      var end = Math.max(0, lines.length - off * PAGE);
      var start = Math.max(0, end - PAGE);
      var head = off ? HEAD.replace('#关', '-' + off + '页 #关') : HEAD;
      el.textContent = head + '\n' + lines.slice(start, end).reverse().join('\n');
    }
  };

  root.KaiDbg = Dbg;
})(typeof window !== 'undefined' ? window : globalThis);
