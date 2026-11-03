# 01 — 验证 Pi API、落盘与恢复

## 目标

消除 spec 第 12 节中的关键假设，先验证后实现。本任务以探针、测试和结论文档为主，不实现完整扩展。

## 最小阅读范围

- spec：第 3、5、6、8、12 节，以及 4.2、4.3。
- 本地参考：shared.ts 的 launchRun；index.ts 的子代理和生命周期部分。
- 当前安装 Pi 的 extensions、session-format、sessions、cli、SDK 相关文档及实际类型/源码；按开发环境要求完整阅读相关 Markdown 并跟随必要交叉引用。

## 工作

1. 确认包名、版本和实际 API：工具注册/取消信号、session_start/shutdown reason、agent_settled、isIdle、sendUserMessage、最新回复与当前分支读取。
2. 验证初始会话何时写入 provider/model/thinking/cwd；只有 session.jsonl 时如何恢复这些设置。特别检查无首次模型回复时的会话能否恢复。
3. 确认首次启动和恢复启动的 CLI 方式，避免恢复时被默认配置覆盖。
4. 验证正常资源发现与显式控制桥加载如何共存，防止桥重复注册；确认子代理不注册 subagent 工具的角色判断方案。
5. 验证如何正常停止 tmux 中的 Pi、等待落盘及退出；不要假设 kill-session 一定触发全部清理。
6. 明确当前环境可验证和无法验证的内容。避免为验证发起付费模型请求；需要真实模型时先征得用户同意。

## 交付

- `docs/implementation-notes.md`：记录 API、版本、源码依据、启动/恢复/停止结论。
- 必要的可复用探针或测试，使用临时目录并清理资源。
- `docs/tasks/handoffs/01.md`。

## 验收

- 后续会话能据文档实现子桥和恢复，不再猜测 Pi 的持久化行为。
- 未验证假设明确标注；如果单 session 文件恢复与 spec 冲突，先向用户报告，不能自行增加 metadata。
- 不留下子进程、tmux session 或用户目录中的测试数据。
