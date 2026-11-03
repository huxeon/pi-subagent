# 06 — subagent 工具与调用展示

## 依赖与阅读

- 依赖 05，阅读相关交接。
- spec：第 4、10 节，3.3、第 5 节。
- 当前 Pi 的工具 schema、execute 取消、renderCall/renderResult 和 TUI 文档及相关示例，按开发环境规则阅读。

## 目标

父角色注册单一 subagent 工具，接入管理服务，并实现已确认的英文卡片展示。

## 工作

1. 固定操作字段和 schema（例如 op），覆盖 create/message/inspect/destroy；检查各操作参数，wait 必须有 name，timeout 默认 1800 秒。
2. 子角色不注册工具；非 TUI 模式业务仍可用。
3. 转发工具取消信号；inspect 取消只结束当前请求，不停止子代理。
4. 明确模型可见 content 与渲染 details，保证会话重载时卡片无需实时进程也能重建。不额外复制子会话作为持久化管理状态。
5. renderCall/renderResult 按 spec 第 10 节执行：英文提示、原文 prompt/回复、空行、✓/✗、create 的 cwd 和 provider/model:thinking、message 仅显式 follow-up 且统一 Delivered。
6. inspect 不等待仅状态；等待返回最新回复并 Markdown 渲染。默认紧凑、展开完整，处理长度限制与错误信息。
7. 等待、取消、超时、连接错误分别展示；错误与 idle 状态不混淆。不得把请求失败当普通成功工具结果。

## 验收

- 四种操作的 schema、分发、取消和错误测试。
- 卡片测试/快照覆盖 create 前后、message 两种参数、inspect 列表/状态/等待/结果、destroy、取消/超时/错误、折叠/展开、中文/长文本/窄宽度。
- 非等待 inspect 不泄漏最新回复；无误报任务成功。
- typecheck 与现有测试通过。

## 非目标

常驻 widget 和 /subagent 选择界面留给 07。
