/* 构图辅助线：关 / 九宫格 / 黄金分割 / 中心十字 / 对角线。
 * 自包含：状态 + localStorage 持久化 + 叠加层绘制（* 键或参数菜单循环切换）。 */
(function (root) {
  'use strict';

  var U = root.KaiUtil;

  var KEY = 'zyGrid';
  var MODES = ['off', 'thirds', 'golden', 'cross', 'diag'];
  var LABELS = {
    off: 'gridOff', thirds: 'gridThirds', golden: 'gridGolden', cross: 'gridCross', diag: 'gridDiag'
  };
  /* 各模式的线位（百分比）：对角线单独处理（渐变绘制，随宽高比自适应） */
  var LINES = {
    thirds: [33.333, 66.667],
    golden: [38.2, 61.8],
    cross: [50]
  };

  var mode = 'off';

  /* 纯函数：上/下一种模式（d=+1 下一种、-1 上一种，两端绕圈）——便于单测 */
  function next(m, d) {
    var n = MODES.length;
    var i = MODES.indexOf(m);
    if (i < 0) i = 0;
    return MODES[((i + (d || 1)) % n + n) % n];
  }

  function mk(el, cls, style) {
    var d = root.document.createElement('div');
    d.className = cls;
    if (style) d.setAttribute('style', style);
    el.appendChild(d);
  }

  var Grid = {
    MODES: MODES,
    next: next,

    /* 读持久化设置（含 v8.2 的布尔值升级） */
    load: function () {
      try {
        var v = root.localStorage && root.localStorage.getItem(KEY);
        if (v === '1' || v === 'true') v = 'thirds';
        mode = (MODES.indexOf(v) >= 0) ? v : 'off';
      } catch (e) { mode = 'off'; }
      return mode;
    },

    mode: function () { return mode; },

    /* 当前模式的显示名 */
    text: function () { return root.Strings.t(LABELS[mode] || 'gridOff'); },

    /* 切到上/下一种；视觉变化本身够明显，不弹提示 */
    cycle: function (d) {
      mode = next(mode, d);
      try { root.localStorage.setItem(KEY, mode); } catch (e) { /* 无存储 */ }
      Grid.apply();
    },

    /* 把当前模式画到 #grid-overlay（清空重建，规模小、调用少） */
    apply: function () {
      var el = U.byId('grid-overlay');
      if (!el) return;
      el.textContent = '';
      if (mode === 'off') { U.show('grid-overlay', false); return; }
      if (mode === 'diag') {
        mk(el, 'gdiag1');
        mk(el, 'gdiag2');
      } else {
        (LINES[mode] || LINES.thirds).forEach(function (p) {
          mk(el, 'gv', 'left:' + p + '%');
          mk(el, 'gh', 'top:' + p + '%');
        });
      }
      U.show('grid-overlay', true);
    }
  };

  root.KaiGrid = Grid;
})(typeof window !== 'undefined' ? window : globalThis);
