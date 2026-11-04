# Pi API、落盘与恢复验证记录（任务 01）

> 接口命名更新：当前工具使用 `spawn/send/list/status/wait/stop`。本文及任务交接中的 `create/message/inspect/destroy` 是历史名称：分别对应 `spawn/send`、拆分后的 `list/status/wait` 与 `stop`；`stop` 仍永久删除整个子代理运行目录和会话。底层 socket 的 `identity/message/inspect` 方法保持不变，以便父扩展重载后仍能连接旧子桥。当前接口以 [设计规格](spec.md) 和 [README](../README.md) 为准；下文保留原始验证记录，不代表本次更名已重新完成全部验收。

## 结论与用户确认

验证对象：**`@earendil-works/pi-coding-agent@1.5.0`**，不是旧包名 `@mariozechner/pi-coding-agent`。当前 Pi 会映射旧导入名，但新代码应使用新包名；schema 使用 `typebox`。Node v26.13.0，Linux，tmux 3.6。结论针对该安装版本，升级需重跑探针。

**单 session 文件恢复本身成立**：第一次 user 消息即写出 header/cwd、初始 model/provider、thinking 和 user 消息；不必等待第一次 assistant 回复。CLI 恢复只传 `--session`，能从其他启动目录回到会话 cwd，并保留 model/thinking，不自动执行中断的 prompt。

**原投递确认语义冲突已解除：用户明确确认“接受‘调用已发起’的确认语义，不要求可靠投递”。** 已同步至 spec 4.1、4.2、10.3。

- 扩展 `pi.sendUserMessage()` 是 **fire-and-forget，返回 `void`**。实际异步错误经 `runner.emitError({event:'send_user_message', ...})` 上报，调用端 `try/catch` 收不到；`await pi.sendUserMessage(...)` 也不会等待接受或落盘。
- 文档示例中“流式时未指定 deliverAs 会 throw”的表述不能理解为扩展调用处的同步异常。源码比示例准确。探针用非法内容触发异步拒绝，实测调用返回 undefined 且不抛同步异常；合法消息的输入 hook、认证等异步失败具有相同的包装路径。
- 控制桥调用后即可作本次输入的确认；`✓ Delivered` 保留，但只表示调用已发起，不保证消息已接受、排队、落盘或执行。不增加逐消息接受确认、重投、投递状态/队列，不改用内部 AgentSession 绕过公共 API。
- spec 12.1 的 **create 成功时可恢复** 要求未取消：桥 `session_start` 就绪时可能根本没有 session 文件；初始消息只有实际进入 Pi 并写出后才满足要求。创建阶段仍需独立检查有效会话已落盘（留任务 05 实现），这不是逐消息的可靠投递协议。不能伪造 assistant、预写空文件或增加 metadata 来绕过。

仅按用户确认更新规格和交接，没有实现完整扩展、控制桥业务协议或后续任务模块。

## 1. 依据和复现

本机安装根目录（下文 `$P`）：

```text
/home/huxeon/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent
```

使用已发布安装内的 `dist` JS 和 `.d.ts` 作为源码依据；CLI 探针运行 `package.json` bin 指定的 `dist/bundle/cli.js`，SDK 探针导入 `dist/index.js`。没有修改宿主安装。

已完整阅读相关 Markdown：`docs/extensions.md`、`session-format.md`、`sessions.md`、`sdk.md`、`cli.md`、`cli-integration.md`，以及恢复/资源/消息相关交叉引用 `configuration.md`、`message-types.md`。参考例子：`examples/sdk/06-extensions.ts`、`11-sessions.ts`、`examples/extensions/send-user-message.ts`、`shutdown-command.ts`。阅读项目 `references/pi-subagent/shared.ts` 的 `launchRun` 与 `index.ts` 的角色和生命周期部分；参考代码不是当前规格的持久化方案。

复现命令（不需 npm install，不请求真实模型）：

```bash
PI_PACKAGE_DIR=/absolute/path/to/@earendil-works/pi-coding-agent node tests/verify-pi.mjs
node --check tests/verify-pi.mjs
```

本机第一条用上述 `$P` 执行通过；最终 bundled CLI 版本全部 7 组 PASS，语法检查通过。另在 unbundled CLI 上执行通过一次，但最终测试固定使用发布的 bundled CLI。

探针：临时 agentDir/HOME/cwd、假认证、本地合成 SDK stream、`--offline`、独立 `tmux -S <临时路径>` server。没有向真实模型发请求。正常资源发现验证使用临时的普通扩展与桥样例，不加载用户真实配置。SDK 的纯循环测试禁用扩展，仅为隔离测试，并非产品的资源筛选策略。所有探针数据在 `finally` 清理；正常路径已等待两次 Pi 进程结束，未保留测试 tmux、socket 或用户目录数据。

## 2. 已确认的 API

| 用途 | 1.5.0 API / 规则 | 证据/验证级别 |
| --- | --- | --- |
| 注册工具 | `pi.registerTool({name,label,description,parameters,execute,...})` | `dist/core/extensions/types.d.ts:533`、extensions 文档；工具完整执行/取消测试留任务 06 |
| 执行与取消 | `execute(toolCallId, params, signal, onUpdate, ctx)`，signal 是 `AbortSignal \| undefined`；应同时检查已 abort 与监听后续 abort | 同上；inspect 取消只清理该请求，绝不调用子 Pi abort |
| 返回 | `content` 和 `details`，错误 throw 或 `isError:true` | 文档/类型；取消不是任务失败 |
| session_start | reason：`startup \| reload \| new \| resume \| fork`；替换会话时带 previousSessionFile | `types.d.ts:595`；startup/reload 实测，其余源码/文档确认 |
| session_shutdown | reason：`quit \| reload \| new \| resume \| fork`；可带 targetSessionFile | `types.d.ts:657`；quit/reload 实测，其余源码/文档确认 |
| 空闲 | 扩展 `ctx.isIdle()`；SDK `session.isIdle` getter（不是函数） | `agent-session.js:1085,2834`；SDK 合成循环实测 |
| 生命周期 | `agent_start`、`agent_end`、`agent_settled`；settled 带 aborted；只有 settled 是自动处理结束边界 | `agent-session.js:702`、extensions 文档；合成 follow-up 循环实测 |
| 提交输入 | `pi.sendUserMessage(content, {deliverAs?:'steer'\|'followUp',expandPromptTemplates?:boolean}) : void` | `types.d.ts:1290`、`agent-session.js:2792`；用户确认的发起语义见开头 |
| 当前设置 | `ctx.model?.provider`、`ctx.model?.id`、`ctx.thinkingLevel` 或 `pi.getThinkingLevel()`、`ctx.cwd` | 文档/类型；CLI startup 快照实测 |
| 当前分支 | `ctx.sessionManager.getBranch()`，从根到当前 leaf 的原始 entries | 分支探针；不能用 getEntries 最后一个 assistant 代替 |
| 全部历史 | `getEntries()` 包括已放弃分支 | 分支探针证实区别 |
| 投影 | `buildContextEntries()` 含 compaction 选择；`buildSessionProjection()` 含 context_edit 投影 | session-format 文档；此任务未做 compaction/context_edit 专项测试 |
| 停止 | `ctx.shutdown()` 请求正常退出，但 TUI 会延迟到 idle；`ctx.abort()` 不是退出 | extensions 文档、interactive-mode 源码；停止结论见后文 |

### 工作状态和最新回复的调用方式

- `agent_start` 标 working；`agent_settled` 时再次检查 `ctx.isIdle()`，为真才标 idle/完成 wait。不要把一次 `agent_end` 当完成。
- SDK 探针中 follow-up 产生两个合成回复，`agent_end` 时仍不 idle，最终只有一次 `agent_settled` 且 idle。重试/自动压缩的组合只做源码核对，未声称全部运行验证。
- 桥可在每个请求读取 `ctx.isIdle()`，不持久化工作状态。spec 已容许 message 后紧接 inspect 的极短窗口，不引入额外任务版本。
- 扩展没有 `ctx.getLastAssistantText()`。用 `ctx.sessionManager.getBranch()` 逆序找 `type==='message' && message.role==='assistant'`，取 text blocks，保留 `stopReason`、`errorMessage` 等信息；没有回复也必须能返回 idle，不能自动找旧分支回复。
- SDK 有 `session.getLastAssistantText()`（`agent-session.js:3609`），它扫描当前上下文 `session.messages`，跳过完全无内容的 aborted，并只返回 text，可能掩盖最近的错误/中止；不等价于桥 inspect 所需的“最近 assistant + 结果信息”。不照搬其忽略 aborted 的策略。
- 回复和 prompt 不翻译；不把 idle 当成功；文本提取不暴露 thinking blocks。截断阈值工具侧可用导出的 `truncateHead` 等（内置惯例 50KiB/2000 行），具体协议和展示限制留任务 03/06，未在本任务自行定协议。

## 3. 初始落盘和恢复

源码主要依据：

- `dist/core/session-manager.js:668–711`：显式路径不存在时保持该路径；newSession 先在内存建立 header。
- `:787–813`：`_hasConversation` 为 user **或** assistant；没有 conversation 不写；首次写以 `wx` 创建并写出所有内存 entries，之后同步 append。
- `:851–875`：thinking/model 是 Pi 原生 tree entries。
- `:1338`：`SessionManager.open(path, sessionDir?, cwdOverride?)` 默认从 header 读取 cwd；不要在恢复时传 cwdOverride。
- `dist/core/sdk.js:83–143,291–302`：初始 model/thinking 原生记录、恢复、默认值、clamp；恢复 model 需要 catalog 有该模型且有已配置认证。
- `dist/main.js:309,589,709`：CLI 选会话后在 session cwd 创建运行时服务；cwd 是会话的一部分。

| 阶段 | 文件行为 |
| --- | --- |
| 指定不存在的 session.jsonl 启动 | header/cwd、初始 model/provider、thinking 在内存；文件不存在 |
| 仅 setup entries/桥 ready | 仍不写文件 |
| 首条 user 真正进入 agent | 立即写出 header + 初始配置 + user；尚无 assistant 也可恢复 |
| 首条回复流式过程中 | 未完成 assistant 不保证入 JSONL；已有 user/config 仍可恢复 |
| 普通后续 entries | 同步追加；不是正常退出时才统一 flush |
| 未聊天就正常 SIGTERM/SIGHUP 退出 | 不补写 setup-only 会话，文件仍不存在 |

**不要预创建空 session 文件**：`_setSessionFile` 对已有零字节文件有特殊初始化/立即 rewrite 路径，可能使“文件存在”失去证明有效配置的意义。探针只测试自然的不存在路径启动。已有非空非法文件会报错，不可当作全新会话覆盖。

### 启动命令

首次（命令参数必须用 argv 传递，不拼接未转义 shell）：

```text
tmux new-session -d -s <派生名称> -x 120 -y 40 -c <解析后的cwd> --
  env PI_SUBAGENT_RUN_DIR=<绝对运行目录>
  pi --session <绝对路径/session.jsonl>
     --provider <解析后的provider> --model <解析后的model-id>
     --thinking <解析后的thinking> -e <同一个扩展入口的绝对路径>
```

规格初始 prompt 经桥提交，不作为恢复命令位置参数。正常产品启动不添加 `--offline`、`--no-extensions`、`--no-skills`、`--no-mcp`、工具筛选等；探针里的隔离参数仅用于不访问用户配置/网络。

恢复：

```text
env PI_SUBAGENT_RUN_DIR=<同一个绝对运行目录>
  pi --session <同一个绝对路径/session.jsonl> -e <同一个扩展入口的绝对路径>
```

- **不重传** provider/model/thinking，不从当前父代理/旧 metadata 重新继承，不传旧 prompt、不 `--continue`、不 `--fork`。显式 CLI/SDK 选择是覆盖项，会破坏恢复。
- CLI 从 session header 的 cwd 恢复工具、资源发现和项目上下文；tmux 的初始 cwd 不能作为覆盖会话的手段。
- 探针设置默认 `openai/gpt-4o:off`，session 保存 `openai/gpt-5:high`，从不同 cwd 启动，实测得到保存值，idle，不自动执行旧 user。
- **恢复所需前提**：原 cwd 仍存在，原 provider/model 可被正常发现且认证仍可用。1.5.0 找不到/无认证时可能选择 fallback model 并给出 warning；单 session 不包含模型定义、凭据和原来的全部扩展实现。规格中的恢复不能被理解为自动备份这些外部配置。后续父侧应核对握手的有效配置并报告缺失，不静默把 fallback 当原配置恢复成功；此异常策略尚未实现。
- cwd 消失时 TUI 可能询问临时替代目录，非交互模式报错；不能在无人值守子代理中偷偷接受替代 cwd（sessions 文档，未做交互专项探针）。

## 4. 资源发现、显式加载与角色

`DefaultResourceLoader.reload`（`dist/core/resource-loader.js:384–428,801–815`）将 CLI -e 与正常发现合并、按资源路径键去重。使用 **同一个 package entry**：子启动仍 `-e <本扩展的入口绝对路径>`，入口按 `PI_SUBAGENT_RUN_DIR` 判角色。不要另外显式加载一个也会开启桥的独立桥模块，否则不是相同资源，不能靠 Pi 自动避免双 listen。

实测临时 agent/extensions 下的桥既自动发现又显式 -e：每个 runtime 只执行一次 factory；另一普通扩展照常加载；子角色工具列表没有 `subagent`；reload 正常关闭旧 socket 后重开。不同副本、不同入口或异常 symlink 布局不保证同一注册；不使用进程级永久 sentinel 来跳过 reload 的新 runtime。

入口应在 factory 只注册事件/工具；socket 在 `session_start` 建立，在 `session_shutdown` 幂等关闭。子角色不注册本扩展的父工具/命令/widget，其他扩展和技能不筛选。探针角色判断是最小样例，不是产品完整实现。

正常项目资源仍遵守 Pi project trust；不能为子代理自动加 `--approve` 绕过用户信任决策。此任务没有在用户真实项目上操纵 trust 或弹出确认。

## 5. 正常停止与父会话生命周期

源码：`dist/modes/interactive/interactive-mode.js:3550–3579,3646–3660`：TUI 安装 SIGTERM/SIGHUP handler；信号退出先 await runtime dispose/扩展 shutdown，再处理 terminal 并退出。`dist/core/agent-session-runtime.js:296–303`：dispose 发 `session_shutdown(reason:'quit')` 后 dispose session；不要在 shutdown handler 中等 agent_settled 当作退出必要条件。

实测在独立 tmux 中给 **Pi PID** 发 SIGTERM、另一次发 SIGHUP：异步 shutdown handler（含 100ms delay、await server.close）完成，Unix socket 删除，Pi PID 消失；已有 JSONL 保留；未聊天会话没有凭退出获得落盘。这里的 bridge 是临时探针监听，不是生产控制桥。

后续停止建议：

1. 定位本子代理对应的 tmux pane/进程（由确定性 session 名及 live socket 身份核对；不持久化 PID）。不能假设 pane_pid 永远是 Pi，启动方式应确保可定位真正的 Pi。
2. 向已确认的 Pi 发 SIGTERM；等待 Pi 退出和桥连接关闭/清理，保留超时/错误报告。不能只等待 tmux has-session 变 false 就认为异步 hook 已完成。
3. Pi 退出后再清理该子代理的剩余 tmux session。强制终止只能作为超时降级，不能描述成完整正常清理；协议/停止 helper 留后续任务。
4. `ctx.shutdown()` 在 working 时会等待自动工作结束，不适合“父退出即暂停子”的唯一机制；不新增 stop RPC 操作作为未经确认的协议扩展。具体进程定位和停止策略仍需后续任务实现测试。

**未把 kill-session 当成可靠的 graceful stop。** 关闭 PTY 可能触发 HUP，但 dead terminal/EIO 等紧急路径可能跳过正常清理；本任务没对用户 tmux 做破坏测试，也没有验证真实运行工具被中断时的全部落盘结果。

父 shutdown reason 为 reload 时仅清理父连接/等待/UI，**不停止子 Pi**；quit/new/resume/fork 时清理旧父会话子代理并保留会话目录。reason 的完整 union 已确认，new/resume/fork 的实际父子清理行为尚未实现。

## 6. 自动测试覆盖与未验证范围

`tests/verify-pi.mjs` 覆盖：

1. 原生 SessionManager setup 不落盘，user 写出，无 assistant 的单文件设置恢复。
2. 真实 SDK prompt + 内存合成 stream：首条回复前文件已存在；follow-up 自动处理完才 settled/idle；最新回复与当前分支/全历史差异。
3. 发布版 bundled CLI/tmux 从不同 cwd 恢复 saved 配置（默认值故意不同），空闲不重放旧任务。
4. 正常扩展发现与显式桥 entry 共存、单次注册、子角色不注册 subagent。
5. 扩展 void send 的调用返回行为，不用错误输入触发模型。
6. `/reload` shutdown/start reason 和旧 socket 清理；SIGTERM/SIGHUP 等待异步 hook，进程退出。
7. 首次 CLI 显式配置；无 user 时即使正常退出也没有可恢复文件。

未验证，不应记作已验收：真实付费模型、真实 provider 重试/自动压缩组合、真实长期工具的停止、工具取消/inspect 取消协议、用户真实的扩展/技能/package/trust 组合、父子多进程完整恢复和异常 socket/旧进程去重、tmux 人工 attach/switch-client、窗口极端条件、崩溃/断电持久性、名称和地址规则的实现。JSONL 同步 write 不等于 fsync/事务，未保证断电完整性。协议分帧/错误结构/输出上限是后续任务，不在此处提前确定。

参考实现的 metadata.json、inbox、suspended、persisted state 和重新传启动配置均不迁移。名称编码/目录规范化/tmux 名称派生遵循 spec 约束，具体规则见任务 02/05 交接；socket 哈希遵循 spec 7，不另造业务 ID。

## 7. 任务 05 补充：运行中进程定位

实际 1.5.0 `dist/cli/setup.js` 及 bundled `cli-runtime.js` 设置 `process.title = APP_NAME`（当前为 `pi`），会覆盖 Linux `/proc/<pid>/cmdline` 中的原 argv。因此 `--session <path>` 只能识别尚未修改标题的启动阶段，不能作为运行中 Pi 的唯一定位条件。

任务 05 使用初始环境中的原样 `PI_SUBAGENT_RUN_DIR` + `PI_SUBAGENT_SESSION_FILE`，结合当前 UID、Pi 标题/启动 argv、tmux session 环境归属以及内存中的 `/proc/stat` starttime 复核。两个路径变量通过 tmux new-session 环境传入，不持久化 PID 或额外记录。候选身份不可读取时 fail closed；无关同 UID 进程先按公开 cmdline 过滤，避免无关服务拒绝 environ 读取阻塞全部管理。

受控 tmux 进程测试已模拟 `process.title='pi'`，验证重新发现、SIGTERM 后等待异步清理和退出、再清 tmux/socket，以及仅 session 文件恢复不重放。**新生产 driver 与真实 Pi 的完整集成仍未验证**；不把该受控测试当成真实模型/工具停止的验收。当前实现限定 Linux 和 `pi` 标题；其他 OS/重品牌需另行验证。完整 API、失败清理与测试结果见 [任务 05 交接](tasks/handoffs/05.md)。

## 8. 任务 08：生产集成离线验证与退出竞态

新增 `tests/verify-production-pi.mjs`，通过 `PI_PACKAGE_DIR=... npm run test:pi-production` 显式执行。真实 Pi 1.5.0 bundled CLI 加载本项目生产入口，使用生产 ParentManager/TmuxProcessDriver/socket，隔离 HOME/agent-dir/XDG、假认证、offline 和私有 tmux server；从原生 SessionManager 预置的早期 user 历史恢复，**不发 prompt、不请求模型、不 attach 用户终端**。

实测通过：保存的 cwd/openai/gpt-5/high 优先于不同默认配置、idle/null 且不重放；生产子角色无 subagent 工具/人工命令；同入口正常发现 + 显式 -e 不重复 bind、普通扩展和 skill 正常发现；父 manager reload 后同 PID 重连且重复 recover 不重复启动；真实子 `/reload` 后桥重开；SIGTERM 安全停止并保留原 session 字节、恢复空闲、destroy 删除记录与 socket、无活子进程残留。修复后连续三次全部通过。

真实探针发现 `/proc/<test-Pi-PID>/environ` 在退出竞态中返回 EACCES。原驱动并行读 environ/stat，可能在识别 zombie 前抛权限错误。本次修复为先排除已知 zombie；权限错误后复核，仅确认 zombie 或已消失才忽略，身份不透明的活进程仍 fail closed。`tests/process-identity.test.ts` 确定性覆盖三种情况，不放宽归属或自动强杀。

另新增受控多进程 `tests/integration.test.ts` + `fixtures/fake-pi.ts`：生产工具/manager/子入口/socket、原生 JSONL，模拟 Pi 工作事件/回复，覆盖 create→message→等待→settled→destroy、取消/超时不产生迟到结果、断线/异常退出/失败、早停恢复/同名隔离。**模拟不能视为真实模型调度通过**。任务 08 最终全套 75/75 与 typecheck 通过，原 `test:pi-api` 探针重跑通过。

仍未完成真实模型全链路、真实父 Pi 的完整 reload/切换会话接线及人工 TUI 屏幕验收；此前关于这些场景“未验证”的结论仍成立。逐项级别/剩余范围见 [任务 08 交接](tasks/handoffs/08.md)，不要将 manager 调用加真实子 Pi 的验证表述为完整父 Pi/模型/TUI 验收。

## 9. 六操作接口迁移

用户确认保留现有架构，公开工具与 manager 改为 `spawn/send/list/status/wait/stop`；`stop` 仅更名，仍安全停止并永久删除整个运行目录与 session。`list` 不接受额外参数，其他操作的 name 必填；移除工具 `wait` 布尔字段，timeout 仅用于独立的 `wait` 操作。send/等待/取消/生命周期语义不变，不保留旧操作别名。

底层 socket 的 `identity/message/inspect` 以及协议帧保持不变：`send` 使用 `message`，`status` 与 `wait` 分别使用 `inspect` 的非等待/等待请求，以兼容父扩展 reload 后仍运行的旧子桥。迁移同步更新 schema、校验、工具说明、卡片、父 UI 调用与测试。

本次运行 `npm run typecheck`、默认测试（82/82，通过且无跳过）和两项指定 Pi 1.5.0 的离线探针（`test:pi-api`、`test:pi-production`）全部通过。探针隔离用户配置，未调用真实模型或接管用户终端；真实父 Pi 生命周期端到端、付费模型及人工 TUI 的未验收范围不变。
