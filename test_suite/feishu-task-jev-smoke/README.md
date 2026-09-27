# 飞书任务 JEV 冒烟评测集

本评测集复用 `test_suite/feishu-task` 中的三个只读 Case：

- `FT-JEV-S01`：查询今天和明天的未完成任务
- `FT-JEV-S02`：解析“发布项目”清单后查询任务
- `FT-JEV-S03`：搜索发布相关任务

每个 Case 同时保留原有确定性 JavaScript 断言，并增加 `semanticEvaluation`，用于验证 JEV 对路由、工具选择与编排、时效、A2UI、最终回复和安全性的判断。

## 运行前配置

本地 Secret 已写入：

```text
.cortex-eval/server.env
```

当前适配 TypeSafe 官方 JEV API，只需要一个 API Key。Endpoint 和 Model 已有默认值：

```text
https://api.typesafe.ai/v1/systemone
jev-latest
```

不需要额外配置 Endpoint/Model；如需覆盖，再设置 `CORTEX_JEV_ENDPOINT` 和 `CORTEX_JEV_MODEL`。`.cortex-eval/server.env` 必须保持 `0600` 权限。

## 校验评测集

```bash
pnpm cases:validate test_suite/feishu-task-jev-smoke/cases.json
```

## 运行

先启动本地服务，再用现有的 Feishu Agent REST 配置运行这个评测集。当前冒烟集只读，不创建、更新或删除任务。
