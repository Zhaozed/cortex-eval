# 测试规范

## 测试目标

测试证明业务不变量、协议边界、存储约束、外部适配、并发恢复和 UI/CLI 行为。测试优先覆盖错误路径、边界、竞争状态和回归风险，不测试 Prompt 具体文案和可变配置值。

## 当前测试入口

- [data_scripts/test_convert_loona_to_promptfoo.py](../data_scripts/test_convert_loona_to_promptfoo.py)：原始数据到 Promptfoo Case 的转换规则。
- [packages/contracts/test](../packages/contracts/test)：P1 Schema、版本、Secret、Work Package、Bridge、Snapshot、Artifact、Canonical Export、137 条能力映射和真实 Fixture。
- [packages/domain/test](../packages/domain/test)：P1 纯 Case/Result、状态、Revision、统计、Proposal 和专用哈希输入。
- [packages/application/test](../packages/application/test)：资源用例、统一 Case Writer、Revision、引用、Cursor、导出、Run 冻结/REST/Evaluation/Report/取消、Pipeline、严格 Promptfoo Result Importer、对外 Retry/Force 和完整 Execution Report Import。
- [packages/storage-sqlite/test](../packages/storage-sqlite/test)：十表、严格行映射与 Hash 对账、约束、权限、资源/Run 双连接和双进程竞争、Eval/Report 原子提交、完整离线导入、Execution 幂等、统一最近运行、回滚、分页、复用 Provenance 和千级性能。
- [packages/evaluation-adapters/test](../packages/evaluation-adapters/test)：P5 REST 模板、Selector、大小、HTTP、超时、并发和取消；P6 配置物化、固定 Promptfoo 进程、Bridge v2 和双官方 SDK Adapter。
- [packages/reporting/test](../packages/reporting/test)：Ajv 2020-12 Diff、Missing、非法 Schema、Validator 差异、Rate、By Metric、Result Set Hash、对账和 Markdown。
- [apps/local-server/test](../apps/local-server/test)：资源与 Run REST/Evaluation/Report API、真实 SQLite 装配、安全入口、OpenAPI、配置 Probe、日志、SSE、Artifact、完整结果导入和流式导出边界。
- [apps/cli/test](../apps/cli/test)：命令注册、机器输出、Secret Snapshot、真实 REST/Evaluation/Report/Pipeline、结果导入、Retry 和 Force。
- [packages/work-package/test](../packages/work-package/test)：原生安全目录、导出、Execution、Artifact、大小边界、锁、恢复、Retry、严格 Evaluation/Report 读取和 Golden Fixture。

Vitest、V8 覆盖率和架构测试已在 P0 落地。P2 已把 Application 与 Storage SQLite 纳入覆盖率范围，P3 纳入 Local Server。当前全仓门禁为语句/行 90%、函数 90%、分支 85%；最终门禁仍以本 Goal 全局要求为准。

- [tooling/test](../tooling/test)：Runtime Doctor、Fixture、Secret、文档、架构、能力矩阵、官方 SDK 契约、Promptfoo 真实进程和 Benchmark 测试。
- [vitest.config.ts](../vitest.config.ts)：当前覆盖率范围与阈值。
- [package.json](../package.json)：`pnpm verify` 确定性门禁入口。

## Domain 测试

覆盖 Case、Assertion、Provider Output、Prompt 变量、状态机、统计、Metric 聚合、Canonical Hash、四种分析分类和建议冲突规则。纯规则使用确定输入，不依赖数据库、网络或时间。

## 架构边界测试

冻结唯一依赖图：阻止 Domain 导入外层；阻止 Reporting 导入 Contracts/Application/Infrastructure；阻止 Application 导入 Contracts/Infrastructure；阻止 Contracts 导入 Domain/Reporting/Application；阻止 Web 导入 Domain 与 Storage；阻止 Route 和 CLI 承载业务规则；阻止生产源码引用 Test Support。相同架构入口扫描 `apps`、`packages` 与 `tooling` 的 TypeScript/TSX 源码和测试，单文件超过 1,000 个物理行即失败；应按职责拆分，不通过排除文件绕过。

## SQLite 测试

当前覆盖十表 Migration、外键、唯一约束、索引、删除策略、Case Definition Writer 原子性、真实 SQLite 首/中/末 Case 删除与重排失败回滚、闭合 JSON 键集合、大小写无关字面搜索、唯一运行双进程竞争、Suite/唯一字段/Execution 双连接竞争、Execution ID 幂等导入，以及平台 Run 阶段条件提交、跨进程取消/提交竞争和恢复。P6 追加 Eval 完整集合的状态/Revision/取消/REST/Hash/Artifact 对账、失败整批回滚、严格行映射和 REST/Eval Provenance 来源校验。

每个数据库测试使用独立临时数据库。并发正确性必须使用独立连接或独立进程验证，不能仅用进程内 Mock 代替。

P2 千级门禁固定生成 1,000 Case；导入同时覆盖全量校验、Hash 与事务写入并限制为 10 秒。组合查询先预热 5 次，再采集 30 个独立样本，nearest-rank p95 不超过 250 毫秒、p99 不超过 500 毫秒；JSON1 必须证明精确成员查询。

## Work Package 测试

P7 当前覆盖 Manifest 不可变、文件 Hash、Execution 状态、分阶段 Env 校验、原子写入、路径与符号链接逃逸、同包双进程锁、遗留锁恢复、已完成阶段不可覆盖、不同工作包并行、固定项级大小门禁、Retry 证据和严格 Evaluation Result 双遍读取。补充回归证明连续 Retry 的普通严格 Reader 能沿祖先 Raw Evidence 链重新导入；Pipeline 在完整 Evaluation 输入、Prompt 引用或 Runtime 失败时 REST 调用数和 Execution 数均为零；普通 Assert 仍验证固定 Promptfoo 版本；Promptfoo Row 在剩余 Raw 文档尚未到达时即可交付且不聚合完整文件；真实子进程取消映射为 `EVALUATOR_CANCELLED`、CLI 130 且无部分 Artifact；导入幂等比较完整 Artifact Manifest；导出请求前死亡/存活/PID 复用/ownerless staging 恢复；畸形或取消导出流主动取消未读 Body；复用与导入结果的 128 项提交边界和当前批次回滚；Normalized Manifest 身份对齐且无全量 Key Set；Link/Rename 后目录同步失败只撤销身份匹配目标，并发替换对象不被误删；REST 在返回后和发布后取消均收敛为 `REST_CANCELLED`，阶段登记失败或发布后取消在当前命令删除未登记 Artifact；工作包私有码完整归一且不泄漏。

每个测试使用独立临时目录，结束后验证受控资源回收。

## REST 测试

覆盖 HTTP 状态、网络、超时、解析、Provider Output、模板、Selector、EnvSecretRef、合法 `ok=false`、部分与全部失败、取消和并发限制。

断言传输错误不产生 Provider Output，合法业务失败仍进入评估。外部服务使用明确的本地 Stub，不访问真实生产 Endpoint。

REST、Eval、Analysis 分别验证默认并发 4、2、1，范围 1–64、1–16、1–8，最大在途数、越界拒绝、冻结后不可修改和平台/CLI 一致性。

## Promptfoo 契约测试

覆盖 Promptfoo `0.121.18`、受控配置、Echo Provider、预计算 Provider Output、Rubric Prompt、Assertion 对齐、退出码和真实 Fixture 完整导入。P0 的真实进程测试在隔离副本中执行 4 个当前 REST Case 和原始 18 条 Assertion，验证主 Provider 零调用、本机隔离 Evaluator 调用、Case ID、Assertion 类型顺序和组件数量；子进程测试验证超时后的完整进程组回收，并固定主进程先退出时解释器后代仍获得剩余 `SIGTERM` 宽限期，耗尽后才升级 `SIGKILL`。真实内联 JavaScript 证明无关父进程 Secret 不进入 Promptfoo 环境。Python/Ruby 阶段前探测以真实 Promptfoo 内联 Assertion 验证所需解释器。每个探针使用独立 `PROMPTFOO_CONFIG_DIR`，并行测试不共享 Promptfoo 状态。

精确版本能力矩阵的 137 条完全展开契约逐条保存合法 Payload 形态、值与阈值必填性、Evaluator/解释器/协议依赖、拒绝边界、合法 Schema Probe、精确运行时代码证据和 Importer 对齐键。矩阵测试证明全部类型都可通过同一开放 Case Assert 契约和通用物化路径，不建立类型白名单；文件/模块/包/依赖协议、Provider/OAuth/认证/Secret 使用统一递归边界拒绝，并覆盖大小写、前导空白和紧凑组合键绕过，不要求流程逐类型复现 Promptfoo 执行。布尔 `equals`、数字数组 `contains-any`、内联 JavaScript/Python/Ruby、Transform、Context Transform 和嵌套 Assertion Set 使用真实进程代表性验证。

Evaluator Bridge 测试 Capability、Run/Execution 绑定、调用预算、取消、超时、端口并发、无自动重试、Secret 脱敏和不能作为任意代理；超时与主动关闭均使用忽略 Abort、永不结束的 Evaluator 替身证明 Bridge 自身能够收口。真实 Promptfoo 测试同时覆盖 SDK Token Usage 非空精确映射和合法 `null` 时省略 Usage、保留评分结果。

P6 真实最小探针固定：两个具有不同 Metric/Weight、但相同 Rubric 的 `llm-rubric` Assertion 会产生两个有序组件和两个默认 Grading HTTP Provider 请求，请求体不包含稳定 Assertion 身份。Bridge v2 因而只绑定 Evaluation 调用期、冻结上下文、确定性总预算和并发，不接收 Assertion/Metric 身份；Importer 再从 Raw Result 的 Metric、完整 Definition 和组件结构区分结果。覆盖能力矩阵全部 Assert 表示构建不设类型白名单，并不要求平台复现或限制每类 Assert 的 Promptfoo 执行流程。

另一项真实进程探针固定 Assertion Set 的稳定展开及 `select-best`、`max-score` 的多输出比较事实。Case 构建和配置生成不按这些类型拒绝，也不由平台复现或限制 Assert 执行；Importer 只按通用 Case 重复、缺失、组件和 Definition Hash 规则对齐。测试覆盖实际评分 Output 与冻结 REST Output 的 Canonical 对账、完整 Definition Hash、Rubric Prompt 物化身份恢复、集合/Case 聚合、redteam `guardrails`、三种 `is-json` 能力及 REST Error 的 `NOT_EVALUATED`。

原始结果测试必须经过 Importer，不直接把 Promptfoo 内部字段当作平台事实。

## Reporting 测试

当前已覆盖 JSON Schema Diff、Missing、非法 Schema、Validator 差异、整体统计、By Metric、同 Case 同 Metric 唯一性、空分母、Owner/上下文/版本 Hash、结果对账、JSON Report 和 Markdown Renderer。

Markdown 断言关注结构和事实，不对无关排版做脆弱快照。

## Analysis 测试

覆盖变量白名单、模型错误、输出 Schema、Analysis Input Hash、Revision、四种分类、Proposal 判别联合、当前 Case 漂移和应用冲突。

不测试 Prompt 具体文本和模型生成措辞。模型调用使用结构化 Stub，业务规则不依赖真实模型概率。

## API、CLI 与 Web 测试

API 覆盖 Cursor 分页、字段路径、稳定错误、Host、Origin 和脱敏。CLI 当前覆盖 Work Package 导出/校验、REST、Evaluation、Report、REST→Evaluation→Report Pipeline、完整结果导入、机器输出、Retry 和 Force；Analysis 和 Canonical Export 测试按后续阶段注册。Web 覆盖资源管理、Run/Evaluation/Report、Dashboard、平台重跑和离线导入报告；Analysis 等待 P9。

P3 API 当前额外覆盖严格成功响应 DTO、六项 Analysis Prompt 变量、OpenAPI 精确 allowlist/漂移与所有 Route 403、真实 SQLite CRUD、Revision/唯一冲突、无未来 Route、服务关闭 Abort、Case 导入固定 200 MiB 边界与合法数组尾随空白超限不提交、低于 192 MiB RSS 增量、导出响应前冲突及临时文件正常/失败/取消清理。Endpoint/LLM Probe 以 Stub SDK 验证无凭据、无 Redirect、无自动重试、配置超时、双 Provider Thinking/结构输出映射和安全失败分类；真实回环 HTTP 验证 `NONE` 不发送 Authorization。Storage/Runtime 额外覆盖状态根 symlink 启动前不污染外部目录、临时根 symlink 不改动外部条目、未过 TTL 的 owner 初始化窗口，以及 owner/writer 故障注入后的句柄和工作区回收。

入口测试证明协议转换与 Application 契约，不复制 Domain 单元测试组合。

能力必须按阶段注册。OpenAPI、CLI Help、Web 导航和 Dashboard 不得暴露尚未闭环的 Run、Eval、Report 或 Analysis 能力。

P4 把 `apps/web/src` 纳入全仓 V8 覆盖率。组件测试覆盖 API Client、请求/响应身份、编辑 Session Revision、删除确认事实原子性与冲突恢复卸载、路由、表单映射、字段错误、冲突、URL 恢复、Query 失效和资源交互；Playwright 使用真实 SQLite/Application/Local Server 和生产 Vite 产物，覆盖 1440×900、1280×800 Reduced Motion、900px 小屏提示、键盘、焦点、axe 与 CSP。`pnpm verify` 必须运行该 E2E 矩阵。

P5 确定性阶段回归通过 100 个 Vitest 文件、541 项测试；完整 `pnpm verify` 的 V8 覆盖率为 Statements 90.33%、Branches 85.06%、Functions 91.81%、Lines 93.14%。回归覆盖有界 Run 投影、逐 Case 写入不读取完整快照、Artifact 单遍流式写入与等价 Hash、Worker 持久化失败后的 Owner 收口、Shutdown/阶段提交竞态、取消轮询拒绝、闭合业务日志、SSE 成功/错误媒体类型与 Hijack 后读取/异步写错误收口、Web 预检 Abort/A→B→A 迟到响应拒绝、同选择重新预检失败门禁及创建响应身份。生产 Playwright E2E 通过 7 项测试，并通过真实 SQLite、Application、Local Server 与生产 Vite 产物覆盖 REST Run 创建、启动、刷新恢复、Case 明细、Dashboard 和 Suite 聚合；完整 `pnpm verify` 已通过。

P6 确定性阶段回归通过 112 个 Vitest 文件、679 项测试；完整 `pnpm verify` 的 V8 覆盖率为 Statements 90.22%（6794/7530）、Branches 85.23%（4568/5359）、Functions 91.83%（1619/1763）、Lines 93.32%（6303/6754）。回归新增 REST→Evaluation Pipeline、Eval API/Web/SSE、受控 Promptfoo/Bridge/双官方 SDK、严格 Importer、不可变 Raw/Normalized Artifact、原子提交/回滚、取消/Shutdown、内部 Retry/Force 与来源复用对账，并覆盖子进程 Secret/Capability 隔离、Assertion config 紧凑组合敏感键及大小写/前导空白外部引用绕过拒绝、主进程提前退出时后代保留 TERM 剩余宽限期、Raw Artifact 原生退出码 `0 | 100`、单 Case Eval Hash 排除执行观测与 Artifact 完整性、Root 外路径与临时符号链接拒绝、函数返回前完整进程组回收、Normalized Case 乱序/重复 Key 原子拒绝、解释器阶段前 Smoke、来源 Artifact `MISSING/CORRUPTED`、Evaluation 原子分类计数、冻结完整 Schema Hash 的 P5 002→P6 003 数据库升级、Pipeline Starter 返回失败与拒绝 Promise 的自动收口、Bridge 精确 Host、排队后 TTL 复核、非协作上游真实并发占槽及超时/关闭、Promptfoo 版本探测与执行共享总时限、有界诊断输出、固定 Row Error 闭合字段和矛盾字段拒绝、持久 Evaluation Error 仅保存 Code 并在 Web 边界映射消息、缺失 Token Usage、Raw/Normalized Artifact Context Hash、全复用 Retry 的新执行版本 Hash、Web Case/Assertion Reason/Score/Weight、DONE 阶段计数选择和无虚假 Evaluation Progress 事件；生产 Playwright E2E 7 项和 Python 7 项回归通过。P7 完成等价离线闭环后删除了旧 TypeScript REST 运行器及其独立测试入口。

P7 覆盖率门禁通过 160 个 Vitest 文件、943 项测试；V8 覆盖率为 Statements 90.06%（9728/10801）、Branches 85.25%（6239/7318）、Functions 92.30%（2100/2275）、Lines 93.31%（9028/9675）。P7 将 `apps/cli/src` 与 `packages/work-package/src` 全量纳入覆盖率，新增 Work Package 导出/接收/校验、原生安全目录、Execution/Artifact、普通/Retry/Force REST 与 Evaluation、REST→Evaluation Pipeline、严格双遍结果读取、多祖先 Raw 证据链、Golden Package、CLI 机器协议、Raw Row 流式 Source/Importer、完整 Evaluation 写前预检、Manifest 幂等身份、真实取消到 CLI 130、命令私有磁盘 staging、版本身份证明、生产导出崩溃恢复、正式目标保留前缀拒绝、配置消费时 Hash 复核、128 Case 事务边界、Manifest Ordinal 身份校验、有界 Result Set Hasher、完整序列终止校验、并发替换保护、发布后同步失败补偿、未登记 REST/Evaluation Artifact 同命令按完整 Descriptor 清理、替换文件保留、REST 最终提交取消、导出 Body 回收、主错误保真、JSON 参数错误与 SDK 禁用重试契约回归。覆盖率运行固定最多 3 个 Vitest Worker，隔离真实 Promptfoo、SQLite 与 HTTP 集成负载；真实 Run API 的 3 秒窗口、测试超时、覆盖率阈值和性能阈值不变。

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
