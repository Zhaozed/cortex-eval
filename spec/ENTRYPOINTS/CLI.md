# CLI

## 模块职责

CLI 负责参数解析、用户消息、稳定机器输出、平台 API 调用和离线阶段用例调用。

CLI 不直接访问平台 SQLite，不复制状态机、统计、Case 写入或导入对账规则。

## 边界与依赖

平台命令依赖本地 HTTP API。离线命令依赖 Work Package、Contracts 和阶段 Application 用例。CLI 文案从消息资源加载；`--json` 使用 NDJSON，stdout 只输出机器协议，诊断写 stderr。

## 实现状态

已落地 `apps/cli` 的 `package export`、`package validate`、`rest run`、`eval run`、`report build`、`analyze run`、默认 REST→Evaluation→Report 且可显式追加 Analysis 的 `pipeline run`，以及 Report/Analysis `result import`。旧 TypeScript REST 运行器已经删除。Canonical Export 尚未闭环，因此 `data export` 不注册，也不出现在 Help。

## 代码事实入口

- [cli-program.ts](../../apps/cli/src/cli-program.ts)：命令、参数、机器协议和退出码映射。
- [cli-entry.ts](../../apps/cli/src/cli-entry.ts)：生产依赖装配。
- [package-command-service.ts](../../apps/cli/src/package-command-service.ts)：平台导出与本地校验。
- [rest-command-service.ts](../../apps/cli/src/rest-command-service.ts)：离线 REST 阶段入口。
- [evaluation-command-service.ts](../../apps/cli/src/evaluation-command-service.ts)：离线 Evaluation 阶段入口。
- [work-package-report-run-service.ts](../../apps/cli/src/work-package-report-run-service.ts)：离线 Report 对账、JSON/Markdown 写入和阶段提交。
- [work-package-analysis-run-service.ts](../../apps/cli/src/work-package-analysis-run-service.ts)：离线 Analysis 输入对账、Analyzer 调用、Artifact 写入和阶段提交。
- [analysis-command-service.ts](../../apps/cli/src/analysis-command-service.ts)：`analyze run` 的安全工作包入口。
- [result-import-command-service.ts](../../apps/cli/src/result-import-command-service.ts)：通过本地 API 导入完整 Execution Report 或 Analysis。
- [pipeline-command-service.ts](../../apps/cli/src/pipeline-command-service.ts)：默认 REST→Evaluation→Report 和显式 Analysis 尾阶段。
- [cli-contracts.ts](../../packages/contracts/src/cli-contracts.ts)：稳定机器输出契约。

## 当前测试入口

- [apps/cli/test](../../apps/cli/test)：命令注册、Help、机器输出、Secret、阶段执行、Pipeline、Retry 和 Force。
- [packages/work-package/test](../../packages/work-package/test)：工作包文件、锁、Artifact 与重跑证据。

## 对外接口

当前命令为 `package export`、`package validate`、`rest run`、`eval run`、`report build`、`analyze run`、`pipeline run` 和 `result import`。`result import --type report | analysis` 显式选择导入类型。后续阶段只剩 `data export` 待注册，未实现命令不得提前暴露。

当前 `pipeline run` 默认执行 REST、Evaluation 与 Report。只有显式提供 `--analysis-selector failed | errors | all` 才执行 Analysis，且必须已有或同时选择 Report，并使用工作包冻结的 Analyzer、Analysis Prompt 和创建 Execution 时冻结的 Analysis 并发。

## 核心流程

CLI 先读取一次显式 Env 文件并形成冻结 Secret Snapshot。Pipeline 在 REST 调用、创建或修改 Execution 前，同时完成所选阶段环境校验、全部冻结 Case 清洗、完整 Evaluator/Rubric Prompt 读取、Case Prompt 引用校验、固定 Promptfoo 精确版本和实际需要的 Python/Ruby Runtime Smoke，再用同一 Snapshot 顺序执行所选阶段。Evaluation 开始前仍重新校验实际待评估 Case，防止状态变化绕过门禁；Report 从已经提交的规范化结果重算，不读取 Secret 或 Raw 事实；Analysis 直接调用冻结 Analyzer 官方 SDK，不经过 Bridge。单阶段命令只校验自身依赖。Secret 展开值不写入工作包、Artifact、stdout、stderr 或日志。

REST 单阶段命令也在创建 Execution 前完整读取 Endpoint、全部 Case 和 Retry 来源，并在 REST 返回后和 Artifact 发布后复核取消；开始后的取消返回 `REST_CANCELLED`。Evaluation 使用 owner-only SQLite 有界暂存输入、复用结果与逐 Row 导入结果，全部按 128 项事务批次提交；REST/Normalized 写入按 Manifest ordinal→Case Key 身份对齐并拒绝截断终止，不保留完整 Case/REST/Eval 数组或全量 Case Key 集合。CLI 信号贯穿预检、Engine、Raw/Normalized 写入和最终提交；已发布但未登记的文件只凭当前命令持有的非持久发布身份补偿删除，相同内容的新 inode 也保留并外化清理警告。`package export` 在成功响应完整消费前失败或取消时主动取消未读 Body。启动恢复没有发布身份时保留并报告，不按路径删除；Body 或文件清理失败不覆盖主错误和主退出码。

每次新运行创建独立 Execution。`--retry-failed` 和 `--force` 读取来源 Execution，但始终创建新身份；连续 Retry 按 Provenance 和 Artifact 完整性决定复用。所有 Case 都复用时仍生成新的 Evaluation Result Set Hash。合法 Promptfoo Assertion Fail 在 Pipeline 全复用路径仍返回退出码 1。

## 状态、事务与幂等

后续阶段通过 Execution ID 读取同一执行的既有产物。已完成阶段不可覆盖。参数、环境或运行时预检失败时不开始阶段；阶段开始后的系统失败写入该阶段 `ERROR`，前置失败保持 `PENDING`。

同一工作包写入由跨进程锁串行化，不同工作包可以并行。`package export` 在发起 Local API 请求前按 Owner、PID 启动身份和 TTL 清理目标父目录中的失活 staging，不删除存活或身份不稳定的目录；正式目标名拒绝恢复器保留的 `.cortex-export-*` 前缀。Endpoint、Evaluator 和 Rubric Prompt 在实际消费时复核 Manifest 文件 Hash 与大小。平台导入幂等由 Application 处理，CLI 不直接写平台数据库。

## 错误收敛

参数、环境、锁、文件和阶段错误映射为稳定 Error Code。已识别命令即使在 Commander 参数解析阶段失败，`--json` 也输出命令对应的严格 `COMMAND_ERROR`；工作包私有路径、布局、孤儿、大小和文件变化码先归一为公开 Work Package 错误，不作为 `INTERNAL_ERROR` 泄漏。退出码固定为 0 成功、1 Eval Fail、2 输入/配置、3 外部或阶段系统错误、4 冲突/锁、130 取消；`REQUEST_ABORTED`、`REST_CANCELLED`、`EVALUATOR_CANCELLED` 与 `ANALYSIS_CANCELLED` 均属于取消。Promptfoo 原生 Assertion Fail 退出码 100 映射为 CLI 退出码 1，不误报为系统错误；真实 Promptfoo 子进程取消映射为 `EVALUATOR_CANCELLED`，不产生部分 Artifact。

## 观测与验收

普通模式输出外化的简体中文消息；机器模式只输出闭合 NDJSON 事件。日志与终端不显示 Secret、完整 Prompt、Provider Output 或第三方堆栈。

测试必须证明命令按阶段注册、未来命令隐藏、Pipeline 使用同一 Secret Snapshot、预检先于 Execution 变更、Retry/Force 创建新身份、Report 对账与导入幂等，以及真实 REST Adapter 与固定 Promptfoo 进程可以在同一 Execution 闭环。
