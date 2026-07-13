# 生效决策

## 事实入口

- 目标产品决策来源：[REQ.md](../REQ.md)
- 目标技术决策来源：[TECH.md](../TECH.md)
- 当前 REST 模块入口：[data_scripts/run_promptfoo_rest.ts](../data_scripts/run_promptfoo_rest.ts)
- 当前转换模块入口：[data_scripts/convert_loona_to_promptfoo.py](../data_scripts/convert_loona_to_promptfoo.py)
- Goal 分阶段方案：[tasks/00_INDEX.md](../tasks/00_INDEX.md)
- P1 Contracts 入口：[packages/contracts/src](../packages/contracts/src)
- P1 Domain 入口：[packages/domain/src](../packages/domain/src)
- P2 Application 入口：[packages/application/src](../packages/application/src)
- P2 SQLite 入口：[packages/storage-sqlite/src](../packages/storage-sqlite/src)
- `apps`、Work Package 文件运行时与 Reporting 入口尚未落地。

## 单文件 SQLite

### 决策

当前平台只使用单文件 SQLite，不同时维护 PostgreSQL 兼容层。

### 原因

本地单用户场景需要低运维、事务和明确约束。未来平台化还需要租户、授权、调度和 Secret 管理，不能简化为替换连接。

### 代码影响

Storage 使用 Kysely 与 better-sqlite3，只实现 SQLite Schema、Migration 和 Repository。

### 测试影响

测试覆盖 Migration、约束、双进程竞争和导出对账。

### 排障影响

从 SQLite 状态、Migration 和 Repository 日志进入。

### 状态

生效。

## 模块化单体与单向依赖

### 决策

系统使用 TypeScript pnpm Workspace 模块化单体。Domain 为最内层；Reporting 只依赖 Domain 和纯计算库；Application 只依赖 Domain、Reporting 和自身 Port；Contracts 不依赖核心层；Mapper 才能同时依赖 Contracts 与核心类型；Infrastructure 实现 Port，Entrypoint 负责装配。

### 原因

UI、API 和 CLI 必须复用业务规则，同时保持 Domain 纯粹和外部副作用可替换。

### 代码影响

代码按 `apps` 与 `packages` 划分并保持上述唯一依赖图。Application 和 Reporting 禁止导入 Contracts，Domain 禁止导入所有外层。

### 测试影响

架构测试逐边验证 Domain、Reporting、Application、Contracts、Infrastructure 和 Entrypoint 的允许依赖，阻止入口层业务逻辑。

### 排障影响

先区分协议、用例、规则和 Adapter 层。

### 状态

生效。

## 十张业务表

### 决策

平台使用十张职责明确的业务表，不建立资源版本、Attempt、Job、Artifact 或 Prompt 关联历史表。

### 原因

当前系统只保存当前资源与独立运行快照，不需要历史编辑审计和持久任务队列。

### 代码影响

Migration 与 Repository 维护十表边界，并发 Revision 只防覆盖。

### 测试影响

测试覆盖表间约束、删除策略和无历史语义。

### 排障影响

从承担对应主事实的表和 Repository 进入，不查找不存在的历史表。

### 状态

生效。

## REST 与 Eval 分离

### 决策

REST Result 和 Eval Result 分表、分阶段保存，合法业务 `ok=false` 仍属于 REST 成功。

### 原因

传输事实与评估事实语义不同，部分 REST 错误不能阻止成功 Case 评估。

### 代码影响

Case Result 与 Eval Result 使用不同状态、写入路径和持久化事实。

### 测试影响

分别覆盖 REST Error、Eval Error 和 Not Evaluated。

### 排障影响

先判断传输阶段还是评估阶段。

### 状态

生效。

## Promptfoo 外部执行器

### 决策

Promptfoo 使用锁定版本的 CLI 和受控配置执行，不作为业务数据库、平台 UI 或最终事实源。

### 原因

平台需要稳定契约，不能依赖未承诺稳定的内部 API 和原始输出结构。

### 代码影响

Adapter 校验版本并通过 Importer 生成规范化事实。

### 测试影响

测试覆盖真实 Fixture、退出码和组件对齐。

### 排障影响

Raw Evidence 只用于定位外部执行与导入问题。

### 状态

生效。

## 不可变离线工作包

### 决策

CLI 使用不可变输入 Manifest 和独立 Execution，不直接访问平台 SQLite，不允许覆盖已完成阶段。

### 原因

离线运行需要可校验身份、并发安全和可重复导入，同时隔离平台存储。

### 代码影响

工作包保存 Hash、Env Key、跨进程锁和原子 Artifact。

### 测试影响

测试覆盖路径逃逸、同包竞争、幂等和冲突。

### 排障影响

从 Manifest、Execution 状态和文件 Hash 进入。

### 状态

生效。

## Secret 只使用环境引用

### 决策

Endpoint、Evaluator 和 Analyzer 的 Secret 统一使用 EnvSecretRef，工作包只包含 `.env.example` 和 Key 名称。

### 原因

数据库、导出文件、快照、日志和响应不得泄露展开 Secret。

### 代码影响

边界拒绝敏感 Literal 和 Options 字段，只在外部调用前展开引用。

### 测试影响

安全测试扫描数据库、文件、日志、快照和响应。

### 排障影响

只显示 Env Key 引用名称，不输出 Secret 值。

### 状态

生效。

## 报告事实与派生物分离

### 决策

Raw Promptfoo、Normalized Eval、JSON Report 和 Markdown Report 分离。JSON 是规范化事实，Markdown 是单向派生物。

### 原因

统计和导入需要可验证结构，展示文本不能反向成为业务事实。

### 代码影响

Reporting 从规范化明细重算并对账，Markdown Renderer 只接收 Report DTO。

### 测试影响

测试覆盖明细、JSON 与 Markdown 的事实一致性。

### 排障影响

使用 Raw、Normalized、Report 各层 Hash 定位差异。

### 状态

生效。

## Case Analysis 独立事实

### 决策

Case Analysis Prompt 单独保存，分析位于报告之后，不属于 Run Stage；重新分析覆盖当前记录。

### 原因

分析使用独立 Analyzer 与 Prompt，且失败不应影响完整报告。

### 代码影响

分析使用独立输入身份与 Revision，并通过 Application 协调 Case 写入。

### 测试影响

测试覆盖四种分类、输出 Schema 和过期建议冲突。

### 排障影响

从当前 Analysis、Input Hash 和 Final Case Result Hash 进入。

### 状态

生效。

## 单运行与单工作包写者

### 决策

同一时刻只有一个平台阶段处于 `RUNNING`，同一工作包只有一个 CLI 写进程。

### 原因

当前单用户系统需要明确执行身份和低复杂度一致性，不需要队列和分布式锁。

### 代码影响

SQLite 使用部分唯一索引与条件更新，工作包使用跨进程文件锁。

### 测试影响

测试覆盖平台与工作包双进程竞争、取消竞争和恢复。

### 排障影响

检查 Run 条件状态、Lock Revision 或工作包锁记录。

### 状态

生效。

## 参数等价分析

### 决策

`PARAMETER_VARIANCE` 表示单次结果中的工具参数语义等价，不自动重复执行 Case 做统计判断。

### 原因

当前需求是解释参数表达差异，不是评估随机性分布。

### 代码影响

分析 Prompt、输出契约和 UI 说明保持语义等价含义。

### 测试影响

测试断言分类来自单次规范化结果，不触发重复执行。

### 排障影响

不得把该分类解释为多次采样或统计波动结论。

### 状态

生效。

## macOS ARM64 单平台

### 决策

当前只支持并验证 macOS ARM64，固定 Node.js 24 LTS。Linux、Windows、x64、Docker、安装器和桌面封装不在当前范围。

### 原因

当前开发与验收环境只有 macOS ARM64，不对未真实执行的平台声明支持。

### 代码影响

运行数据位于项目根 `.cortex-eval/`，构建、原生依赖、文件锁、进程信号和测试只承诺当前平台。

### 测试影响

`pnpm verify:release` 记录 OS、芯片、Node、pnpm、SQLite 和 Promptfoo 实际版本。

### 排障影响

其他平台问题不属于当前回归，不得声称已经验证。

### 状态

生效。

## 双 Provider 统一接口

### 决策

Evaluator 和 Analyzer 只支持 `GOOGLE_GEMINI` 与 `OPENAI_COMPATIBLE`。OpenAI-compatible 只表示 Chat Completions。两者统一公开 Model、Thinking Level、Temperature、Top P、Max Output Tokens 和 Timeout。

### 原因

业务需要 Gemini 和广泛兼容的 Chat Completions，同时必须避免任意 Provider 参数污染核心契约。

### 代码影响

Adapter 使用官方 Gemini 与 OpenAI SDK。远程 OpenAI-compatible 必须 HTTPS 与 Bearer EnvSecretRef；本地回环可无认证。所有层关闭自动重试。

### 测试影响

协议 Stub 验证统一映射、结构输出、能力错误、Secret 脱敏和单次调用；发布门禁执行两条单次真实 Gemini 测试。

### 排障影响

先区分统一配置、Provider 能力、SDK 协议和外部网络，不自动切换或降级。

### 状态

生效。

## 全 Promptfoo Assertion 默认可信

### 决策

支持 Promptfoo `0.121.18` 能力矩阵中的全部内置 Assertion，包括可信内联 JavaScript、Python、Ruby、Transform、Context Transform 和嵌套 Assertion Set。系统不检测、不提示、不标记、不沙箱。

### 原因

测试集由本机用户提供并默认可信，需要保留 Promptfoo 的完整 Assertion 表达能力。

### 代码影响

边界仍拒绝 `file://` 外部代码、外部模块、额外 npm/pip 依赖、Assertion 内嵌 Provider 和 Provider 插件。需要 Provider 的 Assertion 统一使用 Run Evaluator。

### 测试影响

精确版本能力矩阵中的每个类型必须有正例、非法 Payload 或能力错误和 Importer 对齐测试；内联语言与 Transform 使用真实进程测试。

### 排障影响

内联代码错误属于可信测试定义或解释器依赖错误，不按恶意输入检测处理。

### 状态

生效。

## Evaluator Bridge

### 决策

Promptfoo 主 Provider 使用预计算输出。Provider-dependent Assertion 通过仅绑定随机回环端口的临时 Evaluator Bridge 调用统一官方 SDK Adapter。

### 原因

必须同时保持预计算 Provider Output、统一 Evaluator、禁止 Assertion Provider 覆盖和不新增自定义 Provider 插件。

### 代码影响

Bridge 使用一次性 Capability、Run/Execution 绑定、Schema、调用预算、并发、超时和取消，只能访问冻结 Evaluator，不能代理任意 URL、Provider、Model、Header 或 Secret。

### 测试影响

覆盖非法 Capability、错误绑定、超预算、端口并发、取消、资源回收、无重试和无法作为通用代理。

### 排障影响

按 Promptfoo HTTP Provider、Bridge、统一 Adapter、官方 SDK 四层定位。

### 状态

生效。

## POST Endpoint 与新身份重跑

### 决策

Endpoint 只支持 POST 且不自动重试。失败重跑与 `--force` 始终创建新 Run/Execution，不覆盖来源。

### 原因

POST 可能有未知副作用，一个 Run/Execution ID 必须始终对应一组不可变结果。

### 代码影响

平台 Retry 与离线 `--retry-failed` 复制 REST `SUCCEEDED` 和与其对齐的 Eval `PASS/FAIL`，重新执行 REST `ERROR`、`EVALUATION_ERROR`、缺失 Eval 事实和新 REST 成功后的 `NOT_EVALUATED`；REST 仍失败时保持 Not Evaluated。Force 全量重跑。

### 测试影响

测试来源 Hash、复用 Provenance、来源缺少 Eval Artifact、新 REST 成功后补 Eval、合法 `ok=false` 不重跑、已完成 Artifact 不覆盖和新 Result Set Hash。

### 排障影响

从来源 Run/Execution、复用事实和新 Run/Execution 的阶段结果分别定位。

### 状态

生效。

## Endpoint 模板选择器

### 决策

Endpoint URL 模板只支持可组合的 `vars.name`、`vars["任意 JSON 键"]` 和 `vars.items[0]` 选择器。字符串键使用 JSON 字符串转义，数组索引使用非负十进制整数；不接受运算、函数、任意表达式或残留模板。

### 原因

需要覆盖任意层级 JSON 标量叶子，同时让语法可静态验证，避免把表达式解析和 Secret 风险推迟到 Adapter。

### 代码影响

Contracts 在解析 URL 前验证选择器语法、固定 Authority、HTTP/HTTPS、敏感 Query 参数名、User Info 和 Fragment。Adapter 只读取已验证路径并对单个 URL 组件编码。

### 测试影响

测试覆盖普通键、任意 JSON 键、数组索引、嵌套组合、残留模板、表达式、动态 Host 和敏感 Query 名。

### 排障影响

先区分选择器语法、变量缺失、非标量值和 URL 约束，不执行或猜测非法表达式。

### 状态

生效。

## Work Package v1 提前冻结

### 决策

完整 Work Package v1 在 Contracts 阶段冻结，首版即包含 Analyzer、Analysis Prompt、全部阶段 Env Key、依赖图和 Artifact 槽位。

### 原因

P7 导出的不可变工作包必须能由后续 Report/Analysis 能力继续执行，不能在同一 v1 内修改 Manifest。

### 代码影响

阶段能力注册只控制入口是否可执行。Manifest 输入路径和 Rubric Prompt Key 唯一；Execution 校验固定阶段依赖与 Artifact 槽位。版本化 Execution Context Hash 输入包含 Package ID、Manifest Hash 和两类执行限制。P7 提交 Golden Package，P8/P9 只增加 Writer、Importer 和入口注册。

### 测试影响

P9 必须使用 P7 Golden Package 完成 Report/Analysis 和导入，不得重导出或修改 Manifest。

### 排障影响

先检查 Schema Version、Golden Hash、能力注册和 Artifact 追加状态。

### 状态

生效。

## 版本化执行限制

### 决策

REST/Eval 并发使用 `RunExecutionLimitsV1`，Analysis 并发使用独立 `AnalysisExecutionLimitsV1`。平台和离线执行共享默认值、范围与冻结语义。

### 原因

并发必须能由 API/CLI 设置、进入执行身份并在运行期间保持不可变，不能散落在 Endpoint、LLM 或进程参数中。

### 代码影响

平台 Create Run 冻结 REST/Eval 限制到 Run Snapshot 与 Context Hash；平台 Analysis 请求独立冻结 Analysis 限制。Work Package Manifest 保存默认值与范围，Create Execution 把选择值冻结到 Execution JSON 与 Hash。

### 测试影响

分别覆盖默认值、上下界、越界拒绝、最大在途数、冻结后不可修改和平台/CLI 一致性。

### 排障影响

从 Run Snapshot、Analysis Input 或 Execution JSON 的版本化限制进入，不从当前配置猜测。

### 状态

生效。

## 简体中文桌面 Web

### 决策

Web 使用简体中文、浅色本地实验室仪表台视觉，正式支持宽度不低于 1024px，并满足 WCAG 2.2 AA。完整移动端和深色主题不在范围。

### 原因

千级 Case 表格、JSON 编辑、报告 Diff 和分析闭环面向桌面技术用户。

### 代码影响

用户文案外化；导航和 Dashboard 采用 Feature 注册，只展示已实现闭环。

### 测试影响

Playwright 验收 1440×900 与 1280×800、键盘、焦点、错误关联和 Reduced Motion。

### 排障影响

先区分 API 事实、Feature 注册、页面状态和表现问题。

### 状态

生效。

## Node 24 隔离执行与 Promptfoo 探针事实

### 决策

仓库门禁显式使用 Homebrew `node@24`，不链接或覆盖用户全局 Node。Promptfoo 固定版本通过隔离临时目录真实执行；原始 Assertion Fail 退出码 `100` 由 Adapter 映射为目标 CLI 退出码 `1`。

### 原因

仅声明 Engine 不能证明 pnpm、Promptfoo 和子进程实际运行在 Node 24。Promptfoo 退出码与组件结构必须来自固定版本探针，不能凭记忆或自然语言输出推断。

### 代码影响

`pnpm verify` 前置 Node 24 路径并运行 Runtime Doctor。真实 Fixture 不在原路径执行探针，所有临时输入输出在隔离目录创建和回收。Promptfoo 子进程统一设置超时，先发送 `SIGTERM`，宽限期后发送 `SIGKILL`，并等待进程关闭后再回收临时目录。

### 测试影响

测试校验实际 `process.execPath`、Promptfoo 版本、主 Provider 与隔离 Evaluator 请求计数、退出码、真实 Fixture Case ID、原始 Assertion 类型顺序、18 个组件结果以及 Python/Ruby 内联 Assertion。完整 Runtime Doctor 自身返回 Python/Ruby Smoke 结果，并把显式选择的 `PROMPTFOO_PYTHON`、`PROMPTFOO_RUBY` 原样传给 Smoke 子进程。能力矩阵不再由类型名隐式生成契约，而是逐项保存全部合法 Payload 形态、值与阈值必填性、依赖、拒绝边界、Schema Probe、精确源码证据和 Importer 对齐键；测试对每项实际执行拒绝与映射，把类型精确映射到安装包处理器，并用真实进程固定布尔 `equals` 和数字数组 `contains-any`。

### 排障影响

先检查 Runtime Doctor、固定版本声明、隔离探针错误和原始退出码，再检查 Adapter 映射。

### 状态

生效。

## 当前资源 Revision 与运行语义 Hash 分离

### 决策

Test Suite、Test Case、Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt 分别保存独立 Revision。Revision 覆盖所有可编辑字段并用于条件更新；运行语义 Hash 只覆盖会影响执行或 Prompt 解释的内容。

Suite Hash 包含按 Ordinal 排序的 Case Key、Ordinal 和 Definition Hash。Endpoint Hash 包含完整请求语义；LLM Hash 包含 Provider、统一参数、Secret 引用名称和结构输出能力；Prompt Hash 包含 Kind、Key 和有序 Messages。ID、显示名称、Revision 和时间均不进入这些运行语义 Hash。

### 原因

显示名称变化也必须防止丢失更新，但不能无意义地改变冻结运行身份。把 Revision 与 Hash 混用会在并发控制和执行身份之间制造隐式耦合。

### 代码影响

资源更新、删除和 Prompt Key 修改携带 expected Revision。任何 Case 写入先条件更新 Suite Revision；编辑既有 Case 还校验 Case Revision。

### 测试影响

测试覆盖旧 Revision 冲突、仅改名称、Rubric Key 引用、两连接竞争和 Hash 包含/排除语义。

### 排障影响

编辑冲突检查 Revision；执行身份差异检查对应版本化 Hash，不从二者之一推断另一项。

### 状态

生效。

## Kysely 托管 SQLite 事务与显式项目根

### 决策

当前固定 Kysely `0.29.3`、better-sqlite3 `12.11.1` 和类型 `7.6.13`。只使用 Kysely 托管事务，事务回调可以等待数据库 Promise，但只获得事务绑定 Repository。Storage 必须接收装配层解析的绝对项目根，不读取 `process.cwd()` 或自行搜索项目目录。只对 `SQLITE_BUSY` 与 `SQLITE_BUSY_SNAPSHOT` 最多重启四次完整短事务，耗尽后收敛为 `STORAGE_TRANSACTION_CONFLICT`。

### 原因

Kysely 的事务与 SQLite 查询接口本身返回 Promise；拒绝 Promise 会使 Repository 无法工作。显式项目根避免从子目录启动时写入不同数据库。

### 代码影响

数据库路径固定为 `<projectRoot>/.cortex-eval/db/cortex-eval.sqlite3`。状态目录权限为 `0700`，数据库和 WAL/SHM 为 `0600`。每个连接启用 Foreign Keys、WAL、5 秒 Busy Timeout 和 `synchronous=FULL`。Busy 重启每次创建新的 Kysely 托管事务，不在已失败事务内续跑，也不扩展到外部副作用。不混用 better-sqlite3 事务或手工 `BEGIN/COMMIT`。

### 测试影响

测试覆盖不同 `cwd`、已有过宽权限收敛、每连接 PRAGMA、Kysely Migration 内部表、独立连接真实 `Promise.all` 竞争和独立进程竞争。

### 排障影响

先检查装配层传入的绝对项目根、目录权限、连接 PRAGMA 和 Migration 结果，再检查 Repository。

### 状态

生效。

## 历史 Run Provenance 删除限制

### 决策

`source_run_id` 和 Case/Eval 的复用来源 Run 外键使用 `ON DELETE RESTRICT`；当前 Suite、Endpoint、Evaluator 来源外键使用 `ON DELETE SET NULL`。P2 不提供历史 Run 删除用例。

### 原因

重跑和复用来源必须持续可查询，当前资源则允许在冻结后删除且不影响历史快照。

### 代码影响

当前资源删除后来源 ID 为空，快照、Artifact Manifest 和规范化结果保持；存在 Provenance 链的历史 Run 不能删除。

### 测试影响

测试覆盖历史 Run 删除拒绝、终态当前资源删除、来源 ID 清空和快照/Artifact 事实保留。

### 排障影响

历史删除冲突先检查重跑与复用链；当前资源删除后的运行事实从冻结快照读取。

### 状态

生效。
