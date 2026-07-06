from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


def _load_env_file() -> None:
    explicit_path = os.getenv("VISION_SERVICE_ENV_FILE")
    candidates: list[Path] = []
    if explicit_path:
        candidates.append(Path(explicit_path))
    candidates.append(Path(__file__).resolve().parents[2] / ".env")

    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved in seen or not resolved.exists():
            continue
        seen.add(resolved)
        for raw_line in resolved.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            os.environ[key] = value


_load_env_file()


def _get_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _get_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    return int(raw)


def _get_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    return float(raw)


@dataclass(frozen=True)
class Settings:
    app_name: str = os.getenv("APP_NAME", "vision-service")
    log_level: str = os.getenv("LOG_LEVEL", "INFO")
    runtime_profile: str = os.getenv("VISION_SERVICE_RUNTIME_PROFILE", "default")

    default_camera_id: str = os.getenv("DEFAULT_CAMERA_ID", "camera_01")
    default_rtsp_url: str | None = os.getenv("DEFAULT_RTSP_URL") or None
    mock_camera_enabled: bool = _get_bool("MOCK_CAMERA_ENABLED", True)
    mock_camera_width: int = _get_int("MOCK_CAMERA_WIDTH", 1280)
    mock_camera_height: int = _get_int("MOCK_CAMERA_HEIGHT", 720)
    mock_camera_fps: int = _get_int("MOCK_CAMERA_FPS", 25)

    capture_stale_timeout_sec: float = _get_float("CAPTURE_STALE_TIMEOUT_SEC", 3.0)
    stream_stale_threshold_ms: int = _get_int("STREAM_STALE_THRESHOLD_MS", 3000)
    stream_stale_reconnect_after_ms: int = _get_int("STREAM_STALE_RECONNECT_AFTER_MS", 6000)
    capture_read_warn_ms: int = _get_int("CAPTURE_READ_WARN_MS", 500)
    capture_read_stale_ms: int = _get_int("CAPTURE_READ_STALE_MS", 3000)
    capture_force_reopen_after_slow_reads: int = _get_int("CAPTURE_FORCE_REOPEN_AFTER_SLOW_READS", 3)
    capture_read_watchdog_release_enabled: bool = _get_bool("CAPTURE_READ_WATCHDOG_RELEASE_ENABLED", False)
    capture_backend: str = os.getenv("CAPTURE_BACKEND", "opencv")
    capture_process_frame_timeout_ms: int = _get_int("CAPTURE_PROCESS_FRAME_TIMEOUT_MS", 2000)
    capture_process_open_timeout_ms: int = _get_int("CAPTURE_PROCESS_OPEN_TIMEOUT_MS", 5000)
    capture_process_read_timeout_ms: int = _get_int("CAPTURE_PROCESS_READ_TIMEOUT_MS", 5000)
    capture_process_restart_ms: int = _get_int("CAPTURE_PROCESS_RESTART_MS", 500)
    capture_ipc_mode: str = os.getenv("CAPTURE_IPC_MODE", "jpeg_pipe")
    capture_jpeg_quality: int = _get_int("CAPTURE_JPEG_QUALITY", 60)
    capture_process_output_height: int = _get_int("CAPTURE_PROCESS_OUTPUT_HEIGHT", 720)
    capture_process_write_fps: float = _get_float("CAPTURE_PROCESS_WRITE_FPS", 10.0)
    capture_process_max_restarts: int = _get_int("CAPTURE_PROCESS_MAX_RESTARTS", 0)
    opencv_capture_buffersize: int = _get_int("OPENCV_CAPTURE_BUFFERSIZE", 1)
    opencv_ffmpeg_capture_options: str = os.getenv("OPENCV_FFMPEG_CAPTURE_OPTIONS", "")
    reconnect_initial_delay_sec: float = _get_float("RECONNECT_INITIAL_DELAY_SEC", 1.0)
    reconnect_max_delay_sec: float = _get_float("RECONNECT_MAX_DELAY_SEC", 10.0)

    detection_enabled: bool = _get_bool("DETECTION_ENABLED", True)
    yolo_model_path: str = os.getenv("YOLO_MODEL_PATH", "yolov8n.pt")
    yolo_confidence: float = _get_float("YOLO_CONFIDENCE", 0.35)
    yolo_imgsz: int = _get_int("YOLO_IMGSZ", 640)
    yolo_device: str | None = os.getenv("YOLO_DEVICE") or None
    detection_interval_ms: int = _get_int("DETECTION_INTERVAL_MS", 100)
    fall_detector_enabled: bool = _get_bool("FALL_DETECTOR_ENABLED", True)
    yolo_fall_model_path: str = os.getenv(
        "YOLO_FALL_MODEL_PATH",
        "models/yolo_fall_hint_v2_plus_b012_best.pt",
    )
    yolo_fall_confidence: float = _get_float("YOLO_FALL_CONFIDENCE", 0.25)
    yolo_fall_imgsz: int = _get_int("YOLO_FALL_IMGSZ", 640)
    yolo_fall_device: str | None = os.getenv("YOLO_FALL_DEVICE") or None
    fall_detector_interval_ms: int = _get_int("FALL_DETECTOR_INTERVAL_MS", 200)

    enable_tracking: bool = _get_bool("ENABLE_TRACKING", True)
    enable_identity: bool = _get_bool("ENABLE_IDENTITY", False)
    enable_target_binding: bool = _get_bool("ENABLE_TARGET_BINDING", False)
    identity_store_dir: str = os.getenv("IDENTITY_STORE_DIR", "data/identities")
    identity_max_images: int = _get_int("IDENTITY_MAX_IMAGES", 5)
    insightface_model_name: str = os.getenv("INSIGHTFACE_MODEL_NAME", "buffalo_l")
    insightface_ctx_id: int = _get_int("INSIGHTFACE_CTX_ID", 0)
    insightface_det_size: int = _get_int("INSIGHTFACE_DET_SIZE", 640)
    insightface_providers: str | None = os.getenv("INSIGHTFACE_PROVIDERS") or None
    identity_service_url: str = os.getenv("IDENTITY_SERVICE_URL", "http://127.0.0.1:8100")
    enable_identity_binding: bool = _get_bool("ENABLE_IDENTITY_BINDING", False)
    identity_request_timeout_ms: int = _get_int("IDENTITY_REQUEST_TIMEOUT_MS", 500)
    identity_match_interval_ms: int = _get_int("IDENTITY_MATCH_INTERVAL_MS", 1000)
    identity_match_threshold: float = _get_float("IDENTITY_MATCH_THRESHOLD", 0.45)
    identity_crop_padding_ratio: float = _get_float("IDENTITY_CROP_PADDING_RATIO", 0.12)
    identity_binding_async: bool = _get_bool("IDENTITY_BINDING_ASYNC", True)
    identity_health_ttl_ms: int = _get_int("IDENTITY_HEALTH_TTL_MS", 5000)
    identity_match_ttl_ms: int = _get_int("IDENTITY_MATCH_TTL_MS", 1000)
    identity_binding_worker_fps: float = _get_float("IDENTITY_BINDING_WORKER_FPS", 1.0)
    identity_max_inflight: int = _get_int("IDENTITY_MAX_INFLIGHT", 1)
    target_lost_after_ms: int = _get_int("TARGET_LOST_AFTER_MS", 1000)
    target_reacquire_after_ms: int = _get_int("TARGET_REACQUIRE_AFTER_MS", 3000)
    bytetrack_track_high_thresh: float = _get_float("BYTETRACK_TRACK_HIGH_THRESH", 0.5)
    bytetrack_track_low_thresh: float = _get_float("BYTETRACK_TRACK_LOW_THRESH", 0.1)
    bytetrack_new_track_thresh: float = _get_float("BYTETRACK_NEW_TRACK_THRESH", 0.6)
    bytetrack_match_thresh: float = _get_float("BYTETRACK_MATCH_THRESH", 0.8)
    bytetrack_track_buffer: int = _get_int("BYTETRACK_TRACK_BUFFER", 30)
    bytetrack_frame_rate: int = _get_int("BYTETRACK_FRAME_RATE", 10)
    bytetrack_fuse_score: bool = _get_bool("BYTETRACK_FUSE_SCORE", True)

    enable_pose: bool = _get_bool("ENABLE_POSE", False)
    pose_provider: str = os.getenv("POSE_PROVIDER", "disabled_placeholder")
    pose_fps: float = _get_float("POSE_FPS", 3.0)
    yolo_pose_model_path: str = os.getenv("YOLO_POSE_MODEL_PATH", "yolov8n-pose.pt")
    yolo_pose_confidence: float = _get_float("YOLO_POSE_CONFIDENCE", 0.25)
    yolo_pose_imgsz: int = _get_int("YOLO_POSE_IMGSZ", 640)
    yolo_pose_device: str | None = os.getenv("YOLO_POSE_DEVICE") or None
    yolo11_pose_model_path: str = os.getenv("YOLO11_POSE_MODEL_PATH", "yolo11n-pose.pt")
    yolo11_pose_confidence: float = _get_float("YOLO11_POSE_CONF", 0.12)
    yolo11_pose_imgsz: int = _get_int("YOLO11_POSE_IMGSZ", 640)
    yolo11_pose_device: str | None = os.getenv("YOLO11_POSE_DEVICE") or os.getenv("YOLO_POSE_DEVICE") or None
    yolo11_pose_half: bool = _get_bool("YOLO11_POSE_HALF", True)
    yolo11_pose_smoothing: bool = _get_bool("YOLO11_POSE_SMOOTHING", True)
    yolo11_pose_max_jump_ratio: float = _get_float("YOLO11_POSE_MAX_JUMP_RATIO", 0.18)
    yolo11_pose_min_match_iou: float = _get_float("YOLO11_POSE_MIN_MATCH_IOU", 0.12)
    yolo11_pose_max_center_distance_ratio: float = _get_float("YOLO11_POSE_MAX_CENTER_DISTANCE_RATIO", 0.65)
    yolo11_pose_match_score_threshold: float = _get_float("YOLO11_POSE_MATCH_SCORE_THRESHOLD", 0.30)
    branch4_pose_confidence: float = _get_float("BRANCH4_POSE_CONF", 0.2)
    branch4_pose_imgsz: int = _get_int("BRANCH4_POSE_IMGSZ", 640)
    branch4_pose_half: bool = _get_bool("BRANCH4_POSE_HALF", True)
    branch4_pose_crop_padding_ratio: float = _get_float("BRANCH4_POSE_CROP_PADDING_RATIO", 0.18)
    rtmpose_config_path: str = os.getenv(
        "RTMPOSE_CONFIG_PATH",
        "models/rtmpose/rtmpose-l_8xb256-420e_coco-384x288.py",
    )
    rtmpose_checkpoint_path: str = os.getenv(
        "RTMPOSE_CHECKPOINT_PATH",
        "models/rtmpose/rtmpose-l_simcc-coco_pt-aic-coco_420e-384x288-9ec0a4e5_20230127.pth",
    )
    rtmpose_device: str | None = os.getenv("RTMPOSE_DEVICE") or None
    rtmpose_bbox_thr: float = _get_float("RTMPOSE_BBOX_THR", 0.2)
    rtmpose_onnx_model_path: str = os.getenv(
        "RTMPOSE_ONNX_MODEL_PATH",
        "models/rtmpose/rtmpose-x-body7-384x288.onnx",
    )
    rtmpose_onnx_input_width: int = _get_int("RTMPOSE_ONNX_INPUT_WIDTH", 288)
    rtmpose_onnx_input_height: int = _get_int("RTMPOSE_ONNX_INPUT_HEIGHT", 384)
    pose_crop_padding_ratio: float = _get_float("POSE_CROP_PADDING_RATIO", 0.06)
    pose_fallen_crop_padding_ratio: float = _get_float("POSE_FALLEN_CROP_PADDING_RATIO", 0.14)
    pose_min_skeleton_confidence: float = _get_float("POSE_MIN_SKELETON_CONFIDENCE", 0.35)
    pose_min_keypoint_inside_ratio: float = _get_float("POSE_MIN_KEYPOINT_INSIDE_RATIO", 0.65)
    pose_min_fallen_keypoint_inside_ratio: float = _get_float("POSE_MIN_FALLEN_KEYPOINT_INSIDE_RATIO", 0.60)
    pose_min_candidate_iou: float = _get_float("POSE_MIN_CANDIDATE_IOU", 0.25)
    pose_min_fallen_candidate_iou: float = _get_float("POSE_MIN_FALLEN_CANDIDATE_IOU", 0.15)
    pose_max_tracking_frame_delta: int = _get_int("POSE_MAX_TRACKING_FRAME_DELTA", 2)
    pose_max_frame_age_ms: int = _get_int("POSE_MAX_FRAME_AGE_MS", 800)
    pose_skip_when_inference_busy: bool = _get_bool("POSE_SKIP_WHEN_INFERENCE_BUSY", True)
    pose_inference_lock_wait_ms: int = _get_int("POSE_INFERENCE_LOCK_WAIT_MS", 160)
    pose_max_inference_ms: int = _get_int("POSE_MAX_INFERENCE_MS", 1500)
    pose_slow_inference_circuit_breaker_count: int = _get_int("POSE_SLOW_INFERENCE_CIRCUIT_BREAKER_COUNT", 3)
    pose_circuit_breaker_cooldown_ms: int = _get_int("POSE_CIRCUIT_BREAKER_COOLDOWN_MS", 10000)
    pose_fallback_to_detection: bool = _get_bool("POSE_FALLBACK_TO_DETECTION", False)
    pose_fallback_min_confidence: float = _get_float("POSE_FALLBACK_MIN_CONFIDENCE", 0.5)

    enable_behavior: bool = _get_bool("ENABLE_BEHAVIOR", False)
    behavior_rapid_descent_px_per_sec: float = _get_float("BEHAVIOR_RAPID_DESCENT_PX_PER_SEC", 260.0)
    behavior_long_still_sec: float = _get_float("BEHAVIOR_LONG_STILL_SEC", 5.0)
    behavior_still_velocity_px_per_sec: float = _get_float("BEHAVIOR_STILL_VELOCITY_PX_PER_SEC", 18.0)

    tracking_worker_fps: float = _get_float("TRACKING_WORKER_FPS", 20.0)
    pose_worker_fps: float = _get_float("POSE_WORKER_FPS", 3.0)
    result_publish_fps: float = _get_float("RESULT_PUBLISH_FPS", 20.0)
    pose_result_ttl_ms: int = _get_int("POSE_RESULT_TTL_MS", 800)
    pose_publish_max_frame_delta: int = _get_int("POSE_PUBLISH_MAX_FRAME_DELTA", 8)
    behavior_result_ttl_ms: int = _get_int("BEHAVIOR_RESULT_TTL_MS", 1500)

    enable_temporal: bool = _get_bool("ENABLE_TEMPORAL", False)
    feature_window_size: int = _get_int("FEATURE_WINDOW_SIZE", 32)
    temporal_no_object_reset_frames: int = _get_int("TEMPORAL_NO_OBJECT_RESET_FRAMES", 3)
    temporal_track_mode: str = os.getenv("TEMPORAL_TRACK_MODE", "all_tracks")
    temporal_sequence_key_mode: str = os.getenv("TEMPORAL_SEQUENCE_KEY_MODE", "identity")
    temporal_model_provider: str = os.getenv("TEMPORAL_MODEL_PROVIDER", "mock")
    temporal_onnx_model_path: str = os.getenv("TEMPORAL_ONNX_MODEL_PATH", "models/fall_lstm_v5.onnx")
    temporal_feature_schema_path: str = os.getenv(
        "TEMPORAL_FEATURE_SCHEMA_PATH",
        "models/fall_lstm_v5_features.json",
    )
    temporal_model_window_size: int = _get_int("TEMPORAL_MODEL_WINDOW_SIZE", 32)
    temporal_model_input_dim: int = _get_int("TEMPORAL_MODEL_INPUT_DIM", 15)
    temporal_warmup_min_size: int = _get_int("TEMPORAL_WARMUP_MIN_SIZE", 16)
    temporal_fallback_to_mock: bool = _get_bool("TEMPORAL_FALLBACK_TO_MOCK", True)
    temporal_onnx_providers: str = os.getenv(
        "TEMPORAL_ONNX_PROVIDERS",
        "CUDAExecutionProvider,CPUExecutionProvider",
    )
    unstable_frame_threshold: int = _get_int("UNSTABLE_FRAME_THRESHOLD", 3)
    falling_prob_threshold: float = _get_float("FALLING_PROB_THRESHOLD", 0.65)
    low_confidence_fallen_candidate_enabled: bool = _get_bool("LOW_CONFIDENCE_FALLEN_CANDIDATE_ENABLED", True)
    low_confidence_fallen_candidate_max_confidence: float = _get_float("LOW_CONFIDENCE_FALLEN_CANDIDATE_MAX_CONFIDENCE", 0.35)
    low_confidence_fallen_candidate_min_probability: float = _get_float("LOW_CONFIDENCE_FALLEN_CANDIDATE_MIN_PROBABILITY", 0.35)
    low_confidence_fallen_candidate_min_window: int = _get_int("LOW_CONFIDENCE_FALLEN_CANDIDATE_MIN_WINDOW", 8)
    fall_detector_promote_unmatched: bool = _get_bool("FALL_DETECTOR_PROMOTE_UNMATCHED", True)
    fall_detector_promote_min_confidence: float = _get_float("FALL_DETECTOR_PROMOTE_MIN_CONFIDENCE", 0.12)
    fall_detector_confirm_enabled: bool = _get_bool("FALL_DETECTOR_CONFIRM_ENABLED", True)
    fall_detector_confirm_min_probability: float = _get_float("FALL_DETECTOR_CONFIRM_MIN_PROBABILITY", 0.32)
    fall_detector_confirm_min_person_confidence: float = _get_float("FALL_DETECTOR_CONFIRM_MIN_PERSON_CONFIDENCE", 0.2)
    fall_detector_confirm_frames: int = _get_int("FALL_DETECTOR_CONFIRM_FRAMES", 4)
    fall_detector_confirm_ms: int = _get_int("FALL_DETECTOR_CONFIRM_MS", 900)
    field_fall_candidate_enabled: bool = _get_bool("FIELD_FALL_CANDIDATE_ENABLED", True)
    field_fall_candidate_requires_recent_fall_hint: bool = _get_bool("FIELD_FALL_CANDIDATE_REQUIRES_RECENT_FALL_HINT", True)
    field_fall_candidate_recent_hint_ms: int = _get_int("FIELD_FALL_CANDIDATE_RECENT_HINT_MS", 15000)
    field_fall_candidate_min_aspect: float = _get_float("FIELD_FALL_CANDIDATE_MIN_ASPECT", 0.8)
    field_fall_candidate_min_center_y_norm: float = _get_float("FIELD_FALL_CANDIDATE_MIN_CENTER_Y_NORM", 0.48)
    field_fall_candidate_max_height_norm: float = _get_float("FIELD_FALL_CANDIDATE_MAX_HEIGHT_NORM", 0.42)
    field_fall_candidate_max_speed: float = _get_float("FIELD_FALL_CANDIDATE_MAX_SPEED", 38.0)
    field_fall_candidate_min_window: int = _get_int("FIELD_FALL_CANDIDATE_MIN_WINDOW", 16)
    field_fall_candidate_confirm_frames: int = _get_int("FIELD_FALL_CANDIDATE_CONFIRM_FRAMES", 6)
    field_fall_candidate_confirm_ms: int = _get_int("FIELD_FALL_CANDIDATE_CONFIRM_MS", 1200)
    fall_confirm_frames: int = _get_int("FALL_CONFIRM_FRAMES", 5)
    fall_still_ms: int = _get_int("FALL_STILL_MS", 1500)
    cooldown_seconds: float = _get_float("COOLDOWN_SECONDS", 10.0)
    fall_v6_scoring_enabled: bool = _get_bool("FALL_V6_SCORING_ENABLED", True)
    fall_v6_decision_enabled: bool = _get_bool("FALL_V6_DECISION_ENABLED", False)
    fall_v6_debug_payload: bool = _get_bool("FALL_V6_DEBUG_PAYLOAD", True)
    fall_evidence_confirm_threshold: float = _get_float("FALL_EVIDENCE_CONFIRM_THRESHOLD", 0.75)
    adl_suppression_confirm_max: float = _get_float("ADL_SUPPRESSION_CONFIRM_MAX", 0.45)
    adl_suppression_slow_max: float = _get_float("ADL_SUPPRESSION_SLOW_MAX", 0.55)
    adl_suppression_block_threshold: float = _get_float("ADL_SUPPRESSION_BLOCK_THRESHOLD", 0.65)
    track_quality_min_confirm: float = _get_float("TRACK_QUALITY_MIN_CONFIRM", 0.70)
    slow_fall_enabled: bool = _get_bool("SLOW_FALL_ENABLED", True)
    slow_fall_hold_ms: int = _get_int("SLOW_FALL_HOLD_MS", 5000)
    slow_fall_floor_contact_min: float = _get_float("SLOW_FALL_FLOOR_CONTACT_MIN", 0.60)
    slow_fall_support_surface_max: float = _get_float("SLOW_FALL_SUPPORT_SURFACE_MAX", 0.40)
    recovery_cancel_threshold: float = _get_float("RECOVERY_CANCEL_THRESHOLD", 0.60)
    uncertain_track_quality_min: float = _get_float("UNCERTAIN_TRACK_QUALITY_MIN", 0.50)

    webrtc_stun_server: str = os.getenv(
        "WEBRTC_STUN_SERVER",
        "stun:stun.l.google.com:19302",
    )
    webrtc_video_fps: int = _get_int("WEBRTC_VIDEO_FPS", 25)

    main_system_alert_enabled: bool = _get_bool("MAIN_SYSTEM_ALERT_ENABLED", False)
    main_system_report_dry_run: bool = _get_bool("MAIN_SYSTEM_REPORT_DRY_RUN", False)
    main_system_base_url: str = os.getenv("MAIN_SYSTEM_BASE_URL", "http://127.0.0.1:8090/api/v1")
    main_system_fall_event_path: str = os.getenv("MAIN_SYSTEM_FALL_EVENT_PATH", "/video-bridge/fall-events")
    main_system_alert_timeout_ms: int = _get_int("MAIN_SYSTEM_ALERT_TIMEOUT_MS", 10000)
    main_system_alert_cooldown_seconds: float = _get_float("MAIN_SYSTEM_ALERT_COOLDOWN_SECONDS", 90.0)
    main_system_alert_token: str = os.getenv("MAIN_SYSTEM_ALERT_TOKEN", "")
    main_system_alert_token_header: str = os.getenv("MAIN_SYSTEM_ALERT_TOKEN_HEADER", "X-Vision-Service-Token")
    main_system_default_port: int = _get_int("MAIN_SYSTEM_DEFAULT_PORT", 8000)
    main_system_base_prefix: str = os.getenv("MAIN_SYSTEM_BASE_PREFIX", "/api/v1")
    vision_service_public_base_url: str = os.getenv("VISION_SERVICE_PUBLIC_BASE_URL", "http://127.0.0.1:8000")
    fall_event_snapshot_dir: str = os.getenv("FALL_EVENT_SNAPSHOT_DIR", "logs/fall_events/snapshots")


@lru_cache
def get_settings() -> Settings:
    return Settings()
