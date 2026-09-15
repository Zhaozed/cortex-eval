# 评测结论归属桥接层设计（判断归属）

日期：2026-09-14 ｜ 状态：设计稿，待确认 ｜ 关联：抽屉多轮重构、验收检查

## 1. 目标

让每条验收项（`AssertionResultV1`）在 UI 上可定位到一个锚点：
`整体（case 级）` 或 `第 N 轮` 或 `trace 具体节点`（llm_call / tool_execution / timeline step）。
反向：点某轮次，能看到哪些验收项消费了该轮的证据。

## 2. 现状事实（基于契约与真实数据，先承认边界）

| 断言类型 | 可机器归因的数据 | 结论 |
|---|---|---|
| `is-json` | `evaluation.diffs[].instancePath`（AJV JSON Pointer，仅 FAIL 时存在） | 能精确归因，但仅失败时、仅 JSON 校验类 |
| `javascript`（field-rule 生成） | `definition.assert[i].value` 头部 `// cortex-eval field-rule v1 {...}` 里的 `path` | path 含 `turns.N` 时可精确归因 |
| `javascript`（自定义 spec，如 CU-B9） | `value` 内 `spec` 对象（`expectedTurns`、`cancelTurnIndex`、`check`…） | 有结构但**未声明归属**，目前视为整体 |
| `llm-rubric` | 无结构化锚点，reason 为散文 | 只能整体；不得解析散文猜轮次（伪精确） |

真实数据实证（.cortex-eval/artifacts）：
- 全部多轮用例（CU-*、TD-*、MX-*）的断言只有 `javascript` + `llm-rubric`，**diffs 全为空**；
- 这些断言在套件设计上就是**跨轮聚合**（逐轮真实终态、禁止工具调用、调用次数上限≤1、整体业务 rubric），不存在逐轮断言；
- 老旧 `is-json` 套件的 diff path 形如 `/parsed_output/tools/0/...`：在单轮 payload 可解析；在 turns 包裹的 payload 下**结构不匹配**（`parsed_output` 下无 `tools`），diff 定位必然失败。

结论：**「桥接层」解决的不是"算出每轮 PASS/FAIL"，而是"把已有的整体结论正确锚定到证据轮次/节点"**。每轮 PASS/FAIL 在现套件设计下不存在，也不应伪造。

## 3. 桥接架构

输入（全部已在 drawer 的 row 上，无需新接口）：
- `rest.providerOutput.parsed_output`（turns 包裹或扁平）
- `definition.assert[]`（expected/type/value/config）
- `evaluation.assertions[]` + `evaluation.diffs[]`
- 现有 `displayEvidence()`（flatten + `_eval_turn_index`）与 `run-trace-analysis-model` 的 doc-pointer→nodeId 解析

输出（每验收项）：
```
AttributedCheck {
  assertionIndex: number
  scope: "case" | "turn" | "node"
  turn: number | null          // 1-based
  nodeId: string | null        // run-trace-panel 锚点 id
  pointer: string | null       // 解析成功的 JSON Pointer
  confidence: "exact" | "declared" | "none"
  mismatch: boolean            // 断言目标与 payload 结构不匹配（如实标注）
}
```

归属算法（按优先级取第一个成功项）：
1. `diffs[].instancePath` 解析：含 `/turns/N/` → `scope=turn`，继续解析到节点 → `scope=node`（exact）。
   path 以 `/parsed_output/...` 开头但 payload 为 turns 包裹 → 解析失败 → `mismatch=true, scope=case`，提示「断言按扁平结构编写，多轮结构下无法定位轮次，需改为 turns[i].parsed_output 写法」。
2. field-rule 头部 `path` 含 `turns.N` → `scope=turn`（exact）。
3. v2：自定义 spec / 规则显式声明 `anchorTurn` → `scope=turn`（declared）。
4. 兜底 `scope=case`（现状）。

明确不做：从 `reason` 散文正则提取「第 N 轮」。理由：llm-rubric/Javascript 的 reason 是自然语言，解析出的"归属"不可复现、不可审计，属于伪精确。

## 4. 分层落地

### v1：纯前端桥接（不加契约，今天可做）
- `apps/web/src/features/runs/run-attribution-model.ts`：纯函数实现算法 1/2/4 与 mismatch 检测
- UI：`RunCaseChecks` 每项加「归属」行（整体/第N轮/节点），点击复用 `turn:N` / 既有 trace 锚点跳转；mismatch 给提示
- 轮次卡片加「关联验收项」反向入口（仅当有 exact/declared 归属时）
- 工作量：1–2 天（含测试）

### v2：契约 + 导入期固化（可靠归属的前提）
- `CaseFieldRule`/自定义 spec 约定新增可选 `anchorTurn: number | "all" | null`（field-rule 头已是声明式，扩展不破坏旧值）
- `AssertionResultV1` 新增可选 `anchor: AssertionAnchorV1 | null`（scope/turn/nodeId/pointer/confidence），导入期由 importer 固化并参与 hash
- case-editor 增加「归属轮次」字段
- 历史数据：新字段 nullable，无需迁移；旧 run 回退 v1 推断
- 工作量：3–5 天（契约 + importer + 表单 + 前端）

## 5. 推荐
先做 v1（今天可交付、零契约风险），同时把 v2 的 `anchorTurn` 约定写进断言编写规范；
当需要"某条验收项必须落在第 N 轮"这种强语义时，再上 v2。

## 6. 待确认
1. v1 现在做吗？
2. mismatch 提示文案：「断言目标按扁平结构编写，多轮证据下无法定位轮次」可否接受？
3. 反向入口（轮次↔验收项互跳）要不要进 v1？
