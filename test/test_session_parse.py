#!/usr/bin/env python3
"""AQ-008 / D11: Python SDK parses CLI machine JSON, not human stderr."""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from agentchat.session import GeminiSession  # noqa: E402


def gs():
    s = GeminiSession.__new__(GeminiSession)
    return s


HUMAN = (
    "[fallback] ✓ ChatGPT: USED (12 chars, 99ms total)\n"
    "Fallback chain: gemini → chatgpt (1 provider(s) skipped)\n"
    "Pro Extended Thinking active\n"
    "Flash-Lite leftover log\n"
)


class TestSessionParse(unittest.TestCase):
    def test_state_json_wins_over_human_logs(self):
        payload = {
            "state": "ready",
            "reason": None,
            "seat": "AgentChat",
            "port": 9222,
            "display": None,
            "checked_at": "2026-10-11T00:00:00.000Z",
            "provider_used": "Gemini",
            "fallback_chain": ["gemini"],
            "model_used": "Flash",
            "total_ms": 1500,
            "exit": 0,
            "run_id": "ac-deadbeef",
        }
        stderr = HUMAN + "[oneweb] AGENTCHAT_STATE " + json.dumps(payload) + "\n"
        r = gs()._parse_result("hello world from gemini", stderr, 999, 0)
        self.assertTrue(r.success)
        self.assertEqual(r.provider_used, "Gemini")
        self.assertEqual(r.model_used, "Flash")
        self.assertEqual(r.fallback_chain, ["gemini"])
        self.assertEqual(r.total_time_ms, 1500)
        self.assertEqual(r.state, "ready")
        self.assertIsNone(r.reason)
        self.assertEqual(r.run_id, "ac-deadbeef")

    def test_human_stderr_alone_does_not_fill_fields(self):
        r = gs()._parse_result("hello world from gemini", HUMAN, 999, 0)
        self.assertEqual(r.provider_used, "")
        self.assertEqual(r.model_used, "")
        self.assertEqual(r.fallback_chain, [])
        self.assertEqual(r.total_time_ms, 999)

    def test_receipt_fallback(self):
        receipt = {
            "run_id": "ac-1",
            "skill": "AgentChat-OneWeb",
            "exit": 0,
            "provider_used": "Qwen",
            "providers_tried": ["gemini", "qwen"],
            "state": "ready",
            "reason": None,
            "model_used": "",
            "total_ms": 80,
        }
        stderr = HUMAN + "[receipt] AGENTCHAT_RUN " + json.dumps(receipt) + "\n"
        r = gs()._parse_result("qwen says hi!!!!", stderr, 1, 0)
        self.assertEqual(r.provider_used, "Qwen")
        self.assertEqual(r.fallback_chain, ["gemini", "qwen"])
        self.assertEqual(r.state, "ready")
        self.assertIsNone(r.reason)

    def test_needs_human_fields_are_not_concatenated(self):
        payload = {
            "state": "needs_human",
            "reason": "muse_login",
            "seat": "Fork-5",
            "port": 9227,
            "display": ":5",
            "checked_at": "2026-10-11T00:00:00.000Z",
            "provider_used": "Muse",
            "fallback_chain": ["muse"],
            "exit": 2,
            "run_id": "ac-2",
        }
        stderr = "[oneweb] AGENTCHAT_STATE " + json.dumps(payload) + "\n"
        r = gs()._parse_result("", stderr, 10, 2)
        self.assertFalse(r.success)
        self.assertEqual(r.state, "needs_human")
        self.assertEqual(r.reason, "muse_login")
        self.assertNotIn("needs_human:", str(r.reason))

    def test_malformed_json_ignored(self):
        stderr = HUMAN + "[oneweb] AGENTCHAT_STATE {not-json\n"
        r = gs()._parse_result("hello world from gemini", stderr, 5, 0)
        self.assertEqual(r.provider_used, "")
        self.assertEqual(r.model_used, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
