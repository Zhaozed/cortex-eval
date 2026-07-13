"""Tests for Loona-to-promptfoo assertion conversion."""

from __future__ import annotations

import unittest
from typing import Any

from data_scripts.convert_loona_to_promptfoo import build_test_case, load_messages


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
