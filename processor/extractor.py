"""Video frame extraction — ported from the FrameForge Tkinter app.

Streams one frame at a time:
    frame -> encode JPEG -> yield -> caller uploads to R2 -> release.

Never accumulates all frames in memory.
"""

import cv2

import config
import frame_encoder
import scene_detection

class CancelledError(Exception):
    """Raised when a cancellation signal is detected during extraction."""


def resolve_fps(extraction_fps, source_fps: float, duration: float) -> float:
    """Map the Worker's sentinel values to an actual extraction FPS.

    -2  -> every frame (source fps)
    -1  -> smart scene (returned as -1 sentinel)
     0  -> thumb strip (auto)
     0.2-> one per 5 s
    >0  -> fixed fps
    """
    if extraction_fps == -2:
        return source_fps
    if extraction_fps == -1:
        return -1.0
    if extraction_fps == 0:
        return round(min(2.0, max(0.2, 20.0 / max(duration, 1))), 2)
    return float(extraction_fps)


def extract_frames(
    video_path: str,
    extraction_fps,
    sharpness: float = 1.0,
    scene_threshold: float = config.SCENE_THRESHOLD_DEFAULT,
    should_cancel=None,
    max_frames: int = config.MAX_FRAMES,
):
    """Yield dicts describing each extracted frame.

    Each yielded dict:
      frame_number, source_frame_number, timestamp,
      full_bytes, thumb_bytes, width, height, processed, total, src_fps
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError("Cannot open video file")

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total / src_fps if total and src_fps else 0.0

    fps = resolve_fps(extraction_fps, src_fps, duration)
    scene_mode = fps == -1.0
    interval = max(1, int(round(src_fps / fps))) if not scene_mode else 1

    frame_no = 0
    count = 0
    prev_gray = None
    first_captured = False
    last_progress = -config.PROGRESS_INTERVAL

    try:
        while True:
            # Periodic cancellation check (avoid a D1 round-trip per frame)
            if frame_no % config.CANCEL_CHECK_INTERVAL == 0 and should_cancel and should_cancel():
                raise CancelledError()

            ret, frame = cap.read()
            if not ret:
                break

            should_capture = False
            if scene_mode:
                small = cv2.resize(frame, (160, 90))
                curr_gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                if prev_gray is None or not first_captured:
                    should_capture = True
                    first_captured = True
                else:
                    if scene_detection.hist_diff(prev_gray, curr_gray) >= scene_threshold:
                        should_capture = True
                prev_gray = curr_gray
            else:
                should_capture = frame_no % interval == 0

            if should_capture:
                ts = frame_no / src_fps
                full_bytes, thumb_bytes, (w, h) = frame_encoder.encode_frame(frame, sharpness)
                count += 1
                yield {
                    "frame_number": count,
                    "source_frame_number": frame_no,
                    "timestamp": ts,
                    "full_bytes": full_bytes,
                    "thumb_bytes": thumb_bytes,
                    "width": w,
                    "height": h,
                    "processed": frame_no,
                    "total": total,
                    "src_fps": src_fps,
                }
                if count >= max_frames:
                    break

            frame_no += 1
    finally:
        cap.release()
