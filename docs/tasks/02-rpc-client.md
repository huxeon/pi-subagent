# 02：RPC 客户端适配

## 目标

对官方 `RpcClient` 做最小包装，落实子进程启动和调用规则，给管理器提供可替换的依赖。

## 前置与阅读

- 任务 01 已完成，工具注册与排除匹配问题已解决。
- 阅读规格、任务索引、`docs/tasks/handoffs/01.md` 和已有类型、测试。
- 阅读 Pi 的 RPC 文档、`examples/rpc-client.ts` 及 RpcClient 的实际类型和实现。

## 实现范围

建议新增 `src/rpc-client.ts`，以任务 01 的接口为准。

1. 稳定解析当前使用的 Pi CLI 绝对路径；不能依赖 cwd 下的 `dist/cli.js`，也不能误用父进程启动脚本。
2. 创建官方 RpcClient，设置 cwd、provider、model 及启动参数。
3. 参数包含 `--no-session`、`--thinking <level>`、规格要求的工具排除项；其他资源按默认规则加载。
4. 暴露启动、prompt、事件订阅、最后 assistant 文本获取及停止等最小操作。
5. 初始消息通过 `prompt(message)`；后续消息通过 `prompt(message, undefined, mode)`，不使用 steer/followUp 或 promptAndWait 代替。
6. 保持 SDK 接收状态和提交错误，不做压缩等待、排队补偿或重试。
7. 核对启动确认与停止行为：如使用 getState 确认可用性，纳入失败路径；停止需有界，并能处理已退出客户端。

名字预留、子代理集合、父消息投递和 session_shutdown 不属于本任务。

## 必须测试

通过可注入的 RpcClient 创建边界或最小 SDK 替身验证：

- CLI 为可用的绝对路径，与子代理 cwd 无关。
- 创建选项及 args 完整，未意外添加关闭默认扩展等选项。
- 每个调用准确委托给对应 SDK 方法，prompt 参数与返回状态保持一致。
- 压缩错误和其他 RPC 拒绝原样失败，不重试。
- 事件可订阅和取消订阅；取结果保留 null。
- 启动确认失败、stop 成功及已退出场景。

可补充一个不发 prompt 的真实 CLI 离线探针，验证启动、getState 和停止；必须隔离配置、不调用模型，并明确它不是生产默认资源加载的完整验证。

## 验收与交接

- 类型检查和全部默认测试通过。
- 生产实现仍使用官方 RpcClient，没有自制 RPC 协议。
- 写入 `docs/tasks/handoffs/02.md`，记录适配接口、CLI 定位方式、停止边界及后续可复用的 fake client。
