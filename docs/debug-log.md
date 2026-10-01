# KaiOS 真机抓日志指南（2720 Flip / Gecko 48）

> 本文是**开发者向**的远程调试手册：不动手机屏幕、不装 WebIDE，用电脑脚本直接抓运行日志、注入诊断代码、截屏。
> WebIDE 安装/日常使用见 [install-2720.md](install-2720.md)。

## 一、工具清单

| 文件 | 用途 |
|---|---|
| `scripts/rdd.js` | 主工具：`shot [png]` 截屏 / `running` 列运行中应用 / `install <app目录>` 安装 / `request <json>` 原始协议透传 |
| `scripts/rdd-probe.js` | 裸协议探针（单条请求 + 打印全部回包），排查协议层问题时用 |
| `scripts/bt-diag.js` + `bt-diag-snippet.js` | **注入式自驱动诊断**模板：往运行中的应用注入 JS，自动跑流程、结果回传存盘（蓝牙版已是成品） |
| `tools/diag/` | 诊断脚本集（注入片段/看板轮询/合成抓包/接收链路对照实验），见 `tools/diag/README.md` |
| `scripts/parse-btsnoop.js` | 解析安卓 btsnoop_hci.log：ATT 读写/通知 + SMP + 智云帧解码（`--all` 全打印、`--peer <地址>` 过滤） |
| `tools/fake-gimbal/fake_gimbal.py` | PC 端"假云台"（Windows WinRT GATT 外设），接收链路对照实验用 |

## 二、前置条件（一次性）

1. 手机拨号 `*#*#33284#*#*` 开开发者模式 → 设置里打开 **ADB and DevTools**。
2. 电脑装 adb；手机插 USB，`adb devices` 能列出设备。

## 三、基础流程

```bash
# 1. 建立通道（每次重插 USB 后必须重跑！）
adb forward tcp:6000 localfilesystem:/data/local/debugger-socket

# 2. 确认通道活着 + 看谁在运行
node scripts/rdd.js running

# 3. 各类操作
node scripts/rdd.js shot logs/now.png          # 远程截屏（拍面板/弹窗）
node scripts/rdd.js install app                # 装 app/ 或 tools/probe/
adb logcat -d -t 3000 > logs/device.log        # 底层 logcat（-d dump 后退出，-t 限行数）
```

注入式诊断（bt-diag 模式）的用法：

```bash
node scripts/bt-diag.js
# 自动：找运行中带 mozBluetooth 的应用 → 注入片段 → 轮询进度 → 日志存 logs/ + 抓 logcat 片段
```

自驱动诊断的工作方式（写自己的版本时照抄这个结构）：

- **片段**（snippet）只做一件事：把结果写进 `window.__btDiag = { stage, log[] }`，立即 `return`；
- **驱动脚本**（bt-diag.js）每 2.5s 注入一条**极短** eval 轮询 `JSON.stringify(window.__btDiag)`，看到 `stage:"done"` 就收工；
- 长流程（扫描 20s、配对、连接）全在片段内的 Promise 链里跑，不占调试通道。

## 四、重点

1. **通道是"无横幅"的 Gecko 48 老协议**：TCP 连上后直接按 `<长度>:<JSON>` 帧收发，第一个请求永远是 `{to:"root",type:"listTabs"}`。所有 actor 名（`server1.connN.webappsActor1` 等）**每次连接都变**，必须先 listTabs 拿到再用，不能硬编码。
2. **找宿主应用要验能力，别猜**：`listRunningApps` → 逐个 `getAppActor` → 在其 consoleActor 里 eval 一条短句确认（如 `!!navigator.mozBluetooth`）。系统自带应用（如 intent）可能是 UI 而没有目标 API。
3. **consoleActor 在 getAppActor 响应的嵌套结构里**（`actor.consoleActor`），直接递归找 `/consoleActor/i` 的字符串值最稳。
4. **长字符串（longString）要递归展开**：大结果的 `result` 会变成 `{type:"longString", initial, length, actor}`，需按段拉取。**本固件的 substring 参数是 `start`/`end`**（不是 Gecko 标准的 `from`/`charLength`），且 `value` 还可能再嵌套 longString——`rdd.js` 的 `unlongify()` 已处理，抄它。
5. **logcat 是环形缓冲区**：`-t 3000` 只留最近约 3000 行，复现问题后要**马上**抓；底层蓝牙日志用 `grep -iE "bluetooth|gatt|btle|hci"` 过滤（bt-diag.js 已自动做）。

## 五、难点

1. **通道僵死的恢复是三级递进**，按顺序来：
   1. `adb devices` 先确认手机还在（不在=USB/手机问题）；
   2. 重建 forward 再试（forward 会因重插 USB 失效）；
   3. 还不行 = 调试服务僵死：`adb shell pkill b2g`（init 自动拉起图形系统，**adb 会掉线几十秒，等它回来重建 forward**）。
2. **挂死是会传染的**：一个不回包的 eval 卡在通道上，后续请求全部排队饿死。诊断脚本必须给每个可疑调用加超时，宁可丢一次结果也不能堵管道。
3. **协议怪癖多，别信标准文档**：Gecko 48 的响应字段和现代文档有出入（substring 参数、嵌套 longString、release 可能无响应不等待）。改 rdd.js 前先开 `RDD_DEBUG=1` 看原始帧。

## 六、误区（血泪清单，按严重程度排序）

1. **🔴 evaluateJS 的 text 里严禁非 ASCII 字符**。中文注释、✗✓、——、… 任何一个是——该请求**永不回包**，且随后同 actor 上所有请求挂死；积累几次整个调试服务僵死，只能 `pkill b2g`。
   - 注入片段一律纯英文注释和日志；**注入前校验**：`grep -cP "[^\x00-\x7F]" snippet.js` 必须为 0。
   - 中文/特殊字符放**字符串值**里也一样挂（单条 `'宿主'` 求值即可复现），`\uXXXX` 转义未验证过，别赌。
   - 应用**内部**代码（app/js）不受影响——这个坑只存在于"经调试协议注入的文本"。
2. **🔴 会弹系统 UI 的调用（adapter.pair 弹 PIN 框）会永久挂起**。必须 `Promise.race` 加超时（bt-diag-snippet.js 的 `t(p, ms)`），否则整条 Promise 链停摆、诊断永远等不到 done。
3. **诊断结果不要指望 eval 的返回值**。返回值要过 longString 拼接，大对象又慢又脆；结果写 `window.__xxx` 全局变量 + 短 eval 轮询才是稳的。
4. **新连接 ≠ 旧连接的尸体能复用**。actor 名每次连接都换（conn111 → conn112…），挂过的连接直接弃掉重连，别在旧连接上重试。
5. **重插 USB 后 forward 静默失效**。症状是"脚本超时但手机明明好好的"，先重建 forward 再怀疑别的。
6. **截图 vs 照相**：`rdd.js shot` 拿的是系统渲染帧，比拍屏幕清楚，且能抓到熄屏前最后一帧；给用户看的现场弹窗（权限框）才需要人拍照。

## 七、快速排障表

| 症状 | 原因 | 处理 |
|---|---|---|
| 脚本零输出超时 | forward 失效 / 通道僵死 / USB 断 | `adb devices` → 重建 forward → `pkill b2g` |
| 注入后无响应，之前好的 | 片段含非 ASCII | 杀掉连接；`grep -cP "[^\x00-\x7F]"` 校验后改纯 ASCII |
| 诊断永远等不到 done | 某调用挂起（pair PIN 框） | 片段内所有可疑调用加 `t(p, ms)` 超时 |
| result 是对象拿不全 | longString 未展开 | 用 rdd.js 的 `unlongify()` |
| logcat 里没有刚才的日志 | 环形缓冲区已被冲掉 | 复现后立即抓；加 `-t 10000` |
| install 后还是旧版本 | 缓存/未重开应用 | 装完杀掉应用重开，看面板版本号（v6 等） |
