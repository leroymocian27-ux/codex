from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np


@dataclass(frozen=True)
class FramePacket:
    camera_id: str
    seq: int
    captured_at: float
    frame: np.ndarray

    @property
    def width(self) -> int:
        return int(self.frame.shape[1])

    @property
    def height(self) -> int:
        return int(self.frame.shape[0])

    @property
    def age_ms(self) -> float:
        return round((time.monotonic() - self.captured_at) * 1000, 2)

    @property
    def captured_at_iso(self) -> str:
        wall_clock = time.time() - (time.monotonic() - self.captured_at)
        return datetime.fromtimestamp(wall_clock, timezone.utc).isoformat(timespec="milliseconds")


class FrameBuffer:
    """Non-consuming latest-frame cache shared by video and detection paths."""

    def __init__(self, camera_id: str) -> None:
        self.camera_id = camera_id
        self._lock = threading.Lock()
        self._packet: FramePacket | None = None
        self._seq = 0

    def update(self, frame: np.ndarray) -> FramePacket:
        with self._lock:
            self._seq += 1
            packet = FramePacket(
                camera_id=self.camera_id,
                seq=self._seq,
                captured_at=time.monotonic(),
                frame=frame,
            )
            self._packet = packet
            return packet

    def latest(self) -> FramePacket | None:
        with self._lock:
            return self._packet
