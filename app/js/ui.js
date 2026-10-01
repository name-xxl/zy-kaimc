/* UI 基础：软键、HUD、toast、快门白闪、参数菜单（键盘驱动） */
(function (root) {
  'use strict';

  var U = root.KaiUtil;

  var UI = {};
  var menuItems = [];
  var menuIdx = 0;

  UI.init = function () {
    U.setText('menu-title', root.Strings.t('menuTitle'));
  };

  UI.setSoftkeys = function (left, center, right) {
    U.setText('sk-left', left || '');
    U.setText('sk-center', center || '');
    U.setText('sk-right', right || '');
  };

  UI.showView = function (name) {
    U.show('finder-view', name === 'finder');
    U.show('menu-view', name === 'menu');
  };

  UI.hud = function (o) {
    if ('ble' in o) { U.setText('hud-ble', o.ble); U.show('hud-ble', !!o.ble); }
    if ('mode' in o) U.setText('hud-mode', o.mode);
    if ('rec' in o) { U.setText('hud-rec', o.rec); U.show('hud-rec', !!o.rec); }
    if ('param' in o) { U.setText('hud-param', o.param); U.show('hud-param', !!o.param); }
    if ('zoom' in o) { U.setText('hud-zoom', o.zoom); U.show('hud-zoom', !!o.zoom); }
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
  };

  UI.refreshMenu = UI._renderMenu;

  root.KaiUI = UI;
})(typeof window !== 'undefined' ? window : globalThis);
