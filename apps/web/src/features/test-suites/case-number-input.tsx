import { useEffect, useState, type ReactElement } from "react";

import { Input } from "../../components/ui/input.tsx";

/** Keep incomplete numeric edits visible; native validity blocks saving stale previous values. */
export function CaseNumberInput({
  value,
  onChange,
  label,
  min,
  step = "any",
  id,
  onUnsafeInteger
}: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly label: string;
  readonly min?: number;
  readonly step?: number | "any";
  readonly id?: string;
  readonly onUnsafeInteger?: (text: string) => void;
}): ReactElement {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <Input
      id={id}
      aria-label={label}
      type="number"
      required
      min={min}
      step={step}
      value={text}
      onChange={(e) => {
        const raw = e.currentTarget.value;
        setText(raw);
        if (/^-?\d+$/.test(raw) && !Number.isSafeInteger(Number(raw)) && onUnsafeInteger)
          onUnsafeInteger(raw);
        else if (Number.isFinite(e.currentTarget.valueAsNumber))
          onChange(e.currentTarget.valueAsNumber);
      }}
    />
  );
}
