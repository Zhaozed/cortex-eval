#!/usr/bin/env python3
"""Convert Loona JSONL cases to promptfoo test cases."""

from __future__ import annotations

import argparse
import copy
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

VAR_FIELDS = ("request_body", "type")
METADATA_FIELDS = ("case_id", "req_id", "task_id",  "scenario_tag")
EMPTY_VALUES = (None, "", [])
FILE_RUBRIC_PROMPT_PREFIX = "file://rubric_prompt/"
PROMPT_RUBRIC_PROMPT_PREFIX = "prompt://"
PROMPT_KEY_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
LEGACY_RUBRIC_PROMPT_PATTERN = re.compile(
    r"^file://rubric_prompt/([A-Za-z0-9][A-Za-z0-9._-]*)\.json$"
)
PROMPT_REFERENCE_PATTERN = re.compile(
    r"^prompt://[A-Za-z0-9][A-Za-z0-9._-]*$"
)
ASSERTION_FIELDS = {
    "type",
    "metric",
    "value",
    "threshold",
    "weight",
    "config",
    "rubricPrompt",
    "transform",
    "contextTransform",
    "assert",
}
SENSITIVE_KEY_SEGMENTS = {
    "auth",
    "authentication",
    "authorization",
    "bearer",
    "credential",
    "credentials",
    "dependencies",
    "dependency",
    "import",
    "module",
    "modules",
    "npm",
    "oauth",
    "package",
    "packages",
    "password",
    "pip",
    "provider",
    "require",
    "secret",
    "token",
}
COMPACT_SENSITIVE_MARKERS = (
    "accesskey",
    "apikey",
    "authorization",
    "bearer",
    "credential",
    "dependencies",
    "dependency",
    "module",
    "npm",
    "oauth",
    "package",
    "password",
    "pip",
    "privatekey",
    "provider",
    "secret",
)
SAFE_TOKEN_KEY_PREFIXES = ("tokenizer", "tokenization", "tokens")
EXTERNAL_REFERENCE_PREFIXES = (
    "file://",
    "module:",
    "node:",
    "npm:",
    "package:",
    "pip:",
)
# Set to False when generated case files must omit all LLM rubric assertions.
OUTPUT_LLM_RUBRIC_ASSERTIONS = True
# User-facing messages and assertion metric labels used by this standalone script.
MESSAGES: dict[str, str] = {
    "invalid_jsonl": "第 {line_no} 行不是合法 JSON，已跳过：{error}",
    "invalid_record": "第 {line_no} 行不是 JSON object，已跳过",
    "invalid_request_body_json": (
        "case_id={case_id} 的 request_body 不是合法 JSON 字符串，已跳过：{error}"
    ),
    "invalid_response_assertions": (
        "case_id={case_id} 的 expected_response_assertion_json "
        "不是合法 Promptfoo 断言对象或对象数组，已跳过：{error}"
    ),
    "invalid_rubric_prompt": (
        "case_id={case_id} 的 rubricPrompt={reference} 无法转换为数据库 Prompt 引用，已跳过"
    ),
    "unsupported_type": "case_id={case_id} 的 type={case_type} 不支持，已跳过",
    "missing_required_field": "case_id={case_id} 缺少必需字段 {field}，已跳过",
    "mismatched_tool_args": (
        "case_id={case_id} 的 expected_tool_name 数量为 {tool_count}，"
        "expected_tool_args_json 数量为 {args_count}，无法成对校验，已跳过"
    ),
    "invalid_expected_list": "case_id={case_id} 的 {field} 不是 list，已跳过",
    "unsupported_expected_field": (
        "case_id={case_id} 的 {field} 当前不支持自动转换，已跳过"
    ),
    "metric_router_reply_text": "router_有回复文本",
    "metric_router_intent": "router_分类",
    "metric_router_tools": "router_工具",
    "metric_router_domain": "router_domain",
    "metric_planner_tools": "planner_工具",
    "metric_present_mode": "planner_无输出模式",
    "metric_planner_reply_text": "planner_有回复文本",
    "summary": "转换完成：读取 {read_count} 条，输出 {write_count} 条，跳过 {skip_count} 条",
}


def load_messages() -> dict[str, str]:
    """Return an independent copy of the built-in message templates."""
    return MESSAGES.copy()


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


def build_non_empty_parsed_output_string_schema(field: str) -> dict[str, Any]:
    """Build JSON Schema requiring one non-empty parsed_output string field."""
    return {
        "type": "object",
        "required": ["parsed_output"],
        "properties": {
            "parsed_output": {
                "type": "object",
                "required": [field],
                "properties": {
                    field: {"type": "string", "minLength": 1},
                },
            },
        },
    }


def build_optional_present_mode_schema() -> dict[str, Any]:
    """Build JSON Schema allowing an absent reply_user_json and none/null mode."""
    return {
        "type": "object",
        "required": ["parsed_output"],
        "properties": {
            "parsed_output": {
                "type": "object",
                "properties": {
                    "reply_user_json": {
                        "type": "object",
                        "properties": {
                            "present_mode": {"enum": ["none", None]},
                        },
                    },
                },
            },
        },
    }


def build_schema_assertion(
        schema: dict[str, Any],
        messages: dict[str, str],
        metric_key: str,
        weight: int | None = None,
) -> dict[str, Any]:
    """Build one named promptfoo JSON Schema assertion."""
    assertion: dict[str, Any] = {
        "type": "is-json",
        "value": schema,
        "metric": messages[metric_key],
    }
    if weight is not None:
        assertion["weight"] = weight
    return assertion


def convert_rubric_prompt_references(
        assertions: list[dict[str, Any]], db: bool
) -> None:
    """Convert local rubric prompt files to database prompt references in place."""
    if not db:
        return

    for assertion in assertions:
        reference = assertion.get("rubricPrompt")
        if reference is not None:
            if not isinstance(reference, str):
                raise InvalidRubricPromptReference(str(reference))
            legacy_match = LEGACY_RUBRIC_PROMPT_PATTERN.fullmatch(reference)
            if legacy_match is not None:
                prompt_key = legacy_match.group(1)
                assertion["rubricPrompt"] = (
                    f"{PROMPT_RUBRIC_PROMPT_PREFIX}{prompt_key}"
                )
            elif PROMPT_REFERENCE_PATTERN.fullmatch(reference) is None:
                raise InvalidRubricPromptReference(reference)

        nested_assertions = assertion.get("assert")
        if isinstance(nested_assertions, list):
            convert_rubric_prompt_references(nested_assertions, db)


def remove_llm_rubric_assertions(assertions: list[dict[str, Any]]) -> None:
    """Remove LLM rubric assertions recursively, including empty assertion sets."""
    retained_assertions = []
    for assertion in assertions:
        if assertion.get("type") == "llm-rubric":
            continue

        nested_assertions = assertion.get("assert")
        if isinstance(nested_assertions, list):
            remove_llm_rubric_assertions(nested_assertions)
            if assertion.get("type") == "assert-set" and not nested_assertions:
                continue
        retained_assertions.append(assertion)
    assertions[:] = retained_assertions


def is_json_value(value: Any) -> bool:
    """Return whether a value can be represented by strict JSON."""
    if value is None or isinstance(value, (bool, str, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and is_json_value(item)
            for key, item in value.items()
        )
    return False


def config_key_segments(key: str) -> list[str]:
    """Split separators, camel case and acronym boundaries in config keys."""
    with_acronym_boundaries = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", key)
    with_word_boundaries = re.sub(
        r"([a-z0-9])([A-Z])",
        r"\1 \2",
        with_acronym_boundaries,
    )
    return [
        segment
        for segment in re.split(r"[^a-z0-9]+", with_word_boundaries.lower())
        if segment
    ]


def config_key_is_sensitive(key: str) -> bool:
    """Detect Provider, authentication, dependency and Secret key forms."""
    segments = config_key_segments(key)
    if any(segment in SENSITIVE_KEY_SEGMENTS for segment in segments):
        return True
    if any(
        segment == "api" and index + 1 < len(segments) and segments[index + 1] == "key"
        for index, segment in enumerate(segments)
    ):
        return True

    compact = "".join(segments)
    if any(marker in compact for marker in COMPACT_SENSITIVE_MARKERS):
        return True
    if compact.startswith("auth"):
        return True
    without_safe_token_words = compact
    for safe_word in SAFE_TOKEN_KEY_PREFIXES:
        without_safe_token_words = without_safe_token_words.replace(safe_word, "")
    if "token" in without_safe_token_words:
        return True
    return compact.startswith("api") and compact.endswith("key")


def external_reference_is_unsafe(value: Any) -> bool:
    """Recursively detect external executable or package references."""
    if isinstance(value, str):
        normalized = value.lstrip().lower()
        return any(
            normalized.startswith(prefix)
            for prefix in EXTERNAL_REFERENCE_PREFIXES
        )
    if isinstance(value, list):
        return any(external_reference_is_unsafe(item) for item in value)
    if isinstance(value, dict):
        return any(external_reference_is_unsafe(item) for item in value.values())
    return False


def assertion_config_is_unsafe(value: Any) -> bool:
    """Recursively reject sensitive keys and external config entries."""
    if isinstance(value, str):
        return external_reference_is_unsafe(value)
    if isinstance(value, list):
        return any(assertion_config_is_unsafe(item) for item in value)
    if isinstance(value, dict):
        return any(
            not isinstance(key, str)
            or config_key_is_sensitive(key)
            or assertion_config_is_unsafe(item)
            for key, item in value.items()
        )
    return False


def validate_response_assertion(assertion: dict[str, Any], path: str) -> str | None:
    """Return the first source assertion contract error, if present."""
    if not all(isinstance(key, str) for key in assertion):
        return f"{path} 的字段名必须是字符串"
    unknown_fields = set(assertion) - ASSERTION_FIELDS
    if unknown_fields:
        return f"{path} 包含未知字段 {sorted(unknown_fields)}"

    assertion_type = assertion.get("type")
    if not isinstance(assertion_type, str) or not assertion_type.strip():
        return f"{path}.type 必须是非空字符串"
    metric = assertion.get("metric")
    if not isinstance(metric, str) or not metric.strip():
        return f"{path}.metric 必须是非空字符串"

    for field in ("threshold", "weight"):
        value = assertion.get(field)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            return f"{path}.{field} 必须是数字"
    weight = assertion.get("weight")
    if isinstance(weight, (int, float)) and not isinstance(weight, bool) and weight < 0:
        return f"{path}.weight 不得为负数"

    config = assertion.get("config")
    if config is not None and not isinstance(config, dict):
        return f"{path}.config 必须是对象"
    if config is not None and assertion_config_is_unsafe(config):
        return f"{path}.config 包含 Provider、认证、依赖、Secret 或外部引用"
    for field in ("transform", "contextTransform"):
        value = assertion.get(field)
        if value is not None and (not isinstance(value, str) or not value):
            return f"{path}.{field} 必须是非空字符串"
        if value is not None and external_reference_is_unsafe(value):
            return f"{path}.{field} 包含外部引用"

    if "value" in assertion and external_reference_is_unsafe(assertion["value"]):
        return f"{path}.value 包含外部引用"

    reference = assertion.get("rubricPrompt")
    if reference is not None:
        valid_reference = isinstance(reference, str) and (
            LEGACY_RUBRIC_PROMPT_PATTERN.fullmatch(reference) is not None
            or PROMPT_REFERENCE_PATTERN.fullmatch(reference) is not None
        )
        if not valid_reference:
            return f"{path}.rubricPrompt 格式非法"

    nested_assertions = assertion.get("assert")
    is_assertion_set = assertion_type == "assert-set"
    if is_assertion_set != (nested_assertions is not None):
        return f"{path}.assert 与 type=assert-set 必须同时出现"
    if nested_assertions is not None:
        if not isinstance(nested_assertions, list) or not nested_assertions:
            return f"{path}.assert 必须是非空对象数组"
        for index, nested_assertion in enumerate(nested_assertions):
            if not isinstance(nested_assertion, dict):
                return f"{path}.assert[{index}] 必须是对象"
            error = validate_response_assertion(
                nested_assertion,
                f"{path}.assert[{index}]",
            )
            if error is not None:
                return error

    if not is_json_value(assertion):
        return f"{path} 包含无法序列化为 JSON 的值"
    return None


def prepare_assertions_for_output(
        assertions: list[dict[str, Any]], db: bool
) -> None:
    """Apply code-level assertion filtering and output reference formatting."""
    if not OUTPUT_LLM_RUBRIC_ASSERTIONS:
        remove_llm_rubric_assertions(assertions)
    convert_rubric_prompt_references(assertions, db)


def parse_response_assertions(
        raw_assertions: Any,
        messages: dict[str, str],
        case_id: str,
) -> list[dict[str, Any]]:
    """Parse and validate explicitly supplied Promptfoo response assertions."""
    if is_empty(raw_assertions):
        return []

    parsed_assertions = raw_assertions
    if isinstance(raw_assertions, str):
        try:
            parsed_assertions = json.loads(raw_assertions)
        except json.JSONDecodeError as error:
            raise ConversionSkip(
                format_message(
                    messages,
                    "invalid_response_assertions",
                    case_id=case_id,
                    error=error,
                )
            ) from error

    if is_empty(parsed_assertions):
        return []

    if isinstance(parsed_assertions, dict):
        assertion_list = [parsed_assertions]
    elif isinstance(parsed_assertions, list) and parsed_assertions:
        assertion_list = parsed_assertions
    else:
        raise ConversionSkip(
            format_message(
                messages,
                "invalid_response_assertions",
                case_id=case_id,
                error=f"实际类型为 {type(parsed_assertions).__name__}",
            )
        )

    for index, assertion in enumerate(assertion_list):
        if not isinstance(assertion, dict):
            error = f"assert[{index}] 必须是对象"
        else:
            error = validate_response_assertion(assertion, f"assert[{index}]")
        if error is not None:
            raise ConversionSkip(
                format_message(
                    messages,
                    "invalid_response_assertions",
                    case_id=case_id,
                    error=error,
                )
            )
    return copy.deepcopy(assertion_list)


def build_planner_tool_items_schema(
        tool_names: list[Any], tool_args: list[Any]
) -> dict[str, Any]:
    """Build JSON Schema for planner paired tool and args inclusion."""
    contains_rules = []
    for tool_name, args_json in zip(tool_names, tool_args):
        assertion_args = copy.deepcopy(args_json)
        if isinstance(assertion_args, dict):
            assertion_args.pop("user_id", None)
        contains_rules.append(
            {
                "contains": {
                    "type": "object",
                    "required": ["tool_name", "args_json"],
                    "properties": {
                        "tool_name": {"const": tool_name},
                        "args_json": {"const": assertion_args},
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


def build_test_case(
        row: dict[str, Any], messages: dict[str, str], db: bool = True
) -> dict[str, Any]:
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
        append_router_assertions(row, assertions, messages)
    if case_type == "planner":
        append_planner_assertions(row, assertions, messages, case_id)

    response_assertions = parse_response_assertions(
        row.get("expected_response_assertion_json"),
        messages,
        case_id,
    )

    if case_type == "planner" and not assertions:
        assertions.append(
            build_schema_assertion(
                build_base_schema(case_type),
                messages,
                "metric_planner_tools",
            )
        )
    append_task_contract_assertion(case_type, assertions, messages)
    append_response_text_assertion(case_type, assertions, messages)
    assertions.extend(response_assertions)
    try:
        prepare_assertions_for_output(assertions, db)
    except InvalidRubricPromptReference as error:
        raise ConversionSkip(
            format_message(
                messages,
                "invalid_rubric_prompt",
                case_id=case_id,
                reference=error.reference,
            )
        ) from error

    request_body = parse_request_body(row.get("request_body"), messages, case_id)
    meta={field: row.get(field) for field in METADATA_FIELDS}
    if "business_module" in row:
        meta["tool_category"] = row["business_module"].lower()
    meta['conversation_type']='simple'
    return {
        "description": str(row.get("case_name") or case_id),
        "threshold": 1,
        "vars": {"request_body": request_body, "task": row.get("type").lower()},
        "metadata": meta,
        "assert": assertions,
    }


def append_task_contract_assertion(
        case_type: str,
        assertions: list[dict[str, Any]],
        messages: dict[str, str],
) -> None:
    """Append fixed parsed_output contract assertions for a task type."""
    if case_type == "router":
        assertions.append(
            build_schema_assertion(
                build_parsed_output_const_schema("domain", "other"),
                messages,
                "metric_router_domain",
            )
        )
        return
    if case_type == "planner":
        assertions.append(
            build_schema_assertion(
                build_optional_present_mode_schema(),
                messages,
                "metric_present_mode",
            )
        )


def append_response_text_assertion(
        case_type: str,
        assertions: list[dict[str, Any]],
        messages: dict[str, str],
) -> None:
    """Append the task-specific non-empty response text assertion."""
    field = "text" if case_type == "router" else "reply_text"
    metric_key = (
        "metric_router_reply_text"
        if case_type == "router"
        else "metric_planner_reply_text"
    )
    assertions.append(
        build_schema_assertion(
            build_non_empty_parsed_output_string_schema(field),
            messages,
            metric_key,
            weight=0,
        )
    )


def append_router_assertions(
        row: dict[str, Any],
        assertions: list[dict[str, Any]],
        messages: dict[str, str],
) -> None:
    """Append router-specific structured assertions."""
    tool_names = row.get("expected_tool_name")
    if not is_empty(tool_names):
        assertions.append(
            build_schema_assertion(
                build_router_tools_schema(tool_names),
                messages,
                "metric_router_tools",
            )
        )

    intent_type = row.get("expected_intent_type_router")
    if not is_empty(intent_type):
        assertions.append(
            build_schema_assertion(
                build_router_intent_schema(intent_type),
                messages,
                "metric_router_intent",
            )
        )


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
        build_schema_assertion(
            build_planner_tool_items_schema(tool_names, tool_args),
            messages,
            "metric_planner_tools",
        )
    )


class ConversionSkip(Exception):
    """Raised when a source case cannot be safely converted."""


class InvalidRubricPromptReference(ValueError):
    """Raised when a rubric prompt cannot become a database reference."""

    def __init__(self, reference: str) -> None:
        """Store the rejected reference for the conversion boundary message."""
        super().__init__(reference)
        self.reference = reference


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
        description="Convert Loona JSONL test cases to promptfoo test cases."
    )
    parser.add_argument("--input", default="loona_test_cases_export.jsonl", help="source JSONL file")
    parser.add_argument(
        "--output",
        default=None,
        help="target output file",
    )
    parser.add_argument(
        "--jsonl",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="write JSONL (use --no-jsonl for JSON)",
    )
    parser.add_argument("--include-disabled", action="store_true", help="include enabled=false cases")
    parser.add_argument(
        "--db",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "use prompt:// rubric prompt references for database import "
            "(use --no-db to preserve file:// references)"
        ),
    )
    parser.add_argument("--pretty", action="store_true", help="pretty-print JSON output")
    parser.add_argument("--wrap-tests", action="store_true", help="write {\"tests\": [...]} instead of an array")
    args = parser.parse_args()
    if args.jsonl and (args.pretty or args.wrap_tests):
        parser.error("--pretty 和 --wrap-tests 仅适用于 --no-jsonl")
    if args.output is None:
        args.output = (
            "loona_promptfoo_tests.jsonl"
            if args.jsonl
            else "loona_promptfoo_tests.json"
        )
    return args


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
            tests.append(build_test_case(row, messages, db=args.db))
        except ConversionSkip as error:
            print(str(error), file=sys.stderr)
            skip_count += 1
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
