# Cortex Eval

Cortex Eval 正在按 `tasks/00_INDEX.md` 的 P0–P10 顺序实现。本仓库当前已完成 P0–P4：Contracts、Domain、十表 SQLite、资源 Application、Local API 和资源管理 Web 已落地。Run、Evaluation、Work Package、Reporting、Analysis、Canonical Export 和目标 CLI 尚未注册。

## 当前可用能力

- 固定 Node.js 24、pnpm 11.3.0 和 Promptfoo 0.121.18。
- 运行现有 Python 数据转换测试和 TypeScript REST Runner 回归测试。
- 校验真实 REST/Eval Fixture 的 Case、18 条原始 Assertion、组件契约与 Secret，并通过隔离副本验证 Case ID 与 Assertion 类型顺序对齐。
- 校验 137 条完全展开的 Promptfoo Assertion 能力契约没有遗漏固定版本内置类型、`not-*`、动态 Redteam 类型和 `assert-set`。
- 运行 Runtime Doctor、真实 Promptfoo 预计算输出探针以及 Python/Ruby 内联 Assertion Smoke。
- 生成确定 Seed 的 1,000 Case 性能数据并运行统一 Benchmark Harness。
- 通过同源 Web/API 管理 Test Suite、Case、Endpoint、LLM、LLM Rubric Prompt 和 Case Analysis Prompt。
- 使用服务端分页、组合过滤、Case 双编辑器、原子导入导出、配置探测、Prompt 预览与引用影响。
- 在 1440×900、1280×800 Reduced Motion 和小于 1024px 提示场景运行生产 Playwright E2E。

## 环境

当前只支持 macOS ARM64。项目命令要求 Node.js 24。`pnpm verify` 会在 Homebrew `node@24` 路径下执行实际门禁，不会链接或覆盖全局 Node。

```bash
brew install node@24
pnpm install
pnpm verify
```

启动资源管理 Web 与本地 API：

```bash
pnpm server:start
```

浏览器访问 `http://127.0.0.1:4310/`。当前导航只显示已闭环资源能力。

运行数据统一写入项目根 `.cortex-eval/`，该目录不会进入版本控制。

## 事实入口

- 产品需求：`REQ.md`
- 技术方案：`TECH.md`
- 稳定事实索引：`spec/00_INDEX.md`
- Goal 任务索引：`tasks/00_INDEX.md`

未闭环能力不会出现在 API、OpenAPI、CLI Help、Web 导航或 Dashboard 中。
