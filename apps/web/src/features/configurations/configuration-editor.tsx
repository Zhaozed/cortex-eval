import { Plus, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactElement, type Ref } from "react";
import {
  useFieldArray,
  useForm,
  type FieldPath,
  type FieldValues,
  type UseFormReturn
} from "react-hook-form";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../../components/ui/select.tsx";
import { ApiClientError } from "../../lib/api-client.ts";
import { usePageLeaveBlocker } from "../../lib/use-page-leave-blocker.ts";
import {
  acceptConfigurationSnapshot,
  createConfigurationConflict,
  type ConfigurationEditorConflict
} from "../../lib/editor-conflict.ts";
import type {
  ConfigurationKind,
  ConfigurationResource,
  EndpointDefinition,
  LlmDefinition,
  ResourceApi
} from "../../lib/resource-api.ts";
import { formatMessage, message } from "../../messages/messages.ts";
import {
  endpointApiPathToFormField,
  endpointDefinitionToForm,
  endpointFormToDefinition,
  llmApiPathToFormField,
  llmDefinitionToForm,
  llmFormToDefinition,
  type EndpointFormValues,
  type LlmFormValues
} from "./configuration-form-mappers.ts";
import { PromptConfigurationEditor } from "./prompt-configuration-editor.tsx";

/** Persisted identity and Revision used by one conditional configuration save. */
export interface ConfigurationRevisionBaseline {
  /** Stable Configuration identity. */
  readonly id: string;
  /** Revision used by the next conditional write. */
  readonly revision: number;
}

/** Configuration editor properties. */
export interface ConfigurationEditorProps {
  /** Resource family selected by the current route. */
  readonly kind: ConfigurationKind;
  /** Existing resource, or null for create. */
  readonly resource: ConfigurationResource | null;
  /** Boundary-validating resource API. */
  readonly api: ResourceApi;
  /** Current Rubric Case references. */
  readonly rubricReferences: readonly { readonly suiteId: string; readonly caseKey: string }[];
  /** Notify the page after a successful explicit save. */
  readonly onSaved: (resource: ConfigurationResource) => Promise<void> | void;
  /** Notify the owning Sheet while validation or save is in flight. */
  readonly onBusyChange?: (busy: boolean) => void;
  /** Notify the owning page while work or a Revision decision blocks leaving. */
  readonly onLeaveBlockedChange?: (blocked: boolean) => void;
  /** Synchronize one conflict-refetched server Snapshot with owning caches. */
  readonly onSnapshot?: (resource: ConfigurationResource) => void;
}

const DEFAULT_ENDPOINT_FORM: EndpointFormValues = {
  name: "",
  urlTemplate: "",
  headers: [],
  bodySelector: "",
  timeoutMs: 60_000,
  defaultConcurrency: 4
};

const DEFAULT_LLM_FORM: LlmFormValues = {
  name: "",
  providerType: "GOOGLE_GEMINI",
  model: "",
  thinkingLevel: "OFF",
  temperature: 0,
  topP: 1,
  maxOutputTokens: 2_048,
  timeoutMs: 60_000,
  structuredOutput: "JSON_OBJECT",
  geminiApiKeyEnv: "",
  baseUrl: "",
  authKind: "NONE",
  bearerEnvKey: ""
};

// Locate one sanitized server path in a typed form and focus the rejected field.
function applyServerFormError<Values extends FieldValues>(
  form: UseFormReturn<Values>,
  error: unknown,
  locate: (path: string) => string | null,
  focus: (field: FieldPath<Values>) => void
): boolean {
  if (!(error instanceof ApiClientError) || error.fieldPath === null) return false;
  const field = locate(error.fieldPath);
  if (field === null) return false;
  const typedField = field as FieldPath<Values>;
  form.setError(typedField, {
    type: "server",
    message: formatMessage("config.serverFieldInvalid", { path: error.fieldPath })
  });
  focus(typedField);
  return true;
}

// Narrow one union resource to its route family or return null.
function matchingResource<Kind extends ConfigurationKind>(
  kind: Kind,
  resource: ConfigurationResource | null
): Extract<ConfigurationResource, { readonly kind: Kind }> | null {
  return resource?.kind === kind
    ? (resource as Extract<ConfigurationResource, { readonly kind: Kind }>)
    : null;
}

// Save one typed definition through create or optimistic update.
async function saveDefinition<Kind extends "ENDPOINT" | "LLM">(
  props: ConfigurationEditorProps,
  baseline: ConfigurationRevisionBaseline | null,
  kind: Kind,
  name: string,
  definition: Kind extends "ENDPOINT" ? EndpointDefinition : LlmDefinition
): Promise<ConfigurationResource> {
  if (baseline === null) {
    return props.api.createConfiguration(
      kind,
      { name, definition } as never,
      new AbortController().signal
    );
  }
  return props.api.updateConfiguration(
    kind,
    baseline.id,
    { name, definition, expectedRevision: baseline.revision } as never,
    new AbortController().signal
  );
}

// Render a controlled shadcn/ui Select for React Hook Form.
function ControlledSelect({
  value,
  onChange,
  options,
  label,
  triggerRef
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly string[];
  readonly label: string;
  /** React Hook Form ref used to focus a rejected Select field. */
  readonly triggerRef?: Ref<HTMLButtonElement>;
}): ReactElement {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger ref={triggerRef} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Render the explicit local Draft versus refetched server Snapshot decision.
function ConfigurationConflictNotice<Definition>({
  conflict,
  onRetry,
  onAccept,
  disabled
}: {
  readonly conflict: ConfigurationEditorConflict<Definition>;
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
          {formatMessage("conflict.serverVersion", {
            description: conflict.serverSnapshot.name
          })}
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

// Endpoint editor with dynamic Header rows and probe-before-save semantics.
function EndpointEditor(props: ConfigurationEditorProps): ReactElement {
  const current = matchingResource("ENDPOINT", props.resource);
  const [baseline, setBaseline] = useState<ConfigurationRevisionBaseline | null>(() =>
    current === null ? null : { id: current.id, revision: current.revision }
  );
  const form = useForm<EndpointFormValues>({
    defaultValues:
      current === null
        ? DEFAULT_ENDPOINT_FORM
        : endpointDefinitionToForm(current.name, current.definition)
  });
  const headers = useFieldArray({ control: form.control, name: "headers" });
  const [status, setStatus] = useState<"IDLE" | "VALID" | "PROBE_ERROR" | "SAVE_ERROR">("IDLE");
  const [busy, setBusy] = useState<"IDLE" | "VALIDATE" | "SAVE">("IDLE");
  const busyRef = useRef(false);
  const [conflict, setConflict] = useState<ConfigurationEditorConflict<EndpointDefinition> | null>(
    null
  );
  const [deferredFocus, setDeferredFocus] = useState<FieldPath<EndpointFormValues> | null>(null);
  usePageLeaveBlocker(busy !== "IDLE" || conflict !== null, props.onLeaveBlockedChange);

  useLayoutEffect(() => {
    if (busy !== "IDLE" || deferredFocus === null) return;
    form.setFocus(deferredFocus);
    setDeferredFocus(null);
  }, [busy, deferredFocus, form]);

  // Focus now for local errors or defer until an in-flight request unlocks the form.
  const focusField = (field: FieldPath<EndpointFormValues>): void => {
    if (busyRef.current) {
      setDeferredFocus(field);
      return;
    }
    form.setFocus(field);
  };

  // Parse current values once and locate the first invalid field.
  const definition = (): EndpointDefinition | null => {
    const result = endpointFormToDefinition(form.getValues());
    if (!result.ok) {
      form.setError(result.field as never, {
        type: "contract",
        message: message("config.formInvalid")
      });
      focusField(result.field as FieldPath<EndpointFormValues>);
      return null;
    }
    form.clearErrors();
    return result.definition;
  };

  // Probe availability without mutating the saved resource.
  const validate = async (): Promise<void> => {
    if (busyRef.current) return;
    const parsed = definition();
    if (parsed === null) return;
    busyRef.current = true;
    setBusy("VALIDATE");
    props.onBusyChange?.(true);
    try {
      await props.api.validateEndpoint(parsed, new AbortController().signal);
      setStatus("VALID");
    } catch (error) {
      if (
        applyServerFormError(
          form,
          error,
          (path) => endpointApiPathToFormField(path, form.getValues("headers")),
          focusField
        )
      ) {
        setStatus("IDLE");
        return;
      }
      setStatus("PROBE_ERROR");
    } finally {
      busyRef.current = false;
      setBusy("IDLE");
      props.onBusyChange?.(false);
    }
  };

  // Explicitly persist current Endpoint values.
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
      const saved = await saveDefinition(
        props,
        saveBaseline,
        "ENDPOINT",
        form.getValues("name"),
        parsed
      );
      await props.onSaved(saved);
      setConflict(null);
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        error.code === "RESOURCE_REVISION_CONFLICT" &&
        current !== null
      ) {
        try {
          const latest = await props.api.getConfiguration(
            "ENDPOINT",
            saveBaseline?.id ?? current.id,
            new AbortController().signal
          );
          if (latest.kind === "ENDPOINT") {
            props.onSnapshot?.(latest);
            setConflict(
              createConfigurationConflict({
                draft: { name: form.getValues("name"), definition: parsed },
                serverSnapshot: latest
              })
            );
            setStatus("IDLE");
            return;
          }
        } catch {
          setStatus("SAVE_ERROR");
          return;
        }
      }
      if (
        applyServerFormError(
          form,
          error,
          (path) => endpointApiPathToFormField(path, form.getValues("headers")),
          focusField
        )
      ) {
        setStatus("IDLE");
        return;
      }
      setStatus("SAVE_ERROR");
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
            rules={{ required: message("common.required") }}
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
            name="urlTemplate"
            rules={{ required: message("common.required") }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>{message("endpoint.urlTemplate")}</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="field-grid">
            <FormItem>
              <FormLabel>{message("endpoint.method")}</FormLabel>
              <Input value="POST" readOnly />
            </FormItem>
            <fieldset className="form-grid">
              <legend>Agent 部署版本（可选）</legend>
              <p>填写此 Endpoint 实际部署的分支和 Commit；仅对后续 Run 生效，不回填历史。</p>
              <FormField
                control={form.control}
                name="agentBranch"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Agent 分支</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ""} placeholder="实际部署分支" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="agentCommit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Agent Commit</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        placeholder="7–40 位 Commit SHA"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </fieldset>
            <FormField
              control={form.control}
              name="bodySelector"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{message("endpoint.bodySelector")}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {(
              [
                ["timeoutMs", "endpoint.timeout"],
                ["defaultConcurrency", "endpoint.concurrency"]
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
                      <Input
                        type="number"
                        {...field}
                        onChange={(event) => field.onChange(event.currentTarget.valueAsNumber)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </div>
          <section className="nested-editor">
            <div className="section-heading compact">
              <h3>{message("endpoint.headers")}</h3>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  headers.append({ name: "", kind: "ENV_SECRET", value: "", envKey: "" })
                }
              >
                <Plus aria-hidden="true" />
                {message("endpoint.addHeader")}
              </Button>
            </div>
            {headers.fields.map((header, index) => {
              const kind = form.watch(`headers.${index}.kind`);
              return (
                <div className="header-row" key={header.id}>
                  <FormField
                    control={form.control}
                    name={`headers.${index}.name`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{message("endpoint.headerName")}</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`headers.${index}.kind`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{message("endpoint.headerKind")}</FormLabel>
                        <ControlledSelect
                          value={field.value}
                          onChange={field.onChange}
                          options={["ENV_SECRET", "LITERAL"]}
                          label={message("endpoint.headerKind")}
                          triggerRef={field.ref}
                        />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={kind === "LITERAL" ? `headers.${index}.value` : `headers.${index}.envKey`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {kind === "LITERAL"
                            ? message("endpoint.literalValue")
                            : message("endpoint.envKey")}
                        </FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={formatMessage("endpoint.removeHeader", { index: index + 1 })}
                    onClick={() => headers.remove(index)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              );
            })}
          </section>
          {status === "VALID" ? (
            <Alert>
              <AlertTitle>{message("config.validateSuccess")}</AlertTitle>
            </Alert>
          ) : null}
          {status === "PROBE_ERROR" ? (
            <Alert variant="destructive">
              <AlertTitle>{message("config.validateError")}</AlertTitle>
            </Alert>
          ) : null}
          {status === "SAVE_ERROR" ? (
            <Alert variant="destructive">
              <AlertTitle>{message("config.saveError")}</AlertTitle>
            </Alert>
          ) : null}
        </fieldset>
        {conflict === null ? null : (
          <ConfigurationConflictNotice
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
              form.reset(endpointDefinitionToForm(snapshot.name, snapshot.definition));
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
            onClick={() => void validate()}
          >
            {busy === "VALIDATE" ? message("config.validating") : message("config.validate")}
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

// LLM editor for both provider branches and shared reasoning parameters.
function LlmEditor(props: ConfigurationEditorProps): ReactElement {
  const current = matchingResource("LLM", props.resource);
  const [baseline, setBaseline] = useState<ConfigurationRevisionBaseline | null>(() =>
    current === null ? null : { id: current.id, revision: current.revision }
  );
  const form = useForm<LlmFormValues>({
    defaultValues:
      current === null ? DEFAULT_LLM_FORM : llmDefinitionToForm(current.name, current.definition)
  });
  const providerType = form.watch("providerType");
  const authKind = form.watch("authKind");
  const [status, setStatus] = useState<"IDLE" | "VALID" | "ERROR">("IDLE");
  const [busy, setBusy] = useState<"IDLE" | "VALIDATE" | "SAVE">("IDLE");
  const busyRef = useRef(false);
  const [conflict, setConflict] = useState<ConfigurationEditorConflict<LlmDefinition> | null>(null);
  const [deferredFocus, setDeferredFocus] = useState<FieldPath<LlmFormValues> | null>(null);
  usePageLeaveBlocker(busy !== "IDLE" || conflict !== null, props.onLeaveBlockedChange);

  useLayoutEffect(() => {
    if (busy !== "IDLE" || deferredFocus === null) return;
    form.setFocus(deferredFocus);
    setDeferredFocus(null);
  }, [busy, deferredFocus, form]);

  // Focus now for local errors or defer until an in-flight request unlocks the form.
  const focusField = (field: FieldPath<LlmFormValues>): void => {
    if (busyRef.current) {
      setDeferredFocus(field);
      return;
    }
    form.setFocus(field);
  };

  // Validate and optionally save the current LLM form.
  const perform = async (
    mode: "VALIDATE" | "SAVE",
    saveBaseline: ConfigurationRevisionBaseline | null = baseline
  ): Promise<void> => {
    if (busyRef.current) return;
    const mapped = llmFormToDefinition(form.getValues());
    if (!mapped.ok) {
      form.setError(mapped.field as never, {
        type: "contract",
        message: message("config.formInvalid")
      });
      focusField(mapped.field as FieldPath<LlmFormValues>);
      return;
    }
    form.clearErrors();
    busyRef.current = true;
    setBusy(mode);
    props.onBusyChange?.(true);
    try {
      if (mode === "VALIDATE") {
        await props.api.validateLlm(mapped.definition, new AbortController().signal);
        setStatus("VALID");
      } else {
        const saved = await saveDefinition(
          props,
          saveBaseline,
          "LLM",
          form.getValues("name"),
          mapped.definition
        );
        await props.onSaved(saved);
        setConflict(null);
      }
    } catch (error) {
      if (
        mode === "SAVE" &&
        error instanceof ApiClientError &&
        error.code === "RESOURCE_REVISION_CONFLICT" &&
        current !== null
      ) {
        try {
          const latest = await props.api.getConfiguration(
            "LLM",
            saveBaseline?.id ?? current.id,
            new AbortController().signal
          );
          if (latest.kind === "LLM") {
            props.onSnapshot?.(latest);
            setConflict(
              createConfigurationConflict({
                draft: { name: form.getValues("name"), definition: mapped.definition },
                serverSnapshot: latest
              })
            );
            return;
          }
        } catch {
          setStatus("ERROR");
          return;
        }
      }
      if (applyServerFormError(form, error, llmApiPathToFormField, focusField)) {
        setStatus("IDLE");
        return;
      }
      setStatus("ERROR");
    } finally {
      busyRef.current = false;
      setBusy("IDLE");
      props.onBusyChange?.(false);
    }
  };

  const selects = [
    ["thinkingLevel", "llm.thinkingLevel", ["OFF", "LOW", "MEDIUM", "HIGH"]],
    ["structuredOutput", "llm.structuredOutput", ["JSON_SCHEMA", "JSON_OBJECT"]]
  ] as const;
  return (
    <Form {...form}>
      <form className="form-stack" onSubmit={(event) => event.preventDefault()}>
        <fieldset className="editor-fieldset" disabled={busy !== "IDLE" || conflict !== null}>
          <Alert>
            <AlertDescription>{message("llm.roleDescription")}</AlertDescription>
          </Alert>
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
            name="providerType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{message("llm.providerType")}</FormLabel>
                <ControlledSelect
                  value={field.value}
                  onChange={field.onChange}
                  options={["GOOGLE_GEMINI", "OPENAI_COMPATIBLE"]}
                  label={message("llm.providerType")}
                  triggerRef={field.ref}
                />
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="model"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{message("llm.model")}</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="field-grid">
            {selects.map(([name, label, options]) => (
              <FormField
                key={name}
                control={form.control}
                name={name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{message(label)}</FormLabel>
                    <ControlledSelect
                      value={field.value}
                      onChange={field.onChange}
                      options={options}
                      label={message(label)}
                      triggerRef={field.ref}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
            {(
              [
                ["temperature", "llm.temperature"],
                ["topP", "llm.topP"],
                ["maxOutputTokens", "llm.maxOutputTokens"],
                ["timeoutMs", "llm.timeout"]
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
                      <Input
                        type="number"
                        step="any"
                        {...field}
                        onChange={(event) => field.onChange(event.currentTarget.valueAsNumber)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </div>
          {providerType === "GOOGLE_GEMINI" ? (
            <FormField
              control={form.control}
              name="geminiApiKeyEnv"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{message("llm.geminiEnv")}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : (
            <>
              <FormField
                control={form.control}
                name="baseUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{message("llm.baseUrl")}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="authKind"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{message("llm.authKind")}</FormLabel>
                    <ControlledSelect
                      value={field.value}
                      onChange={field.onChange}
                      options={["NONE", "BEARER_ENV"]}
                      label={message("llm.authKind")}
                      triggerRef={field.ref}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              {authKind === "BEARER_ENV" ? (
                <FormField
                  control={form.control}
                  name="bearerEnvKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{message("llm.bearerEnv")}</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}
            </>
          )}
          {status === "VALID" ? (
            <Alert>
              <AlertTitle>{message("config.validateSuccess")}</AlertTitle>
            </Alert>
          ) : null}
          {status === "ERROR" ? (
            <Alert variant="destructive">
              <AlertTitle>{message("config.validateError")}</AlertTitle>
            </Alert>
          ) : null}
        </fieldset>
        {conflict === null ? null : (
          <ConfigurationConflictNotice
            conflict={conflict}
            disabled={busy !== "IDLE"}
            onRetry={() => {
              if (busyRef.current || baseline === null) return;
              const retryBaseline = {
                id: baseline.id,
                revision: conflict.serverSnapshot.revision
              };
              setBaseline(retryBaseline);
              void perform("SAVE", retryBaseline);
            }}
            onAccept={() => {
              if (busyRef.current) return;
              const snapshot = acceptConfigurationSnapshot(conflict);
              form.reset(llmDefinitionToForm(snapshot.name, snapshot.definition));
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
            onClick={() => void perform("VALIDATE")}
          >
            {busy === "VALIDATE" ? message("config.validating") : message("config.validate")}
          </Button>
          <Button
            type="button"
            disabled={busy !== "IDLE" || conflict !== null}
            onClick={() => void perform("SAVE")}
          >
            {busy === "SAVE" ? message("config.saving") : message("config.save")}
          </Button>
        </div>
      </form>
    </Form>
  );
}

/** Strongly dispatch one Configuration family to its structured editor. */
export function ConfigurationEditor(props: ConfigurationEditorProps): ReactElement {
  if (props.kind === "ENDPOINT") return <EndpointEditor {...props} />;
  if (props.kind === "LLM") return <LlmEditor {...props} />;
  return <PromptConfigurationEditor {...props} />;
}
