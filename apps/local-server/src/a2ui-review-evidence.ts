import { createHash } from "node:crypto";
import { z } from "zod";
import {
  A2uiFileSchema,
  A2uiHashSchema,
  type A2uiReview,
  type A2uiReviewImport
} from "@cortex-eval/contracts/src/a2ui-review-contracts.ts";

/** Hash exact bytes instead of reserializing evidence. */
export function a2uiHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
const ResultSchema = z.object({
  case_id: z.string().min(1),
  title: z.string(),
  status: z.enum(["passed", "failed", "error"]),
  counts: z.object({ groups: z.number().int().nonnegative() }).optional(),
  payload_sha256: A2uiHashSchema.nullable().optional()
});
const ReportSchema = z.object({
  scope: z.literal("offline_web_payload"),
  cases_sha256: A2uiHashSchema,
  results: z.array(ResultSchema).min(1).max(100)
});
const CaptureSchema = z.object({
  scope: z.literal("web_template_capture"),
  report_sha256: A2uiHashSchema,
  cases_sha256: A2uiHashSchema,
  results: z
    .array(
      z.object({
        case_id: z.string(),
        payload_status: z.enum(["passed", "failed", "error"]),
        payload_sha256: A2uiHashSchema.nullable().optional(),
        status: z.enum(["captured", "empty_verified", "error"]),
        screenshots: z.array(
          z.object({
            file: A2uiFileSchema,
            sha256: A2uiHashSchema,
            group_index: z.number().int().nonnegative()
          })
        )
      })
    )
    .max(100)
});
const CasesSchema = z.array(
  z.object({
    case_id: z.string(),
    synthetic: z.literal(true),
    expected_groups: z.array(z.unknown())
  })
);

/** Reject inconsistent evidence before publishing any review or image. */
export function validateA2uiEvidence(input: A2uiReviewImport): A2uiReview["cases"] {
  const report = ReportSchema.parse(JSON.parse(input.report));
  const capture = CaptureSchema.parse(JSON.parse(input.capture));
  const cases = CasesSchema.parse(JSON.parse(input.cases));
  const require = (ok: boolean): void => {
    if (!ok) throw new Error("A2UI_EVIDENCE_INVALID");
  };
  require(a2uiHash(input.report) === capture.report_sha256);
  require(
    a2uiHash(input.cases) === report.cases_sha256 && report.cases_sha256 === capture.cases_sha256
  );
  require(new Set(report.results.map((row) => row.case_id)).size === report.results.length);
  require(
    new Set(capture.results.map((row) => row.case_id)).size === report.results.length &&
      capture.results.length === report.results.length
  );
  require(
    new Set(cases.map((row) => row.case_id)).size === report.results.length &&
      cases.length === report.results.length
  );
  const images = new Map(input.images.map((image) => [image.file, image]));
  require(images.size === input.images.length);
  const used = new Set<string>();
  const result = report.results.map((row) => {
    const shot = capture.results.find((item) => item.case_id === row.case_id);
    const source = cases.find((item) => item.case_id === row.case_id);
    if (!shot || !source) throw new Error("A2UI_EVIDENCE_INVALID");
    require(shot.payload_status === row.status);
    if (shot.status === "captured") {
      require(
        source.expected_groups.length > 0 &&
          shot.screenshots.length === source.expected_groups.length
      );
      require(row.counts?.groups === shot.screenshots.length);
      require(shot.screenshots.every((image, index) => image.group_index === index));
    }
    if (shot.status === "empty_verified")
      require(
        source.expected_groups.length === 0 &&
          row.status === "passed" &&
          shot.screenshots.length === 0
      );
    for (const image of shot.screenshots) {
      const bytes = images.get(image.file);
      if (!bytes) throw new Error("A2UI_EVIDENCE_INVALID");
      const png = Buffer.from(bytes.base64, "base64");
      require(!used.has(image.file) && png.toString("base64") === bytes.base64);
      require(
        png.length >= 24 &&
          png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      );
      require(a2uiHash(png) === image.sha256 && image.sha256 === bytes.sha256);
      used.add(image.file);
    }
    return {
      caseId: row.case_id,
      title: row.title,
      automatic: row.status,
      capture: shot.status,
      images: shot.screenshots.map((image) => ({
        file: image.file,
        sha256: image.sha256,
        groupIndex: image.group_index
      })),
      manual:
        shot.status === "captured"
          ? ("pending" as const)
          : shot.status === "empty_verified"
            ? ("not_applicable" as const)
            : ("unavailable" as const)
    };
  });
  require(used.size === images.size);
  return result;
}
/** Manual approval never overrides automatic or capture failures. */
export function a2uiOverall(cases: A2uiReview["cases"]): A2uiReview["overall"] {
  if (
    cases.some(
      (row) => row.automatic !== "passed" || row.capture === "error" || row.manual === "rejected"
    )
  )
    return "failed";
  return cases.some((row) => row.manual === "pending") ? "pending" : "passed";
}
