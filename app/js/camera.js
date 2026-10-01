/* KaiOS mozCamera 封装：打开相机、取景流、拍照、录像、参数读写。
 * Gecko 48 的 CameraControl 方法同时存在回调式与 DOMRequest 式两种形态，
 * 全部做双重兼容（done 标志防二次触发）。
 * 真机各固件行为差异大：打开相机/取景流均多方案自动重试，并把每一步
 * 的调用与底层报错记入日志（主界面按 # 查看），便于真机排障。 */
(function (root) {
  'use strict';

  var U = root.KaiUtil;

  function Cam() {
    this.mode = 'picture';      /* 'picture' | 'video' */
    this.which = null;
    this.control = null;
    this.caps = null;
    this.previewStream = null;
    this.recording = false;
    this.logLines = [];
  }

  /* 提取底层报错（去掉冗长前缀），让面板单行放得下 */
  function why(e) {
    var m = (e && e.message) ? e.message : String(e || '未知错误');
    var idx = m.indexOf('失败: ');
    if (idx !== -1) m = m.substring(idx + 4);
    m = m.replace(/超时\((\d+)ms\)/g, function (_, ms) { return '超时' + (ms / 1000) + 's'; });
    return m;
  }

  Cam.prototype.dbg = function (msg) {
    this.logLines.push(msg);
    if (this.logLines.length > 80) this.logLines.shift();
    try { root.console.log('[cam] ' + msg); } catch (e) { /* 无 console */ }
  };

  Cam.prototype.getLog = function () { return this.logLines.slice(-14); };

  Cam.prototype.manager = function () {
    return root.navigator.mozCameras || root.navigator.mozCamera || null;
  };

  Cam.prototype.init = function () {
    var self = this;
    var mgr = this.manager();
    if (!mgr) {
      self.dbg('✗ 无相机API(非privileged?)');
      return Promise.reject(new Error('相机 API 不存在（需要 privileged 权限）'));
    }
    var names = [];
    try { names = mgr.getListOfCameras() || []; } catch (e) {
      self.dbg('getListOfCameras 异常: ' + e.message);
    }
    self.dbg('API=' + (root.navigator.mozCameras ? 'mozCameras' : 'mozCamera') +
      ' cams=[' + names.join(',') + ']');
    var candidates = names.length ? names.slice() : ['back', 'front'];
    if (candidates.indexOf('back') !== -1) {
      candidates = ['back'].concat(candidates.filter(function (c) { return c !== 'back'; }));
    }
    var i = 0;
    var tryNext = function () {
      if (i >= candidates.length) {
        return Promise.reject(new Error('getCamera 候选全部失败（按 9 重试）'));
      }
      self.which = candidates[i++];
      return self._open().catch(function (err) {
        self.dbg('--> 换摄像头重试');
        return tryNext();
      });
    };
    return tryNext();
  };

  Cam.prototype._open = function () {
    var self = this;
    var mgr = this.manager();
    var configs = [{ mode: this.mode }, null]; /* 带 mode 配置 → 默认配置 */
    var idx = 0;
    var tryOne = function () {
      var cfg = configs[idx++];
      var tag = 'open ' + self.which + (cfg ? ' m:' + cfg.mode : ' 默认');
      var p = new Promise(function (resolve, reject) {
        var req;
        try {
          req = cfg ? mgr.getCamera(self.which, cfg) : mgr.getCamera(self.which);
        } catch (e) {
          reject(new Error('调用抛异常: ' + e.message));
          return;
        }
        U.prom(req, 'getCamera').then(resolve, reject);
      });
      return U.withTimeout(p, 20000, 'getCamera')
        .then(function (res) {
          var r = res || {};
          var control = r.camera || r; /* 有的实现直接给 CameraControl */
          if (!control) throw new Error('返回为空');
          self.control = control;
          self.caps = control.capabilities || {};
          if (!control.capabilities) self.dbg('⚠ 无capabilities属性');
          self.dbg('✓ ' + tag);
          self._logCaps();
          return self;
        }, function (err) {
          self.dbg('✗ ' + tag + ' ' + why(err));
          if (idx < configs.length) return tryOne();
          throw err;
        });
    };
    return tryOne();
  };

  Cam.prototype._logCaps = function () {
    var c = this.caps || {};
    var n = function (a) { return (a || []).length; };
    this.dbg('caps 预览=' + n(c.previewSizes) + ' 照片=' + n(c.pictureSizes) +
      ' 录制=' + n(c.recorderProfiles) + ' WB=' + n(c.whiteBalanceModes) +
      ' ISO=' + n(c.isoModes) + ' 变焦=' + n(c.zoomRatios));
    var ps = (c.previewSizes || []).map(function (s) {
      return s.width + 'x' + s.height;
    }).join(',');
    if (ps) this.dbg('预览尺寸: ' + ps);
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

  /* 取景尺寸候选：capabilities 里最接近屏幕的几个；没有则给常见兜底 */
  Cam.prototype._previewCandidates = function () {
    var list = (this.caps && this.caps.previewSizes) || [];
    var target = 240 * 320;
    var sorted = list.slice().sort(function (a, b) {
      return Math.abs(a.width * a.height - target) - Math.abs(b.width * b.height - target);
    });
    if (!sorted.length) {
      sorted = [{ width: 320, height: 240 }, { width: 240, height: 320 }, { width: 640, height: 480 }];
    }
    return sorted.slice(0, 5);
  };

  Cam.prototype.startPreview = function (videoEl) {
    var self = this;
    var c = this.control;
    if (!c) return Promise.reject(new Error('相机未打开'));

    var variants = [];
    self._previewCandidates().forEach(function (s) {
      variants.push({ mode: self.mode, previewSize: s });
    });
    variants.push({ mode: self.mode }); /* 不带尺寸的兜底 */

    var attach = function (stream) {
      self.previewStream = stream;
      try {
        if ('mozSrcObject' in videoEl) videoEl.mozSrcObject = stream;
        else videoEl.srcObject = stream;
      } catch (e) { /* 渲染失败不打断流程 */ }
      try { videoEl.play(); } catch (e) {}
      return stream;
    };

    var tryVariant = function () {
      if (!variants.length) {
        return Promise.reject(new Error('取景流所有方案均失败（按 # 看详情）'));
      }
      var cfg = variants.shift();
      var sizeLabel = cfg.previewSize ? (cfg.previewSize.width + 'x' + cfg.previewSize.height) : '无尺寸';
      return new Promise(function (resolve) {
        var settled = false;
        var ok = function (stream) {
          if (settled || !stream) return;
          settled = true;
          self.dbg('✓ 预览 ' + sizeLabel);
          resolve(attach(stream));
        };
        var err = function (whyMsg) {
          if (settled) return;
          settled = true;
          self.dbg('✗ 预览 ' + sizeLabel + ' ' + (whyMsg || ''));
          resolve(null);
        };
        var ret;
        try { ret = c.getPreviewStream(cfg, ok, err); }
        catch (e) { err('抛异常:' + e.message); return; }
        if (ret && 'onsuccess' in ret) {
          ret.onsuccess = function () { ok(ret.result); };
          ret.onerror = function () {
            var whyMsg = 'onerror';
            try { whyMsg = ret.error ? (ret.error.name + ':' + (ret.error.message || '')) : whyMsg; } catch (e) {}
            err(whyMsg);
          };
        }
        root.setTimeout(function () { err('超时'); }, 4000);
      }).then(function (got) {
        return got ? got : tryVariant();
      });
    };
    return tryVariant();
  };

  Cam.prototype.stopPreview = function () {
    if (this.previewStream && this.previewStream.stop) {
      try { this.previewStream.stop(); } catch (e) { /* 已停止 */ }
    }
    this.previewStream = null;
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

  Cam.prototype.takePicture = function () {
    var self = this;
    var c = this.control;
    if (!c) return Promise.reject(new Error('相机未打开'));
    var size = this._pickPictureSize();
    var variants = [{ fileFormat: 'jpeg', dateTime: Date.now() }];
    if (size) variants[0].pictureSize = size;
    variants.push({ fileFormat: 'jpeg' });

    var tryOne = function () {
      var cfg = variants.shift();
      if (!cfg) return Promise.reject(new Error('拍照失败（按 # 看详情）'));
      return new Promise(function (resolve, reject) {
        var done = false;
        var ok = function (blob) { if (!done) { done = true; resolve(blob); } };
        var err = function (whyMsg) {
          if (done) return;
          done = true;
          self.dbg('✗ 拍照: ' + (whyMsg || ''));
          reject(new Error('拍照失败'));
        };
        var ret;
        try { ret = c.takePicture(cfg, ok, err); } catch (e) { err('抛异常:' + e.message); return; }
        if (ret && 'onsuccess' in ret) {
          ret.onsuccess = function () { ok(ret.result); };
          ret.onerror = function () {
            var whyMsg = 'onerror';
            try { whyMsg = ret.error ? (ret.error.name + ':' + (ret.error.message || '')) : whyMsg; } catch (e) {}
            err(whyMsg);
          };
        }
      }).then(function (blob) {
        self.dbg('✓ 拍照');
        if (c.resumePreview) { try { c.resumePreview(); } catch (e) { /* 部分机型自动恢复 */ } }
        return blob;
      }, function (err) {
        return tryOne();
      });
    };
    return tryOne();
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
        if (!done) { done = true; self.recording = true; self.dbg('✓ 录像开始 ' + filename); resolve(filename); }
      };
      var err = function (why) {
        if (done) return;
        done = true;
        self.dbg('✗ 录像启动 ' + (why || ''));
        reject(new Error('录像启动失败'));
      };
      var ret;
      try { ret = c.startRecording(cfg, storage, meta, ok, err); } catch (e) { err('抛异常:' + e.message); return; }
      if (ret && 'onsuccess' in ret) { ret.onsuccess = ok; ret.onerror = function () { err('onerror'); }; }
    });
  };

  Cam.prototype.stopRecording = function () {
    var c = this.control;
    this.recording = false;
    if (c && c.stopRecording) {
      try { c.stopRecording(); this.dbg('■ 录像停止'); } catch (e) { /* 已停止 */ }
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
