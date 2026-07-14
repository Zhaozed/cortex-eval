# P7：Work Package、CLI、重跑与导入基础

## 状态与依赖

- 状态：`COMPLETED`
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
- 覆盖 Manifest/Execution/输入文件固定上限，以及 Canonical Case 16 MiB、REST Case 32 MiB、Normalized Case 32 MiB、Raw Row 64 MiB、解码 JSON String 16 MiB 的解析前字节门禁；不得用 REST/Normalized/Raw 总文件上限替代逐项流式处理。
- 覆盖重跑来源、复用 Hash、合法 `ok=false` 不重跑、Import 幂等与冲突。
- 覆盖来源缺少完整 Eval Artifact、REST 重试后补 Eval、REST 仍失败保持 NOT_EVALUATED 和新 Result Set Hash。
- 离线 REST/Eval 并发边界必须与平台一致，冻结后不可修改。
- 验证 Report/Analyze 文件槽位已在 v1 中，但命令尚未注册。
- 验证 `result import` 尚未出现在 CLI Help 或 OpenAPI。
- 查询模型测试使用预置离线来源 Run 验证 Source Type 映射；真正导入后的 Dashboard 与 Playwright 验收移到 P8。

## Spec 更新

- `REQ.md`
- `TECH.md`
- `spec/00_INDEX.md`
- `spec/SYSTEM_OVERVIEW.md`
- `spec/PACKAGES/WORK_PACKAGE.md`
- `spec/ENTRYPOINTS/CLI.md`
- `spec/APPLICATION/EXECUTION_IMPORTS.md`
- `spec/SYSTEM_FLOWS.md`
- `spec/ERROR_HANDLING.md`
- `spec/INTERNAL_BEHAVIOR.md`
- `spec/TEST.md`
- `spec/DECISION_LOG.md`

## 当前收口事实

- Work Package v1 安全文件运行时、平台导出 API、Execution/Artifact、REST/Eval/Pipeline CLI、Retry/Force、严格 Evaluation Result Reader、Import 身份基础和 Golden Fixture 已实现。
- 当前 Pipeline 只注册 REST→Evaluation，并在 REST 外部调用和写 Execution 前用同一 Secret Snapshot 完成全部阶段预检；预检读取完整 Evaluator/Rubric Prompt、验证 Case Prompt 引用、固定 Promptfoo 精确版本和实际需要的 Python/Ruby Runtime。
- 普通严格 Evaluation Reader 支持连续 Retry：复用结果保持祖先 Raw Evidence，并沿 Execution Provenance 验证来源 Result 与最终 Raw，不把证据伪装为当前执行所有。
- 固定 Promptfoo 版本预检不依赖 Assert 类型或解释器需求；真实 Promptfoo Raw 使用可回收 Source 分别流式写 Artifact 和逐 Row 导入，不再整文件读取或解析。子进程取消收敛为 `EVALUATOR_CANCELLED` 和 CLI 130，不登记部分 Artifact。
- Work Package Evaluation 以 owner-only SQLite 按 128 Case 批次暂存 Case/REST/复用/导入结果，向 Engine 提供两遍可重放 Source，并按 Ordinal 直接流式生成最终 Normalized；不保留随 1.25 GiB 输入线性增长的大对象数组或 Map。
- CLI 取消信号贯穿 REST 执行、Artifact 发布与登记，以及 Runtime Preflight、Engine、Raw、逐 Row 导入、Normalized 和最终提交；REST 发布前或发布后取消收敛为 `REST_CANCELLED`，Raw Source/staging 清理失败只报告，不覆盖成功、业务失败或取消。固定 Promptfoo 版本证明最长复用 30 秒，且每次精确复核规范路径和文件身份。
- Raw/Normalized 已发布但未登记时在当前命令返回前凭非持久发布身份补偿删除；导出 staging 或 Evaluation 清理失败经脱敏旁路观察器报告，不能覆盖业务错误、目标冲突或取消。已识别 JSON 命令的参数错误输出严格 `COMMAND_ERROR`，内部文件校验码归一为公开 Work Package 输入错误。
- REST Artifact 登记失败或发布后取消同样在当前命令按发布句柄删除未登记文件；启动恢复没有发布身份，只保留并报告孤儿，不按路径删除，也不承担正常失败补偿。工作包导出在响应完整消费前失败或取消时主动取消未读 Body，回收失败不覆盖主错误。
- 不可变文件 Link 与完整目录 Rename 只有在父目录同步后才提交成功；发布后同步失败会按文件身份撤销可见目标，清理或观察器失败不覆盖首次错误。
- CLI 对工作包私有输入、Hash、路径、目标冲突、导出流和内部不变量错误执行闭合公开映射，私有码不进入机器输出或诊断。
- `package export` 在网络请求前完成目标父目录 Owner/TTL 恢复；死亡 Owner、PID 复用和持续 ownerless staging 可清理，存活 Owner 与身份变化目录保留。
- Case/REST、复用结果和 Raw 导入结果均按 128 项 SQLite 事务批次提交，异常回滚当前批次；Normalized Writer 按 Manifest ordinal 身份逐项校验，不再保存线性增长的 Case Key Set。
- Link/Rename 同步失败补偿只操作设备号/inode 仍匹配刚发布对象的目标，并发替换后的路径保持不动并记录清理失败。
- 正式导出目标拒绝 `.cortex-export-*` 恢复保留前缀；Endpoint、Evaluator 和 Rubric Prompt 在实际消费时再次校验 Manifest Hash 与大小。
- Normalized Writer 与 Eval Result Set Hasher 都从已验证 Manifest 按 Ordinal 获取 Case 身份，不保存随 Case 数线性增长的第二份 Key Set。
- Normalized Writer 与 Eval Result Set Hasher 在提交时确认 Manifest 已无下一 Case，非空前缀不得生成 Result Set Hash 或发布 Artifact。
- 未登记 Artifact 只在固定槽位、Descriptor Hash/大小、发布时设备/inode 及清理时稳定身份全部匹配时删除；相同字节的新 inode 也作为替换对象保留并报告清理失败。REST/Normalized Writer 都校验 Manifest Case Key 和完整终止；`RUNNING/ERROR` 阶段禁止携带 Artifact。
- 完整 `pnpm verify` 已通过 160 个 Vitest 文件、943 项测试、Playwright 7 项和 Python 7 项；覆盖率 Statements 90.06%（9728/10801）、Branches 85.25%（6239/7318）、Functions 92.30%（2100/2275）、Lines 93.31%（9028/9675），其余确定性门禁全部通过。
- Execution Import 幂等同时比较 Package、Execution、Result Set 与规范化 Artifact Manifest 全部事实，Manifest 任一 Kind、路径、Hash、大小或 Contract Version 漂移都返回冲突。
- 旧 TypeScript REST 运行器已在等价命令与重跑覆盖后删除。
- 最终独立 change reviewer 未发现 P0/P1；两个 P2 已按失败测试闭合，完整门禁复验通过。

## 完成标准

- v1 Manifest 不因 P8/P9 增加命令而变化。
- 同一 Execution 的已完成阶段不可覆盖。
- 旧 TS REST 运行器删除前，目标 CLI 的 REST、失败重跑和 `--force` 已完整覆盖。

## 阻塞条件

若 P8/P9 需要修改 v1 Schema，必须新建协议版本并先请求用户确认，禁止静默修改 Golden Fixture。
