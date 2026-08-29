"""Environment configuration for the FrameForge Python processor.

All secrets come from environment variables (set via Modal secrets).
"""

import os


def _req(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise RuntimeError(f"Missing required env var: {name}")
    return val


# R2 (S3-compatible) credentials
R2_ACCOUNT_ID = _req("PROCESSOR_R2_ACCOUNT_ID")
R2_ACCESS_KEY_ID = _req("PROCESSOR_R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = _req("PROCESSOR_R2_SECRET_ACCESS_KEY")
R2_BUCKET = _req("PROCESSOR_R2_BUCKET")
R2_ENDPOINT = _req("PROCESSOR_R2_ENDPOINT")

# Cloudflare D1 (via the HTTP query API)
D1_ACCOUNT_ID = _req("PROCESSOR_D1_ACCOUNT_ID")
D1_DATABASE_ID = _req("PROCESSOR_D1_DATABASE_ID")
D1_API_TOKEN = _req("PROCESSOR_D1_API_TOKEN")

# Webhook auth (must match the Worker's MODAL_TOKEN)
WEBHOOK_TOKEN = os.environ.get("PROCESSOR_WEBHOOK_TOKEN", "")

# Processing limits / behaviour (mirrors the desktop app)
MAX_FRAMES = int(os.environ.get("PROCESSOR_MAX_FRAMES", "5000"))
JPEG_QUALITY = int(os.environ.get("PROCESSOR_JPEG_QUALITY", "92"))
BASE_THUMB_W = 480
BASE_THUMB_H = 270
PROGRESS_INTERVAL = 50  # throttle D1 progress writes
CANCEL_CHECK_INTERVAL = 20  # frames between cancellation checks

SCENE_THRESHOLD_DEFAULT = 30.0

# R2 object key layout (must match the Worker).
# `user_segment` is the email (new uploads) or legacy uid; `folder_id` is the
# user folder id or "root" for the email root. Both are always derived from the
# job's r2_video_key (`users/{segment}/{folder}/jobs/...`).
def full_frame_key(user_segment: str, folder_id: str, job_id: str, n: int) -> str:
    return f"users/{user_segment}/{folder_id}/jobs/{job_id}/frames/full/frame_{n:04d}.jpg"


def thumb_frame_key(user_segment: str, folder_id: str, job_id: str, n: int) -> str:
    return f"users/{user_segment}/{folder_id}/jobs/{job_id}/frames/thumbs/frame_{n:04d}.jpg"


def chunk_video_key(user_segment: str, folder_id: str, job_id: str, n: int) -> str:
    return f"users/{user_segment}/{folder_id}/jobs/{job_id}/chunks/chunk_{n:04d}.mp4"


def export_key(user_segment: str, folder_id: str, job_id: str, export_type: str, kind: str = "frames") -> str:
    name = f"{kind}_selected.zip" if export_type == "selected" else f"{kind}_all.zip"
    return f"users/{user_segment}/{folder_id}/jobs/{job_id}/exports/{name}"


def video_thumb_key(user_segment: str, folder_id: str, job_id: str) -> str:
    return f"users/{user_segment}/{folder_id}/jobs/{job_id}/thumbnail.jpg"


# Image formats the frame-optimizer supports (Pillow save args) — mirrors the Worker.
IMAGE_EXT = {"webp": "webp", "jpeg": "jpg", "avif": "avif", "png": "png"}
IMAGE_FORMATS = ("webp", "jpeg", "avif", "png")


def optimized_frame_key(user_segment: str, folder_id: str, job_id: str, fmt: str, n: int) -> str:
    ext = IMAGE_EXT.get(fmt, "webp")
    return f"users/{user_segment}/{folder_id}/jobs/{job_id}/frames/optimized/{fmt}/frame_{n:04d}.{ext}"


# ffmpeg for stream-copy chunk export (found on PATH; matches local_trimer-5.py)
FFMPEG = os.environ.get("FFMPEG_BIN") or "ffmpeg"
