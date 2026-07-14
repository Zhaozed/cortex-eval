# 内部行为

## 纯粹性与边界校验

外部 `unknown`、JSON 和第三方响应先通过边界 Schema 校验和 Mapper 转换，再进入 Application。Domain 不接收未校验数据，不依赖 Zod、HTTP DTO、数据库类型或第三方协议。

副作用函数通过 Application Port 显式表达。外部 REST、Promptfoo 和 LLM 调用位于事务外，资源写入、输入冻结、阶段提交和结果导入使用短事务。

## 聚合与事务

Test Suite 聚合包含当前 Suite 和 Cases。所有 Case 写入口共用同一写入流程，统一校验 Definition、Prompt 引用、筛选字段和哈希。

全量 Case 导入只把单项保留在内存，逐项写外部 staging 并增量计算 Suite Hash；最终主库事务重新校验 Suite Revision 与 Rubric 引用后整体替换。导出冻结 Revision，并以 `(ordinal,id)` 顺序逐项读取，避免混合版本和完整数组常驻内存。

Run 聚合包含 Run Log、Case Results 和 Eval Results。P5 已实现 Run 冻结、REST 阶段开始、逐 Case进度、Artifact 和最终提交；每一步使用独立条件事务，外部执行不跨事务。

Case Analysis 是独立事实。应用建议时按 Analysis、Suite、Case、Rubric Prompt 的稳定顺序锁定和校验，再调用 Case 写入流程。

## 状态不变量

- 全库最多一条 Run 为 `RUNNING`。
- Run 状态转换同时校验 Status、Stage 和 Lock Revision。
- 终态不能重新进入 `READY` 或 `RUNNING`。
- REST `SUCCEEDED` 必须有合法 Provider Output；REST `ERROR` 必须有规范化错误且无 Provider Output。
- 完整报告要求每个冻结 Case 有一个 Case Result 和一个 Eval Result。
- 未开始 Evaluation 时不创建 Eval Result。
- Analysis 不属于 Run Stage，不修改原 Run Context Hash。
- Run 和 Analysis 的每次可见状态写入都校验调用方 Revision；合法转换递增 Revision，旧 Revision 返回稳定冲突。

## 幂等与身份

Case 业务身份使用测试集内唯一的 `metadata.case_id`，内部 ID 与业务 ID 分离。导入、编辑、分析建议和结果导入不得静默修改 Case ID。

资源、Case、运行上下文、结果集合、最终 Case 结果和分析输入使用规范化 JSON 与 SHA-256 形成身份。第三方随机 ID、绝对路径、Secret 和不稳定 metadata 不进入平台业务哈希。

离线 Execution Context 使用独立 `cortex.execution-context.v1` 哈希输入。输入包含 Package ID、Manifest Hash、Run Execution Limits 和 Analysis Execution Limits；任一限制变化都形成不同 Execution Context Hash。

相同 Package ID、Execution ID、Result Set Hash 与规范化 Artifact Manifest 的导入幂等；相同 Execution ID 对应不同 Package、结果，或 Manifest 的版本、Owner、Kind、路径、Hash、大小、Payload Contract Version 任一不同均冲突。相同 Analysis Input Hash 的分析导入幂等，不同输入按当前分析 Revision 条件更新。

失败重跑和 `--force` 都创建新的 Run/Execution。新身份可以记录来源和复用结果 Hash，但不得修改来源 Run/Execution 或已完成 Artifact。

## 并发与顺序

- SQLite 部分唯一索引和条件更新共同保证唯一运行，进程内锁不作为正确性来源。
- 当前资源使用独立 Revision 防止丢失更新；业务语义 Hash 不承担并发 Token 职责。Case 写入校验 Suite Revision，编辑既有 Case 再校验 Case Revision。
- SQLite 锁竞争只在 Storage 边界重启完整短事务，最多四次；耗尽返回稳定存储冲突。任何外部副作用都不进入该重启范围。
- `READY` 阶段不占用全局运行互斥。
- 取消与阶段提交竞争时只有一个条件更新成功。
- 跨进程取消由持久 Request 和 25–50 毫秒轮询传播；进程内 Abort 只负责降低本地延迟。
- 同一工作包使用跨进程文件锁；不同工作包允许并行。
- 已完成 Execution 和阶段 Artifact 不可覆盖。
- Case Ordinal、Case Key、Assertion Index 和 Definition Hash 用于跨阶段对齐。

## 快照与数据保留

运行冻结当前资源的脱敏快照。冻结后资源修改或删除不影响历史运行。来源资源删除后，历史 Run 可以清空来源 ID，但快照保持完整。

Artifact 预期 Kind、相对路径、Hash、大小和 Contract Version 保存在 Run Artifact Manifest。文件存在性按需校验；Raw 文件缺失或损坏不改变已经落库的规范化结果和报告事实。

真实 Promptfoo Raw 在 Adapter 私有目录中保持文件形态。Adapter 先流式验证版本、完整 JSON、逐 Row/字符串上限和 Capability，再把显式 `openBytes/openRows/dispose` Source 交给 Application；Artifact Store 与 Importer 顺序消费，Application 不接收路径，所有成功与失败路径最终回收 Source。

离线 Evaluation 把 Case/REST、复用 Eval 和新导入 Eval 都按 128 项事务批次写入 owner-only 命令私有 SQLite；异常回滚当前批次，失败命令删除整个 staging。Engine 通过可重放 Source 执行两遍一致性校验并流式生成配置；Raw、缺失结果和最终 Normalized 都逐项处理，Writer 与 Result Set Hasher 从已验证 Manifest 按 Ordinal 查询预期 Case Key，并在结束时确认不存在下一 Case，不保留与 Case 数等长的大对象数组、Map 或 Set。Endpoint、Evaluator 和 Rubric Prompt 在消费时重算文件 Hash 与大小。CLI Abort Signal 在 REST 返回、Artifact 发布及每次 Evaluation 边界消费和最终提交前复核；导出响应提前结束时取消未读 Body。

Run 与离线 Execution 使用同一 `cortex.artifact-manifest.v1` 对象，Owner 联合显式区分 `RUN` 和 `EXECUTION`。P5 REST Artifact 位于 Run ID 专属相对路径；只有数据库或 Execution 状态提交后的 Manifest 才是引用事实。平台与离线 Writer 返回可持久 Descriptor 和非持久发布身份；阶段提交失败只在当前命令同时匹配固定槽位、Descriptor Hash/大小、发布时 device/inode 和清理时稳定身份后删除未登记 Artifact。若目标被替换为不同或相同字节的新 inode，都保留替换对象并报告。启动时发布身份已经丢失，因而只发现、保留并报告未被持久 Manifest 引用的受控文件，不能按路径删除或代替当前命令补偿。

文件可见性提交包含两个事实：目标名称发布成功、父目录同步成功。Link 或 Rename 已发生但目录同步失败时，边界层只撤销设备号/inode 仍匹配刚发布对象的目标；若路径已被并发替换则保留替换对象并报告补偿失败。清理失败通过旁路观察，不改写主错误。

当前资源不保存版本历史。重新分析覆盖同一 Run/Case 当前分析，Revision 只用于并发控制和当前记录演进，不表示可查询历史。

历史 Run 的重跑/复用 Provenance 外键使用删除限制；当前 Suite、Endpoint、Evaluator 来源使用 `SET NULL`，删除后快照、Artifact Manifest 和规范化事实保持。

## Secret 与日志

Secret 统一使用 EnvSecretRef，只在外部调用前从环境展开。数据库、快照、工作包、响应、报告和日志只包含引用名称或脱敏值。

日志记录中文业务事件、安全标识、状态、耗时和 Error Code，不记录完整 Case、Vars、Provider Output、Prompt、Secret 或第三方堆栈。

可信内联 Assertion 使用当前用户权限执行。系统不做代码检测或安全沙箱；边界只拒绝外部脚本文件、额外依赖和 Provider 覆盖。

## 风险边界

绕过 Application 直接写 Repository 会破坏引用、哈希、派生字段和聚合对账。让 Domain 依赖外部协议会污染业务规则。外部调用持有事务会放大锁竞争。工作包覆盖和路径逃逸会破坏 Execution 身份和文件安全。

## 相关模块

- 目标内部约束来源：[TECH.md](../TECH.md)
- 当前 Domain 状态入口：[PACKAGES/DOMAIN.md](PACKAGES/DOMAIN.md)
- 当前 Contracts Snapshot 与 Execution 入口：[PACKAGES/CONTRACTS.md](PACKAGES/CONTRACTS.md)
- 当前 Run 编排入口：[packages/application/src/features/runs](../packages/application/src/features/runs)
- 当前 REST Adapter：[packages/evaluation-adapters/src](../packages/evaluation-adapters/src)
- 当前 Run 竞争与恢复测试：[packages/storage-sqlite/test/sqlite-platform-run-repository.test.ts](../packages/storage-sqlite/test/sqlite-platform-run-repository.test.ts)
- 当前 Application 资源入口：[packages/application/src](../packages/application/src)
- 当前 SQLite 入口：[packages/storage-sqlite/src](../packages/storage-sqlite/src)
- 当前 Work Package 文件运行时：[packages/work-package/src](../packages/work-package/src)
- 当前离线 CLI：[apps/cli/src](../apps/cli/src)
- [PACKAGES/DOMAIN.md](PACKAGES/DOMAIN.md)
- [APPLICATION/OVERVIEW.md](APPLICATION/OVERVIEW.md)
- [PACKAGES/STORAGE_SQLITE.md](PACKAGES/STORAGE_SQLITE.md)
- [PACKAGES/WORK_PACKAGE.md](PACKAGES/WORK_PACKAGE.md)
