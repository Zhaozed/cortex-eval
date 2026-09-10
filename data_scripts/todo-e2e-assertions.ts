/** Compatibility exports; all new generators share the protocol rule library. */
export {
  agentExecutionAssertion as todoExecutionAssertion,
  agentReplyAssertion as todoReplyAssertion,
  type AgentExecutionExpectation as TodoExecutionExpectation
} from "../packages/contracts/src/assertion-rules/agent-rules.ts";
