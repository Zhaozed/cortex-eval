# Cortex Eval

Cortex Eval 是面向本地环境的 LLM 测试、评估、报告与分析平台。当前版本已按 `tasks/00_INDEX.md` 的 P0–P10 顺序完成：支持 Web/API 平台运行、离线 Work Package、结构化 Evidence、结果回传和 Canonical Export。

当前只支持 macOS ARM64、Node.js 24、pnpm 11.3.0 和 Promptfoo 0.121.18。最终功能状态以 [任务索引](tasks/00_INDEX.md) 和 [系统概览](spec/SYSTEM_OVERVIEW.md) 为准。

## 当前可用能力

- 通过同源 Web/API 管理 Test Suite、Case、Endpoint、LLM、Rubric Prompt 和 Case Analysis Prompt。
- 执行 REST → Evaluation → Report，并按需追加 Case Analysis。
- 在每个 Case 的评估结果内保留各 Assert 的 Metric、结果和 Diff；Analysis 另行保存结构化 Evidence。平台不限制 Case Assert 的构建类型，也不复现或干预 Promptfoo 的 Assert 执行流程。
- 为 Retry、Force 和重新分析创建新 Run/Execution 或 Analysis 版本，保留明确的来源关系，不覆盖来源结果。
- 导出不可变 Work Package，在离线环境分阶段执行或一次完成 Pipeline，再将 Report 和 Analysis 导回平台。
- 导出十类 Canonical JSONL 数据；独立接收端会复算计数、引用、实体 Hash 和文件 Hash 后原子发布。
- 运行 Runtime Doctor、覆盖率、性能、安全审计、OpenAPI 漂移检查和完整 Playwright E2E。

## 环境准备

项目命令要求 Node.js 24。`pnpm verify` 会显式使用 Homebrew `node@24`，不会链接或覆盖全局 Node。

```bash
brew install node@24
pnpm install
pnpm verify
```

如果配置引用 Gemini Secret，在启动服务前通过环境变量提供密钥。不要把真实密钥写入仓库：

```bash
export GOOGLE_API_KEY="<your-google-api-key>"
```

Endpoint 或 OpenAI-compatible 配置引用的其他 Secret 也使用相同方式提供，变量名必须与配置中的 `EnvSecretRef` 一致。

所有运行数据默认写入项目根目录 `.cortex-eval/`，该目录不会进入版本控制。

## 快速开始：Web 平台流程

启动本地 API 和 Web：

```bash
pnpm server:start
```

浏览器访问 `http://127.0.0.1:4310/`，然后按以下顺序操作：

1. 创建 Test Suite，并导入或编辑 Cases 与各自的 Assertions。
2. 创建 Endpoint 配置，声明 URL、请求模板、响应 Selector 和所需 Secret 引用。
3. 创建 Evaluator、Rubric Prompts；如需分析，再创建 Analyzer 和 Case Analysis Prompt。
4. 创建 Run，选择 `PIPELINE` 自动执行 REST、Evaluation 和 Report，或选择 `STAGED` 手动推进各阶段。
5. 在 Run 详情查看逐 Case REST/Eval 结果和 Report。
6. Report 完成后，按 `failed`、`errors` 或 `all` 选择 Case 发起 Analysis，并查看结构化 Evidence 和 Proposal。
7. 对 Proposal 执行接受、编辑后接受或拒绝。接受前系统会再次校验结果版本、Analysis Revision 和 Case Definition Hash。

平台 Run 创建时会冻结 Test Suite、Case、Endpoint、Evaluator 和 Rubric Prompt。之后修改当前资源不会改变已经创建的 Run；Analysis 使用发起分析时另行冻结的 Analyzer 和 Analysis Prompt。

## 离线 Work Package 流程

以下命令中的 ID 是 Web 或 API 创建资源后返回的 UUID。Local Server 必须处于运行状态，CLI 才能导出工作包或回传结果。

### 1. 导出并校验工作包

```bash
pnpm cli -- package export \
  --suite-id "<suite-id>" \
  --endpoint-config-id "<endpoint-config-id>" \
  --evaluator-config-id "<evaluator-config-id>" \
  --analyzer-config-id "<analyzer-config-id>" \
  --analysis-prompt-id "<analysis-prompt-id>" \
  --output "./exports/my-work-package"

pnpm cli -- package validate "./exports/my-work-package"
```

工作包只冻结非秘密输入和 Secret 变量名。当前工作包协议为 v2：`inputs/tests.jsonl` 每行一个测试 Case；REST 与标准化 Evaluation 分别输出 `executions/<execution-id>/rest-results.jsonl` 和 `normalized-eval.jsonl`。两类结果文件使用 `HEADER → CASE × N → FOOTER` 记录协议，Raw Promptfoo、Report 与 Analysis 仍保留各自的 JSON/Markdown 格式。独立本地 REST 脚本已移除，`rest run` 覆盖本地请求、并发、失败记录、重试和结果落盘能力。

根据根目录 `.env.example` 创建本地运行文件并填入真实值；该文件不要提交：

```bash
cp "./exports/my-work-package/.env.example" "./.cortex-eval/work-package.env"
chmod 600 "./.cortex-eval/work-package.env"
```

### 2. 一次执行完整 Pipeline

默认执行 REST → Evaluation → Report：

```bash
pnpm cli -- pipeline run "./exports/my-work-package" \
  --env-file "./.cortex-eval/work-package.env"
```

只有显式提供 `--analysis-selector` 才会追加 Analysis：

```bash
pnpm cli -- pipeline run "./exports/my-work-package" \
  --env-file "./.cortex-eval/work-package.env" \
  --analysis-selector failed
```

`--analysis-selector` 只允许 `failed`、`errors` 或 `all`。Pipeline 会在任何外部调用和 Execution 状态变更前完成所有已选阶段的环境与输入预检。

### 3. 分阶段执行

需要人工检查中间产物时，可以分阶段运行。后续命令使用 REST 命令返回的同一个 `<execution-id>`：

```bash
pnpm cli -- rest run "./exports/my-work-package" \
  --env-file "./.cortex-eval/work-package.env"

pnpm cli -- eval run "./exports/my-work-package" \
  --execution-id "<execution-id>" \
  --env-file "./.cortex-eval/work-package.env"

pnpm cli -- report build "./exports/my-work-package" \
  --execution-id "<execution-id>"

pnpm cli -- analyze run "./exports/my-work-package" \
  --execution-id "<execution-id>" \
  --selector all \
  --env-file "./.cortex-eval/work-package.env"
```

Report 只读取已经提交的规范化结果，不需要 Secret。Analyzer 直接调用冻结的模型配置，不经过 Promptfoo Evaluator Bridge。

### 4. Retry、Force 和版本关系

Retry 只重跑失败或缺少可信产物的 Case；Force 重新执行全部 Case：

```bash
pnpm cli -- pipeline run "./exports/my-work-package" \
  --env-file "./.cortex-eval/work-package.env" \
  --retry-failed "<source-execution-id>"

pnpm cli -- pipeline run "./exports/my-work-package" \
  --env-file "./.cortex-eval/work-package.env" \
  --force "<source-execution-id>"
```

两种命令都会创建新的 Execution ID 和输出目录。来源 Execution 保持不变；即使所有 Case 都可复用，新执行也会生成自己的版本身份和结果集合 Hash。

### 5. 将离线结果导回平台

先导入 Report，再导入同一 Execution 的 Analysis：

```bash
pnpm cli -- result import "./exports/my-work-package" \
  --execution-id "<execution-id>" \
  --type report

pnpm cli -- result import "./exports/my-work-package" \
  --execution-id "<execution-id>" \
  --type analysis
```

导入端会完整复算 Execution、Result Set、Artifact 和 Case 身份。重复导入相同事实会幂等成功；相同身份对应不同内容会返回冲突。查询不会使用 `select max` 猜测“最新结果”。

## Canonical 数据导出

Canonical Export 面向备份、迁移前校验和外部数据处理，不等同于可离线执行的 Work Package。

默认只导出 Artifact 元数据：

```bash
pnpm cli -- data export --output "./exports/canonical-data"
```

只有明确需要时才复制 Raw Promptfoo Evidence：

```bash
pnpm cli -- data export \
  --output "./exports/canonical-data-with-raw" \
  --include-raw-evidence
```

Raw Evidence 可能包含敏感 Provider 输出。服务端 Manifest 和 CLI 接收端都会独立校验本次显式授权；没有 `--include-raw-evidence` 时不会复制 Raw 内容。

导出目录包含：

```text
canonical-data/
├── manifest.json
├── reconciliation.json
├── entities/
│   ├── test-suites.jsonl
│   ├── test-cases.jsonl
│   ├── endpoint-configs.jsonl
│   ├── llm-configs.jsonl
│   ├── rubric-prompts.jsonl
│   ├── analysis-prompts.jsonl
│   ├── runs.jsonl
│   ├── case-results.jsonl
│   ├── eval-results.jsonl
│   └── case-analyses.jsonl
└── artifacts/                  # 仅在显式授权且源文件存在时包含 Raw Evidence
```

也可以直接读取 API 的 NDJSON Transport；若需要落盘目录，优先使用 CLI，因为 CLI 会完成独立对账和原子发布：

```bash
curl --fail-with-body --silent --show-error \
  -X POST "http://127.0.0.1:4310/api/v1/data/export" \
  -H "Content-Type: application/json" \
  -d '{"rawEvidenceIncluded":false}' \
  > "./exports/canonical-transport.ndjson"

curl --fail-with-body --silent --show-error \
  "http://127.0.0.1:4310/api/v1/openapi.json" \
  > "./exports/openapi.json"
```

## 数据流转

平台在线执行的数据流：

```text
当前资源
  Test Suite + Cases + Endpoint + Evaluator + Rubric Prompts
      │ 创建 Run 时冻结；之后不再读取当前值
      ▼
Run Snapshot
      ▼
REST：请求 Endpoint，保存每个 Case 的 Provider Output 或 REST Error
      ▼
Evaluation：Promptfoo 执行 Case 中的全部 Assertions
      │ 需要 Evaluator 的调用由临时 Bridge 转发给冻结 Evaluator
      │ Bridge 不识别、筛选或限制 Assert/Metric
      ▼
Normalized Eval：按 Case + Assert 保存 Metric、PASS/FAIL/ERROR、Diff 和 Hash
      ▼
Report：从规范化结果重算总计、按 Metric 统计和 Result Set Hash
      ▼
Analysis（显式）：选择 failed/errors/all，生成独立版本的结构化 Evidence 与 Proposal
      ▼
Proposal 决策：接受 / 编辑后接受 / 拒绝
```

离线执行和回传的数据流：

```text
平台当前资源
      ▼ 冻结非秘密输入
Work Package v2 + .env.example
      ▼ 每次运行创建新的 Execution ID
REST Artifact → Raw Promptfoo Evidence → Normalized Eval → Report → 可选 Analysis
      ▼ 完整对账
Report Import → Analysis Import
      ▼
平台 Imported Run（保留 Package ID、Execution ID、来源和结果 Hash）
```

Canonical Export 使用另一条只读数据链：

```text
平台 SQLite
  → 短时 Backup Snapshot
  → 十类稳定排序 JSONL + Artifact Presence/Inclusion
  → 服务端四类对账
  → NDJSON Transport
  → CLI 独立复算计数、引用、实体 Hash、文件 Hash
  → 原子发布导出目录
```

关键身份规则：

- Run/Execution 表示一次具体执行；Retry 和 Force 永远创建新身份。
- Eval Result 由 Run/Execution + Case 定位；同一 Case 内的 Assert 组件由 Metric 和完整 Definition 区分，不通过 Bridge 区分结果。
- Analysis 每次调用都有独立 ID、Input Hash、Result Hash 和 Revision；重新分析不会伪装成旧结果。
- Structured Evidence 是 Analysis 输出的一部分，包含固定来源、字段路径和非空结论，不能使用无法校验的整段字符串代替。

## CLI 命令参考

统一调用格式：

```bash
pnpm cli -- [--json] <命令> [参数] [选项]
```

所有命令都支持以下全局选项：

| 选项 | 默认行为 | 说明 |
| --- | --- | --- |
| `--json` | 关闭 | 使用一行一个事件的 NDJSON 机器协议；正常事件写 stdout，诊断写 stderr，适合脚本和 CI |
| `-h`, `--help` | 关闭 | 显示当前层级或具体命令的帮助，不执行命令 |

使用 `pnpm cli -- --help` 查看顶层命令，使用 `pnpm cli -- <一级命令> <二级命令> --help` 查看具体命令，例如 `pnpm cli -- pipeline run --help`。`help [command]` 可查看某个一级命令，例如 `pnpm cli -- help package`。

下文各执行、校验和导入命令的位置参数 `<path>` 表示 Work Package 根目录；`--output <path>` 和 `--env-file <path>` 的含义以各命令参数表为准。`<execution-id>` 表示该工作包内已有的 UUIDv7 Execution ID。除 `--json` 和帮助选项外，各命令参数与选项如下。

`--env-file` 必须指向 Work Package 外、不超过 8 MiB 的 owner-only 普通文件，不能使用符号链接，也不能向 group 或 other 开放任何权限。可使用 `chmod 600 <env-file>` 设置权限。显式 Env 文件中的值优先于同名进程环境变量。

### `package export`：导出 Work Package

```bash
pnpm cli -- package export \
  --suite-id <id> \
  --endpoint-config-id <id> \
  --evaluator-config-id <id> \
  --analyzer-config-id <id> \
  --analysis-prompt-id <id> \
  --output <path>
```

| 参数或选项 | 必填 | 说明 |
| --- | --- | --- |
| `--suite-id <id>` | 是 | 要冻结的 Test Suite UUIDv7 |
| `--endpoint-config-id <id>` | 是 | REST Endpoint 配置 UUIDv7 |
| `--evaluator-config-id <id>` | 是 | Evaluation 使用的 Evaluator 配置 UUIDv7 |
| `--analyzer-config-id <id>` | 是 | Analysis 使用的 Analyzer 配置 UUIDv7 |
| `--analysis-prompt-id <id>` | 是 | Analysis Prompt UUIDv7 |
| `--output <path>` | 是 | 新 Work Package 的目标目录 |

该命令没有命令级可选项，且要求 Local Server 已启动。目标目录用于发布不可变工作包，不会覆盖已有导出。

场景示例：

```bash
# 交互使用：导出一套可离线执行的冻结输入
pnpm cli -- package export \
  --suite-id "<suite-id>" \
  --endpoint-config-id "<endpoint-config-id>" \
  --evaluator-config-id "<evaluator-config-id>" \
  --analyzer-config-id "<analyzer-config-id>" \
  --analysis-prompt-id "<analysis-prompt-id>" \
  --output "./exports/release-candidate"

# 自动化使用：输出稳定 NDJSON 事件
pnpm cli -- --json package export \
  --suite-id "<suite-id>" \
  --endpoint-config-id "<endpoint-config-id>" \
  --evaluator-config-id "<evaluator-config-id>" \
  --analyzer-config-id "<analyzer-config-id>" \
  --analysis-prompt-id "<analysis-prompt-id>" \
  --output "./exports/ci-package"
```

### `package validate`：校验 Work Package

```bash
pnpm cli -- package validate <path>
```

| 参数或选项 | 必填 | 说明 |
| --- | --- | --- |
| `<path>` | 是 | 要校验的 Work Package 根目录；同时校验其中已有的 Execution 上下文 |

该命令没有命令级可选项，也不依赖 Local Server。

场景示例：

```bash
# 离线执行前人工校验
pnpm cli -- package validate "./exports/my-work-package"

# CI 中使用机器协议校验
pnpm cli -- --json package validate "./exports/my-work-package"
```

### `data export`：导出 Canonical 数据

```bash
pnpm cli -- data export --output <path> [--include-raw-evidence]
```

| 参数或选项 | 必填 | 默认行为 | 说明 |
| --- | --- | --- | --- |
| `--output <path>` | 是 | 无 | Canonical JSONL 的目标目录 |
| `--include-raw-evidence` | 否 | 不复制 Raw Evidence | 显式授权复制存在的 Promptfoo Raw Evidence；内容可能包含敏感 Provider 输出 |

该命令要求 Local Server 已启动。CLI 会独立复算计数、引用、实体 Hash 和文件 Hash，再原子发布目标目录。

场景示例：

```bash
# 常规备份或迁移预检：只导出实体和 Artifact 元数据
pnpm cli -- data export --output "./exports/canonical-2026-07-17"

# 受控审计：连同 Raw Promptfoo Evidence 一起导出
pnpm cli -- data export \
  --output "./exports/canonical-audit-2026-07-17" \
  --include-raw-evidence
```

### `rest run`：创建 Execution 并执行 REST

```bash
pnpm cli -- rest run <path> [选项]
```

| 参数或选项 | 必填 | 默认行为 | 说明 |
| --- | --- | --- | --- |
| `<path>` | 是 | 无 | Work Package 根目录 |
| `--env-file <path>` | 否 | 从当前进程环境读取 Secret | 使用符合前述安全约束的工作包外 Env 文件 |
| `--retry-failed <execution-id>` | 否 | 创建全新的 Execution | 以来源 Execution 创建新版本，复用可信的成功事实，只重跑失败或缺少可信产物的 Case |
| `--force <execution-id>` | 否 | 创建全新的 Execution | 以来源 Execution 创建新版本，并全量重跑 Case |
| `--rest-concurrency <count>` | 否 | 使用 Manifest 冻结的默认值 | 覆盖 REST 最大并发数，只允许 `1`–`64` 的整数 |
| `--eval-concurrency <count>` | 否 | 使用 Manifest 冻结的默认值 | 冻结给后续 Evaluation 的最大并发数，只允许 `1`–`16` 的整数 |
| `--analysis-concurrency <count>` | 否 | 使用 Manifest 冻结的默认值 | 冻结给后续 Analysis 的最大并发数，只允许 `1`–`8` 的整数 |

`--retry-failed` 与 `--force` 互斥。三个并发值会在创建 Execution 时一并冻结；分阶段执行时，即使当前命令只运行 REST，后续阶段仍使用这里冻结的值。

场景示例：

```bash
# 首次执行，并降低外部 Endpoint 压力
pnpm cli -- rest run "./exports/my-work-package" \
  --env-file "./.cortex-eval/work-package.env" \
  --rest-concurrency 2

# 仅重试失败或证据不完整的 Case，来源 Execution 保持不变
pnpm cli -- rest run "./exports/my-work-package" \
  --env-file "./.cortex-eval/work-package.env" \
  --retry-failed "<source-execution-id>"

# 创建一次全量重跑，并为后续阶段冻结并发值
pnpm cli -- rest run "./exports/my-work-package" \
  --force "<source-execution-id>" \
  --rest-concurrency 4 \
  --eval-concurrency 2 \
  --analysis-concurrency 1
```

### `eval run`：执行 Evaluation

```bash
pnpm cli -- eval run <path> --execution-id <id> [--env-file <path>]
```

| 参数或选项 | 必填 | 默认行为 | 说明 |
| --- | --- | --- | --- |
| `<path>` | 是 | 无 | Work Package 根目录 |
| `--execution-id <id>` | 是 | 无 | REST 阶段已成功的 Execution ID |
| `--env-file <path>` | 否 | 从当前进程环境读取 Secret | 从符合前述安全约束的工作包外 Env 文件读取 Evaluator Secret |

Evaluation 的并发数已在 `rest run` 创建 Execution 时冻结，不能在此命令中修改。合法 Assertion Fail 会产生完整结果，但 CLI 返回退出码 `1`。

场景示例：

```bash
# Secret 已通过 export 写入当前进程环境
pnpm cli -- eval run "./exports/my-work-package" \
  --execution-id "<execution-id>"

# 从工作包外的私有 Env 文件读取 Evaluator Secret
pnpm cli -- eval run "./exports/my-work-package" \
  --execution-id "<execution-id>" \
  --env-file "./.cortex-eval/work-package.env"
```

### `report build`：生成 Report

```bash
pnpm cli -- report build <path> --execution-id <id>
```

| 参数或选项 | 必填 | 说明 |
| --- | --- | --- |
| `<path>` | 是 | Work Package 根目录 |
| `--execution-id <id>` | 是 | Evaluation 阶段已成功的 Execution ID |

该命令没有命令级可选项，不读取 Secret，也不调用外部模型；它从已提交的规范化结果生成 JSON 和 Markdown Report。

场景示例：

```bash
# 评估完成后生成可读报告
pnpm cli -- report build "./exports/my-work-package" \
  --execution-id "<execution-id>"

# 在脚本中读取报告完成事件
pnpm cli -- --json report build "./exports/my-work-package" \
  --execution-id "<execution-id>"
```

### `analyze run`：执行 Case Analysis

```bash
pnpm cli -- analyze run <path> \
  --execution-id <id> \
  --selector <failed|errors|all> \
  [--env-file <path>]
```

| 参数或选项 | 必填 | 默认行为 | 说明 |
| --- | --- | --- | --- |
| `<path>` | 是 | 无 | Work Package 根目录 |
| `--execution-id <id>` | 是 | 无 | Report 阶段已成功的 Execution ID |
| `--selector <selector>` | 是 | 无 | `failed` 选择 Eval `FAIL`，`errors` 选择 `EVALUATION_ERROR`，`all` 选择前两类；`all` 不包含通过的 Case |
| `--env-file <path>` | 否 | 从当前进程环境读取 Secret | 从符合前述安全约束的工作包外 Env 文件读取 Analyzer Secret |

Analysis 的并发数已在创建 Execution 时冻结，不能在此命令中修改。

场景示例：

```bash
# 只分析断言失败的 Case，适合日常质量回归
pnpm cli -- analyze run "./exports/my-work-package" \
  --execution-id "<execution-id>" \
  --selector failed \
  --env-file "./.cortex-eval/work-package.env"

# 同时分析断言失败和评估系统错误，适合完整问题排查
pnpm cli -- analyze run "./exports/my-work-package" \
  --execution-id "<execution-id>" \
  --selector all \
  --env-file "./.cortex-eval/work-package.env"
```

### `pipeline run`：一次执行完整 Pipeline

```bash
pnpm cli -- pipeline run <path> [选项]
```

| 参数或选项 | 必填 | 默认行为 | 说明 |
| --- | --- | --- | --- |
| `<path>` | 是 | 无 | Work Package 根目录 |
| `--env-file <path>` | 否 | 从当前进程环境读取 Secret | 从符合前述安全约束的工作包外 Env 文件，为所有选中阶段读取同一份 Secret 快照 |
| `--retry-failed <execution-id>` | 否 | 创建全新的 Execution | 创建 Retry 新版本，只重新执行失败或缺少可信产物的 Case |
| `--force <execution-id>` | 否 | 创建全新的 Execution | 创建 Force 新版本，全量重跑 Case |
| `--rest-concurrency <count>` | 否 | 使用 Manifest 冻结的默认值 | REST 最大并发数，只允许 `1`–`64` 的整数 |
| `--eval-concurrency <count>` | 否 | 使用 Manifest 冻结的默认值 | Evaluation 最大并发数，只允许 `1`–`16` 的整数 |
| `--analysis-concurrency <count>` | 否 | 使用 Manifest 冻结的默认值 | Analysis 最大并发数，只允许 `1`–`8` 的整数；未追加 Analysis 时也会冻结供后续使用 |
| `--analysis-selector <selector>` | 否 | 不执行 Analysis | 追加 Analysis；取值为 `failed`、`errors` 或 `all`，语义与 `analyze run --selector` 相同 |

`--retry-failed` 与 `--force` 互斥。默认阶段为 REST → Evaluation → Report；只有提供 `--analysis-selector` 才追加 Analysis。Pipeline 会在开始外部调用和修改 Execution 状态前，完成所有选中阶段的输入、Secret 与 Runtime 预检。

场景示例：

```bash
# 常规回归：执行 REST、Evaluation 和 Report
pnpm cli -- pipeline run "./exports/my-work-package" \
  --env-file "./.cortex-eval/work-package.env"

# 完整诊断：追加所有失败与错误 Case 的 Analysis
pnpm cli -- pipeline run "./exports/my-work-package" \
  --env-file "./.cortex-eval/work-package.env" \
  --analysis-selector all \
  --analysis-concurrency 2

# 增量回归：基于已有执行创建 Retry 新版本
pnpm cli -- pipeline run "./exports/my-work-package" \
  --env-file "./.cortex-eval/work-package.env" \
  --retry-failed "<source-execution-id>"

# 压测前全量重跑，并显式控制各阶段并发
pnpm cli -- pipeline run "./exports/my-work-package" \
  --env-file "./.cortex-eval/work-package.env" \
  --force "<source-execution-id>" \
  --rest-concurrency 8 \
  --eval-concurrency 4
```

### `result import`：将离线结果导回平台

```bash
pnpm cli -- result import <path> --execution-id <id> [--type <report|analysis>]
```

| 参数或选项 | 必填 | 默认行为 | 说明 |
| --- | --- | --- | --- |
| `<path>` | 是 | 无 | Work Package 根目录 |
| `--execution-id <id>` | 是 | 无 | 要导入的完整 Execution ID |
| `--type <type>` | 否 | `report` | `report` 导入完整 Report 版本；`analysis` 导入同一 Execution 的 Analysis 版本 |

该命令要求 Local Server 已启动。通常先导入 Report，再导入 Analysis；重复导入相同事实会幂等成功，身份相同但内容不同会冲突。

场景示例：

```bash
# 省略 --type，默认导入 Report
pnpm cli -- result import "./exports/my-work-package" \
  --execution-id "<execution-id>"

# Report 成功导入后，再导入同一 Execution 的 Analysis
pnpm cli -- result import "./exports/my-work-package" \
  --execution-id "<execution-id>" \
  --type analysis
```

## 常用命令

```bash
# 查看全部 CLI 命令
pnpm cli -- --help

# 查看子命令帮助
pnpm cli -- help pipeline

# 使用 NDJSON 机器输出
pnpm cli -- --json package validate "./exports/my-work-package"

# 完整开发门禁
pnpm verify

# macOS ARM64 发布门禁；需要真实 Gemini 配置和 GOOGLE_API_KEY
pnpm verify:release
```

CLI 固定退出码：`0` 成功、`1` 合法 Eval Fail、`2` 输入或配置错误、`3` 外部或阶段系统错误、`4` 冲突或锁、`130` 取消。

## 事实入口

- [产品需求](REQ.md)
- [技术方案](TECH.md)
- [稳定事实索引](spec/00_INDEX.md)
- [系统流程](spec/SYSTEM_FLOWS.md)
- [CLI 契约](spec/ENTRYPOINTS/CLI.md)
- [Local Server 契约](spec/ENTRYPOINTS/LOCAL_SERVER.md)
- [测试与验收](spec/TEST.md)
- [Goal 任务索引](tasks/00_INDEX.md)

未闭环能力不会出现在 API、OpenAPI、CLI Help、Web 导航或 Dashboard 中。
