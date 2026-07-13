import type { ReactElement } from "react";

import { Badge } from "../../components/ui/badge.tsx";

/** Display one list of exact Case facts as compact Badges. */
export function CaseListTags({ values }: { readonly values: readonly string[] }): ReactElement {
  return (
    <div className="tag-list">
      {values.map((value) => (
        <Badge key={value} variant="secondary">
          {value}
        </Badge>
      ))}
    </div>
  );
}
