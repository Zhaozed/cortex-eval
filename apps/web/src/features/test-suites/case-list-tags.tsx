import type { ReactElement } from "react";

import { Badge } from "../../components/ui/badge.tsx";

/** Display exact Case facts, optionally disclosing longer lists on demand. */
export function CaseListTags({
  values,
  previewCount = values.length
}: {
  readonly values: readonly string[];
  readonly previewCount?: number;
}): ReactElement {
  const visible = values.slice(0, previewCount);
  const remaining = values.slice(previewCount);
  return (
    <div className="tag-list">
      {visible.map((value) => (
        <Badge key={value} variant="secondary">
          {value}
        </Badge>
      ))}
      {remaining.length > 0 ? (
        <details className="case-tags-more">
          <summary>其余 {remaining.length} 项</summary>
          <div className="tag-list">
            {remaining.map((value) => (
              <Badge key={value} variant="secondary">
                {value}
              </Badge>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
