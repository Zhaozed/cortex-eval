import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import { useCallback, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { useForm } from "react-hook-form";

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
  replaceAssertionJson,
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

type StructuredErrorTarget = "ROOT" | "REQUEST_BODY" | "ASSERTION";

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
    scenarioTag: definition.metadata.scenario_tag
  };
}

// Serialize arbitrary validated JSON for one focused editor field.
function formattedJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Lossless structured/full-JSON Case editor sharing one validated Draft. */
export function CaseEditor({
  initialDefinition,
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
  const requestBodyRef = useRef<HTMLTextAreaElement>(null);
  const assertionRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const fullJsonRef = useRef<HTMLTextAreaElement>(null);
  const deferredFocusRef = useRef<(() => void) | null>(null);
  const consumedExternalSaveErrorIdRef = useRef<number | null>(null);
  const form = useForm<StructuredCaseFields>({
    defaultValues: structuredValues(initialDefinition)
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
    for (const [index, text] of assertionTexts.entries()) {
      const assertion = replaceAssertionJson(next, index, text);
      if (!assertion.ok) {
        reportStructuredError(message("caseEditor.assertionInvalid"), "ASSERTION", index);
        return null;
      }
      next = assertion.state;
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
      <form onSubmit={(event) => event.preventDefault()} className="case-editor-form">
        <fieldset className="case-editor-fieldset" disabled={saving || disabled}>
          <Tabs value={editor.mode} onValueChange={changeMode}>
            <TabsList aria-label={message("caseEditor.modeLabel")}>
              <TabsTrigger value="STRUCTURED">{message("caseEditor.structured")}</TabsTrigger>
              <TabsTrigger value="JSON">{message("caseEditor.json")}</TabsTrigger>
            </TabsList>
            <TabsContent value="STRUCTURED" className="case-structured-grid">
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
                  ["task", "caseEditor.task"],
                  ["reqId", "caseEditor.reqId"],
                  ["taskId", "caseEditor.taskId"],
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
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
              <div className="field-wide grid gap-2">
                <Label htmlFor="case-request-body">{message("caseEditor.requestBody")}</Label>
                <Textarea
                  ref={requestBodyRef}
                  id="case-request-body"
                  aria-invalid={structuredError?.target === "REQUEST_BODY"}
                  aria-describedby={
                    structuredError?.target === "REQUEST_BODY" ? "case-structured-error" : undefined
                  }
                  value={requestBodyText}
                  onChange={(event) => {
                    setRequestBodyText(event.currentTarget.value);
                    if (structuredError?.target === "REQUEST_BODY") setStructuredError(null);
                  }}
                  rows={7}
                />
              </div>
              {assertionTexts.map((text, index) => (
                <div className="field-wide grid gap-2" key={`assertion-${index}`}>
                  <Label htmlFor={`case-assertion-${index}`}>
                    {message("caseEditor.assertion")} {index + 1}
                  </Label>
                  <Textarea
                    ref={(element) => {
                      assertionRefs.current[index] = element;
                    }}
                    id={`case-assertion-${index}`}
                    aria-invalid={
                      structuredError?.target === "ASSERTION" &&
                      structuredError.assertionIndex === index
                    }
                    aria-describedby={
                      structuredError?.target === "ASSERTION" &&
                      structuredError.assertionIndex === index
                        ? "case-structured-error"
                        : undefined
                    }
                    value={text}
                    onChange={(event) => {
                      const next = [...assertionTexts];
                      next[index] = event.currentTarget.value;
                      setAssertionTexts(next);
                      if (
                        structuredError?.target === "ASSERTION" &&
                        structuredError.assertionIndex === index
                      ) {
                        setStructuredError(null);
                      }
                    }}
                    rows={9}
                  />
                </div>
              ))}
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
