import type { ReactElement } from "react";
import type { UseFormReturn } from "react-hook-form";
import type { EndpointFormValues } from "./configuration-form-mappers.ts";
import { Button } from "../../components/ui/button.tsx";

/** Explicitly apply safe transport defaults without guessing host or replacing credentials. */
export function BriefEndpointPreset({
  form
}: {
  readonly form: UseFormReturn<EndpointFormValues>;
}): ReactElement {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          form.setValue("name", "Cortex Brief 内容生成", { shouldDirty: true });
          form.setValue("bodySelector", "/request_body", { shouldDirty: true });
          form.setValue("timeoutMs", 150_000, { shouldDirty: true });
          form.setValue("defaultConcurrency", 2, { shouldDirty: true });
        }}
      >
        使用 Brief replay 参数预设
      </Button>
      <p className="field-hint">
        预设不改 URL 或认证。Brief 请填写已部署 Cortex 的 /eval/e2e/brief/replay 地址；Daily /
        Meeting 共用。
      </p>
    </>
  );
}
