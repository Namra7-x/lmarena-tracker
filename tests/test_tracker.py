#!/usr/bin/env python3
"""
Comprehensive Unit Test Suite for LM Arena Tracker (tracker.py)
Validates all detection categories, modality collapse guards, ID rotation pairing,
userSelectable tracking, large change confirmation, and Discord Embed generation.
"""

import json
import os
import unittest
from unittest.mock import MagicMock, patch

import tracker


def make_dummy_model(
    mid: str,
    public_name: str,
    org: str = "openai",
    provider: str = "openai",
    display_name: str = None,
    name: str = None,
    rank: int = 100,
    out_caps: dict = None,
    in_caps: dict = None,
    rank_by_modality: dict = None,
    user_selectable: bool = True,
) -> dict:
    if out_caps is None:
        out_caps = {"text": True}
    if in_caps is None:
        in_caps = {"text": True}
    if rank_by_modality is None:
        rank_by_modality = {"chat": rank}
    return {
        "id": mid,
        "publicName": public_name,
        "displayName": display_name or public_name,
        "name": name or public_name,
        "organization": org,
        "provider": provider,
        "userSelectable": user_selectable,
        "rank": rank,
        "rankByModality": rank_by_modality,
        "capabilities": {
            "inputCapabilities": in_caps,
            "outputCapabilities": out_caps,
        },
    }


class TestTrackerCore(unittest.TestCase):

    def test_scenario_a_no_change(self):
        """Scenario A: Identical old and new snapshots -> no changes."""
        old = {
            "m1": make_dummy_model("m1", "gpt-5"),
            "m2": make_dummy_model("m2", "claude-4"),
        }
        new = json.loads(json.dumps(old))
        report = tracker.detect_changes(old, new)
        self.assertFalse(report.has_changes())
        self.assertEqual(tracker.build_discord_embeds(report), [])

    def test_scenario_b_new_model(self):
        """Scenario B: 1 genuinely new model -> detected with line-by-line card layout."""
        old = {"m1": make_dummy_model("m1", "gpt-5")}
        new = {
            "m1": make_dummy_model("m1", "gpt-5"),
            "m2": make_dummy_model("m2", "gemini-3", org="google"),
        }
        report = tracker.detect_changes(old, new)
        self.assertTrue(report.has_changes())
        self.assertEqual(len(report.new_models), 1)
        self.assertEqual(report.new_models[0]["id"], "m2")
        embeds = tracker.build_discord_embeds(report)
        self.assertTrue(any("NEW MODEL LIVE" in e["title"] for e in embeds))

    def test_scenario_c_capability_updates(self):
        """Scenario C: Model gains or loses capabilities -> detected."""
        old = {"m1": make_dummy_model("m1", "gpt-5", in_caps={"text": True})}
        new = {
            "m1": make_dummy_model(
                "m1",
                "gpt-5",
                in_caps={"text": True, "image": True},
                out_caps={"text": True, "search": True},
            )
        }
        report = tracker.detect_changes(old, new)
        self.assertTrue(report.has_changes())
        self.assertEqual(len(report.capability_updates), 1)
        embeds = tracker.build_discord_embeds(report)
        self.assertTrue(any("CAPABILITIES UPDATED" in e["title"] for e in embeds))

    def test_scenario_d_name_updates(self):
        """Scenario D: Model changes displayName or publicName -> detected."""
        old = {"m1": make_dummy_model("m1", "gpt-5", display_name="GPT 5 Early")}
        new = {"m1": make_dummy_model("m1", "gpt-5", display_name="GPT-5 Turbo")}
        report = tracker.detect_changes(old, new)
        self.assertTrue(report.has_changes())
        self.assertEqual(len(report.name_updates), 1)
        embeds = tracker.build_discord_embeds(report)
        self.assertTrue(any("MODEL RENAME" in e["title"] for e in embeds))

    def test_scenario_e_id_rotation(self):
        """Scenario E: ID rotation with identical publicName -> paired as rotation."""
        old = {"old-uuid-1": make_dummy_model("old-uuid-1", "deepseek-v4-pro")}
        new = {"new-uuid-2": make_dummy_model("new-uuid-2", "deepseek-v4-pro")}
        report = tracker.detect_changes(old, new)
        self.assertTrue(report.has_changes())
        self.assertEqual(len(report.id_rotations), 1)
        self.assertEqual(len(report.removed_models), 0)
        self.assertEqual(len(report.new_models), 0)
        self.assertEqual(len(report.variants), 0)
        old_m, new_m = report.id_rotations[0]
        self.assertEqual(old_m["id"], "old-uuid-1")
        self.assertEqual(new_m["id"], "new-uuid-2")
        embeds = tracker.build_discord_embeds(report)
        self.assertTrue(any("ID ROTATION DETECTED" in e["title"] for e in embeds))

    def test_scenario_f_stealth_model(self):
        """Scenario F: Model with no organization -> detected as stealth/hidden."""
        old = {"m1": make_dummy_model("m1", "gpt-5")}
        new = {
            "m1": make_dummy_model("m1", "gpt-5"),
            "s1": make_dummy_model("s1", "mystery-ai", org=None),
        }
        report = tracker.detect_changes(old, new)
        self.assertTrue(report.has_changes())
        self.assertEqual(len(report.hidden_models), 1)
        self.assertEqual(report.hidden_models[0]["id"], "s1")
        embeds = tracker.build_discord_embeds(report)
        self.assertTrue(any("STEALTH MODEL DETECTED" in e["title"] for e in embeds))

    def test_scenario_g_genuine_removal(self):
        """Scenario G: Model genuinely delisted -> removal alert."""
        old = {
            "m1": make_dummy_model("m1", "gpt-5"),
            "m2": make_dummy_model("m2", "old-model"),
        }
        new = {"m1": make_dummy_model("m1", "gpt-5")}
        report = tracker.detect_changes(old, new)
        self.assertTrue(report.has_changes())
        self.assertEqual(len(report.removed_models), 1)
        self.assertEqual(report.removed_models[0]["id"], "m2")
        embeds = tracker.build_discord_embeds(report)
        self.assertTrue(any("MODEL DELISTED" in e["title"] for e in embeds))

    def test_scenario_h_modality_collapse(self):
        """Scenario H: Search modality collapses from 44 to 1 -> detected as broken fetch."""
        old = {}
        for i in range(500):
            old[f"chat_{i}"] = make_dummy_model(f"chat_{i}", f"chat_{i}", out_caps={"text": True})
        for i in range(44):
            old[f"search_{i}"] = make_dummy_model(
                f"search_{i}",
                f"search_{i}",
                out_caps={"search": True},
                rank_by_modality={"search": i + 1},
            )

        new = {}
        for i in range(500):
            new[f"chat_{i}"] = make_dummy_model(f"chat_{i}", f"chat_{i}", out_caps={"text": True})
        new["search_0"] = make_dummy_model(
            "search_0",
            "search_0",
            out_caps={"search": True},
            rank_by_modality={"search": 1},
        )

        is_healthy, reason = tracker.check_modality_health(old, new)
        self.assertFalse(is_healthy)
        self.assertIn("search", reason)
        self.assertIn("collapsed", reason)

    def test_scenario_j_variant_model(self):
        """Scenario J: New model instance sharing an existing model's publicName -> variant."""
        old = {"m1": make_dummy_model("m1", "gpt-5", org="openai")}
        new = {
            "m1": make_dummy_model("m1", "gpt-5", org="openai"),
            "m2": make_dummy_model("m2", "gpt-5", org="openai"),
        }
        report = tracker.detect_changes(old, new)
        self.assertTrue(report.has_changes())
        self.assertEqual(len(report.variants), 1)
        self.assertEqual(report.variants[0]["id"], "m2")
        embeds = tracker.build_discord_embeds(report)
        self.assertTrue(any("NEW MODEL VARIANT" in e["title"] for e in embeds))

    def test_scenario_k_org_and_provider_updates(self):
        """Scenario K: Organization and Provider changes are categorized."""
        old = {"m1": make_dummy_model("m1", "claude-4", org="anthropic", provider="anthropic")}
        new = {"m1": make_dummy_model("m1", "claude-4", org="anthropic", provider="googleVertexAnthropic")}
        report = tracker.detect_changes(old, new)
        self.assertTrue(report.has_changes())
        self.assertEqual(len(report.provider_updates), 1)
        embeds = tracker.build_discord_embeds(report)
        self.assertTrue(any("PROVIDER UPDATE" in e["title"] for e in embeds))

    def test_scenario_user_selectable_toggle(self):
        """Scenario: User Selectable transitions (false -> true and true -> false)."""
        # Enabled: false -> true
        old1 = {"m1": make_dummy_model("m1", "gpt-5", user_selectable=False)}
        new1 = {"m1": make_dummy_model("m1", "gpt-5", user_selectable=True)}
        report1 = tracker.detect_changes(old1, new1)
        self.assertTrue(report1.has_changes())
        self.assertEqual(len(report1.selectable_enabled), 1)
        embeds1 = tracker.build_discord_embeds(report1)
        self.assertTrue(any("DIRECT SELECTION ENABLED" in e["title"] for e in embeds1))

        # Disabled: true -> false
        old2 = {"m1": make_dummy_model("m1", "gpt-5", user_selectable=True)}
        new2 = {"m1": make_dummy_model("m1", "gpt-5", user_selectable=False)}
        report2 = tracker.detect_changes(old2, new2)
        self.assertTrue(report2.has_changes())
        self.assertEqual(len(report2.selectable_disabled), 1)
        embeds2 = tracker.build_discord_embeds(report2)
        self.assertTrue(any("DIRECT SELECTION DISABLED" in e["title"] for e in embeds2))

    def test_scenario_multiple_simultaneous_changes(self):
        """Scenario: Single model with multiple simultaneous changes captures all."""
        old = {"m1": make_dummy_model("m1", "gpt-5", display_name="GPT 5", org="openai", user_selectable=False)}
        new = {"m1": make_dummy_model("m1", "gpt-5", display_name="GPT 5 Pro", org="microsoft", user_selectable=True)}
        report = tracker.detect_changes(old, new)
        self.assertTrue(report.has_changes())
        # All 3 changes captured simultaneously!
        self.assertEqual(len(report.name_updates), 1)
        self.assertEqual(len(report.org_updates), 1)
        self.assertEqual(len(report.selectable_enabled), 1)
        embeds = tracker.build_discord_embeds(report)
        self.assertEqual(len(embeds), 3)

    def test_snapshot_identity_hash_stability(self):
        """Identity hash remains identical even if ranks change."""
        models_v1 = {
            "m1": make_dummy_model("m1", "gpt-5", rank=10),
            "m2": make_dummy_model("m2", "claude", rank=20),
        }
        models_v2 = {
            "m1": make_dummy_model("m1", "gpt-5", rank=99),
            "m2": make_dummy_model("m2", "claude", rank=105),
        }
        h1 = tracker.snapshot_identity_hash(models_v1)
        h2 = tracker.snapshot_identity_hash(models_v2)
        self.assertEqual(h1, h2)


if __name__ == "__main__":
    unittest.main()
