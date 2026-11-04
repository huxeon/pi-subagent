# pi-subagent

基于 **独立 tmux session + 完整 Pi 子进程** 的协作式子代理扩展。父 Pi 用单一 `subagent` 工具启动、发送输入、列出、查看状态、等待及停止并删除协作者；子代理完成工作后保持空闲，可继续接收输入。

不是沙箱，也不创建 worktree。子代理使用正常的 Pi 扩展、技能、项目指令与信任机制；本扩展只在子角色中不注册自己的 `subagent` 工具和父 UI，防止通过本工具嵌套创建。其他扩展的能力不受限制。

## 环境要求

- **Linux**（可访问当前用户进程的 `/proc`）、Unix socket、tmux、Node.js **>=22.18.0**、npm。
- PATH 中可执行的 **`pi` 与 `tmux`**；当前验证版本：Pi `@earendil-works/pi-coding-agent` **1.5.0**、tmux **3.6**、Node **26.13.0**。未验证其他 Pi 版本或最低 Node 版本。
- 子 Pi 必须能正常发现原 provider/model、认证及 cwd。恢复不会备份凭据、模型定义、扩展或项目目录。默认停止器依赖 Pi 的进程标题 `pi`，重品牌版本/包装器需另行验证。
- 父、子需使用一致且安全的运行时目录环境。环境变量 `PI_SUBAGENT_RUN_DIR` / `PI_SUBAGENT_SESSION_FILE` 由扩展设置，不要手动给父 Pi 设置。

正常使用会调用您配置的模型，可能产生费用，且子 Pi 与用户具有相同文件/进程权限。默认开发测试不调用真实模型。

## 安装与加载

在本仓库中安装开发依赖：

```sh
npm ci --ignore-scripts
npm run typecheck
```

Pi 直接加载 TypeScript，无需构建。临时加载同一个根入口（请替换为自己的绝对路径）：

```sh
pi -e /absolute/path/to/pi-subagent/index.ts
```

持久加载可选择以下一种方式：

```sh
pi install /absolute/path/to/pi-subagent
```

或者在 Pi 的 agent-dir `settings.json` 的 `extensions` 中加入 `/absolute/path/to/pi-subagent/index.ts`。保留同一稳定入口路径；不要同时加载另一份副本或独立桥入口。全局/项目自动发现与显式 `-e` 的同路径加载会去重；不同路径/副本不作此保证。项目资源仍需正常信任决策，本扩展不自动批准。

启动或 `/reload` 后，父 Pi 注册 `subagent` 工具和 `/subagent` 命令。子启动器自动传 `-e` 同一个入口，无需另外安装控制桥。本包目前 `private`，未发布 npm 包。

## 工具使用

工具提供 `spawn/send/list/status/wait/stop` 六个操作。以下 JSON 是 **`subagent` 工具的参数**，不是 shell 命令，也不是 `/subagent` 的参数。可直接请父代理“启动 reviewer 审查代码，等待结果后向它反馈”。

```json
{"operation":"spawn","name":"reviewer","prompt":"审查当前改动，重点检查错误处理。"}
```

```json
{"operation":"send","name":"reviewer","prompt":"也检查取消与超时。"}
```

```json
{"operation":"send","name":"reviewer","prompt":"完成后总结发现。","followUp":true}
```

```json
{"operation":"list"}
```

```json
{"operation":"status","name":"reviewer"}
```

```json
{"operation":"wait","name":"reviewer","timeout":1800}
```

```json
{"operation":"stop","name":"reviewer"}
```

| operation | 必填 | 可选 | 行为 |
| --- | --- | --- | --- |
| `spawn` | `name`, `prompt` | `provider`, `model`, `thinking`, `cwd` | 独立继承**创建时**父配置；相对 cwd 基于当前父 cwd。桥可用并且初始有效会话已落盘后返回，不等待首次回复或任务完成 |
| `send` | `name`, `prompt` | `followUp`，默认 false | idle 时新输入；working 时默认 steer，true 时 follow-up，由 Pi 调度 |
| `list` | 无 | 无 | 列出当前父会话的协作者及概览状态，不附带 assistant 回复；不可用信息不是第三种工作状态 |
| `status` | `name` | 无 | 立即仅返回该协作者的 working/idle，不读取或返回 assistant 回复 |
| `wait` | `name` | `timeout` | 等待 idle，返回状态及当前分支最近 assistant 回复（可能为 null）；已 idle 则立即返回 |
| `stop` | `name` | 无 | 安全停止并永久删除该子代理**整个运行目录及 session.jsonl，不归档、不保留历史** |

- 除 `list` 外，所有操作必须指定 `name`；`list` 仅接受 `operation`，无额外字段。新接口不接受 `wait` 布尔参数，也不保留旧操作别名。
- `timeout` 仅用于 `wait`，单位**秒**，默认 **1800**，范围 `0.001–2147483.647`，精度为整毫秒。其他操作的参数、未知字段会被拒绝。
- 父公开 manager 方法对应 `spawn/send/status/wait/list/stop`。底层 socket wire methods **保持 `identity/message/inspect` 不变**，使父 `/reload` 后仍可连接旧子进程；公开操作拆分不意味着 wire 改名或删除 wire 内部的等待参数。
- thinking：`off/minimal/low/medium/high/xhigh/max`，Pi 可按模型能力合法 clamp；创建结果报告实际值。provider/model/cwd 静默 fallback 不算成功。
- 名称在**同一父会话**内精确唯一（不 trim、不折叠大小写、不作 Unicode 归一化）；不同父会话允许同名。名称不可全空白、含控制字符或超过 **126 UTF-8 字节**。中文、emoji、斜线等经可逆编码存目录，不作为 shell 代码。
- prompt 非空白，保留原文；provider/model/cwd 不接受空白字符串或 NUL。父后来修改配置不影响既有子代理。

### 确认、结果、取消与超时

**send 的 `✓ Delivered` / `{invoked:true}` 仅代表 `pi.sendUserMessage()` 调用已发起，不保证输入已接受、排队、落盘、可靠投递或任务完成。** 不提供消息重投或可靠消息队列。spawn 另行验证初始可恢复历史，不能把桥 ready 当作落盘证据。

`working`/`idle` 是在线工作状态，不是任务成败。等待只在 Pi `agent_settled` 且实际 idle 后结束；结果保留最近回复的 `stopReason`、`errorMessage`，不跳过空的 error/aborted 回复，也不输出 thinking。send 后紧接 status/wait 仍可能遇到 Pi 尚未开始工作的极短 idle 窗口，没有额外任务版本记账。

- **取消或超时 wait 仅结束该次等待**，不停止子代理，不调用其 abort、不清空 steer/follow-up。对应子侧等待被移除，之后 settled 不再回复它；仍可另发 wait。
- 连接丢失、子代理退出、启动/清理失败会报告错误，不能当成任务完成。列表与 widget 的不可用信息不是第三种工作状态。
- 主动取消等待在卡片中中性显示（无 `✗`）；取消/超时在工具执行结果中仍标记 `isError:true`，避免被模型误认为获得了完成结果。
- spawn/stop 取消可能已有副作用：spawn 尝试回滚自有新资源；已开始的 graceful stop 必须先安全结束，stop 取消时尽可能保留历史，但已经开始删除不支持事务回滚。清理不完整会明确报错。

## 人工入口与显示

仅在父 **TUI** 中启用；RPC（即使 hasUI=true）、JSON、print 不创建 widget、选择界面、刷新定时器或终端接管，工具仍可执行。

- 编辑器下方 widget：`subagents: reviewer:working | implementer:idle`；零条目隐藏，多条目紧凑显示部分与 `+N more`。每 **1 秒**本地 socket 查询，单项 **600ms** deadline，上轮未结束不叠加。不可连接显示 `unavailable`，快照不持久化、不代替工具 list/status 的直接查询。
- `/subagent`：打开共享快照的键盘列表。方向键/翻页移动、Enter 确认、Escape 取消（遵循 Pi 键位配置）。状态刷新保留所选名称；不可用/已删除条目不可进入。确认前再次直接检查在线状态。
- 父已在 tmux：`switch-client` 进入子 session；用 tmux 的 session 切换（通常 prefix+s）返回父 session。
- 父不在 tmux：暂停父 TUI 后 attach，使用 tmux detach（通常 Ctrl-B d）返回，随后恢复父 TUI。attach 期间父 JS 事件循环同步暂停。失败时报告错误并恢复终端。
- 六种工具卡片使用英文标题/提示，prompt/回复保持原文。spawn 保留实际 cwd、显示实际 provider/model/thinking，状态为 `Spawning...` / `✓ Spawned`；send 仅显式 true 标注 follow-up，状态为 `Delivering...` / `✓ Delivered`；list 调用中显示 `Listing subagents...`，完成后展示概览列表；status 调用中显示 `Checking status...`，完成后仅展示指定协作者的状态，working/idle 不加成功标记；wait 标题为 `subagent wait reviewer (timeout 1800s)`，不重复标注 wait，等待回复用 Markdown；stop 使用 `Stopping...` / `✓ Stopped · session data deleted`，明示永久删除。默认紧凑，可按 Pi 的工具展开键（通常 Ctrl+O）查看完整内容。错误/超时 `✗`，主动取消等待无叉号。

## 暂停、恢复与数据

- 父 **`/reload` 不停止既有子 Pi**：清父连接/等待/UI，新 runtime 重新连接，保留子当前工作现场。
- 父**正常退出、切换会话（new/resume/fork）**：停止旧父会话的子进程，保留历史。重新加载原父会话时扫描关系目录，活着的重新连接，否则只加载原 session、**空闲等待新消息，不自动重放旧任务**。
- 暂停不是执行现场快照：运行中的工具、未写入历史的内存队列与旧 wait 请求不保证恢复。强杀父进程/系统崩溃不保证退出清理；恢复先检查旧进程，避免重复启动。
- 停止向可确认归属的 Pi 发 SIGTERM，等退出及异步清理，才清 tmux/socket。默认等 10 秒；不自动 SIGKILL，无法安全确认/停止时保留资源并报错，不声称清理完成。
- **stop 是永久删除，不是暂停**，也不能通过恢复父会话找回。此前已写入父会话的工具结果仍是父的历史，并不会随 stop 删除；它不是子代理的可恢复记录。

持久化位置（agent-dir 采用 Pi 的配置，默认 `~/.pi/agent`）：

```text
<agent-dir>/subagents/p-<父 Pi session ID 的 UTF-8 hex>/n-<名称的 UTF-8 hex>/session.jsonl
```

只有原生 Pi 会话文件，无 metadata、inbox、状态、PID 或配置副本。目录存在表达关系。socket 使用安全有效 `XDG_RUNTIME_DIR/pi-subagent/`，否则 `/tmp/pi-subagent-<uid>/`，私有目录 0700，文件名为规范化绝对 runDir 的 SHA-256 前 32 个 hex。路径过长、不安全目录、活动端点冲突均报错；不据 socket 文件存在判在线。共享 runtime/父目录不会由 stop 删除，只清该端点和运行目录。

## 开发与测试

```sh
npm run typecheck
npm test                  # 全部默认单元/集成测试；不调用真实模型
npm run test:integration   # 受控假 Pi 子进程 + 生产子入口/socket/工具/管理器
```

默认测试仅操作 mkdtemp 自有数据。tmux 测试使用 `tmux -S <临时socket> -f /dev/null` 私有 server，不关闭用户已有 session。无 tmux 或非 Linux 时对应受控 tmux 测试会跳过，需检查测试汇总，不可将跳过当通过。

可选真实 Pi **离线**探针（不向模型发 prompt，不 attach 用户终端）：

```sh
export PI_PACKAGE_DIR=/absolute/path/to/node_modules/@earendil-works/pi-coding-agent
npm run test:pi-api         # 宿主原生 API/落盘/事件兼容性；含内存合成 SDK stream
npm run test:pi-production  # 生产桥+manager+进程驱动与真实 CLI：恢复、发现、reload、stop 删除
```

这两项均使用隔离 HOME/agent-dir、假认证、offline、自有 tmux server；不是付费模型或人工屏幕验收。`test:pi-production` 需要支持原生 TS 的上述 Node 版本。升级 Pi 后应重跑类型检查、全部测试及两项探针。

## 当前验证范围与限制

- 六操作的 schema、参数校验、公开 manager 方法、卡片、取消/超时，以及跨模块 spawn→working→send→status/wait→idle→stop、断线/异常退出、失败清理、早期恢复和同名隔离已由**受控测试**覆盖；当前默认测试 **82/82 通过，无跳过**，类型检查通过。
- 两项真实 Pi **离线**探针已在本次接口迁移后重跑通过，包括生产桥配置/资源发现、父 manager reload 后同 PID 重连、子 reload、历史恢复及 stop 永久删除。底层 wire 未改变，受控测试同时验证新 manager 沿用 `message/inspect`；这些结果不等同于真实父 Pi 生命周期、真实模型调度或人工 TUI 验收。
- **尚未完整验收**：真实模型下完整父子 spawn/send/follow-up/wait 链路；真实父 Pi `/reload`/会话切换对全部子代理的端到端流程；真实模型重试/自动压缩、长期工具停止、用户认证/扩展/技能/trust 的实际组合。
- **人工 TUI 待验证**：真实父 Pi `/subagent` attach/detach 后编辑器恢复、tmux 内切回、主题/resize/regular/fullscreen/HTML export。已有组件快照/终端桩与受控 PTY 记录不能替代人工屏幕结论。需要用户终端接管或付费调用的补验须先获同意。
- 单 socket 帧上限 **1 MiB**，超大回复明确失败；模型可见工具输出上限 **50 KiB / 2000 行**，截断有提示，完整已返回回复保存在父工具结果 details，非独立副本文件。
- 仅验证当前 Linux/Pi 1.5.0；无跨 OS、断电事务/fsync、恶意同 UID 路径/进程替换防护保证。会话校验针对本扩展创建的当前原生格式，不自动修复损坏 JSONL、迁移旧格式或接受恢复模型 fallback。

产品依据：[docs/spec.md](docs/spec.md)；API 证据：[implementation-notes](docs/implementation-notes.md)；逐项验收及剩余问题：[任务 08 交接](docs/tasks/handoffs/08.md)。
