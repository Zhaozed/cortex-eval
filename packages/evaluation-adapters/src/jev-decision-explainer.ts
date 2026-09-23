import type {
  AgentTraceV1,
  JevDecisionQuestionV1,
  JevDecisionResultV1,
  SemanticEvaluationContractV1
} from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";

export interface JevDecisionExplanation {
  readonly applicable: boolean;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly evidenceRefs: readonly string[];
}

function list(values: readonly string[]): string {
  return values.length > 0 ? values.join("、") : "无";
}

function fact(ref: string, value: string): string {
  return `${ref}：${value}`;
}

function toolFacts(trace: AgentTraceV1) {
  const calls = trace.toolCalls;
  const names = calls.map((call) => call.name);
  const failed = calls.filter((call) => ["failure", "timeout", "cancelled"].includes(call.outcome));
  const unknown = calls.filter((call) => call.outcome === "unknown");
  const retries = calls.filter((call) => call.retryOf !== undefined);
  return { calls, names, failed, unknown, retries };
}

function orderedMissing(requiredOrder: readonly string[], names: readonly string[]): string[] {
  let cursor = 0;
  const missing: string[] = [];
  for (const required of requiredOrder) {
    const found = names.indexOf(required, cursor);
    if (found < 0) missing.push(required);
    else cursor = found + 1;
  }
  return missing;
}

function boundedResult(call: AgentTraceV1["toolCalls"][number]): string {
  if (call.result === undefined) return "无结果字段";
  try {
    const text = JSON.stringify(call.result);
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return "结果不可序列化";
  }
}

function successfulResultText(trace: AgentTraceV1): string {
  return trace.toolCalls
    .filter((call) => call.outcome === "success")
    .map((call) => `${call.name}=${boundedResult(call)}`)
    .join("；");
}

function explainToolPolicy(
  contract: SemanticEvaluationContractV1,
  trace: AgentTraceV1
): { reason: string; evidence: string[]; evidenceRefs: string[] } {
  const policy = contract.toolPolicy;
  const { calls, names, failed, unknown, retries } = toolFacts(trace);
  const allowed = policy?.allowedTools ?? [];
  const required = policy?.requiredTools ?? [];
  const requiredOrder = policy?.requiredOrder ?? [];
  const forbidden = policy?.forbiddenTools ?? [];
  const missing = required.filter((name) => !names.includes(name));
  const forbiddenUsed = names.filter((name) => forbidden.includes(name));
  const disallowed = allowed.length === 0 ? [] : names.filter((name) => !allowed.includes(name));
  const retryLimit = policy?.maxRetries;
  const retryExceeded = retryLimit !== undefined && retries.length > retryLimit;
  const orderMissing = orderedMissing(requiredOrder, names);
  const issues = [
    missing.length > 0 ? `缺少必需工具：${list(missing)}` : "",
    forbiddenUsed.length > 0 ? `调用了禁止工具：${list([...new Set(forbiddenUsed)])}` : "",
    disallowed.length > 0 ? `调用了允许列表之外的工具：${list([...new Set(disallowed)])}` : "",
    orderMissing.length > 0 ? `工具顺序不满足要求，未按顺序观察到：${list(orderMissing)}` : "",
    retryExceeded ? `重试次数 ${retries.length} 超过上限 ${retryLimit}` : ""
  ].filter(Boolean);
  const reason =
    issues.length > 0
      ? issues.join("；")
      : `工具调用符合策略：${calls.length} 次调用（${list(names)}），失败/超时 ${failed.length} 次，重试 ${retries.length} 次。`;
  return {
    reason,
    evidence: [
      fact("Trace 工具顺序", list(names)),
      fact(
        "Trace 工具终态",
        calls.length === 0
          ? "无调用"
          : calls.map((call) => `${call.name}=${call.outcome}`).join("；")
      ),
      fact("契约允许工具", list(allowed)),
      fact("契约必需工具", list(required)),
      fact("契约要求顺序", list(requiredOrder)),
      fact("契约禁止工具", list(forbidden)),
      fact("Trace 未知终态", String(unknown.length)),
      fact("工具结果摘要", successfulResultText(trace) || "无成功工具结果")
    ],
    evidenceRefs: [
      "trace.toolCalls[*].name",
      "trace.toolCalls[*].outcome",
      "trace.toolCalls[*].result",
      "contract.toolPolicy.allowedTools",
      "contract.toolPolicy.requiredTools",
      "contract.toolPolicy.requiredOrder",
      "contract.toolPolicy.forbiddenTools",
      "contract.toolPolicy.maxRetries"
    ]
  };
}

function explainA2uiChoice(
  contract: SemanticEvaluationContractV1,
  trace: AgentTraceV1
): { reason: string; evidence: string[]; evidenceRefs: string[] } {
  const expected = contract.a2ui?.expectedComponents ?? [];
  const required = contract.a2ui?.requiredComponents ?? [];
  const forbidden = contract.a2ui?.forbiddenComponents ?? [];
  const components = [...new Set(trace.a2ui.map((item) => item.component))];
  const missingRequired = required.filter((item) => !components.includes(item));
  const unexpected =
    expected.length > 0 ? components.filter((item) => !expected.includes(item)) : [];
  const forbiddenUsed = components.filter((item) => forbidden.includes(item));
  const issues = [
    missingRequired.length > 0 ? `缺少必需组件：${list(missingRequired)}` : "",
    unexpected.length > 0 ? `出现未列入期望集合的组件：${list([...new Set(unexpected)])}` : "",
    forbiddenUsed.length > 0 ? `出现禁止组件：${list([...new Set(forbiddenUsed)])}` : ""
  ].filter(Boolean);
  return {
    reason: issues.length > 0 ? issues.join("；") : `Trace A2UI 组件：${list(components)}。`,
    evidence: [
      fact("Trace A2UI 组件", list(components)),
      fact("契约期望/可接受组件", list(expected)),
      fact("契约必需组件", list(required)),
      fact("契约禁止组件", list(forbidden)),
      fact("A2UI 事件数", String(trace.a2ui.length))
    ],
    evidenceRefs: [
      "trace.a2ui[*].component",
      "trace.a2ui[*].event",
      "contract.a2ui.expectedComponents",
      "contract.a2ui.requiredComponents",
      "contract.a2ui.forbiddenComponents"
    ]
  };
}

function explainResponse(
  contract: SemanticEvaluationContractV1,
  trace: AgentTraceV1,
  decision: JevDecisionResultV1
): JevDecisionExplanation {
  const required = contract.responseRequiredFacts ?? [];
  const forbiddenClaims = contract.responseForbiddenClaims ?? [];
  const answer = trace.finalAnswer.trim();
  const answerLower = answer.toLowerCase();
  const explicitForbidden = forbiddenClaims.filter((claim) =>
    answerLower.includes(claim.toLowerCase())
  );
  const successfulCalls = trace.toolCalls.filter((call) => call.outcome === "success");
  const resultText = successfulResultText(trace);
  const unverifiable = required.filter((item) => {
    const lower = item.toLowerCase();
    return !/(数量|多少|几条|标题|名称|task|工具结果|真实结果|范围|覆盖)/i.test(lower);
  });
  const missingCountClaim =
    required.some((item) => /(数量|多少|几条)/.test(item)) &&
    successfulCalls.some((call) => /"tasks"\s*:\s*\[/.test(boundedResult(call))) &&
    !/[0-9一二两三四五六七八九十百千万]+/.test(answer);
  const missingTitleClaims =
    required.some((item) => /(标题|名称)/.test(item)) &&
    successfulCalls.some((call) => /"title"\s*:/.test(boundedResult(call))) &&
    !successfulCalls.some((call) => {
      const result = boundedResult(call);
      const titles = [...result.matchAll(/"title"\s*:\s*"([^"]+)"/g)]
        .map((match) => match[1])
        .filter((title): title is string => title !== undefined);
      return titles.length > 0 && titles.some((title) => answer.includes(title));
    });
  const derivedIssues = [
    explicitForbidden.length > 0 ? `命中禁止输出：${list(explicitForbidden)}` : "",
    missingCountClaim ? "成功工具结果包含任务数量，但最终回复未出现可核对的数量" : "",
    missingTitleClaims ? "成功工具结果包含任务标题，但最终回复未引用任何标题" : ""
  ].filter(Boolean);
  const reason =
    decision.value === true
      ? `JEV 判定最终回复准确；平台核验到最终回复${answer === "" ? "为空" : `有 ${answer.length} 个字符`}。${required.length > 0 ? `要求覆盖：${list(required)}。` : ""}`
      : `JEV 判定最终回复不准确。${derivedIssues.length > 0 ? `平台可直接归因：${derivedIssues.join("；")}。` : "平台当前没有把该语义失败进一步结构化归因。"}${required.length > 0 ? `要求覆盖：${list(required)}。` : ""}`;
  return {
    applicable: true,
    reason,
    evidence: [
      fact("最终回复", answer || "空"),
      fact("成功工具结果摘要", resultText || "无成功工具结果"),
      fact("回复必须覆盖", list(required)),
      fact("回复禁止声明", list(forbiddenClaims)),
      fact("平台直接识别的问题", list(derivedIssues)),
      fact("平台无法仅靠规则核验的要求", list(unverifiable))
    ],
    evidenceRefs: [
      "trace.finalAnswer",
      "trace.toolCalls[*].result",
      "contract.responseRequiredFacts",
      "contract.responseForbiddenClaims",
      "contract.successCriteria"
    ]
  };
}

/** Explain a JEV decision from bounded Case/Trace facts, independently of JEV's reason field. */
export function explainJevDecision(input: {
  readonly contract: SemanticEvaluationContractV1;
  readonly question: JevDecisionQuestionV1;
  readonly decision: JevDecisionResultV1;
  readonly trace: AgentTraceV1;
}): JevDecisionExplanation {
  const { contract, question, decision, trace } = input;
  const tools = toolFacts(trace);

  if (question.id === "task-outcome.completed") {
    return {
      applicable: true,
      reason:
        decision.value === true
          ? `JEV 判定任务完成；成功标准：${list(contract.successCriteria)}。`
          : `JEV 判定未通过，任务未完成。成功标准：${list(contract.successCriteria)}；Trace 工具调用：${list(tools.names)}；最终回复：${trace.finalAnswer.trim() || "空"}。由于 JEV 未返回 reason，平台只能给出这些可核对事实，不能推断它具体漏判了哪条标准。`,
      evidence: [
        fact("成功标准", list(contract.successCriteria)),
        fact("工具调用", list(tools.names)),
        fact("工具结果摘要", successfulResultText(trace) || "无成功工具结果"),
        fact("最终回复", trace.finalAnswer.trim() || "空")
      ],
      evidenceRefs: [
        "trace.task",
        "contract.successCriteria",
        "trace.toolCalls[*].name",
        "trace.toolCalls[*].result",
        "trace.finalAnswer"
      ]
    };
  }

  if (question.id === "tool-use.recovery") {
    if (tools.failed.length === 0) {
      return {
        applicable: false,
        reason: "本 Case 没有失败、超时或取消的工具调用；失败恢复不适用，未纳入阻断判断。",
        evidence: [fact("失败/超时/取消工具调用", "0")],
        evidenceRefs: ["trace.toolCalls[*].outcome"]
      };
    }
    return {
      applicable: true,
      reason:
        decision.value === true
          ? "发生工具异常，Trace 显示 Agent 进行了恢复处理。"
          : "发生工具异常，但 JEV 判定没有完成合理恢复。",
      evidence: [
        fact("异常工具调用", tools.failed.map((call) => `${call.name}=${call.outcome}`).join("；")),
        fact("重试调用数", String(tools.retries.length)),
        fact("允许最大重试数", String(contract.toolPolicy?.maxRetries ?? "未设置"))
      ],
      evidenceRefs: [
        "trace.toolCalls[*].outcome",
        "trace.toolCalls[*].retryOf",
        "contract.toolPolicy.maxRetries"
      ]
    };
  }

  if (question.id === "tool-use.plan") {
    return { applicable: true, ...explainToolPolicy(contract, trace) };
  }

  if (question.id === "tool-use.need") {
    const required = contract.toolPolicy?.requiredTools ?? [];
    const expected = required.length > 0 || trace.toolCalls.length > 0;
    return {
      applicable: true,
      reason:
        decision.value === expected
          ? `工具需求判断与可见事实一致：${expected ? "本任务存在工具调用需求" : "本任务未显示工具调用需求"}。`
          : `JEV 判断与可见事实冲突：Trace 中${trace.toolCalls.length > 0 ? "存在" : "不存在"}工具调用。`,
      evidence: [
        fact("Trace 工具调用数", String(trace.toolCalls.length)),
        fact("契约必需工具", list(required))
      ],
      evidenceRefs: ["trace.toolCalls.length", "contract.toolPolicy.requiredTools"]
    };
  }

  if (question.id === "a2ui.choice") {
    const choice = explainA2uiChoice(contract, trace);
    return {
      applicable: true,
      ...choice,
      reason: `${decision.value === true ? "JEV 判定通过" : "JEV 判定未通过"}；${choice.reason}`
    };
  }

  if (question.id === "a2ui.timing") {
    const hasTiming =
      trace.a2ui.some((item) => item.timestampMs !== undefined) &&
      trace.toolCalls.some(
        (call) => call.startedAtMs !== undefined || call.endedAtMs !== undefined
      );
    if (!hasTiming) {
      return {
        applicable: false,
        reason:
          "Trace 未提供 A2UI 与工具调用的可比较时间戳，无法解释过早/过晚；这不是一个可审计的失败原因。",
        evidence: [fact("A2UI 时间戳", "缺失"), fact("工具调用时间戳", "缺失")],
        evidenceRefs: [
          "trace.a2ui[*].timestampMs",
          "trace.toolCalls[*].startedAtMs",
          "trace.toolCalls[*].endedAtMs"
        ]
      };
    }
    return {
      applicable: true,
      reason:
        decision.value === true
          ? "A2UI 时序满足 JEV 判定。"
          : "A2UI 时序未满足 JEV 判定，请查看事件时间线定位早于/晚于哪个工具结果。",
      evidence: [
        fact("A2UI 事件数", String(trace.a2ui.length)),
        fact("工具调用数", String(trace.toolCalls.length))
      ],
      evidenceRefs: [
        "trace.a2ui[*].timestampMs",
        "trace.toolCalls[*].startedAtMs",
        "trace.toolCalls[*].endedAtMs",
        "contract.a2ui.timingNote"
      ]
    };
  }

  if (question.id === "timeliness.quality") {
    if (trace.timing.durationMs === undefined) {
      return {
        applicable: false,
        reason: "Trace 未提供端到端耗时，无法核验时效性。",
        evidence: [fact("Trace durationMs", "缺失")],
        evidenceRefs: ["trace.timing.durationMs", "contract.latencySlaMs"]
      };
    }
    return {
      applicable: true,
      reason: `Trace 端到端耗时 ${trace.timing.durationMs}ms${contract.latencySlaMs === undefined ? "" : `，SLA ${contract.latencySlaMs}ms`}；JEV 给出评分 ${String(decision.value)}。`,
      evidence: [
        fact("Trace durationMs", `${trace.timing.durationMs}ms`),
        fact("契约 latencySlaMs", String(contract.latencySlaMs ?? "未设置"))
      ],
      evidenceRefs: [
        "trace.timing.durationMs",
        "trace.timing.firstResponseMs",
        "contract.latencySlaMs"
      ]
    };
  }

  if (question.id === "response.correct") return explainResponse(contract, trace, decision);

  if (question.id === "response.clean") {
    const forbiddenPattern = /(prompt|trace|api[_ -]?key|凭据|内部编码|system message)/i;
    const leaked = forbiddenPattern.test(trace.finalAnswer);
    return {
      applicable: true,
      reason: leaked
        ? "最终回复命中了禁止内容模式。"
        : `最终回复未命中已知禁止内容模式；JEV 判定为 ${decision.value === true ? "合规" : "不合规"}。`,
      evidence: [
        fact("最终回复长度", `${trace.finalAnswer.length} 字符`),
        fact("禁止内容模式命中", leaked ? "是" : "否"),
        fact("契约禁止行为", list(contract.forbiddenBehaviors ?? []))
      ],
      evidenceRefs: [
        "trace.finalAnswer",
        "contract.forbiddenBehaviors",
        "contract.responseForbiddenClaims"
      ]
    };
  }

  if (question.id === "routing.correct") {
    return {
      applicable: true,
      reason:
        trace.router.selected === undefined
          ? `JEV 判定${decision.value === true ? "通过" : "未通过"}，但 Trace 未提供 router.selected；平台无法独立核验具体路由。`
          : `Trace 选择路由：${trace.router.selected}；JEV 判定为 ${decision.value === true ? "正确" : "不正确"}。`,
      evidence: [
        fact("Trace selected route", trace.router.selected ?? "缺失"),
        fact("候选路由", list(trace.router.candidates))
      ],
      evidenceRefs: ["trace.router.selected", "trace.router.candidates"]
    };
  }

  return {
    applicable: true,
    reason:
      decision.value === true
        ? "JEV 判定通过；平台已列出本题使用的 Trace/契约事实。"
        : `JEV 判定未通过。成功标准：${list(contract.successCriteria)}；平台当前没有足够的结构化事实把失败进一步归因。`,
    evidence: [
      fact("任务", trace.task),
      fact("最终回复是否为空", trace.finalAnswer.trim() === "" ? "是" : "否"),
      fact("成功标准", list(contract.successCriteria)),
      fact("工具结果摘要", successfulResultText(trace) || "无")
    ],
    evidenceRefs: [
      "trace.task",
      "trace.finalAnswer",
      "trace.toolCalls[*].result",
      "contract.goal",
      "contract.successCriteria"
    ]
  };
}
