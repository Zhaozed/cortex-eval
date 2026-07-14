# 生效决策

## 事实入口

- 目标产品决策来源：[REQ.md](../REQ.md)
- 目标技术决策来源：[TECH.md](../TECH.md)
- 当前离线 CLI 入口：[apps/cli/src](../apps/cli/src)
- 当前 Work Package 入口：[packages/work-package/src](../packages/work-package/src)
- 当前转换模块入口：[data_scripts/convert_loona_to_promptfoo.py](../data_scripts/convert_loona_to_promptfoo.py)
- Goal 分阶段方案：[tasks/00_INDEX.md](../tasks/00_INDEX.md)
- P1 Contracts 入口：[packages/contracts/src](../packages/contracts/src)
- P1 Domain 入口：[packages/domain/src](../packages/domain/src)
- P2 Application 入口：[packages/application/src](../packages/application/src)
- P2 SQLite 入口：[packages/storage-sqlite/src](../packages/storage-sqlite/src)
- P3 Local Server 入口：[apps/local-server/src](../apps/local-server/src)
- P4 Web 入口：[apps/web/src](../apps/web/src)
- P7 CLI 与 Work Package 已落地；Reporting 完整入口等待 P8。

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

## P6 Assert 构建、Bridge 职责与执行版本

### 决策

Case Assert 构建不设置类型白名单。Promptfoo `0.121.18` 能力矩阵中的全部 Assert 可以进入受控配置；平台不复现、不替代也不限制各类 Assert 的原生执行流程。不同 Assert 的结果由 Promptfoo Raw Result 中的 Metric、完整 Definition 和组件顺序区分。

Bridge v2 只在一次 Evaluation 调用期内把 Provider-dependent Assert 的模型请求转交给冻结 Evaluator。Capability 绑定 Run/Execution、Evaluation Context Hash、Evaluator Config Hash、TTL、并发和确定性总调用预算。Bridge 不接收 Case、Assertion、Metric 或组件身份，不参与评分和聚合。

每个 Run ID 或离线 Execution ID 表示独立执行版本。Retry 和 Force 创建新身份，不覆盖来源。单 Case Eval Result Hash 表示允许 Provenance 复用的语义事实，排除延迟、Token Usage、Cost 和 Raw Artifact Hash/大小等执行观测与完整性；Result Set Hash 显式输入 Run/Execution Owner 和 Evaluation Context Hash。Raw/Normalized Eval Artifact 显式保存同一 Context Hash，与 Result Set Hash 一起表示绑定执行身份、冻结 Evaluator 和契约版本的评估版本；当前不建立 Attempt 历史。

### 原因

真实 Promptfoo Grading 请求不携带稳定 Assertion 身份，而 Raw Result 已保存结果对齐所需事实。把 Assertion 身份或评分职责塞入 Bridge 会重复 Promptfoo 逻辑并制造无法验证的协议。执行与评估都需要不可覆盖身份，才能保证重跑来源、复用 Hash 和历史结果可对账。

### 代码影响

配置物化器不按 Assert 类型拒绝输入，但 Contracts 与物化器使用同一递归安全判定拒绝 Assertion `config` 中的 Provider/OAuth/认证/Secret、模块/依赖字段、紧凑组合敏感键和外部引用。外部引用先忽略前导空白并转小写，覆盖文件、模块、包及 npm/pip 依赖协议。Bridge v2 使用调用期授权、精确回环 Host、FIFO 并发和总预算，排队请求出队后复验关闭状态与 TTL；非空 Token Usage 映射回 Promptfoo 原生计数字段，`null` 保持缺失而不伪造零计数。Bridge 对 Evaluator Promise 与超时/关闭做受控竞速，即使上游忽略 Abort 也先收口 HTTP 与 Owner，并处理迟到 Promise；真实上游 Promise 未结束前继续占用并发槽，关闭监听器后统计仍保留该无法强杀的实际在途调用。Engine 从同一整体预算派生 Bridge TTL 和 Promptfoo 剩余时间，版本检查与 Eval 共享单调截止时间。Importer 负责 Assertion/Metric/组件对齐，只在固定 Row Error 形状闭合后将其与内联解释器执行错误清洗为 `EVALUATION_ERROR`；持久事实只保存进入 Hash 的 Error Code，展示文案由 Web 消息资源解析。Promptfoo 子进程采用最小环境白名单、单次触发的有界诊断闩锁和独立进程组，防止可信内联代码读取父进程无关 Secret、超限后继续累积输出或在取消后遗留解释器；主进程先退出时继续等待解释器后代，并把从首次 TERM 起算的剩余宽限期留给后代清理，耗尽后才 KILL。临时路径绑定显式项目 Root 并逐级拒绝路径/符号链接逃逸，终止返回前确认进程组消失，输出离开临时目录前递归拒绝完整 Capability，污染 Raw 不进入 Application。Normalized Artifact Writer 强制连续 Ordinal，并按已验证 Manifest 的 ordinal→Case Key 身份逐项对齐；唯一性由 Manifest Schema 和 staging `UNIQUE` 共同保证，不再建立随 Case 数增长的第二份内存集合。Evaluation 在抢占 Stage 前只对 REST 成功、未复用且将进入 Promptfoo 的 Case 运行解释器 Smoke。内部 Retry/Force Use Case 创建新 Run，在规划和实际 Evaluation 两处沿 Provenance 验证 Normalized 与真正祖先 Raw Artifact，再按逐 Case Hash 决定复用并重新生成目标完整结果集合；全复用时也用目标 Owner 与本次 Context 生成不同 Result Set Hash。Evaluation 分类计数与完整明细在同一事务原子提交，P6 Migration 不改写 P5 001，只从 002 增量新增分类列与 Provenance 单一来源身份触发器；Pipeline Starter 返回失败或直接拒绝 Promise 时，都只在未变化的交接 Revision 上提交稳定阶段错误。SSE 不暴露没有逐 Case持久事实支撑的 Evaluation Progress，一次轮询跨越多个 Revision/Stage 时，可从同一最新 Revision 按流水线顺序补发全部可证明事件。Web 终态根据已提交 Evaluation 完成事实选择 Evaluation 或 REST 计数，不把 REST 失败伪装成全零 Evaluation。

### 测试影响

契约与真实进程探针覆盖能力矩阵、不同 Metric、嵌套组件、可信内联解释器、嵌套 config、紧凑组合敏感键及大小写/前导空白外部引用绕过拒绝、单 Case Eval Hash 排除执行观测和 Artifact 完整性、父进程 Secret 隔离、诊断输出上限、Root 外路径/临时符号链接拒绝、主进程提前退出时后代保留 TERM 剩余宽限期、函数返回前进程组回收、整体 Deadline、Raw Artifact 原生退出码 `0 | 100`、严格 Row Error、Code-only Evaluation Error、Normalized 乱序/重复 Key 拒绝、非零及缺失 Token Usage 和特殊比较类型；Bridge 测试覆盖授权、绑定、精确 Host、预算、并发、排队 TTL 过期、非协作上游的真实并发占槽及超时/关闭、取消和 Provider 能力错误。重跑测试验证新身份、来源不变、多代 Provenance、Manifest 缺失及实际文件 `MISSING/CORRUPTED` 时不复用，并只执行待补 Case。SQLite 升级测试冻结 P5 002 完整 Schema Hash，证明 001 未漂移且 003 安装新计数与 Provenance 约束。Web 测试覆盖 Case/Assertion 的 Score、Reason、Weight、Evaluation Error 消息资源与 DONE 阶段计数选择；SSE 契约测试拒绝 `EVALUATION_PROGRESS` 并覆盖跨阶段补发顺序。

### 排障影响

Assert 结果错位先检查 Raw Result 的 Metric、Definition 和组件顺序，不向 Bridge 增加身份字段。重跑结果异常先核对来源 Artifact 完整性、Provenance 与 Result Hash，不使用同一 Run ID 覆盖执行。

### 状态

生效；取代 P6 早期关于 Bridge 必须识别 Assertion 以及 `select-best`/`max-score` 构成阻塞的判断。

## P7 Work Package、执行版本与离线 Pipeline

### 决策

Work Package v1 保持 P1 已冻结的完整 Manifest，P8/P9 只能填充既有 Report/Analysis 槽位，不能修改 v1。P7 提交固定 Manifest Hash、无 Secret 的 Golden Fixture，并以该 Fixture 约束后续兼容性。

Work Package 按 UTF-8 原始字节执行固定门禁：Manifest 256 MiB、Execution 4 MiB、每个配置/Prompt/`.env.example` 8 MiB、Canonical Tests 1.25 GiB；单个 Canonical Case、REST Case、Normalized Eval Case、Promptfoo Raw Row 分别为 16/32/32/64 MiB，解码后的 JSON String Token 为 16 MiB。REST、Normalized、Raw 不增加总文件上限，保持流式 Hash/复制/存在性；真实 Promptfoo Raw 在私有目录预校验后以显式可回收 Source 向 Artifact Writer 重放字节、向 Importer 重放 Row，不向 Application 暴露文件路径或完整对象；Raw Retry 只复核登记 Descriptor、Hash 和大小，不重新解析正文。

Run/Execution ID 是每次运行的执行版本；Retry 和 Force 创建新身份。Raw/Normalized Artifact 与 Result Set Hash 是绑定该执行身份和 Evaluation Context 的评估版本。平台导入幂等绑定 Package ID、Execution ID、Result Set Hash 与规范化 Artifact Manifest；Manifest 比较覆盖版本、Owner、Kind、路径、Hash、大小和 Payload Contract Version，不能只用 `select max` 或其他查询推断唯一事实。

P7 `pipeline run` 只注册已经闭环的 REST→Evaluation。Pipeline 在 REST 外部调用和任何 Execution 变更前同时预检两个阶段的 Env、冻结 Case、完整 Evaluator/Rubric Prompt、Case Prompt 引用、固定 Promptfoo 精确版本和实际需要的 Python/Ruby Runtime，并在后续阶段复用同一个冻结 Secret Snapshot；Evaluation 开始前针对实际待评估 Case 再次校验。P8 闭合 Report 后才扩展默认 Pipeline；未来命令在闭环前不出现在 Help 或 OpenAPI。真实 Promptfoo 子进程取消统一收敛为 `EVALUATOR_CANCELLED` 和 CLI 130，阶段不登记部分 Artifact。

Work Package Evaluation 使用命令私有 owner-only SQLite 按 128 Case 批次暂存 Case、REST、可复用 Eval 和新导入 Eval。Engine 只接收可重放 Source，以两遍标量一致性检查和流式配置替代完整 Promptfoo Tests 数组；Raw 逐 Row 导入，最终结果按 Ordinal 直接写出。取消信号贯穿所有阶段边界；已发布但未登记的 Raw/Normalized 固定槽位由当前 Session 立即删除，避免把恢复推迟到下一次启动。Raw Source、staging、未登记 Artifact 或导出 staging 清理失败经脱敏旁路观察器报告，不覆盖主结果或目标冲突。已识别 JSON 命令的参数解析失败仍输出命令级 `COMMAND_ERROR`，文件模块私有错误在 CLI 边界显式归一为公开 Work Package 错误。

固定 Promptfoo 版本探测形成最长 30 秒的进程内证明。只有规范真实路径、设备、inode、大小、纳秒修改时间和纳秒变更时间全部未变时才复用；Local Server 组装期预热证明，Run 前仍重新核对身份。该证明只消除同一已验证二进制的重复 `--version` 进程，不干预 Promptfoo Assert 执行。

### 原因

Manifest 是离线协议身份，随实现阶段变化会让已导出的包失去可验证性。项级门禁可以在物化前拒绝单项资源耗尽，同时保留大集合流式处理；磁盘 staging 避免合法 1.25 GiB Package 因多个全量数组/Map 产生 OOM。执行身份和评估结果身份分离，才能表达每次运行不同、语义事实可复用但集合版本不可覆盖。全 Pipeline 预检避免 REST 已写入后才发现 Evaluation 配置、Prompt、固定 Promptfoo 或解释器不可用；完整 Manifest 身份比较避免同一结果 Hash 掩盖证据文件漂移。短期版本证明把不可变二进制身份与重复进程成本分离，同时保证文件一旦变化就重新验证。

### 代码影响

`packages/work-package` 使用 macOS `openat(O_NOFOLLOW)` 原生边界、0700 目录、0600 文件、稳定 Lock inode、原子发布和 Owner/TTL 恢复。每次 CLI 导出在发起平台请求前扫描目标父目录，只删除超过 TTL 且 Owner 消失、PID 启动身份变化或持续 ownerless 的 staging；存活 Owner 与身份变化中的目录不动，正式目标拒绝 `.cortex-export-*` 恢复保留前缀。导出使用 Manifest-first NDJSON；Execution 只原子追加固定阶段产物。Endpoint、Evaluator 和 Rubric Prompt 在实际消费时重新校验 Manifest 文件 Hash 与大小。Evaluation Result Reader 先完整预检，再在消费时第二次校验 REST/Normalized 语义和 Raw 描述符，复用事实沿 Execution Provenance 追溯最终祖先 Raw，每遍按执行版本只验证一次并缓存最小身份字段，同时重算 Eval、Final Case 与 Owner/Context Result Set Hash。CLI Evaluation staging 使用 Node 内置 SQLite 与受控临时目录；Case/REST、复用结果和 Raw 导入结果都以 128 项事务批次写入，异常只回滚当前批次，命令失败后删除完整 staging。REST/Normalized Writer 与 Result Set Hasher 都通过 Manifest Ordinal 解析身份，结束时确认不存在下一 Case，不保留全量 Case Key Set。不可变 Writer 把可持久 Descriptor 与非持久发布身份分开；未登记 Artifact 只有在固定槽位、Descriptor Hash/大小、发布时设备/inode 和清理时稳定身份均匹配时删除，相同内容的新 inode 也保留。异常退出后身份丢失的孤儿由启动恢复保留并报告。REST 在 Execution 创建前完成输入预检。Promptfoo 进程边界保存并复核短期版本证明，Local Runtime 只做无副作用预热。CLI 当前只注册 package、rest、eval 和 pipeline 命令；旧 TypeScript REST 运行器在等价能力闭合后删除。

### 测试影响

测试覆盖字节边界精确值与加一拒绝、路径/符号链接逃逸、权限、半写、同包多进程单写、不同包并行、锁恢复、阶段不可覆盖、完整 REST/Evaluation 输入与 Runtime 预检先于外部调用和 Execution、普通 Assert 固定 Promptfoo 版本、精确文件身份版本证明、真实 REST Adapter、真实 Promptfoo 取消到 CLI 130、REST 返回后与 Artifact 发布后取消到 `REST_CANCELLED`、取消贯穿预检/Raw/导入/Normalized、清理失败不覆盖主结果、导出请求前死亡/存活/PID 复用/ownerless staging 恢复、畸形或取消响应的未读 Body 回收、正式目标保留前缀拒绝、配置消费时同 inode/同尺寸篡改拒绝、2,048 Case 多批次 staging 重放、128 项提交与当前批次回滚、Raw Row 背压、Manifest Case 身份逐项对齐、有界且拒绝截断前缀的 Result Set Hasher/Normalized Writer、同尺寸不同 inode 替换 Artifact 保留、Retry/Force、连续 Retry 严格读取、新执行 Result Set Hash、Raw 缺失/损坏、双遍严格读取、Package/完整 Manifest 冲突、SQLite 并发幂等和 Golden Manifest Hash。

### 排障影响

文件错误先检查受控路径、Owner、Descriptor、Hash、大小和阶段状态；重跑复用异常再检查来源 Provenance 与 Raw/Normalized 完整性。Pipeline 在写入前失败时检查统一预检；阶段已进入 `ERROR` 时检查对应外部执行或 Artifact 错误，不把两者混为环境输入错误。

### 状态

生效。Golden Manifest Hash 为 `e840ce500481b6f92393b1efe6d9022c1ceebd9fbbeaf713d03c9e2f6ee54178`。

## P4 资源 Web、冲突 Draft 与严格同源静态边界

### 决策

资源 Web 只按闭环 Feature 注册路由、导航和 Dashboard 贡献。Case 结构化/完整 JSON 编辑使用同一 Contracts-valid Draft；资源 Revision 冲突保存本地 Draft，并读取最新 Snapshot 供用户显式重试或替换。写入或冲突待决状态上报应用壳层，由同一离开门禁覆盖编辑容器关闭、Esc、应用导航、浏览器历史和页面卸载。`Navigation.currentEntry.index` 是资源 Web 启动硬能力，缺失时停止挂载全部资源 Feature。Test Suite 详情以 Suite ID 作为组件状态生命周期边界。生产静态资源与 API 同源，脚本 CSP 不允许 `'unsafe-eval'`；Zod JIT 由主模块之前的同源配置关闭。

### 原因

占位导航会把未来能力伪装成当前事实。两个独立 Case 编辑状态会在切换时丢失完整 Assertion。自动覆盖冲突会破坏用户输入。History API 本身不提供未知 State 的遍历方向，缺少绝对索引时猜测恢复会丢失 Draft；因此采用能力检测失败即停止的边界。跨 Suite 复用局部状态会泄漏筛选、Cursor 和编辑器事实。放宽 CSP 只为容纳库的可选 JIT 会扩大本地页面攻击面。

### 代码影响

P4 注册 Dashboard、Test Suite/Case 和四类配置页面；Feature 页面动态加载，并按配置 `kind`、Test Suite ID 重建路由级状态。Case 默认每页 50 条，筛选和 Cursor 历史写入 URL。API Client 严格校验成功与错误响应并传递取消 Signal，Case 创建和更新输入直接使用 Contracts Schema 推导类型。409 统一呈现 Draft/Snapshot 决策；Suite 与配置的保存、删除以及 Case 编辑重试均重新进入原流程，连续冲突每次刷新 Snapshot 与 Revision。Case 编辑的服务端 Snapshot 与可见 Draft 分离，冲突决策前不重挂结构化或完整 JSON 编辑器。若 Case 编辑或条件删除刷新得到稳定 `CASE_NOT_FOUND`，显式联合状态记录 `REMOTE_CASE_DELETED`，不伪造可重试 Revision；编辑流程先禁用详情 Query，再清理精确缓存和刷新聚合，删除流程保留原 Dialog，两者都只允许用户采用删除事实后解除门禁。Case 创建、复制、删除和导入共用带同步单飞锁的恢复流程；配置探测、预览与保存采用同一单飞约束。页面把写入和冲突状态显式汇总给应用壳层；应用壳层为自身 History 条目写入单调位置，拒绝受控导航，并用 `history.go` 恢复被拒绝的前进后退位置，同时注册 `beforeunload` 门禁。第三方或旧版条目没有应用位置时，门禁以 `Navigation.currentEntry.index` 判定遍历方向并恢复原同源位置，避免未知 State 从前进进入时被再次前推。根组件先校验该索引；无效时只显示外部化错误文案，不创建资源 Query 消费者。已提交导航由应用壳层原子解除门禁并写入新位置，页面不能直接覆盖根门禁。Test Suite 删除影响预检单飞、卸载时 Abort，并与页面其他写入口双向互斥，避免一个完成流程误解除另一个 Draft。Case 删除精确移除目标详情，全量导入移除全部 Case 详情，Test Suite 删除移除聚合及全部子 Query，再刷新存活消费者。新建配置默认值直接对应 REQ；Analysis 允许变量从 Contracts 闭合枚举读取。模态操作错误留在当前容器，探测、模板变量和完整 JSON 服务端字段错误聚焦当前编辑器。Rubric 删除引用查询绑定 AbortSignal 和请求代次，迟到结果不能污染新目标。Local Server 只为 P4 路径提供 SPA 回退，未来路径保持 404。fast-json-stringify 编译前移除其不支持的响应 `propertyNames`，但 Route Runtime Schema 与 OpenAPI 保持严格原事实。pnpm Workspace 精确覆盖安装链中的漏洞版本 `ini` 为兼容补丁版 1.3.8，不改变业务依赖或运行时协议。

Case 编辑 Session 由本次成功且身份匹配的详情读取创建，同时冻结 Definition、Case Revision 和 Suite Revision；刷新失败不能用旧 Query data 建立 Session。API Client 在 Schema 通过后使用请求上下文验证器校验所有请求已固定的 Suite、Case、Definition Case ID、配置 ID 与 Kind；错配响应统一为 `CLIENT_RESPONSE_INVALID`，不进入 Query 缓存、不覆盖 Draft、不产生成功状态。Session 建立后不跟随后台缓存变化。远端删除保持原 Session 和编辑器实例，普通冲突显式采用 Snapshot 才创建新 Session。Web 服务端错误码从 `ApiErrorResponseV1Schema` 推导，客户端码闭合列举，不接受任意字符串。Case 非编辑恢复 Hook 统一清洗显式重试的终态错误并回传最近 Revision Facts，owner 清除旧冲突、保留输入并显示错误；Case 编辑重试以单调事件 ID 复用原编辑器的错误映射，避免重复聚焦和未处理 Promise rejection。

Test Suite 详情页把组合过滤、表格动作和 Cursor 历史拆入独立列表面板；详情页测试按列表/编辑、Case 写操作、Suite 生命周期拆分并共享事实夹具。架构门禁扫描 `apps`、`packages` 与 `tooling` 下的 TypeScript/TSX 源码和测试，单文件最多 1,000 个物理行，防止职责再次聚合为巨型文件。

Suite 元数据编辑不再从实时 Query 读取普通保存 Revision，而是把打开或显式采用 Snapshot 时的 Revision 与表单一起冻结。Suite 删除确认使用显式 `{ suiteSnapshot, impact }` 联合事实：预检前冻结 Suite，Impact 成功后才发布；409 刷新先 Suite 后 Impact，二者成功后才同步缓存和替换确认事实。恢复 Controller 与 mounted 门禁共同阻止卸载后的迟到 Suite 继续触发 Impact 或同步 Query。该顺序利用条件删除保证并发安全，不扩展 P3 Impact DTO 或 OpenAPI。

### 测试影响

组件测试覆盖 DTO 映射、请求/响应身份、Session Revision、删除确认事实原子性、默认值、允许变量、字段错误、删除/导入缓存移除、URL 恢复、连续冲突、可见 Draft、删除冲突、写操作单飞、引用乱序、冲突两种决策和失败不误关闭。Playwright 在真实 SQLite/API 与生产构建上覆盖资源 CRUD、导入导出、组合过滤、分页刷新、双编辑器、四类配置、键盘、axe、CSP、Reduced Motion 和目标尺寸。Web 源码纳入原全仓覆盖率阈值，源码尺寸边界由真实仓库扫描回归固定。

### 排障影响

页面缺失先核对 Feature 注册、Local Server SPA 路径和生产 `dist`。保存冲突先核对 Draft、最新 Snapshot 与 Revision，不通过自动重试或覆盖解决。CSP 错误先检查同源静态配置加载顺序，不加入 `'unsafe-eval'`。

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

Adapter 使用官方 Gemini 与 OpenAI SDK。OpenAI-compatible Thinking 映射到 Chat Completions `reasoning_effort: none | low | medium | high`；Provider 以 400/422 拒绝统一能力参数时返回 `CAPABILITY_UNSUPPORTED`。远程 OpenAI-compatible 必须 HTTPS 与 Bearer EnvSecretRef；本地回环可无认证，无认证通过 SDK 的显式空 Header 覆盖保证不发送 `Authorization`，不得发送伪 Bearer。所有层关闭自动重试。

### 测试影响

协议 Stub 验证统一映射、结构输出、能力错误、Secret 脱敏和单次调用；真实回环 HTTP 验证无认证 Header，发布门禁执行两条单次真实 Gemini 测试。

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

精确版本能力矩阵中的每个类型必须能通过同一开放 Case Assert 契约和通用物化路径，不按类型建立白名单；非法 Provider/Secret/外部引用使用统一边界测试，内联语言、Transform、Context Transform 与嵌套集合使用代表性真实进程测试。

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

## Evaluator Bridge v2 调用期授权与断言身份边界

### 当前事实

锁定 Promptfoo `0.121.18` 的真实最小探针表明：两个具有不同 Metric/Weight、但相同 Rubric 的 `llm-rubric` Assertion 会生成两个有序组件并分别调用默认 Grading HTTP Provider，但两次请求体逐字节相同，且没有 `callId`、Capability、Run/Execution 绑定、Case Key 或 Assertion Index。

### 决策

Bridge 不承担 Assertion 身份。既有单次调用 Bridge v1 保持不变；P6 新增 v2，将 Capability 绑定一次非持久化 Evaluation 调用期、Run/Execution、Evaluation Context Hash、Evaluator Config Hash、TTL、并发和按生成配置确定性派生的总调用预算。Bridge 不接收 Case、Assertion、Metric 或组件身份，也不参与 Promptfoo 评分聚合。

### 原因

Assertion 的区分事实已存在于 Promptfoo Raw Result 的 Metric、完整 Definition 和组件结构；把不存在于 Grader 请求中的身份强塞给 Bridge 会迫使系统猜测请求顺序并干预 Promptfoo 执行。调用期总预算足以限制冻结 Evaluator 的外部调用面，同时保留 Promptfoo 原生执行。

### 代码与测试影响

系统只在受控临时 Promptfoo 配置的共享 Grading Provider 中配置随机回环 Bridge；用户输入和持久化 Assertion Definition 仍不能提供 Provider、Secret、外部模块或额外依赖。Capability 仅经子进程环境注入。测试覆盖预算、FIFO 并发、错误绑定、TTL、超时、取消、无重试和无 Assertion 身份字段。

### 状态

生效，替代原“每个 Assertion 一次性 Capability”假设。

## Promptfoo Importer 展开对齐、字符串 Schema 与比较输出边界

### 决策

Importer 对普通组件规范化完整 Assertion Definition 并比较 Definition Hash，不以 Type、Metric、Weight 三元组代替身份。Promptfoo `assert-set` 按固定版本真实输出解释为“集合聚合组件 + 有序子组件”，同时核对子组件副本、完整子 Definition、Weight、Threshold、集合加权分数和 Case 加权分数。

`select-best` 与 `max-score` 不参与普通 Assertion 批次，而是在比较阶段追加，并可能产生共享同一个 `case_id` 的多条行。Case 构建和配置生成不按类型设置白名单或拒绝规则；平台不复制单 REST Output、不伪造候选，也不复现或限制 Assert 执行。Importer 仅按通用重复、缺失、组件和 Definition Hash 对齐规则接收或拒绝实际结构。

`guardrails` 在 `config.purpose=redteam` 且组件失败时，会在其所在 `AssertionsResult` 聚合层最后覆盖 Threshold 并强制 Pass；该覆盖不跨越 Assertion Set 自动传播到外层 Case。Importer 逐层复现，不把普通失败误判为系统错误。

`is-json` 的 NONE 形态使用空 Schema 解释已解析 JSON；STRING 形态使用与 Promptfoo `0.121.18` 相同的 `js-yaml 5.2.0` 解析后清洗为 JSON Schema；OBJECT 形态直接使用冻结结构。三种形态最终都由 Reporting 的锁定 Ajv 对账，Validator 不一致时拒绝导入。

### 原因

固定版本会把 Assertion Set 聚合与子结果一起展开，并对 redteam Guardrail 使用特殊聚合覆盖；能力矩阵同时允许 `is-json` 的 NONE、STRING、OBJECT。只按顶层数量或局部字段处理会错误绑定冻结定义；按类型预判比较行为同样会越界干预 Promptfoo。

### 代码影响

Application Importer 负责脏数据清洗、YAML Schema 解析、受控 Rubric Prompt 身份恢复、完整 Definition Hash 对齐和原生聚合复算；重复、缺失或无法对齐的结构返回通用错误，不使用 Assertion 类型拒绝分支。Domain 与 Reporting 继续只接收已验证 JSON 和强类型事实。

### 测试影响

覆盖同 Type/Metric/Weight 但 Value 不同的错位拒绝、NONE/STRING/OBJECT Schema、真实 Assertion Set 展开、真实比较多行与阶段顺序事实、比较输出模型拒绝、redteam Guardrail 覆盖、集合聚合篡改拒绝和 REST Error 时子 Metric 的 `NOT_EVALUATED`。

### 状态

Assertion Set、Schema 和 Guardrail 规则生效；比较输出模型阻塞，等待 Case/Result 契约显式扩展。

## Eval 原子提交与复用来源对账

### 决策

平台 Eval 只接受完整、有序的规范化 Case 集合。Importer 必须把 Promptfoo v3 `response.output` 清洗为 JSON 后与冻结 REST Provider Output 做 Canonical 对账，不能只依赖 `case_id` 和 Assertion 元数据。SQLite 提交边界在一个短事务中复算 Eval、Final 和 Result Set Hash，对齐冻结 REST 状态、Raw Evidence Artifact、Run Revision、取消事实和 Case 顺序；全部通过后整体写入并推进到 `READY/REPORT`，任一不一致整批回滚。

Eval 提交输入只包含 Raw/Normalized Eval Artifact 描述。Repository 从当前 Run 读取并严格验证既有 REST Manifest，再按稳定顺序追加两条 Eval 描述；调用方不能覆盖或删除 REST Artifact 事实。

`RETRY_FAILED` 的纯内部选择器固定四类逐 Case 动作：复用 REST/Eval、复用 REST 后重评、重试 REST 后评估、Force 全量执行。REST/Eval Provenance 必须且只能选择一个来源身份。平台 Repository 只接受目标 Run 声明的来源 Run 中真实存在、同 Case、同状态和同语义 Hash 的事实；Eval 复用还必须与目标已复用 REST 对齐。REST Artifact 必须保留 Provenance，不得在文件边界清空来源。

### 原因

Hash 和 Provenance 是重跑不可变性的证据，不能只依赖 Application 调用方自报。完整 Eval 集合会同时改变明细、计数、Manifest 和阶段，必须由同一事务提交，避免部分结果或伪造来源进入 Reporting。

### 代码影响

Application 定义平台 Eval 模型、提交/查询 Port 和纯重跑选择器；Storage SQLite 实现严格映射、来源对账和原子提交。当前只闭合内部基础，不创建新重跑 Run，不跳过外部执行，也不注册 Evaluation 或 Retry/Force API、OpenAPI、CLI、Web。

### 测试影响

覆盖 Promptfoo 实际 Output 错配、Eval 成功提交、状态/Revision/取消、语义 Hash、Final Hash、Result Set Hash、REST 状态、REST Manifest 保留、Artifact/Evidence、整批回滚、严格行映射、REST/Eval 来源 Run 与 Hash、Provenance 异或约束、Artifact 来源保留，以及 Retry/Force 选择规则。

### 状态

内部持久化和选择基础生效；外部 Evaluation 链与完整重跑用例仍受 P6 阻塞条件约束。

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

## P7 覆盖率范围与集成测试资源隔离

### 决策

P7 起把 `apps/cli/src` 与 `packages/work-package/src` 全量纳入全仓 V8 覆盖率，不按文件规避门禁。Vitest 同时运行的 Worker 上限固定为 3；覆盖率、测试超时和性能阈值保持原值。

### 原因

CLI 与 Work Package 是当前交付能力，必须和既有平台代码接受同一覆盖率约束。默认按 12 个逻辑核并行时，多个真实 Promptfoo 子进程、SQLite 和 HTTP 集成测试争用 CPU/IO，单测稳定、全量运行却会发生调度饥饿。4 Worker 覆盖率运行曾让真实 Run API 在固定 3 秒窗口内停留于 `EVALUATION`；相同用例独立连续三次通过，完整覆盖率集改为 3 Worker 后 160 个文件、943 项测试全部通过且不提高轮询窗口。限制测试 Worker 是资源隔离，不改变产品行为或验收阈值。

### 代码影响

`vitest.config.ts` 显式纳入两类源码并限制 `maxWorkers`。生产并发、执行限制、Promptfoo 超时、测试超时和发布性能阈值均不受影响。

### 测试影响

P7 覆盖率门禁通过 160 个测试文件、943 项测试；Statements 90.06%（9728/10801）、Branches 85.25%（6239/7318）、Functions 92.30%（2100/2275）、Lines 93.31%（9028/9675）。真实 Run API、完整 Evaluation 写前预检、Manifest 幂等身份、真实取消、Raw Row 流式边界、命令私有磁盘 staging、版本身份证明、生产导出崩溃恢复、正式目标保留前缀拒绝、配置消费时 Hash 复核、128 Case 事务边界、Manifest Ordinal 身份校验、有界 Result Set Hasher、完整序列终止校验、并发替换保护、发布后同步失败补偿、未登记 Artifact 当前命令按完整 Descriptor 清理、替换文件保留、REST 最终提交取消、导出 Body 回收和错误保真在同一覆盖率总门禁内稳定完成，不提高轮询窗口。

### 排障影响

覆盖率集成测试超时时先检查 Worker 数、Promptfoo 子进程和 SQLite/HTTP 资源争用，不通过提高业务超时、删除测试或缩小覆盖范围绕过。

### 状态

生效。

## P7 文件可见性提交与当前命令补偿

### 决策

不可变普通文件的提交点是“不可覆盖 Link 成功且父目录同步成功”，完整 Work Package 目录的提交点是“staging Rename 成功且父目录同步成功”。若目标名称已经可见而目录同步失败，写入方按设备与 inode 身份撤销刚发布的目标并再次同步。REST、Raw 或 Normalized Artifact 文件已提交但阶段描述符登记失败时，当前命令使用 Writer 返回的非持久发布身份立即补偿；完整 Descriptor 相同但 inode 不同也拒绝删除。启动恢复已没有该发布身份，因此保留并报告未登记文件，绝不按固定路径或 Manifest 差集删除。所有清理失败和清理观察器失败均旁路记录，不覆盖首次业务、冲突、取消或写入错误。

CLI 维护闭合的 Work Package 私有码映射：输入、Hash、路径、目标冲突、导出流和内部不变量分别归一为稳定公开 Error Code 与退出码。私有码不得进入 NDJSON、普通 stdout、stderr 或公开消息。

### 原因

Link/Rename 只改变目录项，不能证明目录项已经持久化；返回失败却保留可见目标会让重试误判为冲突，也会产生没有 Execution/数据库描述符的孤儿。把补偿推迟到下次启动，会使同一命令的失败结果与磁盘事实暂时不一致。私有码直接穿透则会把文件实现细节变成不稳定的外部契约。

### 代码影响

安全目录、Work Package 发布器和平台 Run Artifact Store 都把父目录同步作为发布边界，并在发布后同步失败时仅对设备号/inode 仍匹配刚发布对象的目标执行撤销；并发替换后的路径不移动、不删除，只报告补偿失败。离线 REST/Evaluation Session 与平台 REST 阶段保留已提交 Artifact 描述符，在阶段登记失败路径中执行当前命令清理。CLI 的单一边界表覆盖当前所有可抛出的非公开 Work Package 错误。

### 测试影响

故障注入覆盖文件 Link 后目录同步失败、目录 Rename 后同步失败、平台 Run Artifact Link 后同步失败、同步失败窗口并发替换目标不被误删、离线 REST `completeStage` 失败，以及输入/Hash/路径/冲突/导出流/内部不变量私有码的公开映射与不泄漏。

### 排障影响

发布失败先检查目标是否已被身份受限补偿删除、父目录同步是否成功和旁路清理事件；阶段登记失败同时检查 Execution/Run 描述符与固定 Artifact 槽位。不得通过保留孤儿、依赖下一次启动或暴露私有码规避补偿。

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

测试校验实际 `process.execPath`、Promptfoo 版本、主 Provider 与隔离 Evaluator 请求计数、退出码、真实 Fixture Case ID、原始 Assertion 类型顺序、18 个组件结果以及 Python/Ruby 内联 Assertion。完整 Runtime Doctor 自身返回 Python/Ruby Smoke 结果，并把显式选择的 `PROMPTFOO_PYTHON`、`PROMPTFOO_RUBY` 原样传给 Smoke 子进程。能力矩阵不再由类型名隐式生成契约，而是逐项保存全部合法 Payload 形态、值与阈值必填性、依赖、拒绝边界、Schema Probe、精确源码证据和 Importer 对齐键；全部类型通过开放契约与通用物化路径，统一安全边界和代表性真实进程测试固定执行事实，不逐类型复现 Promptfoo 流程。

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

## P3 资源能力注册与严格 OpenAPI

### 决策

Local Server 只按已闭环阶段注册能力。P3 仅公开 Test Suite、Suite-local Case、Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt 的资源闭环；Run、Execution、Report、Analysis、Work Package 和 SSE URL 不注册。请求与成功响应使用同一组严格 Zod DTO 投影为 Fastify Runtime Schema 和提交的 OpenAPI。

### 原因

通用对象响应或按名称猜测分页会让 OpenAPI 暴露未定义字段和伪能力。阶段注册、闭合错误联合和精确响应 Schema 可以让入口事实与 Application 能力一致，并阻止未来能力提前泄漏。

### 代码影响

真实 Route 生成 `apps/local-server/openapi.json`，漂移检查按仓库 Prettier 配置产生确定字节。资源列表使用显式 allowlist 才接受 Cursor；Prompt 引用查询不伪装成分页列表。OpenAPI 声明 Probe 502 与 Case 导入 404/409/413/422/499 等实际状态，所有状态使用闭合错误 Schema。配置更新显式物化资源字段，禁止把 `expectedRevision` 等命令字段泄漏进响应或持久化事实。SQLite Busy 重试耗尽在 HTTP 边界保留 `STORAGE_TRANSACTION_CONFLICT`，不降级成 `INTERNAL_ERROR`。

### 测试影响

测试校验 OpenAPI 路径精确集合、严格成功响应、Cursor 参数范围、未来 Route 404、运行时与提交文件字节一致，以及真实 SQLite 下全部资源族的 CRUD 和冲突。

### 排障影响

先比较真实 Route、Zod DTO、生成的 OpenAPI 和 Application 返回类型；不通过放宽响应对象或隐藏漂移解决。

### 状态

生效。

## P3 外部 Case staging 与只读 ATTACH

### 决策

最大 200 MiB 的 Case 全量导入不在主库业务表或内存中暂存。边界逐项解析，Application 逐项准备并写入受控外部 SQLite staging，同时增量计算 Suite Hash；全部项目通过后，在主库同一 Kysely 租用连接内执行一个 `BEGIN IMMEDIATE` 最终事务，通过 `ATTACH`、校验和 `INSERT ... SELECT` 整体替换，再验证 `DETACH`。这一手工事务只限 staging 最终提交，其他主库业务事务继续使用 Kysely 托管事务。

### 原因

完整数组会让内存随文件增长；把未完整校验的数据写入主业务表会暴露部分事实。SQLite 跨库原子提交需要 ATTACH 与主库事务共享同一连接，且 ATTACH/DETACH 生命周期不能跨 Kysely 托管事务边界。

### 代码影响

staging Writer 使用 `journal_mode=OFF`，写入时权限 `0600`，关闭后收敛为 `0400`。better-sqlite3 `12.11.1` 当前连接未启用 SQLite URI 文件名解析，`mode=ro&immutable=1` 会被当作普通文件名，不能作为只读保证；实现改用 canonical realpath、路径 containment 和 OS `0400`，并在真实写探针中要求 `SQLITE_READONLY`。

SQLite 初始化在任何 state/db mkdir、chmod 或数据库打开前，从显式项目根逐级验证 `.cortex-eval`、`db` 和现有数据库/WAL/SHM 的 `lstat + realpath` containment，符号链接或非普通文件直接拒绝。临时目录 owner 严格包含 PID、进程启动时间和 nonce。临时根必须是显式项目 containment root 的 lexical/canonical 子路径，根或父级符号链接在 chmod 和扫描前拒绝。启动清理只处理超过 TTL 且确认进程死亡或 PID 启动身份变化的目录；无 owner 目录未过 TTL 时保留，避免与并发初始化竞争，过 TTL 才隔离。删除前再次读取 nonce。其他非法 owner 与工作区符号链接隔离，所有 realpath 必须留在受控根内。owner 或 SQLite writer 初始化失败时关闭已打开句柄，并对部分工作区重新执行 containment/owner 清理。删除失败先记录 `TEMP_CLEANUP_FAILED`，Application 不允许它覆盖已经提交的成功结果；默认 Runtime 关闭会等待安全日志 flush。

### 测试影响

测试覆盖 `200 MiB-1`、恰好 200 MiB、`200 MiB+1`、固定 192 MiB RSS 增量、逐项背压、重复/引用/Revision 冲突、取消、只读写拒绝、无 sidecar、并发仅一方提交、DETACH、状态根/工作区/临时根符号链接、owner 伪造、PID 复用、owner 初始化窗口、清理竞争和初始化故障回收。

### 排障影响

先检查 owner 身份、文件权限、canonical path、ATTACH 列表、主库 Revision 和 staging 清理结果。不得改回完整数组、主库临时业务表或依赖无效的 SQLite URI 参数。

### 状态

生效。

## P3 大文件 HTTP 原子响应边界

### 决策

Case 导入把 multipart 截断事实纳入被 Application 消费的定义流完成条件，确认未超限后才能进入最终主库事务。Case 导出先把固定 Suite Revision 的 JSON 流写入 owner-only `0600` 临时文件，完整读取和一致性校验通过后才打开 200；Revision 冲突在响应前返回 409。导出正文按背压读取，正常结束、准备失败和响应取消均按 owner 身份清理，不保留完整 Case 数组。

### 原因

若 Route 在业务事务提交后才检查 `file.truncated`，合法数组后的超限尾随空白会造成“返回 413 但事实已写入”。若导出在异步生成器开始读取前先发送 200，后续 Revision 冲突只能表现为连接断流，无法再返回闭合 409。提交条件必须在写事务前闭合，错误状态必须在 HTTP 响应打开前确定。

### 代码影响

导入边界在定义流开始和结束时检查截断状态；导出使用独立 `case-export-` 工作区、0600 文件和带背压的清理感知流。Analysis Prompt 预览 Schema 同步 Domain 的六个合法变量；所有 Route 的 OpenAPI 都声明 Host/Origin 403；LLM Probe 组合请求 Signal 与配置 `timeoutMs`，Gemini 和 OpenAI-compatible 使用同一超时分类。

### 测试影响

测试覆盖合法数组先结束的 `200 MiB+1` 输入不提交、响应前导出 Revision 冲突、导出文件权限与正常/失败/取消清理、六变量响应契约、所有操作 403，以及 Gemini 不返回时按配置超时。

### 排障影响

导入 413 先核对 Suite Revision 与 Case 事实是否保持不变。导出断流先检查临时文件写入、Revision 校验与 owner 清理；不得改回响应后错误映射或完整数组缓冲。

### 状态

生效。

## P5 平台 Run 只闭合 REST 并以持久事实推进

### 决策

P5 平台 Run 创建在一个短事务中冻结 Suite、Cases、Endpoint、Evaluator、被引用 Rubric Prompts 和 `RunExecutionLimitsV1`，写入 `READY/REST`。当前 Start 只允许抢占 REST；REST 逐 Case结果以独立短事务落库，完整对账和不可变 Artifact 成功后再把 Run 提交为 `READY/EVALUATION`。P5 不注册 Evaluation、Report、Analysis、Pipeline 自动推进或 Retry/Force 动作。

取消先持久化 `cancel_requested_at` 和新 Revision，再通知本地 Abort；其他进程通过 25–50 毫秒持久状态轮询观察取消。Runtime Shutdown 收敛为 `INTERRUPTED/DONE`，不冒充用户取消。Run 与离线 Execution 的 Artifact 预期事实统一使用完整 `cortex.artifact-manifest.v1` 对象和显式 Owner 联合，不再保存无身份数组。

### 原因

外部 POST 副作用不能包在数据库事务或自动重试中。只有数据库事实、文件事实和 Revision 都闭合后才能推进 Stage。取消请求必须跨进程可见；进程内 Abort 只能作为低延迟优化。未实现的 Stage 若提前注册，会把不可执行状态暴露给 API 和 Web。

### 代码影响

Application 通过专用 Run Transaction Manager、Rest Executor 和 Run Artifact Store Port 编排。SQLite 部分唯一索引保证全库最多一条 `RUNNING`；阶段抢占、取消、逐 Case计数、完成、失败和恢复均使用条件写。REST Artifact 先写 Run ID 专属路径；数据库提交失败时使用 Store 返回的非持久发布身份删除未提交文件。启动时发布身份已丢失，只保留并报告未被任何持久平台 Run Manifest 引用的受控文件。

### 测试影响

测试覆盖冻结与 Hash、默认和显式限制、双进程唯一运行、跨进程取消/提交竞争、停止派发、Runtime Shutdown、启动恢复、Artifact 写失败和孤儿清理、真实 HTTP、Provider Output、精确大小/超时/并发边界，以及 REST 后停在 `READY/EVALUATION`。

### 排障影响

先检查 Run Status、Stage、Lock Revision、取消时间、逐 Case计数和 Manifest，再检查受控 Artifact 与 REST Adapter 分类。不得通过重试 POST、跨事务持有网络调用或跳过对账推进 Stage。

### 状态

生效。

## P5 Run 动作小响应、有限期 SSE 与最近平台 Run 聚合

### 决策

Start 和 Cancel 返回小型 `RunProgress`，完整冻结摘要由 Run Detail 单独读取。SSE 在发送 200 前验证 Run，先发送当前 Snapshot，再按 250 毫秒从 SQLite 查询 Revision 变化；单连接最多 5 秒并声明 1 秒重连，因此跨进程变化最坏可见时间约 6 秒。Web 同时保留查询刷新，断流或协议错误只重新读取服务端事实。

Dashboard 和 Test Suite 列表的最近运行只聚合 `source_type='PLATFORM'`，按 `created_at DESC, id DESC` 确定顺序。SQLite 使用专用部分倒序索引；离线导入不冒充最近平台 Run。

### 原因

动作响应若返回完整快照会放大序列化、缓存和泄露面。内存 Event Hub 无法观察其他进程写入；无限 SSE 会长期占用本地连接。最近运行按 `updated_at` 排序会因进度写改变“创建顺序”，混入离线导入会错误表达平台执行状态。

### 代码影响

Run HTTP Client 对每个响应和 SSE Envelope 执行 Contracts 与请求 Run ID 双重校验。Web 只在 `READY/REST` 显示 Start、只在 `RUNNING` 显示 Cancel；`READY/EVALUATION` 不出现未来 Stage 动作。测试集列表查询使用专用索引并返回严格可空最新平台 Run 投影。

### 测试影响

测试覆盖 Start/Cancel 小响应、SSE 不存在 Run 的普通 JSON 404、Snapshot/Event 身份、有限期流重查、Run SPA 路由、Dashboard、Test Suite 最新平台 Run、离线导入排除和未来能力隔离。

### 排障影响

进度延迟先检查 SSE 生命周期、重连和 Run Revision，再检查 SQLite 查询。不得把浏览器缓存或内存事件当成跨进程事实源，也不得扩大动作响应替代详情查询。

### 状态

生效。

## P5 Run 有界读取、流式 Artifact 与 Owner 终态收敛

### 决策

Application 显式区分完整冻结执行输入、`PlatformRunDetail` 和 `PlatformRunProgress`。完整输入只在 REST 阶段成功抢占时读取；详情不返回冻结 Case 数组或 Rubric Prompt 正文，动作、SSE、取消轮询和阶段推进只读取进度投影。SQLite 逐 Case 写入按 Run ID 与 Ordinal 直接校验目标冻结 Case Key/Hash，不重复反序列化完整 Suite。

REST Artifact Port 接受带预期总数的 `AsyncIterable`，按稳定 Cursor 单遍写入 Canonical JSON；Writer 在同一遍增量计算 Result Set Hash、文件 Hash 与大小，并逐 Case 执行 Contracts 清洗。REST Executor 的任一逐 Case 持久化回调失败会记录首个错误、内部 Abort、停止领取并等待所有 Worker 退出，再向后台 Owner 拒绝。后台 Owner 在注册时立即捕获取消轮询拒绝并 Abort Executor；Runtime Shutdown 在 Artifact 写入后、阶段提交后和后台任务最终化时重查中断门禁，把仍未 `DONE` 的本地 Run 收敛为 `INTERRUPTED/DONE`。

### 原因

完整冻结 Suite 和完整结果集合都随 Case 数增长。若每个结果写入、每次轮询或 SSE 都加载完整 Run，会形成二次增长的解析与分配；若 Artifact 先聚合数组，会额外放大峰值内存。后台 Promise 若晚绑定错误处理会泄漏拒绝；Shutdown 与文件/数据库提交竞争时，单次前置检查不足以保证关闭语义。

### 代码影响

新增有界 Detail/Progress DTO 与对应 Repository 查询，Artifact 输入改为单次消费流并返回计算后的 Result Set Hash。SSE OpenAPI 分别声明 200 `text/event-stream` 和开流前 400/403/404/500 `application/json`；Hijack 后的轮询、Schema 或写流异常统一结束响应并释放 Controller。Local Runtime 接入创建冻结、REST 开始/完成、取消请求/完成五类闭合业务事件。Web 预检由组件生命周期持有 AbortController，并以单调请求代次加选择键拒绝迟到响应；重新预检先失效旧事实，本代失败保持创建门禁。创建响应校验所有由请求固定的身份和显式限制。

### 测试影响

测试证明逐 Case 写入不调用完整 Run 读取、详情/进度投影不包含大字段、流式 Artifact 与批量 Canonical Hash 等价、结果持久化失败后等待忽略 Abort 的 Worker 收口、轮询拒绝无未处理 Promise、Shutdown 不能晚到 `READY/EVALUATION`、SSE 成功/错误媒体类型和 Hijack 后拒绝收口，以及 Web 预检 Abort、A→B→A 迟到拒绝、同选择重新预检失败门禁和创建响应身份。

### 排障影响

进度或写入变慢时先检查是否误用完整 `getPlatformRun`；Artifact 内存异常先检查 Cursor 与 `AsyncIterable` 是否被聚合。关闭卡住或终态错误时检查 Owner 中断门禁、轮询错误和最终 settlement，不通过放宽 Shutdown 语义规避。

### 状态

生效。
