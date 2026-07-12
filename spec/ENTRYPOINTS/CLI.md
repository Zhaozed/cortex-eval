# CLI

## 模块职责

CLI 负责参数解析、用户消息、进度展示、稳定机器输出、平台 API 调用和离线阶段用例调用。

CLI 不直接访问平台 SQLite，不复制状态机、统计、Case 写入或导入对账规则。

## 边界与依赖

平台命令依赖本地 HTTP API。离线命令依赖 Work Package、Contracts 和阶段 Application 用例。CLI 文案从消息资源加载；`--json` 使用 NDJSON，stdout 只输出机器协议，诊断写 stderr。

## 实现状态

目标 `apps/cli` 尚未落地。当前存在独立 REST 运行器 CLI，但它不代表目标工作包协议。

## 目标代码落点

`apps/cli`

## 当前代码事实入口

- [run_promptfoo_rest_cli.ts](../../data_scripts/run_promptfoo_rest_cli.ts)
- [run_promptfoo_rest.ts](../../data_scripts/run_promptfoo_rest.ts)

## 当前样例与测试入口

- [run_promptfoo_rest.test.ts](../../data_scripts/run_promptfoo_rest.test.ts)
- [run_promptfoo_rest.md](../../data_scripts/run_promptfoo_rest.md)

当前脚本支持 REST 请求、并发、超时、续跑和原子结果写入，但其输出与错误结构不是目标规范化 Work Package 契约。

## 对外接口

目标命令包括 `package export`、`package validate`、`rest run`、`eval run`、`report build`、`analyze run`、`pipeline run`、`result import` 和 `data export`。命令按阶段能力注册，未实现命令不出现在 Help。

## 核心流程

CLI 解析参数并校验阶段输入。平台命令调用 HTTP API；离线命令验证 Manifest 和 Execution，调用对应阶段用例，再展示结构化进度和结果路径。

离线 Pipeline 默认 REST、Eval、Report。P9 注册 Analysis 后，显式选择 Analysis 必须已有或同时选择 Report，并提供 Analyzer、Analysis Prompt 和 Case Selector。依赖缺失返回输入错误；Analysis 外部失败返回退出码 3，但不改变已完成 Report Artifact；无可分析 Case 以零结果成功结束。

## 状态、事务与幂等

每次离线执行使用新的 Execution ID。后续阶段读取同一 Execution 已完成产物，已完成阶段不可覆盖。`--retry-failed` 和 `--force` 创建新 Execution，不修改来源。相同结果重复导入由平台 Application 处理幂等。

## 错误收敛

参数、环境、锁、文件和阶段错误映射为稳定 Error Code 与非零退出码。退出码固定为 0 成功、1 Eval Fail、2 输入/配置、3 外部或阶段系统错误、4 冲突/锁、130 取消。Assertion 失败不得误报为 Promptfoo 系统错误。

## 观测与验收

普通模式展示简洁阶段进度和结果路径；机器模式只输出稳定协议。日志与终端不显示 Secret、完整 Prompt、Provider Output 或第三方堆栈。

## 相关测试

目标测试覆盖参数解析、阶段独立执行、Pipeline、环境变量分阶段校验、同包锁、取消、机器输出、导出和幂等导入。
