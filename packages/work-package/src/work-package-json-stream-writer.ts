import type { JsonValue } from "@cortex-eval/contracts/src/contracts-primitives.ts";

import type { ImmutableFileWriter } from "./secure-work-package-directory.ts";

// Return the exact compact JSON byte size without allocating the complete encoded value.
export function compactJsonByteLength(value: JsonValue): number {
  if (value === null) return 4;
  if (typeof value !== "object") return Buffer.byteLength(JSON.stringify(value), "utf8");
  if (Array.isArray(value)) {
    let size = 2;
    for (const [index, item] of value.entries()) {
      if (index > 0) size += 1;
      size += compactJsonByteLength(item);
    }
    return size;
  }
  let size = 2;
  let index = 0;
  for (const [key, item] of Object.entries(value)) {
    if (index > 0) size += 1;
    size += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
    size += compactJsonByteLength(item);
    index += 1;
  }
  return size;
}

// Append compact JSON in bounded primitive chunks without a whole-document buffer.
export async function writeCompactJson(
  writer: ImmutableFileWriter,
  value: JsonValue
): Promise<void> {
  if (value === null || typeof value !== "object") {
    await writer.append(Buffer.from(JSON.stringify(value), "utf8"));
    return;
  }
  if (Array.isArray(value)) {
    await writer.append(Buffer.from("[", "utf8"));
    for (const [index, item] of value.entries()) {
      if (index > 0) await writer.append(Buffer.from(",", "utf8"));
      await writeCompactJson(writer, item);
    }
    await writer.append(Buffer.from("]", "utf8"));
    return;
  }
  await writer.append(Buffer.from("{", "utf8"));
  let index = 0;
  for (const [key, item] of Object.entries(value)) {
    if (index > 0) await writer.append(Buffer.from(",", "utf8"));
    await writer.append(Buffer.from(`${JSON.stringify(key)}:`, "utf8"));
    await writeCompactJson(writer, item);
    index += 1;
  }
  await writer.append(Buffer.from("}", "utf8"));
}
