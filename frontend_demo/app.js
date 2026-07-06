const $ = (id) => document.getElementById(id);
const OVERLAY_POSE_CACHE_TTL_MS = 120;
const OVERLAY_POSE_CACHE_MAX_CENTER_SHIFT_RATIO = 0.18;
const OVERLAY_BBOX_CACHE_TTL_MS = 1000;
const OVERLAY_BBOX_FADE_START_MS = 500;
const OVERLAY_BBOX_SMOOTHING_ALPHA = 0.42;
const APP_POSE_STALE_THRESHOLD_MS = 500;
const RESULT_OVERLAY_TTL_MS = 1500;

const state = {
  pc: null,
  peerId: null,
  ws: null,
  lastResult: null,
  lastStatus: null,
  pendingResult: null,
  pendingIceCandidates: [],
  poseCache: new Map(),
  bboxCache: new Map(),
  lastTargetPoseCacheKey: null,
  connectSeq: 0,
  userConnected: false,
  connectedDisplaySource: null,
  lastDisplaySource: null,
  autoReconnect: {
    webrtcAttempts: 0,
    wsAttempts: 0,
    webrtcTimer: null,
    wsTimer: null,
    connecting: false,
  },
  videoFps: {
    lastAt: null,
    lastTotalFrames: null,
    lastDroppedFrames: null,
  },
  videoFrameCallbackActive: false,
  overlayFallbackTimer: null,
  overlayFps: {
    lastAt: null,
    lastFrames: 0,
  },
  userEditedRtspUrl: false,
  lastPlayError: null,
};
window.__VISION_APP_STATE__ = state;

const debugState = window.__VISION_DEBUG__ || {
  overlayMode: new URLSearchParams(window.location.search).get("overlayMode") || "full",
  showRawJson: new URLSearchParams(window.location.search).get("rawJson") === "1",
  videoSamples: [],
  rtcSamples: [],
  wsSamples: [],
  statusSamples: [],
  errors: [],
  longTasks: [],
  counters: {
    wsMessages: 0,
    statusUpdates: 0,
    rawJsonUpdates: 0,
    webrtcReconnects: 0,
    wsReconnects: 0,
    displayFallbackSwitches: 0,
    overlayFramesDrawn: 0,
  },
};
window.__VISION_DEBUG__ = debugState;

debugState.setOverlayMode = (mode) => {
  debugState.overlayMode = mode;
  if (mode === "off") {
    clearOverlayCanvas();
  } else if (state.lastResult && !isResultExpired(state.lastResult)) {
    drawOverlay($("video"), state.lastResult);
  }
};
debugState.setRawJson = (enabled) => {
  debugState.showRawJson = Boolean(enabled);
  const box = $("statusBox");
  if (box && !debugState.showRawJson) {
    box.textContent = "Raw JSON hidden for debug";
  }
};
debugState.reset = () => {
  debugState.videoSamples = [];
  debugState.rtcSamples = [];
  debugState.wsSamples = [];
  debugState.statusSamples = [];
  debugState.errors = [];
  debugState.longTasks = [];
  debugState.counters = {
    wsMessages: 0,
    statusUpdates: 0,
    rawJsonUpdates: 0,
    webrtcReconnects: 0,
    wsReconnects: 0,
    displayFallbackSwitches: 0,
    overlayFramesDrawn: 0,
  };
  state.overlayFps.lastAt = null;
  state.overlayFps.lastFrames = 0;
  state.pendingResult = null;
  state.lastResult = null;
  state.poseCache.clear();
  state.bboxCache.clear();
  window.__VISION_OVERLAY_STATS__?.reset?.();
};
debugState.snapshot = () => ({
  overlayMode: debugState.overlayMode,
  showRawJson: debugState.showRawJson,
  counters: debugState.counters,
  video: summarizeVideo(debugState.videoSamples),
  rtc: summarizeRtc(debugState.rtcSamples),
  ws: summarizeSamples(debugState.wsSamples),
  status: summarizeSamples(debugState.statusSamples),
  overlay: window.__VISION_OVERLAY_STATS__?.snapshot?.() || null,
  latestVideo: debugState.videoSamples.at(-1) || null,
  latestRtc: debugState.rtcSamples.at(-1) || null,
  errors: debugState.errors.slice(-50),
  longTasks: debugState.longTasks.slice(-50),
  dom: readFreezeDomSnapshot(),
});

const FALL_STATE_LABELS = {
  normal: "正常",
  unstable: "姿态异常",
  falling: "疑似跌倒",
  fallen_candidate: "高风险倒地",
  fallen_confirmed: "倒地确认",
  cooldown: "冷却观察",
};

const RISK_LEVEL_LABELS = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  critical: "紧急风险",
  cooldown: "观察中",
};

const BEHAVIOR_LABELS = {
  standing: "站立",
  walking: "行走",
  sitting: "坐下",
  bending: "弯腰",
  lying: "躺卧",
  unknown: "未知",
};

const IDENTITY_STATE_LABELS = {
  unbound: "未绑定",
  identifying: "识别中",
  recognized: "已识别",
};

const TRACKING_STATE_LABELS = {
  idle: "空闲",
  target_locked: "已锁定",
  target_lost: "目标丢失",
  target_reacquiring: "重新寻找",
};

function apiBase() {
  if (window.location.protocol === "file:") {
    return "http://127.0.0.1:8000";
  }
  return window.location.origin;
}

function wsBase() {
  if (window.location.protocol === "file:") {
    return "ws://127.0.0.1:8000";
  }
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
}

const DEFAULT_MANUAL_ALERT_IP = "192.168.8.253";
const LEGACY_MANUAL_ALERT_IPS = new Set(["172.18.33.66", "192.168.8.254"]);
const MANUAL_ALERT_IP_STORAGE_KEY = "vision.manualAlertTargetIp";

function initializeManualAlertControls() {
  const input = $("manualAlertIp");
  const button = $("sendManualAlertBtn");
  if (!input || !button) {
    return;
  }
  const savedIp = window.localStorage?.getItem(MANUAL_ALERT_IP_STORAGE_KEY);
  if (savedIp && !LEGACY_MANUAL_ALERT_IPS.has(savedIp)) {
    input.value = savedIp;
  } else {
    input.value = DEFAULT_MANUAL_ALERT_IP;
    window.localStorage?.setItem(MANUAL_ALERT_IP_STORAGE_KEY, DEFAULT_MANUAL_ALERT_IP);
  }
  button.addEventListener("click", sendManualAlert);
}

async function sendManualAlert() {
  const input = $("manualAlertIp");
  const button = $("sendManualAlertBtn");
  const result = $("manualAlertResult");
  const targetIp = input?.value.trim() || "";
  if (!isLikelyIpv4(targetIp)) {
    setManualAlertResult("失败：请输入合法的 IPv4 地址，例如 192.168.8.254", "error");
    input?.focus();
    return;
  }
  if (button) {
    button.disabled = true;
  }
  setManualAlertResult(`发送中：${targetIp}`, "pending");
  try {
    const response = await fetch(`${apiBase()}/alerting/simulation/send-once`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_ip: targetIp,
        camera_id: $("cameraId")?.value.trim() || "camera_01",
        track_id: "manual-console-probe",
        fall_prob: 0.91,
      }),
    });
    const payload = await safeJson(response);
    if (response.ok && payload?.ok) {
      window.localStorage?.setItem(MANUAL_ALERT_IP_STORAGE_KEY, targetIp);
      const remoteBody = summarizeRemoteBody(payload.response_body);
      setManualAlertResult(
        `成功：HTTP ${payload.status_code}，${remoteBody}，发送时间 ${payload.sent_at}`,
        "success",
      );
      $("statusBox").textContent = JSON.stringify(payload, null, 2);
      return;
    }
    const message = payload?.error || payload?.response_body || payload?.detail || `HTTP ${response.status}`;
    setManualAlertResult(`失败：${message}`, "error");
    $("statusBox").textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    setManualAlertResult(`失败：${error}`, "error");
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

function isLikelyIpv4(value) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const numeric = Number(part);
    return numeric >= 0 && numeric <= 255;
  });
}

function setManualAlertResult(message, kind) {
  const result = $("manualAlertResult");
  if (!result) {
    return;
  }
  result.textContent = message;
  result.dataset.state = kind;
}

function summarizeRemoteBody(body) {
  if (!body) {
    return "远端无响应正文";
  }
  try {
    const parsed = JSON.parse(body);
    const flags = [];
    if (parsed.accepted !== undefined) {
      flags.push(`accepted=${parsed.accepted}`);
    }
    if (parsed.pushed !== undefined) {
      flags.push(`pushed=${parsed.pushed}`);
    }
    if (parsed.alarm_id) {
      flags.push(`alarm_id=${parsed.alarm_id}`);
    }
    return flags.length ? flags.join(" / ") : JSON.stringify(parsed).slice(0, 160);
  } catch (_) {
    return body.slice(0, 160);
  }
}

async function startStream() {
  return startStreamRequest({ updateUi: true });
}

async function startStreamRequest({ updateUi }) {
  const cameraId = $("cameraId").value.trim() || "camera_01";
  const rtspUrl = $("rtspUrl").value.trim() || null;
  const startBtn = $("startBtn");
  if (startBtn) {
    startBtn.disabled = true;
  }

  try {
    const response = await fetch(`${apiBase()}/stream/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        camera_id: cameraId,
        rtsp_url: rtspUrl,
        main_rtsp_url: rtspUrl,
        analysis_rtsp_url: rtspUrl,
      }),
    });
    const payload = await safeJson(response);
    if (updateUi) {
      $("statusBox").textContent = JSON.stringify(payload, null, 2);
    }
    if (!response.ok) {
      throw new Error(payload?.detail || payload?.message || `stream start failed: ${response.status}`);
    }
    state.userEditedRtspUrl = false;
    await refreshStatus();
    return payload;
  } catch (error) {
    if (updateUi) {
      $("statusBox").textContent = String(error);
    }
    throw error;
  } finally {
    if (startBtn) {
      startBtn.disabled = false;
    }
  }
}

async function connectWebRTC() {
  const cameraId = $("cameraId").value.trim() || "camera_01";
  state.userConnected = true;
  state.autoReconnect.connecting = true;
  clearReconnectTimer("webrtc");
  const connectSeq = ++state.connectSeq;
  closeConnections();
  stopOverlayLoop();
  $("connectBtn").disabled = true;
  $("webrtcState").textContent = "connecting";
  updatePeerDebugState();
  $("wsState").textContent = "idle";
  updateRecoveryBanner();

  try {
    await startStreamRequest({ updateUi: false });
  } catch (error) {
    $("webrtcState").textContent = "failed";
    $("statusBox").textContent = `stream start failed before WebRTC: ${error}`;
    state.autoReconnect.connecting = false;
    $("connectBtn").disabled = false;
    return;
  }

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  state.pc = pc;
  state.peerId = null;
  state.pendingIceCandidates = [];
  updatePeerDebugState();

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.onicecandidate = (event) => {
    if (state.pc !== pc || !event.candidate) {
      return;
    }
    const payload = {
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
    };
    if (!state.peerId) {
      state.pendingIceCandidates.push(payload);
      return;
    }
    void sendIceCandidate(state.peerId, payload);
  };
  pc.ontrack = (event) => {
    const video = $("video");
    const stream = event.streams?.[0] || new MediaStream([event.track]);
    video.srcObject = stream;
    state.lastPlayError = null;
    updatePeerDebugState();
    void video.play().then(() => {
      state.lastPlayError = null;
      updatePeerDebugState();
    }).catch((error) => {
      state.lastPlayError = String(error);
      $("statusBox").textContent = `video.play failed: ${error}`;
      updatePeerDebugState();
    });
    attachVideoFrameLoop();
  };
  pc.onconnectionstatechange = () => {
    if (state.pc === pc) {
      $("webrtcState").textContent = pc.connectionState;
      updatePeerDebugState();
      updateRecoveryBanner();
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        scheduleWebRTCReconnect(`webrtc ${pc.connectionState}`);
      } else if (pc.connectionState === "connected") {
        state.autoReconnect.webrtcAttempts = 0;
        state.connectedDisplaySource = state.lastDisplaySource
          || state.lastStatus?.display_source_current
          || state.lastStatus?.display_source
          || state.connectedDisplaySource;
        updateRecoveryBanner();
      }
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (state.pc === pc) {
      updatePeerDebugState();
    }
  };
  pc.onsignalingstatechange = () => {
    if (state.pc === pc) {
      updatePeerDebugState();
    }
  };
  pc.onicegatheringstatechange = () => {
    if (state.pc === pc) {
      updatePeerDebugState();
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    updatePeerDebugState();

    if (!isCurrentPeer(pc, connectSeq)) {
      return;
    }

    const response = await fetch(`${apiBase()}/webrtc/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        camera_id: cameraId,
        sdp: pc.localDescription.sdp,
        type: pc.localDescription.type,
        prefer_latest_frame: true,
        preferred_display_source: "analysis",
      }),
    });
    const answer = await safeJson(response);
    if (!response.ok) {
      throw new Error(answer?.detail || answer?.message || `webrtc offer failed: ${response.status}`);
    }

    if (!isCurrentPeer(pc, connectSeq)) {
      return;
    }
    state.peerId = answer.peer_id;
    await pc.setRemoteDescription(answer);
    flushPendingIceCandidates();
    updatePeerDebugState();
    connectResults(cameraId);
  } catch (error) {
    if (state.pc === pc) {
      $("webrtcState").textContent = "failed";
      $("statusBox").textContent = String(error);
      updatePeerDebugState();
      closeConnections();
      state.autoReconnect.connecting = false;
      scheduleWebRTCReconnect("webrtc offer failed");
    }
  } finally {
    state.autoReconnect.connecting = false;
    $("connectBtn").disabled = false;
    updateRecoveryBanner();
  }
}

function isCurrentPeer(pc, connectSeq) {
  return state.pc === pc && state.connectSeq === connectSeq && pc.signalingState !== "closed";
}

function closeConnections() {
  clearReconnectTimer("webrtc");
  clearReconnectTimer("ws");
  stopOverlayLoop();
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  state.peerId = null;
  state.pendingIceCandidates = [];
  state.connectedDisplaySource = null;
  updatePeerDebugState();
}

async function sendIceCandidate(peerId, candidate) {
  const response = await fetch(`${apiBase()}/webrtc/candidate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      peer_id: peerId,
      candidate,
    }),
  });
  if (!response.ok) {
    const payload = await safeJson(response);
    throw new Error(payload?.detail || payload?.message || `webrtc candidate failed: ${response.status}`);
  }
}

function flushPendingIceCandidates() {
  if (!state.peerId || !state.pendingIceCandidates.length) {
    return;
  }
  const pending = state.pendingIceCandidates.splice(0, state.pendingIceCandidates.length);
  for (const candidate of pending) {
    void sendIceCandidate(state.peerId, candidate).catch((error) => {
      $("statusBox").textContent = `webrtc candidate failed: ${error}`;
    });
  }
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
  });
}

function connectResults(cameraId) {
  clearReconnectTimer("ws");
  if (state.ws) {
    state.ws.close();
  }
  const ws = new WebSocket(`${wsBase()}/ws/results?camera_id=${encodeURIComponent(cameraId)}`);
  state.ws = ws;
  ws.onopen = () => {
    $("wsState").textContent = "connected";
    state.autoReconnect.wsAttempts = 0;
    updateRecoveryBanner();
  };
  ws.onclose = () => {
    if (state.ws === ws) {
      $("wsState").textContent = "closed";
      scheduleWebSocketReconnect("websocket closed");
    }
  };
  ws.onerror = () => {
    if (state.ws === ws) {
      $("wsState").textContent = "error";
      scheduleWebSocketReconnect("websocket error");
    }
  };
  ws.onmessage = (event) => {
    const startedAt = performance.now();
    const result = JSON.parse(event.data);
    const composedResult = composeOverlayResult(result);
    composedResult.overlay_received_at = Date.now();
    state.lastResult = composedResult;
    state.pendingResult = composedResult;
    $("frameInfo").textContent = `${result.frame_width}x${result.frame_height} #${result.frame_seq}`;
    $("personCount").textContent = `${(result.objects || []).length}`;
    $("latency").textContent = `${result.detector?.latency_ms ?? "-"} ms`;
    updateTargetDetails(composedResult);
    debugState.counters.wsMessages += 1;
    pushLimited(debugState.wsSamples, {
      at: Date.now(),
      elapsedMs: performance.now() - startedAt,
      objects: (result.objects || []).length,
      frameSeq: result.frame_seq,
    });
    updateWsFps();
  };
}

function composeOverlayResult(result) {
  const now = Date.now();
  const cameraId = String(result?.camera_id || "");
  const activeTrackIds = new Set();
  const activeBboxTrackIds = new Set();
  const objects = (result.objects || []).map((object) => {
    const trackKey = poseCacheKey(cameraId, object);
    if (trackKey) {
      activeTrackIds.add(trackKey);
      activeBboxTrackIds.add(trackKey);
    }
    const bboxPatch = buildOverlayBboxPatch(cameraId, object, now);

    const pose = object.pose;
    if (isPoseDisabledPlaceholder(pose)) {
      if (trackKey) {
        clearPoseArtifacts(trackKey, object);
      }
      return {
        ...object,
        ...bboxPatch,
        pose,
        overlay_camera_id: cameraId,
        overlay_frame_seq: result.frame_seq,
        overlay_pose_cached: false,
        overlay_pose_age_ms: null,
        overlay_pose_expired: false,
        overlay_pose_stale: false,
        overlay_pose_waiting: false,
        overlay_pose_disabled: true,
        overlay_pose_rejected: false,
        overlay_pose_rejected_reason: null,
      };
    }
    const poseRejectedReason = validatePoseForObject(result, object, pose);
    const poseRejected = Boolean(poseRejectedReason || pose?.debug?.rejected_reason);
    const poseAgeMs = poseAgeFromObject(object);
    const poseStale = isPoseMarkedStale(object);
    if (trackKey && (poseRejected || poseStale)) {
      clearPoseArtifacts(trackKey, object);
      return {
        ...object,
        ...bboxPatch,
        pose: null,
        overlay_camera_id: cameraId,
        overlay_frame_seq: result.frame_seq,
        overlay_pose_cached: false,
        overlay_pose_age_ms: poseAgeMs,
        overlay_pose_expired: true,
        overlay_pose_stale: poseStale,
        overlay_pose_waiting: false,
        overlay_pose_rejected: true,
        overlay_pose_rejected_reason: poseRejectedReason || pose?.debug?.rejected_reason || "pose_stale",
      };
    }
    if (trackKey && hasPoseKeypoints(pose)) {
      state.poseCache.set(trackKey, {
        pose,
        bbox: object.bbox,
        poseBounds: computePoseBoundsFromPose(pose),
        updatedAt: now,
        frameSeq: result.frame_seq,
      });
      return {
        ...object,
        ...bboxPatch,
        pose,
        overlay_camera_id: cameraId,
        overlay_frame_seq: result.frame_seq,
        overlay_pose_cached: false,
        overlay_pose_age_ms: poseAgeMs,
        overlay_pose_expired: false,
        overlay_pose_stale: false,
        overlay_pose_waiting: false,
      };
    }

    const cached = trackKey ? state.poseCache.get(trackKey) : null;
    if (trackKey && cached) {
      clearPoseArtifacts(trackKey, object);
    }
    return {
      ...object,
      ...bboxPatch,
      pose: null,
      overlay_camera_id: cameraId,
      overlay_frame_seq: result.frame_seq,
      overlay_pose_cached: false,
      overlay_pose_age_ms: cached ? Math.round(now - cached.updatedAt) : null,
      overlay_pose_expired: Boolean(cached),
      overlay_pose_stale: false,
      overlay_pose_waiting: true,
    };
  });

  const targetObject = objects.find((object) => object?.is_target === true) || null;
  const targetTrackKey = targetObject ? poseCacheKey(cameraId, targetObject) : null;
  if (state.lastTargetPoseCacheKey && state.lastTargetPoseCacheKey !== targetTrackKey) {
    clearPoseArtifacts(state.lastTargetPoseCacheKey);
  }
  state.lastTargetPoseCacheKey = targetTrackKey;

  for (const [trackKey, cached] of state.poseCache.entries()) {
    if (!activeTrackIds.has(trackKey) || now - cached.updatedAt > OVERLAY_POSE_CACHE_TTL_MS) {
      clearPoseArtifacts(trackKey);
    }
  }
  for (const [trackKey, cached] of state.bboxCache.entries()) {
    if (!activeBboxTrackIds.has(trackKey) || now - cached.updatedAt > OVERLAY_BBOX_CACHE_TTL_MS) {
      state.bboxCache.delete(trackKey);
    }
  }

  return {
    ...result,
    objects,
    overlay_debug: {
      pose_cache_size: state.poseCache.size,
      pose_cache_ttl_ms: OVERLAY_POSE_CACHE_TTL_MS,
      bbox_cache_size: state.bboxCache.size,
      bbox_cache_ttl_ms: OVERLAY_BBOX_CACHE_TTL_MS,
    },
  };
}

function buildOverlayBboxPatch(cameraId, object, now) {
  const bbox = normalizeBbox(object?.bbox);
  const trackKey = poseCacheKey(cameraId, object);
  if (!bbox || !trackKey) {
    return {
      overlay_bbox: bbox || object?.bbox || null,
      overlay_bbox_age_ms: null,
      overlay_bbox_stale: false,
      overlay_bbox_alpha: 1,
    };
  }

  const cached = state.bboxCache.get(trackKey);
  const stale = object?.fusion_debug?.tracking_stale === true;
  let smoothed = bbox;
  if (cached?.bbox && !stale) {
    smoothed = smoothBbox(cached.bbox, bbox, OVERLAY_BBOX_SMOOTHING_ALPHA);
  }
  state.bboxCache.set(trackKey, {
    bbox: smoothed,
    updatedAt: now,
    frameSeq: object?.overlay_frame_seq ?? null,
  });
  const rawAge = Number(object?.fusion_debug?.tracking_age_ms);
  const ageMs = Number.isFinite(rawAge) ? Math.max(0, Math.round(rawAge)) : 0;
  const fadeSpan = Math.max(1, OVERLAY_BBOX_CACHE_TTL_MS - OVERLAY_BBOX_FADE_START_MS);
  const alpha = ageMs <= OVERLAY_BBOX_FADE_START_MS
    ? 1
    : Math.max(0.18, 1 - ((ageMs - OVERLAY_BBOX_FADE_START_MS) / fadeSpan));
  return {
    overlay_bbox: smoothed,
    overlay_bbox_age_ms: ageMs,
    overlay_bbox_stale: stale,
    overlay_bbox_alpha: Number(alpha.toFixed(3)),
  };
}

function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) {
    return null;
  }
  const values = bbox.slice(0, 4).map(Number);
  return values.every(Number.isFinite) ? values : null;
}

function smoothBbox(previous, current, alpha) {
  return current.map((value, index) => {
    const prior = Number(previous[index]);
    if (!Number.isFinite(prior)) {
      return value;
    }
    return Number((prior + (value - prior) * alpha).toFixed(2));
  });
}

function poseCacheKey(cameraId, object) {
  const trackId = object?.track_id;
  if (trackId === null || trackId === undefined || trackId === "") {
    return null;
  }
  const scope = cameraId || object?.overlay_camera_id || "camera";
  return `${scope}:${trackId}`;
}

function hasPoseKeypoints(pose) {
  return Boolean(pose && Array.isArray(pose.keypoints) && pose.keypoints.length > 0);
}

function isPoseDisabledPlaceholder(pose) {
  return Boolean(
    pose
    && (
      String(pose?.pose_provider || "").toLowerCase() === "disabled_placeholder"
      || pose?.debug?.pose_disabled === true
    )
  );
}

function poseAgeFromObject(object) {
  const ageMs = Number(object?.pose?.debug?.pose_frame_age_ms);
  return Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs)) : null;
}

function isPoseMarkedStale(object) {
  const ageMs = poseAgeFromObject(object);
  return ageMs != null && ageMs > APP_POSE_STALE_THRESHOLD_MS;
}

function validatePoseForObject(result, object, pose) {
  if (!pose || !hasPoseKeypoints(pose)) {
    return null;
  }
  if (isPoseDisabledPlaceholder(pose)) {
    return null;
  }
  const objectTrackId = normalizeTrackId(object?.track_id);
  const poseTrackId = normalizeTrackId(pose?.track_id);
  const sourceTrackId = normalizeTrackId(pose?.source_track_id);
  if (objectTrackId == null || poseTrackId == null || sourceTrackId == null) {
    return "pose_identity_missing";
  }
  if (poseTrackId !== objectTrackId || sourceTrackId !== objectTrackId) {
    return "pose_track_mismatch";
  }
  const poseFrameSeq = normalizeFrameSeq(pose?.pose_frame_seq ?? pose?.debug?.pose_frame_seq);
  const objectFrameSeq = normalizeFrameSeq(result?.frame_seq);
  if (poseFrameSeq == null || objectFrameSeq == null) {
    return "pose_frame_missing";
  }
  if (Math.abs(objectFrameSeq - poseFrameSeq) > 2) {
    return "pose_frame_desync";
  }
  if (!isPoseBboxAligned(object?.bbox, pose?.source_bbox || pose?.pose_bbox)) {
    return "pose_bbox_drift";
  }
  return null;
}

function isPoseBboxAligned(objectBbox, poseBbox) {
  const bbox = rectFromBbox(objectBbox);
  const reference = rectFromBbox(poseBbox);
  if (!bbox || !reference) {
    return false;
  }
  if (rectIou(bbox, reference) <= 0.05) {
    return false;
  }
  const shift = distance(rectCenter(bbox), rectCenter(reference));
  const diagonal = Math.hypot(bbox.width, bbox.height) || 1;
  return shift <= diagonal * OVERLAY_POSE_CACHE_MAX_CENTER_SHIFT_RATIO;
}

function clearPoseArtifacts(trackKey, object = null) {
  if (trackKey) {
    state.poseCache.delete(trackKey);
    clearSmoothingTrackByCacheKey(trackKey);
  }
  if (object) {
    window.__VISION_POSE_SMOOTHING__?.tracks?.delete?.(Number(object.track_id));
  }
}

function clearSmoothingTrackByCacheKey(trackKey) {
  const parts = String(trackKey || "").split(":");
  const maybeTrackId = Number(parts.at(-1));
  if (Number.isFinite(maybeTrackId)) {
    window.__VISION_POSE_SMOOTHING__?.tracks?.delete?.(maybeTrackId);
  }
}

function normalizeTrackId(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeFrameSeq(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isReusableCachedPose(cached, object, now) {
  if (!cached || now - cached.updatedAt > OVERLAY_POSE_CACHE_TTL_MS) {
    return false;
  }
  if (!hasPoseKeypoints(object?.pose)) {
    return false;
  }
  if (!Array.isArray(object?.bbox) || object.bbox.length < 4 || !cached.poseBounds) {
    return false;
  }
  const bbox = rectFromBbox(object.bbox);
  const poseBounds = rectFromBbox(cached.poseBounds);
  if (!bbox || !poseBounds) {
    return false;
  }
  const iou = rectIou(bbox, poseBounds);
  if (iou <= 0.05) {
    return false;
  }
  const shift = distance(rectCenter(bbox), rectCenter(poseBounds));
  const diagonal = Math.hypot(bbox.width, bbox.height) || 1;
  return shift <= diagonal * OVERLAY_POSE_CACHE_MAX_CENTER_SHIFT_RATIO;
}

function computePoseBoundsFromPose(pose) {
  const points = (pose?.keypoints || [])
    .map((kp) => ({
      x: Number(kp?.x),
      y: Number(kp?.y),
      confidence: Number(kp?.confidence ?? 0),
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.confidence >= 0.2);
  if (!points.length) {
    return null;
  }
  return [
    Math.min(...points.map((point) => point.x)),
    Math.min(...points.map((point) => point.y)),
    Math.max(...points.map((point) => point.x)),
    Math.max(...points.map((point) => point.y)),
  ];
}

function rectFromBbox(bbox) {
  const x1 = Number(bbox?.[0]);
  const y1 = Number(bbox?.[1]);
  const x2 = Number(bbox?.[2]);
  const y2 = Number(bbox?.[3]);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) {
    return null;
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1, right: x2, bottom: y2 };
}

function rectCenter(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function rectIou(a, b) {
  const interX1 = Math.max(a.x, b.x);
  const interY1 = Math.max(a.y, b.y);
  const interX2 = Math.min(a.right, b.right);
  const interY2 = Math.min(a.bottom, b.bottom);
  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;
  if (interArea <= 0) {
    return 0;
  }
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  return interArea / Math.max(1, areaA + areaB - interArea);
}

function reconnectDelayMs(attempt) {
  const steps = [1000, 2000, 5000];
  return steps[Math.min(attempt, steps.length - 1)];
}

function clearReconnectTimer(kind) {
  const key = kind === "ws" ? "wsTimer" : "webrtcTimer";
  const timer = state.autoReconnect[key];
  if (timer) {
    clearTimeout(timer);
    state.autoReconnect[key] = null;
  }
}

function scheduleWebRTCReconnect(reason) {
  if (!state.userConnected || state.autoReconnect.connecting || state.autoReconnect.webrtcTimer) {
    updateRecoveryBanner();
    return;
  }
  const attempt = state.autoReconnect.webrtcAttempts++;
  const delay = reconnectDelayMs(attempt);
  debugState.counters.webrtcReconnects += 1;
  $("webrtcState").textContent = `重连中 ${Math.round(delay / 1000)}s`;
  updateRecoveryBanner(reason);
  state.autoReconnect.webrtcTimer = setTimeout(() => {
    state.autoReconnect.webrtcTimer = null;
    connectWebRTC();
  }, delay);
}

function scheduleWebSocketReconnect(reason) {
  if (!state.userConnected || state.autoReconnect.wsTimer) {
    updateRecoveryBanner();
    return;
  }
  const attempt = state.autoReconnect.wsAttempts++;
  const delay = reconnectDelayMs(attempt);
  debugState.counters.wsReconnects += 1;
  $("wsState").textContent = `重连中 ${Math.round(delay / 1000)}s`;
  updateRecoveryBanner(reason);
  state.autoReconnect.wsTimer = setTimeout(() => {
    state.autoReconnect.wsTimer = null;
    const pcState = state.pc?.connectionState;
    if (!state.pc || ["failed", "closed", "disconnected"].includes(pcState)) {
      scheduleWebRTCReconnect("websocket reconnect needs webrtc");
      return;
    }
    connectResults($("cameraId").value.trim() || "camera_01");
  }, delay);
}

function updateRecoveryBanner(extraMessage = null) {
  const banner = $("recoveryBanner");
  if (!banner) {
    return;
  }
  const status = state.lastStatus || {};
  const messages = [];
  const main = status.main_stream;
  const analysis = status.analysis_stream;

  if (status.diagnostics?.camera_lost) {
    messages.push("Camera offline: stale frame hidden; waiting for fresh frame");
  } else if (status.diagnostics?.capture_stale) {
    messages.push("Capture stale: waiting for fresh frame");
  }

  if (state.autoReconnect.webrtcTimer || state.autoReconnect.connecting) {
    messages.push("WebRTC 重连中");
  }
  if (state.autoReconnect.wsTimer) {
    messages.push("WebSocket 重连中");
  }
  if (status.display_fallback_active || status.display_source_current === "analysis") {
    messages.push("高清流恢复中，已切换稳定分析流显示");
  } else if (main && main.stream_state !== "connected") {
    messages.push("高清流恢复中");
  }
  if (analysis && analysis.stream_state !== "connected") {
    messages.push("AI 分析流恢复中");
  }
  if (extraMessage) {
    messages.push(extraMessage);
  }

  if (!messages.length) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  banner.textContent = Array.from(new Set(messages)).join(" / ");
}

async function refreshStatus() {
  try {
    const startedAt = performance.now();
    const cameraId = $("cameraId").value.trim() || "camera_01";
    const response = await fetch(`${apiBase()}/status?camera_id=${encodeURIComponent(cameraId)}`);
    const data = await response.json();
    state.lastStatus = data;
    const jsonStartedAt = performance.now();
    if (debugState.showRawJson) {
      $("statusBox").textContent = JSON.stringify(data, null, 2);
      debugState.counters.rawJsonUpdates += 1;
    }
    const rawJsonMs = performance.now() - jsonStartedAt;
    updateStreamState(data);
    updateBackendSource(data);
    syncRtspInputFromStatus(data);
    if (isResultExpired(state.lastResult)) {
      expireOverlayResult();
    }
    updateMetricPanel(data);
    debugState.counters.statusUpdates += 1;
    pushLimited(debugState.statusSamples, {
      at: Date.now(),
      elapsedMs: performance.now() - startedAt,
      rawJsonMs,
      frameAgeMs: data.cameras?.[0]?.frame_age_ms ?? null,
      publishFps: data.pipeline?.result_publish_fps ?? null,
      poseFps: data.pose?.pose_fps ?? null,
    });
  } catch (error) {
    $("statusBox").textContent = String(error);
  }
}

function syncRtspInputFromStatus(status) {
  const input = $("rtspUrl");
  if (!input) {
    return;
  }
  const cameraId = $("cameraId").value.trim() || "camera_01";
  const camera = (status.cameras || []).find((item) => item.camera_id === cameraId);
  const analysisUrl = status.analysis_stream?.source_url || status.main_stream?.source_url || camera?.source_url || "";
  if (analysisUrl && (!state.userEditedRtspUrl || !input.value.trim())) {
    input.value = analysisUrl;
    state.userEditedRtspUrl = false;
  }
}

function updateBackendSource(status) {
  const target = $("backendSource");
  if (!target) {
    return;
  }
  const main = status.main_stream;
  const analysis = status.analysis_stream || (status.cameras || [])[0];
  const display = status.display_source_current || status.display_source || "single";
  const analysisSource = status.analysis_source || "single";
  const mainUrl = main?.source_url || "-";
  const analysisUrl = analysis?.source_url || "-";
  if (mainUrl === analysisUrl) {
    target.textContent = `统一源(single): ${analysisUrl}`;
    return;
  }
  target.textContent = `显示(${display}): ${mainUrl} / AI(${analysisSource}): ${analysisUrl}`;
}

function updateStreamState(status) {
  const cameraId = $("cameraId").value.trim() || "camera_01";
  const camera = (status.cameras || []).find((item) => item.camera_id === cameraId);
  if (!camera) {
    $("streamState").textContent = "未连接";
    updateRecoveryBanner();
    return;
  }

  const age = camera.frame_age_ms == null ? "-" : `${Math.round(camera.frame_age_ms)}ms`;
  const display = status.display_source_current || status.display_source || "single";
  const suffix = status.display_fallback_active ? " / 显示=分析流" : ` / 显示=${display}`;
  const staleLabel = status.diagnostics?.camera_lost
    ? "Camera offline"
    : status.diagnostics?.capture_stale
      ? "Capture stale / waiting for fresh frame"
      : streamStateLabel(camera.stream_state);
  $("streamState").textContent = `${staleLabel} (${age})${suffix}`;
  maybeReconnectForDisplaySource(status);
  updateRecoveryBanner();
}

function maybeReconnectForDisplaySource(status) {
  const display = status.display_source_current || status.display_source || "single";
  state.lastDisplaySource = display;
  if (!state.userConnected || state.autoReconnect.connecting) {
    return;
  }
  if (!state.connectedDisplaySource) {
    state.connectedDisplaySource = display;
    return;
  }
  if (state.connectedDisplaySource !== display) {
    if (display === "analysis") {
      debugState.counters.displayFallbackSwitches += 1;
    }
    state.connectedDisplaySource = display;
    scheduleWebRTCReconnect(`显示流切换到 ${display}`);
  }
}

function streamStateLabel(streamState) {
  const labels = {
    disconnected: "未连接",
    connecting: "正在连接",
    connected: "画面正常",
    stale: "画面停滞/正在恢复",
    reconnecting: "正在重连",
  };
  return labels[streamState] || streamState;
}

function updateTargetDetails(result) {
  const objects = result?.objects || [];
  const target = objects.find((item) => item.is_target === true) || objects[0];
  if (!target) {
    $("targetTrackId").textContent = "-";
    $("targetFlag").textContent = "-";
    $("targetPerson").textContent = "-";
    $("trackingState").textContent = "-";
    $("identityState").textContent = "-";
    $("behaviorState").textContent = "-";
    $("poseState").textContent = "-";
    $("poseState").className = "";
    updateFallPreview(null);
    return;
  }

  const personLabel = target.person_id
    ? `${target.person_id}${target.person_name ? ` / ${target.person_name}` : ""}`
    : "-";
  const behavior = target.behavior;
  const behaviorLabel = behavior
    ? `${localizeBehaviorState(behavior.behavior_state)} (${formatScore(behavior.behavior_confidence)})`
    : "-";

  $("targetTrackId").textContent = target.track_id == null ? "-" : `#${target.track_id}`;
  $("targetFlag").textContent = target.is_target ? "是" : "否";
  $("targetPerson").textContent = personLabel;
  $("trackingState").textContent = localizeTrackingState(target.identity_state);
  $("identityState").textContent = localizeIdentityState(target);
  $("behaviorState").textContent = behaviorLabel;
  updatePoseState(target);
  updateFallPreview(target);
}

function updatePoseState(target) {
  const element = $("poseState");
  if (!element) {
    return;
  }
  element.textContent = describePoseState(target);
  element.className = poseStateClass(target);
}

function describePoseState(target) {
  if (!target) {
    return "-";
  }
  if (target.overlay_pose_disabled || isPoseDisabledPlaceholder(target.pose)) {
    return "pose placeholder";
  }
  const pose = target.pose;
  const ageMs = poseAgeFromObject(target);
  if (target.overlay_pose_stale) {
    return ageMs == null ? "pose stale" : `pose stale (${ageMs}ms)`;
  }
  if (pose && hasPoseKeypoints(pose)) {
    return ageMs == null ? "pose ready" : `pose ready (${ageMs}ms)`;
  }
  if (target.overlay_pose_rejected_reason) {
    return target.overlay_pose_rejected_reason === "pose_stale"
      ? "pose stale"
      : `pose filtered (${target.overlay_pose_rejected_reason})`;
  }
  return "waiting pose";
}

function poseStateClass(target) {
  if (!target) {
    return "";
  }
  if (target.overlay_pose_disabled || isPoseDisabledPlaceholder(target.pose)) {
    return "risk-cooldown";
  }
  if (target.overlay_pose_stale || target.overlay_pose_rejected_reason === "pose_stale") {
    return "risk-cooldown";
  }
  if (target.pose && hasPoseKeypoints(target.pose)) {
    return "risk-low";
  }
  return "";
}

function updateFallPreview(target) {
  const temporal = target?.temporal;
  const decision = target?.fall_decision;
  const alarm = target?.alarm_preview;
  const stateName = decision?.fall_state || "-";
  const risk = alarm?.risk_level || decision?.risk_level || "-";
  const probability = temporal?.fall_probability;
  const countdown = alarm?.countdown_ms ?? decision?.countdown_ms;
  const shadowProbability = temporal?.shadow?.fall_probability;
  const windowSize = temporal?.window_size;
  const windowReady = temporal?.window_ready;

  $("fallState").textContent = localizeFallState(stateName);
  $("riskLevel").textContent = localizeRiskLevel(risk);
  $("fallProbability").textContent = formatProbability(probability);
  $("fallCountdown").textContent = formatCountdown(countdown);
  $("shadowProbability").textContent = formatProbability(shadowProbability);
  $("temporalWindow").textContent = windowSize == null ? "-" : `${windowSize}${windowReady ? " / ready" : " / warmup"}`;
  $("fallState").className = fallStateClass(target);
  $("riskLevel").className = riskClass(risk);
}

function fallStateClass(target) {
  return riskClass(displayRiskForFallState(target?.fall_decision?.fall_state, target?.alarm_preview?.confirmed, target?.alarm_preview?.risk_level || target?.fall_decision?.risk_level));
}

function displayRiskForFallState(fallState, alarmConfirmed, rawRisk) {
  if (alarmConfirmed === true || fallState === "fallen_confirmed") {
    return "critical";
  }
  if (fallState === "normal") {
    return "low";
  }
  if (fallState === "unstable") {
    return "medium";
  }
  if (fallState === "falling" || fallState === "fallen_candidate") {
    return rawRisk === "medium" ? "medium" : "high";
  }
  if (fallState === "cooldown") {
    return "cooldown";
  }
  return rawRisk || "low";
}

function updateMetricPanel(status) {
  const detection = (status.detection || [])[0];
  const detectionFps = detection?.detection_fps ?? null;
  const trackingFps = status.pipeline?.tracking_worker_fps ?? status.tracking?.tracking_fps ?? null;
  const poseFps = status.pose?.pose_fps ?? null;
  const publishFps = status.pipeline?.result_publish_fps ?? null;
  $("detectionFps").textContent = formatFps(detectionFps);
  $("trackingFps").textContent = formatFps(trackingFps);
  $("poseFps").textContent = formatFps(poseFps);
  $("aiFps").textContent = `D:${formatFps(detectionFps)} T:${formatFps(trackingFps)} P:${formatFps(poseFps)} R:${formatFps(publishFps)}`;
  updateWsFps();
  updateOverlayAge();
  updatePeerDebugState();
  const reporter = status.fall_event_reporter || {};
  const latest = status.latest_result || {};
  $("reporterStatus").textContent = reporter.enabled
    ? `${reporter.last_post_status || "ready"}${reporter.last_incident_id ? ` / ${reporter.last_incident_id}` : ""}`
    : "disabled";
  if (!$("targetTrackId").textContent || $("targetTrackId").textContent === "-") {
    $("targetTrackId").textContent = latest.track_id == null ? "-" : `#${latest.track_id}`;
  }
}

function attachVideoFrameLoop() {
  const video = $("video");
  if (!video) {
    return;
  }
  stopOverlayLoop();
  if (typeof video.requestVideoFrameCallback !== "function") {
    startOverlayFallbackLoop(video);
    return;
  }
  state.videoFrameCallbackActive = true;
  const loop = (_now, metadata) => {
    if (!state.videoFrameCallbackActive) {
      return;
    }
    const result = consumePendingOverlayResult();
    if (result) {
      drawOverlay(video, result, metadata);
      debugState.counters.overlayFramesDrawn += 1;
      updateOverlayFps();
    }
    video.requestVideoFrameCallback(loop);
  };
  video.requestVideoFrameCallback(loop);
}

function stopOverlayLoop() {
  state.videoFrameCallbackActive = false;
  if (state.overlayFallbackTimer) {
    clearInterval(state.overlayFallbackTimer);
    state.overlayFallbackTimer = null;
  }
}

function startOverlayFallbackLoop(video) {
  if (state.overlayFallbackTimer) {
    return;
  }
  const drawLatest = () => {
    const result = consumePendingOverlayResult();
    if (!result) {
      return;
    }
    if (!video || video.readyState < 2 || video.paused || !video.videoWidth || !video.videoHeight) {
      return;
    }
    drawOverlay(video, result, {
      mediaTime: video.currentTime,
      presentedFrames: debugState.counters.overlayFramesDrawn + 1,
    });
    debugState.counters.overlayFramesDrawn += 1;
    updateOverlayFps();
  };
  state.overlayFallbackTimer = setInterval(drawLatest, 100);
}

function consumePendingOverlayResult() {
  const result = state.pendingResult || state.lastResult;
  state.pendingResult = null;
  if (!result) {
    return null;
  }
  if (isResultExpired(result)) {
    expireOverlayResult();
    return null;
  }
  return result;
}

function isResultExpired(result) {
  if (!result) {
    return false;
  }
  const receivedAt = Number(result.overlay_received_at);
  if (!Number.isFinite(receivedAt)) {
    return false;
  }
  return Date.now() - receivedAt > RESULT_OVERLAY_TTL_MS;
}

function expireOverlayResult() {
  state.lastResult = null;
  state.pendingResult = null;
  state.poseCache.clear();
  clearOverlayCanvas();
  updateTargetDetails(null);
  updateOverlayAge();
}

function clearOverlayCanvas() {
  const canvas = $("overlay");
  const ctx = canvas?.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function updateWsFps() {
  const target = $("wsFps");
  if (!target) {
    return;
  }
  const samples = debugState.wsSamples;
  if (samples.length < 2) {
    target.textContent = "warming up";
    return;
  }
  const first = samples[0];
  const last = samples.at(-1);
  const elapsedSec = (last.at - first.at) / 1000;
  if (elapsedSec <= 0) {
    target.textContent = "-";
    return;
  }
  target.textContent = `${((samples.length - 1) / elapsedSec).toFixed(1)}`;
}

function updateOverlayFps() {
  const target = $("overlayFps");
  if (!target) {
    return;
  }
  const now = performance.now();
  const frames = debugState.counters.overlayFramesDrawn;
  if (state.overlayFps.lastAt == null) {
    state.overlayFps.lastAt = now;
    state.overlayFps.lastFrames = frames;
    target.textContent = "warming up";
    return;
  }
  const elapsedSec = (now - state.overlayFps.lastAt) / 1000;
  const frameDelta = frames - state.overlayFps.lastFrames;
  if (elapsedSec >= 1) {
    target.textContent = `${(frameDelta / elapsedSec).toFixed(1)}`;
    state.overlayFps.lastAt = now;
    state.overlayFps.lastFrames = frames;
  }
}

function updateOverlayAge() {
  const target = $("overlayAge");
  if (!target) {
    return;
  }
  const timestamp = state.lastResult?.timestamp;
  if (!timestamp) {
    target.textContent = "-";
    return;
  }
  const ageMs = Date.now() - Date.parse(timestamp);
  target.textContent = Number.isFinite(ageMs) ? `${Math.max(0, Math.round(ageMs))}ms` : "-";
}

function formatFps(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "-";
  }
  return Number(value).toFixed(1);
}

function formatScore(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "-";
  }
  return Number(value).toFixed(2);
}

function formatProbability(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "-";
  }
  return `${Math.round(Number(value) * 100)}%`;
}

function formatCountdown(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "-";
  }
  return `${(Number(value) / 1000).toFixed(1)}秒`;
}

function localizeFallState(value) {
  return FALL_STATE_LABELS[value] || value || "-";
}

function localizeRiskLevel(value) {
  return RISK_LEVEL_LABELS[value] || value || "-";
}

function localizeBehaviorState(value) {
  return BEHAVIOR_LABELS[value] || value || "-";
}

function localizeTrackingState(value) {
  return TRACKING_STATE_LABELS[value] || value || "-";
}

function localizeIdentityState(target) {
  if (!target?.person_id) {
    return IDENTITY_STATE_LABELS.unbound;
  }
  return IDENTITY_STATE_LABELS.recognized;
}

function riskClass(risk) {
  return RISK_LEVEL_LABELS[risk] ? `risk-${risk}` : "";
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return { status: response.status, message: response.statusText };
  }
}

function pushLimited(items, item, limit = 600) {
  items.push(item);
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
}

function summarizeSamples(samples) {
  if (!samples.length) {
    return { count: 0 };
  }
  const elapsedValues = samples
    .map((item) => item.elapsedMs)
    .filter((value) => Number.isFinite(value));
  return {
    count: samples.length,
    avgElapsedMs: average(elapsedValues),
    maxElapsedMs: max(elapsedValues),
    firstAt: samples[0].at,
    lastAt: samples.at(-1).at,
  };
}

function summarizeRtc(samples) {
  if (!samples.length) {
    return { count: 0 };
  }
  const first = samples[0];
  const last = samples.at(-1);
  return {
    count: samples.length,
    framesDecodedDelta: diff(last.framesDecoded, first.framesDecoded),
    framesDroppedDelta: diff(last.framesDropped, first.framesDropped),
    framesReceivedDelta: diff(last.framesReceived, first.framesReceived),
    packetsLostDelta: diff(last.packetsLost, first.packetsLost),
    jitterLatest: last.jitter,
    freezeCountLatest: last.freezeCount,
    totalFreezesDurationLatest: last.totalFreezesDuration,
  };
}

function summarizeVideo(samples) {
  if (!samples.length) {
    return { count: 0 };
  }
  const first = samples[0];
  const last = samples.at(-1);
  return {
    ...summarizeSamples(samples),
    currentTimeDelta: round(diff(last.currentTime, first.currentTime)),
    totalVideoFramesDelta: diff(last.totalVideoFrames, first.totalVideoFrames),
    droppedVideoFramesDelta: diff(last.droppedVideoFrames, first.droppedVideoFrames),
    droppedVideoFramesLatest: last.droppedVideoFrames,
    totalVideoFramesLatest: last.totalVideoFrames,
    readyStateLatest: last.readyState,
    pausedLatest: last.paused,
  };
}

function average(values) {
  if (!values.length) {
    return null;
  }
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function max(values) {
  if (!values.length) {
    return null;
  }
  return round(Math.max(...values));
}

function diff(last, first) {
  if (!Number.isFinite(last) || !Number.isFinite(first)) {
    return null;
  }
  return round(last - first);
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function pushDebugError(kind, payload) {
  pushLimited(debugState.errors, {
    at: Date.now(),
    kind,
    message: String(payload?.message || payload?.reason || payload || ""),
    source: payload?.filename || payload?.source || null,
    line: payload?.lineno || null,
    col: payload?.colno || null,
  }, 100);
}

function readFreezeDomSnapshot() {
  const video = $("video");
  const quality = typeof video?.getVideoPlaybackQuality === "function"
    ? video.getVideoPlaybackQuality()
    : null;
  return {
    href: window.location.href,
    visibilityState: document.visibilityState,
    webrtcState: $("webrtcState")?.textContent || null,
    wsState: $("wsState")?.textContent || null,
    videoFps: $("videoFps")?.textContent || null,
    wsFps: $("wsFps")?.textContent || null,
    overlayFps: $("overlayFps")?.textContent || null,
    overlayAge: $("overlayAge")?.textContent || null,
    videoFrames: $("videoFrames")?.textContent || null,
    videoReadyState: $("videoReadyState")?.textContent || null,
    videoSize: $("videoSize")?.textContent || null,
    pcExists: $("pcExists")?.textContent || null,
    iceConnectionState: $("iceConnectionState")?.textContent || null,
    signalingState: $("signalingState")?.textContent || null,
    srcObjectTracks: $("srcObjectTracks")?.textContent || null,
    readyState: video?.readyState ?? null,
    paused: video?.paused ?? null,
    currentTime: video?.currentTime ?? null,
    totalVideoFrames: quality?.totalVideoFrames ?? null,
    droppedVideoFrames: quality?.droppedVideoFrames ?? null,
  };
}

function sampleVideoQuality() {
  const video = $("video");
  if (!video) {
    return;
  }
  const quality = typeof video.getVideoPlaybackQuality === "function"
    ? video.getVideoPlaybackQuality()
    : null;
  pushLimited(debugState.videoSamples, {
    at: Date.now(),
    currentTime: video.currentTime,
    readyState: video.readyState,
    paused: video.paused,
    totalVideoFrames: quality?.totalVideoFrames ?? null,
    droppedVideoFrames: quality?.droppedVideoFrames ?? null,
    corruptedVideoFrames: quality?.corruptedVideoFrames ?? null,
  });
  updateVideoFps(quality);
}

function updateVideoFps(quality) {
  const target = $("videoFps");
  if (!target) {
    return;
  }
  if (!quality || !Number.isFinite(quality.totalVideoFrames)) {
    target.textContent = "unsupported";
    return;
  }
  const now = performance.now();
  const totalFrames = Number(quality.totalVideoFrames);
  const droppedFrames = Number(quality.droppedVideoFrames || 0);
  const previous = state.videoFps;
  if (
    previous.lastAt == null
    || previous.lastTotalFrames == null
    || previous.lastDroppedFrames == null
  ) {
    previous.lastAt = now;
    previous.lastTotalFrames = totalFrames;
    previous.lastDroppedFrames = droppedFrames;
    target.textContent = "warming up";
    return;
  }
  const elapsedSec = (now - previous.lastAt) / 1000;
  const frameDelta = totalFrames - previous.lastTotalFrames;
  const dropDelta = droppedFrames - previous.lastDroppedFrames;
  previous.lastAt = now;
  previous.lastTotalFrames = totalFrames;
  previous.lastDroppedFrames = droppedFrames;
  if (elapsedSec <= 0 || frameDelta < 0 || dropDelta < 0) {
    target.textContent = "-";
    return;
  }
  const fps = frameDelta / elapsedSec;
  target.textContent = `${fps.toFixed(1)} (drop ${Math.round(dropDelta)})`;
  const videoFrames = $("videoFrames");
  if (videoFrames) {
    videoFrames.textContent = `${Math.round(totalFrames)} / drop ${Math.round(droppedFrames)}`;
  }
  updatePeerDebugState();
}

async function sampleRtcStats() {
  const pc = state.pc;
  if (!pc || pc.connectionState === "closed") {
    return;
  }
  try {
    const stats = await pc.getStats();
    let sample = null;
    stats.forEach((report) => {
      if (report.type === "inbound-rtp" && (report.kind === "video" || report.mediaType === "video")) {
        sample = {
          at: Date.now(),
          framesDecoded: report.framesDecoded ?? null,
          framesDropped: report.framesDropped ?? null,
          framesReceived: report.framesReceived ?? null,
          packetsLost: report.packetsLost ?? null,
          jitter: report.jitter ?? null,
          freezeCount: report.freezeCount ?? null,
          totalFreezesDuration: report.totalFreezesDuration ?? null,
        };
      }
    });
    if (sample) {
      pushLimited(debugState.rtcSamples, sample);
    }
    updatePeerDebugState();
  } catch (_) {
    // Debug-only sampling must never affect the demo.
  }
}

function updatePeerDebugState() {
  const pc = state.pc;
  const video = $("video");
  const srcObject = video?.srcObject || null;
  const pcExists = $("pcExists");
  const iceConnectionState = $("iceConnectionState");
  const signalingState = $("signalingState");
  const iceGatheringState = $("iceGatheringState");
  const hasSrcObject = $("hasSrcObject");
  const srcObjectTracks = $("srcObjectTracks");
  const videoReadyState = $("videoReadyState");
  const videoSize = $("videoSize");
  if (!pcExists || !iceConnectionState || !signalingState || !iceGatheringState || !hasSrcObject || !srcObjectTracks || !videoReadyState || !videoSize) {
    return;
  }
  pcExists.textContent = pc ? "yes" : "no";
  iceConnectionState.textContent = pc?.iceConnectionState || "-";
  signalingState.textContent = pc?.signalingState || "-";
  iceGatheringState.textContent = pc?.iceGatheringState || "-";
  hasSrcObject.textContent = srcObject ? "yes" : "no";
  const tracks = srcObject?.getTracks?.() || [];
  srcObjectTracks.textContent = tracks.length
    ? tracks.map((track) => `${track.kind}:${track.readyState}${track.muted ? ':muted' : ''}`).join(", ")
    : "-";
  videoReadyState.textContent = video ? `${video.readyState}${state.lastPlayError ? ` / playErr` : ""}` : "-";
  videoSize.textContent = video && video.videoWidth > 0 && video.videoHeight > 0
    ? `${video.videoWidth}x${video.videoHeight}`
    : "-";
}

$("startBtn").addEventListener("click", startStream);
$("connectBtn").addEventListener("click", connectWebRTC);
initializeManualAlertControls();
$("rtspUrl")?.addEventListener("input", () => {
  state.userEditedRtspUrl = true;
});
window.addEventListener("beforeunload", () => {
  state.userConnected = false;
  stopOverlayLoop();
  closeConnections();
});
window.addEventListener("resize", () => {
  const video = $("video");
  if (state.lastResult && video && !isResultExpired(state.lastResult)) {
    drawOverlay(video, state.lastResult);
  } else if (isResultExpired(state.lastResult)) {
    expireOverlayResult();
  }
});
window.addEventListener("error", (event) => pushDebugError("error", event));
window.addEventListener("unhandledrejection", (event) => pushDebugError("unhandledrejection", event));
if ("PerformanceObserver" in window) {
  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        pushLimited(debugState.longTasks, {
          at: Date.now(),
          name: entry.name,
          durationMs: round(entry.duration),
          startTimeMs: round(entry.startTime),
        }, 100);
      }
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch (_) {
    // Long-task telemetry is best-effort and must never affect playback.
  }
}
setInterval(refreshStatus, 2000);
setInterval(sampleVideoQuality, 1000);
setInterval(sampleRtcStats, 1000);
refreshStatus();
