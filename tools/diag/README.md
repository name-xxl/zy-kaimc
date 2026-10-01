# tools/diag — 真机诊断脚本（一次性/按需）

配合 `docs/debug-log.md`（通道与注入方式）与 `scripts/parse-btsnoop.js`（抓包解析）使用。
这些脚本多数是某次排查的现场工具，保留是为了复现与灵感，不保证长期兼容。

| 脚本 | 用途 |
|---|---|
| `tmp-run-snippet.js` | 往运行中的应用注入 JS 片段并轮询结果变量：`node tools/diag/tmp-run-snippet.js <片段文件> [轮询表达式] [秒数]` |
| `tmp-watch-panel.js` | 每 2.5s 读一次应用屏上面板，变化即记录（配合真机手动操作） |
| `tmp-dump-console.js` | 读应用 console 缓存消息（面板外的另一条观察通道） |
| `tmp-list-apps.js` | 列出已安装应用（找带 bluetooth 权限的宿主/探针） |
| `tmp-cleanup-snippet.js` | 注入式清理：断开诊断脚本遗留的连接、停扫描 |
| `tmp-mkbtsnoop.js` | 造一个合成 btsnoop 文件，用于验证 `scripts/parse-btsnoop.js` |
| `bt-fake-diag-snippet.js` | **接收链路判定实验**：自行扫描→连接（优先 CRANE/M2）→订阅→发官方初始化→统计收到的字节 |
| `bt-fake-diag2-snippet.js` | 同上变体：只调 `startNotifications()`（不手写 CCCD），用于对照订阅是否登记 |
| `bt-fake-diag3-snippet.js` | 读设备名(0x2A00) + CCCD 前后读值，验证"读是真实往返"与 CCCD 写入效果 |
| `bt-fake-diag4-snippet.js` | 读特征对象 `.value` 轮询：**证明通知值会更新 .value 而事件不触发**（接收方案由此确定） |

> 结论都已落地到 `app/js/session.js`（轮询 `.value`）与 `docs/protocol.md`（接收路径实测表），
> 这些脚本只在需要重新验证时使用。

配对工具见 [`tools/fake-gimbal`](../fake-gimbal/README.md)（PC 端假云台）。
