/** Small authoring catalog, not a second evaluation engine. Executable JS is frozen in each Case. */
export const FIELD_RULE_CATALOG = [
  {
    id: "field-exists",
    operation: "exists",
    label: "字段存在",
    evidence: "目标字段必须存在；null、false、0 不视为缺失"
  },
  {
    id: "field-equals",
    operation: "equals",
    label: "字段值等于",
    evidence: "精确比较；数组检查顺序和重复项，对象不检查键顺序"
  },
  {
    id: "field-type",
    operation: "type",
    label: "字段类型正确",
    evidence: "区分 object、array 和 null"
  },
  {
    id: "field-count",
    operation: "count",
    label: "列表数量等于",
    evidence: "必须为实际数组，缺字段不能当作空数组"
  }
] as const;

export const AGENT_RULE_CATALOG = [
  {
    id: "agent-executions",
    label: "实际工具执行及结果",
    evidence: "Cortex E2E parsed_output.tool_executions；不接受 Planner tools 替代",
    collections: "执行预期无序匹配，检查次数及请求 ID；sets 无序且禁止重复"
  },
  {
    id: "agent-reply",
    label: "最终回复与交付",
    evidence: "reply_text/reply_type；交付检查需当前请求关联的 final_output 与 delivered_messages"
  }
] as const;
