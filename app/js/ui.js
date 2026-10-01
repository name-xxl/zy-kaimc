/* UI 基础：软键、HUD（顶栏药丸 + 底栏单条信息条）、toast、中央提示块（启动/倒计时/进度）、
 * 快门白闪、菜单与关于页渲染（键盘驱动） */
(function (root) {
  'use strict';

  var U = root.KaiUtil;

  var UI = {};
  var menuItems = [];
  var menuIdx = 0;

  UI.init = function () {
    U.setText('menu-title', root.Strings.t('menuTitle'));
  };

  /* 供上层注册：菜单选中项变化时回调（用于动态设置中键文案/动作） */
  UI.onMenuSel = null;

  UI.setSoftkeys = function (left, center, right) {
    U.setText('sk-left', left || '');
    U.setText('sk-center', center || '');
    U.setText('sk-right', right || '');
  };

  UI.showView = function (name) {
    U.show('finder-view', name === 'finder');
    U.show('menu-view', name === 'menu');
    U.show('about-view', name === 'about');
  };

  UI.aboutActive = function () {
    var el = U.byId('about-view');
    return el && !el.classList.contains('hidden');
  };

  /* 关于页内容（版本号 / 项目地址 / 运行环境），由调用方给版本号 */
  UI.renderAbout = function (ver) {
    U.setText('about-title', root.Strings.t('aboutTitle'));
    var body = U.byId('about-body');
    if (!body) return;
    body.textContent = '';
    var rows = [
      [root.Strings.t('aboutVer'), ver, ''],
      [root.Strings.t('aboutRepo'), 'github.com/name-xxl/zy-kaimc', 'url'],
      [root.Strings.t('aboutEnv'), 'KaiOS 2.5 · Nokia 2720', '']
    ];
    rows.forEach(function (r) {
      var div = root.document.createElement('div');
      div.className = 'about-row';
      var k = root.document.createElement('span');
      k.className = 'k';
      k.textContent = r[0];
      var v = root.document.createElement('span');
      v.className = 'v' + (r[2] ? ' ' + r[2] : '');
      v.textContent = r[1];
      div.appendChild(k);
      div.appendChild(v);
      body.appendChild(div);
    });
  };

  /* 顶部：三枚药丸（状态/录像/模式），保持原样式。
   * 底部：**一条贯穿全宽的信息条**（左参数、右变焦），两者都空时整条隐藏——
   * 不再出现"两块分离黑底 + 中间一道缝"的观感 */
  var bottom = { param: '', zoom: '' };

  UI.hud = function (o) {
    if ('ble' in o) { U.setText('hud-ble', o.ble); U.show('hud-ble', !!o.ble); }
    if ('mode' in o) U.setText('hud-mode', o.mode);
    if ('rec' in o) { U.setText('hud-rec', o.rec); U.show('hud-rec', !!o.rec); }
    if ('param' in o || 'zoom' in o) {
      if ('param' in o) bottom.param = o.param || '';
      if ('zoom' in o) bottom.zoom = o.zoom || '';
      U.setText('hud-param', bottom.param);
      U.setText('hud-zoom', bottom.zoom);
      U.show('hud-bottom', !!(bottom.param || bottom.zoom));
    }
  };

  /* 中央提示块：启动信息 / 倒计时 / 拍摄进度；只给需要显示的字段 */
  UI.splash = function (o) {
    o = o || {};
    U.setText('splash-title', o.title || '');
    U.setText('splash-big', o.big || '');
    U.setText('splash-sub', o.sub || '');
    U.setText('splash-hint', o.hint || '');
    U.show('splash-title', !!o.title);
    U.show('splash-big', !!o.big);
    U.show('splash-sub', !!o.sub);
    U.show('splash-hint', !!o.hint);
    var el = U.byId('splash');
    if (el) el.classList.remove('fade');
    U.show('splash', !!(o.title || o.big || o.sub || o.hint));
  };

  UI.splashHide = function (fade) {
    var el = U.byId('splash');
    if (!el) return;
    if (fade) {
      el.classList.add('fade');
      root.setTimeout(function () { U.show('splash', false); el.classList.remove('fade'); }, 320);
    } else {
      U.show('splash', false);
    }
  };

  UI.toast = function (msg, ms) {
    var el = U.byId('toast');
    if (!el) return;
    el.textContent = msg;
    U.show('toast', true);
    root.clearTimeout(UI._toastTimer);
    UI._toastTimer = root.setTimeout(function () { U.show('toast', false); }, ms || 1800);
  };

  UI.flash = function () {
    var el = U.byId('flash-overlay');
    if (!el) return;
    el.classList.add('on');
    root.setTimeout(function () { el.classList.remove('on'); }, 70);
  };

  UI.openMenu = function (items) {
    menuItems = items;
    menuIdx = 0;
    UI._renderMenu();
    UI.showView('menu');
  };

  UI.closeMenu = function () {
    UI.showView('finder');
  };

  UI.menuActive = function () {
    var el = U.byId('menu-view');
    return el && !el.classList.contains('hidden');
  };

  /* 菜单内的按键处理；返回是否已消费 */
  UI.menuKey = function (key) {
    if (!menuItems.length) return false;
    if (key === 'ArrowUp') {
      menuIdx = (menuIdx - 1 + menuItems.length) % menuItems.length;
      UI._renderMenu();
      return true;
    }
    if (key === 'ArrowDown') {
      menuIdx = (menuIdx + 1) % menuItems.length;
      UI._renderMenu();
      return true;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      var it = menuItems[menuIdx];
      if (it && it.cycle) {
        it.cycle(key === 'ArrowRight' ? 1 : -1);
        UI._renderMenu();
      }
      return true;
    }
    return false;
  };

  UI._renderMenu = function () {
    var ul = U.byId('menu-list');
    if (!ul) return;
    ul.textContent = '';
    menuItems.forEach(function (it, i) {
      var li = root.document.createElement('li');
      if (i === menuIdx) li.className = 'sel';
      var name = root.document.createElement('span');
      name.textContent = it.label;
      var val = root.document.createElement('span');
      val.textContent = it.valueText || '';
      li.appendChild(name);
      li.appendChild(val);
      ul.appendChild(li);
    });
    var sel = ul.children[menuIdx];
    if (sel) ul.scrollTop = sel.offsetTop - ul.clientHeight / 2;
    /* 选中项变化时通知上层（软键文案要跟着变：只有可进入的项才显示"进入"） */
    if (UI.onMenuSel) UI.onMenuSel(menuItems[menuIdx] || null);
  };

  UI.refreshMenu = UI._renderMenu;

  /* 当前选中的菜单项（用于 Enter 进入二级页，如"关于"） */
  UI.selectedItem = function () {
    return menuItems[menuIdx] || null;
  };

  root.KaiUI = UI;
})(typeof window !== 'undefined' ? window : globalThis);
