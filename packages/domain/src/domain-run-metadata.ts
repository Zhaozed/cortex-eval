/** Human labels are non-semantic metadata, separate from frozen execution inputs. */
export function validateRunMetadata(value: {
  readonly name?: unknown;
  readonly description?: unknown;
}):
  | {
      readonly ok: true;
      readonly name: string | undefined;
      readonly description: string | null | undefined;
    }
  | { readonly ok: false; readonly path: "name" | "description" } {
  if (
    value.name !== undefined &&
    (typeof value.name !== "string" ||
      value.name.trim().length < 1 ||
      value.name.trim().length > 120)
  )
    return { ok: false, path: "name" };
  if (
    value.description !== undefined &&
    (typeof value.description !== "string" || value.description.trim().length > 2000)
  )
    return { ok: false, path: "description" };
  return {
    ok: true,
    name: typeof value.name === "string" ? value.name.trim() : undefined,
    description:
      typeof value.description === "string" ? value.description.trim() || null : undefined
  };
}
