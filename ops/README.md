# AgentMemory 运维入口

`ops/` 与 AgentMemory 源码使用同一个 Git 提交管理，包含正式部署、运行诊断、
全量提炼编排和 Windows 生命周期脚本。使用方仓库不应保存这些脚本的副本。

## 路径契约

- 源码仓库由脚本所在位置推导，不依赖外部仓库路径。
- 正式 runtime（运行环境）默认是 `F:\ai-runtime\agentmemory`。
- 需要迁移 runtime 时，传入 `-RuntimeRoot`，或设置
  `AGENTMEMORY_RUNTIME_ROOT`；已部署脚本也会从 `app\current` 反推 runtime。
- `home`、日志、锁和提炼状态不进入 Git，也不随发布目录替换。

## 主要入口

```powershell
pwsh -File .\ops\scripts\deploy-agentmemory-current.ps1 -RuntimeRoot F:\ai-runtime\agentmemory
npm run test:ops
```

正式发布从一个 AgentMemory `sourceCommit`（源提交）构建，生成的
`DEPLOYMENT.json` 不再依赖使用方仓库提交。
