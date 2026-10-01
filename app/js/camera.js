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
      if (key === 'pictureSize') return (typeof c.getPictureSize === 'function') ? c.getPictureSize() : c.pictureSize;
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
      else if (key === 'pictureSize') {
        if (typeof c.setPictureSize === 'function') c.setPictureSize(value);
        else c.pictureSize = value;
      }
      else if (key === 'recorderProfile') c.recorderProfile = value;
    } catch (e) { /* 该机型不支持 */ }
  };

  /* 能力清单（参数菜单据此生成）。KaiOS 2720 实测：capabilities 为空对象，
   * 但白平衡/变焦/曝光补偿属性本身可读写 → 为空时给保守候选值兜底，以回读值为准。 */
  Cam.prototype.capabilities = function () {
    var c = this.caps || {};
    var nonEmpty = function (a) { return (a && a.length) ? a : []; };
    /* KaiOS 的 recorderProfiles 是对象（键=profile 名），统一转数组 */
    var recProfiles = c.recorderProfiles;
    if (recProfiles && !recProfiles.length && typeof recProfiles === 'object') {
      recProfiles = Object.keys(recProfiles);
    }
    var out = {
      pictureSizes: nonEmpty(c.pictureSizes),
      previewSizes: nonEmpty(c.previewSizes),
      recorderProfiles: nonEmpty(recProfiles),
      whiteBalanceModes: nonEmpty(c.whiteBalanceModes),
      isoModes: nonEmpty(c.isoModes),
      sceneModes: nonEmpty(c.sceneModes),
      effects: nonEmpty(c.effects),
      flashModes: nonEmpty(c.flashModes),
      focusModes: nonEmpty(c.focusModes),
      zoomRatios: nonEmpty(c.zoomRatios),
      ecMin: (c.minExposureCompensation !== undefined) ? c.minExposureCompensation : 0,
      ecMax: (c.maxExposureCompensation !== undefined) ? c.maxExposureCompensation : 0,
      ecStep: (c.exposureCompensationStep !== undefined) ? c.exposureCompensationStep : 1
    };
    if (!out.whiteBalanceModes.length) {
      out.whiteBalanceModes = ['auto', 'incandescent', 'daylight', 'fluorescent', 'cloudy'];
    }
    if (!out.isoModes.length) out.isoModes = ['auto'];
    if (!out.flashModes.length) out.flashModes = ['auto', 'off', 'on'];
    if (!out.sceneModes.length) out.sceneModes = ['auto'];
    if (!out.effects.length) out.effects = ['none'];
    if (!out.focusModes.length) out.focusModes = ['auto'];
    if (!out.zoomRatios.length && this.control && typeof this.control.zoom === 'number') {
      out.zoomRatios = [1, 2, 3, 4];
    }
    if (out.ecMax <= out.ecMin && this.control && typeof this.control.exposureCompensation === 'number') {
      out.ecMin = -2;
      out.ecMax = 2;
      out.ecStep = 0.5;
    }
    return out;
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

    /* KaiOS 2720（实测）：CameraControl 没有 getPreviewStream，
     * control 本身就是 MediaStream，直接喂给 video 即可（320x240 帧流已验证）。
     * 传感器横装（sensorAngle=270），按安装角旋转铺满竖屏。 */
    if (typeof c.getPreviewStream !== 'function') {
      return new Promise(function (resolve, reject) {
        try {
          if ('mozSrcObject' in videoEl) videoEl.mozSrcObject = c;
          else videoEl.srcObject = c;
          videoEl.play();
        } catch (e) {
          self.dbg('✗ 预览直连 ' + e.name + ':' + e.message);
          reject(new Error('取景流启动失败'));
          return;
        }
        self.previewStream = c;
        /* 传感器横装（sensorAngle=270）。实测确认：预览需按 sensorAngle 本身旋转
         * （(360-sensorAngle) 方向反了，用户目测 +180° 后即为 sensorAngle）。 */
        var ang = 0;
        try { ang = Number(c.sensorAngle) || 0; } catch (e2) { /* 读不到就不转 */ }
        ang = ((ang % 360) + 360) % 360;
        if (ang === 90 || ang === 270) {
          videoEl.style.position = 'absolute';
          videoEl.style.left = '50%';
          videoEl.style.top = '50%';
          videoEl.style.width = root.innerHeight + 'px';
          videoEl.style.height = root.innerWidth + 'px';
          videoEl.style.transform = 'translate(-50%,-50%) rotate(' + ang + 'deg)';
          videoEl.style.objectFit = 'cover';
        } else {
          videoEl.style.transform = '';
        }
        self.dbg('✓ 预览直连 angle=' + ang);
        resolve(c);
      });
    }

    var variants = [];
    /* 清理 KaiOS 直连路径可能残留的内联样式（跨模式/跨实现切回标准路径时） */
    videoEl.style.transform = '';
    videoEl.style.position = '';
    videoEl.style.left = '';
    videoEl.style.top = '';
    videoEl.style.width = '';
    videoEl.style.height = '';
    videoEl.style.objectFit = '';
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
    /* KaiOS 直连模式下 previewStream 就是 control，绝不能 stop 它 */
    if (this.previewStream && this.previewStream.stop && this.previewStream !== this.control) {
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

    /* KaiOS 2720（实测）：takePicture 无回调，结果经 onpicture(BlobEvent) 事件送达 */
    if (typeof c.getPreviewStream !== 'function') {
      return new Promise(function (resolve, reject) {
        var done = false;
        var finish = function (fn, arg) {
          if (done) return;
          done = true;
          try { c.resumePreview(); } catch (e) { /* 部分机型自动恢复 */ }
          fn(arg);
        };
        c.onpicture = function (ev) {
          /* KaiOS 的照片在 ev.data（BlobEvent 变体），标准实现是 ev.blob，两者都收 */
          var blob = ev && (ev.data || ev.blob);
          if (blob) finish(resolve, blob);
          else finish(reject, new Error('onpicture 无 blob'));
        };
        try {
          c.takePicture({ fileFormat: 'jpeg', dateTime: Date.now() });
          self.dbg('拍照(fired)');
        } catch (e) {
          finish(reject, new Error('拍照失败: ' + e.message));
          return;
        }
        root.setTimeout(function () { finish(reject, new Error('拍照超时')); }, 15000);
      });
    }

    /* 标准 B2G 路径：回调式与 DOMRequest 式双重兼容 */
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

    /* setConfiguration 的真等待：onsuccess/onerror/3s 超时兜底三保险，
   * 失败不静默（打 dbg）。resolve(true)=确认成功，false=失败或超时。 */
  function setConfigAsync(c, cfg, cam) {
    return new Promise(function (resolve) {
      var done = false;
      var fin = function (ok, why) {
        if (done) return;
        done = true;
        if (!ok) cam.dbg('✗ setConfiguration ' + (why || ''));
        resolve(ok);
      };
      try {
        var r = c.setConfiguration(cfg);
        if (r && 'onsuccess' in r) {
          r.onsuccess = function () { fin(true); };
          r.onerror = function () { fin(false, (r.error && r.error.name) || 'onerror'); };
          root.setTimeout(function () { fin(true); }, 3000); /* 回调可能不来，超时放行 */
        } else {
          root.setTimeout(function () { fin(true); }, 300); /* 无返回值实现 */
        }
      } catch (e) {
        fin(false, '抛异常:' + e.name);
      }
    });
  }

  /* KaiOS 2720（实测）旋转三层模型：
     * 1) 预览：raw 帧横装需转，由 UI 层 CSS rotate(sensorAngle) 补偿（见 startPreview）；
     * 2) 录像：编码帧恒为横向原始帧，固件不烤像素旋转；
     *    tkhd 矩阵 = (传入 rotation + sensorAngle) % 360 —— startRecording 只传
     *    屏幕方向角（竖屏锁定 = 0），setConfiguration 不带 rotation（与 Gaia 一致）；
     * 3) 播放：.3gp 路径播放器遵守矩阵 → 正立；.mp4 路径忽略矩阵 → 横放（平台行为）。
     * 录像含音轨需要 audio-capture 权限。 */
    if (typeof c.getPreviewStream !== 'function') {
      var profiles = [];
      try { profiles = Object.keys((this.caps && this.caps.recorderProfiles) || {}); } catch (e) { /* 无列表 */ }
      if (!profiles.length) profiles = ['low', 'default', 'high'];
      var profile = (profiles.indexOf('high') !== -1) ? 'high' : profiles[profiles.length - 1];
      return new Promise(function (resolve, reject) {
        /* 方向锁定 → 真等待锁完成 → setConfiguration 真等待（onerror 打日志）→
         * 300ms 定长传导 → 开录。任何一步静默失败都会让旋转/档位错乱。 */
        Promise.resolve(U.lockPortrait()).then(function () {
          return setConfigAsync(c, { mode: 'video', recorderProfile: profile }, self);
        }).then(function () {
          return new Promise(function (res) { root.setTimeout(res, 300); });
        }).then(function () {
          var filename = videoFilename(profile);
          try {
            var p = c.startRecording({ rotation: 0, maxFileSizeBytes: 536870912, createPoster: false },
              storage, filename);
            self.recording = true;
            self.dbg('✓ 录像开始 ' + filename + ' (' + profile + ')');
            if (p && typeof p.then === 'function') {
              p.then(function () { /* 停止后落定 */ }, function (err) {
                self.recording = false;
                self.dbg('✗ 录像中断 ' + (err && err.name));
              });
            }
            resolve(filename);
          } catch (e) {
            self.dbg('✗ 录像 ' + e.name + ':' + e.message);
            reject(new Error('录像失败: ' + e.message));
          }
        }).catch(function (err) {
          reject(err instanceof Error ? err : new Error('录像前置失败: ' + err));
        });
      });
    }

    var cfg = { mode: 'video' };
    var profiles2 = (this.caps && this.caps.recorderProfiles) || [];
    var profile2 = null, i;
    for (i = 0; i < profiles2.length; i++) {
      if (String(profiles2[i]).indexOf('mp4') !== -1) { profile2 = profiles2[i]; break; }
    }
    if (!profile2 && profiles2.length) profile2 = profiles2[profiles2.length - 1];
    if (profile2) cfg.recorderProfile = profile2;
    var filename2 = videoFilename(profile2);
    var meta = { filename: filename2 };
    return new Promise(function (resolve, reject) {
      var done = false;
      var ok = function () {
        if (!done) { done = true; self.recording = true; self.dbg('✓ 录像开始 ' + filename2); resolve(filename2); }
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

  /* 切换拍照/录像。KaiOS：setConfiguration 直接切（不释放 control，规避 HAL 泄漏）；
   * 标准平台：释放后按新模式重开。 */
  Cam.prototype.switchMode = function (mode, videoEl) {
    var self = this;
    this.mode = (mode === 'video') ? 'video' : 'picture';
    var c = this.control;
    if (c && typeof c.setConfiguration === 'function' && typeof c.getPreviewStream !== 'function') {
      return new Promise(function (resolve, reject) {
        var done = false;
        var fin = function (ok, err) {
          if (done) return;
          done = true;
          if (ok) resolve(self.startPreview(videoEl));
          else reject(err || new Error('setConfiguration 失败'));
        };
        try {
          var r = c.setConfiguration({ mode: self.mode });
          if (r && 'onsuccess' in r) {
            r.onsuccess = function () { fin(true); };
            r.onerror = function () { fin(false, r.error); };
          } else {
            root.setTimeout(function () { fin(true); }, 800);
          }
        } catch (e) { fin(false, e); }
        root.setTimeout(function () { fin(false, new Error('切换超时')); }, 6000);
      });
    }
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
    /* 实测（2720）：KaiOS 播放器只对 .3gp 文件应用 tkhd 旋转矩阵，
     * .mp4 同样的内容会横转 90° 播放 → 与系统相机一致使用 .3gp */
    return 'DCIM/ZYKaiCam/VID_' + stamp() + '.3gp';
  }

  root.KaiCam = new Cam();
})(typeof window !== 'undefined' ? window : globalThis);
