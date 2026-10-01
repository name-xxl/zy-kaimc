# ZY-KaiCam — 用智云云鹤 M2 的按键控制 KaiOS 相机

Nokia 2720 Flip（KaiOS 2.5，旧固件 build 22-）上的 privileged 应用：通过 BLE 连接智云云鹤 M2 云台，
把云台按键映射为手机相机的快门/录像，并提供键盘可调的相机参数（ISO/白平衡/曝光补偿等，按 HAL 实际能力生成）。

## 目录

```
app/            主应用（manifest type=privileged；权限 bluetooth / camera / device-storage）
tools/probe/    BLE 探针应用（先装它：枚举云台 GATT、监听并显示按键原始字节）
docs/           install-2720.md 装机指南；protocol.md 协议笔记（实测数据填这里）
scripts/        build.js（语法检查 + 协议自测 + 打包 zip）、make-icons.js
dist/           构建产物 zy-kaimc.zip / zy-probe.zip
```

## 快速开始

1. 按 [docs/install-2720.md](docs/install-2720.md) 准备：手机拨 `*#*#33284#*#*` 开发者模式，电脑配 WebIDE 或 gdeploy。
2. **先装探针**（WebIDE 选 `tools/probe/manifest.webapp`，或 `dist/zy-probe.zip`）：
   连上 `CRANE-M2-XXXX`，依次按云台各按键，把屏幕上的 `[IN]` 字节行记录到 [docs/protocol.md](docs/protocol.md)。
   这一步同时回答三件事：M2 是否用 fee9 特征对、通知能否触发（还是要轮询）、各按键的命令字节。
3. 再装主应用（WebIDE 选 `app/manifest.webapp`，或 `dist/zy-kaimc.zip`）。
   若探针测出的按键字节与默认映射不同，改 `app/js/main.js` 里的 `BUTTON_MAP` 后重装。

## 构建

```
node scripts/build.js
```

自动完成：全部 JS 语法检查、manifest 校验、CRC16/帧编解码自测（含 Weebill-S 实测心跳样例）、
共享 JS 同步到探针、打包两个 zip。无任何 npm 依赖。

## 按键说明（主应用）

| 输入 | 动作 |
|---|---|
| 云台快门键（协议 cmd 0x20） | 拍照 / 录像起停（跟随当前模式） |
| OK / 中键 | 快门 |
| 左软键 | 相机参数菜单（↑↓ 选择，←→ 改值，实时生效） |
| 右软键 | 拍照 ↔ 录像 模式切换 |
| ↑↓（取景时） | 变焦（HAL 支持时） |
| ←→（取景时） | 曝光补偿 |
| 1 / 3 | 循环白平衡 / ISO |
| 9 | 重试相机初始化 |
| # | 开/关屏幕调试面板（相机与 BLE 每步日志） |
| 返回键 | 菜单中=关闭菜单；取景界面=退出应用 |

## 当前状态与风险

- [x] 协议层：CRC16-XMODEM 与帧编解码通过 Weebill-S 实测样例自测（本地可验证）
- [ ] 真机：2720 开发者模式连通、privileged 应用安装
- [ ] 真机：探针确认 M2 的 GATT 特征与按键字节（**go/no-go 门槛**）
- [ ] 真机：相机取景/拍照/录像与参数

已知风险（均有对策，详见 docs/）：

1. **M2 协议与 Weebill-S 有差异（约 20% 概率）** → 探针实测为准，字节写在 `BUTTON_MAP`，只改映射不改架构。
2. **KaiOS 实机 GATT 通知可能不触发**（kaios.dev 实测结论）→ 主应用与探针都内置 100ms `readValue` 轮询差分兜底。
3. **2720 的 2MP 相机 HAL 参数不全** → 参数菜单按 `capabilities` 动态生成，缺的自动隐藏，不影响快门功能。
4. **固件无中文字形** → 把 `app/js/strings.js` 的 `LANG` 改为 `'en'`。

## KaiOS 相机旋转三层模型（2720 实测定论）

| 层 | 行为 |
|---|---|
| 预览 | HAL 出横向原始帧，App 以 CSS `rotate(sensorAngle=270°)` 补偿（与 Gaia kania 官方一致） |
| 录像 | 编码帧恒为横向原始帧（固件不烤像素旋转）；tkhd 矩阵 = (传入 rotation + sensorAngle) mod 360 = 270°；`setConfiguration` 不带 rotation（Gaia 从不传）；`startRecording` 的 rotation 只传屏幕方向角（竖屏锁定 = 0） |
| 播放 | `.3gp`：播放器遵守 tkhd 矩阵 → 正立；`.mp4`：忽略矩阵 → 横放。**因此录像固定存 `.3gp`**；竖屏小窗横条为平台行为（系统相机文件同样如此），观看用「全屏」 |

⚠ 前提：录制前必须 `screen.orientation.lock('portrait')`（App 已内置于启动/快门/录像流程），否则矩阵错乱。
⚠ 调试注意：ffmpeg/PotPlayer 抽帧与播放会自动应用旋转矩阵——「抽出来的帧是正立的」不代表像素烤入了旋转，判断帧方向务必加 `-noautorotate`。
