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

/** Project the same Zod source to the OpenAPI 3.0 Schema dialect. */
export function projectOpenApiSchema(schema: z.ZodType): Record<string, unknown> {
  return withoutDialect(
    z.toJSONSchema(schema, { target: "openapi-3.0", unrepresentable: "throw" })
  );
}
