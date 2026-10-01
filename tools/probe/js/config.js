/* 全局配置：时序、帧常量、云台键码、调试开关。
 * 只放"参数"不放逻辑——调手感/调时序改这里即可（app 与探针共享，由 build.js 同步）。 */
(function (root) {
  'use strict';

  var C = {
    /* ---- 时序 ---- */
    POLL_MS: 100,             /* 接收轮询周期：读特征对象 .value 本地缓存（KaiOS 不派发通知事件） */
    ZOOM_HOLD_MS: 180,        /* 变焦杆按住时的连发间隔（短拨一下=一档） */
    RECONNECT_MS: [3000, 6000, 12000, 30000], /* 断线重连退避，超出取最后一项 */
    INIT_WAIT_MS: 150,        /* 初始化序列每步等待应答 */
    INIT_TRIES: 3,            /* 初始化每步最多重试次数 */
    BATTERY_QUERY_MS: 30000,  /* 电量自动查询周期（0=关闭） */
    MODE_QUERY_MS: 5000,      /* 云台状态查询周期（0=关闭；官方 App 用 0x1817 查状态，状态字节变化才记日志） */

    /* ---- 帧 ---- */
    FMT_CMD: 0x1812,          /* 命令帧格式（0x1815=心跳、0x1818=会话帧） */
    FRAME_1818: [0x24, 0x3C, 0x05, 0x00, 0x18, 0x18, 0x09, 0x00, 0x01, 0xA3, 0x16], /* 官方初始化固定帧 */
    FRAME_1817: [0x24, 0x3C, 0x04, 0x00, 0x18, 0x17, 0x02, 0x00, 0xF5, 0x3E],       /* 官方状态查询帧 */

    /* ---- 云台按键码（notify 帧 cmd=0x20，payload: C0 <code> 00，2026-10-01 真机实测） ---- */
    KEY: {
      SHUTTER: 0x3D,          /* 拍照/录像键：单击 → 录像起停 */
      PHOTO: 0x3C,            /* 拍照/录像键：双击 → 拍照 */
      ZOOM_IN: 0x18,          /* 变焦杆 T 按下 → 变焦 + */
      ZOOM_OUT: 0x17,         /* 变焦杆 W 按下 → 变焦 − */
      ZOOM_REL_A: 0x28,       /* T 释放 → 停 */
      ZOOM_REL_B: 0x27        /* W 释放 → 停 */
    },

    /* ---- 调试 ---- */
    DEBUG: false              /* true 时开放诊断键：0=电量查询 5=0x02 探测帧 7=运动测试 */
  };

  root.AppCfg = C;
})(typeof window !== 'undefined' ? window : globalThis);
