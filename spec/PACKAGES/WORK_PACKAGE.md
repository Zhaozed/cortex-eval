# Work Package

## 模块职责

Work Package 管理离线输入协议、不可变 Manifest、Execution 状态、路径安全、跨进程锁、原子写入和阶段 Artifact Schema。

模块不写平台数据库，不执行平台结果导入，不把文件系统伪装成 Repository。

## 边界与依赖

Package 依赖 Contracts Schema、文件系统和安全 Hash 工具，实现 Work Package Store 与 Stage Artifact Store。离线阶段接收冻结 Execution Context，通过窄接口读输入和追加输出。

## 实现状态

P1 已在 Contracts 冻结完整 Manifest v1、Execution v1、固定阶段依赖图、六类 Artifact 槽位、Artifact Manifest 与 Result Import Schema。`packages/work-package` 文件运行时尚未落地；当前脚本仍直接读写固定 JSON 路径，不具备路径安全、锁、原子 Artifact Store 或导入实现。

## 目标代码落点

`packages/work-package`

## 当前代码事实入口

- [work-package-contracts.ts](../../packages/contracts/src/work-package-contracts.ts)：不可修改的 Manifest v1 与 Execution v1 Schema。
- [artifact-contracts.ts](../../packages/contracts/src/artifact-contracts.ts)：阶段 Artifact 与 Artifact Manifest Schema。
- [result-import-contracts.ts](../../packages/contracts/src/result-import-contracts.ts)：报告/分析分次导入协议。
- [run_promptfoo_rest.ts](../../data_scripts/run_promptfoo_rest.ts)：当前原子结果文件写入参考。
- [run_promptfoo_rest_cli.ts](../../data_scripts/run_promptfoo_rest_cli.ts)：当前文件参数入口参考。

## 当前样例与测试入口

- [run_promptfoo_rest.test.ts](../../data_scripts/run_promptfoo_rest.test.ts)
- [run_promptfoo_rest.md](../../data_scripts/run_promptfoo_rest.md)

## 对外接口

Manifest v1 在 Contracts 阶段一次冻结，保存 Package Version、Package ID、来源 Suite 与 Hash、Case Base Hashes、Endpoint、Evaluator、Analyzer、两类 Prompt、Promptfoo 与 Contract Version、全部阶段 Env Keys、Run/Analysis Execution Limits 默认值与范围、最终阶段依赖图、全部 Artifact 槽位和输入文件 Hash。

每个 `executions/<execution_id>/execution.json` 保存独立执行身份、冻结的 Run/Analysis Execution Limits、Execution Context Hash、阶段状态、时间、Error Code 和输出文件 Hash。CLI 在创建 Execution 时显式传入或使用 Manifest 默认值；首个阶段开始后不可修改。Artifact 分为 REST Results、Raw Promptfoo Evidence、Normalized Eval、Report JSON、Report Markdown 和 Analysis Results。

Manifest 中所有输入文件路径唯一，Rubric Prompt Key 唯一。Execution Context Hash 的版本化输入固定包含 Package ID、Manifest Hash、Run Execution Limits 和 Analysis Execution Limits。Execution Schema 校验顶层生命周期、固定阶段依赖、单一运行阶段、来源 Execution 不自指，并把每个阶段绑定到固定 Artifact Kind、路径和 Contract Version。

Analysis 是 Report 后的可选执行步骤，不属于平台 Run Stage。离线 Pipeline 选择 Analysis 时必须有 Report Artifact 或同时选择 Report，并显式提供 Case Selector；Analysis 失败不覆盖 Report 文件或 Hash。

## 核心流程

导出时原子生成不可变输入和 `.env.example`。执行时校验版本、路径、文件 Hash 和阶段环境，获取同包独占锁，创建新 Execution，再按阶段追加尚未完成的 Artifact。

## 状态、事务与幂等

Manifest 创建后不可修改。每次执行使用新 Execution ID。成功阶段产物不可覆盖。`--retry-failed` 复制 REST `SUCCEEDED` 和对齐的 Eval `PASS/FAIL`，重新执行 REST `ERROR`、`EVALUATION_ERROR`、缺失 Eval 事实和新 REST 成功后的 `NOT_EVALUATED`；`--force` 全量执行。两者保存来源与复用 Hash。写入先落受控临时文件，Flush 后原子 Rename。

同一工作包只有一个写进程，不同工作包可以并行。锁记录 PID、Execution ID 和开始时间。

## 错误收敛

拒绝绝对路径、`..`、符号链接逃逸、`file://` 外部代码、外部模块、额外依赖、Hash 不匹配、缺失 Env、活动锁和已完成阶段覆盖。失败时不暴露半写文件，遗留锁只在确认进程不存在且状态可恢复时清理。

## 观测与验收

目录与普通文件仅当前用户可访问。日志记录 Package ID、Execution ID、阶段、文件 Hash 和 Error Code，不记录 Secret 与敏感正文。只含空值 Key 和用途说明的 `.env.example` 属于工作包；用户显式指定且可能包含真实 Secret 的 Env 文件不属于工作包，也不参与 Hash 或导入。

## 相关测试

目标测试覆盖 Manifest、Execution、阶段追加、原子写入、权限、路径与符号链接逃逸、同包双进程锁、遗留锁、不同包并行、Secret 扫描、重跑来源和已完成阶段不可覆盖。P7 提交 Golden Package，P9 必须不修改 Manifest 完成 Report/Analysis 并导入。
