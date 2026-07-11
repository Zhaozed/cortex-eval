#!/usr/bin/env python3
"""Convert Loona JSONL cases to promptfoo test cases."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

VAR_FIELDS = ("request_body", "type")
METADATA_FIELDS = ("case_id", "req_id", "task_id", "business_module", "scenario_tag")
EMPTY_VALUES = (None, "", [])
MESSAGE_FILE = Path(__file__).with_name("loona_promptfoo_messages.json")


def load_messages(path: Path = MESSAGE_FILE) -> dict[str, str]:
    """Load user-facing message templates."""
    with path.open("r", encoding="utf-8") as message_file:
        messages = json.load(message_file)
    if not isinstance(messages, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return {str(key): str(value) for key, value in messages.items()}


def format_message(messages: dict[str, str], key: str, **values: Any) -> str:
    """Render a configured message template."""
    template = messages[key]
    return template.format(**values)


def is_empty(value: Any) -> bool:
    """Return whether a source field has no assertion value."""
    return value in EMPTY_VALUES


def normalize_case_type(raw_type: Any) -> str:
    """Normalize case type for conversion branch selection."""
    if not isinstance(raw_type, str):
        return ""
    return raw_type.strip().lower()


def parse_request_body(raw_request_body: Any, messages: dict[str, str], case_id: str) -> Any:
    """Parse request_body strings into JSON values for promptfoo vars."""
    if not isinstance(raw_request_body, str):
        ret = raw_request_body
    else:
        try:
            ret = json.loads(raw_request_body)
        except json.JSONDecodeError as error:
            raise ConversionSkip(
                format_message(
                    messages,
                    "invalid_request_body_json",
                    case_id=case_id,
                    error=error,
                )
            ) from error
    ret['lang'] = 'zh-Hans'
    return ret

def build_base_schema(case_type: str) -> dict[str, Any]:
    """Build the minimal response shape assertion schema."""
    parsed_properties: dict[str, Any] = {}
    parsed_required: list[str] = []
    if case_type == "router":
        parsed_required = ["router_tools", "llm_intent"]
        parsed_properties = {
            "router_tools": {"type": "array"},
            "llm_intent": {"type": ["string", "null"]},
        }
    if case_type == "planner":
        parsed_required = ["tools"]
        parsed_properties = {
            "tools": {"type": "array"},
        }
    return {
        "type": "object",
        "required": ["parsed_output"],
        "properties": {
            "parsed_output": {
                "type": "object",
                "required": parsed_required,
                "properties": parsed_properties,
            },
        },
    }


def build_router_tools_schema(tool_names: list[Any]) -> dict[str, Any]:
    """Build JSON Schema for router tool inclusion."""
    return {
        "type": "object",
        "required": ["parsed_output"],
        "properties": {
            "parsed_output": {
                "type": "object",
                "required": ["router_tools"],
                "properties": {
                    "router_tools": {
                        "type": "array",
                        "allOf": [
                            {"contains": {"const": tool_name}}
                            for tool_name in tool_names
                        ],
                    },
                },
            },
        },
    }


def build_router_intent_schema(intent_type: Any) -> dict[str, Any]:
    """Build JSON Schema for router intent equality."""
    return {
        "type": "object",
        "required": ["parsed_output"],
        "properties": {
            "parsed_output": {
                "type": "object",
                "required": ["llm_intent"],
                "properties": {
                    "llm_intent": {"const": intent_type},
                },
            },
        },
    }


def build_parsed_output_const_schema(field: str, value: Any) -> dict[str, Any]:
    """Build JSON Schema for one fixed parsed_output field."""
    return {
        "type": "object",
        "required": ["parsed_output"],
        "properties": {
            "parsed_output": {
                "type": "object",
                "required": [field],
                "properties": {
                    field: {"const": value},
                },
            },
        },
    }


def build_parsed_output_nested_const_schema(parent_field: str, field: str, value: Any) -> dict[str, Any]:
    """Build JSON Schema for one fixed nested parsed_output field."""
    return {
        "type": "object",
        "required": ["parsed_output"],
        "properties": {
            "parsed_output": {
                "type": "object",
                "required": [parent_field],
                "properties": {
                    parent_field: {
                        "type": "object",
                        "required": [field],
                        "properties": {
                            field: {"const": value},
                        },
                    },
                },
            },
        },
    }


def build_planner_tool_items_schema(
        tool_names: list[Any], tool_args: list[Any]
) -> dict[str, Any]:
    """Build JSON Schema for planner paired tool and args inclusion."""
    contains_rules = []
    for tool_name, args_json in zip(tool_names, tool_args):
        contains_rules.append(
            {
                "contains": {
                    "type": "object",
                    "required": ["tool_name", "args_json"],
                    "properties": {
                        "tool_name": {"const": tool_name},
                        "args_json": {"const": args_json},
                    },
                }
            }
        )
    return build_planner_tools_schema(contains_rules)


def build_planner_tools_schema(contains_rules: list[dict[str, Any]]) -> dict[str, Any]:
    """Build a JSON Schema rooted at parsed_output.tools."""
    return {
        "type": "object",
        "required": ["parsed_output"],
        "properties": {
            "parsed_output": {
                "type": "object",
                "required": ["tools"],
                "properties": {
                    "tools": {
                        "type": "array",
                        "allOf": contains_rules,
                    },
                },
            },
        },
    }


def build_test_case(row: dict[str, Any], messages: dict[str, str]) -> dict[str, Any]:
    """Convert one source row to one promptfoo test case."""
    case_id = str(row.get("case_id") or f"row-{row.get('id', 'unknown')}")
    case_type = normalize_case_type(row.get("type"))
    if case_type not in ("router", "planner"):
        raise ConversionSkip(
            format_message(
                messages,
                "unsupported_type",
                case_id=case_id,
                case_type=row.get("type"),
            )
        )

    for field in (*VAR_FIELDS, *METADATA_FIELDS):
        if field not in row:
            raise ConversionSkip(
                format_message(messages, "missing_required_field", case_id=case_id, field=field)
            )

    for field in ("expected_tool_order", "forbid_redundant_tools"):
        if not is_empty(row.get(field)):
            raise ConversionSkip(
                format_message(messages, "unsupported_expected_field", case_id=case_id, field=field)
            )

    if not is_empty(row.get("expected_tool_args_assertion_json")):
        raise ConversionSkip(
            format_message(
                messages,
                "unsupported_expected_field",
                case_id=case_id,
                field="expected_tool_args_assertion_json",
            )
        )

    assertions: list[dict[str, Any]] = []
    if case_type == "router":
        append_router_assertions(row, assertions)
    if case_type == "planner":
        append_planner_assertions(row, assertions, messages, case_id)

    if not is_empty(row.get("expected_response_assertion_json")):
        raise ConversionSkip(
            format_message(
                messages,
                "unsupported_expected_field",
                case_id=case_id,
                field="expected_response_assertion_json",
            )
        )

    if not assertions:
        assertions.append({"type": "is-json", "value": build_base_schema(case_type)})
    append_task_contract_assertion(case_type, assertions)

    request_body = parse_request_body(row.get("request_body"), messages, case_id)

    return {
        "description": str(row.get("case_name") or case_id),
        "threshold": 1,
        "vars": {"request_body": request_body, "task": row.get("type").lower()},
        "metadata": {field: row.get(field) for field in METADATA_FIELDS},
        "assert": assertions,
    }


def append_task_contract_assertion(case_type: str, assertions: list[dict[str, Any]]) -> None:
    """Append fixed parsed_output contract assertions for a task type."""
    if case_type == "router":
        assertions.append(
            {"type": "is-json", "value": build_parsed_output_const_schema("domain", "other")}
        )
        return
    if case_type == "planner":
        assertions.append(
            {
                "type": "is-json",
                "value": build_parsed_output_nested_const_schema(
                    "reply_user_json",
                    "present_mode",
                    "none",
                ),
            }
        )


def append_router_assertions(row: dict[str, Any], assertions: list[dict[str, Any]]) -> None:
    """Append router-specific structured assertions."""
    tool_names = row.get("expected_tool_name")
    if not is_empty(tool_names):
        assertions.append({"type": "is-json", "value": build_router_tools_schema(tool_names)})

    intent_type = row.get("expected_intent_type_router")
    if not is_empty(intent_type):
        assertions.append({"type": "is-json", "value": build_router_intent_schema(intent_type)})


def append_planner_assertions(
        row: dict[str, Any],
        assertions: list[dict[str, Any]],
        messages: dict[str, str],
        case_id: str,
) -> None:
    """Append planner-specific structured assertions."""
    tool_names = row.get("expected_tool_name")
    tool_args = row.get("expected_tool_args_json")

    has_names = not is_empty(tool_names)
    has_args = not is_empty(tool_args)
    if not has_names and not has_args:
        return

    if not isinstance(tool_names, list):
        raise ConversionSkip(
            format_message(
                messages,
                "invalid_expected_list",
                case_id=case_id,
                field="expected_tool_name",
            )
        )
    if not isinstance(tool_args, list):
        raise ConversionSkip(
            format_message(
                messages,
                "invalid_expected_list",
                case_id=case_id,
                field="expected_tool_args_json",
            )
        )

    if len(tool_names) != len(tool_args):
        raise ConversionSkip(
            format_message(
                messages,
                "mismatched_tool_args",
                case_id=case_id,
                tool_count=len(tool_names),
                args_count=len(tool_args),
            )
        )

    assertions.append(
        {
            "type": "is-json",
            "value": build_planner_tool_items_schema(tool_names, tool_args),
        }
    )


class ConversionSkip(Exception):
    """Raised when a source case cannot be safely converted."""


def iter_source_rows(input_path: Path, messages: dict[str, str]) -> tuple[int, list[dict[str, Any]]]:
    """Read JSONL source rows and skip malformed records."""
    read_count = 0
    rows = []
    with input_path.open("r", encoding="utf-8") as source_file:
        for line_no, line in enumerate(source_file, start=1):
            if not line.strip():
                continue
            read_count += 1
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                print(
                    format_message(
                        messages,
                        "invalid_jsonl",
                        line_no=line_no,
                        error=error,
                    ),
                    file=sys.stderr,
                )
                continue
            if not isinstance(row, dict):
                print(
                    format_message(messages, "invalid_record", line_no=line_no),
                    file=sys.stderr,
                )
                continue
            rows.append(row)
    return read_count, rows


def write_json_output(output_path: Path, tests: list[dict[str, Any]], pretty: bool, wrap_tests: bool) -> None:
    """Write converted tests to a JSON file."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload: Any = {"tests": tests} if wrap_tests else tests
    with output_path.open("w", encoding="utf-8") as output_file:
        if pretty:
            json.dump(payload, output_file, ensure_ascii=False, indent=2)
        else:
            json.dump(payload, output_file, ensure_ascii=False, separators=(",", ":"))
        output_file.write("\n")


def write_jsonl_output(output_path: Path, tests: list[dict[str, Any]]) -> None:
    """Write converted tests to a JSONL file."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as output_file:
        for test_case in tests:
            output_file.write(json.dumps(test_case, ensure_ascii=False, separators=(",", ":")))
            output_file.write("\n")


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Convert Loona JSONL test cases to promptfoo test case JSON."
    )
    parser.add_argument("--input", default="loona_test_cases_export.jsonl", help="source JSONL file")
    parser.add_argument(
        "--output",
        default="loona_promptfoo_tests.json",
        help="target output file",
    )
    parser.add_argument("--jsonl", action="store_true", help="write JSONL instead of JSON")
    parser.add_argument("--include-disabled", action="store_true", help="include enabled=false cases")
    parser.add_argument("--pretty", action="store_true", help="pretty-print JSON output")
    parser.add_argument("--wrap-tests", action="store_true", help="write {\"tests\": [...]} instead of an array")
    return parser.parse_args()


def main() -> int:
    """Run the conversion command."""
    args = parse_args()
    messages = load_messages()
    input_path = Path(args.input)
    output_path = Path(args.output)

    read_count, rows = iter_source_rows(input_path, messages)
    tests = []
    skip_count = read_count - len(rows)
    for row in rows:
        if row.get("enabled") is False and not args.include_disabled:
            skip_count += 1
            continue
        try:
            tests.append(build_test_case(row, messages))
        except ConversionSkip as error:
            print(str(error), file=sys.stderr)
            skip_count += 1
    tests=tests[-2:]
    if args.jsonl:
        write_jsonl_output(output_path, tests)
    else:
        write_json_output(output_path, tests, args.pretty, args.wrap_tests)

    print(
        format_message(
            messages,
            "summary",
            read_count=read_count,
            write_count=len(tests),
            skip_count=skip_count,
        ),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
