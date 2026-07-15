# Domain

## 模块职责

Domain 保存业务实体、值对象、显式状态、纯校验、统计、规范化哈希输入和状态归并规则。它是业务语义与不变量的权威层。

Domain 不依赖 Zod、HTTP DTO、SQLite、文件、网络、Promptfoo 或 LLM SDK，不接收 `unknown`、未校验 JSON 或第三方原始响应。

## 边界与依赖

Domain 位于依赖最内层，不依赖其他业务 Package。Application 调用 Domain 规则，Contracts 和 Infrastructure 通过 Mapper 转换为 Domain 类型。

## 实现状态

P1 已落地纯 Domain Package；P2 补充资源模型与哈希；P5 补充 Run/REST 规则。P6 已补充 Assertion Definition、Eval Result、Eval Result Set 和 Final Case Result 的版本化哈希输入，以及单 Case Metric 去重。

Domain 不执行副作用、不接收 `unknown`，也不依赖 Contracts 或 Zod。P5 的 Application、Repository、Adapter 和入口只消费这些纯规则，未反向进入 Domain。

## 代码事实入口

- [domain-evaluation.ts](../../packages/domain/src/domain-evaluation.ts)：Case、递归 Assertion、Provider Output、REST/Eval 事实不变量。
- [domain-run-state.ts](../../packages/domain/src/domain-run-state.ts)：带 Lock Revision 的 Run 状态机。
- [domain-analysis-state.ts](../../packages/domain/src/domain-analysis-state.ts)：带 Revision 的 Analysis 状态机。
- [domain-analysis.ts](../../packages/domain/src/domain-analysis.ts)：四类分析与 Proposal 纯校验。
- [domain-metrics.ts](../../packages/domain/src/domain-metrics.ts)：Metric 去重、优先级和 Rate。
- [domain-canonical-hash.ts](../../packages/domain/src/domain-canonical-hash.ts)：I-JSON、RFC 8785 与 SHA-256。
- [domain-hash-inputs.ts](../../packages/domain/src/domain-hash-inputs.ts)：Case、Assertion、REST/Eval Result Set、Final Case Result、Run Context 和 Analysis Input 哈希输入。
- [domain-resource-models.ts](../../packages/domain/src/domain-resource-models.ts)：当前资源纯模型、安全校验和 Prompt 引用/变量派生。
- [domain-resource-hashes.ts](../../packages/domain/src/domain-resource-hashes.ts)：资源运行语义哈希。
- [domain-case-projection.ts](../../packages/domain/src/domain-case-projection.ts)：稳定 Case JSON 与筛选投影。

## 当前样例与测试入口

- [loona_promptfoo_tests.json](../../test_suite/current/cases/loona_promptfoo_tests.json)
- [test_convert_loona_to_promptfoo.py](../../data_scripts/test_convert_loona_to_promptfoo.py)
- [domain tests](../../packages/domain/test)：纯规则、错误路径、边界、Revision 竞争、Hash 和联合动作测试。
- [Work Package tests](../../packages/work-package/test)：离线 REST/Eval 对齐与执行版本哈希边界测试。

## 对外接口

Domain 对 Application 暴露强类型实体、值对象和纯函数。返回值使用精确结果联合，错误包含稳定业务类别和事实路径，不包含用户文案。

## 核心事实

Test Suite 保存当前 Cases。`metadata.case_id` 是 Suite 内唯一稳定业务键。Case Definition 不包含 `providerOutput` 或运行 metadata。

Assertion 支持 Promptfoo `0.121.18` 能力矩阵中的全部内置类型。每条 Assertion 具有非空 Type 与 Metric，Weight 不得为负。Domain 只表达结构和业务身份，不解析或执行可信内联 JavaScript、Python、Ruby、Transform 或 Context Transform；外部代码文件、额外依赖和 Provider 覆盖由边界拒绝。

REST 合法 Provider Output 包含业务成功或业务失败联合。HTTP 2xx 且结构合法统一为 REST `SUCCEEDED`；传输或结构错误为 `ERROR`。

Eval Status 为 `PASS`、`FAIL`、`EVALUATION_ERROR` 和 `NOT_EVALUATED`。Run Status、Run Stage、Analysis Status、Decision、Apply Status 和四种分析分类使用穷尽联合类型。Analysis Evidence 是非空结构化值：固定来源、RFC 6901 字段路径或 `null`、非空结论；Domain 不接收字符串兼容格式。

## 状态、事务与幂等

Domain 不开启事务和执行副作用，只校验状态转换是否合法。哈希使用 RFC 8785 Canonical JSON 与 SHA-256。单 Case Eval Result Hash 表示可复用语义，显式排除延迟、Token Usage、Cost 与 Raw Artifact 完整性；Eval Result Set Hash 显式绑定 `RUN/EXECUTION` 身份、Evaluation Context Hash 和有序 Case Hash，因此新执行不能沿用来源集合版本。不存在的第三方事实表示为缺失值，不伪造零、空对象或空字符串。

Metric 聚合优先级为 `FAIL`、`ERROR`、`PASS`、`SKIPPED`、`NOT_EVALUATED`。一条 Case 对同名 Metric 最多贡献一次。Rate 分母为零时结果为空。

## 错误收敛

非法状态、身份冲突、结构不变量和统计对账失败返回显式 Domain Error。Domain 不记录日志，不重试、不补偿、不吞掉错误。

## 观测与验收

Domain 规则必须确定、可穷尽测试且不访问时钟、随机数或环境。任何外层协议变化不得迫使 Domain 接收脏数据或依赖第三方类型。

## 相关测试

当前测试覆盖 Case、Assertion、Provider Output、Run/Analysis 状态机、取消请求、REST/Eval/Analysis Result Hash、执行版本化 Result Set Hash、Metric、Rate、Canonical Hash、结构化 Evidence、四种分析分类、Proposal 联合、Revision 竞争和非法状态。
