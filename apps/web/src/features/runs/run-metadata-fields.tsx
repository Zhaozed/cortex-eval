import type { ReactElement } from "react";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";

/** Shared, bounded human labels for new Runs and reruns. */
export function RunMetadataFields({
  name,
  description,
  onName,
  onDescription
}: {
  readonly name: string;
  readonly description: string;
  readonly onName: (value: string) => void;
  readonly onDescription: (value: string) => void;
}): ReactElement {
  return (
    <div className="run-metadata-fields">
      <label className="run-field">
        <span>运行名称</span>
        <Input
          required
          maxLength={120}
          value={name}
          onChange={(event) => onName(event.target.value)}
          placeholder="例如：待办时间解析修复回归"
        />
      </label>
      <label className="run-field">
        <span>
          运行描述 <small>选填</small>
        </span>
        <Textarea
          maxLength={2000}
          rows={3}
          value={description}
          onChange={(event) => onDescription(event.target.value)}
          placeholder="这次测什么？记录测试目的、改动或重点关注的场景。"
        />
      </label>
    </div>
  );
}
