import { expect, it } from "vitest";
import { validateRunMetadata } from "../src/domain-run-metadata.ts";

it("normalizes labels and distinguishes omitted description from explicit clearing", () => {
  expect(validateRunMetadata({})).toEqual({ ok: true, name: undefined, description: undefined });
  expect(validateRunMetadata({ name: " 回归 ", description: " 描述 " })).toEqual({
    ok: true,
    name: "回归",
    description: "描述"
  });
  expect(validateRunMetadata({ description: "   " })).toMatchObject({
    ok: true,
    description: null
  });
  for (const name of ["", " ", "a".repeat(121), null, 123])
    expect(validateRunMetadata({ name })).toEqual({ ok: false, path: "name" });
  for (const description of ["a".repeat(2001), null, 123])
    expect(validateRunMetadata({ description })).toEqual({ ok: false, path: "description" });
});
