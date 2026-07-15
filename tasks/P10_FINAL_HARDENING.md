# P10：Canonical Export 与最终硬化

## 状态与依赖

- 状态：`COMPLETED`
- 依赖：P9

## 目标

完成迁移边界、最终安全与性能验收、真实 Gemini 验证、文档事实收口和可交付记录。

## 实现清单

- [x] 实现 `data export` API/CLI：Manifest 和按实体稳定排序的 Canonical JSONL。
- [x] 导出当前资源、历史 Run/Case/Eval、当前 Analysis、Contract 和 Artifact 元数据；不展开 Secret，不默认内嵌 Raw 文件。
- [x] 读回完成计数、引用、实体 Hash、文件 Hash 四类对账；Raw 缺失标记 `present=false` 仍允许导出。
- [x] 按实际实现更新现有 `spec/MIGRATION_BOUNDARY.md`，补齐 Canonical Export 代码与测试入口，并核对可迁移事实与必须重构的租户、授权、调度、Secret、Artifact 边界。
- [x] 完成 10 MiB/10 文件文本日志轮转、全链路脱敏和资源回收压力测试。
- [x] 完成生产依赖安全审计、OpenAPI 漂移、WCAG、目标尺寸 E2E 和全部性能门禁。
- [x] 完成 README、REQ、TECH 和全部相关 spec 的实际代码入口；删除过渡代码和空占位。
- [x] 使用显式 Live 配置运行一次真实 Gemini Rubric 和一次真实 Analyzer；所有层重试为 0。

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

## 当前验证记录

- 环境：macOS 15.7.4 ARM64、Apple M4 Pro、12 个逻辑核、总内存 48 GiB；最终门禁开始时 `os.freemem()` 为 2,141,372,416 Bytes。Node 24.18.0、pnpm 11.3.0、SQLite 3.53.3、Promptfoo 0.121.18；未做人工资源限速。
- 最终发布调用中，1,000 Case SQLite 测试集导入 5 次中位数 61.833833 ms；Work Package 导出 75.356708 ms；Execution Result 导入 1,772.008334 ms；报告与 Markdown 107.069667 ms。
- 最终发布调用中，查询预热 10 次、测量 100 次：中位数 1.00125 ms、p95 1.163125 ms、p99 1.494416 ms。
- Web 完整导航 5 次：最终同一次 `pnpm verify:release` 中 1440×900 最大 878.54125 ms；1280×800 Reduced Motion 最大 905.468958 ms。完整 Playwright 为 10 项通过、1 项按设计跳过。
- Canonical Export 真实 Runtime 连续执行 20 次，受控临时目录全部回收；完整 Work Package 导出与接收测量同样验证无遗留临时项。
- 生产依赖审计使用官方 npm Registry，Info/Low/Moderate/High/Critical 均为 0；OpenAPI 漂移、WCAG 和固定尺寸 E2E 已通过。
- Runtime Doctor：Python `/Users/air/miniconda3/envs/py312/bin/python3` 3.12.12、Ruby `/usr/bin/ruby` 2.6.10；两种内联 Smoke 均通过。
- 完整 `pnpm verify` 已通过：213 个 Vitest 文件、1,212 项测试，Statements 90.03%（13,034/14,476）、Branches 85.07%（8,553/10,053）、Functions 92.18%（2,702/2,931）、Lines 93.26%（12,106/12,980）；P10 独立 Canonical Export 接收包已纳入同一覆盖率范围。
- 独立变更复审发现的 Raw 请求授权绑定和 Release Report 模型追溯问题已按 TDD 修复；复核结果 P0/P1/P2 均无问题。
- 同一次完整 `pnpm verify:release` 已按固定顺序通过确定性门禁、环境、官方 Registry 审计、完整 Runtime Doctor、真实 Gemini Rubric 和真实 Analyzer。Live 配置引用 `GOOGLE_API_KEY`；Rubric 使用 `gemini-2.5-flash`、Provider 尝试数 1、组件数 1、退出码 0，Analyzer 使用同一模型、Provider 尝试数 1、结构化 Evidence 3 条。
- 最终覆盖率为 Statements 90.03%、Branches 85.07%、Functions 92.18%、Lines 93.26%；无剩余必需功能或门禁失败。

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
