# P7：Work Package、CLI、重跑与导入基础

## 状态与依赖

- 状态：`PENDING`
- 依赖：P6

## 目标

发布完整 Schema 的不可变 Work Package v1，并交付当前已闭环阶段的离线 CLI、重跑和平台导入基础；完整 Report 导入入口由 P8 注册。

## 实现清单

- 导出完整 v1 输入：Tests、Endpoint、Evaluator、Analyzer、两类 Prompt、全部阶段 Env Key 和最终阶段依赖图。
- 实现 Manifest、Execution、Artifact 路径/Hash、权限、原子写入、符号链接防护、跨进程锁和遗留锁处理。
- Manifest 保存执行限制默认值与范围；Create Execution CLI 接受 Run/Analysis Execution Limits，在首个阶段前冻结到 `execution.json` 和 Context Hash。
- 统一注册离线 `package export/validate`、`rest run`、`eval run` 和当前 REST→Eval Pipeline。Report 完整导入尚未闭环，因此本阶段只实现 Import Parser/Application 基础，不注册 `result import` 命令。
- `--retry-failed` 创建新 Execution，复制 REST `SUCCEEDED` 和对齐 Eval `PASS/FAIL`，重新执行 REST `ERROR`、`EVALUATION_ERROR`、缺失 Eval 事实和新 REST 成功后的 `NOT_EVALUATED`。
- `--force` 创建新 Execution 并全量重新执行，不覆盖来源。
- CLI 普通模式中文；`--json` 使用 NDJSON stdout，诊断写 stderr，并实现稳定退出码。
- 实现平台导入的身份、对齐、幂等和冲突基础事务，等待 P8 Report 对账完成后注册入口。
- 提交无 Secret 的 Work Package v1 Golden Fixture；完成等价功能后删除旧 TS REST 运行器。

## TDD 与验证

- 真实多进程测试同包单写、不同包并行、锁恢复和 CLI 信号。
- 覆盖路径逃逸、符号链接、Hash 损坏、半写、权限、Env 缺失和已完成阶段覆盖。
- 覆盖重跑来源、复用 Hash、合法 `ok=false` 不重跑、Import 幂等与冲突。
- 覆盖来源缺少完整 Eval Artifact、REST 重试后补 Eval、REST 仍失败保持 NOT_EVALUATED 和新 Result Set Hash。
- 离线 REST/Eval 并发边界必须与平台一致，冻结后不可修改。
- 验证 Report/Analyze 文件槽位已在 v1 中，但命令尚未注册。
- 验证 `result import` 尚未出现在 CLI Help 或 OpenAPI。
- 查询模型测试使用预置离线来源 Run 验证 Source Type 映射；真正导入后的 Dashboard 与 Playwright 验收移到 P8。

## Spec 更新

- `spec/PACKAGES/WORK_PACKAGE.md`
- `spec/ENTRYPOINTS/CLI.md`
- `spec/APPLICATION/EXECUTION_IMPORTS.md`
- `spec/SYSTEM_FLOWS.md`
- `spec/ERROR_HANDLING.md`

## 完成标准

- v1 Manifest 不因 P8/P9 增加命令而变化。
- 同一 Execution 的已完成阶段不可覆盖。
- 旧 TS REST 运行器删除前，目标 CLI 的 REST、失败重跑和 `--force` 已完整覆盖。

## 阻塞条件

若 P8/P9 需要修改 v1 Schema，必须新建协议版本并先请求用户确认，禁止静默修改 Golden Fixture。
