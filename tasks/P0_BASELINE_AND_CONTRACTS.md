# P0：事实源、工具链与契约探针

## 状态与依赖

- 状态：`PENDING`
- 依赖：无

## 目标

先消除目标文档冲突，再建立可重复的工程工具链、真实 Fixture 基线、Promptfoo 精确版本能力清单和性能测量基础。

## 实现清单

- 把本轮全部确认决策同步到 `REQ.md`、`TECH.md` 和相关 spec，入口保持为 `spec/00_INDEX.md`。
- 建立 Node 24、pnpm Workspace、精确依赖和 `pnpm-lock.yaml`，提供格式、Lint、类型、测试、覆盖率、构建、架构和文档检查脚本。
- 创建 `.cortex-eval/` 运行目录约定并整体加入 `.gitignore`；测试使用隔离目录。
- 扫描未跟踪真实 REST/Eval Fixture 的 Secret，确认安全后纳入契约测试数据。
- 使用 Promptfoo `0.121.18` 对真实 Fixture 验证预计算 `providerOutput`、退出码、组件结果和 Importer 所需结构。
- 冻结 `0.121.18` 全 Assertion 能力矩阵：每种类型、`not-*`、Payload、Evaluator/解释器/外部协议依赖，以及拒绝边界。
- 实现 Runtime Doctor：固定 Node 24；Python 使用 `PROMPTFOO_PYTHON` 或 `python3` 且不低于 3.7；Ruby 使用 `PROMPTFOO_RUBY` 或 `ruby`。记录实际命令与版本，并分别运行最小内联 Assertion Smoke。
- 获取并记录 Gemini、OpenAI-compatible、Promptfoo 所需官方文档事实；实现阶段不得依靠记忆猜 API。
- 建立确定 Seed 的 1,000 Case 生成器和统一 Benchmark Harness。
- 新增 README 初稿，说明当前实现状态和目标启动方式。

## TDD 与验证

- 先运行并保留当前 Python、TypeScript 测试基线。
- 为版本、Fixture Schema、能力矩阵覆盖、文档链接和 Secret 扫描写失败测试。
- Doctor 覆盖解释器成功、缺失、版本不满足和命令不可执行；不自动安装解释器或语言依赖。
- `pnpm verify` 在本阶段允许只运行已经注册的测试族，但命令结构和失败传播必须完整。
- Benchmark 记录 macOS、芯片、CPU、内存、Node、pnpm、SQLite 和 Promptfoo 版本。

## Spec 更新

- `REQ.md`
- `TECH.md`
- `spec/00_INDEX.md`
- `spec/SYSTEM_OVERVIEW.md`
- `spec/DECISION_LOG.md`
- `spec/TEST.md`
- 所有受本轮新决策直接影响的模块 spec

## 完成标准

- 旧事实源与新决策不再冲突。
- Promptfoo 能力矩阵可由自动测试证明无漏项。
- 工具链、真实 Fixture 和性能 Harness 可重复运行。
- 未开始实现的功能仍明确标记为目标状态。

## 阻塞条件

Promptfoo `0.121.18` 无法可靠提供预计算输出、全 Assertion 能力或组件对齐事实时，保存最小复现并请求用户决定是否调整版本或契约。
