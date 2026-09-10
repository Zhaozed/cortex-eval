import { CaseDefinitionV1Schema } from "./case-contracts.ts";
import { caseAssertionsIssue } from "./assertion-rules/authoring-validation.ts";

/** Validate new writes only. Historical snapshots continue using the original read contract. */
export const CaseAuthoringV1Schema = CaseDefinitionV1Schema.superRefine((definition, context) => {
  const issue = caseAssertionsIssue(definition.assert);
  if (issue) context.addIssue({ code: "custom", path: [...issue.path], message: issue.code });
});
