# Cortex Eval

Cortex Eval 正在按 `tasks/00_INDEX.md` 的 P0–P10 顺序实现。本仓库当前已完成 P0 工程基线；Contracts、Domain、SQLite、Local API、Web、Run、Evaluation、Work Package、Reporting、Analysis 和 Canonical Export 尚未对外注册。

## 当前可用能力

- 固定 Node.js 24、pnpm 11.3.0 和 Promptfoo 0.121.18。
- 运行现有 Python 数据转换测试和 TypeScript REST Runner 回归测试。
- 校验真实 REST/Eval Fixture 的 Case、18 条原始 Assertion、组件契约与 Secret，并通过隔离副本验证 Case ID 与 Assertion 类型顺序对齐。
- 校验 137 条完全展开的 Promptfoo Assertion 能力契约没有遗漏固定版本内置类型、`not-*`、动态 Redteam 类型和 `assert-set`。
- 运行 Runtime Doctor、真实 Promptfoo 预计算输出探针以及 Python/Ruby 内联 Assertion Smoke。
- 生成确定 Seed 的 1,000 Case 性能数据并运行统一 Benchmark Harness。

## 环境

当前只支持 macOS ARM64。项目命令要求 Node.js 24。`pnpm verify` 会在 Homebrew `node@24` 路径下执行实际门禁，不会链接或覆盖全局 Node。

```bash
brew install node@24
pnpm install
pnpm verify
```

运行数据统一写入项目根 `.cortex-eval/`，该目录不会进入版本控制。

## 事实入口

- 产品需求：`REQ.md`
- 技术方案：`TECH.md`
- 稳定事实索引：`spec/00_INDEX.md`
- Goal 任务索引：`tasks/00_INDEX.md`

未闭环能力不会出现在 API、OpenAPI、CLI Help、Web 导航或 Dashboard 中。
