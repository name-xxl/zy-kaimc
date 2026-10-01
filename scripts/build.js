#!/usr/bin/env node
/* 构建：语法检查 → manifest 校验 → 悬空成员/i18n/HTML 脚本图检查 → 协议自测
 * → 共享 JS 漂移检查与同步 → 单元/会话测试 → 版本一致性 → 打包 zip。
 * 纯 Node，无第三方依赖。zip 用 Windows 自带 bsdtar（条目名为正斜杠）。 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const rootDir = path.resolve(__dirname, '..');

let fail = 0;
function check(ok, msg) {
  console.log((ok ? '✓ ' : '✗ ') + msg);
  if (!ok) fail = 1;
}

function listJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).forEach((f) => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile() && f.endsWith('.js')) out.push(p);
  });
  return out;
}

/* 1) 语法检查 */
[...listJs(path.join(rootDir, 'app/js')), ...listJs(path.join(rootDir, 'tools/probe/js'))]
  .forEach((f) => {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
      console.log('✓ 语法 ' + path.relative(rootDir, f));
    } catch (e) {
      check(false, '语法 ' + path.relative(rootDir, f) + '\n' + e.stderr);
    }
  });

/* 2) manifest JSON 校验 */
['app/manifest.webapp', 'tools/probe/manifest.webapp'].forEach((rel) => {
  try {
    JSON.parse(fs.readFileSync(path.join(rootDir, rel), 'utf8'));
    console.log('✓ manifest ' + rel);
  } catch (e) {
    check(false, 'manifest ' + rel + ': ' + e.message);
  }
});

/* 2b) 悬空成员检查：模块导出的成员 vs 全仓库的成员访问
 * （专治"函数被删、调用还在"——历史上 U.withTimeout 被误删导致相机卡启动中） */
(function danglingMembers() {
  const readSrc = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');
  /* 注释剥离但保持索引对齐（注释里的换行换成空行），这样行号能直接算准 */
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  function namesOf(re, src) {
    const out = new Set();
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
    return out;
  }
  const utilSrc = readSrc('app/js/util.js');
  const bleSrc = readSrc('app/js/ble.js');
  const uiSrc = readSrc('app/js/ui.js');
  const btnSrc = readSrc('app/js/buttons.js');
  const sessSrc = readSrc('app/js/session.js');
  const camSrc = readSrc('app/js/camera.js');
  const cfgSrc = readSrc('app/js/config.js');
  const zSrc = readSrc('app/js/zhiyun.js');
  const fmtSrc = readSrc('app/js/format.js');
  const gridSrc = readSrc('app/js/grid.js');
  const dbgSrc = readSrc('app/js/debug.js');
  const menuSrc = readSrc('app/js/menu.js');
  const cfgBody = (/var C = \{([\s\S]*?)\n  \};/.exec(cfgSrc) || ['', ''])[1];
  const zExport = (/root\.Zhiyun = \{([\s\S]*?)\n  \};/.exec(zSrc) || ['', ''])[1];
  /* 模块既可能用 X.y = … 定义，也可能是 var X = { k: … } 字面量，或 root.KaiX = { k: … } 导出别名，
   * 三种写法都收集 */
  const objKeys = (src, name) => {
    const body = (new RegExp('var ' + name + ' = \\{([\\s\\S]*?)\\n  \\};').exec(src) || ['', ''])[1];
    return namesOf(/^\s*([\w$]+)\s*:/gm, body);
  };
  const exportKeys = (src) => {
    const out = [];
    let m;
    const re = /root\.\w+\s*=\s*\{([^}]*)\};/g;
    while ((m = re.exec(src)) !== null) {
      let k;
      const reK = /([\w$]+)\s*:/g;
      while ((k = reK.exec(m[1])) !== null) out.push(k[1]);
    }
    return out;
  };
  const membersOf = (src, name, assignRe) =>
    new Set([...namesOf(assignRe, src), ...objKeys(src, name), ...exportKeys(src)]);
  const known = {
    U: membersOf(utilSrc, 'U', /U\.([\w$]+)\s*=/g),
    UI: membersOf(uiSrc, 'UI', /UI\.([\w$]+)\s*=/g),
    Buttons: membersOf(btnSrc, 'B', /B\.([\w$]+)\s*=/g),
    AppCfg: new Set([...namesOf(/([\w$]+)\s*:/g, cfgBody), ...objKeys(cfgSrc, 'C')]),
    Session: new Set([...namesOf(/Session\.prototype\.([\w$]+)\s*=/g, sessSrc), ...namesOf(/this\.([\w$]+)\s*=/g, sessSrc)]),
    bt: new Set([...namesOf(/Bt\.prototype\.([\w$]+)\s*=/g, bleSrc), ...namesOf(/this\.([\w$]+)\s*=/g, bleSrc)]),
    Z: namesOf(/([\w$]+)\s*:/g, zExport),
    cam: new Set([...namesOf(/Cam\.prototype\.([\w$]+)\s*=/g, camSrc), ...namesOf(/this\.([\w$]+)\s*=/g, camSrc)]),
    F: membersOf(fmtSrc, 'F', /F\.([\w$]+)\s*=/g),
    Grid: membersOf(gridSrc, 'Grid', /Grid\.([\w$]+)\s*=/g),
    Dbg: membersOf(dbgSrc, 'Dbg', /Dbg\.([\w$]+)\s*=/g),
    Menu: membersOf(menuSrc, 'Menu', /Menu\.([\w$]+)\s*=/g),
    Strings: new Set(['t', 'val', 'LANG'])
  };
  const reUse = /\b(U|UI|Buttons|AppCfg|Session|bt|Z|cam|F|Grid|Dbg|Menu|Strings)\.([A-Za-z_$][\w$]*)/g;
  const bad = [];
  [...listJs(path.join(rootDir, 'app/js')), ...listJs(path.join(rootDir, 'tools/probe/js'))].forEach((f) => {
    const raw = fs.readFileSync(f, 'utf8');
    const src = strip(raw);
    let m;
    reUse.lastIndex = 0;
    while ((m = reUse.exec(src)) !== null) {
      const alias = m[1];
      const name = m[2];
      if (name === 'prototype') continue;   /* 定义行本身（Session.prototype.x = …） */
      const tail = src.slice(m.index + m[0].length);
      if (/^\s*(=[^=]|:)/.test(tail)) continue;  /* 赋值/键值：是定义不是访问 */
      if (known[alias] && known[alias].has(name)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      bad.push(path.relative(rootDir, f) + ':' + line + '  ' + alias + '.' + name);
    }
  });
  const uniq = [...new Set(bad)];
  check(uniq.length === 0, '悬空成员检查（各模块成员访问均有定义）' +
    (uniq.length ? '：\n    ' + uniq.slice(0, 12).join('\n    ') : ''));
})();

/* 3) 协议自测 */
try {
  const Z = require(path.join(rootDir, 'app/js/zhiyun.js'));
  const v = new Uint8Array(Buffer.from('123456789', 'utf8'));
  check(Z.crc16(v) === 0x31C3, 'CRC16/XMODEM 标准向量 "123456789" → 0x31C3');

  /* Weebill-S 实测心跳帧样例（petermaguire.xyz 逆向文档）：CRC=0x4B98，帧内小端存放 98 4B */
  const sample = [0x24, 0x3E, 0x00, 0x0C, 0x18, 0x15, 0x08, 0x00, 0x01, 0x80, 0x50, 0x10, 0xC2, 0x01, 0x00, 0x00, 0x98, 0x4B];
  const gotA = Z.crc16(new Uint8Array(sample.slice(4, 16)));
  check(gotA === 0x4B98 && sample[16] === 0x98 && sample[17] === 0x4B,
    '心跳样例 CRC（FMT..PAYLOAD=0x' + gotA.toString(16) + '，小端应存 98 4B）');
  const parsed = new Z.Parser().push(new Uint8Array(sample));
  check(parsed.length === 1 && parsed[0].crcOk && parsed[0].cmd === 0x80 &&
    parsed[0].format === Z.FMT_HB && parsed[0].payload.length === 6,
    '真实心跳样例经 Parser 解析（crcOk、cmd=0x80）');

  const f = Z.buildOfficialFrame(0x20, [0xC0, 0x3C, 0x00]);
  const frames = new Z.Parser().push(f);
  check(frames.length === 1 && frames[0].cmd === 0x20 && frames[0].crcOk &&
    frames[0].payload[0] === 0xC0 && frames[0].payload[2] === 0x00,
    '帧编解码回环（按键帧 0x20 / c0 3c 00）');
  check(frames[0].type === 0x01 && frames[0].format === Z.FMT_CMD,
    '官方帧字段（flag=0x01, FMT=0x1812）');

  /* 抓包回归：云台按键上报帧与初始化应答帧（ZY Play btsnoop 实录） */
  const capBtn = new Uint8Array([0x24, 0x3C, 0x08, 0x00, 0x18, 0x12, 0x01, 0x10, 0x20, 0xC0, 0x3D, 0x00, 0x7C, 0x57]);
  const cb = new Z.Parser().push(capBtn);
  check(cb.length === 1 && cb[0].crcOk && cb[0].cmd === 0x20 && cb[0].type === 0x10 &&
    cb[0].payload[0] === 0xC0 && cb[0].payload[1] === 0x3D,
    '抓包按键帧解析（cmd=0x20 flag=0x10 c0 3d 00）');
  let btnHits = 0;
  const cli = new Z.Client(function () { return Promise.resolve(); }, { onButton: function () { btnHits++; } });
  cli.feed(capBtn);
  check(btnHits === 1, 'onButton 触发（cmd=0x20，忽略 dir=0x3C）');

  const p2 = new Z.Parser();
  const a = p2.push(f.subarray(0, 5));
  const b = p2.push(f.subarray(5));
  check(b.length === 1 && b[0].cmd === 0x20 && a.length === 0, '半帧分包解析');

  const garbage = new Uint8Array([0x00, 0x99, 0x24, 0x3C, 0x00, 0x06, 0x18, 0x12]);
  const p3 = new Z.Parser();
  p3.push(garbage);
  const c3 = p3.push(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xAA, 0xBB, 0x24, 0x3E]));
  check(Array.isArray(c3), '脏数据重同步不抛异常');
} catch (e) {
  check(false, '协议自测异常: ' + e.message);
}

/* 3b) i18n 检查：zh/en 键集合一致、静态 t('…') 的键存在、未使用的键给出提醒 */
(function i18nCheck() {
  const src = fs.readFileSync(path.join(rootDir, 'app/js/strings.js'), 'utf8');
  const dictOf = (lang) => {
    const re = new RegExp(lang + ":\\s*\\{([\\s\\S]*?)\\n    \\}");
    const body = (re.exec(src) || ['', ''])[1];
    const keys = new Set();
    let m;
    const reKey = /^\s*'?([A-Za-z_$][\w$-]*)'?\s*:/gm;
    while ((m = reKey.exec(body)) !== null) keys.add(m[1]);
    return keys;
  };
  const zh = dictOf('zh');
  const en = dictOf('en');
  const onlyZh = [...zh].filter((k) => !en.has(k));
  const onlyEn = [...en].filter((k) => !zh.has(k));
  check(onlyZh.length === 0 && onlyEn.length === 0,
    'i18n 键集合一致（zh ' + zh.size + ' / en ' + en.size + '）' +
    (onlyZh.length ? '：仅 zh 有 ' + onlyZh.join(',') : '') +
    (onlyEn.length ? '：仅 en 有 ' + onlyEn.join(',') : ''));

  /* 收集全仓用到的键：t('x') / addCycle('x') 等字面量；以及字符串里出现的字典键名 */
  const files = [...listJs(path.join(rootDir, 'app/js')), ...listJs(path.join(rootDir, 'tools/probe/js'))]
    .filter((f) => !f.endsWith('strings.js'));
  const used = new Set();
  const missing = [];
  files.forEach((f) => {
    const raw = fs.readFileSync(f, 'utf8');
    let m;
    const reT = /\bt\(\s*'([^']+)'\s*\)/g;
    while ((m = reT.exec(raw)) !== null) {
      const k = m[1];
      used.add(k);
      if (!zh.has(k)) missing.push(path.relative(rootDir, f) + '  t(' + k + ')');
    }
    /* GRID_LABELS 这类"键名写在映射表里"的用法：只要字面量恰好是字典键就算用到 */
    const reAny = /'([A-Za-z_$][\w$-]*)'/g;
    while ((m = reAny.exec(raw)) !== null) { if (zh.has(m[1])) used.add(m[1]); }
  });
  check(missing.length === 0, 'i18n 键都存在（未定义：' + (missing.length ? '\n    ' + missing.join('\n    ') : '0') + '）');

  const unused = [...zh].filter((k) => !used.has(k));
  if (unused.length) console.log('· 提醒：以下 i18n 键暂未被引用（可删）：' + unused.join(', '));
})();

/* 4) 共享 JS 同步到探针：先比对再复制——探针侧若有未同步的改动会当场失败，
 * 不再被静默覆盖（同步基线记在 tools/probe/.sync-state.json） */
(function syncShared() {
  const shared = ['config.js', 'util.js', 'ble.js', 'session.js', 'buttons.js', 'zhiyun.js'];
  const stateFile = path.join(rootDir, 'tools/probe/.sync-state.json');
  let baseline = {};
  try { baseline = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { baseline = {}; }
  const sha = (p) => require('crypto').createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  const drifted = [];
  shared.forEach((f) => {
    const probeFile = path.join(rootDir, 'tools/probe/js', f);
    if (baseline[f] && fs.existsSync(probeFile) && sha(probeFile) !== baseline[f]) drifted.push(f);
  });
  check(drifted.length === 0,
    '共享 JS 无探针侧漂移（基线来自上次同步）' +
    (drifted.length ? '：' + drifted.join(',') + ' 在探针侧被改过；要保留请先搬回 app/js' : ''));
  const next = {};
  shared.forEach((f) => {
    fs.copyFileSync(path.join(rootDir, 'app/js', f), path.join(rootDir, 'tools/probe/js', f));
    next[f] = sha(path.join(rootDir, 'tools/probe/js', f));
  });
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2) + '\n');
  console.log('✓ 共享 JS 已同步到 tools/probe/js（基线已更新）');
})();

/* 4b) HTML 脚本图检查：脚本文件都存在、顺序满足依赖、app/js 下的文件都被引到 */
(function scriptGraph() {
  const order = ['config.js', 'util.js', 'format.js', 'strings.js', 'zhiyun.js', 'ble.js', 'session.js',
    'buttons.js', 'camera.js', 'ui.js', 'grid.js', 'debug.js', 'menu.js', 'main.js'];
  ['app/index.html', 'tools/probe/index.html'].forEach((rel) => {
    const html = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    const srcs = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map((m) => m[1]);
    const missing = srcs.filter((s) => !fs.existsSync(path.join(rootDir, path.dirname(rel), 'js', s)));
    check(missing.length === 0 && srcs.length > 0,
      rel + ' 脚本文件都存在（' + srcs.length + ' 个）' + (missing.length ? '：缺 ' + missing.join(',') : ''));
    const idx = (f) => srcs.indexOf(f);
    if (rel === 'app/index.html') {
      check(idx('main.js') === srcs.length - 1, 'app 的 main.js 在脚本序列最后');
      const bad = order.filter((f, i) => i > 0 && idx(order[i - 1]) > idx(f) && idx(f) !== -1);
      check(bad.length === 0, 'app 脚本顺序满足依赖' + (bad.length ? '：' + bad.join(',') + ' 位置不对' : ''));
      const all = listJs(path.join(rootDir, 'app/js')).map((p) => path.basename(p));
      const notLoaded = all.filter((f) => srcs.indexOf(f) === -1);
      check(notLoaded.length === 0, 'app/js 下每个文件都被 index.html 引用' +
        (notLoaded.length ? '：漏 ' + notLoaded.join(',') : ''));
    }
  });
})();

/* 4c) 单元/会话测试（与构建同跑，避免"忘记跑测试"） */
['scripts/test-units.js', 'scripts/test-session.js'].forEach((rel) => {
  try {
    execFileSync(process.execPath, [path.join(rootDir, rel)], { stdio: 'pipe' });
    console.log('✓ 测试通过 ' + rel);
  } catch (e) {
    check(false, '测试失败 ' + rel + '\n' + String(e.stdout || '') + String(e.stderr || ''));
  }
});

/* 5) 图标缺失时生成 */
if (!fs.existsSync(path.join(rootDir, 'app/icons/icon112.png'))) {
  execFileSync(process.execPath, [path.join(rootDir, 'scripts/make-icons.js')], { stdio: 'inherit' });
}

/* 6) 打包：产物带版本号（交付件），并留一份不带版本号的最新副本（脚本/文档引用用） */
function manifestVersion(relManifest) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, relManifest), 'utf8')).version || '0.0';
  } catch (e) {
    return '0.0';
  }
}
const appVer = manifestVersion('app/manifest.webapp');
const probeVer = manifestVersion('tools/probe/manifest.webapp');
/* 版本一致性：main.js 的 APP_VERSION（关于页显示）应与 manifest 主版本一致，防交付版本错配 */
try {
  const m = /APP_VERSION\s*=\s*'v(\d+)/.exec(fs.readFileSync(path.join(rootDir, 'app/js/main.js'), 'utf8'));
  check(!!m && appVer.split('.')[0] === m[1],
    '版本一致：APP_VERSION v' + (m && m[1]) + ' ↔ manifest ' + appVer);
} catch (e) {
  check(false, '版本一致性检查异常: ' + e.message);
}

fs.mkdirSync(path.join(rootDir, 'dist'), { recursive: true });
function zipApp(appDir, baseName, version, entries) {
  const versioned = path.join(rootDir, 'dist', baseName + '-' + version + '.zip');
  const latest = path.join(rootDir, 'dist', baseName + '.zip');
  try { fs.unlinkSync(versioned); } catch (e) { /* 首次无文件 */ }
  execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-c', '-f', versioned, ...entries], {
    cwd: path.join(rootDir, appDir)
  });
  fs.copyFileSync(versioned, latest);
  const size = fs.statSync(versioned).size;
  console.log('✓ 打包 ' + appDir + ' → dist/' + baseName + '-' + version + '.zip (' + size + ' B；' +
    baseName + '.zip 为最新副本)');
}

if (!fail) {
  try {
    zipApp('app', 'zy-kaimc', appVer, ['manifest.webapp', 'index.html', 'css', 'js', 'icons']);
    zipApp('tools/probe', 'zy-probe', probeVer, ['manifest.webapp', 'index.html', 'css', 'js', 'icons']);
  } catch (e) {
    check(false, '打包失败: ' + e.message);
  }
}

console.log(fail ? '✗ 构建失败' : '✓ 构建完成');
process.exit(fail);
