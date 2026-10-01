# tools/diag — 真机诊断脚本（一次性/按需）

配合 `docs/debug-log.md`（通道与注入方式）与 `scripts/parse-btsnoop.js`（抓包解析）使用。
这些脚本多数是某次排查的现场工具，保留是为了复现与灵感，不保证长期兼容。

| 脚本 | 用途 |
|---|---|
| `bt-fake-diag-snippet.js` | **接收链路判定实验**：自行扫描→连接（优先 CRANE/M2）→订阅→发官方初始化→统计收到的字节 |
| `bt-fake-diag2-snippet.js` | 同上变体：只调 `startNotifications()`（不手写 CCCD），用于对照订阅是否登记 |
| `bt-fake-diag3-snippet.js` | 读设备名(0x2A00) + CCCD 前后读值，验证"读是真实往返"与 CCCD 写入效果 |
| `bt-fake-diag4-snippet.js` | 读特征对象 `.value` 轮询：**证明通知值会更新 .value 而事件不触发**（接收方案由此确定） |

> 结论都已落地到 `app/js/session.js`（轮询 `.value`）与 `docs/protocol.md`（接收路径实测表），
> 这些脚本只在需要重新验证时使用。
> 一次性脚本（注入片段/看板轮询/列应用/合抓包等）在收尾时已删除；需要时用
> `node scripts/rdd-console.js "<纯 ASCII 表达式>"` 直接跑即可（见 `docs/debug-log.md`）。

配对工具见 [`tools/fake-gimbal`](../fake-gimbal/README.md)（PC 端假云台）。
