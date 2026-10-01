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
      gattPoor: '云台 GATT 特征不完整（缺 fee9 写/通知特征），8 秒后重试',
      disconnected: '云台连接断开，重连中…',
      btFail: '蓝牙不可用',
      modePhoto: '拍照',
      modeVideo: '录像',
      skParams: '参数',
      skMode: '模式',
      skShutter: '快门',
      skBack: '返回',
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
      gimbalBatt: '云台',
      sizeFmt: '尺寸'
    },
    en: {
      camInit: 'Starting camera…',
      camFail: 'Camera unavailable: permission required',
      scan: 'Scanning for gimbal…',
      connecting: 'Connecting gimbal…',
      connected: 'Gimbal connected',
      gattPoor: 'Gimbal GATT chars incomplete (fee9), retry in 8s',
      disconnected: 'Gimbal lost, reconnecting…',
      btFail: 'Bluetooth unavailable',
      modePhoto: 'PHOTO',
      modeVideo: 'VIDEO',
      skParams: 'Params',
      skMode: 'Mode',
      skShutter: 'Shutter',
      skBack: 'Back',
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
      gimbalBatt: 'Gimbal',
      sizeFmt: 'Size'
    }
  };

  function t(key) {
    return (DICTS[LANG] && DICTS[LANG][key]) || DICTS.en[key] || key;
  }

  root.Strings = { t: t, LANG: LANG };
})(typeof window !== 'undefined' ? window : globalThis);
