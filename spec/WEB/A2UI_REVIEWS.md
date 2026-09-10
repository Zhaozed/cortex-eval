# 固定 A2UI 回放历史归档

## 职责与边界

固定模板回归不再作为产品评测流程：移除运行页的模板入口、导入命令和人工审批操作。产品的 A2UI 模板库不受影响。历史文件不删除、不改写，旧 `/a2ui-reviews`、`/runs/templates` 书签仅提供只读归档。

业务 A2UI 验收属于对应 E2E Case：自动断言检查业务与结构，真实 Web 截图由 UI／产品人工审核。本期没有实现真实 Run／Case 截图采集与绑定，业务报告只能显示“未采集”，不能显示已通过、无需审核或用固定回放替代。没有 AI 视觉、像素差异、按钮测试或 iOS 自动化。

## 历史证据与状态

历史批次保留自动、采集、人工三个独立状态及原审批记录。人工批准不能掩盖自动失败。页面可查看全部图片、原始 JSON、审核人、时间、备注和历史版本，但没有编辑或审批控件。截图加载失败明确提示；原始证据和图片下载仍检查 SHA256 与内容完整性。

数据继续保存在 `.cortex-eval/a2ui-reviews`。Run 删除不级联删除历史附件；原 runId 仅为历史参考，不证明截图来自该 Run。标准 Report、Artifact Manifest、Canonical Export 及业务自动通过率不变。

## 接口与停用

[路由](../../apps/local-server/src/a2ui-review-routes.ts) 保留 GET 列表、详情、图片与原始证据，复用 Host／Origin／CSP 安全边界。历史导入和 decisions POST 标记 deprecated，合法旧请求返回 HTTP 410 与停用原因；无效请求仍遵守契约校验，跨源写入仍拒绝。没有新的 HTTP 写入口。底层存储的历史写逻辑保留给兼容与隔离测试，不是可用业务流程。

## 事实入口与验证

- [契约](../../packages/contracts/src/a2ui-review-contracts.ts)：历史记录结构。
- [归档页面](../../apps/web/src/features/a2ui-reviews/a2ui-review-page.tsx)：只读图片、独立状态、错误与历史。
- [证据校验](../../apps/local-server/src/a2ui-review-evidence.ts)：哈希、分组与状态完整性。
- [附件存储](../../apps/local-server/src/a2ui-review-store.ts)：历史文件兼容，不改现存数据。
- [HTTP 测试](../../apps/local-server/test/a2ui-review-routes.test.ts)：同源、停用返回、证据读取和记录不变。
- [页面测试](../../apps/web/test/a2ui-review-page.test.tsx)：只读历史、无审批入口、图片及查询错误。
- [报告页面](../../apps/web/src/features/reports/report-page.tsx)：未采集为非交互状态，不提供虚假审核动作。
