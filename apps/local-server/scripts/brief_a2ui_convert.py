"""Brief public_result -> A2UI 稳定载荷的离线转换桥。

由 cortex-eval 本地服务以子进程方式调用：
  argv[1]  Cortex 仓库根目录（processor / rendering 配置按 cwd 相对路径解析）
  stdin    {"brief_type": "daily"|"meeting", "result": <public_results[i]>, "timezone": "Asia/Shanghai"}
  stdout   {"ok": true, "payload": <a2ui payload>} 或 {"ok": false, "error": "..."}
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    root = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(root))
    request = json.load(sys.stdin)
    brief_type = request["brief_type"]
    tool_name = {"daily": "daily_brief", "meeting": "meeting_brief"}[brief_type]

    from src.presentation.a2ui.config.a2ui_template_catalog import A2uiTemplateCatalog
    from src.presentation.a2ui.config.a2ui_template_parser import parse_a2ui_tool_template_text
    from src.presentation.a2ui.conversion.orchestration.a2ui_local_resources import (
        load_local_processor_catalog,
        load_local_rendering_config,
    )
    from src.presentation.a2ui.conversion.orchestration.convert_a2ui_adapter import (
        build_a2ui_for_result_payload,
    )
    from src.presentation.a2ui.validation.a2ui_validator_resources import (
        component_catalog_or_project_default,
        project_text_catalog,
    )

    template_path = root / f"config/ui_template/{tool_name}_cards.json"
    template = parse_a2ui_tool_template_text(
        template_path.read_text(encoding="utf-8"),
        source_name=str(template_path),
        component_catalog=component_catalog_or_project_default(
            component_catalog=None, component_dir=None
        ),
    )
    payload = build_a2ui_for_result_payload(
        result_payload={"source_tool_name": tool_name, "result": request["result"]},
        surface_id=f"eval_brief_{brief_type}",
        template_catalog=A2uiTemplateCatalog.from_templates([template]),
        processor_catalog=load_local_processor_catalog(),
        text_catalog=project_text_catalog(),
        rendering_config=load_local_rendering_config(),
        request_timezone=request.get("timezone") or "Asia/Shanghai",
    )
    if not isinstance(payload, dict) or not payload.get("messages"):
        print(json.dumps({"ok": False, "error": "A2UI_EMPTY_PAYLOAD"}))
        return 0
    print(json.dumps({"ok": True, "payload": payload}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # 转换失败不能拖垮 Case 预览，错误透传给平台侧本地化
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        raise SystemExit(0)
