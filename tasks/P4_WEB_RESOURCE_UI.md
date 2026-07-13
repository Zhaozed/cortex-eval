# P4：Web 资源管理界面

## 状态与依赖

- 状态：`COMPLETED`
- 依赖：P3

## 目标

交付简体中文、桌面优先、可访问的资源管理 Web，不渲染未实现能力的占位内容。

## 实现清单

- 使用 React、Vite、shadcn/ui、TanStack Query/Table 和 React Hook Form。
- 采用浅色“本地实验室仪表台”视觉，目标尺寸为 1440×900 和 1280×800。
- 实现资源 Dashboard、测试集列表、Case 分页/搜索/组合过滤、创建/复制/删除和双编辑器。
- 结构化编辑保留 Assertion 完整 JSON；完整 JSON 模式共享 Draft，未知合法字段不得丢失。
- 实现 Endpoint、LLM、Rubric Prompt 和 Analysis Prompt 配置页面。
- Dashboard 通过 Feature Contribution 注册；本阶段只显示资源数量。

## TDD 与验证

- 组件测试覆盖表单映射、URL 状态、冲突和错误字段定位。
- Playwright 覆盖资源 CRUD、导入、搜索过滤、分页、双编辑切换和刷新恢复。
- 验证 WCAG 2.2 AA、键盘、焦点、标签、错误关联、Reduced Motion 和两个目标尺寸。
- 导航不得显示 Run、Report、Analysis 未实现入口。

## Spec 更新

- `spec/WEB/OVERVIEW.md`
- `spec/WEB/TEST_SUITES.md`
- `spec/WEB/CONFIGURATIONS.md`
- `spec/EXTERNAL_BEHAVIOR.md`

## 完成标准

- 资源用户流程完整可用，无伪数据、空占位或永久 Loading。
- Case 的全部 Promptfoo Assertion 字段可以无损编辑。
- 小于 1024px 显示明确可读提示，不承诺完整移动端流程。

## 验收记录

- 失败测试先锁定 API Client、表单映射、共享 Draft、409 冲突、字段定位、导入错误、引用删除门禁、静态路由与 CSP，再完成实现。
- 组件与集成测试覆盖 Dashboard、Test Suite/Case、四类配置、Query 失效、URL 恢复、失败不误关闭和冲突两种显式决策。
- Playwright 使用真实 SQLite/Application/Local Server 和生产 Vite 产物，覆盖 1440×900、1280×800 Reduced Motion、900px 小屏提示、键盘、axe 与 CSP。
- Web 源码已进入原全仓 90/85/90/90 覆盖率门禁；最近一次全仓覆盖率门禁为语句 90.97%、分支 85.84%、函数 92.79%、行 93.60%。
- `pnpm verify` 已通过 87 个 Vitest 文件、435 项测试、5 项生产 E2E、Python 7 项与旧 TypeScript 5 项回归、文档、Secret Fixture、OpenAPI 和生产构建门禁。
- 独立审查指出的删除缓存、配置路由状态、Case 非编辑写入 409、配置 Snapshot Revision、默认分页、更新时间、JSON 错误聚焦和 Rubric 引用三态均已先补回归测试再闭环。
- 第二轮独立审查指出的连续 409 基线刷新、Case 非编辑写操作单飞和 Test Suite 删除缓存移除均已先补失败测试再闭环。
- 第三轮独立审查指出的 Case 删除/导入详情缓存、资源删除冲突、模态错误反馈、Rubric 引用竞态、完整 JSON 服务端错误聚焦和配置写操作单飞均已先补失败测试再闭环。
- 第四轮独立审查指出的配置默认值、Analysis 允许变量、探测/变量字段聚焦和 Case 冲突可见 Draft 均已先补失败测试再闭环。
- 第五轮独立审查指出的 Suite 元数据单飞与字段错误、配置冲突缓存同步与竞争门禁、Rubric Prompt 使用冲突字段语义及配置删除详情缓存均已先补失败测试再闭环。
- 第六轮独立审查指出的 Case 冲突编辑冻结、配置本地契约错误映射、删除冲突列表同步、Suite 创建字段错误和导入同文件重选均已先补失败测试再闭环。
- 第七轮独立审查指出的全部写入编辑冻结、Suite/Case Snapshot 列表同步、Case/Prompt 本地字段聚焦和模态取消门禁均已先补失败测试再闭环。
- 第八轮独立审查指出的写入/冲突待决离开门禁已先补失败测试再闭环，覆盖编辑器关闭、Esc、侧栏、浏览器历史和页面卸载。
- 第九轮独立审查指出的 History 前进栈破坏和删除流程错误解除其他门禁已先补失败测试再闭环，改为位置哨兵恢复、已提交导航和删除预检互斥。
- 第十轮独立审查指出的未知 History State 遍历方向错误和测试事实计数过期已闭环；前者先补前进、后退双向失败测试，再以同源 Navigation Entry 绝对索引恢复原位置。
- 第十一轮独立审查指出的无 Navigation API 未闭合、跨 Suite 页面状态复用和 Case 写请求弱类型均已先补失败测试再闭环；资源 Web 改为能力检测失败即停止，Suite ID 成为路由状态边界，Case 输入直接由 Contracts 推导。
- 第十二轮独立审查指出的 Case 编辑冲突后远端删除可能丢失 Draft，以及条件删除冲突后远端已删除缺少显式接受决策，均已先补失败测试再闭环；两条路径现在使用 `REMOTE_CASE_DELETED` 联合状态，不伪造 Case Revision、不继续重取详情，并持续持有离开门禁直至显式采用删除事实。
- 第十三轮独立审查指出的远端删除重挂完整 JSON 编辑器和 Web 错误码退化为任意字符串，均已先补失败测试再闭环；修复方案审查进一步锁定旧缓存刷新成功/失败与普通冲突采用 Snapshot。Case 编辑现以本次成功读取建立 Definition/双 Revision Session，远端删除保留原实例、模式和文本；服务端错误码从闭合 API Schema 推导，客户端码显式列举。
- 第十四轮独立审查指出的详情响应身份错配、四类 Case 非编辑操作重试终态失败留在旧冲突，以及 Case 编辑重试未处理拒绝，均已先补失败测试再闭环；API Client 现校验请求/响应身份，恢复 Hook 统一清洗错误并回传最新 Revision，CaseEditor 以一次性事件复用普通保存的字段映射和聚焦。
- 第十五轮独立审查指出的写响应身份错配和详情页/测试文件超过 1,000 行均已先补失败测试再闭环；API Client 现校验所有请求已固定的 Suite、Case、Definition Case ID、配置 ID 与 Kind，错误写响应保留原 Draft 且不误判成功；详情列表面板和三类测试职责已拆分，并加入全仓 TypeScript/TSX 文件尺寸门禁。
- 第十六轮独立审查指出的 Case 更新请求 Definition ID、Suite 元数据实时 Revision 和删除影响实时 Revision 均已先补失败测试再闭环；元数据编辑冻结 Session Revision，删除把 Suite Snapshot 与 Impact 原子绑定并按 Suite、Impact 顺序刷新，失败或 Abort 不发布半成品确认事实。
- 第十七轮独立审查指出的 Suite 删除 409 恢复在卸载后仍可能发布迟到 Snapshot 已先补失败测试再闭环；恢复 Controller 现由组件托管，并以 mounted 门禁阻止迟到 Suite 继续读取 Impact 或污染共享 Query 缓存。
- 第十八轮独立变更审查未发现 P0、P1、P2 或 P3 问题，并确认三个外部测试样例未进入 P4 暂存范围。
- P4 门禁期间主分支新增 `5bb4fca` 并重命名已提交 Fixture；本阶段保留其转换逻辑和 REST runner 默认路径，只同步失效的工具、测试、Secret 门禁与事实源引用，并把 Python 测试期望对齐其 Planner 消息键。
- 官方 npm registry 的 `pnpm audit --audit-level=high` 为 0 已知漏洞；漏洞传递依赖已通过 Workspace 精确补丁版本闭合。
- Run、Report、Analysis、Work Package 与目标 CLI 仍未注册。

## 阻塞条件

若结构化编辑会丢失 Promptfoo 合法字段，停止该字段的结构化映射并保留完整 JSON 编辑能力。
