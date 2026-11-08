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
subagent({ action: "send", name: "reviewer", message: "重点检查并发", mode: "steer" });
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
| `mode` | 否 | `"steer"` 或 `"followUp"`，默认 `"steer"` |

执行规则：

- 名字不存在时返回错误。
- 子代理空闲时启动新运行。
- 子代理运行中时，按 `mode` 提交 steering 或 follow-up 消息。
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

// send：空闲时启动，运行中按 mode 排队。
await client.prompt(message, undefined, mode);
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
- `send.mode` 只控制父到子的消息，不影响回报模式。
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
