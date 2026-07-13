# 测试规范

## 测试目标

测试证明业务不变量、协议边界、存储约束、外部适配、并发恢复和 UI/CLI 行为。测试优先覆盖错误路径、边界、竞争状态和回归风险，不测试 Prompt 具体文案和可变配置值。

## 当前测试入口

- [data_scripts/run_promptfoo_rest.test.ts](../data_scripts/run_promptfoo_rest.test.ts)：REST 模板、并发、续跑、超时和失败隔离。
- [data_scripts/test_convert_loona_to_promptfoo.py](../data_scripts/test_convert_loona_to_promptfoo.py)：原始数据到 Promptfoo Case 的转换规则。
- [packages/contracts/test](../packages/contracts/test)：P1 Schema、版本、Secret、Work Package、Bridge、Snapshot、Artifact、Canonical Export、137 条能力映射和真实 Fixture。
- [packages/domain/test](../packages/domain/test)：P1 纯 Case/Result、状态、Revision、统计、Proposal 和专用哈希输入。
- [packages/application/test](../packages/application/test)：P2–P5 资源用例、统一 Case Writer、Revision、引用、Cursor、导出、Run 冻结/REST/取消和事务外验证。
- [packages/storage-sqlite/test](../packages/storage-sqlite/test)：P2–P5 十表、严格行映射与 Hash 对账、约束、权限、资源/Run 双连接和双进程竞争、Execution 幂等和千级性能。
- [packages/evaluation-adapters/test](../packages/evaluation-adapters/test)：P5 REST 模板、Selector、大小、HTTP、超时、并发和取消。
- [apps/local-server/test](../apps/local-server/test)：P3–P5 资源与 Run API、真实 SQLite 装配、安全入口、OpenAPI、配置 Probe、日志、SSE、Artifact 和流式导入边界。

Vitest、V8 覆盖率和架构测试已在 P0 落地。P2 已把 Application 与 Storage SQLite 纳入覆盖率范围，P3 纳入 Local Server。当前全仓门禁为语句/行 90%、函数 90%、分支 85%；最终门禁仍以本 Goal 全局要求为准。

- [tooling/test](../tooling/test)：Runtime Doctor、Fixture、Secret、文档、架构、能力矩阵、官方 SDK 契约、Promptfoo 真实进程和 Benchmark 测试。
- [vitest.config.ts](../vitest.config.ts)：当前覆盖率范围与阈值。
- [package.json](../package.json)：`pnpm verify` 确定性门禁入口。

## Domain 测试

覆盖 Case、Assertion、Provider Output、Prompt 变量、状态机、统计、Metric 聚合、Canonical Hash、四种分析分类和建议冲突规则。纯规则使用确定输入，不依赖数据库、网络或时间。

## 架构边界测试

冻结唯一依赖图：阻止 Domain 导入外层；阻止 Reporting 导入 Contracts/Application/Infrastructure；阻止 Application 导入 Contracts/Infrastructure；阻止 Contracts 导入 Domain/Reporting/Application；阻止 Web 导入 Domain 与 Storage；阻止 Route 和 CLI 承载业务规则；阻止生产源码引用 Test Support。相同架构入口扫描 `apps`、`packages` 与 `tooling` 的 TypeScript/TSX 源码和测试，单文件超过 1,000 个物理行即失败；应按职责拆分，不通过排除文件绕过。

## SQLite 测试

当前覆盖十表 Migration、外键、唯一约束、索引、删除策略、Case Definition Writer 原子性、真实 SQLite 首/中/末 Case 删除与重排失败回滚、闭合 JSON 键集合、大小写无关字面搜索、唯一运行双进程竞争、Suite/唯一字段/Execution 双连接竞争、Execution ID 幂等导入，以及平台 Run 阶段条件提交、跨进程取消/提交竞争和恢复。

每个数据库测试使用独立临时数据库。并发正确性必须使用独立连接或独立进程验证，不能仅用进程内 Mock 代替。

P2 千级门禁固定生成 1,000 Case；导入同时覆盖全量校验、Hash 与事务写入并限制为 10 秒。组合查询先预热 5 次，再采集 30 个独立样本，nearest-rank p95 不超过 250 毫秒、p99 不超过 500 毫秒；JSON1 必须证明精确成员查询。

## Work Package 测试

覆盖 Manifest 不可变、文件 Hash、Execution 状态、分阶段 Env 校验、原子写入、路径与符号链接逃逸、同包双进程锁、遗留锁恢复、已完成阶段不可覆盖和不同工作包并行。

每个测试使用独立临时目录，结束后验证受控资源回收。

## REST 测试

覆盖 HTTP 状态、网络、超时、解析、Provider Output、模板、Selector、EnvSecretRef、合法 `ok=false`、部分与全部失败、取消和并发限制。

断言传输错误不产生 Provider Output，合法业务失败仍进入评估。外部服务使用明确的本地 Stub，不访问真实生产 Endpoint。

REST、Eval、Analysis 分别验证默认并发 4、2、1，范围 1–64、1–16、1–8，最大在途数、越界拒绝、冻结后不可修改和平台/CLI 一致性。

## Promptfoo 契约测试

覆盖 Promptfoo `0.121.18`、受控配置、Echo Provider、预计算 Provider Output、Rubric Prompt、Assertion 对齐、退出码和真实 Fixture 完整导入。P0 的真实进程测试在隔离副本中执行 4 个当前 REST Case 和原始 18 条 Assertion，验证主 Provider 零调用、本机隔离 Evaluator 调用、Case ID、Assertion 类型顺序和组件数量；子进程测试验证超时后 `SIGTERM` 与 `SIGKILL` 回收。每个探针使用独立 `PROMPTFOO_CONFIG_DIR`，并行测试不共享 Promptfoo 状态。

精确版本能力矩阵的 137 条完全展开契约逐条保存全部合法 Payload 形态、值与阈值必填性、Evaluator/解释器/协议依赖、拒绝边界、合法 Schema Probe、精确运行时代码证据和 Importer 对齐键。测试逐条执行非法 Payload、`file://`、外部模块、Provider 覆盖拒绝以及组件身份映射，并把每个类型精确映射到锁定包处理器；处理器名称即使存在于包内，只要不属于该类型也会失败。布尔 `equals` 和数字数组 `contains-any` 另由真实进程正例固定。P0 真实进程覆盖内联 JavaScript、Python 和 Ruby；P6 必须继续覆盖 Transform、Context Transform、嵌套 Assertion Set 和矩阵中的全部能力，并稳定拒绝 `file://`、外部模块、额外依赖、Assertion Provider 覆盖和 Provider 插件。

Evaluator Bridge 测试 Capability、Run/Execution 绑定、调用预算、取消、超时、端口并发、无自动重试、Secret 脱敏和不能作为任意代理。

原始结果测试必须经过 Importer，不直接把 Promptfoo 内部字段当作平台事实。

## Reporting 测试

覆盖整体统计、By Metric、同 Case 同 Metric 去重、空分母、JSON Schema Diff、Validator 差异、结果对账、JSON Report 和 Markdown Renderer。

Markdown 断言关注结构和事实，不对无关排版做脆弱快照。

## Analysis 测试

覆盖变量白名单、模型错误、输出 Schema、Analysis Input Hash、Revision、四种分类、Proposal 判别联合、当前 Case 漂移和应用冲突。

不测试 Prompt 具体文本和模型生成措辞。模型调用使用结构化 Stub，业务规则不依赖真实模型概率。

## API、CLI 与 Web 测试

API 覆盖 Cursor 分页、字段路径、稳定错误、Host、Origin 和脱敏。CLI 覆盖分阶段、Pipeline、机器输出、导出和导入。Web 覆盖资源管理、搜索过滤、分页、运行刷新恢复、取消、报告和分析修改闭环。

P3 API 当前额外覆盖严格成功响应 DTO、六项 Analysis Prompt 变量、OpenAPI 精确 allowlist/漂移与所有 Route 403、真实 SQLite CRUD、Revision/唯一冲突、无未来 Route、服务关闭 Abort、Case 导入固定 200 MiB 边界与合法数组尾随空白超限不提交、低于 192 MiB RSS 增量、导出响应前冲突及临时文件正常/失败/取消清理。Endpoint/LLM Probe 以 Stub SDK 验证无凭据、无 Redirect、无自动重试、配置超时、双 Provider Thinking/结构输出映射和安全失败分类；真实回环 HTTP 验证 `NONE` 不发送 Authorization。Storage/Runtime 额外覆盖状态根 symlink 启动前不污染外部目录、临时根 symlink 不改动外部条目、未过 TTL 的 owner 初始化窗口，以及 owner/writer 故障注入后的句柄和工作区回收。

入口测试证明协议转换与 Application 契约，不复制 Domain 单元测试组合。

能力必须按阶段注册。OpenAPI、CLI Help、Web 导航和 Dashboard 不得暴露尚未闭环的 Run、Eval、Report 或 Analysis 能力。

P4 把 `apps/web/src` 纳入全仓 V8 覆盖率。组件测试覆盖 API Client、请求/响应身份、编辑 Session Revision、删除确认事实原子性与冲突恢复卸载、路由、表单映射、字段错误、冲突、URL 恢复、Query 失效和资源交互；Playwright 使用真实 SQLite/Application/Local Server 和生产 Vite 产物，覆盖 1440×900、1280×800 Reduced Motion、900px 小屏提示、键盘、焦点、axe 与 CSP。`pnpm verify` 必须运行该 E2E 矩阵。

P5 确定性阶段回归通过 100 个 Vitest 文件、541 项测试；完整 `pnpm verify` 的 V8 覆盖率为 Statements 90.33%、Branches 85.06%、Functions 91.81%、Lines 93.14%。回归覆盖有界 Run 投影、逐 Case 写入不读取完整快照、Artifact 单遍流式写入与等价 Hash、Worker 持久化失败后的 Owner 收口、Shutdown/阶段提交竞态、取消轮询拒绝、闭合业务日志、SSE 成功/错误媒体类型与 Hijack 后读取/异步写错误收口、Web 预检 Abort/A→B→A 迟到响应拒绝、同选择重新预检失败门禁及创建响应身份。生产 Playwright E2E 通过 7 项测试，并通过真实 SQLite、Application、Local Server 与生产 Vite 产物覆盖 REST Run 创建、启动、刷新恢复、Case 明细、Dashboard 和 Suite 聚合；完整 `pnpm verify` 已通过。

## 性能测试

覆盖千级 Case 导入、全量 Hash、常用搜索与组合过滤、REST 进度批量提交、报告聚合和 Markdown 生成。性能门禁使用固定数据规模与环境说明，不断言具体配置参数。

固定 1,000 Case、Node 24、本地磁盘，参考环境至少 4 个逻辑核和 8 GiB 可用内存，不做人工资源限速并记录实际硬件。测试集导入、Work Package 导出、Execution Result 导入分别计时且各不超过 10 秒；查询预热后 p95 不超过 250 毫秒且 p99 不超过 500 毫秒；报告与 Markdown 不超过 5 秒；1440×900 与 1280×800 关键列表页可交互不超过 2.5 秒。测量次数、预热、统计方法和重测规则以 [P10_FINAL_HARDENING.md](../tasks/P10_FINAL_HARDENING.md) 为准。

## 边界与发布测试

- 测试集导入覆盖 `200 MiB-1`、等于和超过 200 MiB。
- REST 请求覆盖 `5 MiB-1`、等于和超过 5 MiB；响应覆盖 `10 MiB-1`、等于和超过 10 MiB。
- Timeout 覆盖 100 毫秒、10 分钟及上下越界。
- `pnpm verify` 运行全部确定性门禁；`pnpm verify:release` 额外运行一次真实 Gemini Rubric 和一次真实 Analyzer，所有层重试为 0。
- Runtime Doctor 验证 Python 3.7+ 和 Ruby 解释器；发布环境必须真实执行两种内联 Assertion，并记录实际命令与版本。
- 当前只对实际运行通过的 macOS ARM64 声明支持。

## 断言模型

- 先断言结构化状态和事实，再断言用户可见映射。
- 错误测试同时断言无非法事实写入、资源已回收和后续 Case 不受污染。
- 并发测试断言最终唯一事实，不依赖执行先后。
- UI 与 CLI 对相同规范化输入必须产生相同统计。
- 所有计数非负且不超过总数，阶段时间不能逆序。

## 禁止方式

- 不通过修改运行时语义满足类型检查。
- 不用 `assert` 代替生产错误处理。
- 不把 Fixture 当作测试结论。
- 不测试 Prompt 文案、Secret 展开值或具体配置值。
- 不只运行最小测试；变更必须运行全部相关测试族。
