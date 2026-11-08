# 05：工具与扩展接线

## 目标

把已经测试的管理器接入 Pi，使用户加载根入口后可使用规格约定的 spawn/send。

## 前置与阅读

- 任务 01–04 已完成。
- 阅读规格、任务索引、前置交接及现有模块。
- 完整阅读 Pi 扩展文档相关工具、生命周期、参数 schema 和暴露方式章节、交叉引用及对应示例。
- 特别核对任务 01 确定的工具注册名称与排除策略，不重新发明另一套命名。

## 实现范围

建议新增 `src/tools.ts`，更新 `src/index.ts`，保留根 `index.ts` 作为稳定入口。

1. 注册单个 `subagent` 工具，以 `action: "spawn" | "send"` 提供两个子命令；schema 字段与规格一致。
2. spawn 使用 name/message、成组可选 provider/model、独立可选 thinking；send 使用 name/message/mode，mode 默认 steer。
3. 使用工具调用时的 ctx 取得父配置和 cwd，而不是扩展 factory 执行时缓存。
4. 工具执行委托给管理器；成功结果包含名字和 disposition，失败使用 Pi 规范的工具错误形式。
5. 工具说明让模型知道接收确认不是任务完成、完成后会异步回报、子代理可以继续接收消息。
6. 将父投递边界接入 pi.sendMessage，将 session_shutdown 接入管理器 shutdown，适用于所有 reason。
7. 扩展 factory 可创建无副作用的管理对象和注册工具/事件，但不能启动进程、定时器或其他后台资源。
8. 保持每个扩展实例状态隔离，不把管理器放到跨运行时的模块级单例中。

无需自定义卡片、widget、命令、额外操作或消息 renderer。

## 必须测试

用最小 fake ExtensionAPI/工具 ctx 验证实际扩展接线：

- 注册内容与 schema，包括 thinking 单独提供和 provider/model 部分提供时的拒绝。
- 两个工具传入管理器的参数、默认值、父配置与 cwd 正确。
- spawn/send 返回接收确认，不等待 settled。
- 生产接线的 pi.sendMessage 选项准确。
- 每种 session_shutdown reason 均清理当前管理器。
- 新扩展实例不持有旧实例的子代理，旧回调不能投递。
- factory 本身没有子进程启动或后台资源副作用。

## 验收与交接

- 根入口可加载，类型检查和全部默认测试通过。
- 工具注册与 `--exclude-tools subagent` 的既定匹配方式一致。
- 写入 `docs/tasks/handoffs/05.md`，列出实际公开调用示例及端到端验证的入口。
