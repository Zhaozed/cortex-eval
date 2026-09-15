# Cortex Eval 本次开发交付说明

日期：2026-09-15。目标：Gitea `liuxu/cortex-eval` 的 `zzy1` 分支。

## 开发范围与 spec 对应

- 未提交 Evaluation/Report 失败阶段原 Run 重试：`spec/APPLICATION/RUNS.md`、`spec/PACKAGES/STORAGE_SQLITE.md`、`spec/DECISION_LOG.md`。
- Evaluator 瞬态错误有界重试、grader ERROR 与质量 FAIL 区分、安全诊断：`spec/PACKAGES/EVALUATION_ADAPTERS.md`、`spec/ERROR_HANDLING.md`、`spec/PACKAGES/CONTRACTS.md`。
- Provider 失败信封的部分证据贯通 Hash、SQLite、Artifact、工作包与导出：`spec/PACKAGES/CONTRACTS.md`、`spec/PACKAGES/STORAGE_SQLITE.md`、`spec/PACKAGES/WORK_PACKAGE.md`。
- 多轮输入/回复/Trace/A2UI 与执行进度：`spec/WEB/E2E_EVIDENCE.md`、`spec/WEB/RUNS.md`。
- 人工复核最终结论与执行失败不可覆盖：`spec/WEB/RUNS.md`、`spec/WEB/A2UI_REVIEWS.md`、`spec/DECISION_LOG.md`，并同步报告与分析界面说明。
- Agent 规则结构化编辑、请求体编辑与 Todo 回归用例：`spec/WEB/TEST_SUITES.md`、`spec/PACKAGES/CONTRACTS.md`、`spec/TEST.md`。
- Run Detail 与 OpenAPI 同步：`spec/ENTRYPOINTS/LOCAL_SERVER.md`、`spec/PACKAGES/CONTRACTS.md`。

## 交付边界

推送包含当前仓库已有但未推送的提交及本次工作树源码、测试、用例和文档。不包含父目录杂项、node_modules、本地运行数据库、临时诊断文件、缓存、截图或环境 Secret。检查期间新出现的 `test_suite/feishu-e2e/` 属于并行新增内容，本次保留在本地，不混入已经审查的交付范围。

`docs/attribution-bridge-2026-09-14.md` 仍为设计稿，完整的断言归属桥接算法不作为本次已交付能力。已有真实验证记录属于其记录时间和样本，不等于本次全量验收。

本次仅修正格式并补全事实文档，不通过禁用 lint、降低覆盖率阈值或修改测试预期制造门禁通过。发现的门禁失败按实际结果记录。

## 推送前校验

本次是分支同步，不是发布验收通过。`pnpm verify` 未通过；以下为 2026-09-15 对本次交付范围实际执行的结果。

- Runtime、格式、架构、TypeScript 类型、OpenAPI、文档链接、既有 Fixture Secret 扫描和 `git diff --check`：通过。首轮发现 12 个格式文件，已仅作格式修正。
- lint：全目录 `pnpm lint` 报 101 个错误，包含本地被 Git 忽略的临时诊断文件；另对本次交付范围加全部已跟踪脚本共 668 个文件执行 ESLint，仍有 88 个错误、2 个警告。错误包括测试非空断言、未使用符号、未声明返回类型、unsafe 类型访问，以及 4 个 Todo 脚本未纳入 TypeScript Project Service。未修改 lint 规则或伪报通过。
- `pnpm test:coverage`：264 个测试文件通过、1 个跳过；1,569 项测试通过、1 项跳过。但覆盖率门禁失败：Statements 88.43% < 90%，Branches 82.74% < 85%，Functions 87.23% < 90%；Lines 91.40% 达标。
- Playwright E2E：使用独立端口 14310 和测试隔离数据库，未复用或停止本地 4310 服务。12 项中 7 通过、4 失败、1 跳过。两种桌面尺寸的 Run 用例均未找到 `评测记录完成 1/1`；1280 与 1024 的资源管理用例触发颜色对比度检查失败。该结果只证明这些验收断言失败，不据此推断 REST 或报告执行本身失败。
- Python 遗留测试：22 项通过。
- Todo 离线合成校验：双平台 307 项检查通过；单平台边界 18 个 Case、20 条正确轨迹与 113 条反例校验通过。没有调用真实 Agent/Judge、导入测试集或操作第三方业务任务。
- `pnpm build`：通过；存在主 bundle 超过 500 kB 的构建警告。
- 待推送变更凭证模式扫描：323 个变更文件，命中仅为脱敏单元测试中的固定伪凭证；未发现真实凭证模式。模式扫描不是不存在任何敏感数据的绝对保证。
- `pnpm verify:release` 与真实模型/第三方业务验收：未执行。当前确定性门禁未通过，不能声明可发布。

## 尚未通过的门禁

保留 lint、覆盖率和上述 E2E 失败供后续开发修复；本次未扩大为业务代码修复，不降低质量门槛。完整本地执行日志位于 `/tmp/cortex-eval-prepush-20260915.log`、`/tmp/cortex-eval-prepush-tests-20260915.log`、`/tmp/cortex-eval-prepush-e2e-20260915.log`、`/tmp/cortex-eval-prepush-lint-20260915.json`。这些临时日志不纳入仓库。
