# Web Test Suites

## 模块职责

该 Feature 提供测试集与 Case 的列表、详情、创建、复制、编辑、删除、导入、导出、搜索、过滤和分页界面。

模块不自行解析 Rubric 引用、计算 Definition Hash 或执行批量写入事务。

## 边界与依赖

页面依赖 Test Suites Application API。表单结构和 JSON 编辑器使用同一保存协议，后端统一执行完整校验。

## 实现状态

P4 已落地当前 Test Suite 与 Case 资源管理。运行状态和最近 Run 展示仍等待 P5。

## 目标代码落点

`apps/web/src/features/test-suites`

## 当前代码事实入口

- [test-suite-list-page.tsx](../../apps/web/src/features/test-suites/test-suite-list-page.tsx)：测试集列表、创建和 Cursor 历史。
- [test-suite-detail-page.tsx](../../apps/web/src/features/test-suites/test-suite-detail-page.tsx)：Suite/Case 查询、CRUD、导入导出和冲突流程编排。
- [test-suite-case-list-panel.tsx](../../apps/web/src/features/test-suites/test-suite-case-list-panel.tsx)：Case 组合过滤、表格动作与 Cursor 历史。
- [test-suite-metadata-sheet.tsx](../../apps/web/src/features/test-suites/test-suite-metadata-sheet.tsx)：Suite 元数据编辑和 Draft/Snapshot 决策。
- [use-test-suite-metadata-editor.ts](../../apps/web/src/features/test-suites/use-test-suite-metadata-editor.ts)：Suite 元数据单飞、字段错误、关闭门禁和连续冲突恢复。
- [case-copy-dialog.tsx](../../apps/web/src/features/test-suites/case-copy-dialog.tsx)：Case 复制 Draft、确认和失败保留。
- [case-import-dialog.tsx](../../apps/web/src/features/test-suites/case-import-dialog.tsx)：全量导入文件、项错误和冲突决策保留。
- [case-delete-dialog.tsx](../../apps/web/src/features/test-suites/case-delete-dialog.tsx)：Case 双 Revision 删除确认和冲突决策。
- [use-case-mutation-recovery.ts](../../apps/web/src/features/test-suites/use-case-mutation-recovery.ts)：创建、复制、删除和导入共用的最新 Revision 重试流程。
- [case-mutation-conflict-notice.tsx](../../apps/web/src/features/test-suites/case-mutation-conflict-notice.tsx)：非编辑写操作的可重试冲突与远端已删除接受决策。
- [case-editor.tsx](../../apps/web/src/features/test-suites/case-editor.tsx)：共享 Draft 的结构化/完整 JSON 编辑器和字段错误定位。
- [case-editor-state.ts](../../apps/web/src/features/test-suites/case-editor-state.ts)：纯编辑转换、无损 Assertion 与 API 路径映射。

## 当前样例与测试入口

- [loona_promptfoo_tests.json](../../test_suite/current/cases/loona_promptfoo_tests.json)
- [test_convert_loona_to_promptfoo.py](../../data_scripts/test_convert_loona_to_promptfoo.py)
- [Test Suite list/edit tests](../../apps/web/test/test-suite-detail-page.test.tsx)
- [Test Suite Case mutation tests](../../apps/web/test/test-suite-detail-page-case-mutations.test.tsx)
- [Test Suite lifecycle tests](../../apps/web/test/test-suite-detail-page-suite-lifecycle.test.tsx)
- [Case editor tests](../../apps/web/test/case-editor.test.tsx)
- [P4 resource E2E](../../apps/web/e2e/resource-management.spec.ts)

## 对外接口

列表默认每页 50 条、最大 200 条，展示 Case ID、描述、业务模块、场景标签、Assertion 类型、Metrics 和更新时间。支持按 Case ID、描述、业务模块、场景标签、Assertion 类型和 Metric 组合过滤。

Case 编辑器使用共享 Draft。结构化模式编辑公共字段并为每条 Assertion 保留完整 JSON，完整 JSON 模式编辑整个 Case；切换前必须成功解析。锁定 Promptfoo 版本接受的未知字段必须原样保留，不能被表单静默删除。

每次打开 Case 都必须由本次成功、身份匹配的详情读取建立显式编辑 Session，并一起冻结 Definition、Case Revision 与 Suite Revision。API Client 在 Schema 通过后校验所有请求已固定的身份：Suite 读取/更新的 ID，Case 列表的 Suite、Case 读取及创建/更新/复制的 Suite、Case Key 和 Definition Case ID，导入返回的 Suite，以及配置列表/创建的 Kind 和配置读取/更新的 ID/Kind。身份错配按 `CLIENT_RESPONSE_INVALID` 拒绝，不能建立 Session、关闭 Draft、显示成功或进入目标 Query 缓存。旧 Query 缓存在刷新完成前不能挂载编辑器；刷新失败只显示读取错误，不允许用旧 Definition 保存。Session 建立后不被后台刷新改写。

## 核心流程

用户创建空测试集或导入 JSON，查看服务端分页 Cases，编辑结构化字段或 JSON，并通过同一 API 保存。删除和全量替换前展示影响范围并确认。

测试集和 Case 写入及测试集删除使用与可见事实同一时刻冻结的 Revision。409 后页面读取最新 Suite/Case Snapshot，保留可见的本地 Draft 或删除意图，并要求用户选择最新 Revision 重试或采用 Snapshot。Suite 元数据 Sheet 把打开或显式采用 Snapshot 时的表单值与 Revision 冻结为同一 Session，后台 Query 刷新不能替换该 Token。Suite 删除在 Impact 预检前冻结 Suite Snapshot，仅在 Impact 成功后原子发布确认事实；409 后按 Suite、Impact 顺序读取，全部成功才替换整组事实，失败或 Abort 不允许拼接新旧状态。冲突恢复 Controller 由组件生命周期托管，卸载后即使底层返回迟到 Suite，也不能继续读取 Impact 或同步共享 Query。若 Case 编辑或删除刷新得到 `CASE_NOT_FOUND`，恢复状态显式变为 `REMOTE_CASE_DELETED`，不伪造 Case Revision；编辑详情 Query 先停用再清理缓存，原 Draft 保持只读可见，删除 Dialog 保持打开，且两种流程都只提供“采用服务端已删除事实”决策。Suite 创建和元数据保存使用同步单飞锁，在途或冲突待决时冻结表单，并阻止关闭 Sheet；非冲突失败和可定位字段错误保留在该 Sheet。Case Snapshot 不在决策前写入可见编辑详情缓存，结构化与完整 JSON 模式都保持原 Draft；保存请求或冲突决策期间冻结整个可编辑面，重试不会静默忽略冲突后输入。创建、复制、删除和导入共用同一恢复流程与同步单飞锁；复制输入在冲突期间同样冻结，重复冲突会再次读取事实，写入在途或冲突待决时禁用原操作。显式重试遇到非 Revision 终态失败时，恢复 Hook 统一清洗错误并把最近 Revision Facts 交回 owner，清除旧冲突但不关闭 Sheet/Dialog；创建 Draft、复制 ID、删除目标和导入文件保持原值，控件恢复可用，删除再次确认使用最近双 Revision。Case 编辑重试失败通过单调事件 ID 交回同一编辑器，仅消费一次，并复用普通保存的字段路径映射与聚焦逻辑。Test Suite 删除影响预检使用独立单飞锁、支持卸载取消，并与 Suite/Case 写入入口双向互斥；成功后通过已提交导航离开，不直接清空页面聚合门禁。页面级离开门禁覆盖关闭按钮、Esc、返回按钮、侧栏、浏览器历史和页面卸载，写入结束或用户显式完成冲突决策后才解除；该门禁要求浏览器提供 `Navigation.currentEntry.index`，能力缺失时整个资源 Feature 不挂载。相邻 Suite 详情路由按 Suite ID 重建组件，卸载时释放上一 Suite 的页面状态和请求。失败的操作保持当前 Sheet/Dialog，并在当前模态容器内展示，不把失败当成成功关闭；导入和删除请求在途或冲突待决时取消按钮同步禁用。

`REMOTE_CASE_DELETED` 不创建替代编辑器，而是在同一编辑 Session 中禁用原实例，保留冲突前的模式、完整 JSON 文本和控件状态。普通冲突只有在用户显式采用仍存在的服务端 Snapshot 后才以新 Session 重建编辑器。

## 状态、事务与幂等

URL 或 Feature State 显式保存分页和过滤条件。保存冲突保留用户输入并刷新服务端事实；Suite Snapshot 同步详情和所有已加载 Suite 列表，Case Snapshot 先同步已加载 Case 列表，只有用户采用 Snapshot 后才替换可见编辑详情。无法获得具体 Case Snapshot 的聚合冲突会使 Case 列表失效并重取；确定的远端删除则在详情 Query 已停用后移除精确缓存并刷新聚合消费者，避免 404 重试覆盖冲突 Draft。删除 Case 时移除其精确详情缓存，全量导入时移除该 Suite 的全部 Case 详情缓存；删除 Test Suite 后移除其详情和全部 Case 缓存，再刷新 Dashboard 与列表。历史运行快照不随当前 Case 修改或删除变化。

## 错误收敛

Suite 创建、编辑的名称或说明错误关联并聚焦当前表单。Case 结构化普通字段先由纯映射返回稳定路径，再关联、聚焦真实控件；Request Body、Assertion、服务端字段和完整 Case JSON 错误同样聚焦当前最近的编辑器，保存锁释放后再执行焦点恢复。复制与删除失败在当前模态容器内提供可访问反馈。批量导入错误同时展示 Case 顺序和 Case ID；关闭、成功或放弃导入时同时清空 React 文件状态与原生输入值，允许重新选择同一文件。引用、身份和并发冲突不自动覆盖。

## 观测与验收

千级 Case 列表保持可用。正在运行使用的测试集禁止删除。所有 Case 写入口呈现一致的校验结果。

## 相关测试

目标测试覆盖 CRUD、复制、导入回滚、分页、组合过滤、JSON 与结构化编辑一致性、删除确认、连续冲突、写操作单飞、缓存清理和错误定位。
