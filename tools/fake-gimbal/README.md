# tools/fake-gimbal — PC 端"假云台"（Windows GATT 外设）

用 Python + Windows WinRT 把自己电脑变成一个 BLE 外设：广播 fee9 服务与智云两个特征，
让 KaiOS 应用连上来看它到底发了什么、能否收到通知。**接收链路的定论就是用它做的对照实验。**

## 依赖

```
py -m pip install "winrt-runtime" "winrt-Windows.Devices.Bluetooth" \
  "winrt-Windows.Devices.Bluetooth.GenericAttributeProfile" \
  "winrt-Windows.Devices.Bluetooth.Advertisement" \
  "winrt-Windows.Foundation" "winrt-Windows.Storage.Streams"
```

（`bless` 在 Windows + Python 3.13 上装不起来，故直接用 WinRT。）

## 用法

```
py tools/fake-gimbal/fake_gimbal.py --notify 4
```

- 启动后创建服务 `0000fee9-…`、写特征 `…129600`（WriteWithoutResponse）、通知特征 `…129601`（Notify），并以"可连接"方式广播；
- 收到的每一帧写都会打印 `[WRITE] 24 3C …`，并原样回显成 `[ECHO]`（模拟真云台应答）；
- 每 `--notify` 秒推一条假按键帧 `[NOTIFY] 24 3E … 10 20 C0 3D 00`；
- 每 4 秒打印一次 `[SUBS] count=N`（订阅登记情况——CCCD 是否真的写进来）。

## 已知限制与坑

- **广播名不可自定义**：WinRT 的 `BluetoothLEAdvertisementPublisher` 不接受本地名（会报参数错误），
  provider 的广播用系统蓝牙名（即电脑的蓝牙名，本机实测时需按实际名字匹配）。因此应用侧"按名字匹配"的逻辑连不上它，
  需要 `tools/diag/bt-fake-diag*.js` 这类"自定义扫描/直连地址"的注入脚本来驱动。
- 同时只能有一个进程持有该服务：重跑前先结束旧的 python 进程，否则第二个实例起不来（日志会写乱）。
- 结论：KaiOS 侧**写特征值会字节不差地到达外设**；通知**能进栈并更新 `.value`，但 JS 事件永不触发**。
