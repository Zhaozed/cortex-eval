import { useEffect, useId, useRef, useState, type ReactElement, type Ref } from "react";

import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";

/** A searchable multi-select with explicit selected chips; values never use CSV encoding. */
export function CaseMultiSelect({
  label,
  options,
  value,
  onChange,
  disabled = false
}: {
  readonly label: string;
  readonly options: readonly string[];
  readonly value: readonly string[];
  readonly onChange: (value: string[]) => void;
  readonly disabled?: boolean;
}): ReactElement {
  const [search, setSearch] = useState("");
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target) &&
        menuRef.current
      )
        menuRef.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return (): void => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  return (
    <div className="case-multi-select">
      <details
        ref={menuRef}
        onKeyDown={(event) => {
          if (event.key === "Escape" && menuRef.current) {
            menuRef.current.open = false;
            menuRef.current.querySelector("summary")?.focus();
          }
        }}
      >
        <summary aria-label={label}>
          {value.length ? `已选 ${value.length} 项` : "全部"}
          <span aria-hidden="true">⌄</span>
        </summary>
        <div className="case-choice-menu">
          <Input
            aria-label={`搜索${label}`}
            placeholder="搜索选项"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            disabled={disabled}
          />
          <div className="case-choice-options">
            {[...new Set([...options, ...value])]
              .filter((option) => option.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
              .map((option) => (
                <label key={option}>
                  <input
                    type="checkbox"
                    checked={value.includes(option)}
                    disabled={disabled}
                    onChange={(e) =>
                      onChange(
                        e.currentTarget.checked
                          ? [...value, option]
                          : value.filter((item) => item !== option)
                      )
                    }
                  />
                  <span>{option}</span>
                </label>
              ))}
            {options.length === 0 && value.length === 0 ? <p>暂无可选值</p> : null}
          </div>
        </div>
      </details>
      {value.length ? (
        <div className="case-selected-values">
          {value.map((option) => (
            <button
              key={option}
              type="button"
              disabled={disabled}
              aria-label={`移除${label}：${option}`}
              onClick={() => onChange(value.filter((item) => item !== option))}
            >
              {option} ×
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Taxonomy chooser: existing values are selected, new values require an explicit action. */
export function CaseCreatableSelect({
  label,
  value,
  options,
  onChange,
  id,
  selectRef,
  invalid = false
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (value: string) => void;
  readonly id?: string;
  readonly selectRef?: Ref<HTMLSelectElement>;
  readonly invalid?: boolean;
}): ReactElement {
  const generatedId = useId();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <div className="case-creatable-select">
      <select
        ref={selectRef}
        aria-invalid={invalid}
        id={id ?? generatedId}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
      >
        <option value="" disabled>
          请选择
        </option>
        {[...new Set([...options, value])]
          .filter(Boolean)
          .sort()
          .map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
      </select>
      <Button type="button" variant="outline" onClick={() => setAdding(!adding)}>
        {adding ? "取消新增" : "新增"}
      </Button>
      {adding ? (
        <div className="case-inline-add">
          <Input
            aria-label={`新增${label}`}
            placeholder={`输入新的${label}`}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          <Button
            type="button"
            disabled={!draft.trim()}
            onClick={() => {
              onChange(draft.trim());
              setAdding(false);
              setDraft("");
            }}
          >
            使用
          </Button>
        </div>
      ) : null}
    </div>
  );
}
