# Local Server

## 模块职责

Local Server 启动本地 HTTP 服务，装配 Application、Repository 和外部 Adapter，负责 Route、协议 Mapper、生命周期和安全入口。

模块不保存业务规则，不直接计算统计、转换运行状态或解析第三方业务结果。

## 边界与依赖

Local Server 依赖 Contracts、Application 和具体 Infrastructure 实现。Route 只接收已校验 DTO，Mapper 负责 DTO 与 Application 输入输出转换。

只有 Local Server 写平台 SQLite。Web 和平台 CLI 均通过 HTTP API 访问平台事实。

## 实现状态

目标模块尚未落地。

## 目标代码落点

`apps/local-server`

## 当前代码事实入口

尚无当前 HTTP Server、Route 或依赖装配代码入口。

## 当前样例与测试入口

当前仓库没有 Local Server 测试。现有 REST 脚本是独立工具，不是 Local Server 实现。

## 对外接口

目标资源位于 `/api/v1`，包括 Test Suites、Test Cases、Endpoint Configs、LLM Configs、Rubric Prompts、Analysis Prompts、Runs、Run Cases、Analysis、Work Package Export、Execution Import 和 Canonical Data Export。Route 按完成阶段注册，未闭环能力不出现在 OpenAPI。

列表使用 Cursor 分页，大 JSON 只在详情返回。写请求返回稳定 Error Code 和必要字段路径。

## 核心流程

启动时初始化配置、SQLite、Repository、Adapter 和 Application，用受控依赖完成 Route 装配。请求进入后先完成 Host、Origin 与 Schema 校验，再调用 Application。关闭时停止接收新请求并回收外部资源。

## 状态、事务与幂等

Route 不持有业务事务。Application 决定事务边界和幂等语义。启动恢复把遗留 `RUNNING` 收敛为 `INTERRUPTED`，不自动续跑。

## 错误收敛

协议错误映射为稳定 HTTP 状态、Error Code、可读消息和字段路径。未知内部错误不暴露 Secret、第三方堆栈或敏感正文。

## 观测与验收

默认监听 `127.0.0.1:4310` 并同源提供 Web 与 API，校验 Host 和 Origin。默认数据目录是项目根 `.cortex-eval/`。日志以单行中文可读文本记录请求关联 ID、业务事件、耗时和 Error Code。验收要求 Route 无业务规则、响应无展开 Secret、页面刷新可以恢复服务端事实。

## 相关测试

目标测试覆盖生命周期、装配、Host、Origin、分页、错误映射、脱敏、取消和启动恢复。
