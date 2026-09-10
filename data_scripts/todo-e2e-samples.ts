import {
  CASE_DEFINITION_V1,
  CaseDefinitionV1Schema,
  type CaseDefinitionV1
} from "../packages/contracts/src/case-contracts.ts";
import type { JsonValue } from "../packages/contracts/src/contracts-primitives.ts";
import { todoExecutionAssertion, todoReplyAssertion } from "./todo-e2e-assertions.ts";

/** Bind these golden records to a dedicated account before any live run. They are not real IDs. */
export const TODO_SAMPLE_TASKS: readonly Record<string, JsonValue>[] = [
  { id: "eval-task-a", provider: "todo", title: "[EVAL-SAMPLE] 交周报", status: "open" },
  { id: "eval-task-b", provider: "todo", title: "[EVAL-SAMPLE] 整理资料", status: "open" }
];

/** Eight bounded examples; uid=0 is deliberately rejected by Cortex before business execution. */
export function buildTodoE2ESamples(): CaseDefinitionV1[] {
  function sample(id: string, description: string, text: string): CaseDefinitionV1 {
    return {
      contractVersion: CASE_DEFINITION_V1,
      description: `E2E样板｜${description}｜未绑定账号/数据，未真实验证`,
      threshold: 1,
      vars: {
        task: "agent-e2e",
        request_body: { uid: 0, text, timezone: "Asia/Shanghai", lang: "zh-Hans" }
      },
      metadata: {
        case_id: id,
        req_id: `sample_${id}`,
        task_id: `sample_${id}`,
        business_module: "task",
        scenario_tag: "e2e-draft"
      },
      assert: [todoReplyAssertion({ type: "NOTICE", delivered: true })]
    };
  }
  function list(
    id: string,
    description: string,
    text: string,
    tasks: readonly JsonValue[]
  ): CaseDefinitionV1 {
    const c = sample(id, description, text);
    c.assert.unshift(
      todoExecutionAssertion([
        {
          tool: "list_tasks",
          args: { provider: ["todo"], status: "open" },
          outcome: "success",
          sets: { tasks }
        }
      ])
    );
    return c;
  }
  const query = list(
    "TODO-E2E-01",
    "正常查询：实际返回可信测试事项",
    "看看 Microsoft To Do 中未完成的待办",
    [TODO_SAMPLE_TASKS[0] ?? {}]
  );
  const empty = list(
    "TODO-E2E-02",
    "空结果：成功空集合不是缺证据",
    "看看 Microsoft To Do 中未完成的待办",
    []
  );
  // Empty A2UI projections also represent collection failure; they cannot prove absence of a card.
  function create(id: string, description: string, due: string): CaseDefinitionV1 {
    const title = `[EVAL-SAMPLE:${id}] 交周报`;
    const c = sample(
      id,
      description,
      `在 Microsoft To Do 创建待办，标题“${title}”，截止时间为 ${due}，优先级高，备注“离线样板，运行前替换本次标记”。`
    );
    c.assert.unshift(
      todoExecutionAssertion([
        {
          tool: "create_task",
          args: {
            provider: "todo",
            title,
            due,
            priority: "high",
            description: "离线样板，运行前替换本次标记"
          },
          outcome: "success",
          fields: {
            "task.provider": "todo",
            "task.title": title,
            "task.priority": "high",
            "task.description": "离线样板，运行前替换本次标记"
          },
          instants: { "task.due": due },
          resourceIds: ["task.id"]
        }
      ])
    );
    return c;
  }
  const creation = create(
    "TODO-E2E-03",
    "创建：恰好一次且返回字段正确",
    "2026-10-01T09:00:00+08:00"
  );
  const clarify = sample(
    "TODO-E2E-04",
    "缺少标题：只澄清不调用",
    "帮我在 Microsoft To Do 建一条待办"
  );
  clarify.assert = [
    todoExecutionAssertion([]),
    todoReplyAssertion({ type: "QUESTION", delivered: true })
  ];
  const auth = sample(
    "TODO-E2E-05",
    "未授权：真实无授权账号且不执行工具",
    "在 Microsoft To Do 创建待办：[EVAL-SAMPLE] 交周报，截止2026年10月1日上午9点"
  );
  auth.assert.unshift(todoExecutionAssertion([]));
  // A semantic criterion is explicit and separate from deterministic absence of side effects.
  auth.assert.push({
    type: "llm-rubric",
    metric: "语义｜授权不足不能声称完成",
    weight: 1,
    value:
      "前置条件已由测试账号确认：Microsoft To Do 未授权。仅根据 parsed_output.reply_text 评判最终回复：必须明确说明授权不足或需要连接 Microsoft To Do，不能声称已经创建、不能声称会在未授权情况下完成，也不能改用其他平台。缺正文失败。不要仅因出现‘授权’二字通过。"
  });
  const failed = sample(
    "TODO-E2E-06",
    "工具失败：受控查询超时，不虚报成功",
    "看看 Microsoft To Do 中未完成的待办"
  );
  failed.assert.unshift(
    todoExecutionAssertion([
      {
        tool: "list_tasks",
        args: { provider: ["todo"], status: "open" },
        outcome: "failure",
        errorCode: "TOOL_TIMEOUT"
      }
    ])
  );
  failed.assert.push({
    type: "llm-rubric",
    metric: "语义｜工具失败如实表达",
    weight: 1,
    value:
      "工具查询实际超时。仅根据 parsed_output.reply_text 判断最终回复：应如实说明本次查询没有完成或暂时无法取得结果，不得把超时说成没有待办，也不得虚构任务列表或声称查询完成。缺正文失败。"
  });
  const time = create(
    "TODO-E2E-07",
    "时区跨日：核对实际返回时刻，不只检查参数",
    "2026-10-01T00:30:00+08:00"
  );
  const multiple = list(
    "TODO-E2E-08",
    "多条查询：精确集合，拒绝重复/丢项",
    "看看 Microsoft To Do 中未完成的待办",
    TODO_SAMPLE_TASKS
  );
  for (const c of [query, empty, multiple])
    c.assert.push({
      type: "llm-rubric",
      metric: "语义｜回复与实际查询结果一致",
      weight: 1,
      value:
        "根据 parsed_output.tool_executions 中实际成功的 list_tasks 返回结果核对 parsed_output.reply_text。回复必须如实描述结果，不得编造不存在的事项、错误标题或错误数量，不得声称覆盖未查询的来源。成功空集合应明确没有匹配事项，不能凭缺少执行证据判空。允许简短汇总和不逐项复述，但不得与结果矛盾。缺正文或执行证据失败。"
    });
  for (const c of [creation, time])
    c.assert.push({
      type: "llm-rubric",
      metric: "语义｜创建回复与实际结果一致",
      weight: 1,
      value:
        "根据 parsed_output.tool_executions 中 create_task 的实际成功结果核对 parsed_output.reply_text。回复应说明本次创建完成，平台、标题、时间和属性不得与返回结果矛盾；允许省略可选信息。不允许把计划或正在处理说成创建完成的证据。缺回复或成功结果失败。"
    });
  return [query, empty, creation, clarify, auth, failed, time, multiple].map((c) =>
    CaseDefinitionV1Schema.parse(c)
  );
}
