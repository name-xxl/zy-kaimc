/* 参数菜单：相机 HAL 参数（白平衡/ISO/场景/效果/闪光灯/对焦/录像规格/照片尺寸/曝光补偿）
 * + 应用自带设置（自拍定时/连拍/间隔定时/构图辅助线）+ 关于页入口。
 * 由 main.js 组装上下文后调用 KaiMenu.open(ctx)；本模块不持有应用状态。 */
(function (root) {
  'use strict';

  var UI = root.KaiUI;
  var F = root.KaiFmt;
  var t = root.Strings.t;
  var tval = root.Strings.val;

  /* 录像规格去重优先级：同分辨率+码率只留一个（真机上高/默认/480p 都是 720×480@2Mbps） */
  var PROF_PREFER = ['default', 'high', '480p', 'low', 'qvga', 'cif', 'qcif'];

  function open(ctx) {
    var cam = ctx.cam;
    var caps = ctx.caps;
    var items = [];

    /* HAL 参数：←→ 改值 */
    function addCycle(labelKey, values, paramKey, fmt) {
      if (!values || !values.length) return;
      fmt = fmt || textOf;
      var item = {
        label: t(labelKey),
        valueText: fmt(cam.getParam(paramKey)),
        cycle: function (d) {
          var cur = cam.getParam(paramKey);
          var idx = values.indexOf(cur);
          idx = (idx === -1) ? 0 : (idx + d + values.length) % values.length;
          cam.setParam(paramKey, values[idx]);
          item.valueText = fmt(values[idx]);
          UI.refreshMenu();
        }
      };
      items.push(item);
    }

    /* 应用设置：离散选项列表 [{v, text}]，←→ 改值后交给 set */
    function addChoice(labelKey, list, get, set) {
      var idxOf = function (v) {
        for (var i = 0; i < list.length; i++) { if (list[i].v === v) return i; }
        return 0;
      };
      var item = {
        label: t(labelKey),
        valueText: list[idxOf(get())].text,
        cycle: function (d) {
          var idx = (idxOf(get()) + d + list.length) % list.length;
          set(list[idx].v);
          item.valueText = list[idx].text;
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

    function profKey(n) {
      var sz = (caps.recorderProfileSizes || {})[n] || n;
      return sz + '@' + ((caps.recorderProfileBps || {})[n] || 0);
    }

    /* 录像规格：按分辨率从大到小排序、同规格只留一个（←→ 沿画质走） */
    function profileValues() {
      var sz = caps.recorderProfileSizes || {};
      var px = function (n) { var m = /^(\d+)×(\d+)$/.exec(sz[n] || ''); return m ? (+m[1]) * (+m[2]) : 0; };
      var list = (caps.recorderProfiles || []).slice().sort(function (a, b) {
        var d = px(b) - px(a);
        if (d) return d;
        var ia = PROF_PREFER.indexOf(a), ib = PROF_PREFER.indexOf(b);
        ia = (ia < 0) ? PROF_PREFER.length : ia;
        ib = (ib < 0) ? PROF_PREFER.length : ib;
        return ia - ib || (a < b ? -1 : (a > b ? 1 : 0));
      });
      var kept = [], seen = {};
      list.forEach(function (n) {
        var k = profKey(n);
        if (seen[k]) return;
        seen[k] = 1;
        kept.push(n);
      });
      return kept;
    }

    /* 当前档位若被去重掉（如 high），切到等价的保留项，保证菜单与实际录制一致 */
    var profValues = profileValues();
    var curProf = cam.getParam('recorderProfile');
    if (curProf && profValues.indexOf(curProf) < 0) {
      for (var pj = 0; pj < profValues.length; pj++) {
        if (profKey(profValues[pj]) === profKey(curProf)) { cam.setParam('recorderProfile', profValues[pj]); break; }
      }
    }

    function profText(v) {
      if (v === undefined || v === null || v === '') return '-';
      var sz = (caps.recorderProfileSizes || {})[v];
      return tval(v) + (sz ? ' ' + sz : '');
    }

    addCycle('pWhiteBalance', caps.whiteBalanceModes, 'whiteBalance');
    addCycle('pIso', caps.isoModes, 'iso');
    addCycle('pScene', caps.sceneModes, 'scene');
    addCycle('pEffect', caps.effects, 'effect');
    addCycle('pFlash', caps.flashModes, 'flash');
    addCycle('pFocus', caps.focusModes, 'focus');
    addCycle('pProfile', profValues, 'recorderProfile', profText);

    if (caps.pictureSizes.length) {
      var sizes = caps.pictureSizes;
      var sizeItem = {
        label: t('pSize'),
        valueText: textOf(cam.getParam('pictureSize')),
        cycle: function (d) {
          var curStr = textOf(cam.getParam('pictureSize'));
          var idx = 0;
          for (var i = 0; i < sizes.length; i++) {
            if (sizes[i].width + '×' + sizes[i].height === curStr) { idx = i; break; }
          }
          idx = (idx + d + sizes.length) % sizes.length;
          cam.setParam('pictureSize', sizes[idx]);
          sizeItem.valueText = textOf(sizes[idx]);
          UI.refreshMenu();
        }
      };
      items.push(sizeItem);
    }

    if (ctx.ec.list.length) {
      var ecItem = {
        label: t('pEc'),
        valueText: F.fmtEc(ctx.ec.get()),
        cycle: function (d) {
          var list = ctx.ec.list;
          var idx = list.indexOf(ctx.ec.get());
          if (idx === -1) idx = list.indexOf(0);
          if (idx === -1) idx = 0;
          idx = (idx + d + list.length) % list.length;
          ctx.ec.set(list[idx]);
          ecItem.valueText = F.fmtEc(ctx.ec.get());
          UI.refreshMenu();
        }
      };
      items.push(ecItem);
    }

    /* ---- 应用自带设置 ---- */
    var shoot = ctx.shoot;
    var sec = t('kSec'), shots = t('kShots'), off = t('kOff');
    addChoice('pDelay', [
      { v: 0, text: off }, { v: 3, text: '3' + sec }, { v: 5, text: '5' + sec }, { v: 10, text: '10' + sec }
    ], function () { return shoot.get().delay; }, function (v) { shoot.set('delay', v); });
    addChoice('pBurst', [
      { v: 0, text: off }, { v: 3, text: '3' + shots }, { v: 5, text: '5' + shots }
    ], function () { return shoot.get().burst; }, function (v) { shoot.set('burst', v); });
    addChoice('pInterval', [
      { v: '0', text: off },
      { v: '5x3', text: '5' + sec + '×3' + shots },
      { v: '10x5', text: '10' + sec + '×5' + shots },
      { v: '30x10', text: '30' + sec + '×10' + shots }
    ], function () { return shoot.get().interval; }, function (v) { shoot.set('interval', v); });

    items.push({
      label: t('grid'),
      valueText: ctx.grid.text(),
      cycle: function (d) {
        ctx.grid.cycle(d);
        this.valueText = ctx.grid.text();
        UI.refreshMenu();
      }
    });
    items.push({
      label: t('about'),
      valueText: ctx.appVersion,
      open: function () { ctx.about.open(); }
    });

    UI.openMenu(items);
    UI.setSoftkeys(t('skBack'), t('skClose'), t('skMode'));
  }

  root.KaiMenu = { open: open };
})(typeof window !== 'undefined' ? window : globalThis);
