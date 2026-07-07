# 专家交接：项目现状

## 1. 项目定位

当前项目是一个本地实时视觉服务，目标能力包括：

- RTSP 摄像头接入
- 最新帧缓存
- YOLO 人体检测
- ByteTrack 跟踪
- WebRTC 前端实时视频
- WebSocket 结果推送
- 姿态 / 行为 / 跌倒预览
- 身份注册与身份绑定

主服务路径：

- 根目录：`D:\Program\vision_service`
- 主应用入口：`app.main:app`
- 前端 Demo：`/demo`
- 身份 sidecar：`identity_service/app.main:app`

## 2. 当前已经相对稳定的部分

### 主服务

- `GET /healthz`
- `GET /status`
- `POST /stream/start`
- `POST /stream/stop`
- `GET /stream/source`
- `POST /stream/probe`
- `POST /webrtc/offer`
- `POST /webrtc/candidate`
- `WS /ws/results`

### 前端 Demo

- 页面能打开
- RTSP URL 可输入
- Start / Connect 流程已做过一轮收敛
- WebRTC candidate 接口已补齐
- 缺失的状态面板 DOM 节点已补齐

### 可用输入源

- `mock://colorbars`
- 本地视频文件
- RTSP

### 已经验证过的能力

- `mock://colorbars` 可驱动主服务、WebRTC、WebSocket、检测、跟踪
- 本地视频文件可驱动检测、跟踪、WebRTC、WebSocket
- `identity_service` 能启动并提供 `/healthz`

## 3. 当前真实边界

### 单流才是当前真实运行形态

虽然接口里还保留了：

- `main_rtsp_url`
- `analysis_rtsp_url`
- `main_stream`
- `analysis_stream`

但当前运行时已按**单流稳定版**收敛：

- 只有一个真实生效源
- 双流字段仅作兼容或状态别名使用

### 高级模块不是完全完成态

系统里已经接入：

- `ENABLE_POSE`
- `ENABLE_BEHAVIOR`
- `ENABLE_TEMPORAL`
- `ENABLE_IDENTITY_BINDING`

但它们目前更接近：

- “代码已接入主系统”
- “允许默认开启并降级”

而不是：

- “所有模块都已在真实 RTSP 上稳定通过验收”

## 4. 当前关键启动方式

### 主服务

常用启动方式：

```powershell
C:\Users\YANG\.conda\envs\torchgpu\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### 身份服务

```powershell
cd D:\Program\vision_service\identity_service
C:\Users\YANG\.conda\envs\torchgpu\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8100
```

### 当前摄像头启动脚本

```text
scripts/start_current_camera.py
```

这个脚本当前已经被修改为：

- 默认局域网监听
- 默认高阶模块开启
- 默认尝试 `subprocess_pyav`
- 保留回退路径

## 5. 当前服务健康状态参考

### 主服务

正常时：

```json
{"status":"ok"}
```

### 身份服务

当前常见健康状态：

```json
{
  "status": "ok",
  "recognizer_loaded": false,
  "recognizer_name": "insightface",
  "model_name": "buffalo_l",
  "registered_count": 0,
  "last_error": "No module named 'insightface'"
}
```

这表示：

- sidecar 进程是活的
- 但人脸识别器未真正可用
- 这应视为**允许的降级状态**

## 6. 当前最重要的运行事实

### mock 源

`mock://colorbars` 是当前最稳定的回归基线：

- `/status` 与 `/stream/source` 一致显示 `connected=true`
- 检测、跟踪、WebRTC、WebSocket 可一起工作

### 本地视频源

本地样本路径：

- `tests/fixtures/person_bus_loop.mp4`
- `tests/fixtures/identity_self_loop.mp4`
- `tests/fixtures/7992a66e51c7700a23f5e3798321077d.mp4`

已知问题：

- 本地文件 EOF 行为过去会进入重连风暴
- 当前正在收敛中，需要再次验证

### 真实 RTSP

摄像头地址：

```text
rtsp://admin:YOUR_PASSWORD@192.168.8.253:10554/tcp/av0_1
```

关键事实：

- 桌面 VLC 会话中曾成功播放
- 但自动化后台上下文里，该地址不总是可达
- 因此真实 RTSP 验收必须限定在**与 VLC 成功同一桌面会话**

## 7. 当前最有价值的专家切入点

最值得专家立刻看的模块：

- `app/camera/capture_worker.py`
- `app/camera/subprocess_capture_worker.py`
- `app/camera/capture_process.py`
- `app/services/stream_service.py`
- `app/services/status_service.py`
- `app/streaming/peer_manager.py`
- `frontend_demo/app.js`

这些模块覆盖：

- 采集
- 生命周期
- 单流契约
- 状态一致性
- WebRTC 闭环
- 前端连接逻辑

## 8. 交接结论

当前项目不是“完全不可用”，而是处于：

- 核心骨架已经成型
- mock / 本地样本能力大部分能跑
- 高级模块已接入但未完全验收
- 真实 RTSP 闭环仍是最大阻塞

专家进入后，最应该做的是：

1. 明确真实 RTSP 验收会话
2. 收敛本地文件 EOF 生命周期
3. 稳定高级模块默认开启时的降级行为
4. 在不破坏现有接口的前提下，把真实 RTSP 前端出图做实
