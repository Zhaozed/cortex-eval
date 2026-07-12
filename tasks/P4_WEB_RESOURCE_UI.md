# P4：Web 资源管理界面

## 状态与依赖

- 状态：`PENDING`
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

## 阻塞条件

若结构化编辑会丢失 Promptfoo 合法字段，停止该字段的结构化映射并保留完整 JSON 编辑能力。
