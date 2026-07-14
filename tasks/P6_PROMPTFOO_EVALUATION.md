# P6：Promptfoo Evaluation 闭环

## 状态与依赖

- 状态：`COMPLETED`
- 依赖：P5

## 目标

使用 Promptfoo `0.121.18`、预计算 Provider Output 和统一 Evaluator Adapter 完成全部 Assertion 的可验证评估闭环。

## 实现清单

- Promptfoo 主 Provider 只使用 Echo/预计算输出，不重新请求业务 Endpoint。
- 启动仅绑定随机回环端口的 Evaluator Bridge v2；Promptfoo 内置 HTTP Provider 通过当前 Evaluation 调用期 Capability 调用 Bridge。
- Bridge 严格绑定 Run/Execution、Evaluation Context Hash、Evaluator Config Hash、Schema、确定性总调用预算、并发、TTL、超时和取消，不能作为任意转发器；不接收或区分 Assertion、Metric 和组件身份。
- Bridge 只调用冻结的 Gemini/OpenAI-compatible 官方 SDK Adapter；三层显式关闭自动重试。
- 生成配置拒绝 Assertion 内嵌 Provider、OAuth/认证/Secret、外部文件/模块/包和额外依赖；引用协议统一忽略前导空白和大小写。
- Case Assert 构建不设类型白名单；能力矩阵中的全部类型可原样进入受控配置。平台不复现或限制 Assert 原生执行；真实进程只覆盖可信内联 JS/Python/Ruby、Transform、Context Transform、嵌套 Assert Set 等代表性跨执行边界。
- Importer 对齐 Case、Assertion、组件结果，生成 Not Evaluated、Hash 和结构化错误。
- 注册平台 Eval API、Web 和 REST→Eval Pipeline；离线 Eval CLI 统一在 P7 注册。
- 实现平台 `CreateRerunPlan` 选择规则与内部 Application Use Case：复制 REST `SUCCEEDED` 和对齐 Eval `PASS/FAIL`，重试 REST `ERROR`，重新评估 `EVALUATION_ERROR`、缺失 Eval 和新 REST 成功后的 `NOT_EVALUATED`，记录来源/复用 Hash 并生成新 Result Set Hash。Report 终态尚未闭环，本阶段不注册 Retry/Force API 或 Web 入口。

## TDD 与验证

- 数据驱动测试要求能力矩阵每项都能通过同一开放 Case Assert 契约和通用物化路径；不逐类型复现 Promptfoo 执行。Provider/Secret/外部引用拒绝和 Importer 对齐按通用边界与代表性复杂类型验证。
- 真实进程测试 JS/Python/Ruby、解释器缺失、Transform、Context Transform 和嵌套集合。
- 阶段启动前只对 REST 成功、未复用且会进入 Promptfoo 的 Case 运行解释器能力检查；Python 与 Ruby 都必须在当前 macOS ARM64 环境成功执行内联 Assertion，并验证显式环境变量覆盖命令。
- Promptfoo 子进程只继承运行必需环境和解释器选择器；真实内联 JS 测试证明父进程无关 Secret 不可见。
- Bridge 测试非法 Token、错误绑定、超预算、外部 Host、Schema、取消、超时和并发端口；排队请求出队后必须复验 TTL，过期不得调用 Evaluator；超时与关闭必须在 Evaluator 忽略 Abort、永不结束时仍可收口。
- Stub 断言一次评分只触发一次 SDK 调用；日志、临时配置和 Raw Evidence 不得含 Secret。
- Promptfoo 使用独立进程组；TERM 后 5 秒未退出则 KILL 完整进程组。主进程提前退出时仍把剩余 TERM 宽限期留给解释器后代，并验证后代、句柄和临时目录回收。
- Promptfoo 临时目录显式绑定项目 Containment Root；覆盖 Root 外路径、符号链接、逐级 canonical containment 和 owner-only 权限，任何目录变更前先拒绝逃逸。终止测试要求函数返回时进程组已经消失，不使用返回后的轮询掩盖竞态。
- Bridge 创建、配置物化、Promptfoo 版本检查和 Eval 共享一个整体预算；测试要求版本检查已消耗时间从 Eval 剩余时间扣除，Capability TTL 不早于合法进程截止。
- 验证 Eval 并发默认 2、范围 1–16、Bridge/SDK 最大在途数、冻结后不可修改，以及内部重跑用例不修改来源 Run。
- 覆盖来源 Eval Artifact 的 Manifest 缺失、实际文件 `MISSING/CORRUPTED`、连续 Retry 的多代 Provenance Raw 追溯、新 REST 成功后补 Eval、REST 仍失败保持 NOT_EVALUATED、复用 Provenance，以及全复用时仍由目标 Run/Execution 与 Evaluation Context 生成新 Result Set Hash；规划与执行两处都必须校验实际文件。
- 覆盖 Assertion config 嵌套 Provider/OAuth/认证/Secret/模块/依赖、大小写与前导空白外部引用及紧凑组合敏感键绕过拒绝、主进程提前退出时后代保留 TERM 剩余宽限期、Raw Artifact 原生退出码 `0 | 100`、单 Case Eval Hash 排除执行观测与 Artifact 完整性、Provider 400/422 能力错误、Bridge 精确 Host、非协作上游真实并发占槽、非零及缺失 Token Usage、固定 Row Error 闭合结构和矛盾字段拒绝、真实内联执行错误清洗、有界进程诊断、Code-only 持久错误与 Web 消息资源、Capability 输出污染阻断、Evaluation 原子分类计数、Raw/Normalized Artifact Context Hash、Normalized Case 乱序与重复 Key 原子拒绝、冻结完整 Schema Hash 的 P5 002→P6 003 数据库升级、Pipeline Evaluation Starter 返回失败与拒绝 Promise 的自动收口、跨 Stage SSE 补发顺序、Web Assertion Weight/Score/Reason 和 DONE 阶段计数选择。

## Spec 更新

- `spec/PACKAGES/EVALUATION_ADAPTERS.md`
- `spec/PACKAGES/CONTRACTS.md`
- `spec/APPLICATION/RUNS.md`
- `spec/WEB/RUNS.md`
- `spec/TEST.md`

## 完成标准

- 能力矩阵无被 Case Assert 构建或通用物化路径按类型拒绝的条目。
- Promptfoo 不能绕过统一 Evaluator Adapter 或覆盖 Provider。
- Assertion FAIL 与阶段系统失败严格区分。
- 平台重跑选择规则和内部用例完整，Retry/Force 入口等待 P8 终态 Report 闭环后注册。

## 阻塞条件

若 Promptfoo 内置 HTTP Provider 无法满足统一 Bridge 契约，提供最小复现并请求用户调整契约，不新增自定义 Provider 插件绕过决定。

## 已确认契约修正

真实 `0.121.18` 进程最小复现证明共享 Grader 请求不携带稳定 Assertion 身份。不同 Assertion 已由 Promptfoo Raw Result 中的 Metric、完整 Definition 和组件顺序区分，Bridge 无需也不得识别 Assertion。既有单调用 Bridge v1 保持不变；P6 使用新 v2，将 Capability 绑定到当前非持久化 Evaluation 调用期，总调用预算按冻结生成配置中的 Provider-dependent Assertion 实例数确定性派生并进入 Evaluation Context Hash。

平台 Raw/Normalized Eval Artifact、Assertion/Eval/Final/Result Set Hash、Case Metric 去重、Ajv 2020-12 Diff、严格 Importer、SQLite 原子提交/查询、受控 Promptfoo/Bridge/官方 SDK 外部链、REST→Evaluation Pipeline、Eval API/Web/SSE 和内部 Retry/Force Use Case 已闭环。Importer 对齐实际评分 Output、Assertion Set 聚合与子组件，复算集合/Case 原生聚合，支持 `is-json` 的 NONE、STRING/YAML、OBJECT 三种能力，并复现 redteam `guardrails` 当前层语义。内部重跑创建新 Run，跳过已复用 REST/Eval 的外部调用，生成新身份的完整 Artifact/Result Set，并保持来源 Run 不变。

`select-best` 与 `max-score` 的真实多输出语义仍作为锁定版本事实保留，但不再构成平台阻塞：Case 构建和配置生成不按类型拒绝，平台不复制单 REST Output、不伪造候选、不预判适用性；Promptfoo 真实输出统一进入通用对齐规则。用户 Case 与持久定义中的 Provider 仍严格拒绝，系统只配置统一回环 Grading Provider，Capability 只经子进程环境注入且不得落盘。

平台 Run ID 和离线 Execution ID 是执行版本身份；每次重试或 Force 创建新身份。Raw/Normalized Eval Artifact 与 Result Set Hash 是绑定该执行身份、冻结 Evaluator 和契约版本的评估版本，不新增 Attempt 表或历史入口。

SSE 只暴露持久事实可推导的 Evaluation Started/Completed；当前 Promptfoo 批处理没有逐 Case持久进度，因此契约不暴露 `EVALUATION_PROGRESS`。Run 进度、详情和 Web 在执行中显示 Evaluation 完成数 0，原子提交后显示总数、完成数、PASS、FAIL、Error 和 Not Evaluated；Web Evaluation 表显式展示 Case Reason 与 Evaluation Error。
