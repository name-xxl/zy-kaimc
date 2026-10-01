# Nokia 2720 Flip 侧载与调试指南（旧固件 build 22-）

## 一次性准备（手机 + 电脑）

1. **开发者模式**：手机拨号 `*#*#33284#*#*`（=DEBUG）→ 设置里出现 Developer 菜单 →
   打开 **ADB and DevTools**。
2. **adb**：电脑装 Android platform-tools（[adb](https://developer.android.com/tools/releases/platform-tools)），
   手机插 USB，`adb devices` 应列出设备。
3. **转发调试端口**（每次重插 USB 后执行一次）：
   ```
   adb forward tcp:6000 localfilesystem:/data/local/debugger-socket
   ```

## 安装应用（两种方式任选）

### 方式 A：WebIDE（推荐，能看 console 日志）

- 安装 **Pale Moon 28.6.1** 或 **Waterfox Classic**（旧 Gecko 内核才有 WebIDE；新 Firefox 已移除）。
- 地址栏 `about:config`：`devtools.debugger.remote-enabled=true`、`devtools.debugger.prompt-connection=false`。
- 菜单 Tools → Web IDE → Remote Runtime → `localhost:6000`。
- Open Packaged App → 选本项目的 `tools/probe/manifest.webapp`（探针）或 `app/manifest.webapp`（主应用）
  → 点 **Install and Run**。

### 方式 B：gdeploy（命令行）

- `npm install -g gdeploy`（GitLab: bananahackers/gdeploy），然后：
  ```
  gdeploy install dist/zy-probe.zip
  gdeploy install dist/zy-kaimc.zip
  ```
- 装不上时退回方式 A。

## 首次运行

- 主应用首次打开会弹「允许 ZY-KaiCam 使用相机？」→ **允许**（privileged 应用的相机权限是弹窗制）。
- 云台：开机、靠近手机、**不要同时连 ZY Cami**（云台同时只服务一个 App）。
- 建议把系统设置的屏幕超时调长，避免取景中途熄屏。
- 先装探针抓按键字节，确认协议后再装主应用（见 README 快速开始）。

## 常见问题

| 现象 | 处理 |
|---|---|
| 提示「mozBluetooth 不可用」 | 安装方式不对：必须以 privileged 打包应用经 WebIDE/gdeploy 安装，浏览器直接开页面不行 |
| 相机 getCamera 超时/失败 | 先重启手机（排除系统相机占用 HAL）；看屏幕有无权限弹窗，有则**允许**后按 `9`；仍不行按 `#` 把面板内容发给开发者（面板含 app type、每步底层报错）。面板显示「无相机API」才说明 privileged 安装有问题 |
| 蓝牙开启超时 | 先确认**系统设置里蓝牙已打开**；App 会显示 `BT: enabled=? state=?` 原始状态，把该行内容发给开发者；检测不到状态时 App 会直接尝试扫描 |
| 扫不到云台 | 云台重启；确认系统蓝牙开着；确认设备名 `CRANE-M2-XXXX`（名字在机身贴纸/探针日志可见） |
| gatt.connect 失败 | 云台被别的 App 占用（ZY Cami 或旧会话），关云台重开 |
| 中文显示方框 | 固件无中文字形：把 `app/js/strings.js` 的 `LANG` 改为 `'en'` 重装 |
| 想看运行日志 | WebIDE console 可看到探针/主应用输出；主应用取景界面按 `#` 有屏幕调试面板（再按关闭） |

## 调试面板（主应用）

- `#` 键：开关面板。面板显示相机 API 与云台连接每一步的结果（含底层错误名/消息）。
- `9` 键：重试相机初始化（授权弹窗允许后、关闭系统相机后用）。
- 返回键：参数菜单里=关闭菜单；取景界面=退出应用。
