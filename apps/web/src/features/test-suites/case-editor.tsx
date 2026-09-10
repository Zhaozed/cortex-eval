import {
  ASSERTION_ISSUES,
  caseAssertionsIssue
} from "@cortex-eval/contracts/src/assertion-rules/authoring-validation.ts";
import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import { useCallback, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { useForm } from "react-hook-form";

import { caseAssertionAuthoringError } from "./case-authoring-validation.ts";
import { CaseCreatableSelect } from "./case-choice-fields.tsx";
import { newCaseAssertion } from "./case-field-rule.ts";
import { CaseAssertionFields } from "./case-assertion-fields.tsx";
import { CaseRequestFields } from "./case-request-fields.tsx";
import { EMPTY_CASE_FILTER_OPTIONS, type CaseFilterOptions } from "./case-filter-options.ts";
import { Button } from "../../components/ui/button.tsx";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from "../../components/ui/form.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { ApiClientError } from "../../lib/api-client.ts";
import { formatMessage, message } from "../../messages/messages.ts";
import {
  applyStructuredCaseFields,
  caseApiPathToEditorField,
  createCaseEditorState,
  replaceAllAssertionsJson,
  replaceRequestBodyJson,
  switchCaseEditorMode,
  updateFullCaseJson,
  type CaseEditorState,
  type StructuredCaseFields
} from "./case-editor-state.ts";

const CASE_API_FORM_FIELDS: Readonly<Record<string, keyof StructuredCaseFields>> = {
  description: "description",
  threshold: "threshold",
  "vars.task": "task",
  "metadata.case_id": "caseId",
  "metadata.req_id": "reqId",
  "metadata.task_id": "taskId",
  "metadata.business_module": "businessModule",
  "metadata.scenario_tag": "scenarioTag"
};

type StructuredErrorTarget = "ROOT" | "REQUEST_BODY" | "ASSERTION" | "GUIDED_ASSERTION";

interface StructuredEditorError {
  /** User-facing error from the checked message catalog. */
  readonly message: string;
  /** Nearest structured editor control owning the error. */
  readonly target: StructuredErrorTarget;
  /** Zero-based Assertion index when the target is one Assertion. */
  readonly assertionIndex: number | null;
}

/** One parent-originated save failure delivered exactly once to a retained editor. */
export interface CaseEditorExternalSaveError {
  /** Monotonic owner-local event identity. */
  readonly eventId: number;
  /** Sanitized failure to map into the current editor mode. */
  readonly error: ApiClientError;
}

/** Case editor properties. */
export interface CaseEditorProps {
  readonly options?: CaseFilterOptions | undefined;
  readonly creating?: boolean;
  /** Initial server or create-default definition. */
  readonly initialDefinition: CaseDefinitionV1;
  /** Save the current validated shared Draft. */
  readonly onSave: (definition: CaseDefinitionV1) => Promise<void> | void;
  /** Disable save while an owning mutation decision is pending. */
  readonly disabled?: boolean;
  /** Save failure produced by an explicit parent-owned recovery retry. */
  readonly externalSaveError?: CaseEditorExternalSaveError | null;
  /** Acknowledge one consumed external save error event. */
  readonly onExternalSaveErrorHandled?: (eventId: number) => void;
}

// Derive visible structured values from one valid Draft.
function structuredValues(definition: CaseDefinitionV1): StructuredCaseFields {
  return {
    caseId: definition.metadata.case_id,
    description: definition.description,
    threshold: definition.threshold,
    task: definition.vars.task,
    reqId: definition.metadata.req_id,
    taskId: definition.metadata.task_id,
    businessModule: definition.metadata.business_module,
    scenarioTag: definition.metadata.scenario_tag,
    ...(definition.metadata.a2ui_capture === undefined
      ? {}
      : { a2uiCapture: definition.metadata.a2ui_capture })
  };
}

// Serialize arbitrary validated JSON for one focused editor field.
function formattedJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Lossless structured/full-JSON Case editor sharing one validated Draft. */
export function CaseEditor({
  initialDefinition,
  options = EMPTY_CASE_FILTER_OPTIONS,
  creating = false,
  onSave,
  disabled = false,
  externalSaveError = null,
  onExternalSaveErrorHandled
}: CaseEditorProps): ReactElement {
  const [editor, setEditor] = useState(() => createCaseEditorState(initialDefinition));
  const [requestBodyText, setRequestBodyText] = useState(() =>
    formattedJson(initialDefinition.vars.request_body)
  );
  const [assertionTexts, setAssertionTexts] = useState(() =>
    initialDefinition.assert.map(formattedJson)
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [structuredError, setStructuredError] = useState<StructuredEditorError | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const requestBodyRef = useRef<HTMLTextAreaElement>(null);
  const assertionRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const fullJsonRef = useRef<HTMLTextAreaElement>(null);
  const deferredFocusRef = useRef<(() => void) | null>(null);
  const consumedExternalSaveErrorIdRef = useRef<number | null>(null);
  const form = useForm<StructuredCaseFields>({
    defaultValues: creating
      ? {
          ...structuredValues(initialDefinition),
          description: "",
          task: "",
          businessModule: "",
          scenarioTag: ""
        }
      : structuredValues(initialDefinition)
  });

  useLayoutEffect(() => {
    if (saving || deferredFocusRef.current === null) return;
    const focus = deferredFocusRef.current;
    deferredFocusRef.current = null;
    focus();
  }, [saving]);

  // Focus immediately when enabled, otherwise defer until the save lock releases.
  const focusAfterSave = useCallback((focus: () => void): void => {
    if (savingRef.current) {
      deferredFocusRef.current = focus;
      return;
    }
    focus();
  }, []);

  // Associate one structured error with its nearest control and move focus there.
  const reportStructuredError = useCallback(
    (
      errorMessage: string,
      target: StructuredErrorTarget,
      assertionIndex: number | null = null
    ): void => {
      setStructuredError({ message: errorMessage, target, assertionIndex });
      if (target === "REQUEST_BODY") {
        focusAfterSave(() => requestBodyRef.current?.focus());
      }
      if (target === "ASSERTION" && assertionIndex !== null) {
        focusAfterSave(() => assertionRefs.current[assertionIndex]?.focus());
      }
    },
    [focusAfterSave]
  );

  // Map one sanitized save failure into the editor mode that owns the retained Draft.
  const reportSaveError = useCallback(
    (error: unknown, savingFromJson: boolean): void => {
      if (error instanceof ApiClientError && error.fieldPath !== null) {
        const errorMessage = formatMessage("caseEditor.serverFieldInvalid", {
          path: error.fieldPath
        });
        if (savingFromJson) {
          setJsonError(errorMessage);
          focusAfterSave(() => fullJsonRef.current?.focus());
          return;
        }
        const editorField = caseApiPathToEditorField(error.fieldPath);
        const formField = CASE_API_FORM_FIELDS[editorField];
        if (formField !== undefined) {
          form.setError(formField, { type: "server", message: errorMessage });
          focusAfterSave(() => form.setFocus(formField));
          return;
        }
        if (editorField === "vars.request_body") {
          reportStructuredError(errorMessage, "REQUEST_BODY");
          return;
        }
        if (editorField.startsWith("assert.")) {
          const assertionIndex = Number(editorField.split(".")[1]);
          reportStructuredError(errorMessage, "ASSERTION", assertionIndex);
          return;
        }
        reportStructuredError(errorMessage, "ROOT");
        return;
      }
      if (savingFromJson) {
        setJsonError(message("caseEditor.saveFailed"));
        focusAfterSave(() => fullJsonRef.current?.focus());
        return;
      }
      reportStructuredError(message("caseEditor.saveFailed"), "ROOT");
    },
    [focusAfterSave, form, reportStructuredError]
  );

  useLayoutEffect(() => {
    if (externalSaveError === null) return;
    if (consumedExternalSaveErrorIdRef.current === externalSaveError.eventId) return;
    consumedExternalSaveErrorIdRef.current = externalSaveError.eventId;
    reportSaveError(externalSaveError.error, editor.mode === "JSON");
    onExternalSaveErrorHandled?.(externalSaveError.eventId);
  }, [editor.mode, externalSaveError, onExternalSaveErrorHandled, reportSaveError]);

  // Compile all structured controls into one Contract-valid shared Draft.
  const compileStructured = (): CaseEditorState | null => {
    const fields = applyStructuredCaseFields(editor, form.getValues());
    if (!fields.ok) {
      const editorField = caseApiPathToEditorField(fields.errorPath);
      const formField = CASE_API_FORM_FIELDS[editorField];
      if (formField !== undefined) {
        form.setError(formField, { type: "contract", message: message("caseEditor.fieldInvalid") });
        focusAfterSave(() => form.setFocus(formField));
      } else {
        reportStructuredError(message("caseEditor.fieldInvalid"), "ROOT");
      }
      return null;
    }
    let next = fields.state;
    const body = replaceRequestBodyJson(next, requestBodyText);
    if (!body.ok) {
      reportStructuredError(message("caseEditor.requestBodyInvalid"), "REQUEST_BODY");
      return null;
    }
    next = body.state;
    const assertions = replaceAllAssertionsJson(next, assertionTexts);
    if (!assertions.ok) {
      const index = Number(assertions.errorPath.split(".")[1]);
      reportStructuredError(
        message("caseEditor.assertionInvalid"),
        "ASSERTION",
        Number.isFinite(index) ? index : 0
      );
      return null;
    }
    next = assertions.state;
    for (const [index, assertion] of next.draft.assert.entries()) {
      const error = caseAssertionAuthoringError(assertion);
      if (error !== null) {
        setStructuredError({ message: error, target: "GUIDED_ASSERTION", assertionIndex: index });
        const card = formRef.current?.querySelectorAll(".case-rule-card")[index];
        (card?.querySelector("[data-guided-target]") as HTMLElement | null)?.focus();
        return null;
      }
    }
    setStructuredError(null);
    return next;
  };

  // Change tabs only when the source mode can produce a valid shared Draft.
  const changeMode = (value: string): void => {
    if (value === "JSON") {
      const compiled = compileStructured();
      if (compiled === null) return;
      const result = switchCaseEditorMode(compiled, "JSON");
      if (result.ok) setEditor(result.state);
      return;
    }
    const result = switchCaseEditorMode(editor, "STRUCTURED");
    if (!result.ok) {
      setJsonError(message("caseEditor.jsonInvalid"));
      return;
    }
    setJsonError(null);
    setEditor(result.state);
    form.reset(structuredValues(result.state.draft));
    setRequestBodyText(formattedJson(result.state.draft.vars.request_body));
    setAssertionTexts(result.state.draft.assert.map(formattedJson));
  };

  // Save only the currently validated shared Draft.
  const save = async (): Promise<void> => {
    if (savingRef.current) return;

    const savingFromJson = editor.mode === "JSON";
    const state =
      editor.mode === "STRUCTURED"
        ? compileStructured()
        : switchCaseEditorMode(editor, "STRUCTURED");
    if (state === null || ("ok" in state && !state.ok)) {
      if (state !== null) setJsonError(message("caseEditor.jsonInvalid"));
      return;
    }
    const next = "ok" in state ? state.state : state;
    if (savingFromJson) {
      for (const assertion of next.draft.assert) {
        const error = caseAssertionAuthoringError(assertion);
        if (error !== null) {
          setJsonError(error);
          fullJsonRef.current?.focus();
          return;
        }
      }
    }
    const caseIssue = caseAssertionsIssue(next.draft.assert);
    if (caseIssue) {
      const error = ASSERTION_ISSUES[caseIssue.code];
      if (savingFromJson) setJsonError(error);
      else setStructuredError({ message: error, target: "GUIDED_ASSERTION", assertionIndex: 0 });
      return;
    }
    if (!savingFromJson && formRef.current?.reportValidity() === false) return;
    if (!savingFromJson) setEditor(next);
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave(next.draft);
    } catch (error) {
      reportSaveError(error, savingFromJson);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Form {...form}>
      <form ref={formRef} onSubmit={(event) => event.preventDefault()} className="case-editor-form">
        <fieldset className="case-editor-fieldset" disabled={saving || disabled}>
          <Tabs value={editor.mode} onValueChange={changeMode}>
            <TabsList aria-label={message("caseEditor.modeLabel")}>
              <TabsTrigger value="STRUCTURED">{message("caseEditor.structured")}</TabsTrigger>
              <TabsTrigger value="JSON">{message("caseEditor.json")}</TabsTrigger>
            </TabsList>
            <TabsContent value="STRUCTURED" className="case-structured-grid">
              <div className="field-wide case-section-heading">
                <div>
                  <h3>基本信息</h3>
                  <p>描述要验收的业务目标，选择分类。技术字段和 JSON 放在高级设置中。</p>
                </div>
              </div>
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem className="field-wide">
                    <FormLabel>{message("caseEditor.description")}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {(
                [
                  ["task", "caseEditor.task"],
                  ["businessModule", "caseEditor.businessModule"],
                  ["scenarioTag", "caseEditor.scenarioTag"]
                ] as const
              ).map(([name, label]) => (
                <FormField
                  key={name}
                  control={form.control}
                  name={name}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{message(label)}</FormLabel>
                      {name === "businessModule" || name === "scenarioTag" ? (
                        <CaseCreatableSelect
                          label={message(label)}
                          selectRef={field.ref}
                          invalid={form.formState.errors[name] !== undefined}
                          value={field.value}
                          options={
                            name === "businessModule"
                              ? options.businessModules
                              : options.scenarioTags
                          }
                          onChange={field.onChange}
                        />
                      ) : (
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="任务名称，与运行配置约定保持一致"
                            list="case-task-options"
                          />
                        </FormControl>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
              <FormField
                control={form.control}
                name="a2uiCapture"
                render={({ field }) => (
                  <FormItem className="field-wide case-capture-option">
                    <FormLabel>
                      <FormControl>
                        <input
                          type="checkbox"
                          checked={field.value ?? false}
                          onChange={(event) => field.onChange(event.target.checked)}
                        />
                      </FormControl>
                      要求 A2UI 人工复核
                    </FormLabel>
                    <p>
                      仅此 Case
                      开启：在结果抽屉用真实出站数据动态渲染卡片，供人工复核。无卡片数据或渲染失败不会算视觉通过。
                    </p>
                  </FormItem>
                )}
              />
              <datalist id="case-task-options">
                <option value="agent-e2e" />
                <option value="planner" />
              </datalist>
              <details
                className="case-advanced field-wide"
                open={
                  form.formState.errors.caseId ||
                  form.formState.errors.threshold ||
                  form.formState.errors.reqId ||
                  form.formState.errors.taskId
                    ? true
                    : undefined
                }
              >
                <summary>高级设置 · 自动生成的标识与通过阈值</summary>
                <div className="case-structured-grid">
                  <FormField
                    control={form.control}
                    name="caseId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{message("caseEditor.caseId")}</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="threshold"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{message("caseEditor.threshold")}</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="0"
                            max="1"
                            step="0.01"
                            {...field}
                            onChange={(event) => field.onChange(event.currentTarget.valueAsNumber)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {(
                    [
                      ["reqId", "caseEditor.reqId"],
                      ["taskId", "caseEditor.taskId"]
                    ] as const
                  ).map(([name, label]) => (
                    <FormField
                      key={name}
                      control={form.control}
                      name={name}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{message(label)}</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  ))}
                </div>
                <p className="field-hint">
                  默认通过阈值为 1。降低阈值或把断言权重设为 0，可能让部分检查失败仍然通过。
                </p>
              </details>
              <CaseRequestFields
                text={requestBodyText}
                rawRef={requestBodyRef}
                error={structuredError?.target === "REQUEST_BODY"}
                onChange={(text) => {
                  setRequestBodyText(text);
                  if (structuredError?.target === "REQUEST_BODY") setStructuredError(null);
                }}
              />
              <section className="case-editor-section field-wide">
                <div className="case-section-heading">
                  <div>
                    <h3>验收检查项</h3>
                    <p>
                      选择规则，再填写目标和预期。字段规则检查实际证据；不代替业务操作的安全拦截。
                    </p>
                  </div>
                </div>
                <datalist id="case-output-paths">
                  {[
                    "ok",
                    "parsed_output",
                    "parsed_output.reply_text",
                    "parsed_output.reply_type",
                    "parsed_output.tools",
                    "parsed_output.tool_executions"
                  ].map((path) => (
                    <option key={path} value={path} />
                  ))}
                </datalist>
                {assertionTexts.map((text, index) => (
                  <CaseAssertionFields
                    key={`assertion-${index}`}
                    text={text}
                    index={index}
                    metrics={options.metrics}
                    error={
                      structuredError?.target === "ASSERTION" &&
                      structuredError.assertionIndex === index
                    }
                    guidedError={
                      structuredError?.target === "GUIDED_ASSERTION" &&
                      structuredError.assertionIndex === index
                        ? structuredError.message
                        : null
                    }
                    rawRef={(element) => {
                      assertionRefs.current[index] = element;
                    }}
                    onChange={(text) => {
                      setAssertionTexts((current) =>
                        current.map((old, position) => (position === index ? text : old))
                      );
                      if (
                        structuredError?.target === "ASSERTION" ||
                        structuredError?.target === "GUIDED_ASSERTION"
                      )
                        setStructuredError(null);
                    }}
                    onRemove={() => {
                      setAssertionTexts((current) =>
                        current.filter((_, position) => position !== index)
                      );
                      setStructuredError(null);
                    }}
                  />
                ))}
                {assertionTexts.length === 0 ? (
                  <p role="status">尚无检查项，至少添加一项才能保存。</p>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setAssertionTexts((current) => [...current, formattedJson(newCaseAssertion())])
                  }
                >
                  ＋ 添加检查项
                </Button>
              </section>
              {structuredError === null ? null : (
                <p id="case-structured-error" className="field-wide form-error" role="alert">
                  {structuredError.message}
                </p>
              )}
            </TabsContent>
            <TabsContent value="JSON">
              <Label htmlFor="case-full-json">{message("caseEditor.fullJson")}</Label>
              <Textarea
                ref={fullJsonRef}
                id="case-full-json"
                aria-invalid={jsonError !== null}
                aria-describedby={jsonError === null ? undefined : "case-json-error"}
                value={editor.jsonText}
                onChange={(event) => {
                  setJsonError(null);
                  setEditor(updateFullCaseJson(editor, event.currentTarget.value));
                }}
                rows={24}
                className="mt-2"
              />
              {jsonError === null ? null : (
                <p id="case-json-error" className="form-error" role="alert">
                  {jsonError}
                </p>
              )}
            </TabsContent>
          </Tabs>
          <div className="editor-actions">
            <Button type="button" disabled={saving || disabled} onClick={() => void save()}>
              {saving ? message("caseEditor.saving") : message("caseEditor.save")}
            </Button>
          </div>
        </fieldset>
      </form>
    </Form>
  );
}
