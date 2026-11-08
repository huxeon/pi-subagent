# 01：接口核对与测试基础

## 目标

让后续会话能基于已验证的 Pi API 和可运行的测试设施实现，不先堆业务逻辑。

## 先读

- `AGENTS.md`、`docs/spec.md`、`docs/tasks/README.md`。
- 当前 `package.json`、`tsconfig.json`、根入口及 `src/index.ts`。
- Pi 的 `docs/extensions.md`、`docs/rpc.md`、`docs/rpc-commands.md`、`docs/sdk.md`，以及相关交叉引用。
- Pi 的 `examples/rpc-client.ts`、工具注册示例和导出的类型。

## 实现范围

1. 核对宿主及项目依赖的 Pi 版本、Node 要求和类型导出，不引入未经验证的最低版本承诺。
2. 验证 `subagent` 工具与 `--exclude-tools subagent` 的匹配和调用行为。
   - `spawn`、`send` 是通过 `action` 选择的两个子命令。
   - 验证不只看模型工具声明，还要检查排除后是否仍可通过其他工具调用到两个子命令。
3. 建立默认测试命令，建议使用 Node 内建测试运行器，确保 TypeScript 测试可执行并纳入类型检查。
4. 定义必要的共享类型：spawn/send 输入、父配置快照、解析后的子配置、接收结果、RPC 适配边界及回报接收边界。
5. 实现纯配置解析与参数校验，建议放在 `src/config.ts`；共享类型可放在 `src/types.ts`。
6. 将核对结论写入本任务交接，不另建长篇研究文档。

只定义业务需要的最小接口，不创建真实子代理管理器或注册生产工具。

## 必须测试

- provider/model 同时提供、同时省略，以及只提供一个时的错误。
- thinking 单独提供、配合指定模型提供、或省略时继承父值。
- 全部显式提供时不依赖父模型是否存在；需要继承但相应父配置缺失时失败。
- 名字和消息的必要校验；不要擅自增加路径编码、大小写归一化等产品规则。
- 工具排除匹配的离线验证；若采用临时探针，使用临时目录和隔离配置并清理。

## 验收与交接

- `npm run typecheck` 和新增的 `npm test` 通过。
- 工具排除行为已验证，证据已记录。
- `docs/spec.md` 明确描述 `subagent` 的两个子命令及其参数，与代码接口一致。
- 写入 `docs/tasks/handoffs/01.md`，明确后续如何创建 RPC 适配器、名字与配置类型，以及测试命令。

## 不做

不实现 spawn/send 管理流程、结果回报、生命周期接线或 UI；不调用真实模型。
