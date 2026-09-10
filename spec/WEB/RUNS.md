# Web Runs

## 当前页面边界（2026-09-10）

- Run 只保留 `/runs/:id` 一个详情页。`/execution`、`/report`、`/analysis`、`/statistics` 仅作旧链接重定向，不得恢复独立页面或导航入口。
- 统计、冻结配置、Token 与 Case 列表同页；Case 抽屉只有结果详情和执行链路，A2UI 动态卡片在结果详情内。
- AI 分析是 Run / Case 抽屉内的显式批量操作；结果留在执行链路，AI 关联证据不等于确认根因，不改评测结论。底层报告、分析与导出 API 保留。
- 离线导入也进入统一详情，以保存的 Report 为证据来源；没有平台执行配置时不伪造启动、停止、重跑或耗时。
- 当前实现：`run-dashboard-page.tsx`、`run-imported-dashboard.tsx`（同页数据来源适配）、`run-analysis-control.tsx`、`run-case-drawer.tsx`。
- 当前验证：`run-unified-workspace.test.tsx`、路由测试和 `web-static-routes.test.ts`。

以下为历史阶段记录；其中独立 Report / Analysis 工作台、旧执行视图、截图审核列的描述不再代表当前 UI，不能据此重新添加页面。


## 模块职责

该 Feature 提供平台 Run 预检、创建、REST/Evaluation/Report 启动、进度、逐 Case 结果、取消、刷新恢复、版本化重跑和当前 Case Analysis 决策界面。

模块不在浏览器推进状态机，不直接控制 REST 请求，也不把缓存视为运行事实。

## 边界与依赖

页面只依赖 Local Server Run API 和 Contracts。服务端 Run 状态是唯一事实源；TanStack Query 与 SSE 只负责及时重新读取事实。

## 实现状态

已注册 `/runs`、`/runs/:id`、`/runs/:id/report`、导航和 Dashboard 统一最近 Run/最新报告卡片。详情支持 REST/Evaluation/Report 启动、结果查询、Pipeline 自动推进后的刷新恢复，以及终态平台 Run 的 Retry/Force。报告页支持显式 Analysis、重新分析、结构化 Evidence 展示，以及 Proposal 拒绝、接受和编辑后接受；离线导入 Run 进入只读 Report 与当前 Analysis 决策界面。

## 代码落点

`apps/web/src/features/runs`

## 当前代码事实入口

- [run-list-page.tsx](../../apps/web/src/features/runs/run-list-page.tsx)：资源选择、预检门禁、执行限制和 Run 列表。
- [run-dashboard-page.tsx](../../apps/web/src/features/runs/run-dashboard-page.tsx)：平台 Run 默认 Dashboard、冻结配置、独立进度、Token 与已有运行操作。
- [run-dashboard-model.ts](../../apps/web/src/features/runs/run-dashboard-model.ts)：完整分页、互斥分类、Judge 用量和安全配置投影。
- [run-dashboard-cases.tsx](../../apps/web/src/features/runs/run-dashboard-cases.tsx)：紧凑列表、即时筛选、分页与三页签 Case 抽屉。
- [run-detail-page.tsx](../../apps/web/src/features/runs/run-detail-page.tsx)：保留旧执行路由的兼容视图。
- [run-ui.ts](../../apps/web/src/features/runs/run-ui.ts)：状态和阶段的展示映射。
- [run-api.ts](../../apps/web/src/lib/run-api.ts)：严格 Run API、身份校验、Cursor 和 SSE Envelope 边界。

## 当前样例与测试入口

- [run-pages.test.tsx](../../apps/web/test/run-pages.test.tsx)：创建门禁、详情、启动、取消和页面能力隔离。
- [run-api.test.ts](../../apps/web/test/run-api.test.ts)：请求、响应身份和 SSE Schema。
- [run-test-fixture.ts](../../apps/web/test/run-test-fixture.ts)：测试专用 Run DTO 工厂。

## 对外接口

创建运行时选择 Test Suite、Endpoint、Evaluator 和 `STAGED`/`PIPELINE` 模式，可覆盖 `RunExecutionLimitsV1`。页面先调用 Preflight，展示 Case 数、Rubric 依赖、REST/Evaluation 所需 Env Key、Endpoint 超时和将被冻结的并发限制；选择改变、重新预检或卸载会 Abort 旧请求，并以单调请求代次和当前选择键共同拒绝迟到成功。重新预检在发请求前失效上一代事实；本代在途或失败时不展示旧事实、不允许创建。只有当前选择与当前代对应的预检成功后才能创建。

Run 列表使用服务端倒序 Cursor，统一展示平台与完整离线导入来源。平台详情只展示有界冻结摘要、阶段计数、Artifact 可用性和真实已完成 REST/Evaluation Case 结果，不加载冻结 Case 数组或 Prompt 正文；离线导入链接直接进入报告。Evaluation 表逐 Case 展示 Status、Score、Reason、Evaluation Error、Metric；每条 Assertion 展示 Type、Metric、Status、Weight、Score 和 Reason。空值明确显示为无，不把错误文案推断成状态。

## 核心流程

1. 用户选择三个当前资源，页面取消旧预检并读取新选择的服务端事实。
2. 用户确认模式和限制后创建 `READY/REST` Run，并进入详情页。
3. Start 携带当前 `lockRevision`；接受后立即用小型进度事实更新展示，再读取完整详情。
4. REST 阶段展示总/完成/成功/错误；Evaluation 及后续阶段展示总/完成/PASS/FAIL/Error/Not Evaluated。批处理执行中完成数为真实的 0，原子提交后一次显示完整分类，不从当前分页明细推算。终态 `DONE` 不再猜测阶段：存在已提交 Evaluation 完成事实时显示 Evaluation 分类，否则显示 REST 计数，并且不请求不存在的 Evaluation 明细。
4. `RUNNING` 时页面订阅有限期 SSE，并保留查询刷新。每个 Snapshot/Event 必须通过 Schema 且绑定当前 Run ID；流结束、重连或错误只触发重新查询，不在浏览器推断新状态。
5. Cancel 携带最新 Revision。页面显示服务端已确认的取消请求和最终状态，不提前伪造 `CANCELLED`。

`STAGED` REST 完成后页面显示 `READY/EVALUATION` 并允许按最新 Revision 启动；Evaluation 完成后显示 `READY/REPORT` 并允许生成 Report。终态平台 Run 在冻结上下文完整时显示 Retry Failed 与 Force，创建新版本后展示复用/执行计数和新 Run 链接，来源保持不变。

## 状态、事务与幂等

浏览器刷新或路由切换后重新查询 Run。`READY/REST`、`READY/EVALUATION` 或 `READY/REPORT` 显示对应阶段启动，`RUNNING` 显示取消；终态平台 Run 只提供创建新版本的动作，离线导入不提供执行动作。重复点击由客户端单飞与服务端 Revision/状态条件共同收敛。

## 错误收敛

预检错误阻止创建。创建成功响应除 Schema 外还必须匹配请求固定的 Suite、Endpoint、Evaluator、Run Mode 和显式执行限制，否则按 `CLIENT_RESPONSE_INVALID` 拒绝。Run 不存在、Revision 冲突、全局运行冲突和未闭环 Stage 使用稳定错误显示。SSE 内容、Run ID 或响应 Schema 不合法时同样重新读取，不把脏数据放入 Query 缓存。

## 观测与验收

REST 展示总数、完成、成功和错误；逐 Case 表只显示真实结果。Dashboard 和 Run 列表显式区分 `PLATFORM` 与 `OFFLINE_IMPORT`；Test Suite 只聚合确实关联当前 Suite 的完整 Run。页面刷新不影响执行，部分或全部 REST Error 均按服务端事实展示。

## 相关测试

当前测试覆盖预检门禁、选择改变 Abort、迟到响应拒绝、创建参数和身份、统一 Run 列表、详情、REST/Evaluation/Report 启动与取消 Revision、Pipeline 刷新恢复、SSE 身份、逐 Case 结果、导航、Dashboard、离线报告链接、Retry/Force、Analysis Cursor 遍历、重新分析和 Proposal 决策。

## 运行工作区

新建默认 `PIPELINE`，仍须预检并冻结输入；`STAGED` 是显式高级调试选择。主导航只保留仪表盘、评测运行、测试集和配置中心，配置页面继续复用原路由。

平台 Run 默认入口 `/runs/:id` 统一为 Dashboard，不再按报告是否存在切换主页面。自上而下为标题与操作、运行配置快照、互斥结果分类和双进度、Token 汇总、Case 列表。旧 `/execution` 与 `/report` 路由暂留兼容，导入报告保持只读。

- `PRESENT` 报告读取所有 Report Case 分页；没有报告时读取已保存的 REST/Evaluation，并通过已有 Case 详情接口取得冻结描述。详情读取并发最多 8，使用不可变记录缓存。界面每页 20 条；不会把当前分页误作总量。此方案适用于当前小团队本地工作台，后续规模增长再补服务端摘要查询，不改执行引擎。
- 总数来自冻结 Suite；分类以每条实际记录为单位：取消 → 执行或评测异常 → 通过/未通过 → 待处理，缺执行记录计待处理。执行、评测两列独立映射，不抹掉已有评测证据。加载失败、计数不同步时不展示虚假的分类零值。
- 统计数字点击联动 Case 过滤。搜索编号/冻结中文描述、业务场景、执行状态、评测结论即时生效；不要求点击应用。描述占最多宽度，移除原始证据列；详情、Trace、卡片打开同一右侧抽屉，卡片入口定位结果详情内的动态预览。
- 首页配置展示 Agent 入口、冻结的分支/短 Commit、配置的评测模型。历史缺失版本显示“未记录”；不使用当前仓库版本回填历史。Endpoint 可以手动填写实际部署的 `agentRevision`（分支和 Commit 必须成对填写），仅后续创建的 Run 冻结该版本。不将复杂 Agent 概括为单一模型或 Prompt 版本。
- Token 主栏为已记录总量、Agent、评测模型。Cortex E2E v1 的 `llm_calls` 按 req_id/call_id 去重，累加实际 input/output（包含已记录的失败与重试），缓存不额外叠加，timeline 和父级汇总不重复相加。UNKNOWN 采集范围或缺 usage 时标“已记录部分”；未采集不是零。Judge 使用非复用评测的 `evaluation.tokenUsage`；人工结论不修改 usage。关联复用执行的 Agent 用量不是本次新增消耗，在明细明确说明；不作为完整账单。

## Case 抽屉、Trace 与人工证据

- 抽屉仅保留“结果详情 / 执行链路”两个页签，顶部标题、操作和页签固定，证据区域独立滚动。宽屏左侧验收检查、右侧实际输出；窄屏上下排列。预期和分项评测按冻结断言索引合并，不按名称匹配；通过项折叠，失败/异常/缺失项展开，完整约束和原始错误再折叠。上一条/下一条沿用当前筛选顺序，不改变底层分页和滚动位置。
- 实际输出汇集 `delivered_messages` 的多条出站记录，保留文本及关联附件/卡片结构。同一消息标识且内容一致的副本去重，不同内容不擅自丢弃或猜测流式拼接。`timeline.payload.reply_text` 中只有生成证据的后续回复也可查看，但明确标注“已生成 · 交付未确认”。历史 `final_output` / `reply_text` 仅作投影兜底，不将其冒充已交付。完整可读内容不再藏在 JSON 中，不展示内部思考字段。仅在时间戳完整有效时合并排序，缺失顺序不推断。
- 用量与耗时默认折叠，展开按模型调用展示角色、模型、输入/输出/总 Token、耗时，点击跳转对应 Trace 节点。唯一且同请求/同工具的调用与终态步骤可计算工具区间，否则耗时“未采集”；工具 Token“不适用”。Judge 仅展示已保存的 Case 汇总，不编造逐 Rubric 分摊；复用消耗注明历史来源。
- “执行链路”只呈现可观测的动作、工具实际返回和模型审计，不展示内部思考字段。步骤顺序取 step_idx；有明确 parent_step_id / parent_call_id 时展示父子层级，缺失/冲突关联不推断；无步骤关联的模型调用另区展示。工具节点不展示 LLM Token。
- A2UI 不单独开页签。在实际输出下方通过生产 Cortex Web 渲染器直接渲染本次保存的真实出站数据，允许滚动、切换和展开；不生成、上传或保留 Run 卡片 PNG。列表“查看卡片”定位同一抽屉。放大保留当前 iframe 状态，重新加载只读取保存证据，不调用 Agent 或工具。
- 人工结论、根因标签、审核人及备注按 Run/Case 隔离保存，不覆盖自动结果。自动失败/异常不能被人工通过覆盖；有真实出站卡片或显式要求 A2UI 复核的 Case，自动通过后仍待人工检查。渲染未就绪、数据缺失、资源加载失败不能确认视觉通过。没有卡片且未要求复核不增加视觉门槛；要求出卡/禁止出卡由 Case 断言表达。
- 保存以 REST resultHash + revision 校验，视觉人工通过另绑定 rendererVersion。执行证据或渲染资源版本变更必须重新审核；旧截图批准不能当作动态卡片批准。审核记录不可读时明确报错；不伪造已渲染状态。


## 单 Case 重跑、仅重评与对比

- 重跑单 Case：冻结原始 Case 与原 Run 配置创建独立 READY Run，ordinal 从 0 开始；原测试集、原执行与原评测不变。无自动业务数据初始化/清理能力，确认区明确说明副作用，创建后仍需用户开始执行。
- 仅重新评测：只接受保存完整且 REST 成功的源 Case，预置带来源 Hash 的旧 REST，执行阶段不再请求 Agent；评测采用新记录，仍可能调用配置的 Judge。沿用 `FORCE` 强制重新评测语义，持久层仅允许精确匹配的一条冻结 Case 预置 REST，不允许整批 FORCE 偷偷复用。评测复用仍只允许 RETRY_FAILED。
- 对比基准运行与当前运行，按 caseKey + definitionHash 对齐，内容变化/新增/缺失分开，不纳入同条件结论变化；记录不完整时不进行对比。配置差异折叠，列表展示自动结论、执行耗时、Agent/Judge 用量变化；人工结果不混入自动对比。部分用量仍明确标识为已记录值。

相关验证：[用量与映射](../../apps/web/test/run-evidence-model.test.ts)、[审核存储](../../apps/local-server/test/run-review-store.test.ts)、[审核路由](../../apps/local-server/test/run-review-routes.test.ts)、[重跑服务](../../packages/application/test/platform-rerun-planner.test.ts)、[真实 SQLite 边界](../../packages/storage-sqlite/test/sqlite-platform-case-rerun.test.ts)。


## 运行名称与测试目的（2026-09-09）

- 创建运行时，运行名称由所选测试集自动填入，可修改（1～120 字符）；运行描述选填（最多 2000 字符），用于记录本次目的、改动和关注点。没有单独的“目的”重复字段。
- 名称和描述保存到 Run 自身，列表主链接显示运行名称，描述单行省略；详情标题显示运行名称，下面显示完整可滚动描述。测试集名称独立保留，Run ID 弱化且可在详情复制。描述为空不占位。
- 历史 Run 的新增字段为 null，展示时使用冻结测试集名称兜底；不生成虚假的历史目的。
- 再次运行先打开可编辑名称/描述的创建面板，默认沿用原值，可清空描述；创建新的 READY Run 后需手动开始。单 Case 重跑和仅重评也由后端继承来源标签，来源记录不变。
- 对比选择器与对比摘要使用运行名称。名称/描述不属于评测条件，不参与 Case、Suite 或 runContextHash，不作为配置差异。
- 两个字段通过可选请求字段向后兼容，服务端也校验长度、空名称和类型；SQLite 006 migration 只追加 nullable 列，不改写现有快照、Hash、Artifact 或评测结果。
- 相关验证：[run-metadata.test.tsx](../../apps/web/test/run-metadata.test.tsx)、[sqlite-platform-case-rerun.test.ts](../../packages/storage-sqlite/test/sqlite-platform-case-rerun.test.ts)、[sqlite-run-metadata-migration.ts](../../packages/storage-sqlite/src/sqlite-run-metadata-migration.ts)。

本轮抽屉定向验证：[输出及状态口径](../../apps/web/test/run-case-output.test.ts)、[抽屉交互](../../apps/web/test/run-case-drawer.test.tsx)。

### Case 动态卡片人工复核

- 兼容已有严格协议中的 `metadata.a2ui_capture` 字段，前台文案为“要求 A2UI 人工复核”；不再代表后台截图任务，不追改旧 Run 的 Case 快照。实际有出站卡片的 Case 也需要视觉复核。
- 顶层出站 `a2ui` 为权威顺序；缺失时才读已交付消息/最终输出，不从 Planner 或工具返回拼卡，不用固定模板补缺失数据。按记录顺序应用所有数据包，展示最终状态，不声称还原原始消息时序或 iOS 效果。
- A2UI 资源跟随 Run 冻结的 endpoint，不读取后来编辑的 endpoint 配置。loopback endpoint 使用 `CORTEX_A2UI_STATIC_ROOT` 本地目录；未配置目录时使用该本地 endpoint 的 HTTP 静态资源。远程 endpoint 使用同环境 `/web_ui/static/`（保留 endpoint 已有的 `/web_ui/` 路径前缀），绝不回退到本地资源。
- 本地进程提供一个独立 loopback 只读源，不启动 Chromium。按 Run + 资源源隔离命名空间；首次复核时获取完整资源内存快照并计算内容哈希，该服务会话内同一 Run 保持固定。页面显示资源来源。历史回看使用对应环境当前资源，不声称是执行当时版本。
- iframe 与平台业务 API 隔离，消息桥验证来源与会话令牌；仅保留组件内部展示行为，不挂接真实业务 action，不允许链接跳转、表单提交或任意外部网络。
- 前端渲染失败会撤回本次页面的就绪状态；“重新加载”可重试。人工审批仍由 UI/产品操作，不由 Agent 代批。

### 复核表单按结论收敛

- 卡片区域使用“视觉复核结论”，与 Case 自动结论区分；通过、待复核不显示失败归因，备注选填。不通过显示问题说明和选填失败归因，无需产品判断技术根因。
- 切换为通过或待复核时清除当前失败归因；服务端新保存的非失败结论统一使用 `UNCLASSIFIED`，不修改历史记录。历史仍展示当时结论、归因与说明。


### 执行证据工作台（2026-09-09）

- Case 抽屉默认最大 1580px，可切换全宽。验收检查与文字输出并列，A2UI 独占宽区，视觉复核在侧栏；小屏上下排列。结果网格按内容高度滚动，禁止压缩卡片区域造成裁切。
- 执行链路采用节点列表 + 证据检查器。点击节点显示可折叠 JSON、完整原始 JSON 与复制；长文本按需展开。展示每次模型调用耗时、输入/输出 Token；普通工具不展示模型用量。分组可折叠，异常可定位；缺失关联不会人为接成执行顺序。
- A2UI 按保存的出站顺序提供卡面/阶段选择，默认最后一项。增量更新按原始前缀重放，支持单卡面检查；多个仍有效卡面另保留最终完整同屏状态，避免独立渲染取代真实组合效果。删除消息保留在原始证据，不作为空白卡面强行渲染。
- 仅当前证据与渲染版本下所有展示项成功加载，前端才开放视觉通过；加载状态不等于人工批准。切换/加载失败立即撤销可批准状态，视觉通过不覆盖自动失败。InfoChip 与 SurfaceHost 都按实际渲染元素检查就绪。
- 本次只改展示与只读回放，不调用真实 Agent / Judge，不生成或保存产品截图。

### Trace 节点的可读证据

所有可点击节点默认提供关键信息，并始终保留原始 JSON、结构视图、复制入口。按可观测记录解析 envelope 和 payload，不依赖 Case 编号、任务业务类型或工具名词典；未知字段保留原字段名并通用展示。
工具调用采用 `Tool calling: <name>` 与紧邻的 Arguments 字段组；支持 param / arguments / args_json / args 及 function.arguments。工具结果独立展示原始 status 与 result / output / data，不将调用请求视为执行成功。模型、路由、动作、消息、采集范围及其他证据节点都使用相同的通用字段展示；字符串全文、长列表和深层对象可展开。
左侧标题仅在保存记录有环节标识时前置 router / planner / ResponseGate 或原环节名；没有标识则不展示阶段，不猜测步骤与模型调用的先后关系。记录时间作为弱化的行内元数据，不单独占大卡片。抽屉及只读 A2UI 预览使用细、浅色滚动条。
所有视图仍经过既有内部思维字段过滤，未知字段不静默丢弃。缺失、null、空列表、空对象、false 与 0 分别展示；不更改评测结论、执行链路、用量统计或人工审核记录。

### 运行入口与列表展示

- 运行页面的“返回”沿应用创建的浏览器历史返回来源页（包括仪表盘、运行列表）；刷新保留来源，直接访问且没有应用内来源时回退到运行列表。不依赖外部 referrer。
- 列表突出运行名称和目的；来源归入测试集列，阶段归入运行状态列。执行、评测使用各自的完成数与总数，不用执行完成代替评测通过。
- 导航采用浅色背景、紧凑系统字体和明确选中态；保留原有导航路由、分页、删除确认及运行中禁止删除约束。
