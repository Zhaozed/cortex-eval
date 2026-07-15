# Web 应用

## 模块职责

Web 提供测试集、配置、运行、报告和分析的本地用户界面。模块负责页面路由、API Client、服务端状态、表单模型、可访问交互和用户可见错误。

Web 不直接依赖 Domain 或 Storage，不在浏览器内存保存运行事实，不复制后端业务校验和状态机。

## 边界与依赖

Web 只通过 Local Server API 读取和修改事实，依赖 Contracts 派生的客户端协议。TanStack Query 管理服务端缓存，TanStack Table 管理分页和过滤，React Hook Form 管理表单。

UI Primitive 只负责表现、可访问性和基础交互，不负责请求、状态机、业务校验或错误翻译。

## 实现状态

已落地资源管理与平台 Run/REST/Evaluation/Report/Analysis Web。当前注册 Dashboard 资源数量、统一最近 Run 与最新完整报告指标、Test Suite/Case、Endpoint、LLM、LLM Rubric Prompt、Case Analysis Prompt、Run 创建/详情、Report、Analysis 和平台 Retry/Force；Analysis 页面已完成冲突刷新、完整 Cursor 分页以及新 Proposal 与旧冲突 Draft 独立展示。

## 目标代码落点

`apps/web`

目标 Feature 为 `features/test-suites`、`features/configurations`、`features/runs`、`features/reports` 和 `features/analysis`。

## 当前代码事实入口

- [app.tsx](../../apps/web/src/app.tsx)：闭合路由、Feature 动态加载和 Query 根装配。
- [resource-api.ts](../../apps/web/src/lib/resource-api.ts)：Contracts 与请求上下文双重校验的资源 API Client、Query Key 和精确失效范围。
- [run-api.ts](../../apps/web/src/lib/run-api.ts)：Run HTTP/SSE 严格协议和请求身份校验。
- [report-page.tsx](../../apps/web/src/features/reports/report-page.tsx)：平台与离线导入统一 Report 页面。
- [feature-registry.ts](../../apps/web/src/features/feature-registry.ts)：当前导航与 Dashboard 能力贡献。
- [app-shell.tsx](../../apps/web/src/components/app-shell.tsx)：桌面外壳、跳转、焦点和小屏提示。
- [styles.css](../../apps/web/src/styles.css)：浅色本地实验室仪表台视觉、目标尺寸和 Reduced Motion。

## 当前样例与测试入口

- [Web component tests](../../apps/web/test)：路由、API 边界、表单、冲突、URL、缓存和可访问状态。
- [resource-management.spec.ts](../../apps/web/e2e/resource-management.spec.ts)：真实 SQLite/API 与生产 Vite 产物上的完整资源流程。
- [playwright.config.ts](../../apps/web/playwright.config.ts)：1440×900、1280×800 Reduced Motion 和 900px 小屏验收矩阵。

## 对外接口

Web 面向本地单用户，不提供认证、权限、租户或协作界面。所有状态修改通过本地 API，所有 Secret 只显示环境变量引用名称。

界面使用简体中文、浅色本地实验室仪表台视觉和桌面优先布局，正式验收 1440×900 与 1280×800。宽度小于 1024px 只显示可读提示，不实现完整移动流程；当前不提供深色主题。

## 核心流程

页面进入后从 API 恢复服务端事实。表单提交时先完成交互校验，再以 Contracts DTO 调用 API。成功后按 Feature 失效相关查询，失败时根据 Error Code 和字段路径定位错误。

生产路由按 Feature 动态加载。Local Server 同源提供静态产物和 `/api/v1`；脚本 CSP 只允许同源。Zod JIT 在主模块加载前由同源静态配置关闭，不放宽为 `'unsafe-eval'`。应用启动先验证 `Navigation.currentEntry.index`；能力缺失时只显示可访问错误，不挂载 Query、Feature 或资源写入口。

## 状态、事务与幂等

服务端是运行和资源事实源。浏览器刷新、路由切换或缓存失效不改变后端执行。重复提交的幂等与冲突由 Application 处理，Web 只展示结果。

资源写入发生 Revision 冲突时，页面读取最新 Snapshot 并保留本地 Draft。用户显式选择使用最新 Revision 重试或采用服务端版本；页面不自动覆盖或合并。API Client 在 Schema 后验证所有由请求固定的资源身份；Suite、Case 与配置的列表项、读取和带资源响应的写入若 ID、Kind、Suite 或 Definition Case ID 错配，统一按 `CLIENT_RESPONSE_INVALID` 拒绝，不能进入缓存、覆盖 Draft 或触发成功状态。Case 编辑 Session 只由本次成功详情读取建立，并冻结 Definition 与双 Revision；旧缓存刷新失败不开放编辑。Case 刷新确认远端已删除时进入独立接受状态，不生成虚假 Revision 或继续重取详情；原编辑器实例、模式、本地文本、Draft 与删除意图保持受保护，直至用户显式采用删除事实。显式重试若终态失败，原 owner 保留输入、显示清洗错误并恢复操作；Case 编辑错误以一次性事件回到同一编辑器。写入或冲突待决时，页面级门禁阻止关闭编辑容器、Esc、侧栏、应用内返回、浏览器前进后退和页面卸载，避免隐式丢弃 Draft；显式解决后恢复导航。浏览器历史使用位置哨兵和 `history.go` 恢复受阻遍历，不追加恢复条目、不截断既有前进栈；第三方或旧版未知 State 通过 `Navigation.currentEntry.index` 区分前进与后退并恢复原同源位置；成功提交通过独立的已提交导航入口原子解除门禁并离开。Test Suite 详情以 Suite ID 重建路由级状态，防止筛选、Cursor、编辑 Draft 或冲突状态跨 Suite 泄漏。

Suite 元数据 Sheet 同时冻结打开或显式采用 Snapshot 时的表单值和 Revision，后台 Query 更新不能改变当前 Session 的条件写 Token。Suite 删除把预检开始前的 Suite Snapshot 与成功返回的 Impact 原子绑定；确认只使用该 Snapshot Revision。409 后按 Suite、Impact 顺序刷新，全部成功后才替换整组确认事实；恢复请求由组件生命周期托管，卸载同时 Abort 并拒绝迟到结果继续读取 Impact 或写入共享 Query。失败或 Abort 不发布半成品，也不把新 Suite 与旧 Impact 拼接为可重试状态。

API Client 的服务端错误码从闭合错误响应 Schema 推导，客户端错误码显式列举；任意字符串不能进入状态机分支。

## 错误收敛

字段错误定位到表单字段或 Case 路径；运行冲突、过期分析和资源引用冲突使用明确页面状态，不通过 Toast 隐藏关键失败。

## 观测与验收

页面满足 WCAG 2.2 AA、键盘操作、可见焦点、表单错误关联、Reduced Motion、可读状态和稳定加载反馈。千级 Case 使用服务端分页。Feature 通过能力注册进入导航与 Dashboard，未实现能力不显示占位、伪数据或永久 Loading。

Dashboard 贡献按闭环注册：P4 提供资源数量；P5 提供最近平台 Run；P8 已扩展为显式区分来源的最近完整平台/离线导入 Run，并展示最近完整报告的有效通过率、覆盖率和按稳定 Metric 名称排序的第一项主要 Metric。所有卡片只读取服务端 DTO，不在前端重算。

## 相关测试

当前测试覆盖资源、Run、Report 与 Analysis API Client、请求/响应身份、路由、缓存失效、表单错误映射、Run 刷新恢复、取消、重跑、报告过滤/详情/导出、Analysis 当前版本与决策，以及可访问状态。真实 Playwright 覆盖离线 Report/Analysis 导入后的 Dashboard、Run、Report、Analysis 与 Test Suite 关联。源码架构门禁同时限制 `apps`、`packages` 与 `tooling` 的 TypeScript/TSX 文件不超过 1,000 个物理行。
