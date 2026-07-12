# 错误处理

## 错误原则

Domain 返回结构化错误，不返回用户文案。Contracts 定义稳定 Error Code，Entrypoint 把错误映射为 API、CLI 和 Web 可见消息。中文文案与日志模板从消息资源加载，不在业务逻辑中硬编码。

每个错误路径必须明确事实是否写入、是否重试或补偿、资源如何回收，以及外部调用方最终观察到什么。

## 资源校验错误

外部 JSON、Case、Assertion 结构、Prompt 引用、URL 模板、Header、Body Selector 和 LLM Options 在边界进入核心逻辑前校验。失败时不写入任何资源事实，不执行外部调用，并返回稳定 Error Code 与字段路径。可信内联 Assertion、Transform 和 Context Transform 不做代码安全检测。

全量测试集导入任一 Case 失败时整笔回滚。Rubric 引用不存在、Prompt Key 冲突或禁止字段出现时不做部分提交。

## REST 错误

REST 错误分类为 `TIMEOUT`、`NETWORK`、`HTTP_STATUS`、`RESPONSE_PARSE`、`PROVIDER_OUTPUT_INVALID`、`TEMPLATE_INPUT` 和 `CANCELLED`。

单 Case 错误写入规范化 REST Error，不写 `providerOutput`，不阻止其他 Case。平台阶段不自动重试未知副作用；是否重新执行由新的运行或新的 Execution 表达。

取消后停止派发新请求，在途请求完成、被 Abort 或超时后收口。阶段只保存真实完成事实。

## Promptfoo 错误

Assertion 失败退出码属于 Eval `FAIL`，不是系统错误。进程启动、版本、配置、文件、信号和未知输出结构错误导致当前阶段系统失败。

Importer 遇到重复 Case、错位 Assertion、未知结构或无法确认聚合状态时拒绝完整阶段提交。Raw Promptfoo 文件可以保留为排障证据，但不能直接写入业务事实。

Evaluator Bridge 的 Capability、Run/Execution 绑定、Schema、调用预算、超时或 Provider 能力错误统一为结构化阶段错误。Promptfoo、Bridge 与 SDK 均不自动重试。

## 报告错误

缺少 Case Result、缺少 Eval Result、明细计数不一致、哈希不一致或统计无法重算时，报告对账失败。系统不提交 Summary、Result Set Hash 或伪造的完整报告。

Markdown 渲染错误不改变已经验证的 Report JSON 事实。Markdown 只作为可重新派生的展示产物。

## 分析错误

模型调用失败或输出不满足 Schema 时保存当前 Analysis `ERROR`，Decision 为 `NO_PROPOSAL`，Apply Status 为 `NOT_APPLICABLE`。系统不从不完整文本猜测分类或建议。

建议应用时 Final Result、Revision、Base Definition、目标 Assertion 或 Prompt 引用发生变化，写入 `CONFLICT`，不自动 Rebase、合并或部分修改 Case。

## 工作包与导入错误

版本、路径、Hash、Manifest、Execution、环境变量、锁或 Artifact 校验失败时，不写后续阶段产物。临时文件未完成时不通过原子 Rename 暴露为正式产物。

Raw Artifact 缺失或损坏时保留数据库规范化事实，API、CLI 和 UI 显示 Evidence Missing/Corrupted；报告不得重新依赖 Raw 文件。

相同 Execution ID 对应不同 Result Set Hash 返回 `EXECUTION_RESULT_CONFLICT`。平台从明细重算统计，不信任工作包 Summary；任一身份或对账失败时不提交导入事务。

## 并发、取消与恢复

非法 Run 转换返回 `RUN_STATE_CONFLICT`。阶段抢占失败不伪造 `RUNNING`，提交冲突不覆盖已落库事实。

进程重启时遗留 `RUNNING` 收敛为 `INTERRUPTED/DONE`。系统不自动推测外部副作用或断点续跑。遗留工作包锁只在确认进程不存在且状态可恢复时清理。

## 资源回收与降级

Adapter 在资源回收路径中终止子进程、释放 Abort 资源并清理受控临时目录。清理失败记录中文业务事件和安全路径标识，不记录敏感正文。

部分 REST Error 降级为成功 Case 继续评估；全部 REST Error 降级为完整 Not Evaluated 报告。模型分析失败不影响已经完成的 Run 和 Report。

## 排障入口

- 运行状态、阶段、Error Code 和安全日志。
- Work Package Manifest、Execution 状态和文件 Hash。
- Raw Promptfoo Evidence 的存在性与 Hash。
- 目标错误语义来源：[REQ.md](../REQ.md) 与 [TECH.md](../TECH.md)
- 当前脚本错误处理：[data_scripts/run_promptfoo_rest.ts](../data_scripts/run_promptfoo_rest.ts)
- 当前脚本错误行为测试：[data_scripts/run_promptfoo_rest.test.ts](../data_scripts/run_promptfoo_rest.test.ts)
- 目标 Contracts、Application 与 Adapter 错误入口尚未落地。
