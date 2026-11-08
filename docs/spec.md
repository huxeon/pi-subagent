# 异步子代理扩展规格

## 1. 概述

基于 Pi RPC 模式实现异步、常驻、可多次交互的子代理。

- 提供一个名为 `subagent` 的模型工具，以 `action: "spawn" | "send"` 区分两个子命令。
- 每个子代理以名字作为唯一标识，名称在同一父会话内唯一。
- 工具只等待 RPC 接收确认，不等待任务完成。
- 子代理在 `agent_settled` 时回报，回报后保持运行，继续接受消息。
- 父代理 `session_shutdown` 时停止所有子代理。
- 不做持久化、恢复、重连或子代理异常退出的专门处理。

## 2. 工具接口

`subagent` 工具提供 `spawn`、`send` 两个子命令，通过 `action` 参数选择。模型使用结构化参数调用：

```ts
subagent({ action: "spawn", name: "reviewer", message: "检查代码" });
subagent({ action: "send", name: "reviewer", message: "重点检查并发" });
```

以下分别描述两个子命令的参数及行为。名字和消息必须是非空、非纯空白字符串；校验不改变原始文本，不编码名字、不归一化大小写。

### 2.1 spawn

启动子代理并发送初始消息。

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `action` | 是 | 固定为 `"spawn"` |
| `name` | 是 | 子代理名字，同一父会话内唯一 |
| `message` | 是 | 初始任务消息文本 |
| `provider` | 成组可选 | 子代理的 provider |
| `model` | 成组可选 | 子代理的 model ID |
| `thinking` | 否 | 子代理的 thinking level，可单独提供 |

模型配置规则：

- `provider`、`model` 必须同时提供或同时省略，仅提供其中一个时返回参数错误。
- 两者省略时，读取调用时父代理的 `ctx.model.provider` 和 `ctx.model.id`。
- `thinking` 独立可选；提供时使用指定值，省略时读取调用时父代理的 `ctx.thinkingLevel`。
- 无法取得所需的父代理配置时返回错误。
- 创建后不随父代理的模型配置变更自动同步。

执行流程：

1. 校验参数、检查重名并解析模型配置；重名时返回错误，不覆盖或复用既有子代理。
2. 预留名字，保证并发 `spawn` 不会创建同名子代理。
3. 在父代理当前工作目录启动 RPC 子进程。
4. 在发送消息前注册事件监听器。
5. 发送初始消息，等待 RPC 接收确认。
6. 返回子代理名字和接收状态。

启动或初始消息提交失败时，清理本次创建的资源并释放预留名字，返回错误。

### 2.2 send

通过名字向既有子代理发送消息。

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `action` | 是 | 固定为 `"send"` |
| `name` | 是 | 目标子代理名字 |
| `message` | 是 | 消息文本 |
| `followUp` | 否 | 布尔值，默认 `false`；为 `true` 时作为 follow-up 发送 |

执行规则：

- 名字不存在时返回错误。
- 子代理空闲时启动新运行。
- `followUp` 省略或为 `false` 时提交 steering，为 `true` 时提交 follow-up；不再接受旧的 `mode` 参数。
- 返回子代理名字和 RPC 接收状态，不等待任务完成。

## 3. RPC 客户端

使用 SDK 导出的 `RpcClient` 管理子进程，按名字保存在当前扩展实例的内存中。

启动配置：

- `cliPath`：所使用 Pi 版本的 CLI 入口绝对路径。
- `cwd`：调用 `spawn` 时父代理的工作目录。
- `provider`、`model`：解析后的模型配置。
- `args`：包含 `--no-session`、`--thinking <level>` 和 `--exclude-tools subagent`。

RPC 模式由 `RpcClient` 设置。启动子代理时通过 `--exclude-tools subagent` 按注册名排除整个 `subagent` 工具（包括 spawn/send 两个 action），避免嵌套调用；其他扩展和资源仍按 Pi 默认规则加载。

`start()` 后可通过 `getState()` 确认 RPC 可用及实际模型配置。

### 3.1 消息提交

统一使用 `RpcClient.prompt()`：

```ts
// spawn：发送初始消息。
await client.prompt(message);

// send：空闲时启动，运行中根据 followUp 排队。
await client.prompt(message, undefined, followUp ? "followUp" : "steer");
```

不使用 `client.steer()` / `client.followUp()` 作为统一发送入口，因为它们不会在子代理空闲时启动运行。

接收状态直接使用 SDK 返回值：

- `started`
- `queued`
- `handled`

`handled` 不保证产生对应的 `agent_settled`。不调用 `promptAndWait()`，也不等待 settled 后再返回工具结果。

### 3.2 提交错误

RPC 提交错误直接作为工具错误返回。压缩期间 `prompt` 被拒绝时，同样直接返回该错误，不暂存、不等待、不自动重试。

## 4. 结果回报

### 4.1 触发与内容

监听子代理 RPC 事件流中的 `agent_settled`，不使用 `agent_end` 作为回报边界。

收到事件后，通过 SDK 获取最后的 assistant 文本：

```ts
const text = await client.getLastAssistantText();
```

- 回报包含子代理名字和取得的文本。
- 文本为 `null` 时，明确表示没有可用的 assistant 文本。
- 不拼接全部消息，不转发 thinking、工具结果或完整执行过程。
- 一次 settled 对应一次回报，不要求每条 `send` 都有独立回报。
- 回报后保留子进程及会话上下文。

### 4.2 投递方式

父扩展调用 `pi.sendMessage()` 投递 custom message：

```ts
pi.sendMessage(
  {
    customType: "subagent.report",
    content: /* 子代理名字和结果文本 */,
    display: true,
    details: { name, text },
  },
  {
    deliverAs: "steer",
    triggerTurn: true,
  },
);
```

- 回报固定使用 `customType: "subagent.report"`。
- 默认 steer，并设置 `triggerTurn: true`，使父代理空闲时也能响应。
- 子代理名字和结果必须写入 `content`，不能只放在 `details` 中。
- `send.followUp` 只控制父到子的消息，不影响回报模式。
- RPC 事件回调中的异步操作需要自行捕获错误。

## 5. 生命周期与清理

子进程仅在 `spawn` 中按需创建，不在扩展 factory 中启动。

父代理 `session_shutdown` 时：

1. 标记正在关闭，拒绝新的 `spawn` / `send`。
2. 禁止继续向父代理投递回报。
3. 并行停止所有子进程，使用有界等待和强制终止兜底。
4. 移除监听器，清理子代理记录及预留名字。

清理适用于所有 shutdown reason：`quit`、`reload`、`new`、`resume`、`fork`。

清理必须幂等，并处理正在启动或已退出的子进程。延迟到达的异步回调不得向已关闭或被替换的父运行时投递消息。

新运行时从空的子代理集合开始，不恢复旧子代理；名字可以重新使用。

子代理异常退出暂不做专门处理：不增加退出通知、异常退出回报、自动重启或恢复机制。SDK 已有的请求失败行为保持不变。

## 6. 主界面状态展示

仅在 TUI 模式使用 widget，在输入框上方显示当前运行时的子代理名字和状态：

```text
Subagents  reviewer · working | coder · idle
```

- 界面文案使用英文：标题 `Subagents`，仅有 `working`（内部 `running`）和 `idle` 两种状态，不表示任务成功或子进程退出。
- 状态完全由子代理 RPC 事件驱动：`agent_start` 切换为运行中，`agent_settled` 切换为空闲；不使用 `agent_end`、工具确认或回报文本推断状态。
- 状态展示不额外调用 `getState()`，不轮询、不使用动画定时器；既有启动握手不变。
- 首次默认空闲；spawn 期间记录事件，但仅在 spawn 成功后展示最新状态。启动或初始消息提交失败不显示条目。
- send 的 `started`、`queued`、`handled` 确认均不直接修改状态；快速 settled 不得被迟到的确认覆盖。
- settled 时立即更新状态，不等待最后文本读取或父消息投递；这些操作失败不影响状态。
- 按创建顺序紧凑横排，子代理之间用淡色 ` | ` 分隔，换行处不保留悬空分隔符。宽度不足时换行，过长名字仅在展示时截断。
- `working` 使用主题 `warning` 色（默认黄色），`idle` 使用主题 `success` 色（默认绿色），始终保留状态文字。显示层处理控制字符，不改变真实名称。
- 没有子代理时隐藏；session_shutdown 时清空，迟到事件不得恢复旧条目，新运行时从空列表开始。
- 状态变化不发送聊天消息、不写会话历史、不触发父模型调用；现有工具返回及 `subagent.report` 保持不变。
- 不增加交互、管理命令、任务摘要、执行流水、计时、费用或异常退出检测。

## 7. 工具调用展示

使用 Pi 的工具 renderer，保留默认工具区域和展开交互，不新增快捷键。

- 标题为 `subagent spawn <name>` 或 `subagent send <name>`，整体加粗，使用空格分隔，不单独着色动作或名字。
- send 仅在 `followUp: true` 时附加普通文本 `(follow-up)`。
- 标题下展示原始任务文本，默认预览 3 个视觉行，展开后显示全文；窄终端按实际宽度换行。
- 成功后 spawn 底部展示 `✓ <Disposition> provider/model:thinking`，send 底部展示 `✓ <Disposition>`。
- Disposition 使用 SDK 接收结果的首字母大写形式：`Started`、`Queued`、`Handled`。对号仅表示提交已受理，不表示任务完成。
- spawn 配置使用本次创建时解析后的模型对和 thinking，包括继承值，通过工具结果 details 提供；不增加状态查询，也不随父配置变化重新计算。模型可见返回文本仍为原来的 `{ name, disposition }` JSON。
- 提交失败时底部显示 `✗ <错误原因>`，不伪造接收结果；图标使用主题 success/error 色，错误原因使用 error 色。
- 历史工具调用不随着子代理后续忙闲变化。部分参数、失败结果或缺失展示元数据不得导致 renderer 崩溃或猜测继承配置。

## 8. 子代理回报展示

为 `subagent.report` 注册专用消息 renderer：

- 标题为整体加粗的 `subagent report <name>`，正文按 Markdown 渲染。
- 默认预览 8 个正文视觉行，使用 Pi 现有展开交互查看全文；不附加任务成功、失败或进程退出判断。
- 通过结构化 `details: { name, text }` 取得名字和文本，不从 content 解析名字；缺失或无效 details 时使用 Pi 默认展示，兼容旧回报。
- `text: null` 显示 `(No assistant text available.)`；空字符串保持为空，不拼接历史或展示执行过程。
- 展示层处理控制字符，并遵循主题、终端宽度和输出缩进设置；不改变模型可见 content、回报时机和投递选项。
