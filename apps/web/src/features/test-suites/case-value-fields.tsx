import type { JsonValue } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import { useId, useState, type ReactElement } from "react";

import { CaseNumberInput } from "./case-number-input.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";

const DEFAULTS: Readonly<Record<string, JsonValue>> = {
  string: "",
  number: 0,
  boolean: false,
  object: {},
  array: [],
  int64: { __cortex_eval_int64: "0" },
  null: null
};
const TYPES: Readonly<Record<string, string>> = {
  string: "文本",
  number: "数字",
  boolean: "布尔值",
  object: "对象 / 字段组",
  array: "列表",
  int64: "长整数 / ID",
  null: "空值"
};

function isInt64(value: JsonValue): value is { __cortex_eval_int64: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof value.__cortex_eval_int64 === "string"
  );
}

/** Preserve JSON primitive types without asking the author to serialize JSON. */
export function caseValueType(value: JsonValue): string {
  return value === null
    ? "null"
    : isInt64(value)
      ? "int64"
      : Array.isArray(value)
        ? "array"
        : typeof value;
}

/** Recursive typed field editor. Duplicate object keys cannot silently overwrite data. */
export function CaseValueFields({
  value,
  onChange,
  label,
  fixedObject = false,
  suggestions = []
}: {
  readonly value: JsonValue;
  readonly onChange: (value: JsonValue) => void;
  readonly label: string;
  readonly fixedObject?: boolean;
  readonly suggestions?: readonly string[];
}): ReactElement {
  const id = useId();
  const [newKey, setNewKey] = useState("");
  const type = caseValueType(value);
  const key = newKey.trim();
  const duplicate = value !== null && typeof value === "object" && Object.hasOwn(value, key);
  return (
    <div className="case-value-fields">
      {!fixedObject ? (
        <div className="case-value-heading">
          <label htmlFor={id}>{label}</label>
          <select
            aria-label={`${label}类型`}
            value={type}
            onChange={(e) => onChange(structuredClone(DEFAULTS[e.currentTarget.value] ?? null))}
          >
            {Object.entries(TYPES).map(([name, text]) => (
              <option key={name} value={name}>
                {text}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {typeof value === "string" ? (
        <Textarea
          id={id}
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          rows={
            /(?:^|\.)(text|content|description)$/.test(label)
              ? 3
              : Math.min(6, value.split("\n").length)
          }
        />
      ) : null}
      {typeof value === "number" ? (
        <CaseNumberInput
          id={id}
          label={label}
          value={value}
          onChange={onChange}
          onUnsafeInteger={(raw) => onChange({ __cortex_eval_int64: raw })}
        />
      ) : null}
      {typeof value === "boolean" ? (
        <select
          id={id}
          aria-label={label}
          value={String(value)}
          onChange={(e) => onChange(e.currentTarget.value === "true")}
        >
          <option value="true">是 / true</option>
          <option value="false">否 / false</option>
        </select>
      ) : null}
      {isInt64(value) ? (
        <Input
          id={id}
          aria-label={label}
          inputMode="numeric"
          pattern="-?(0|[1-9][0-9]*)"
          required
          value={value.__cortex_eval_int64}
          onChange={(e) => onChange({ __cortex_eval_int64: e.currentTarget.value })}
        />
      ) : null}
      {value === null ? <span className="field-hint">空值，不是空字符串</span> : null}
      {Array.isArray(value) ? (
        <div className="case-nested-fields">
          {value.map((item, index) => (
            <div key={index} className="case-value-row">
              <CaseValueFields
                label={`${label}[${index}]`}
                value={item}
                onChange={(next) =>
                  onChange(value.map((old, position) => (position === index ? next : old)))
                }
              />
              <Button
                type="button"
                variant="outline"
                aria-label={`删除${label}[${index}]`}
                onClick={() => onChange(value.filter((_, position) => position !== index))}
              >
                删除
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" onClick={() => onChange([...value, ""])}>
            添加列表项
          </Button>
        </div>
      ) : null}
      {value !== null && typeof value === "object" && !Array.isArray(value) && !isInt64(value) ? (
        <div className="case-nested-fields">
          {Object.entries(value).map(([name, item]) => (
            <div key={name} className="case-value-row">
              <CaseValueFields
                label={fixedObject ? name : `${label}.${name}`}
                value={item}
                onChange={(next) => onChange({ ...value, [name]: next })}
              />
              <Button
                type="button"
                variant="outline"
                aria-label={`删除字段 ${name}`}
                onClick={() =>
                  onChange(
                    Object.fromEntries(Object.entries(value).filter(([field]) => field !== name))
                  )
                }
              >
                删除
              </Button>
            </div>
          ))}
          <div className="case-inline-add">
            <Input
              aria-label={`${label}新字段名`}
              placeholder="选择或输入字段名"
              list={`${id}-keys`}
              value={newKey}
              onChange={(e) => setNewKey(e.currentTarget.value)}
            />
            <datalist id={`${id}-keys`}>
              {suggestions
                .filter((name) => !Object.hasOwn(value, name))
                .map((name) => (
                  <option key={name} value={name} />
                ))}
            </datalist>
            <Button
              type="button"
              variant="outline"
              disabled={!key || duplicate}
              onClick={() => {
                onChange({ ...value, [key]: "" });
                setNewKey("");
              }}
            >
              添加字段
            </Button>
          </div>
          {duplicate ? <p className="form-error">字段已存在，请修改已有字段。</p> : null}
        </div>
      ) : null}
    </div>
  );
}
