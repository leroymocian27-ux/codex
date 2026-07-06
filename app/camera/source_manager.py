from __future__ import annotations

import threading
from dataclasses import dataclass

from app.camera.capture_worker import CaptureWorker, CaptureWorkerStatus
from app.camera.frame_buffer import FrameBuffer
from app.camera.source_models import CameraSourceConfig, is_local_file_source
from app.camera.subprocess_capture_worker import SubprocessCaptureWorker
from app.core.config import Settings


@dataclass
class CameraRuntime:
    config: CameraSourceConfig
    frame_buffer: FrameBuffer
    worker: CaptureWorker | SubprocessCaptureWorker


class CameraSourceManager:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._runtimes: dict[str, CameraRuntime] = {}
        self._lock = threading.Lock()

    def start_source(self, config: CameraSourceConfig) -> tuple[CameraRuntime, bool]:
        with self._lock:
            existing = self._runtimes.get(config.camera_id)
            if existing:
                if not existing.worker.status().running:
                    self._runtimes.pop(config.camera_id, None)
                    try:
                        existing.worker.stop()
                    except Exception:
                        pass
                    existing = None
            if existing:
                if existing.config.source_url != config.source_url:
                    raise ValueError(
                        f"camera {config.camera_id} is already running with another source"
                    )
                return existing, False
            buffer = FrameBuffer(config.camera_id)
            worker = self._create_worker(config, buffer)
            runtime = CameraRuntime(config=config, frame_buffer=buffer, worker=worker)
            self._runtimes[config.camera_id] = runtime
            worker.start()
            return runtime, True

    def stop_source(self, camera_id: str) -> bool:
        with self._lock:
            runtime = self._runtimes.pop(camera_id, None)
        if not runtime:
            return False
        runtime.worker.stop()
        return True

    def get_runtime(self, camera_id: str) -> CameraRuntime | None:
        with self._lock:
            return self._runtimes.get(camera_id)

    def get_buffer(self, camera_id: str) -> FrameBuffer | None:
        runtime = self.get_runtime(camera_id)
        return runtime.frame_buffer if runtime else None

    def get_main_buffer(self, camera_id: str) -> FrameBuffer | None:
        return self.get_buffer(camera_id)

    def get_analysis_buffer(self, camera_id: str) -> FrameBuffer | None:
        return self.get_buffer(camera_id)

    def display_state(self, camera_id: str) -> tuple[str, bool]:
        runtime = self.get_runtime(camera_id)
        if runtime is None:
            return "none", False
        return "single", False

    def list_runtimes(self) -> list[CameraRuntime]:
        with self._lock:
            return list(self._runtimes.values())

    def worker_status(self, camera_id: str) -> CaptureWorkerStatus | None:
        runtime = self.get_runtime(camera_id)
        return runtime.worker.status() if runtime else None

    def stop_all(self) -> None:
        for runtime in self.list_runtimes():
            runtime.worker.stop()
        with self._lock:
            self._runtimes.clear()

    def _create_worker(
        self,
        config: CameraSourceConfig,
        buffer: FrameBuffer,
    ) -> CaptureWorker | SubprocessCaptureWorker:
        if is_local_file_source(config.source_url):
            return CaptureWorker(config, buffer, self.settings)
        if (
            self.settings.capture_backend in {"subprocess_opencv", "subprocess_pyav"}
            and not config.source_url.startswith("mock://")
        ):
            return SubprocessCaptureWorker(config, buffer, self.settings)
        return CaptureWorker(config, buffer, self.settings)
