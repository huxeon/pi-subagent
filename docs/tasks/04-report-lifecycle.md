# 04：回报与运行时清理

## 目标

补齐管理器的 settled 回报和可靠的 session-scoped 清理，处理异步事件、启动和关闭之间的竞态。

## 前置与阅读

- 任务 01–03 已完成。
- 阅读规格、任务索引、前置交接及管理器、RPC 适配器和测试。
- 阅读 Pi 的 agent_settled、session_shutdown、sendMessage 文档及 RpcClient 的异步事件回调实现。

## 实现范围

1. 监听每个子代理的 agent_settled，仅在此边界读取 `getLastAssistantText()`。
2. 构造含名字和最后文本的回报；null 时明确无可用文本，不拼接历史或转发 thinking、工具过程。
3. 通过可注入的父投递函数调用 `pi.sendMessage()`，固定 customType 为 `subagent.report`，display 为 true，deliverAs 为 steer，triggerTurn 为 true。
4. 一次 settled 回报一次；不按 send 计数，不为 handled 等待不存在的 settled。
5. 捕获 SDK 不等待的异步事件回调中的错误，避免未处理的 Promise rejection；不因此增加异常退出通知或自动重试。
6. 实现管理器 shutdown：先标记关闭、阻止新请求和回报，再并行停止、取消订阅、清空记录及预留名字。
7. shutdown 幂等且有界，处理启动中、已退出、停止失败等资源状态。
8. 异步 getLastAssistantText、启动确认或初始 prompt 在 shutdown 后才完成时，不能泄漏子进程、重新加入记录或向旧父运行时投递消息。

可以将回报构造放在 `src/report.ts`；避免在每个事件回调中散落格式和生命周期判断。

## 必须测试

- agent_end 不回报，settled 才回报；结果只来自 getLastAssistantText。
- 回报 customType、content 中的名字/文本、display、deliverAs 和 triggerTurn 正确。
- null 文本、连续两次运行、多条 send 合并到一次 settled。
- 文本读取失败或父投递失败不会产生未处理 rejection，不自动重试或报告崩溃。
- 并行启动与 shutdown 交错时最终无遗留客户端、监听器和预留名字。
- shutdown 发生在文本读取期间，不投递迟到回报。
- 关闭后 spawn/send 拒绝；重复 shutdown 安全；一个子代理停止失败不阻止其他子代理清理。
- 无异常退出专用监听通知或恢复逻辑。

测试需控制 Promise 完成时机，避免仅用 sleep 猜测竞态。

## 验收与交接

- 类型检查和全部默认测试通过。
- 回报后子代理保持可发送，只有运行时清理才批量停止。
- 写入 `docs/tasks/handoffs/04.md`，说明父投递函数、shutdown 接口、错误处理及已覆盖的竞态。
