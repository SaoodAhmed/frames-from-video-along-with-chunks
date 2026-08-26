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

# R2 object key layout (must match the Worker)
def full_frame_key(user_id: str, job_id: str, n: int) -> str:
    return f"users/{user_id}/jobs/{job_id}/frames/full/frame_{n:04d}.jpg"


def thumb_frame_key(user_id: str, job_id: str, n: int) -> str:
    return f"users/{user_id}/jobs/{job_id}/frames/thumbs/frame_{n:04d}.jpg"


def chunk_video_key(user_id: str, job_id: str, n: int) -> str:
    return f"users/{user_id}/jobs/{job_id}/chunks/chunk_{n:04d}.mp4"


def export_key(user_id: str, job_id: str, export_type: str, kind: str = "frames") -> str:
    name = f"{kind}_selected.zip" if export_type == "selected" else f"{kind}_all.zip"
    return f"users/{user_id}/jobs/{job_id}/exports/{name}"


# ffmpeg for stream-copy chunk export (found on PATH; matches local_trimer-5.py)
FFMPEG = os.environ.get("FFMPEG_BIN") or "ffmpeg"
