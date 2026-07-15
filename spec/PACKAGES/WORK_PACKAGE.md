# Work Package

## 模块职责

Work Package 管理离线输入协议、不可变 Manifest、Execution 状态、路径安全、跨进程锁、原子写入、阶段 Artifact 和严格导入读取。

模块不写平台数据库，不执行平台结果提交，不把文件系统伪装成 Repository。

## 边界与依赖

Package 依赖 Contracts Schema、文件系统和安全 Hash 工具，实现 Work Package Store 与 Stage Artifact Store。离线阶段接收冻结 Execution Context，通过窄接口读输入和追加输出。Application 只接收已经完成边界清洗的强类型结果。

## 实现状态

P7 已落地 `packages/work-package` 文件运行时、平台导出接收、包校验、Execution 生命周期、REST/Raw/Normalized Artifact、Retry 证据读取和 Evaluation Import 严格读取基础。P8 在不修改 Work Package v1 Manifest 的前提下补齐 Report JSON/Markdown Writer、Report Reader、完整平台导入 Reader 和取消/大小门禁。P9 使用既有 Analysis 槽位补齐流式 Writer、严格 Artifact Reader、双遍 Import Reader 和命令闭环，Manifest v1 与 Golden Hash 均未修改。

## 代码事实入口

- [work-package-contracts.ts](../../packages/contracts/src/work-package-contracts.ts)：不可修改的 Manifest v1 与 Execution v1 Schema。
- [work-package-runtime-contracts.ts](../../packages/contracts/src/work-package-runtime-contracts.ts)：文件运行时上限和运行结果契约。
- [artifact-contracts.ts](../../packages/contracts/src/artifact-contracts.ts)：阶段 Artifact 与 Artifact Manifest Schema。
- [secure-work-package-directory.ts](../../packages/work-package/src/secure-work-package-directory.ts)：安全目录和不可跟随路径边界。
- [work-package-export-receiver.ts](../../packages/work-package/src/work-package-export-receiver.ts)：Manifest-first 流式导出接收。
- [work-package-execution-session.ts](../../packages/work-package/src/work-package-execution-session.ts)：Execution、阶段状态、锁和 Artifact 提交。
- [work-package-evaluation-result-reader.ts](../../packages/work-package/src/work-package-evaluation-result-reader.ts)：Evaluation Artifact 双遍严格读取与语义对账。
- [work-package-report-artifact-writer.ts](../../packages/work-package/src/work-package-report-artifact-writer.ts)：Report JSON/Markdown 成对不可变发布。
- [work-package-report-reader.ts](../../packages/work-package/src/work-package-report-reader.ts)：离线 Report 构建输入的规范化读取。
- [work-package-report-import-reader.ts](../../packages/work-package/src/work-package-report-import-reader.ts)：平台导入前的 Report 双遍对账。
- [work-package-analysis-artifact-writer.ts](../../packages/work-package/src/work-package-analysis-artifact-writer.ts)：稀疏 Analysis Case 流式写入、Result Set Hash 和不可变发布。
- [work-package-analysis-artifact-reader.ts](../../packages/work-package/src/work-package-analysis-artifact-reader.ts)：结构化 Evidence、Case Hash、顺序和尾部身份校验。
- [work-package-analysis-import-reader.ts](../../packages/work-package/src/work-package-analysis-import-reader.ts)：冻结 Report/Analyzer/Prompt 与 Analysis Artifact 的双遍导入对账。

## 当前样例与测试入口

- [work-package-v1](../../packages/work-package/test-fixtures/work-package-v1)：无 Secret、固定 Manifest Hash 的 Golden Work Package v1。
- [packages/work-package/test](../../packages/work-package/test)：文件安全、导出、Execution、Artifact、Retry、大小边界和 Golden Fixture。
- [apps/cli/test](../../apps/cli/test)：真实命令和阶段闭环。

## 对外接口

Manifest v1 保存 Package 身份、来源 Suite 与 Hash、Case Base Hashes、Endpoint、Evaluator、Analyzer、两类 Prompt、Promptfoo 与 Contract Version、全部阶段 Env Keys、Run/Analysis Execution Limits 默认值与范围、最终阶段依赖图、全部 Artifact 槽位和输入文件 Hash。

每个 `executions/<execution_id>/execution.json` 保存独立执行身份、冻结限制、Execution Context Hash、来源 Execution、阶段状态、时间、Error Code 和输出描述符。Artifact 分为 REST Results、Raw Promptfoo Evidence、Normalized Eval、Report JSON、Report Markdown 和 Analysis Results。

固定运行时上限按 UTF-8 原始字节计算：Manifest 256 MiB、Execution 4 MiB、配置/Prompt/`.env.example` 每项 8 MiB、Canonical Tests 1.25 GiB、Canonical Case 16 MiB、REST Case 32 MiB、Normalized Eval Case 32 MiB、Report Case 80 MiB、Analysis Result Case 80 MiB、Promptfoo Raw Row 64 MiB，解码后的 JSON String Token 16 MiB。REST、Normalized、Report、Analysis 和 Raw Artifact 不设总文件上限；前四类按 Case 流式解析，Raw Retry 只复核登记 Hash、大小和 Descriptor，不重新解析正文。

## 核心流程

平台导出先在短事务中冻结资源快照，再以 Manifest-first NDJSON 流传给本地接收器。接收器校验路径、声明 Hash、大小和顺序，写入 0700 staging 与 0600 文件，完整成功后原子发布。每次 CLI 导出在发起平台请求前先按 Owner、PID 启动身份和 TTL 恢复目标父目录中的遗留 staging；存活 Owner、未过 TTL 或身份变化中的目录不删除。`.cortex-export-*` 是恢复器专用的 staging 名称空间，正式目标名必须拒绝该前缀，避免 ownerless 恢复误删已发布包。

执行前校验 Manifest、输入文件和阶段依赖，获取同包独占锁并创建新 Execution。Endpoint、Evaluator 和 Rubric Prompt 在实际消费时再次按 Manifest 描述符校验 Hash 与大小，防止初始扫描后被同 inode、同尺寸原位替换。Pipeline 在创建 Execution 前读取完整 Evaluator/Rubric Prompt、验证 Case Prompt 引用、固定 Promptfoo 精确版本和实际需要的 Python/Ruby Runtime。阶段成功后只原子追加固定路径 Artifact 和描述符。Evaluation 导入读取先完整预检，再在实际消费时重新校验 REST/Normalized 语义和 Raw 描述符；复用结果按 `provenance` 逐代读取来源 Execution，校验来源 Result Hash、Ordinal、相同 Raw Evidence 和最终祖先 Raw 完整性。每一遍只缓存 Case Key、Ordinal、Hash、Evidence 与 Provenance，不缓存完整规范化正文。

REST 单阶段命令在创建 Execution 前完整读取并校验 Endpoint、全部 Case 和 Retry 来源，并在 REST 返回后、Artifact 发布后与阶段登记前复核取消；开始后的取消收敛为 `REST_CANCELLED`。Evaluation 把 Case/REST、可复用 Eval 和新导入 Eval 写入命令私有 owner-only SQLite，三类写入都按 128 项事务批次提交；当前批次异常回滚，命令失败后删除完整 staging。Engine 从该存储获得可重放 Case Source，Raw 按 Row 导入，最终结果按 Ordinal 直接流式写入 Normalized Artifact；REST/Normalized Writer 和增量 Result Set Hasher 都通过已验证 Manifest 的 ordinal→Case Key 解析器逐项对齐，并在结束时确认 Manifest 已无下一 Case，不建立随 Case 数增长的内存 Key 集合。取消在每次读取、写入和最终提交前复核；REST/Raw/Normalized 发布结果把可持久 Descriptor 与非持久 device/inode 补偿身份分开，当前锁定 Session 只有在固定槽位、Descriptor Hash/大小、发布身份及清理时稳定身份全部匹配时才删除未登记文件。相同字节的新 inode 也作为替换对象保留并报告；异常退出后发布身份已丢失的未登记文件由启动恢复保留并报告，不按路径删除。`RUNNING` 或 `ERROR` 阶段不允许携带 Artifact。工作包导出成功响应未完整消费时主动取消 Body；Body、Raw Source、staging、未登记 Artifact 或导出 staging 清理失败通过脱敏旁路观察器报告，不能覆盖主结果或目标冲突。

Analysis 只消费同一 Execution 已完成的 Report、冻结 Analyzer 与 Analysis Prompt，并按 `failed | errors | all` 显式 Selector 产生稀疏结果。每项 Evidence 在写入前已经是严格结构对象；Artifact Reader 不接受字符串兼容格式。错误结果只接受闭合 Error Code 和有界诊断文案；该文案只用于离线排障，平台导入会按 Error Code 重建本地化文案。阶段认领前取消保持 `PENDING/REQUEST_ABORTED`，认领后取消保存 `ANALYSIS_CANCELLED/ERROR`，且不登记部分 Artifact。Analysis 失败不修改已完成的 Report JSON、Markdown、Hash 或导入事实；无可分析 Case 写入合法空结果集。平台导入在预检与实际消费两遍中重算每个 Analysis Input/Result Hash、选中 Case 集与 Result Set Hash。

普通文件使用同目录临时文件、Flush、不可覆盖 Link 和目录同步发布；完整工作包目录使用 staging Rename 和父目录同步发布。若 Link/Rename 已成功而目录同步失败，运行时只在目标 inode/设备身份仍等于刚发布对象时撤销并再次同步；目标已被并发替换时不触碰替换对象，只报告补偿失败。撤销和清理观察器失败不得覆盖首次发布错误。

## 状态、事务与幂等

Manifest 创建后不可修改。每次运行、失败重跑和 Force 都使用新 Execution ID；Run/Execution 身份是执行版本，Raw/Normalized/Evaluation Result Set Hash 是绑定该身份和 Evaluation Context 的评估版本，Report Result Set Hash 再绑定 Execution Owner、Evaluation 版本、Run Context 和 Report Contract，Analysis Result Set Hash 另行绑定 Execution Owner、Selector、Analyzer、Prompt 和有序 Analysis 结果。成功阶段产物不可覆盖，也不通过 `select max` 推断来源版本。

`--retry-failed` 复制 REST `SUCCEEDED` 和证据完整且对齐的 Eval `PASS/FAIL`；其余事实重新执行。`--force` 全量执行。两者保存来源与复用 Hash。只有 Package ID、Execution ID、Result Set Hash 和规范化 Artifact Manifest 全部相同的平台登记才是幂等；任一身份冲突均拒绝。

同一工作包只有一个写进程，不同工作包可以并行。锁使用稳定 inode，记录 PID、Execution ID、进程启动身份和开始时间；只在确认 Owner 消失且状态可恢复时清理。

## 错误收敛

拒绝绝对路径、`..`、符号链接逃逸、外部代码或依赖、Hash/大小不匹配、缺失 Env、活动锁和已完成阶段覆盖。参数、环境或运行时预检失败时阶段保持 `PENDING`；阶段开始后的外部或产物失败写入 `ERROR`。临时文件不以正式路径暴露。

Import 任一身份、Owner、路径、顺序、Base Hash、REST/Eval/Raw 关系或重算 Hash 不一致都返回稳定错误，且不进入数据库事务。Raw 只作为证据校验，不作为平台业务事实导入。

## 观测与验收

目录与普通文件仅当前用户可访问。日志记录 Package ID、Execution ID、阶段、文件 Hash 和 Error Code，不记录 Secret 与敏感正文。`.env.example` 只含空值 Key 与用途；用户 Env 文件不属于工作包，也不参与 Hash 或导入。

Golden Manifest Hash 固定为 `e840ce500481b6f92393b1efe6d9022c1ceebd9fbbeaf713d03c9e2f6ee54178`。P8 已在不修改 Work Package v1 Manifest 的前提下补充 Report；P9 对 Analysis 也必须遵守同一约束。若协议无法满足，必须新建版本而不是静默修改 Fixture。
