# 系统流程

## 流程边界

本文档只描述跨模块的事实变化、提交点和副作用边界。模块内部协议和局部校验由对应模块文档维护。

## 资源写入

P3–P4 已把当前资源用例注册为严格 HTTP API 和 Web；目标 CLI 仍未落地。所有当前资源更新使用独立 Revision；Case 创建、编辑、复制、删除、全量替换与未来建议接受入口共用 CaseDefinitionWriter。

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

P5 到此停止，不自动启动 Evaluation。逐 Case API 只返回真实已完成结果。SSE 通过独立数据库查询发送当前 Snapshot 和 Revision 变化，页面刷新或流重连只重新读取事实。

## Evaluation 阶段

1. Application 条件抢占 `READY/EVALUATION`。
2. 系统只把 REST 成功 Case 物化为受控 Promptfoo 输入，并使用预计算 `providerOutput`。
3. Promptfoo Adapter 使用固定版本和固定参数启动子进程，不通过 Shell 拼接输入。
4. Provider-dependent Assertion 通过本机临时 Evaluator Bridge 调用冻结 Run Evaluator；Bridge 不能代理任意 Provider、URL、Model、Header 或 Secret。
5. Importer 对齐 Case 和 Assertion，提取结构化事实，生成 Diff、Metric 和结果哈希。
6. REST Error Case 生成 `NOT_EVALUATED`。全部 REST Error 时跳过 Promptfoo，但仍生成完整的 Not Evaluated 集合。
7. 完整结果集合提交后转为 `READY/REPORT`。

Assertion 失败退出码属于评估事实。进程启动、配置、文件、信号或未知输出结构错误才是系统执行失败。

## Report 阶段

1. Application 条件抢占 `READY/REPORT`。
2. Reporting 校验每个冻结 Case 的 REST 和 Eval 事实完整性。
3. Reporting 从规范化明细重算整体统计、By Metric 统计和结果集合哈希。
4. 对账通过后生成 JSON 事实和单向派生的 Markdown。
5. 无错误提交 `COMPLETED/DONE`；存在 REST、Eval Error 或 Not Evaluated 提交 `COMPLETED_WITH_ERRORS/DONE`。

对账失败不得提交伪造的完整报告。

## Analysis 流程

1. 用户从完整报告选择失败或评估错误 Case，并选择 Analyzer 与 Case Analysis Prompt。
2. Application 构造脱敏、版本化的 Analysis Input 和输入身份。
3. Analysis Adapter 渲染受控变量并调用模型，模型调用期间不持有事务。
4. Analysis Adapter/Mapper 使用 Contracts 校验外部结构化输出并转换为核心类型，Application 保存当前分析、分类、证据和可选 Proposal。
5. 用户拒绝、接受或编辑后接受建议。
6. 应用前重新校验 Final Result、Analysis Revision、Base Definition Hash 和 Prompt 引用，再调用统一 Case Definition Writer。

输入或目标发生变化时写入冲突，不自动合并。重新分析覆盖同一 Run/Case 的当前分析，并递增 Revision。

## 离线工作包

1. 平台从当前资源生成不可变 Manifest、输入文件、哈希和 `.env.example`。
2. 每次离线执行创建新的 Execution ID 和独立输出目录。
3. CLI 按阶段校验环境变量、读取冻结输入并原子追加阶段产物。
4. 同一工作包由跨进程锁限制为单写者；不同工作包可以并行。
5. 平台导入规范化事实，重新校验身份、结构、明细、顺序和哈希，并从明细重算统计。

相同 Execution ID 与相同结果哈希重复导入幂等成功；相同 ID 对应不同结果返回冲突。报告和分析允许分两次导入。

平台 Retry 与离线 `--retry-failed` 使用来源冻结输入创建新 Run/Execution：复制 REST `SUCCEEDED`，重新请求 REST `ERROR`；复制对齐的 Eval `PASS/FAIL`；重新评估 `EVALUATION_ERROR`、缺失 Eval 事实和新 REST 成功后的 `NOT_EVALUATED`。Force 在新身份下重新执行全部 REST/Eval。两者保存来源与每条复用 Hash，重新生成 Result Set Hash，不能覆盖来源。

## 取消与恢复

- P5 取消先持久化请求，再停止派发新 REST Case，并让在途请求被 Abort 或安全收口；跨进程轮询拒绝会立即 Abort 并由 Owner 收敛为受控失败，不产生未处理 Promise。Promptfoo 终止规则在 P6 生效。
- 已真实完成的阶段事实保留；未执行 Case 不生成伪造结果。
- 取消与阶段提交通过条件更新竞争，只允许先成功的一方生效。
- Runtime Shutdown 在 Artifact 写入和阶段提交后重查中断门禁，最终把仍未 `DONE` 的本地 Owner 修正为 `INTERRUPTED/DONE`。
- 进程启动时把遗留 `RUNNING` 收敛为 `INTERRUPTED/DONE`，不自动续跑或推测未知副作用。
- 外部进程、临时文件和临时目录由 Adapter 在资源回收路径中清理。
- REST、Evaluator 和 Analyzer 不自动重试。Promptfoo 取消先发送 `SIGTERM`，5 秒未退出再发送 `SIGKILL`。

## 相关事实入口

- 目标流程来源：[REQ.md](../REQ.md) 与 [TECH.md](../TECH.md)
- 当前 Run 编排：[packages/application/src/features/runs](../packages/application/src/features/runs)
- 当前 REST Adapter：[packages/evaluation-adapters/src](../packages/evaluation-adapters/src)
- 当前 Run Repository：[packages/storage-sqlite/src/sqlite-platform-run-repository.ts](../packages/storage-sqlite/src/sqlite-platform-run-repository.ts)
- 当前 P3–P5 Local API：[apps/local-server/src](../apps/local-server/src)
- 当前 P4–P5 Web：[apps/web/src](../apps/web/src)
- Importer、Evaluation、Reporting 和 Work Package 文件运行时仍未落地。
- [APPLICATION/RUNS.md](APPLICATION/RUNS.md)
- [APPLICATION/EXECUTION_IMPORTS.md](APPLICATION/EXECUTION_IMPORTS.md)
- [PACKAGES/EVALUATION_ADAPTERS.md](PACKAGES/EVALUATION_ADAPTERS.md)
- [PACKAGES/REPORTING.md](PACKAGES/REPORTING.md)
- [PACKAGES/WORK_PACKAGE.md](PACKAGES/WORK_PACKAGE.md)
