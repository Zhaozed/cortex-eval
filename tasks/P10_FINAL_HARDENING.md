# P10：Canonical Export 与最终硬化

## 状态与依赖

- 状态：`PENDING`
- 依赖：P9

## 目标

完成迁移边界、最终安全与性能验收、真实 Gemini 验证、文档事实收口和可交付记录。

## 实现清单

- 实现 `data export` API/CLI：Manifest 和按实体稳定排序的 Canonical JSONL。
- 导出当前资源、历史 Run/Case/Eval、当前 Analysis、Contract 和 Artifact 元数据；不展开 Secret，不默认内嵌 Raw 文件。
- 读回完成计数、引用、实体 Hash、文件 Hash 四类对账；Raw 缺失标记 `present=false` 仍允许导出。
- 按实际实现更新现有 `spec/MIGRATION_BOUNDARY.md`，补齐 Canonical Export 代码与测试入口，并核对可迁移事实与必须重构的租户、授权、调度、Secret、Artifact 边界。
- 完成 10 MiB/10 文件文本日志轮转、全链路脱敏和资源回收压力测试。
- 完成生产依赖安全审计、OpenAPI 漂移、WCAG、目标尺寸 E2E 和全部性能门禁。
- 完成 README、REQ、TECH 和全部相关 spec 的实际代码入口；删除过渡代码和空占位。
- 使用显式 Live 配置运行一次真实 Gemini Rubric 和一次真实 Analyzer；所有层重试为 0。

## 性能协议

- 参考环境为当前 macOS ARM64、Node 24、本地磁盘、至少 4 个逻辑核和至少 8 GiB 可用内存；不做人工 CPU/内存限速，记录实际硬件、空闲基线和进程环境。
- 查询预热 10 次、测量 100 次，以 Nearest Rank 计算 p95/p99；单并发。
- 测试集导入、Work Package 导出、Execution Result 导入、报告生成四个对象分别预热 1 次、测量 5 次，报告每次值并以中位数验收，不混用计时范围。
- Playwright 在 1440×900、1280×800 各测 5 次，以表格 ARIA 标记、首屏数据出现且无 Loading/Error 为可交互点。
- 性能噪音只允许在同环境完整重跑一次，不得修改阈值。

## 最终验证

- 1,000 Case 测试集导入 ≤10 秒。
- 查询 p95 ≤250 ms、p99 ≤500 ms。
- 报告与 Markdown ≤5 秒。
- Work Package 导出 ≤10 秒；Execution Result 导入 ≤10 秒。
- Web 关键列表可交互 ≤2.5 秒。
- `pnpm verify:release` 全部通过，覆盖率达到全局门禁。
- 发布记录 Runtime Doctor 检测到的 Python/Ruby 命令与版本，内联两种语言 Smoke 均通过。

## Spec 更新

- `spec/00_INDEX.md`
- `spec/MIGRATION_BOUNDARY.md`
- `spec/SYSTEM_OVERVIEW.md`
- `spec/DECISION_LOG.md`
- `spec/TEST.md`
- 所有模块 spec 的实现状态、代码事实和测试入口

## 完成标准

- 仅对实际通过的 macOS ARM64 环境声明完成和验证。
- 最终交付列出阶段 Commit、验证命令、实测、Live 结果、审计和工作区状态。
- 任何必需未完成项都必须阻止 Goal 标记 Complete，并记录恢复条件。

## 阻塞条件

Gemini Live 因代码错误失败时继续修复；确认是网络、配额或模型权限后记录脱敏证据并请求用户处理。Critical/High 可利用生产漏洞未解决时不得完成。
