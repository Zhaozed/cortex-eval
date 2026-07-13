import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useForm, type FieldPath, type UseFormReturn } from "react-hook-form";

import { ApiClientError } from "../../lib/api-client.ts";
import {
  invalidateTestSuiteMutation,
  synchronizeTestSuiteSnapshot,
  type ResourceApi
} from "../../lib/resource-api.ts";
import { formatMessage } from "../../messages/messages.ts";
import type { TestSuiteMetadataForm } from "./test-suite-metadata-sheet.tsx";
import type { SuiteEditorConflict } from "./test-suite-notices.tsx";

/** Current server facts required by the metadata editor. */
export interface TestSuiteMetadataSnapshot {
  /** Stable Test Suite identity. */
  readonly id: string;
  /** Current display name. */
  readonly name: string;
  /** Current description. */
  readonly description: string;
  /** Current optimistic-concurrency token. */
  readonly revision: number;
}

/** Metadata editor orchestration dependencies. */
export interface UseTestSuiteMetadataEditorInput {
  /** Boundary-validating resource API. */
  readonly api: ResourceApi;
  /** Current route Test Suite identity. */
  readonly suiteId: string;
  /** Latest Query-owned server facts, or null while loading. */
  readonly suite: TestSuiteMetadataSnapshot | null;
  /** Notify the page after persistence and cache invalidation succeed. */
  readonly onSaved: () => void;
}

/** Controlled state and actions consumed by the metadata Sheet. */
export interface TestSuiteMetadataEditor {
  /** Whether the editor Sheet is visible. */
  readonly open: boolean;
  /** Typed React Hook Form instance. */
  readonly form: UseFormReturn<TestSuiteMetadataForm>;
  /** Explicit Draft and latest server Snapshot after a Revision conflict. */
  readonly conflict: SuiteEditorConflict | null;
  /** Whether a conditional write or conflict refresh is in flight. */
  readonly pending: boolean;
  /** Whether the last operation failed outside a locatable field. */
  readonly error: boolean;
  /** Open the editor from current server facts. */
  readonly openEditor: () => void;
  /** Apply a visibility change unless a write is in flight. */
  readonly onOpenChange: (open: boolean) => void;
  /** Persist a validated metadata Draft. */
  readonly save: (values: TestSuiteMetadataForm) => Promise<void>;
  /** Retry the retained Draft against the latest server Revision. */
  readonly retry: () => void;
  /** Replace the retained Draft with the latest server Snapshot. */
  readonly accept: () => void;
}

// Focus a boundary-validated Test Suite metadata field without leaking raw errors.
function applyMetadataFieldError(
  form: UseFormReturn<TestSuiteMetadataForm>,
  error: unknown,
  focus: (field: FieldPath<TestSuiteMetadataForm>) => void
): boolean {
  if (!(error instanceof ApiClientError)) return false;
  if (error.fieldPath !== "name" && error.fieldPath !== "description") return false;
  form.setError(error.fieldPath, {
    type: "server",
    message: formatMessage("config.serverFieldInvalid", { path: error.fieldPath })
  });
  focus(error.fieldPath);
  return true;
}

/** Own the metadata editor's single-flight, error and Revision-conflict lifecycle. */
export function useTestSuiteMetadataEditor({
  api,
  suiteId,
  suite,
  onSaved
}: UseTestSuiteMetadataEditorInput): TestSuiteMetadataEditor {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [conflict, setConflict] = useState<SuiteEditorConflict | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [sessionRevision, setSessionRevision] = useState<number | null>(null);
  const [deferredFocus, setDeferredFocus] = useState<FieldPath<TestSuiteMetadataForm> | null>(null);
  const pendingRef = useRef(false);
  const form = useForm<TestSuiteMetadataForm>({
    defaultValues: { name: "", description: "" }
  });

  useEffect(() => {
    if (suite !== null && !open) {
      form.reset({ name: suite.name, description: suite.description });
    }
  }, [form, open, suite]);

  useLayoutEffect(() => {
    if (pending || deferredFocus === null) return;
    form.setFocus(deferredFocus);
    setDeferredFocus(null);
  }, [deferredFocus, form, pending]);

  // Focus now for local errors or defer until an in-flight write unlocks the form.
  const focusField = (field: FieldPath<TestSuiteMetadataForm>): void => {
    if (pendingRef.current) {
      setDeferredFocus(field);
      return;
    }
    form.setFocus(field);
  };

  // Persist one Draft with either its frozen Session or an explicit conflict Snapshot Revision.
  const persist = async (
    values: TestSuiteMetadataForm,
    expectedRevision: number
  ): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(false);
    form.clearErrors();
    try {
      const updated = await api.updateTestSuite(
        suiteId,
        { ...values, expectedRevision },
        new AbortController().signal
      );
      await invalidateTestSuiteMutation(queryClient, updated.id);
      setConflict(null);
      setSessionRevision(null);
      setOpen(false);
      onSaved();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === "RESOURCE_REVISION_CONFLICT") {
        try {
          const latest = await api.getTestSuite(suiteId, new AbortController().signal);
          synchronizeTestSuiteSnapshot(queryClient, latest);
          setConflict({
            draft: values,
            serverSnapshot: {
              name: latest.name,
              description: latest.description,
              revision: latest.revision
            }
          });
          return;
        } catch {
          setError(true);
          return;
        }
      }
      if (applyMetadataFieldError(form, caught, focusField)) return;
      setError(true);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return {
    open,
    form,
    conflict,
    pending,
    error,
    openEditor: (): void => {
      if (suite === null) return;
      form.reset({ name: suite.name, description: suite.description });
      setConflict(null);
      setError(false);
      setSessionRevision(suite.revision);
      setOpen(true);
    },
    onOpenChange: (nextOpen: boolean): void => {
      if (!nextOpen && (pendingRef.current || conflict !== null)) return;
      setOpen(nextOpen);
      if (!nextOpen) {
        setConflict(null);
        setError(false);
        setSessionRevision(null);
      }
    },
    save: async (values: TestSuiteMetadataForm): Promise<void> => {
      if (sessionRevision === null || conflict !== null) return;
      await persist(values, sessionRevision);
    },
    retry: (): void => {
      if (conflict === null) return;
      void persist(conflict.draft, conflict.serverSnapshot.revision);
    },
    accept: (): void => {
      if (conflict === null || pendingRef.current) return;
      form.reset({
        name: conflict.serverSnapshot.name,
        description: conflict.serverSnapshot.description
      });
      setSessionRevision(conflict.serverSnapshot.revision);
      setConflict(null);
      setError(false);
    }
  };
}
