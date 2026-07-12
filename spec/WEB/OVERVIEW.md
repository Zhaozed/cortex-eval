# Web 应用

## 模块职责

Web 提供测试集、配置、运行、报告和分析的本地用户界面。模块负责页面路由、API Client、服务端状态、表单模型、可访问交互和用户可见错误。

Web 不直接依赖 Domain 或 Storage，不在浏览器内存保存运行事实，不复制后端业务校验和状态机。

## 边界与依赖

Web 只通过 Local Server API 读取和修改事实，依赖 Contracts 派生的客户端协议。TanStack Query 管理服务端缓存，TanStack Table 管理分页和过滤，React Hook Form 管理表单。

UI Primitive 只负责表现、可访问性和基础交互，不负责请求、状态机、业务校验或错误翻译。

## 实现状态

目标 Web 应用尚未落地。

## 目标代码落点

`apps/web`

目标 Feature 为 `features/test-suites`、`features/configurations`、`features/runs`、`features/reports` 和 `features/analysis`。

## 当前代码事实入口

尚无当前 Web 代码入口。

## 当前样例与测试入口

当前 Fixture 可用于后续页面和契约测试，统一登记在 [00_INDEX.md](../00_INDEX.md)。

## 对外接口

Web 面向本地单用户，不提供认证、权限、租户或协作界面。所有状态修改通过本地 API，所有 Secret 只显示环境变量引用名称。

界面使用简体中文、浅色本地实验室仪表台视觉和桌面优先布局，正式验收 1440×900 与 1280×800。宽度小于 1024px 只显示可读提示，不实现完整移动流程；当前不提供深色主题。

## 核心流程

页面进入后从 API 恢复服务端事实。表单提交时先完成交互校验，再以 Contracts DTO 调用 API。成功后按 Feature 失效相关查询，失败时根据 Error Code 和字段路径定位错误。

## 状态、事务与幂等

服务端是运行和资源事实源。浏览器刷新、路由切换或缓存失效不改变后端执行。重复提交的幂等与冲突由 Application 处理，Web 只展示结果。

## 错误收敛

字段错误定位到表单字段或 Case 路径；运行冲突、过期分析和资源引用冲突使用明确页面状态，不通过 Toast 隐藏关键失败。

## 观测与验收

页面满足 WCAG 2.2 AA、键盘操作、可见焦点、表单错误关联、Reduced Motion、可读状态和稳定加载反馈。千级 Case 使用服务端分页。Feature 通过能力注册进入导航与 Dashboard，未实现能力不显示占位、伪数据或永久 Loading。

Dashboard 贡献按闭环注册：P4 提供资源数量；P5 提供最近平台 Run、阶段、状态和 Source Type，并让测试集列表显示最近 Run 状态；P8 在注册 Report 导入入口后增加离线导入来源，以及最近完整报告的有效通过率、覆盖率和主要 Metric。所有卡片只读取服务端事实。

## 相关测试

目标测试覆盖 API Client、路由、缓存失效、表单错误映射、刷新恢复、取消、可访问性和五个 Feature 的主路径。
