"""FrameForge serverless processor — runs on Modal.

Entry points:
  - webhook(): triggered by the Worker (HTTP POST) to spawn process/export jobs.
  - sweep(): scheduled poller that picks up queued jobs/exports (safety net).
  - process_job(job_id): OpenCV frame extraction -> R2 -> D1.
  - export_job(export_id): stream frames into a ZIP -> R2.

Deploy:  modal deploy app.py
Requires a Modal secret named `frameforge-secrets` with the PROCESSOR_* vars.
"""

import json
import os
import uuid
import zipfile

import modal
import fastapi

import config
import extractor
import job_manager
import r2_storage

staging = modal.Volume.from_name("frameforge-staging", create_if_missing=True)

image = (
    modal.Image.debian_slim()
    .pip_install(
        "opencv-python-headless>=4.8",
        "pillow>=10.0",
        "numpy>=1.24",
        "boto3>=1.28",
    )
)

app = modal.App("frameforge-processor", image=image)

FRAME_COMMON = dict(
    secrets=[modal.Secret.from_name("frameforge-secrets")],
    volumes={"/staging": staging},
    timeout=3600,
    cpu=2.0,
    memory=2048,
)


@app.function(**FRAME_COMMON)
def process_job(job_id: str):
    job = job_manager.get_job(job_id)
    if not job:
        return {"ok": False, "error": "job not found"}

    if not job_manager.claim_job(job_id):
        return {"ok": False, "error": "job not claimable"}

    safe_name = "".join(c for c in job["original_filename"] if c.isalnum() or c in "._-") or "video.mp4"
    local = f"/staging/{job_id}_{safe_name}"

    try:
        r2_storage.download_video(job["r2_video_key"], local)
    except Exception as e:
        job_manager.fail_job(job_id, f"video download failed: {e}")
        return {"ok": False, "error": str(e)}

    def cancel_check() -> bool:
        try:
            cur = job_manager.get_job(job_id)
            return bool(cur and cur.get("status") == "cancelled")
        except Exception:
            return False

    last_progress = -config.PROGRESS_INTERVAL
    last_width = last_height = None
    src_fps = total = None

    def progress(frame_no: int, total_frames: int):
        nonlocal last_progress
        if frame_no - last_progress >= config.PROGRESS_INTERVAL:
            try:
                job_manager.update_progress(job_id, frame_no, total_frames)
            except Exception:
                pass
            last_progress = frame_no

    try:
        for fr in extractor.extract_frames(
            local,
            job["extraction_fps"],
            sharpness=job["sharpness"] or 1.0,
            scene_threshold=job["scene_threshold"] or config.SCENE_THRESHOLD_DEFAULT,
            should_cancel=cancel_check,
            max_frames=config.MAX_FRAMES,
        ):
            full_key = config.full_frame_key(job["user_id"], job_id, fr["frame_number"])
            thumb_key = config.thumb_frame_key(job["user_id"], job_id, fr["frame_number"])

            r2_storage.upload_bytes(full_key, fr["full_bytes"], "image/jpeg")
            r2_storage.upload_bytes(thumb_key, fr["thumb_bytes"], "image/jpeg")
            job_manager.insert_frame(job_id, fr, full_key)

            src_fps = fr["src_fps"]
            total = fr["total"]
            last_width, last_height = fr["width"], fr["height"]
            progress(fr["processed"], fr["total"])
    except extractor.CancelledError:
        job_manager.cancel_job(job_id)
        return {"ok": True, "status": "cancelled"}
    except Exception as e:
        job_manager.fail_job(job_id, str(e))
        return {"ok": False, "error": str(e)}
    finally:
        try:
            os.remove(local)
        except OSError:
            pass

    duration = (total / src_fps) if total and src_fps else None
    job_manager.complete_job(
        job_id,
        {"src_fps": src_fps, "total": total, "width": last_width, "height": last_height, "duration": duration},
        extracted=0,  # corrected below
    )
    # extracted_frames was updated incrementally? Simpler: recount from D1.
    frames = job_manager.get_frames(job_id)
    job_manager._query(
        "UPDATE jobs SET extracted_frames = ?, updated_at = ? WHERE id = ?",
        [len(frames), job_manager._now(), job_id],
    )
    return {"ok": True, "frames": len(frames)}


@app.function(**FRAME_COMMON)
def export_job(export_id: str):
    exp = job_manager.get_export(export_id)
    if not exp:
        return {"ok": False, "error": "export not found"}
    if not job_manager.claim_export(export_id):
        return {"ok": False, "error": "export not claimable"}

    job = job_manager.get_job(exp["job_id"])
    if not job:
        job_manager.fail_export(export_id, "job not found")
        return {"ok": False, "error": "job not found"}

    frame_ids = None
    if exp["export_type"] == "selected" and exp.get("frame_ids"):
        try:
            frame_ids = json.loads(exp["frame_ids"])
        except Exception:
            frame_ids = None

    try:
        frames = job_manager.get_frames(exp["job_id"], frame_ids)
        zip_path = f"/staging/export_{export_id}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in frames:
                data = r2_storage.get_object(f["r2_key"])
                ts = f"{float(f['timestamp']):.3f}".replace(".", "_")
                name = f"frame_{f['frame_number']:04d}_t{ts}s.jpg"
                zf.writestr(name, data)

        key = config.export_key(job["user_id"], exp["job_id"], exp["export_type"])
        with open(zip_path, "rb") as fh:
            r2_storage.upload_bytes(key, fh.read(), "application/zip")
        size = os.path.getsize(zip_path)
        os.remove(zip_path)
        job_manager.complete_export(export_id, key, size, len(frames))
        return {"ok": True, "frames": len(frames), "size": size}
    except Exception as e:
        job_manager.fail_export(export_id, str(e))
        return {"ok": False, "error": str(e)}


@app.function(secrets=[modal.Secret.from_name("frameforge-secrets")])
@app.function(cpu=0.5, memory=512)
def sweep():
    """Safety net: pick up any queued jobs/exports the webhook missed."""
    spawned = []
    for j in job_manager.get_queued_jobs():
        process_job.spawn(job_id=j["id"])
        spawned.append(("job", j["id"]))
    for e in job_manager.get_queued_exports():
        export_job.spawn(export_id=e["id"])
        spawned.append(("export", e["id"]))
    return {"spawned": spawned}


@app.web_endpoint(method="POST")
async def webhook(request: fastapi.Request):
    auth = request.headers.get("authorization", "")
    token = auth[7:] if auth.lower().startswith("bearer ") else ""
    if config.WEBHOOK_TOKEN and token != config.WEBHOOK_TOKEN:
        return modal.Response({"error": "unauthorized"}, status_code=401)

    try:
        payload = await request.json()
    except Exception:
        return modal.Response({"error": "invalid json"}, status_code=400)

    action = payload.get("action")
    if action == "process" and payload.get("jobId"):
        process_job.spawn(job_id=payload["jobId"])
        return {"accepted": True, "action": "process", "jobId": payload["jobId"]}
    if action == "export" and payload.get("exportId"):
        export_job.spawn(export_id=payload["exportId"])
        return {"accepted": True, "action": "export", "exportId": payload["exportId"]}
    return modal.Response({"error": "unknown action"}, status_code=400)
