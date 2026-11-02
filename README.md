# pi-subagent

基于 tmux 的 Pi 子代理扩展。

> 当前仅为项目骨架，不包含任何功能实现，也不能运行子代理。

## 目录结构

```text
pi-subagent/
├── src/
│   └── index.ts          # 扩展入口，当前为空
├── tests/                # 测试（预留）
├── docs/                 # 设计文档（预留）
├── .gitignore
├── index.ts              # 转导出 src/index.ts 的 default
├── package.json
├── tsconfig.json
└── README.md
```

空目录使用 `.gitkeep` 保留。

## 开发准备

- Node.js 22 或更高版本及 npm。
- 后续运行扩展需要 Pi CLI 和 tmux；本骨架尚不调用它们。

安装开发依赖并检查类型：

```sh
npm install
npm run typecheck
```

Pi 宿主 API 通过 `peerDependencies` 声明，不打包进扩展。Pi 可以直接加载 TypeScript 扩展，无需单独构建。

## 扩展入口

`package.json` 中的 `pi.extensions` 指向根目录的 `index.ts`，该文件仅转导出 `src/index.ts` 的默认导出。

`src/index.ts` 目前仍为空，尚无默认导出，因此当前入口不能正常加载，类型检查也会报缺少默认导出的错误。后续实现默认扩展工厂函数后，可从项目根目录使用 `pi -e .` 临时加载。当前不注册任何工具、命令或事件，也不启动 tmux 或子代理进程。

项目暂标记为 `private`，尚未配置发布、测试框架或 CI。
