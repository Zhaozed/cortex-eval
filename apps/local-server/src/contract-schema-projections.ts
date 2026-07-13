import { z } from "zod";

// Remove generator metadata that belongs neither in Fastify route schemas nor components.
function withoutDialect(value: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, ...result } = value;
  void _schema;
  return result;
}

/** Project one Zod source to JSON Schema Draft 7 for Fastify AJV. */
export function projectRuntimeSchema(schema: z.ZodType): Record<string, unknown> {
  return withoutDialect(z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "throw" }));
}

// Remove validation-only object-key constraints unsupported by the response serializer.
export function sanitizeRuntimeSerializerSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeRuntimeSerializerSchema);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => name !== "propertyNames")
      .map(([name, child]) => [name, sanitizeRuntimeSerializerSchema(child)])
  );
}

/** Project one Zod source for Fastify response serialization without unsupported keywords. */
export function projectRuntimeResponseSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitizeRuntimeSerializerSchema(projectRuntimeSchema(schema)) as Record<string, unknown>;
}

/** Project the same Zod source to the OpenAPI 3.0 Schema dialect. */
export function projectOpenApiSchema(schema: z.ZodType): Record<string, unknown> {
  return withoutDialect(
    z.toJSONSchema(schema, { target: "openapi-3.0", unrepresentable: "throw" })
  );
}
