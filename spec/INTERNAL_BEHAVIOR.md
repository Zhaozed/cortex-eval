# 内部行为

## 纯粹性与边界校验

外部 `unknown`、JSON 和第三方响应先通过边界 Schema 校验和 Mapper 转换，再进入 Application。Domain 不接收未校验数据，不依赖 Zod、HTTP DTO、数据库类型或第三方协议。

副作用函数通过 Application Port 显式表达。外部 REST、Promptfoo 和 LLM 调用位于事务外，资源写入、输入冻结、阶段提交和结果导入使用短事务。

## 聚合与事务

Test Suite 聚合包含当前 Suite 和 Cases。所有 Case 写入口共用同一写入流程，统一校验 Definition、Prompt 引用、筛选字段和哈希。

Run 聚合包含 Run Log、Case Results 和 Eval Results。阶段开始、进度和最终提交使用独立条件事务，外部执行不跨事务。

Case Analysis 是独立事实。应用建议时按 Analysis、Suite、Case、Rubric Prompt 的稳定顺序锁定和校验，再调用 Case 写入流程。

## 状态不变量

- 全库最多一条 Run 为 `RUNNING`。
- Run 状态转换同时校验 Status、Stage 和 Lock Revision。
- 终态不能重新进入 `READY` 或 `RUNNING`。
- REST `SUCCEEDED` 必须有合法 Provider Output；REST `ERROR` 必须有规范化错误且无 Provider Output。
- 完整报告要求每个冻结 Case 有一个 Case Result 和一个 Eval Result。
- 未开始 Evaluation 时不创建 Eval Result。
- Analysis 不属于 Run Stage，不修改原 Run Context Hash。

## 幂等与身份

Case 业务身份使用测试集内唯一的 `metadata.case_id`，内部 ID 与业务 ID 分离。导入、编辑、分析建议和结果导入不得静默修改 Case ID。

资源、Case、运行上下文、结果集合、最终 Case 结果和分析输入使用规范化 JSON 与 SHA-256 形成身份。第三方随机 ID、绝对路径、Secret 和不稳定 metadata 不进入平台业务哈希。

相同 Execution ID 与相同 Result Set Hash 的导入幂等；相同 Execution ID 对应不同结果冲突。相同 Analysis Input Hash 的分析导入幂等，不同输入按当前分析 Revision 条件更新。

失败重跑和 `--force` 都创建新的 Run/Execution。新身份可以记录来源和复用结果 Hash，但不得修改来源 Run/Execution 或已完成 Artifact。

## 并发与顺序

- SQLite 部分唯一索引和条件更新共同保证唯一运行，进程内锁不作为正确性来源。
- `READY` 阶段不占用全局运行互斥。
- 取消与阶段提交竞争时只有一个条件更新成功。
- 同一工作包使用跨进程文件锁；不同工作包允许并行。
- 已完成 Execution 和阶段 Artifact 不可覆盖。
- Case Ordinal、Case Key、Assertion Index 和 Definition Hash 用于跨阶段对齐。

## 快照与数据保留

运行冻结当前资源的脱敏快照。冻结后资源修改或删除不影响历史运行。来源资源删除后，历史 Run 可以清空来源 ID，但快照保持完整。

Artifact 预期 Kind、相对路径、Hash、大小和 Contract Version 保存在 Run Artifact Manifest。文件存在性按需校验；Raw 文件缺失或损坏不改变已经落库的规范化结果和报告事实。

当前资源不保存版本历史。重新分析覆盖同一 Run/Case 当前分析，Revision 只用于并发控制和当前记录演进，不表示可查询历史。

## Secret 与日志

Secret 统一使用 EnvSecretRef，只在外部调用前从环境展开。数据库、快照、工作包、响应、报告和日志只包含引用名称或脱敏值。

日志记录中文业务事件、安全标识、状态、耗时和 Error Code，不记录完整 Case、Vars、Provider Output、Prompt、Secret 或第三方堆栈。

可信内联 Assertion 使用当前用户权限执行。系统不做代码检测或安全沙箱；边界只拒绝外部脚本文件、额外依赖和 Provider 覆盖。

## 风险边界

绕过 Application 直接写 Repository 会破坏引用、哈希、派生字段和聚合对账。让 Domain 依赖外部协议会污染业务规则。外部调用持有事务会放大锁竞争。工作包覆盖和路径逃逸会破坏 Execution 身份和文件安全。

## 相关模块

- 目标内部约束来源：[TECH.md](../TECH.md)
- 当前 REST 类型入口：[data_scripts/run_promptfoo_rest_types.ts](../data_scripts/run_promptfoo_rest_types.ts)
- 当前 REST 并发与原子写入入口：[data_scripts/run_promptfoo_rest.ts](../data_scripts/run_promptfoo_rest.ts)
- 当前 REST 竞争与错误测试：[data_scripts/run_promptfoo_rest.test.ts](../data_scripts/run_promptfoo_rest.test.ts)
- 目标 Domain、Application、SQLite 和 Work Package 入口尚未落地。
- [PACKAGES/DOMAIN.md](PACKAGES/DOMAIN.md)
- [APPLICATION/OVERVIEW.md](APPLICATION/OVERVIEW.md)
- [PACKAGES/STORAGE_SQLITE.md](PACKAGES/STORAGE_SQLITE.md)
- [PACKAGES/WORK_PACKAGE.md](PACKAGES/WORK_PACKAGE.md)
