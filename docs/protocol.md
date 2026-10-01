# 智云云鹤 M2 BLE 协议笔记

## 已知部分（2026-10-01 ZY Play 抓包实锤，原始解析见 docs/capture-zyplay-2026-10-01.txt（仅云台链路、MAC 已打码）；早期资料：Weebill-S / Crane 2S 逆向）

来源：
- https://petermaguire.xyz/posts/zhiyun-weebil-s-ble-protocol/ （Weebill-S 完整逆向）
- https://github.com/zhiyun-crane2s/bte-protocol （Crane 2S，与 Weebill-S 完全一致）
- https://github.com/Peter-Maguire/bleebil （客户端 + 假云台模拟器）

### 广播与连接
- 广播名：`CRANE-M2-XXXX`（XXXX = 云台俯仰电机旁贴纸 USER ID）
- 无配对码，App 直接 GATT 连接；云台开机即可被扫描；同一时间只服务一个中心设备。

### GATT
| 角色 | UUID |
|---|---|
| Service | `0000fee9-0000-1000-8000-00805f9b34fb` |
| App→云台（writeWithoutResponse） | `d44bc439-abfd-45a2-b575-925416129600` |
| 云台→App（notify） | `d44bc439-abfd-45a2-b575-925416129601` |

Android nRF Connect 实测（2026-10-01，CRANE-M2_XXXX / c4:4f:33:xx:xx:xx，未配对直连）：
- 129600：**Properties: WRITE NO RESPONSE**（无 READ/NOTIFY）
- 129601：**Properties: NOTIFY**，含 **CCCD 描述符 0x2902**（即我们手动写 `0x2902=0x0001` 是正确使能值；该特征无 READ，轮询读值不可能）
- 服务表共 3 个：`0x1800`（GAP）、`0x1801`（GATT）、`0xFEE9`

### 帧格式（抓包实锤）
```
24 <DIR> <LEN:2B 小端> <FMT:2B> <inc:1B> <flag:1B> <CMD:1B> <ARGS…> <CRC16:2B 小端>
DIR  3C=App→云台  3E=云台→App（云台的"按键上报"帧 dir 仍是 0x3C！）
FMT  1812=命令帧  1815=心跳  1818=会话固定帧（App 发 24 3C 05 00 18 18 09 00 01 A3 16）
flag 01=App 请求  10=云台应答/上报
LEN  从 FMT 字节起到 ARGS 末尾的字节数（不含 4 字节头、不含 CRC）；小端存放
CRC  CRC16/XMODEM（init 0x0000，poly 0x1021），对 FMT..ARGS 计算，小端存放
```
实测样例（Weebill-S 心跳）：`24 3E 0C 00 18 15 08 00 01 80 50 10 C2 01 00 00 98 4B`（CRC=0x4B98）

### 官方 App 初始化序列（抓包实录，逐帧）
```
→ 0x04 00 00 00     （发 3 次直到应答）
← 24 3E 08 00 18 12 01 01 04 00 CA 00 …   （应答，参数 CA 00）
→ 0x7C/0x7D/0x7E/0x7F 00 00 00            （读序列号，各自被回显确认）
→ 24 3C 05 00 18 18 09 00 01 A3 16         （FMT 0x1818 固定帧，原文回显）
→ 0x06 00 00 00                            （电量）
← 24 3E 08 00 18 12 08 01 06 00 38 04 …   （电量应答：0x0438）
```
无配对/绑定（无 SMP 流量）；官方 App **不发心跳**；应答与请求同 inc 同 cmd，仅 ARGS 不同。

### 接收路径（KaiOS 2.5 实测结论，2026-10-01 假云台对照实验）
| 环节 | 实测结果 |
|---|---|
| App→外设 写特征值 | ✅ 正常，字节不差到达外设（PC 端 GATT 服务器日志验证） |
| `startNotifications()` | ❌ 空壳：不写 CCCD、不派发任何事件 |
| 手动写 CCCD `0x2902=0001` | ✅ 有效：外设立刻登记订阅（`subscribed_clients` 从 0 变 1） |
| 外设→手机 通知 | ✅ 进入蓝牙栈，**特征对象的 `.value` 会随每条通知更新** |
| `oncharacteristicchanged` / addEventListener | ❌ **永远不触发**（这就是 kaios.dev "KaiOS 不支持通知"的含义） |
| `readValue()` 轮询 | ❌ 通知特征无 READ 属性，ATT 读被栈直接拒绝 |

⇒ **接收实现 = 100ms 轮询 `notifyChar.value`（本地缓存读）+ 差分**，见 `app/js/main.js startPolling()`。

### 按键上报（核心）
云台以 notify 主动推（dir 仍是 0x3C，flag=0x10）：
```
← 24 3C 08 00 18 12 01 10 20 C0 3D 00 7C 57
← 24 3C 08 00 18 12 02 10 20 C0 3D 00 9C 99
← 24 3C 08 00 18 12 03 10 20 C0 17 00 11 35   …
```
格式 `CMD=0x20，ARGS = C0 <键码> 00`。实录到过的键码：`3D、17、27、18、28`（各出现多次；与物理键的对应关系待逐个按键实测）。

### 已知命令
| CMD | 含义 | 备注 |
|---|---|---|
| 0x20 | 按键事件 | payload 例 `c0 3c 00`（Weebill-S 快门键） |
| 0x80 | 心跳 | 例 payload `50 10 c2 01 00 00`（可能含电量） |
| 0x06 | 电量 | |
| 0x27 | 云台模式设置 | PF/L/F/POV/GO |
| 0x01/02/03 | 俯仰/平移/横滚速度 | |
| 0x68 | 相机品牌设置 | |
| 0x7C–7F | 序列号读写 | |

## 云鹤 M2 实测（装 zy-probe 探针后填写）

探针操作：连接后依次按云台按键，记录 `[IN]` / `[POLL]` 行字节；按 `5` 发心跳、`6` 请求电量、`*` 开关自动心跳。

- [x] service 是否为 fee9，特征对 UUID 是否一致：**是**（2026-10-01 实机 bt-diag：发现服务 1801/1800/fee9；fee9 下 `d44bc439-…-129600`（写）与 `…-129601`（通知），与 Weebill-S 一致）
- [x] notify 事件是否触发：**是**。CCCD 需手动写（`startNotifications()` 是空壳，不写 0x2902）；2026-10-01 抓包确认云台以 notify 主动上报应答与按键
- [x] 是否需要先发心跳/握手：**不需要心跳**；需要官方初始化序列（见上：0x04 → 0x7C-0x7F → 0x1818 → 0x06），跑完云台才上报按键
- [x] 拍照/录像键（正面左下）：**单击** `C0 3D 00` → 录像起停；**双击** `C0 3C 00` → 拍照（与 M2 说明书、官方协议 `C0 3C 00`=拍照 完全一致）
- [x] 变焦杆 T/W（左侧）：**T 上推** = `C0 18 00`（按下）+ `C0 28 00`（释放）；**W 下推** = `C0 17 00`+`C0 27 00`。App 映射：**按住连续变焦**（按下立即一档、之后每 180ms 一档），**松开即停**（释放码），短拨一下=一档，到顶/到底自动停
- [x] M 键（模式，正面右下）与扳机键（背面）：**不上报 BLE**（纯本地动作；管道确认活着时按多次 App 侧零事件）→ 无需映射
- [ ] 菜单键 / 摇杆：未逐个实测（如需再补）
- [ ] 云台电量帧：应答 `24 3E 08 00 18 12 08 01 06 00 38 04 …`（电量在 ARGS，例 0x0438）
- [x] 连接后云台是否主动发帧（握手/状态）：**无自发心跳**；只在被请求时应答、按键时上报

抓包日期 / 云台固件版本：

> 填完后把按键字节同步到 `app/js/main.js` 的 `BUTTON_MAP`（cmd → 动作），
> 若帧结构与上不同，改 `app/js/zhiyun.js` 的帧解析参数即可。

## App 模块职责（低耦合分层）

```
app/js/
  config.js    时序/帧常量/键码/DEBUG 开关（app 与探针共享）★
  util.js      DOM/Promise/hex 小工具
  strings.js   文案（zh/en）
  ui.js        软键/HUD/toast/参数菜单
  ble.js       BLE 传输层 KaiBt（适配器/扫描/连接/CCCD 订阅/写特征）★
  session.js   云台会话层 KaiSession（连接→订阅→官方初始化序列→轮询 .value→状态回调）★
  buttons.js   键码→动作分发（动作由 main 注入）★
  zhiyun.js    协议编解码（帧/CRC/Parser/Client）★
  camera.js    相机 HAL 封装
  main.js      编排：相机 + UI/键位 + 会话 + 按键
tools/probe/   探针（复用 ★ 共享层，仅剩 UI 与诊断键）
```

分工原则：`main.js` 不碰 BLE 细节；`session.js` 不碰 UI/相机；`buttons.js` 不依赖具体动作实现。
★ 的文件由 `scripts/build.js` 逐字节同步到 `tools/probe/js/`（改完跑一次 build 即保证两份一致）。
