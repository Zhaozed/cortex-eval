import type { QueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { ApiClientError } from "../../lib/api-client.ts";
import {
  invalidateCaseDeletion,
  invalidateCaseMutation,
  invalidateCaseReplacement,
  resourceKeys,
  synchronizeCaseSnapshot,
  synchronizeTestSuiteSnapshot,
  type ResourceApi
} from "../../lib/resource-api.ts";
import type {
  CaseMutationConflict,
  CaseMutationConflictKind
} from "./case-mutation-conflict-notice.tsx";

/** Outcome returned to the owning Dialog or editor. */
export type CaseMutationOutcome =
  | { readonly ok: true }
  | {
      /** Failed mutation discriminator. */
      readonly ok: false;
      /** Sanitized boundary or local refresh error. */
      readonly error: ApiClientError;
      /** Whether an explicit retry-or-discard decision is now visible. */
      readonly revisionConflict: boolean;
      /** Whether execution was skipped because another mutation is in flight. */
      readonly skipped: boolean;
    };

/** Revisions consumed by one conditional Case mutation. */
export interface CaseMutationRevisionFacts {
  /** Current aggregate Test Suite Revision. */
  readonly suiteRevision: number;
  /** Current Case Revision for conditional delete, otherwise null. */
  readonly caseRevision: number | null;
}

/** Local operation facts retained across a Revision conflict. */
export interface CaseMutationRecovery {
  /** Operation owning the retained local input. */
  readonly kind: CaseMutationConflictKind;
  /** Stable local operation description shown in the conflict notice. */
  readonly draftLabel: string;
  /** Case to refetch for a dual-Revision retry, otherwise null. */
  readonly caseKey: string | null;
  /** Close or discard the retained operation. */
  readonly close: () => void;
  /** Return an explicit retry's terminal failure to the still-open owner. */
  readonly onRetryFailure: (error: ApiClientError, latestFacts: CaseMutationRevisionFacts) => void;
}

/** Case mutation recovery hook inputs. */
export interface UseCaseMutationRecoveryInput {
  /** Boundary-validating resource API. */
  readonly api: ResourceApi;
  /** Shared TanStack Query cache. */
  readonly queryClient: QueryClient;
  /** Current Test Suite identity. */
  readonly suiteId: string;
  /** Update the page-level fallback error state. */
  readonly onFailureChange: (failed: boolean) => void;
  /** Notify the page after a successful mutation. */
  readonly onSuccess: () => void;
}

/** Case mutation recovery hook result. */
export interface CaseMutationRecoveryController {
  /** Current explicit Draft-versus-Snapshot decision. */
  readonly conflict: CaseMutationConflict | null;
  /** Whether one non-edit Case mutation or recovery retry is in flight. */
  readonly pending: boolean;
  /** Clear a decision when its owning Dialog is dismissed. */
  readonly clearConflict: () => void;
  /** Execute one conditional mutation with repeatable conflict recovery. */
  readonly finish: (
    caseKey: string,
    mutation: (facts: CaseMutationRevisionFacts) => Promise<unknown>,
    recovery: CaseMutationRecovery,
    facts: CaseMutationRevisionFacts
  ) => Promise<CaseMutationOutcome>;
}

// Prevent transport details and arbitrary thrown values from escaping the hook boundary.
function sanitizedRecoveryError(error: unknown): ApiClientError {
  return error instanceof ApiClientError ? error : new ApiClientError("CLIENT_REQUEST_FAILED");
}

/** Retain non-edit Case operations and refetch exact Revision facts after 409. */
export function useCaseMutationRecovery({
  api,
  queryClient,
  suiteId,
  onFailureChange,
  onSuccess
}: UseCaseMutationRecoveryInput): CaseMutationRecoveryController {
  const [conflict, setConflict] = useState<CaseMutationConflict | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  // Execute one mutation and recursively reuse refetched facts after another conflict.
  const finish = async (
    caseKey: string,
    mutation: (facts: CaseMutationRevisionFacts) => Promise<unknown>,
    recovery: CaseMutationRecovery,
    facts: CaseMutationRevisionFacts
  ): Promise<CaseMutationOutcome> => {
    if (pendingRef.current) {
      return {
        ok: false,
        error: new ApiClientError("CLIENT_MUTATION_PENDING"),
        revisionConflict: false,
        skipped: true
      };
    }
    pendingRef.current = true;
    setPending(true);
    try {
      await mutation(facts);
      if (recovery.kind === "DELETE") {
        await invalidateCaseDeletion(queryClient, suiteId, caseKey);
      } else if (recovery.kind === "IMPORT") {
        await invalidateCaseReplacement(queryClient, suiteId);
      } else {
        await invalidateCaseMutation(queryClient, suiteId, caseKey);
      }
      onFailureChange(false);
      setConflict(null);
      recovery.close();
      onSuccess();
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "RESOURCE_REVISION_CONFLICT") {
        try {
          const latestSuite = await api.getTestSuite(suiteId, new AbortController().signal);
          synchronizeTestSuiteSnapshot(queryClient, latestSuite);
          let latestCase: Awaited<ReturnType<ResourceApi["getCase"]>> | null = null;
          if (recovery.caseKey !== null) {
            try {
              latestCase = await api.getCase(
                suiteId,
                recovery.caseKey,
                new AbortController().signal
              );
            } catch (refreshError) {
              const remoteCaseDeleted =
                recovery.kind === "DELETE" &&
                refreshError instanceof ApiClientError &&
                refreshError.code === "CASE_NOT_FOUND";
              if (!remoteCaseDeleted) throw refreshError;

              await invalidateCaseDeletion(queryClient, suiteId, recovery.caseKey);
              setConflict({
                recoveryState: "REMOTE_CASE_DELETED",
                kind: "DELETE",
                draftLabel: recovery.draftLabel,
                serverSuiteRevision: latestSuite.revision,
                onAccept: () => {
                  recovery.close();
                  setConflict(null);
                  onFailureChange(false);
                }
              });
              onFailureChange(false);
              return { ok: false, error, revisionConflict: true, skipped: false };
            }
          }
          if (latestCase !== null) {
            synchronizeCaseSnapshot(queryClient, latestCase);
          } else {
            await queryClient.invalidateQueries({ queryKey: resourceKeys.caseLists(suiteId) });
          }
          const latestFacts: CaseMutationRevisionFacts = {
            suiteRevision: latestSuite.revision,
            caseRevision: latestCase?.revision ?? null
          };
          setConflict({
            recoveryState: "RETRYABLE",
            kind: recovery.kind,
            draftLabel: recovery.draftLabel,
            serverSuiteRevision: latestSuite.revision,
            onRetry: () => {
              void finish(caseKey, mutation, recovery, latestFacts).then((outcome) => {
                if (outcome.ok || outcome.revisionConflict || outcome.skipped) return;
                setConflict(null);
                onFailureChange(false);
                recovery.onRetryFailure(outcome.error, latestFacts);
              });
            },
            onAccept: () => {
              recovery.close();
              setConflict(null);
              onFailureChange(false);
            }
          });
          onFailureChange(false);
          return { ok: false, error, revisionConflict: true, skipped: false };
        } catch (refreshError) {
          onFailureChange(true);
          return {
            ok: false,
            error: sanitizedRecoveryError(refreshError),
            revisionConflict: false,
            skipped: false
          };
        }
      }
      onFailureChange(true);
      return {
        ok: false,
        error: sanitizedRecoveryError(error),
        revisionConflict: false,
        skipped: false
      };
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return {
    conflict,
    pending,
    clearConflict: (): void => {
      if (!pendingRef.current) setConflict(null);
    },
    finish
  };
}
