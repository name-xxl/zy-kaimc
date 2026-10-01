# 智云云鹤 M2 BLE 协议笔记

## 已知部分（来自 Weebill-S / Crane 2S 逆向，M2 大概率同源；GATT 结构已实机确认 2026-10-01，帧/按键**待探针确认**）

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

### 帧格式
```
24 <DIR> <LEN:2B 大端> <FMT:2B> <SEQ:2B 大端> <TYPE> <CMD> <PAYLOAD…> <CRC16:2B 小端>
DIR  3C=App→云台  3E=云台→App
FMT  1812=普通命令  1815=心跳
TYPE 01=命令  10=响应
LEN  从 FMT 字节起到 PAYLOAD 末尾的字节数（不含 4 字节头、不含 CRC）
CRC  CRC16/XMODEM（init 0x0000，poly 0x1021），对 FMT..PAYLOAD 计算，小端存放（低字节在前）
```
实测样例（Weebill-S 心跳，已通过本地自测）：`24 3E 00 0C 18 15 08 00 01 80 50 10 C2 01 00 00 98 4B`
（CRC 计算值 0x4B98，帧内存为 `98 4B`）

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
- [x] notify 事件是否触发：**CCCD 已实测使能**（2026-10-01：`startNotifications()` 是空壳、不写 0x2902；应用手动写 `0x2902=0x0001` 成功并回读 `01 00`）。**但使能后按云台按键、静置 30s+ 均未收到任何字节**（POLL 已关，`[IN#]` 零行）→ 待判：云台需先握手？还是该固件不把通知派发给 JS
- [ ] 是否需要先发心跳/握手，云台才上报按键：**疑似需要**——只发 0x80 心跳 + 0x06 电量查询时云台零应答；抄官方 App 的初始化序列（安卓 HCI 日志，用 `scripts/parse-btsnoop.js` 解）
- [ ] 快门键 短按：`24 3E …`（完整字节）
- [ ] 快门键 长按：
- [ ] 录像键：
- [ ] 模式键：
- [ ] 云台电量帧：
- [x] 连接后云台是否主动发帧（握手/状态）：**未观察到自发帧**（CCCD 使能后 30s+ 静默，连心跳都没有）

抓包日期 / 云台固件版本：

> 填完后把按键字节同步到 `app/js/main.js` 的 `BUTTON_MAP`（cmd → 动作），
> 若帧结构与上不同，改 `app/js/zhiyun.js` 的帧解析参数即可。
