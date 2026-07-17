"""Tests for Loona-to-promptfoo assertion conversion."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from typing import Any

from data_scripts import convert_loona_to_promptfoo as converter
from data_scripts.convert_loona_to_promptfoo import (
    ConversionSkip,
    InvalidRubricPromptReference,
    build_test_case,
    convert_rubric_prompt_references,
    load_messages,
    main,
    parse_args,
    prepare_assertions_for_output,
)


class ConvertLoonaToPromptfooTest(unittest.TestCase):
    """Verify task-specific promptfoo assertions and metrics."""

    def setUp(self) -> None:
        """Load the same message labels used by the converter."""
        self.messages = load_messages()

    def test_load_messages_returns_complete_independent_copies(self) -> None:
        """Expose all required messages without sharing mutable state."""
        expected_keys = {
            "invalid_jsonl",
            "invalid_record",
            "invalid_request_body_json",
            "invalid_response_assertions",
            "invalid_rubric_prompt",
            "unsupported_type",
            "missing_required_field",
            "mismatched_tool_args",
            "invalid_expected_list",
            "unsupported_expected_field",
            "metric_planner_reply_text",
            "metric_router_reply_text",
            "metric_router_intent",
            "metric_router_tools",
            "metric_router_domain",
            "metric_planner_tools",
            "metric_present_mode",
            "summary",
        }

        first = load_messages()
        second = load_messages()
        first.pop("summary")

        self.assertEqual(set(second), expected_keys)
        self.assertIn("summary", load_messages())

    def test_db_mode_is_enabled_by_default_and_can_be_disabled(self) -> None:
        """Default to database prompt references while retaining file mode."""
        with patch("sys.argv", ["convert_loona_to_promptfoo.py"]):
            args = parse_args()
            self.assertTrue(args.db)
            self.assertTrue(args.jsonl)
            self.assertEqual(args.output, "loona_promptfoo_tests.jsonl")

        with patch(
            "sys.argv",
            ["convert_loona_to_promptfoo.py", "--no-db", "--no-jsonl"],
        ):
            args = parse_args()
            self.assertFalse(args.db)
            self.assertFalse(args.jsonl)
            self.assertEqual(args.output, "loona_promptfoo_tests.json")

    def test_db_mode_converts_file_rubric_prompt_references(self) -> None:
        """Convert rubric prompt files to database prompt keys."""
        assertions = [
            {
                "type": "llm-rubric",
                "rubricPrompt": (
                    "file://rubric_prompt/reply_text_repetition_rubric.json"
                ),
            },
            {
                "type": "llm-rubric",
                "rubricPrompt": "file://rubric_prompt/reply_text_quality.json",
            },
            {"type": "is-json", "value": {}},
        ]

        convert_rubric_prompt_references(assertions, db=True)

        self.assertEqual(
            assertions[0]["rubricPrompt"],
            "prompt://reply_text_repetition_rubric",
        )
        self.assertEqual(
            assertions[1]["rubricPrompt"],
            "prompt://reply_text_quality",
        )
        self.assertNotIn("rubricPrompt", assertions[2])

    def test_file_mode_preserves_rubric_prompt_references(self) -> None:
        """Preserve existing file references when database mode is disabled."""
        reference = "file://rubric_prompt/reply_text_repetition_rubric.json"
        assertions = [{"type": "llm-rubric", "rubricPrompt": reference}]

        convert_rubric_prompt_references(assertions, db=False)

        self.assertEqual(assertions[0]["rubricPrompt"], reference)

    def test_code_variable_can_disable_llm_rubric_assertions(self) -> None:
        """Filter LLM rubric assertions through the code-level output switch."""
        assertions = [
            {"type": "is-json", "value": {}},
            {
                "type": "llm-rubric",
                "rubricPrompt": (
                    "file://rubric_prompt/reply_text_repetition_rubric.json"
                ),
            },
        ]

        with patch.object(converter, "OUTPUT_LLM_RUBRIC_ASSERTIONS", False):
            prepare_assertions_for_output(assertions, db=True)

        self.assertEqual(assertions, [{"type": "is-json", "value": {}}])

    def test_build_case_converts_source_llm_rubric_for_db_output(self) -> None:
        """Apply DB references to source-provided assertions in the real flow."""
        reference = "file://rubric_prompt/reply_text_repetition_rubric.json"
        row = self.build_row(
            "Planner",
            expected_response_assertion_json=json.dumps(
                {
                    "type": "llm-rubric",
                    "value": "不得无效复述用户要求",
                    "rubricPrompt": reference,
                    "metric": "回复文本未无效复述用户要求",
                }
            ),
        )

        db_case = build_test_case(row, self.messages)
        file_case = build_test_case(row, self.messages, db=False)

        db_assertion = next(
            item for item in db_case["assert"] if item["type"] == "llm-rubric"
        )
        file_assertion = next(
            item for item in file_case["assert"] if item["type"] == "llm-rubric"
        )
        self.assertEqual(
            db_assertion["rubricPrompt"],
            "prompt://reply_text_repetition_rubric",
        )
        self.assertEqual(file_assertion["rubricPrompt"], reference)

    def test_build_case_code_variable_omits_source_llm_rubric(self) -> None:
        """Apply the code-level LLM rubric switch in the real build flow."""
        row = self.build_row(
            "Planner",
            expected_response_assertion_json={
                "type": "llm-rubric",
                "value": "不得无效复述用户要求",
                "rubricPrompt": (
                    "file://rubric_prompt/reply_text_repetition_rubric.json"
                ),
                "metric": "回复文本未无效复述用户要求",
            },
        )

        with patch.object(converter, "OUTPUT_LLM_RUBRIC_ASSERTIONS", False):
            test_case = build_test_case(row, self.messages)

        self.assertNotIn("llm-rubric", {item["type"] for item in test_case["assert"]})

    def test_main_writes_every_case_as_jsonl_by_default(self) -> None:
        """Write every converted case as one JSON object per line."""
        rows = [
            self.build_row("Router", case_id=f"case-{index}")
            for index in range(5)
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "input.jsonl"
            output_path = Path(temp_dir) / "output.jsonl"
            input_path.write_text(
                "".join(
                    f"{json.dumps(row, ensure_ascii=False)}\n"
                    for row in rows
                ),
                encoding="utf-8",
            )

            with patch(
                "sys.argv",
                [
                    "convert_loona_to_promptfoo.py",
                    "--input",
                    str(input_path),
                    "--output",
                    str(output_path),
                ],
            ):
                self.assertEqual(main(), 0)

            lines = output_path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 5)
            self.assertEqual(
                [json.loads(line)["metadata"]["case_id"] for line in lines],
                [row["case_id"] for row in rows],
            )

    def test_invalid_prompt_key_is_rejected_in_db_mode(self) -> None:
        """Reject database references that violate the prompt key contract."""
        reference = "file://rubric_prompt/非法 key.json"
        assertions = [{"type": "llm-rubric", "rubricPrompt": reference}]

        with self.assertRaises(InvalidRubricPromptReference):
            convert_rubric_prompt_references(assertions, db=True)

    def test_invalid_source_assertion_is_rejected(self) -> None:
        """Reject malformed source assertions before output generation."""
        invalid_assertions = (
            {},
            {"type": 1, "metric": "metric"},
            {"type": "llm-rubric"},
            {
                "type": "assert-set",
                "metric": "set",
                "assert": [{"type": "llm-rubric", "metric": 1}],
            },
        )

        for assertion in invalid_assertions:
            with self.subTest(assertion=assertion):
                row = self.build_row(
                    "Planner",
                    expected_response_assertion_json=assertion,
                )
                with self.assertRaises(ConversionSkip):
                    build_test_case(row, self.messages)

    def test_json_encoded_empty_source_assertions_are_ignored(self) -> None:
        """Treat JSON-encoded null and empty arrays like native empty values."""
        for empty_assertions in ("null", "[]"):
            with self.subTest(empty_assertions=empty_assertions):
                row = self.build_row(
                    "Planner",
                    expected_response_assertion_json=empty_assertions,
                )
                test_case = build_test_case(row, self.messages)
                self.assertNotIn(
                    "llm-rubric",
                    {item["type"] for item in test_case["assert"]},
                )

    def test_unsafe_source_assertion_is_rejected(self) -> None:
        """Reject external references and sensitive assertion configuration."""
        unsafe_fields = (
            {"value": "file://evil.js"},
            {"transform": " module:evil"},
            {"contextTransform": "npm:evil"},
            {"config": {"apiKey": "secret"}},
            {"config": {"nested": {"provider": "evil"}}},
            {"config": {"nested": "package:evil"}},
        )

        for unsafe_field in unsafe_fields:
            with self.subTest(unsafe_field=unsafe_field):
                row = self.build_row(
                    "Planner",
                    expected_response_assertion_json={
                        "type": "llm-rubric",
                        "metric": "unsafe",
                        **unsafe_field,
                    },
                )
                with self.assertRaises(ConversionSkip):
                    build_test_case(row, self.messages)

    def test_safe_tokenizer_config_is_allowed(self) -> None:
        """Do not mistake tokenizer configuration for a secret token."""
        row = self.build_row(
            "Planner",
            expected_response_assertion_json={
                "type": "llm-rubric",
                "metric": "safe",
                "config": {"tokenizer": {"tokens": 10}},
            },
        )

        test_case = build_test_case(row, self.messages)

        self.assertIn("safe", {item["metric"] for item in test_case["assert"]})

    def test_nested_llm_rubric_obeys_db_mode_and_output_switch(self) -> None:
        """Apply prompt conversion and filtering recursively to assertion sets."""
        reference = "file://rubric_prompt/reply_text_repetition_rubric.json"
        assertions = [
            {
                "type": "assert-set",
                "metric": "set",
                "assert": [
                    {
                        "type": "llm-rubric",
                        "metric": "rubric",
                        "rubricPrompt": reference,
                    },
                    {"type": "is-json", "metric": "shape", "value": {}},
                ],
            }
        ]

        convert_rubric_prompt_references(assertions, db=True)
        nested = assertions[0]["assert"]
        self.assertEqual(
            nested[0]["rubricPrompt"],
            "prompt://reply_text_repetition_rubric",
        )

        with patch.object(converter, "OUTPUT_LLM_RUBRIC_ASSERTIONS", False):
            prepare_assertions_for_output(assertions, db=True)

        self.assertEqual(nested, [{"type": "is-json", "metric": "shape", "value": {}}])

    def test_jsonl_rejects_json_only_formatting_options(self) -> None:
        """Reject flags that cannot affect JSONL output."""
        for option in ("--pretty", "--wrap-tests"):
            with self.subTest(option=option):
                with patch("sys.argv", ["convert_loona_to_promptfoo.py", option]):
                    with self.assertRaises(SystemExit):
                        parse_args()

    def build_row(self, case_type: str, **overrides: Any) -> dict[str, Any]:
        """Build one minimal valid source row."""
        row: dict[str, Any] = {
            "request_body": "{}",
            "type": case_type,
            "case_id": f"case-{case_type.lower()}",
            "req_id": "request-1",
            "task_id": "task-1",
            "business_module": "test",
            "scenario_tag": "unit",
            "expected_tool_name": None,
            "expected_tool_args_json": None,
            "expected_intent_type_router": None,
        }
        row.update(overrides)
        return row

    def assertions_by_metric(self, row: dict[str, Any]) -> dict[str, dict[str, Any]]:
        """Index generated assertions by their configured metric label."""
        test_case = build_test_case(row, self.messages)
        return {
            assertion["metric"]: assertion
            for assertion in test_case["assert"]
            if "metric" in assertion
        }

    def test_router_has_zero_weight_non_empty_text_assertion(self) -> None:
        """Require Router parsed_output.text without affecting the case score."""
        expected_schema = {
            "type": "object",
            "required": ["parsed_output"],
            "properties": {
                "parsed_output": {
                    "type": "object",
                    "required": ["text"],
                    "properties": {
                        "text": {"type": "string", "minLength": 1},
                    },
                },
            },
        }

        assertions = self.assertions_by_metric(self.build_row("Router"))
        assertion = assertions[self.messages["metric_router_reply_text"]]

        self.assertEqual(assertion["type"], "is-json")
        self.assertEqual(assertion["weight"], 0)
        self.assertEqual(assertion["value"], expected_schema)

    def test_planner_has_zero_weight_non_empty_reply_text_assertion(self) -> None:
        """Require Planner parsed_output.reply_text without affecting the score."""
        expected_schema = {
            "type": "object",
            "required": ["parsed_output"],
            "properties": {
                "parsed_output": {
                    "type": "object",
                    "required": ["reply_text"],
                    "properties": {
                        "reply_text": {"type": "string", "minLength": 1},
                    },
                },
            },
        }

        assertions = self.assertions_by_metric(self.build_row("Planner"))
        assertion = assertions[self.messages["metric_planner_reply_text"]]

        self.assertEqual(assertion["type"], "is-json")
        self.assertEqual(assertion["weight"], 0)
        self.assertEqual(assertion["value"], expected_schema)

    def test_router_only_generates_configured_tool_and_intent_assertions(self) -> None:
        """Do not synthesize Router tool or intent assertions without expectations."""
        cases = (
            ({}, set()),
            (
                {"expected_tool_name": ["web_search"]},
                {self.messages["metric_router_tools"]},
            ),
            (
                {"expected_intent_type_router": "NEW"},
                {self.messages["metric_router_intent"]},
            ),
            (
                {
                    "expected_tool_name": ["web_search"],
                    "expected_intent_type_router": "NEW",
                },
                {
                    self.messages["metric_router_tools"],
                    self.messages["metric_router_intent"],
                },
            ),
        )

        fixed_metrics = {
            self.messages["metric_router_domain"],
            self.messages["metric_router_reply_text"],
        }
        for overrides, conditional_metrics in cases:
            with self.subTest(overrides=overrides):
                assertions = self.assertions_by_metric(
                    self.build_row("Router", **overrides)
                )
                self.assertEqual(set(assertions), fixed_metrics | conditional_metrics)

    def test_router_metrics_preserve_existing_assertion_schemas(self) -> None:
        """Label Router assertions without changing their matching rules."""
        assertions = self.assertions_by_metric(
            self.build_row(
                "Router",
                expected_tool_name=["web_search"],
                expected_intent_type_router="NEW",
            )
        )

        tools_schema = assertions[self.messages["metric_router_tools"]]["value"]
        tools = tools_schema["properties"]["parsed_output"]["properties"]["router_tools"]
        self.assertEqual(tools["allOf"], [{"contains": {"const": "web_search"}}])

        intent_schema = assertions[self.messages["metric_router_intent"]]["value"]
        intent = intent_schema["properties"]["parsed_output"]["properties"]["llm_intent"]
        self.assertEqual(intent, {"const": "NEW"})

        domain_schema = assertions[self.messages["metric_router_domain"]]["value"]
        domain = domain_schema["properties"]["parsed_output"]["properties"]["domain"]
        self.assertEqual(domain, {"const": "other"})

    def test_planner_tools_metric_covers_expected_and_shape_only_paths(self) -> None:
        """Label both Planner tool assertion branches with one metric."""
        rows = (
            self.build_row("Planner", expected_tool_name=[], expected_tool_args_json=[]),
            self.build_row(
                "Planner",
                expected_tool_name=["web_search"],
                expected_tool_args_json=[{"query": "test"}],
            ),
        )

        for row in rows:
            with self.subTest(expected_tool_name=row["expected_tool_name"]):
                assertions = self.assertions_by_metric(row)
                tool_assertion = assertions[self.messages["metric_planner_tools"]]
                self.assertEqual(tool_assertion["type"], "is-json")
                tools = tool_assertion["value"]["properties"]["parsed_output"]
                self.assertIn("tools", tools["required"])
                self.assertEqual(tools["properties"]["tools"]["type"], "array")

    def test_planner_tool_assertion_omits_user_id_without_mutating_source(self) -> None:
        """Remove invocation identity from expected args while preserving source data."""
        expected_args = {
            "query": "test",
            "user_id": "user-1",
            "filters": {"user_id": "business-user"},
        }
        row = self.build_row(
            "Planner",
            expected_tool_name=["web_search"],
            expected_tool_args_json=[expected_args],
        )

        assertions = self.assertions_by_metric(row)

        tool_assertion = assertions[self.messages["metric_planner_tools"]]
        tools_schema = tool_assertion["value"]["properties"]["parsed_output"]
        contains = tools_schema["properties"]["tools"]["allOf"][0]["contains"]
        self.assertEqual(
            contains["properties"]["args_json"]["const"],
            {"query": "test", "filters": {"user_id": "business-user"}},
        )
        self.assertEqual(
            expected_args,
            {
                "query": "test",
                "user_id": "user-1",
                "filters": {"user_id": "business-user"},
            },
        )

    def test_present_mode_schema_allows_missing_parent_and_nullable_field(self) -> None:
        """Allow reply_user_json absence and only none/null present_mode values."""
        assertions = self.assertions_by_metric(self.build_row("Planner"))
        assertion = assertions[self.messages["metric_present_mode"]]
        self.assertEqual(assertion["type"], "is-json")
        self.assertEqual(
            assertion["value"],
            {
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
            },
        )


if __name__ == "__main__":
    unittest.main()
