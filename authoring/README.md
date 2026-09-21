# 规范驱动的评测集构造层

本目录是评测集构造的规则源，不是运行结果目录。

## 业务方只填写什么

业务规范使用 `templates/business-case.md`，保持自然语言，只描述：

1. 背景与目标
2. 触发条件
3. 用户的话
4. 分支矩阵：有哪些情况、应该怎么处理、不能做什么、最终结果
5. Agent 期望链路
6. UI 期望响应链路
7. 验收关注点
8. （不填写）测试数据和清理由项目侧准备

业务方不填写 `branch_id`、真实资源 ID、JSON 路径或断言代码。
这些由构造器和平台规则自动生成或绑定。

## 构造流程

```text
evaluation_sources/*.md
  -> profiles + capabilities + tools + a2ui + assertions + fixtures
  -> evaluation_specs/<source>/
  -> generated/<source>/cases.jsonl
  -> 现有执行、评分和报告链路
```

构造器会先做以下检查：

- 必填章节是否存在且有实际内容；
- 是否识别出至少一个需要覆盖的业务情况；
- 用户输入是否存在；
- 业务能力、工具和 A2UI 是否能绑定；
- 每个分支是否有可用测试数据；
- 生成的 Case 数量、ID 和现有 Case 契约是否正确。

任何一项不满足，结果为 `BLOCKED`，不生成可执行 `cases.jsonl`。

## 构造命令

```bash
pnpm authoring:build -- \
  --source evaluation_sources/feishu/D01-search-document.md \
  --profile dev-validation \
  --registry authoring \
  --output .
```

命令默认 fail-closed：

- `READY`：生成 `generated/<source>/cases.jsonl`。
- `BLOCKED`：只生成 `evaluation_specs/<source>/` 下的 IR、绑定、就绪报告和 Manifest；进程返回码为 2。
- 调试或人工查看时可追加 `--allow-blocked`。

## 真相源

- `profiles/`：评测类型构造规则。
- `capabilities/`：稳定的业务能力 ID。
- `tools/`：能力到运行时工具名的绑定。
- `a2ui/`：A2UI 组件和证据要求。
- `assertions/`：可复用断言模板目录。
- `fixtures/`：分支所需的前置资源状态。
- `evaluation_sources/`：业务规范源文档。

`evaluation_specs/` 和 `generated/` 都是构造产物，不作为工具事实或断言规则的唯一来源。
