import { a2uiHash } from "../src/a2ui-review-evidence.ts";
import type { A2uiReviewImport } from "@cortex-eval/contracts/src/a2ui-review-contracts.ts";
/** Synthetic transport; real production capture is covered by the replay runner. */
export function reviewFixture(failed = false): A2uiReviewImport {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64"
  );
  const sha256 = a2uiHash(png),
    file = "case-group-0.png";
  const cases = JSON.stringify([{ case_id: "case", synthetic: true, expected_groups: [{}] }]);
  const status = failed ? "failed" : "passed";
  const report = JSON.stringify({
    scope: "offline_web_payload",
    cases_sha256: a2uiHash(cases),
    results: [{ case_id: "case", title: "Case", status, counts: { groups: 1 } }]
  });
  const capture = JSON.stringify({
    scope: "web_template_capture",
    report_sha256: a2uiHash(report),
    cases_sha256: a2uiHash(cases),
    results: [
      {
        case_id: "case",
        payload_status: status,
        status: "captured",
        screenshots: [{ file, sha256, group_index: 0 }]
      }
    ]
  });
  return {
    version: 1,
    title: "Review",
    runId: null,
    report,
    capture,
    cases,
    images: [{ file, sha256, base64: png.toString("base64") }]
  };
}
