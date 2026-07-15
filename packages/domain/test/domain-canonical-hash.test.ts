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

  it("接受完整 Unicode 代理对与 null prototype 对象，拒绝类实例和断裂代理对", () => {
    const nullPrototype = Object.create(null) as Record<string, string>;
    nullPrototype.emoji = "😀";
    expect(canonicalJson(nullPrototype as never)).toBe('{"emoji":"😀"}');
    expect(canonicalJson(["😀", null, true])).toBe('["😀",null,true]');
    expect(() => canonicalJson("\ud800x")).toThrow("CANONICAL_JSON_INVALID");
    expect(() => canonicalJson(new Date("2026-07-15T00:00:00.000Z") as never)).toThrow(
      "CANONICAL_JSON_INVALID"
    );
  });
});
