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
node scripts/build.js          # 语法 + 协议自测 + 同步共享 JS + 打包
node scripts/test-session.js   # 会话层仿真回归（假适配器，不碰真机）
```

自动完成：全部 JS 语法检查、manifest 校验、协议自测（含 ZY Play 抓包回归）、**悬空成员检查**
（模块导出的成员 vs 全仓成员访问，专防"函数被删、调用还在"这类回归——`U.withTimeout` 事件就是它没在）
、共享 JS 同步到探针、版本一致性自检（HUD 版本 ↔ manifest 版本）、打包。无任何 npm 依赖。

产物：`dist/zy-kaimc-<版本>.zip`（**交付件**）＋ `dist/zy-kaimc.zip`（最新副本，供脚本/文档引用）；
探针同理 `zy-probe-<版本>.zip` / `zy-probe.zip`。

## 分发与交付

交付物就是**打包应用 zip**（`manifest.webapp` + 全部文件）。两条安装路径要分清：

| 路径 | 交付物 | 需要签名？ | 适用 |
|---|---|---|---|
| **开发者模式侧载**（WebIDE / gdeploy / adb，本项目当前方式） | 同一个 zip | **不需要** | KaiOS 2.5 机型（2720 / 8110 …）；对方需先开开发者模式，见 [docs/install-2720.md](docs/install-2720.md) |
| **KaiStore 上架** | 同一个 zip，但必须先**签名**：`kaios-sign` 生成密钥对 → 公钥交 KaiOS 换证书 → 包内带 `META-INF` 签名 | **必须**（未签名包只能装开发机） | 面向公众分发；包大小上限 20 MB（本包约 37 KB） |

- **中国区合规（CTA）**：面向中国市场的系统是 KaiOS 2.5.2.1 / 2.5.4.1。对**联网或读通话记录**的 privileged 应用，
  manifest 必须补 `mobiledata` / `wifidata` / `calllog` 权限并弹安装确认窗，否则不上架。
  **本应用不联网**（只有 bluetooth / camera / storage），按官方 FAQ 原文"无需做任何修改"。
- **KaiOS 3.0 侧载已被锁死**（Firefox/Pale Moon 的 WebIDE 已移除、未签名包直接被拒，只剩"注册开发者→签名→上架→把自己手机登记为 tester"）
  ——这也是本项目锁定 2.5 机型的原因之一。

## 按键说明（主应用）

| 输入 | 动作 |
|---|---|
| 云台**拍照/录像键单击**（键码 `0x3D`） | 拍照 / 录像起停（跟随当前模式） |
| 云台**拍照/录像键双击**（键码 `0x3C`） | 拍照 |
| 云台**变焦杆 T / W**（键码 `0x18` / `0x17`） | 按住连续变焦，松开即停（释放码 `0x28`/`0x27` 忽略） |
| 云台 M 键 / 扳机键 | 云台本地动作（不上报 BLE，App 无响应，属正常） |
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

- [x] 协议层：CRC16-XMODEM 与帧编解码通过 Weebill-S 样例 + ZY Play 抓包回归（`scripts/build.js` 自测）
- [x] 真机：2720 开发者模式连通、privileged 应用安装
- [x] 真机：GATT 链路实测连通（FEE9 过滤扫描 → `connect()`/`discoverServices()` → fee9 + 129600 写/129601 通知；不需要配对）
- [x] 真机：云台按键全链路（单击 `0x3D`=录像起停、双击 `0x3C`=拍照、变焦杆 T/W 按住连续变焦；接收=100ms 轮询 `.value`）
- [x] 真机：相机取景/拍照/录像与参数（取景 320×240、白平衡、数码变焦 2×、曝光补偿、照片 1600×1200 已验证）

已知风险与对策（详见 docs/）：

1. **KaiOS 不派发 GATT 通知事件**（本机实测）→ 接收改为 100ms 轮询特征对象 `.value`（本地缓存读；通知值会同步进来）；`readValue()` 对通知特征必败（无 READ 位）。实现见 `app/js/session.js`，实测表见 `docs/protocol.md`。
2. **云台状态字节 ↔ 模式名（PF/L/POV）尚未映射** → 应用每 5s 用官方 `0x1817` 查状态并记录状态字节变化；按 M 键切模式时对照面板日志即可完成映射。
3. **2720 的 2MP 相机 HAL 参数不全** → 参数菜单按 `capabilities` 动态生成，缺的自动隐藏，不影响快门功能。
4. **固件无中文字形** → 把 `app/js/strings.js` 的 `LANG` 改为 `'en'`。

## KaiOS 相机旋转三层模型（2720 实测定论）

| 层 | 行为 |
|---|---|
| 预览 | HAL 出横向原始帧，App 以 CSS `rotate(sensorAngle=270°)` 补偿（与 Gaia kania 官方一致） |
| 录像 | 编码帧恒为横向原始帧（固件不烤像素旋转）；tkhd 矩阵 = (传入 rotation + sensorAngle) mod 360 = 270°；`setConfiguration` 不带 rotation（Gaia 从不传）；`startRecording` 的 rotation 只传屏幕方向角（竖屏锁定 = 0） |
| 播放 | `.3gp`：播放器遵守 tkhd 矩阵 → 正立；`.mp4`：忽略矩阵 → 横放。**因此录像固定存 `.3gp`**；竖屏小窗横条为平台行为（系统相机文件同样如此），观看用「全屏」 |

⚠ 矩阵与屏幕方向锁**无关**（VID_rot0 实证：rotation:0 恒得 270° 矩阵）；lockPortrait 仅作竖屏 UI 方向稳定保险保留。
⚠ 调试注意：ffmpeg/PotPlayer 抽帧与播放会自动应用旋转矩阵——「抽出来的帧是正立的」不代表像素烤入了旋转，判断帧方向务必加 `-noautorotate`。
