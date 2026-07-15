# 系统流程

## 流程边界

本文档只描述跨模块的事实变化、提交点和副作用边界。模块内部协议和局部校验由对应模块文档维护。

## 资源写入

P3–P4 已把当前资源用例注册为严格 HTTP API 和 Web；P7 CLI 只新增 Work Package 导出和离线阶段命令，不复制资源写入。所有当前资源更新使用独立 Revision；Case 创建、编辑、复制、删除、全量替换与未来建议接受入口共用 CaseDefinitionWriter。

1. Entrypoint 校验外部协议并映射为 Application 输入。
2. Application 调用统一 Case Definition Writer 或配置用例。
3. Domain 校验 Case、Assertion、Prompt 引用、禁止字段和安全约束。
4. 系统派生筛选字段和规范化哈希。
5. Repository 在短事务中写入当前资源并完成对账。

导入测试集按流逐项校验并写入受控外部 staging，全部通过后在一个最终主库短事务中整体提交。导出先冻结 Suite Revision，再按背压逐 Case 短事务读取；Revision 改变即中止。当前资源只保存当前值，不建立版本历史。删除或替换当前资源不改变历史运行快照。

## 创建运行与冻结输入

1. 用户选择测试集、Endpoint、Evaluator 和运行模式。
2. Application 校验资源、Rubric 引用、环境变量名称和执行前置条件。
3. 系统在短读事务中冻结测试集、Cases、Endpoint、Evaluator 和 Rubric Prompts 的脱敏快照。
4. Domain 生成 Suite、Definition、配置和运行上下文哈希。
5. Repository 写入 `READY/REST` 运行事实。

冻结后只使用运行快照，不重新读取当前资源。Analyzer 和 Case Analysis Prompt 在发起分析时另行选择和冻结。

P5 的 Web 创建页先读取 Preflight 事实，再提交可选执行限制；Run Detail 不返回完整冻结 Case 数组或 Prompt 正文。

## REST 阶段

1. Application 条件抢占 `READY/REST`，写入 `RUNNING/REST`。
2. REST Adapter 按冻结配置和并发限制派发 Case，请求期间不持有数据库事务。
3. HTTP 2xx 且 Provider Output 结构合法写入 `SUCCEEDED`，包括业务 `ok=false`。
4. 传输、状态码、解析和结构错误规范化为 REST Error；单个错误不停止其他 Case。
5. 每个已派发结果先以独立短事务幂等落库并推进计数。
6. 若逐 Case 持久化回调失败，Adapter 停止领取、Abort 在途请求并等待全部 Worker 回到同一 Owner，随后阶段收敛为系统失败；不得让迟到 POST 或回调游离到 Owner 之外。
7. 所有已派发请求收口后核对真实结果计数，再按稳定 Cursor 单遍流式读取；Artifact Writer 同步增量计算 Result Set Hash、文件 Hash 与大小，不把完整结果集合驻留内存。
8. 数据库以最新 Revision 对账计数并提交 Manifest，转为 `READY/EVALUATION`；提交竞争失败删除未提交 Artifact。

`STAGED` 到此停在 `READY/EVALUATION`；`PIPELINE` 使用 REST 提交后的最新 Revision 自动启动 Evaluation。Starter 返回失败且 Run 仍处于同一交接 Revision 时提交 `EVALUATION_STAGE_FAILED`；若其他 Owner 已推进，则保留最新事实。逐 Case API 只返回真实已完成结果。SSE 通过独立数据库查询发送当前 Snapshot 和有持久语义的 Revision 事件；Evaluation 只有开始/完成事件，不伪造没有逐 Case持久计数支撑的进度事件。轮询跨过多个 Stage 时，以同一最新 Revision 按流水线顺序补发全部可证明事件。页面刷新或流重连只重新读取事实。

## Evaluation 阶段

以下 P6 流程已闭环并注册平台 API/Web。Bridge 不需要 Assertion 身份，按调用期总预算和并发限制调用冻结 Evaluator。

1. Application 校验候选 Run 后，在状态改变前只对 REST 成功、未复用且实际进入 Promptfoo 的 Case 所需 Python/Ruby 执行真实内联 Smoke；通过后才条件抢占 `READY/EVALUATION`。
2. 系统只把 REST 成功 Case 物化为受控 Promptfoo 输入，并使用预计算 `providerOutput`。
3. Promptfoo Adapter 使用固定版本和固定参数启动子进程，不通过 Shell 拼接输入。
4. Provider-dependent Assertion 通过本机临时 Evaluator Bridge 调用冻结 Run Evaluator；Bridge 不能代理任意 Provider、URL、Model、Header 或 Secret。
5. Importer 对齐 Case 和 Assertion，提取结构化事实，生成 Diff、Metric 和结果哈希。
6. REST Error Case 生成 `NOT_EVALUATED`。全部 REST Error 时跳过 Promptfoo，但仍生成完整的 Not Evaluated 集合。
7. SQLite 提交边界复算 Eval、Final 和 Result Set Hash，对齐 REST 状态、Raw Evidence Artifact、来源 Provenance、Revision 与取消事实；完整集合在一个短事务中写入后转为 `READY/REPORT`。

Assertion 失败退出码属于评估事实。进程启动、配置、文件、信号或未知输出结构错误才是系统执行失败。

## Report 阶段

1. Application 条件抢占 `READY/REPORT`。
2. Reporting 校验每个冻结 Case 的 REST 和 Eval 事实完整性。
3. Reporting 从规范化明细重算整体统计、By Metric 统计和结果集合哈希。
4. 对账通过后生成 JSON 事实和单向派生的 Markdown。
5. 无错误提交 `COMPLETED/DONE`；存在 REST、Eval Error 或 Not Evaluated 提交 `COMPLETED_WITH_ERRORS/DONE`。

对账失败不得提交伪造的完整报告。

## Analysis 流程

1. 用户从完整报告显式选择 `failed | errors | all`，并选择 Analyzer、Case Analysis Prompt 与 Analysis 并发。
2. Application 构造脱敏、版本化的 Analysis Input 和输入身份；Analyzer 直接使用官方 SDK，不经过 Promptfoo Evaluator Bridge。
3. Analysis Adapter 渲染受控变量并调用模型，模型调用期间不持有事务。
4. Analysis Adapter/Mapper 使用 Contracts 校验外部结构化输出并转换为核心类型。Evidence 每项必须有固定来源、RFC 6901 字段路径或 `null` 和非空结论，字符串整体拒绝。
5. Application 保存当前分析、分类、结构化 Evidence 和可选 Proposal。每次调用生成新 ID/Input/Result Hash；重新分析按 Revision 替换当前记录并清除旧决策。
6. 并发启动只能恢复本请求精确抢占的 ID/Revision；另一个请求持有的 `RUNNING` 记录返回 `ANALYSIS_STATE_CONFLICT` 且不被覆盖。
7. 用户拒绝、接受或编辑后接受建议。
8. 应用前重新校验 Final Result、Analysis Revision、Base Definition Hash 和 Prompt 引用，再调用统一 Case Definition Writer。

输入或目标发生变化时写入冲突，不自动合并或 Rebase。

## 离线工作包

1. 平台在短读事务中冻结当前资源，通过 Manifest-first NDJSON 导出不可变输入、Hash 和 `.env.example`。
2. 本地接收器在受控 staging 中校验路径、大小、顺序和 Hash，完整成功后原子发布 0700 目录与 0600 文件。
3. 每次离线执行创建新的 Execution ID 和独立输出目录；Retry/Force 只读取来源，不覆盖来源。
4. 单阶段 CLI 校验自身环境；REST 在创建 Execution 前完整读取 Endpoint、全部 Case 和 Retry 来源。Pipeline 在 REST 外部调用和任何 Execution 变更前，同时预检所选阶段环境、冻结 Case、完整 Evaluator/Rubric Prompt、Case Prompt 引用、固定 Promptfoo 精确版本与实际需要的 Python/Ruby Runtime，并用同一个冻结 Secret Snapshot 顺序执行。
5. Evaluation 的 Case、REST、复用与导入结果按 128 项写入 owner-only SQLite；Engine 两遍重放并流式生成配置，Raw 逐 Row 导入，最终按 Ordinal 直接写 Normalized，不聚合随 Case 数线性增长的大对象数组或 Map。
6. 同一工作包由跨进程锁限制为单写者；不同工作包可以并行。阶段成功产物不可覆盖。
7. 当前 Pipeline 默认执行 REST→Evaluation→Report；只有显式提供 Analysis Selector 时才追加 Analysis，并要求 Report、Analyzer 和 Analysis Prompt 已存在。
8. Work Package Reader 对 REST/Raw/Normalized/Report/Analysis 执行两遍严格校验并重算 Eval、Final、Report、Analysis Input/Result 和 Result Set Hash；复用结果沿 Execution Provenance 追溯到真正持有 Raw 的祖先，每遍按执行版本验证一次并只缓存最小 Evidence 身份。取消贯穿预检、Engine、Artifact 与最终提交；清理失败只报告，不覆盖主终态。

相同 Package ID、Execution ID、Result Set Hash 与规范化 Artifact Manifest 重复登记幂等成功；相同 Execution ID 对应不同 Package、结果，或 Manifest 的版本、Owner、Kind、路径、Hash、大小、Payload Contract Version 任一不同均返回冲突。报告和分析允许分两次导入；Analysis 必须绑定已经存在的精确 Report Execution 与 Final Case Result。所有导入按显式身份查询，不使用 `select max`。

平台 Retry 与离线 `--retry-failed` 使用来源冻结输入创建新 Run/Execution：复制 REST `SUCCEEDED`，重新请求 REST `ERROR`；只复制对齐且 Raw/Normalized 来源 Artifact 在规划和 Evaluation 时均实际校验为 `PRESENT` 的 Eval `PASS/FAIL`；文件缺失/损坏、`EVALUATION_ERROR`、缺失 Eval 事实和新 REST 成功后的 `NOT_EVALUATED` 都重新评估。Force 在新身份下重新执行全部 REST/Eval。P6 内部 Use Case 已创建新 Run、跳过复用 Case 的外部调用并重新生成完整 Artifact/Result Set；来源事实不得覆盖。对外入口等待 Report 终态闭环后注册。

## 取消与恢复

- 取消先持久化请求，再停止派发新 REST/Evaluation 工作，并让在途请求或子进程被 Abort、安全收口；跨进程轮询拒绝会立即 Abort 并由 Owner 收敛为受控失败，不产生未处理 Promise。
- 已真实完成的阶段事实保留；未执行 Case 不生成伪造结果。
- 取消与阶段提交通过条件更新竞争，只允许先成功的一方生效。
- Runtime Shutdown 在 Artifact 写入和阶段提交后重查中断门禁，最终把仍未 `DONE` 的本地 Owner 修正为 `INTERRUPTED/DONE`。
- 进程启动时把遗留 `RUNNING` 收敛为 `INTERRUPTED/DONE`，不自动续跑或推测未知副作用。
- 外部进程、临时文件和临时目录由 Adapter 在资源回收路径中清理。
- REST、Evaluator 和 Analyzer 不自动重试。Promptfoo 取消先发送 `SIGTERM`，5 秒未退出再发送 `SIGKILL`；离线阶段收敛为 `EVALUATOR_CANCELLED`，不登记部分 Artifact，CLI 返回 130。

## 相关事实入口

- 目标流程来源：[REQ.md](../REQ.md) 与 [TECH.md](../TECH.md)
- 当前 Run 编排：[packages/application/src/features/runs](../packages/application/src/features/runs)
- 当前 REST Adapter：[packages/evaluation-adapters/src](../packages/evaluation-adapters/src)
- 当前 Run Repository：[packages/storage-sqlite/src/sqlite-platform-run-repository.ts](../packages/storage-sqlite/src/sqlite-platform-run-repository.ts)
- 当前 Eval Repository：[packages/storage-sqlite/src/sqlite-platform-eval-repository.ts](../packages/storage-sqlite/src/sqlite-platform-eval-repository.ts)
- 当前重跑选择器：[packages/application/src/features/runs/platform-rerun-planner.ts](../packages/application/src/features/runs/platform-rerun-planner.ts)
- 当前 P3–P5 Local API：[apps/local-server/src](../apps/local-server/src)
- 当前 P4–P5 Web：[apps/web/src](../apps/web/src)
- 当前 Work Package 文件运行时：[packages/work-package/src](../packages/work-package/src)
- 当前离线 CLI：[apps/cli/src](../apps/cli/src)
- Promptfoo 外部链、Eval/Report/Analysis 原子持久化、平台重跑、Work Package REST→Evaluation→Report→显式 Analysis、Reporting Ajv Diff/聚合/Markdown 和完整 Execution Report/Analysis Import 已落地；Canonical Export 等待 P10。
- [APPLICATION/RUNS.md](APPLICATION/RUNS.md)
- [APPLICATION/EXECUTION_IMPORTS.md](APPLICATION/EXECUTION_IMPORTS.md)
- [PACKAGES/EVALUATION_ADAPTERS.md](PACKAGES/EVALUATION_ADAPTERS.md)
- [PACKAGES/REPORTING.md](PACKAGES/REPORTING.md)
- [PACKAGES/WORK_PACKAGE.md](PACKAGES/WORK_PACKAGE.md)
