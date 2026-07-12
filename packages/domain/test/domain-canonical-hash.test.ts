import { describe, expect, it } from "vitest";

import { canonicalJson, sha256CanonicalJson } from "../src/domain-canonical-hash.ts";

describe("RFC 8785 Canonical Hash", () => {
  it("对象键顺序不影响 Canonical JSON 与 SHA-256", () => {
    const left = { z: 1, a: { y: true, x: "值" } };
    const right = { a: { x: "值", y: true }, z: 1 };
    expect(canonicalJson(left)).toBe('{"a":{"x":"值","y":true},"z":1}');
    expect(sha256CanonicalJson(left)).toBe(sha256CanonicalJson(right));
    expect(sha256CanonicalJson(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("拒绝非 I-JSON 数值和 undefined", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("CANONICAL_JSON_INVALID");
    expect(() => canonicalJson({ value: undefined } as never)).toThrow("CANONICAL_JSON_INVALID");
    expect(() => canonicalJson("\ud800")).toThrow("CANONICAL_JSON_INVALID");
    expect(() => canonicalJson({ ["\udfff"]: "value" })).toThrow("CANONICAL_JSON_INVALID");
  });
});
