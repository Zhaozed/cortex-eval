import type { FrozenRunCase } from "./run-rest-models.ts";

/** Closed scoring changes accepted from the entrypoint; never includes generation inputs. */
export interface BriefReevaluationOptions {
  readonly evaluatorConfigId?: string | undefined;
  readonly judgePrompt?: string | undefined;
  readonly evaluatorPrompt?: string | null | undefined;
  readonly rubric?:
    | {
        readonly dimensions: readonly {
          readonly id: string;
          readonly assertion: string;
          readonly sourceRefs: readonly string[];
        }[];
        readonly minTotalScore: number;
        readonly hardFailRules: readonly string[];
        readonly failOnZeroDimension?: boolean | undefined;
      }
    | undefined;
}

/** Boundary validates scoring schema and input references, then returns rehashed immutable Cases. */
export type PrepareBriefReevaluation = (
  cases: readonly FrozenRunCase[],
  options: BriefReevaluationOptions
) => readonly FrozenRunCase[] | null;
