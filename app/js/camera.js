/* KaiOS mozCamera 封装：打开相机、取景流、拍照、录像、参数读写。
 * Gecko 48 的 CameraControl 方法同时存在回调式与 DOMRequest 式两种形态，
 * 这里全部做双重兼容（done 标志防二次触发）。 */
(function (root) {
  'use strict';

  var U = root.KaiUtil;

  function Cam() {
    this.mode = 'picture';      /* 'picture' | 'video' */
    this.which = 'back';
    this.control = null;
    this.caps = null;
    this.previewStream = null;
    this.recording = false;
  }

  Cam.prototype.manager = function () {
    return root.navigator.mozCameras || root.navigator.mozCamera || null;
  };

  Cam.prototype.init = function () {
    var mgr = this.manager();
    if (!mgr) return Promise.reject(new Error('相机 API 不可用（需要 privileged 权限）'));
    var cams = mgr.getListOfCameras ? mgr.getListOfCameras() : ['back'];
    this.which = (cams.indexOf('back') !== -1) ? 'back' : (cams[0] || 'back');
    return this._open();
  };

  Cam.prototype._open = function () {
    var self = this;
    var mgr = this.manager();
    var req = mgr.getCamera(this.which, { mode: this.mode });
    return U.prom(req, 'getCamera').then(function (res) {
      var r = res || {};
      self.control = r.camera || r; /* 有的实现直接给 CameraControl */
      self.caps = self.control.capabilities || {};
      return self;
    });
  };

  /* 能力清单（参数菜单据此生成，缺什么隐藏什么） */
  Cam.prototype.capabilities = function () {
    var c = this.caps || {};
    return {
      pictureSizes: c.pictureSizes || [],
      previewSizes: c.previewSizes || [],
      recorderProfiles: c.recorderProfiles || [],
      whiteBalanceModes: c.whiteBalanceModes || [],
      isoModes: c.isoModes || [],
      sceneModes: c.sceneModes || [],
      effects: c.effects || [],
      flashModes: c.flashModes || [],
      focusModes: c.focusModes || [],
      zoomRatios: c.zoomRatios || [],
      ecMin: (c.minExposureCompensation !== undefined) ? c.minExposureCompensation : 0,
      ecMax: (c.maxExposureCompensation !== undefined) ? c.maxExposureCompensation : 0,
      ecStep: (c.exposureCompensationStep !== undefined) ? c.exposureCompensationStep : 1
    };
  };

  Cam.prototype.getParam = function (key) {
    var c = this.control;
    if (!c) return undefined;
    try {
      if (key === 'whiteBalance') return c.whiteBalanceMode;
      if (key === 'iso') return c.isoMode;
      if (key === 'scene') return c.sceneMode;
      if (key === 'effect') return c.effect;
      if (key === 'flash') return c.flashMode;
      if (key === 'focus') return c.focusMode;
      if (key === 'ec') return c.exposureCompensation;
      if (key === 'zoom') return c.zoom;
      if (key === 'pictureSize') return c.pictureSize;
      if (key === 'recorderProfile') return c.recorderProfile;
    } catch (e) { /* 属性不存在 */ }
    return undefined;
  };

  Cam.prototype.setParam = function (key, value) {
    var c = this.control;
    if (!c) return;
    try {
      if (key === 'whiteBalance') c.whiteBalanceMode = value;
      else if (key === 'iso') c.isoMode = value;
      else if (key === 'scene') c.sceneMode = value;
      else if (key === 'effect') c.effect = value;
      else if (key === 'flash') c.flashMode = value;
      else if (key === 'focus') c.focusMode = value;
      else if (key === 'ec') c.exposureCompensation = value;
      else if (key === 'zoom') c.zoom = value;
      else if (key === 'pictureSize') c.pictureSize = value;
      else if (key === 'recorderProfile') c.recorderProfile = value;
    } catch (e) { /* 该机型不支持 */ }
  };

  Cam.prototype._pickPreviewSize = function () {
    var list = (this.caps && this.caps.previewSizes) || [];
    var target = 240 * 320;
    var best = null, bestDiff = Infinity;
    list.forEach(function (s) {
      var diff = Math.abs(s.width * s.height - target);
      if (diff < bestDiff) { bestDiff = diff; best = s; }
    });
    return best || { width: 320, height: 240 };
  };

  Cam.prototype._pickPictureSize = function () {
    var list = (this.caps && this.caps.pictureSizes) || [];
    var best = null, bestPx = -1;
    list.forEach(function (s) {
      var px = s.width * s.height;
      if (px > bestPx) { bestPx = px; best = s; }
    });
    return best;
  };

  Cam.prototype.startPreview = function (videoEl) {
    var self = this;
    var c = this.control;
    if (!c) return Promise.reject(new Error('相机未打开'));
    return new Promise(function (resolve, reject) {
      var done = false;
      var ok = function (stream) {
        if (done) return;
        done = true;
        self.previewStream = stream;
        try {
          if ('mozSrcObject' in videoEl) videoEl.mozSrcObject = stream;
          else videoEl.srcObject = stream;
        } catch (e) { /* 渲染失败不打断流程 */ }
        try { videoEl.play(); } catch (e) {}
        resolve(stream);
      };
      var err = function () {
        if (done) return;
        done = true;
        reject(new Error('取景流启动失败'));
      };
      var ret;
      try {
        ret = c.getPreviewStream({ mode: self.mode, previewSize: self._pickPreviewSize() }, ok, err);
      } catch (e) { err(); return; }
      if (ret && 'onsuccess' in ret) {
        ret.onsuccess = function () { ok(ret.result); };
        ret.onerror = function () { err(ret.error); };
      }
    });
  };

  Cam.prototype.stopPreview = function () {
    if (this.previewStream && this.previewStream.stop) {
      try { this.previewStream.stop(); } catch (e) { /* 已停止 */ }
    }
    this.previewStream = null;
  };

  Cam.prototype.takePicture = function () {
    var self = this;
    var c = this.control;
    if (!c) return Promise.reject(new Error('相机未打开'));
    var cfg = { fileFormat: 'jpeg', dateTime: Date.now() };
    var size = this._pickPictureSize();
    if (size) cfg.pictureSize = size;
    return new Promise(function (resolve, reject) {
      var done = false;
      var ok = function (blob) { if (!done) { done = true; resolve(blob); } };
      var err = function () { if (!done) { done = true; reject(new Error('拍照失败')); } };
      var ret;
      try { ret = c.takePicture(cfg, ok, err); } catch (e) { err(); return; }
      if (ret && 'onsuccess' in ret) {
        ret.onsuccess = function () { ok(ret.result); };
        ret.onerror = function () { err(ret.error); };
      }
    }).then(function (blob) {
      if (c.resumePreview) { try { c.resumePreview(); } catch (e) { /* 部分机型自动恢复 */ } }
      return blob;
    });
  };

  Cam.prototype.saveBlob = function (blob, kind, filename) {
    var st = root.navigator.getDeviceStorage ? root.navigator.getDeviceStorage(kind) : null;
    if (!st) return Promise.reject(new Error('DeviceStorage 不可用'));
    return U.prom(st.addNamed(blob, filename), 'addNamed');
  };

  Cam.prototype.startRecording = function () {
    var self = this;
    var c = this.control;
    if (!c) return Promise.reject(new Error('相机未打开'));
    var storage = root.navigator.getDeviceStorage ? root.navigator.getDeviceStorage('videos') : null;
    if (!storage) return Promise.reject(new Error('DeviceStorage(videos) 不可用'));
    var cfg = { mode: 'video' };
    var profiles = (this.caps && this.caps.recorderProfiles) || [];
    var profile = null, i;
    for (i = 0; i < profiles.length; i++) {
      if (String(profiles[i]).indexOf('mp4') !== -1) { profile = profiles[i]; break; }
    }
    if (!profile && profiles.length) profile = profiles[profiles.length - 1];
    if (profile) cfg.recorderProfile = profile;
    var filename = videoFilename(profile);
    var meta = { filename: filename };
    return new Promise(function (resolve, reject) {
      var done = false;
      var ok = function () {
        if (!done) { done = true; self.recording = true; resolve(filename); }
      };
      var err = function () { if (!done) { done = true; reject(new Error('录像启动失败')); } };
      var ret;
      try { ret = c.startRecording(cfg, storage, meta, ok, err); } catch (e) { err(); return; }
      if (ret && 'onsuccess' in ret) { ret.onsuccess = ok; ret.onerror = err; }
    });
  };

  Cam.prototype.stopRecording = function () {
    var c = this.control;
    this.recording = false;
    if (c && c.stopRecording) {
      try { c.stopRecording(); } catch (e) { /* 已停止 */ }
    }
  };

  /* 切换拍照/录像：释放后按新模式重开（跨 Gecko 48 各实现最稳的路径） */
  Cam.prototype.switchMode = function (mode, videoEl) {
    var self = this;
    this.mode = (mode === 'video') ? 'video' : 'picture';
    this.stopPreview();
    var old = this.control;
    this.control = null;
    if (old && old.release) { try { old.release(); } catch (e) { /* 继续 */ } }
    return new Promise(function (resolve) { root.setTimeout(resolve, 400); })
      .then(function () { return self._open(); })
      .then(function () { return self.startPreview(videoEl); });
  };

  Cam.prototype.photoFilename = function () {
    return 'DCIM/ZYKaiCam/IMG_' + stamp() + '.jpg';
  };

  function stamp() {
    var d = new Date();
    var p = function (n, w) {
      var s = String(n);
      while (s.length < (w || 2)) s = '0' + s;
      return s;
    };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function videoFilename(profile) {
    var ext = (profile && String(profile).indexOf('3gp') !== -1) ? '3gp' : 'mp4';
    return 'DCIM/ZYKaiCam/VID_' + stamp() + '.' + ext;
  }

  root.KaiCam = new Cam();
})(typeof window !== 'undefined' ? window : globalThis);
