/** Load and render user-facing runner messages. */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Configured user-facing message templates. */
export type RunnerMessages = Record<string, string>;

const MESSAGE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "run_promptfoo_rest_messages.json"
);

// Return whether a boundary value is a non-array object.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validate and load the external message map.
export async function loadRunnerMessages(): Promise<RunnerMessages> {
  const value = JSON.parse(await readFile(MESSAGE_PATH, "utf8")) as unknown;
  if (!isRecord(value) || Object.values(value).some((message) => typeof message !== "string")) {
    throw new TypeError("Runner message file must be a string map");
  }
  return value as RunnerMessages;
}

// Render one configured user-facing message.
export function formatRunnerMessage(
  messages: RunnerMessages,
  key: string,
  values: Record<string, unknown> = {}
): string {
  return messages[key].replace(/{(\w+)}/g, (_match, name: string) => String(values[name] ?? ""));
}
