# pi-subagent

Pi 异步命名子代理扩展。父代理通过一个 `subagent` 模型工具启动常驻 RPC 子进程、继续发送消息，并在子代理真正空闲（`agent_settled`）时收到结果。工具返回的是**接收确认，不是任务完成**。

## 安装与加载

需要已安装的 Pi 和 Node.js ≥ 22.19.0。当前实测环境为 **Pi 1.5.0、Node.js v26.13.0、Linux**；尚未验证其他 Pi 版本或最低 Node 版本。扩展直接加载 TypeScript，无需构建。

从本地 checkout 安装（将路径替换为实际绝对路径）：

```sh
pi install /absolute/path/pi-subagent
pi
```

也可在 Pi 的用户配置 `~/.pi/agent/settings.json` 中，将本扩展路径**合并**到现有 `extensions` 数组：

```json
{
  "extensions": ["/absolute/path/pi-subagent/index.ts"]
}
```

项目级配置需遵循 Pi 的项目信任规则。不要同时通过多个方式重复加载本扩展。Pi 提供宿主 SDK；本扩展不将其作为额外运行时依赖打包。

单次试用：

```sh
pi -e /absolute/path/pi-subagent/index.ts
```

`-e` 仅影响当前 Pi 调用，**不会作为启动参数转发给子代理**。子进程按 Pi 默认规则加载配置、扩展和其他资源；若希望父子都加载本扩展或某个自定义 provider，应把它们配置在子进程也能发现的位置（例如用户级扩展/包配置）。子代理仍会通过 `--exclude-tools subagent` 排除本工具。父会话仅在内存中动态注册的 provider、临时 `-e` 资源以及父会话历史不会自动复制给子进程。

## 模型工具

以下是模型的结构化工具调用示例，**不是 shell 命令或 `/subagent` 斜杠命令**。可以让父代理“启动名为 reviewer 的子代理审查实现，稍后汇总回报”。

### spawn：创建并提交初始任务

```ts
subagent({ action: "spawn", name: "reviewer", message: "审查实现与测试，返回主要问题" });

// thinking 可以单独指定，provider/model 仍继承父代理。
subagent({ action: "spawn", name: "deep-review", message: "重点检查并发", thinking: "high" });

// 显式选择模型；请使用本机 Pi 已配置且子进程可用的 provider/model。
subagent({
  action: "spawn", name: "specialist", message: "复核文档",
  provider: "openai", model: "gpt-4o-mini", thinking: "off",
});
```

| 参数 | 说明 |
| --- | --- |
| `action` | 必需，`"spawn"` |
| `name` | 必需，当前父会话内唯一的名字 |
| `message` | 必需，初始任务文本 |
| `provider`、`model` | 同时提供或同时省略；只提供其中一个会报错 |
| `thinking` | 独立可选：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |

配置在**调用时**解析：省略模型对时继承 `ctx.model.provider/id`；省略 thinking 时独立继承 `ctx.thinkingLevel`。需要继承但父配置缺失时返回错误。创建后不随父模型或 thinking 变化同步；实际可用模型与 thinking 能力约束由 Pi 决定。

名字和消息必须为非空、非纯空白字符串；保留原文，不 trim、编码或归一化大小写。重名立即报错，即使原子代理已完成工作也不会覆盖或复用。启动中的名字同样被预留；启动或初始提交失败会停止本次子进程并释放名字。

### send：继续交互

```ts
subagent({ action: "send", name: "reviewer", message: "继续检查 shutdown 竞态" });
subagent({ action: "send", name: "reviewer", message: "完成当前工作后复核 README", mode: "followUp" });
```

| 参数 | 说明 |
| --- | --- |
| `action` | 必需，`"send"` |
| `name`、`message` | 必需，目标名字与消息文本 |
| `mode` | 可选，`"steer"`（默认）或 `"followUp"` |

空闲子代理会启动新一轮运行；运行中的子代理按 mode 接收 steering 或 follow-up。统一使用官方 `RpcClient.prompt(message, undefined, mode)`，由 Pi 调度。未知名字或仍在启动、尚未确认初始消息的名字返回错误。

### 返回值与错误

成功时工具文本为 JSON，`details` 也包含同一结果：

```json
{"name":"reviewer","disposition":"started"}
```

`disposition` 原样使用 SDK 的 `started`、`queued`、`handled`。扩展只等待 RPC 接收确认，不等待结果；`handled` 可能由输入处理器或扩展命令消费，**不保证有后续回报**。

参数、重名、未知名字以及 RPC 提交错误作为 Pi 工具错误返回。压缩期间拒绝 prompt 时直接报错：扩展不暂存、不等待压缩完成、不自动重试。既有子代理的 send 失败不会删除它。这里不改变 Pi 自身的 provider 重试策略。

## 异步回报

每次 `agent_settled` 读取官方 `getLastAssistantText()`，发送可见 custom message：

```text
Subagent: reviewer

最后一条 assistant 的文本
```

- 固定 `customType: "subagent.report"`，名字和结果都写在 `content` 中。
- 固定 `{ deliverAs: "steer", triggerTurn: true }`：父代理忙时作为 steering，空闲时也会触发父代理响应；不受 send.mode 影响。
- 不以 `agent_end` 为完成边界，不拼接全部历史，不转发 thinking、工具结果或执行流水。
- 无可用 assistant 文本时显示 `(No assistant text available.)`；空字符串仍保留为空字符串。
- 一次 settled 对应一次回报；多次 send 可能合并进同一轮完成，不是一条消息对应一份回执。
- 取文本/投递失败会被捕获并放弃本次回报，不自动重试、不专门通知异常退出。子代理仍保留，可以继续 send。

## 生命周期与限制

- 仅 spawn 按需创建子进程，使用加载中的 Pi SDK 对应的绝对 CLI 入口、调用时父 cwd，以及 `--no-session --thinking <level> --exclude-tools subagent`。
- 每个扩展运行时有独立内存名字集合；子代理回报后不退出，保留对话上下文。
- 子代理实际加载本扩展时，整个 `subagent` 注册名仍被排除，包括其他工具经嵌套调用访问 spawn/send 的路径。**这不是安全沙箱**，不会阻止其他工具自行运行程序。
- 子代理共享父 cwd 和正常操作系统权限，没有 worktree/文件隔离；并行任务可能修改同一文件。真实使用会消耗所选 provider 的模型额度，回报还可能触发父代理模型调用。
- 父 `session_shutdown` 的 `quit`、`reload`、`new`、`resume`、`fork` 均关闭当前集合：先拒绝新请求和迟到回报，再并行取消监听、停止空闲/运行中/启动中的子进程、清空记录。清理幂等。
- 停止依赖 Pi 1.5.0 官方 SDK 的 SIGTERM → 最多等待约 1 秒 → SIGKILL 兜底；不等待未完成的 getState/prompt。无进程树清理保证；操作系统拒绝终止时不能保证进程消失。
- 新运行时从空集合开始，名字可重用。不持久化、不恢复、不重连、不自动重启，也没有额外 list/status/wait/stop 工具或 TUI。

## 开发与验证

在 checkout 中安装开发依赖后执行：

```sh
npm ci
npm run typecheck
npm test
npm run test:integration
npm run test:rpc-probe
git diff --check
```

`npm test` 已包含真实 CLI 离线集成；`test:integration` 可单独运行它。默认测试**不调用真实模型、不消费 API 配额、不操作现有用户会话或配置**。

| 测试层 | 已验证范围 |
| --- | --- |
| 配置/SDK 替身 | 参数矩阵、精确 prompt 参数/接收状态、并发名字预留、失败回滚、异步错误捕获、迟到回报保护、各 shutdown reason 及精确启动/关闭竞态 |
| SDK 工具/加载器 | 生产入口加载、schema/错误转换、工具注册/模型声明/嵌套可执行性；direct/codemode/deferred 的工具排除边界 |
| 官方 SDK + 受控进程 | 正常退出、忽略 SIGTERM 后强杀、已退出子进程的有界清理与 PID 消失 |
| 真实父子 CLI + 本地固定响应 provider | 生产工具→管理器→生产 RPC 适配器→子工作→settled→真实父 custom message；保留上下文再 send；实际 steer 先于 followUp 消费；异名并行/重名拒绝；模型对与 thinking 继承/覆盖；实际压缩拒绝；空闲唤醒和忙时 steering；默认发现下实际加载生产扩展仍无法嵌套 spawn/send；运行时替换及启动中关闭，无受控进程遗留 |
| `test:rpc-probe` | 单独的无 prompt CLI 启动/getState/空文本/停止探针；该探针关闭扩展等发现，**不能**用来证明工具排除 |

集成夹具放在临时 HOME、cwd、agent/config/cache/session 目录，清除继承认证环境；生产入口和固定响应 provider 经默认全局扩展发现加载，不使用 `--no-extensions` 证明排除。文件 gate 只控制本地响应时机，测试后停止并检查已记录 PID、清理临时目录。未执行真实服务商网络调度、实际 QuickJS 脚本、真实用户 TUI 操作，也未验证其他平台/版本组合；对应行为不要理解为已通过端到端验证。

产品约定见 [`docs/spec.md`](docs/spec.md)；最终验收与逐项落实记录见 [`docs/tasks/handoffs/06.md`](docs/tasks/handoffs/06.md)。
