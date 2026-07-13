import { AnalysisPromptVariableV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import { Plus, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactElement, type Ref } from "react";
import { useFieldArray, useForm, type FieldPath, type UseFormReturn } from "react-hook-form";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from "../../components/ui/form.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../../components/ui/select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { ApiClientError } from "../../lib/api-client.ts";
import { usePageLeaveBlocker } from "../../lib/use-page-leave-blocker.ts";
import {
  acceptConfigurationSnapshot,
  createConfigurationConflict,
  type ConfigurationEditorConflict
} from "../../lib/editor-conflict.ts";
import type { AnalysisPromptDefinition, RubricPromptDefinition } from "../../lib/resource-api.ts";
import { formatMessage, message } from "../../messages/messages.ts";
import type {
  ConfigurationEditorProps,
  ConfigurationRevisionBaseline
} from "./configuration-editor.tsx";
import {
  promptApiPathToFormField,
  promptDefinitionToForm,
  promptFormToDefinition,
  type PromptFormValues
} from "./configuration-form-mappers.ts";

type PromptResource = Extract<
  NonNullable<ConfigurationEditorProps["resource"]>,
  { readonly kind: "LLM_RUBRIC_PROMPT" | "CASE_ANALYSIS_PROMPT" }
>;

type ConfigurationResource = NonNullable<ConfigurationEditorProps["resource"]>;

interface PromptRevisionBaseline {
  /** Stable Prompt Configuration identity. */
  readonly id: string;
  /** Revision used by the next conditional write. */
  readonly revision: number;
}

const DEFAULT_PROMPT_FORM: PromptFormValues = {
  name: "",
  promptKey: "",
  messages: [{ role: "SYSTEM", content: "" }]
};

// Locate one sanitized server path in the Prompt form and focus the rejected field.
function applyPromptServerFormError(
  form: UseFormReturn<PromptFormValues>,
  error: unknown,
  focus: (field: FieldPath<PromptFormValues>) => void
): boolean {
  if (!(error instanceof ApiClientError) || error.fieldPath === null) return false;
  const field = promptApiPathToFormField(error.fieldPath);
  if (field === null) return false;
  const typedField = field as FieldPath<PromptFormValues>;
  form.setError(typedField, {
    type: "server",
    message: formatMessage("config.serverFieldInvalid", { path: error.fieldPath })
  });
  focus(typedField);
  return true;
}

// Narrow the editor resource to either Prompt family.
function currentPromptResource(props: ConfigurationEditorProps): PromptResource | null {
  if (props.resource?.kind === "LLM_RUBRIC_PROMPT") return props.resource;
  if (props.resource?.kind === "CASE_ANALYSIS_PROMPT") return props.resource;
  return null;
}

// Reject a boundary-valid but route-inconsistent resource before it reaches editor state.
function requirePromptResource(
  resource: ConfigurationResource,
  expectedKind: PromptResource["kind"]
): PromptResource {
  if (resource.kind === expectedKind) return resource;
  throw new ApiClientError("CLIENT_RESPONSE_INVALID");
}

// Persist one typed Prompt through create or optimistic update.
async function savePromptDefinition(
  props: ConfigurationEditorProps,
  baseline: PromptRevisionBaseline | null,
  name: string,
  definition: RubricPromptDefinition | AnalysisPromptDefinition
): Promise<PromptResource> {
  if (definition.kind === "LLM_RUBRIC") {
    if (baseline === null) {
      return requirePromptResource(
        await props.api.createConfiguration(
          "LLM_RUBRIC_PROMPT",
          { name, definition },
          new AbortController().signal
        ),
        "LLM_RUBRIC_PROMPT"
      );
    }
    return requirePromptResource(
      await props.api.updateConfiguration(
        "LLM_RUBRIC_PROMPT",
        baseline.id,
        { name, definition, expectedRevision: baseline.revision },
        new AbortController().signal
      ),
      "LLM_RUBRIC_PROMPT"
    );
  }
  if (baseline === null) {
    return requirePromptResource(
      await props.api.createConfiguration(
        "CASE_ANALYSIS_PROMPT",
        { name, definition },
        new AbortController().signal
      ),
      "CASE_ANALYSIS_PROMPT"
    );
  }
  return requirePromptResource(
    await props.api.updateConfiguration(
      "CASE_ANALYSIS_PROMPT",
      baseline.id,
      { name, definition, expectedRevision: baseline.revision },
      new AbortController().signal
    ),
    "CASE_ANALYSIS_PROMPT"
  );
}

// Render a controlled shadcn/ui Select for one Prompt role.
function PromptRoleSelect({
  value,
  onChange,
  label,
  triggerRef
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
  /** React Hook Form ref used to focus one rejected role. */
  readonly triggerRef?: Ref<HTMLButtonElement>;
}): ReactElement {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger ref={triggerRef} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {["SYSTEM", "USER", "ASSISTANT"].map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Render the explicit local Prompt Draft versus refetched server Snapshot decision.
function PromptConflictNotice({
  conflict,
  onRetry,
  onAccept,
  disabled
}: {
  readonly conflict: ConfigurationEditorConflict<RubricPromptDefinition | AnalysisPromptDefinition>;
  readonly onRetry: () => void;
  readonly onAccept: () => void;
  readonly disabled: boolean;
}): ReactElement {
  return (
    <Alert>
      <AlertTitle>
        <h3>{message("conflict.title")}</h3>
      </AlertTitle>
      <AlertDescription>
        <p>{message("conflict.description")}</p>
        <p>{formatMessage("conflict.localDraft", { description: conflict.draft.name })}</p>
        <p>
          {formatMessage("conflict.serverVersion", { description: conflict.serverSnapshot.name })}
        </p>
        <div className="conflict-actions">
          <Button type="button" disabled={disabled} onClick={onRetry}>
            {message("conflict.retryLatest")}
          </Button>
          <Button type="button" variant="outline" disabled={disabled} onClick={onAccept}>
            {message("conflict.acceptServer")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

// Render compact tag lists inside Analysis Prompt previews.
function Tags({ values }: { readonly values: readonly string[] }): ReactElement {
  return (
    <div className="tag-list">
      {values.map((value) => (
        <Badge key={value} variant="secondary">
          {value}
        </Badge>
      ))}
    </div>
  );
}

/** Prompt editor shared by Rubric and Analysis resources. */
export function PromptConfigurationEditor(props: ConfigurationEditorProps): ReactElement {
  const promptResource = currentPromptResource(props);
  const [baseline, setBaseline] = useState<PromptRevisionBaseline | null>(() =>
    promptResource === null ? null : { id: promptResource.id, revision: promptResource.revision }
  );
  const form = useForm<PromptFormValues>({
    defaultValues:
      promptResource === null
        ? DEFAULT_PROMPT_FORM
        : promptDefinitionToForm(promptResource.name, promptResource.definition)
  });
  const messages = useFieldArray({ control: form.control, name: "messages" });
  const [preview, setPreview] = useState<
    | {
        readonly kind: "RUBRIC";
        readonly promptKey: string;
        readonly messages: readonly { readonly role: string; readonly content: string }[];
      }
    | { readonly kind: "ANALYSIS"; readonly variables: readonly string[] }
    | null
  >(null);
  const [error, setError] = useState<"PREVIEW" | "SAVE" | null>(null);
  const [busy, setBusy] = useState<"IDLE" | "PREVIEW" | "SAVE">("IDLE");
  const busyRef = useRef(false);
  const [deferredFocus, setDeferredFocus] = useState<FieldPath<PromptFormValues> | null>(null);
  const [conflict, setConflict] = useState<ConfigurationEditorConflict<
    RubricPromptDefinition | AnalysisPromptDefinition
  > | null>(null);
  const definitionKind = props.kind === "LLM_RUBRIC_PROMPT" ? "LLM_RUBRIC" : "CASE_ANALYSIS";
  usePageLeaveBlocker(busy !== "IDLE" || conflict !== null, props.onLeaveBlockedChange);

  useLayoutEffect(() => {
    if (busy !== "IDLE" || deferredFocus === null) return;
    form.setFocus(deferredFocus);
    setDeferredFocus(null);
  }, [busy, deferredFocus, form]);

  // Focus now for local errors or defer until an in-flight request unlocks the form.
  const focusField = (field: FieldPath<PromptFormValues>): void => {
    if (busyRef.current) {
      setDeferredFocus(field);
      return;
    }
    form.setFocus(field);
  };

  // Map current Prompt fields through the matching strict Contract.
  const definition = (): RubricPromptDefinition | AnalysisPromptDefinition | null => {
    const result = promptFormToDefinition(definitionKind, form.getValues());
    if (!result.ok) {
      form.setError(result.field as never, {
        type: "contract",
        message: message("config.formInvalid")
      });
      focusField(result.field as FieldPath<PromptFormValues>);
      return null;
    }
    form.clearErrors();
    return result.definition;
  };

  // Ask the server for the matching unsaved Prompt preview.
  const runPreview = async (): Promise<void> => {
    if (busyRef.current) return;
    const parsed = definition();
    if (parsed === null) return;
    busyRef.current = true;
    setBusy("PREVIEW");
    props.onBusyChange?.(true);
    try {
      if (parsed.kind === "LLM_RUBRIC") {
        const result = await props.api.previewRubricPrompt(parsed, new AbortController().signal);
        setPreview({ kind: "RUBRIC", ...result });
      } else {
        const result = await props.api.previewAnalysisPrompt(parsed, new AbortController().signal);
        setPreview({ kind: "ANALYSIS", variables: result.variables });
      }
      setError(null);
    } catch (caught) {
      if (applyPromptServerFormError(form, caught, focusField)) {
        setError(null);
        return;
      }
      setError("PREVIEW");
    } finally {
      busyRef.current = false;
      setBusy("IDLE");
      props.onBusyChange?.(false);
    }
  };

  // Explicitly persist one Prompt after strict local mapping.
  const save = async (
    saveBaseline: ConfigurationRevisionBaseline | null = baseline
  ): Promise<void> => {
    if (busyRef.current) return;
    const parsed = definition();
    if (parsed === null) return;
    busyRef.current = true;
    setBusy("SAVE");
    props.onBusyChange?.(true);
    try {
      const saved = await savePromptDefinition(props, saveBaseline, form.getValues("name"), parsed);
      await props.onSaved(saved);
      setConflict(null);
    } catch (caught) {
      if (
        caught instanceof ApiClientError &&
        caught.code === "RESOURCE_REVISION_CONFLICT" &&
        saveBaseline !== null
      ) {
        try {
          const latest = await props.api.getConfiguration(
            props.kind,
            saveBaseline.id,
            new AbortController().signal
          );
          if (
            (latest.kind === "LLM_RUBRIC_PROMPT" && parsed.kind === "LLM_RUBRIC") ||
            (latest.kind === "CASE_ANALYSIS_PROMPT" && parsed.kind === "CASE_ANALYSIS")
          ) {
            props.onSnapshot?.(latest);
            setConflict(
              createConfigurationConflict({
                draft: { name: form.getValues("name"), definition: parsed },
                serverSnapshot: {
                  name: latest.name,
                  definition: latest.definition,
                  revision: latest.revision
                }
              })
            );
            setError(null);
            return;
          }
        } catch {
          setError("SAVE");
          return;
        }
      }
      if (applyPromptServerFormError(form, caught, focusField)) {
        setError(null);
        return;
      }
      setError("SAVE");
    } finally {
      busyRef.current = false;
      setBusy("IDLE");
      props.onBusyChange?.(false);
    }
  };

  return (
    <Form {...form}>
      <form className="form-stack" onSubmit={(event) => event.preventDefault()}>
        <fieldset className="editor-fieldset" disabled={busy !== "IDLE" || conflict !== null}>
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{message("config.name")}</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="promptKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{message("prompt.promptKey")}</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormDescription>{message("config.sheetDescription")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <section className="nested-editor">
            <div className="section-heading compact">
              <h3>{message("prompt.messages")}</h3>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => messages.append({ role: "USER", content: "" })}
              >
                <Plus aria-hidden="true" />
                {message("prompt.addMessage")}
              </Button>
            </div>
            {messages.fields.map((item, index) => (
              <div className="prompt-message-row" key={item.id}>
                <FormField
                  control={form.control}
                  name={`messages.${index}.role`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{message("prompt.role")}</FormLabel>
                      <PromptRoleSelect
                        value={field.value}
                        onChange={field.onChange}
                        label={`${message("prompt.role")} ${index + 1}`}
                        triggerRef={field.ref}
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={`messages.${index}.content`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{message("prompt.content")}</FormLabel>
                      <FormControl>
                        <Textarea rows={5} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={formatMessage("prompt.removeMessage", { index: index + 1 })}
                  onClick={() => messages.remove(index)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            ))}
          </section>
          {props.kind === "CASE_ANALYSIS_PROMPT" ? (
            <section className="reference-panel">
              <h3>{message("prompt.allowedVariables")}</h3>
              <Tags values={AnalysisPromptVariableV1Schema.options} />
            </section>
          ) : null}
          {props.kind === "LLM_RUBRIC_PROMPT" ? (
            <section className="reference-panel">
              <h3>{message("prompt.references")}</h3>
              {props.rubricReferences.length === 0 ? (
                <p>{message("prompt.noReferences")}</p>
              ) : (
                props.rubricReferences.map((reference) => (
                  <div key={`${reference.suiteId}:${reference.caseKey}`}>
                    <Badge variant="outline">{reference.caseKey}</Badge>
                    <span>{reference.suiteId}</span>
                  </div>
                ))
              )}
            </section>
          ) : null}
          {preview === null ? null : (
            <section className="preview-panel">
              <h3>{message("prompt.previewTitle")}</h3>
              {preview.kind === "RUBRIC" ? (
                <>
                  <Badge>{preview.promptKey}</Badge>
                  {preview.messages.map((item, index) => (
                    <pre key={`${item.role}-${index}`}>{item.content}</pre>
                  ))}
                </>
              ) : (
                <Tags values={preview.variables} />
              )}
            </section>
          )}
          {error === null ? null : (
            <Alert variant="destructive">
              <AlertTitle>
                {message(error === "PREVIEW" ? "prompt.previewError" : "config.saveError")}
              </AlertTitle>
            </Alert>
          )}
        </fieldset>
        {conflict === null ? null : (
          <PromptConflictNotice
            conflict={conflict}
            disabled={busy !== "IDLE"}
            onRetry={() => {
              if (busyRef.current || baseline === null) return;
              const retryBaseline = {
                id: baseline.id,
                revision: conflict.serverSnapshot.revision
              };
              setBaseline(retryBaseline);
              void save(retryBaseline);
            }}
            onAccept={() => {
              if (busyRef.current) return;
              const snapshot = acceptConfigurationSnapshot(conflict);
              form.reset(promptDefinitionToForm(snapshot.name, snapshot.definition));
              if (baseline !== null) {
                setBaseline({ id: baseline.id, revision: snapshot.revision });
              }
              setConflict(null);
            }}
          />
        )}
        <div className="editor-actions">
          <Button
            type="button"
            variant="outline"
            disabled={busy !== "IDLE" || conflict !== null}
            onClick={() => void runPreview()}
          >
            {props.kind === "LLM_RUBRIC_PROMPT"
              ? message("prompt.previewMessages")
              : message("prompt.previewVariables")}
          </Button>
          <Button
            type="button"
            disabled={busy !== "IDLE" || conflict !== null}
            onClick={() => void save()}
          >
            {busy === "SAVE" ? message("config.saving") : message("config.save")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
