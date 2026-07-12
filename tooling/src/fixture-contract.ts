/** Validated REST fixture summary. */
export interface RestFixtureSummary {
  /** Number of REST Case rows. */
  caseCount: number;
}

/** Validated Promptfoo fixture summary. */
export interface PromptfooFixtureSummary {
  /** Number of Promptfoo result rows. */
  resultCount: number;
}

// Return whether a boundary value is a JSON object.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validate the stable outer shape of the real REST fixture.
export function validateRestResultFixture(value: unknown): RestFixtureSummary {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("FIXTURE_REST_ARRAY");
  }
  const caseIds = new Set<string>();
  value.forEach((item, index) => {
    if (!isRecord(item) || !isRecord(item.metadata)) {
      throw new Error(`FIXTURE_REST_CASE:${index}`);
    }
    if (typeof item.metadata.case_id !== "string" || item.metadata.case_id === "") {
      throw new Error(`FIXTURE_REST_CASE_ID:${index}`);
    }
    if (caseIds.has(item.metadata.case_id)) {
      throw new Error(`FIXTURE_REST_DUPLICATE_CASE_ID:${index}`);
    }
    caseIds.add(item.metadata.case_id);
  });
  return { caseCount: value.length };
}

// Validate the stable outer shape needed by the future Promptfoo Importer.
export function validatePromptfooEvalFixture(value: unknown): PromptfooFixtureSummary {
  if (!isRecord(value) || !isRecord(value.results) || !Array.isArray(value.results.results)) {
    throw new Error("FIXTURE_PROMPTFOO_RESULTS");
  }
  if (value.results.results.length === 0) {
    throw new Error("FIXTURE_PROMPTFOO_EMPTY");
  }
  value.results.results.forEach((item, index) => {
    if (!isRecord(item) || typeof item.success !== "boolean") {
      throw new Error(`FIXTURE_PROMPTFOO_ROW:${index}`);
    }
    if (
      !isRecord(item.gradingResult) ||
      !Array.isArray(item.gradingResult.componentResults) ||
      item.gradingResult.componentResults.length === 0
    ) {
      throw new Error(`FIXTURE_PROMPTFOO_COMPONENTS:${index}`);
    }
    item.gradingResult.componentResults.forEach((component, componentIndex) => {
      if (
        !isRecord(component) ||
        typeof component.pass !== "boolean" ||
        typeof component.score !== "number" ||
        typeof component.reason !== "string"
      ) {
        throw new Error(`FIXTURE_PROMPTFOO_COMPONENT:${index}:${componentIndex}`);
      }
      if (
        !isRecord(component.assertion) ||
        typeof component.assertion.type !== "string" ||
        component.assertion.type === ""
      ) {
        throw new Error(`FIXTURE_PROMPTFOO_ASSERTION:${index}:${componentIndex}`);
      }
    });
  });
  return { resultCount: value.results.results.length };
}
