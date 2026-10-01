/* 文案。默认中文；若固件无中文字形（显示方框），把下面的 LANG 改为 'en'。 */
(function (root) {
  'use strict';

  var LANG = 'zh';

  var DICTS = {
    zh: {
      camInit: '相机启动中…',
      camFail: '相机不可用：需要相机权限',
      scan: '搜索云台…',
      connecting: '连接云台…',
      connected: '云台已连接',
      gimbalSilent: '云台无应答',
      disconnected: '重连中',
      btFail: '蓝牙不可用',
      modePhoto: '拍照',
      modeVideo: '录像',
      skParams: '参数',
      skMode: '模式',
      skShutter: '快门',
      skBack: '返回',
      skClose: '关闭',
      about: '关于',
      aboutTitle: '关于 ZY-KaiCam',
      aboutVer: '版本',
      aboutRepo: '项目地址',
      aboutEnv: '运行环境',
      na: '不支持',
      btBad: '蓝牙 ✗',
      recHud: '● 录像 ',
      menuTitle: '相机参数（←→ 改值）',
      noParams: '未检测到可调参数',
      saved: '已保存',
      saveFail: '保存失败',
      recording: '录像中，先停止再切换',
      recPhoto: '录像中不支持拍照',
      recFail: '录像失败',
      switchFail: '模式切换失败',
      camAllFail: '相机打不开：按 # 看详情，按 9 重试',
      previewFail: '取景失败：按 # 看详情，按 9 重试',
      retrying: '重试相机…',
      zoom: '变焦',
      pWhiteBalance: '白平衡',
      pIso: '感光度 ISO',
      pEc: '曝光补偿',
      pFlash: '闪光灯',
      pScene: '场景',
      pEffect: '效果',
      pFocus: '对焦',
      pSize: '照片尺寸',
      pProfile: '录像规格',
      pZoom: '变焦',
      hudWb: '白平衡',
      hudIso: 'ISO',
      hudEc: '曝光',
      sizeFmt: '尺寸'
    },
    en: {
      camInit: 'Starting camera…',
      camFail: 'Camera unavailable: permission required',
      scan: 'Scanning for gimbal…',
      connecting: 'Connecting gimbal…',
      connected: 'Gimbal connected',
      gimbalSilent: 'Gimbal silent',
      disconnected: 'Reconnecting',
      btFail: 'Bluetooth unavailable',
      modePhoto: 'PHOTO',
      modeVideo: 'VIDEO',
      skParams: 'Params',
      skMode: 'Mode',
      skShutter: 'Shutter',
      skBack: 'Back',
      skClose: 'Close',
      about: 'About',
      aboutTitle: 'About ZY-KaiCam',
      aboutVer: 'Version',
      aboutRepo: 'Repository',
      aboutEnv: 'Environment',
      na: 'N/A',
      btBad: 'BT ✗',
      recHud: '● REC ',
      menuTitle: 'Camera params (←→ change)',
      noParams: 'No adjustable params',
      saved: 'Saved',
      saveFail: 'Save failed',
      recording: 'Recording, stop before switching',
      recPhoto: 'Cannot shoot while recording',
      recFail: 'Record failed',
      switchFail: 'Switch failed',
      camAllFail: 'Camera failed: #=details, 9=retry',
      previewFail: 'Preview failed: #=details, 9=retry',
      retrying: 'Retrying camera…',
      zoom: 'Zoom',
      pWhiteBalance: 'White balance',
      pIso: 'ISO',
      pEc: 'Exposure comp',
      pFlash: 'Flash',
      pScene: 'Scene',
      pEffect: 'Effect',
      pFocus: 'Focus',
      pSize: 'Photo size',
      pProfile: 'Rec profile',
      pZoom: 'Zoom',
      hudWb: 'WB',
      hudIso: 'ISO',
      hudEc: 'EV',
      sizeFmt: 'Size'
    }
  };

  /* 相机 HAL 取值汉化（菜单/HUD 用；英文模式或查不到就原样返回） */
  var VALUES = {
    auto: '自动', off: '关闭', on: '开启', none: '无', default: '默认', yes: '是', no: '否',
    incandescent: '白炽灯', fluorescent: '荧光灯', 'warm-fluorescent': '暖色荧光', warmfluorescent: '暖色荧光',
    daylight: '日光', cloudy: '阴天', twilight: '黄昏', shade: '阴影', tungsten: '钨丝灯',
    night: '夜景', 'night-portrait': '夜景人像', portrait: '人像', landscape: '风景', snow: '雪景',
    beach: '沙滩', sunset: '日落', sport: '运动', candle: '烛光', fireworks: '烟花', backlight: '逆光',
    party: '聚会', theatre: '剧场', action: '动作', 'steady-photo': '稳定拍摄', steadyphoto: '稳定拍摄',
    mono: '黑白', sepia: '棕褐', negative: '负片', posterize: '色调分离', solarize: '过度曝光',
    emboss: '浮雕', aqua: '水蓝', sketch: '素描', neon: '霓虹',
    'red-eye': '红眼消除', redeye: '红眼消除', torch: '常亮',
    infinity: '无穷远', macro: '微距', edof: '全焦',
    'continuous-picture': '连续对焦·照片', 'continuous-video': '连续对焦·视频', 'continuous-picture-video': '连续对焦',
    high: '高', low: '低', cif: 'CIF', qcif: 'QCIF',
    /* 2720 相机 HAL 实测取值（2026-10-02 从真机 capabilities 抄录）里不在上表的 */
    'cloudy-daylight': '阴天', manual: '手动', hjr: '高感光', asd: '自动场景',
    sports: '运动', flowers: '花卉', candlelight: '烛光', whiteboard: '白板', blackboard: '黑板',
    fixed: '固定焦距', qvga: 'QVGA', '480p': '480p', ar: 'AR'
  };

  function val(v) {
    if (v === undefined || v === null || v === '') return '-';
    var s = String(v);
    if (LANG !== 'zh') return s;
    var key = s.toLowerCase().replace(/[\s_]+/g, '-');
    return VALUES[key] || VALUES[s.toLowerCase()] || s;
  }

  function t(key) {
    return (DICTS[LANG] && DICTS[LANG][key]) || DICTS.en[key] || key;
  }

  root.Strings = { t: t, val: val, LANG: LANG };
})(typeof window !== 'undefined' ? window : globalThis);
