from __future__ import annotations

import unittest
from dataclasses import replace

from app.core.config import Settings
from app.schemas.vision_result import DetectedObject
from app.services.temporal_service import TemporalService


class TemporalServiceTest(unittest.TestCase):
    def test_disabled_pose_runtime_produces_bbox_only_temporal_features(self) -> None:
        settings = replace(
            Settings(),
            enable_temporal=True,
            enable_pose=False,
            pose_provider="disabled_placeholder",
            temporal_track_mode="all_tracks",
            temporal_sequence_key_mode="identity",
        )
        service = TemporalService(settings)
        obj = DetectedObject(
            label="person",
            confidence=0.95,
            bbox=[100.0, 100.0, 260.0, 340.0],
            track_id=1,
            is_target=True,
            pose={
                "pose_provider": "disabled_placeholder",
                "keypoints": [],
                "debug": {"pose_disabled": True},
            },
        )

        enriched = service.enrich("camera_01", [obj])

        temporal = enriched[0].temporal or {}
        features = temporal.get("features") or {}
        self.assertFalse(features["pose_available"])
        self.assertEqual(features["pose_confidence"], 0.0)
        self.assertIsNone(features["torso_angle"])
        self.assertIsNone(features["head_height_ratio"])
        self.assertIsNone(features["hip_height_ratio"])

    def test_objects_empty_resets_temporal_state_after_threshold(self) -> None:
        settings = replace(
            Settings(),
            enable_temporal=True,
            temporal_no_object_reset_frames=3,
            temporal_track_mode="all_tracks",
            temporal_sequence_key_mode="identity",
        )
        service = TemporalService(settings)
        obj = DetectedObject(
            label="person",
            confidence=0.95,
            bbox=[100.0, 100.0, 240.0, 340.0],
            track_id=1,
            is_target=True,
        )

        service.enrich("camera_01", [obj])
        self.assertEqual(service.status("camera_01").active_tracks, 1)

        service.enrich("camera_01", [])
        service.enrich("camera_01", [])
        service.enrich("camera_01", [])
        status = service.status("camera_01")

        self.assertEqual(status.active_tracks, 0)
        self.assertEqual(status.fall_state, "normal")
        self.assertEqual(status.no_object_reset_count, 1)
        self.assertEqual(status.last_reset_reason, "no_objects_reset_temporal")

    def test_v6_scoring_shadow_payload_does_not_take_over_decision(self) -> None:
        settings = replace(
            Settings(),
            enable_temporal=True,
            enable_pose=False,
            pose_provider="disabled_placeholder",
            temporal_model_provider="mock",
            temporal_track_mode="all_tracks",
            temporal_sequence_key_mode="identity",
            fall_v6_scoring_enabled=True,
            fall_v6_decision_enabled=False,
            fall_v6_debug_payload=True,
        )
        service = TemporalService(settings)
        obj = DetectedObject(
            label="person",
            confidence=0.95,
            bbox=[100.0, 100.0, 260.0, 340.0],
            track_id=1,
            is_target=True,
        )

        enriched = service.enrich("camera_01", [obj])

        temporal = enriched[0].temporal or {}
        decision = enriched[0].fall_decision or {}
        self.assertIn("fall_evidence_score", temporal)
        self.assertIn("adl_suppression_score", temporal)
        self.assertEqual(temporal["motion_path"], "legacy_shadow")
        self.assertEqual(decision["motion_path"], "legacy_shadow")
        self.assertEqual(decision["fall_state"], "normal")


if __name__ == "__main__":
    unittest.main()
