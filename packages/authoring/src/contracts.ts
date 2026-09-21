import { z } from "zod";

export const AuthoringProfileSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  case_id_template: z.string().min(1),
  required_sections: z.array(z.string().min(1)).default([]),
  required_capabilities: z.array(z.string().min(1)).default([]),
  required_assertion_templates: z.array(z.string().min(1)).default([]),
  require_fixtures: z.boolean().default(true),
  require_evidence: z.boolean().default(true),
  default_threshold: z.number().min(0).max(1).default(1),
  a2ui_capture: z.boolean().default(false)
});
export type AuthoringProfile = z.infer<typeof AuthoringProfileSchema>;

export const CapabilitySchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  domain: z.string().min(1),
  description: z.string().min(1),
  tool_id: z.string().min(1),
  evidence_paths: z.array(z.string().min(1)).default([]),
  read_only: z.boolean().default(true)
});
export type Capability = z.infer<typeof CapabilitySchema>;

export const ToolBindingSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  runtime_name: z.string().min(1),
  description: z.string().min(1)
});
export type ToolBinding = z.infer<typeof ToolBindingSchema>;

export const A2uiComponentSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  runtime_component: z.string().min(1),
  evidence: z.array(z.string().min(1)).default([])
});
export type A2uiComponent = z.infer<typeof A2uiComponentSchema>;

export const AssertionTemplateSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  type: z.enum(["agent-executions", "agent-reply", "field-exists"]),
  description: z.string().min(1),
  blocking: z.boolean().default(true)
});
export type AssertionTemplate = z.infer<typeof AssertionTemplateSchema>;

export const FixtureSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  branch: z.string().min(1),
  status: z.enum(["available", "missing", "external"]),
  description: z.string().min(1)
});
export type Fixture = z.infer<typeof FixtureSchema>;

export interface ParsedSource {
  readonly sourcePath: string;
  readonly title: string;
  readonly sections: Readonly<Record<string, string>>;
  readonly userInput: string | null;
  readonly detectedCapabilities: readonly string[];
  readonly detectedTools: readonly string[];
  readonly detectedA2ui: readonly string[];
  readonly branches: readonly string[];
  readonly branchMatrix: string;
  readonly readOnlyExpectation: boolean;
  readonly requiresEvidence: boolean;
}

export interface CaseSpecIr {
  readonly id: string;
  readonly title: string;
  readonly sourcePath: string;
  readonly profile: Pick<AuthoringProfile, "id" | "version">;
  readonly domain: string;
  readonly userInput: string | null;
  readonly capabilities: readonly string[];
  readonly branches: readonly string[];
  readonly branchMatrix: string;
  readonly detectedTools: readonly string[];
  readonly detectedA2ui: readonly string[];
  readonly constraints: {
    readonly readOnly: boolean;
    readonly requiresEvidence: boolean;
  };
}

export type ReadinessCode =
  | "SOURCE_SECTION_MISSING"
  | "SOURCE_SECTION_EMPTY"
  | "BRANCHES_MISSING"
  | "TEST_DATA_MISSING"
  | "CAPABILITY_UNRESOLVED"
  | "TOOL_UNRESOLVED"
  | "A2UI_UNRESOLVED"
  | "ASSERTION_TEMPLATE_MISSING"
  | "FIXTURE_MISSING"
  | "USER_INPUT_MISSING"
  | "EVIDENCE_UNAVAILABLE"
  | "GENERATED_CASE_INVALID";

export interface ReadinessIssue {
  readonly code: ReadinessCode;
  readonly message: string;
  readonly blocking: boolean;
  readonly path?: string;
}

export interface ReadinessReport {
  readonly status: "READY" | "BLOCKED";
  readonly sourcePath: string;
  readonly profile: string;
  readonly issues: readonly ReadinessIssue[];
  readonly resolved: {
    readonly capabilities: readonly string[];
    readonly capabilityBindings: readonly {
      capability: string;
      tool: string;
      runtimeName: string;
    }[];
    readonly runtimeTools: readonly string[];
    readonly a2ui: readonly string[];
    readonly fixtures: readonly string[];
    readonly assertionTemplates: readonly string[];
  };
}

export interface BuildOutput {
  readonly ir: CaseSpecIr;
  readonly readiness: ReadinessReport;
  readonly cases: readonly Record<string, unknown>[];
  readonly manifest: {
    readonly generator: string;
    readonly profile: string;
    readonly sourcePath: string;
    readonly readiness: ReadinessReport["status"];
    readonly caseIds: readonly string[];
  };
}
