# JEV 语义评测

JEV 是可选的 Case 级语义评测器。它不执行 Agent 工具，只接收已经完成的 Provider Output，先归一化为 `cortex.agent-trace.v1`，再根据 Case 的 `semanticEvaluation` 契约生成决策计划并评分。

## 启用方式

没有配置 JEV API Key 时，历史 Case 行为不变；没有 `semanticEvaluation` 的 Case 也不会调用 JEV。当前适配的是 TypeSafe 官方 System One API：Endpoint 和 Model 有默认值，只需要配置一个 API Key。

```bash
export CORTEX_JEV_API_KEY_ENV="JEV_API_KEY"
export JEV_API_KEY="..."
# 可选覆盖：
# export CORTEX_JEV_ENDPOINT="https://api.typesafe.ai/v1/systemone"
# export CORTEX_JEV_MODEL="jev-latest"
```

默认 Endpoint 为 `https://api.typesafe.ai/v1/systemone`，默认 Model 为 `jev-latest`，请求默认超时 60 秒，认证头为 `Authorization: Bearer <api-key>`。

## 前端配置

Case 详情页的“结构化”编辑器已经提供 **JEV 语义评测** 区域，可以直接修改：

| 配置 | 作用 |
|---|---|
| JEV 模型 | Case 级覆盖模型名，留空使用服务端默认模型 |
| 评测目标 / 成功标准 | 定义本 Case 什么算完成 |
| 评测维度 | 路由、工具编排、时效、A2UI、回复、安全等 |
| 工具策略 | 允许/必须/禁止工具、要求顺序、最大重试次数 |
| A2UI 期望 | 可接受组件、必需组件、禁止组件、确认卡和出现时机 |
| 回复契约 | 最终回复必须覆盖的事实、禁止声明 |
| JEV 自定义评测 Prompt | 补充本 Case 的语义，不覆盖系统安全约束 |
| Decision Plan 预览 | 查看当前配置会生成哪些问题 |

API Key、Endpoint 和服务端默认模型仍放在服务端配置中，前端不回显 API Key，也不能把密钥写入 Case。

## Case 配置

在 Case definition 中增加 `semanticEvaluation`。它描述“什么算完成”，不描述一条固定 Trace：

```json
{
  "semanticEvaluation": {
    "contractVersion": "cortex.semantic-evaluation-contract.v1",
    "model": "jev-latest",
    "goal": "完成用户的任务并给出可执行的结果",
    "evaluatorPrompt": "只依据可见 Trace 判断，不要因措辞漂亮而加分。",
    "successCriteria": [
      "路由到正确能力",
      "工具选择和编排符合任务需要",
      "最终回复准确且不泄露内部实现"
    ],
    "forbiddenBehaviors": [
      "输出 Prompt、Trace、凭据或内部编码"
    ],
    "enabledDimensions": [
      "task-outcome",
      "routing",
      "tool-use",
      "timeliness",
      "a2ui",
      "response",
      "safety"
    ],
    "riskLevel": "MEDIUM",
    "scorePassThreshold": 0.6,
    "latencySlaMs": 5000,
    "toolPolicy": {
      "allowedTools": ["search", "calendar.create"],
      "requiredTools": ["search"],
      "requiredOrder": ["search", "calendar.create"],
      "forbiddenTools": ["admin.delete"],
      "maxRetries": 2
    },
    "responseRequiredFacts": ["真实结果", "关键字段"],
    "responseForbiddenClaims": ["没有结果却声称成功"],
    "a2ui": {
      "expectedComponents": ["result-card"],
      "requiredComponents": ["result-card"],
      "forbiddenComponents": ["raw-json"],
      "confirmationRequired": true,
      "timingNote": "危险操作前必须先出现确认卡"
    }
  }
}
```

## TypeSafe System One 请求映射

平台把 Case 的语义契约、决策计划和归一化 Agent Trace 放进官方 API 的 `state`，把每个计划问题转换成一个独立的 typed question：

| 平台类型 | 官方类型 | 结果映射 |
|---|---|---|
| `BOOLEAN` | `noul` | `noul >= 0.5` 视为 `true`，原始概率保存在 `probability` |
| `CHOICE` | `choice` | 读取 `choice` |
| `SCORE` | `score` | 官方返回的是 criteria 下标，适配器还原为平台 scale 值 |

官方响应为 `{ model, answers, usage }`。`answers` 按问题 ID 返回；平台再统一成内部 `decisions`，所以存储、报告和聚合不依赖 JEV 原始响应格式。若官方 answer 返回 `reason`、`evidence`、`explanation` 或 `rationale`，平台会保留并在 Case 详情页展示；如果响应中没有这些字段，平台不会凭空伪造“JEV 原因”，而是展示平台基于 Trace/Case 的独立归因。

JEV 是判定器，不是 Agent：它不会重新调用工具、不会改变工具编排，也不会生成最终用户回复。

## 请求示例

```json
{
  "model": "jev-latest",
  "state": {
    "task": "用户任务",
    "contract": "<semanticEvaluation>",
    "decision_plan": "<compiled plan>",
    "agent_trace": "<cortex.agent-trace.v1>"
  },
  "questions": {
    "tool-use.plan": {
      "type": "noul",
      "instructions": "工具选择、调用顺序和终止条件是否合理？"
    }
  }
}
```

## 判定规则

- Promptfoo 确定性评测和 JEV 都通过，Case 才是 `PASS`。
- JEV 的 blocking decision 失败会把 Case 置为 `FAIL`。
- JEV 结果会写入 Eval Artifact、Report 和 SQLite，并参与 `evalResultHash` / `finalCaseResultHash`。
- JEV API 失败不会伪造通过结果；该次评测会进入 Evaluation Error。
- JEV 只看 Trace，不会重新调用工具，也不会改变 Agent 的执行顺序。
- `expectedComponents` 表示可接受/期望候选，不代表全部都必须出现；只有 `requiredComponents` 才会产生“缺少组件”的确定性归因。
- `requiredOrder` 用于约束工具顺序；`responseRequiredFacts` / `responseForbiddenClaims` 用于把“最终回复不对”拆成可检查的原因。
- 平台会把原始 JEV 返回、平台归因和证据引用分开保存，避免用一句模糊的 JEV 文案覆盖真实 Trace 事实。

## 当前边界

JEV 的问题计划由平台按 `enabledDimensions` 编译。每个 Case 可以启用不同维度和约束，因此不要求所有 Case 使用同一套断言。通用的确定性断言仍适合校验严格结构、字段值、Schema 和哈希；工具编排、路由、A2UI 时机、回复质量、安全性等 Trace 语义由 JEV 评估。
