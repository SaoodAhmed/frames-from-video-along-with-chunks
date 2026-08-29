#!/usr/bin/env python3
"""Local FrameForge extraction runner (no Modal needed).

Polls the Worker for queued jobs and extracts frames using the same OpenCV
logic as the serverless processor.

Frame JPEGs are written DIRECTLY to R2 via boto3 (the R2 S3 credentials come
from the repo .env R2_* vars), so the heavy bytes never cross the Worker proxy.
Only the small D1 state changes (frames-row insert, progress, complete/fail) go
through the Worker's /api/processor/* routes.

Needs:
    WORKER_BASE_URL  (default https://frameforge.ahmedsauddd128.workers.dev)
    PROCESSOR_TOKEN  (matches the Worker's PROCESSOR_TOKEN secret)

Usage:
    WORKER_BASE_URL=... PROCESSOR_TOKEN=... python processor/local_runner.py
    python processor/local_runner.py --once   # process current queue and exit
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

import boto3
import cv2
import requests
from botocore.config import Config as BotoConfig
from PIL import Image

# config.py requires the PROCESSOR_* vars at import. Satisfy them from the
# repo's .env (read-only) so the runner stays self-contained.
def _load_dotenv(path):
    env = {}
    try:
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    except OSError:
        pass
    return env


_ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
_DOTENV = _load_dotenv(_ENV_FILE)

# .env key -> config.py env var (config expects PROCESSOR_R2_BUCKET, not _NAME)
for _src, _dst in (
    ("R2_ACCOUNT_ID", "PROCESSOR_R2_ACCOUNT_ID"),
    ("R2_ACCESS_KEY_ID", "PROCESSOR_R2_ACCESS_KEY_ID"),
    ("R2_SECRET_ACCESS_KEY", "PROCESSOR_R2_SECRET_ACCESS_KEY"),
    ("R2_BUCKET_NAME", "PROCESSOR_R2_BUCKET"),
    ("R2_ENDPOINT", "PROCESSOR_R2_ENDPOINT"),
):
    if _DOTENV.get(_src) and not os.environ.get(_dst):
        os.environ[_dst] = _DOTENV[_src]
# D1 writes route through the Worker, so the D1 client vars are just placeholders.
for _k in ("PROCESSOR_D1_ACCOUNT_ID", "PROCESSOR_D1_DATABASE_ID", "PROCESSOR_D1_API_TOKEN"):
    os.environ.setdefault(_k, "unused")

import config  # noqa: E402
import extractor  # noqa: E402
import scene_chunks  # noqa: E402

BASE = os.environ.get("WORKER_BASE_URL", "https://frameforge.ahmedsauddd128.workers.dev").rstrip("/")
TOKEN = os.environ.get("PROCESSOR_TOKEN", "").strip()
POLL_INTERVAL = float(os.environ.get("PROCESSOR_POLL_INTERVAL", "5"))
PROGRESS_EVERY = config.PROGRESS_INTERVAL
RETRIES = int(os.environ.get("PROCESSOR_RETRIES", "4"))

R2 = boto3.client(
    "s3",
    endpoint_url=config.R2_ENDPOINT,
    aws_access_key_id=config.R2_ACCESS_KEY_ID,
    aws_secret_access_key=config.R2_SECRET_ACCESS_KEY,
    region_name="auto",
    config=BotoConfig(retries={"max_attempts": 4, "mode": "standard"}),
)
R2_BUCKET = config.R2_BUCKET

TRANSIENT = (0, 408, 429, 500, 502, 503, 504)


class JobAborted(Exception):
    """Job left 'processing' (cancelled/re-queued) — stop cleanly, no /fail."""


def _headers(content_type="application/json"):
    h = {"Authorization": f"Bearer {TOKEN}"}
    if content_type:
        h["Content-Type"] = content_type
    return h


def _req(method, path, body=None, raw_body=None, content_type="application/json", timeout=300):
    # urllib's TLS/HTTP stack is flagged by Cloudflare bot protection (403 /
    # stalled reads); `requests` (urllib3) passes cleanly, so all Worker calls go
    # through requests.
    ct = content_type if raw_body is None else (content_type or "application/octet-stream")
    try:
        resp = requests.request(
            method,
            f"{BASE}{path}",
            data=raw_body if raw_body is not None else json.dumps(body or {}),
            headers=_headers(ct),
            timeout=timeout,
        )
    except requests.RequestException as e:
        return 0, {"error": f"request failed: {e}"}
    try:
        return resp.status_code, resp.json() if resp.text else {}
    except ValueError:
        return resp.status_code, {"error": resp.text[:500]}


def _req_ok(method, path, body=None, raw_body=None, content_type="application/json", timeout=300, what="request"):
    """Worker call with retry/backoff. 409 -> JobAborted. 200 -> parsed JSON."""
    status, data = 0, {}
    for attempt in range(RETRIES):
        status, data = _req(method, path, body, raw_body, content_type, timeout)
        if status in TRANSIENT and attempt < RETRIES - 1:
            wait = 2 ** attempt
            print(f"  retry {what} ({attempt + 1}/{RETRIES}) after {wait}s: HTTP {status}", flush=True)
            time.sleep(wait)
            continue
        break
    if status == 409:
        raise JobAborted(data.get("error") or "job left processing")
    if status != 200:
        raise RuntimeError(f"{what} failed HTTP {status}: {data}")
    return data


def _put_r2(key, data, content_type):
    R2.put_object(Bucket=R2_BUCKET, Key=key, Body=data, ContentType=content_type)


def _put_r2_retry(key, data, content_type, what):
    for attempt in range(RETRIES):
        try:
            _put_r2(key, data, content_type)
            return
        except Exception as e:  # noqa: BLE001
            if attempt >= RETRIES - 1:
                raise RuntimeError(f"giving up on R2 {what}: {e}")
            wait = 2 ** attempt
            print(f"  retry R2 {what} ({attempt + 1}/{RETRIES}) after {wait}s: {e}", flush=True)
            time.sleep(wait)


def _r2_get_bytes(key):
    """Download an R2 object to memory (frames/chunks are small enough)."""
    obj = R2.get_object(Bucket=R2_BUCKET, Key=key)
    return obj["Body"].read()


def _download_r2(key, dest):
    """Stream an R2 object to a local file (used for chunk videos)."""
    obj = R2.get_object(Bucket=R2_BUCKET, Key=key)
    with open(dest, "wb") as f:
        shutil.copyfileobj(obj["Body"], f)


def _run_ffmpeg(args, timeout=600):
    """Run ffmpeg with the stream-copy flags from the desktop app; raise on failure."""
    if shutil.which(config.FFMPEG) is None:
        raise RuntimeError("ffmpeg not found on PATH — required for chunk splitting")
    cmd = [
        config.FFMPEG,
        "-y",
    ] + list(args)
    kw = {"creationflags": 0x08000000} if os.name == "nt" else {}  # CREATE_NO_WINDOW
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, **kw)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode(errors="replace")[-400:])


def _optimize_filter(maxdim):
    """scale filter for optimization: cap width at maxdim (height follows aspect),
    both rounded to even for yuv420p; without maxdim just force even dimensions so
    odd-sized sources still encode."""
    if maxdim:
        return f"scale='min({maxdim},iw)':-2"
    return "scale=trunc(iw/2)*2:trunc(ih/2)*2"


def _user_segment(job):
    """R2 key segment for a job: the email (new uploads) or legacy uid. Always
    derived from the stored r2_video_key (`users/{segment}/jobs/...`) so old and
    new jobs work identically."""
    key = job.get("r2_video_key") or ""
    if key.startswith("users/"):
        parts = key.split("/")
        if len(parts) > 1:
            return parts[1]
    return job.get("user_id") or ""


def get_queue():
    _, data = _req("GET", "/api/processor/queue")
    return data.get("jobs") or []


def get_chunk_queue():
    _, data = _req("GET", "/api/processor/queue/chunks")
    return data.get("jobs") or []


def get_export_queue():
    _, data = _req("GET", "/api/processor/exports/queue")
    return data.get("exports") or []


def get_optimize_queue():
    _, data = _req("GET", "/api/processor/queue/optimize")
    return data.get("jobs") or []


def get_frameopt_queue():
    _, data = _req("GET", "/api/processor/queue/frameopts")
    return data.get("batches") or []


def process_job(job_id):
    print(f"[{job_id}] claim", flush=True)
    status, data = _req("POST", f"/api/processor/claim/{job_id}")
    if status != 200:
        print(f"[{job_id}] claim failed {status}: {data}", flush=True)
        return
    job = data.get("job") or {}
    seg = _user_segment(job)

    local = None
    try:
        print(f"[{job_id}] fetching video URL", flush=True)
        _, vdata = _req("GET", f"/api/processor/video/{job_id}")
        url = vdata.get("url")
        if not url:
            raise RuntimeError("no video URL returned")

        safe = "".join(c for c in (job.get("original_filename") or "video.mp4") if c.isalnum() or c in "._-") or "video.mp4"
        local = os.path.join(tempfile.gettempdir(), f"frameforge_{job_id}_{safe}")
        print(f"[{job_id}] downloading to {local}", flush=True)
        with requests.get(url, stream=True, timeout=300) as resp:
            resp.raise_for_status()
            with open(local, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    if chunk:
                        f.write(chunk)

        fps = job.get("extraction_fps")
        if fps is None:
            fps = 1.0
        sharpness = float(job.get("sharpness") or 1.0)
        scene_threshold = float(job.get("scene_threshold") or config.SCENE_THRESHOLD_DEFAULT)

        gen = extractor.extract_frames(local, fps, sharpness=sharpness, scene_threshold=scene_threshold)
        count = 0
        meta = None
        last_progress = -PROGRESS_EVERY
        for fr in gen:
            count += 1
            fn = fr["frame_number"]
            full_key = config.full_frame_key(seg, job_id, fn)
            thumb_key = config.thumb_frame_key(seg, job_id, fn)
            _put_r2_retry(full_key, fr["full_bytes"], "image/jpeg", f"full {fn}")
            _put_r2_retry(thumb_key, fr["thumb_bytes"], "image/jpeg", f"thumb {fn}")
            q = f"?src={fr['source_frame_number']}&t={fr['timestamp']:.3f}&w={fr['width']}&h={fr['height']}"
            _req_ok("POST", f"/api/processor/frame/{job_id}/{fn}/meta{q}", what=f"meta {fn}")

            if count - last_progress >= PROGRESS_EVERY or fr["frame_number"] % max(1, fr["total"] or 1) == 0:
                _req_ok("POST", f"/api/processor/progress/{job_id}",
                        {"processed": fr["processed"], "total": fr["total"]}, what="progress")
                last_progress = count
            meta = fr
            print(f"[{job_id}] frame {fn}/{meta['total']}", flush=True)

        if meta is None:
            raise RuntimeError("no frames extracted")

        # Video poster for the user-gallery card: first try 1s in (fast seek),
        # fall back to the first frame, then give up silently if ffmpeg can't.
        poster_key = config.video_thumb_key(seg, job_id)
        poster_path = os.path.join(tempfile.gettempdir(), f"frameforge_poster_{job_id}.jpg")
        poster_ok = False
        try:
            _run_ffmpeg(["-ss", "1", "-i", local, "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", poster_path])
        except Exception:
            try:
                _run_ffmpeg(["-i", local, "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", poster_path])
            except Exception:
                poster_path = None
        if poster_path and os.path.exists(poster_path) and os.path.getsize(poster_path) > 0:
            with open(poster_path, "rb") as f:
                _put_r2_retry(poster_key, f.read(), "image/jpeg", "video poster")
            os.remove(poster_path)
            poster_ok = True

        complete_body = {
            "srcFps": meta["src_fps"],
            "total": meta["total"],
            "width": meta["width"],
            "height": meta["height"],
            "duration": (meta["total"] / meta["src_fps"]) if meta["src_fps"] else 0,
            "extracted": count,
        }
        if poster_ok:
            complete_body["videoThumbKey"] = poster_key
        s, cdata = _req("POST", f"/api/processor/complete/{job_id}", complete_body)
        print(f"[{job_id}] complete {s}: {cdata}", flush=True)
    except JobAborted as e:
        print(f"[{job_id}] aborted: {e}", flush=True)
    except Exception as e:
        print(f"[{job_id}] ERROR: {e}", flush=True)
        _req("POST", f"/api/processor/fail/{job_id}", {"message": str(e)})
    finally:
        if local and os.path.exists(local):
            try:
                os.remove(local)
            except OSError:
                pass


def process_chunks(job_id):
    """Scene-change splitting: ffmpeg stream-copy each chunk -> direct R2 upload."""
    print(f"[{job_id}] chunk claim", flush=True)
    status, data = _req("POST", f"/api/processor/chunk/claim/{job_id}")
    if status != 200:
        print(f"[{job_id}] chunk claim failed {status}: {data}", flush=True)
        return
    job = data.get("job") or {}
    seg = _user_segment(job)

    local = None
    tmpdir = None
    try:
        print(f"[{job_id}] fetching video URL for chunk split", flush=True)
        _, vdata = _req("GET", f"/api/processor/video/{job_id}")
        url = vdata.get("url")
        if not url:
            raise RuntimeError("no video URL returned")

        safe = "".join(c for c in (job.get("original_filename") or "video.mp4") if c.isalnum() or c in "._-") or "video.mp4"
        local = os.path.join(tempfile.gettempdir(), f"frameforge_chunk_{job_id}_{safe}")
        print(f"[{job_id}] downloading to {local}", flush=True)
        with requests.get(url, stream=True, timeout=600) as resp:
            resp.raise_for_status()
            with open(local, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    if chunk:
                        f.write(chunk)

        cap = cv2.VideoCapture(local)
        if not cap.isOpened():
            raise RuntimeError("cannot open downloaded video")
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or None
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or None
        cap.release()
        duration = (total / src_fps) if total and src_fps else 0.0

        chunks = scene_chunks.detect_scene_chunks(local, src_fps, end_sec=duration)
        if not chunks:
            raise RuntimeError("scene detection produced no chunks")

        tmpdir = tempfile.mkdtemp(prefix=f"frameforge_chunks_{job_id}_")
        print(f"[{job_id}] {len(chunks)} chunk(s) detected", flush=True)
        for i, (cs, ce) in enumerate(chunks, start=1):
            out_path = os.path.join(tmpdir, f"chunk_{i:04d}.mp4")
            dur = ce - cs
            # Re-encode (like local_trimer-6.py) so cuts are frame-accurate and
            # chunks are exactly contiguous — stream-copy rounds to keyframes.
            _run_ffmpeg([
                "-ss", f"{cs:.6f}",
                "-i", local,
                "-t", f"{dur:.6f}",
                "-c:v", "libx264",
                "-crf", "18",
                "-preset", "fast",
                "-c:a", "aac",
                "-b:a", "192k",
                "-pix_fmt", "yuv420p",
                "-avoid_negative_ts", "make_zero",
                "-movflags", "+faststart",
                out_path,
            ])
            size = os.path.getsize(out_path)
            if size == 0:
                raise RuntimeError(f"ffmpeg produced empty chunk {i}")

            key = config.chunk_video_key(seg, job_id, i)
            with open(out_path, "rb") as f:
                _put_r2_retry(key, f.read(), "video/mp4", f"chunk {i}")
            os.remove(out_path)

            q = (
                f"?start={cs:.6f}&end={ce:.6f}&duration={dur:.6f}"
                f"&size={size}&w={width}&h={height}&fps={src_fps:.6f}"
            )
            _req_ok("POST", f"/api/processor/chunk/{job_id}/{i}/meta{q}", what=f"chunk meta {i}")

            if i % max(1, len(chunks) // 10) == 0 or i == len(chunks):
                _req_ok("POST", f"/api/processor/chunk/progress/{job_id}",
                        {"processed": i, "total": len(chunks)}, what="chunk progress")
            print(f"[{job_id}] chunk {i}/{len(chunks)} ({cs:.2f}-{ce:.2f}s)", flush=True)

        _req_ok("POST", f"/api/processor/chunk/complete/{job_id}", {
            "count": len(chunks),
            "duration": duration,
            "width": width,
            "height": height,
            "srcFps": src_fps,
        }, what="chunk complete")
        print(f"[{job_id}] chunks complete: {len(chunks)}", flush=True)
    except JobAborted as e:
        print(f"[{job_id}] chunk aborted: {e}", flush=True)
    except Exception as e:
        print(f"[{job_id}] chunk ERROR: {e}", flush=True)
        _req("POST", f"/api/processor/chunk/fail/{job_id}", {"message": str(e)})
    finally:
        if local and os.path.exists(local):
            try:
                os.remove(local)
            except OSError:
                pass
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


def _smart_resize(img, max_dim):
    """Aspect-preserving downscale to fit within max_dim (mirrors tikinn-2.py)."""
    w, h = img.size
    if max(w, h) <= max_dim:
        return img
    ratio = max_dim / max(w, h)
    return img.resize((max(1, round(w * ratio)), max(1, round(h * ratio))), Image.LANCZOS)


def _save_image(img, fmt, quality, out_path):
    """Encode `img` as `fmt` at `quality` using tikinn-2.py's per-format settings.
    Returns the MIME content type."""
    fmt = (fmt or "webp").lower()
    if fmt == "jpeg":
        # Flatten RGBA onto white instead of dropping alpha onto black.
        if img.mode == "RGBA":
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[-1])
            im = bg
        else:
            im = img.convert("RGB")
        im.save(out_path, "JPEG", quality=quality, optimize=True, progressive=True)
        return "image/jpeg"
    if fmt == "avif":
        im = img.convert("RGB") if img.mode == "RGBA" else img
        im.save(out_path, "AVIF", quality=quality, speed=7)
        return "image/avif"
    if fmt == "png":
        im = img.convert("RGBA") if img.mode not in ("RGB", "RGBA") else img
        im.save(out_path, "PNG", optimize=True, compress_level=max(1, min(9, int((100 - quality) / 11))))
        return "image/png"
    # webp (default)
    im = img.convert("RGBA") if img.mode not in ("RGB", "RGBA") else img
    im.save(out_path, "WEBP", quality=quality, method=6, lossless=False)
    return "image/webp"


def _process_image(job_id, job, optimized_key):
    """Pillow resize -> any format (webp/jpeg/avif/png) + JPEG thumb, both written
    directly to R2. Format/quality/maxdim follow the job's opt_* fields.
    Images need no cv2/ffmpeg."""
    fmt = job.get("opt_format") or "webp"
    quality = int(job.get("opt_quality") or 85)
    maxdim = job.get("opt_max_dim")
    if maxdim:
        maxdim = int(maxdim)
    thumb_key = job.get("optimized_thumb_key")

    print(f"[{job_id}] fetching image URL for optimize", flush=True)
    _, vdata = _req("GET", f"/api/processor/video/{job_id}")
    url = vdata.get("url")
    if not url:
        raise RuntimeError("no source URL returned")

    local = None
    out_path = None
    thumb_path = None
    try:
        local = os.path.join(tempfile.gettempdir(), f"frameforge_img_{job_id}")
        print(f"[{job_id}] downloading to {local}", flush=True)
        with requests.get(url, stream=True, timeout=300) as resp:
            resp.raise_for_status()
            with open(local, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    if chunk:
                        f.write(chunk)

        img = Image.open(local)
        img.load()
        if maxdim:
            img = _smart_resize(img, maxdim)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")

        out_path = os.path.join(tempfile.gettempdir(), f"frameforge_img_out_{job_id}")
        ct = _save_image(img, fmt, quality, out_path)

        size = os.path.getsize(out_path)
        if size == 0:
            raise RuntimeError("Pillow produced empty output")

        # Abort check + metadata heartbeat (409 here -> cancelled, stop cleanly).
        _req_ok("POST", f"/api/processor/optimize/{job_id}/meta",
                {"size": size, "duration": 0}, what="optimize meta")

        with open(out_path, "rb") as f:
            _put_r2_retry(optimized_key, f.read(), ct, "optimized image")

        if thumb_key:
            thumb_path = os.path.join(tempfile.gettempdir(), f"frameforge_img_thumb_{job_id}")
            thumb = img.copy()
            thumb.thumbnail((400, 400), Image.LANCZOS)
            thumb = thumb.convert("RGB") if thumb.mode == "RGBA" else thumb
            thumb.save(thumb_path, "JPEG", quality=75)
            with open(thumb_path, "rb") as f:
                _put_r2_retry(thumb_key, f.read(), "image/jpeg", "optimized thumb")

        _req_ok("POST", f"/api/processor/optimize/complete/{job_id}",
                {"size": size, "duration": 0, "format": fmt}, what="optimize complete")
        print(f"[{job_id}] image optimize complete: {size} bytes ({fmt} q{quality})", flush=True)
    finally:
        for p in (local, out_path, thumb_path):
            if p and os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass


def process_optimize(job_id):
    """H.264 transcode (video) or Pillow resize/convert (image) -> direct R2 upload.

    The abort check is the meta call right after the transcode: if the admin
    cancelled the job the meta returns 409 and we stop before uploading anything.
    """
    print(f"[{job_id}] optimize claim", flush=True)
    status, data = _req("POST", f"/api/processor/optimize/claim/{job_id}")
    if status != 200:
        print(f"[{job_id}] optimize claim failed {status}: {data}", flush=True)
        return
    job = data.get("job") or {}
    optimized_key = job.get("optimized_key")
    crf = int(job.get("opt_crf") or 23)
    codec = job.get("opt_codec") or "libx264"
    container = job.get("opt_container") or "mp4"
    maxdim = job.get("opt_max_dim")
    if maxdim:
        maxdim = int(maxdim)

    local = None
    out_path = None
    try:
        if not optimized_key:
            raise RuntimeError("no optimized_key set on job")
        if job.get("media_type") == "image":
            _process_image(job_id, job, optimized_key)
            return
        print(f"[{job_id}] fetching video URL for optimize", flush=True)
        _, vdata = _req("GET", f"/api/processor/video/{job_id}")
        url = vdata.get("url")
        if not url:
            raise RuntimeError("no video URL returned")

        safe = "".join(c for c in (job.get("original_filename") or "video.mp4") if c.isalnum() or c in "._-") or "video.mp4"
        local = os.path.join(tempfile.gettempdir(), f"frameforge_opt_in_{job_id}_{safe}")
        out_ext = container if container in ("mp4", "mkv", "webm") else "mp4"
        out_path = os.path.join(tempfile.gettempdir(), f"frameforge_opt_out_{job_id}.{out_ext}")
        print(f"[{job_id}] downloading to {local}", flush=True)
        with requests.get(url, stream=True, timeout=600) as resp:
            resp.raise_for_status()
            with open(local, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    if chunk:
                        f.write(chunk)

        # webm cannot carry H.264 — force AV1 (mirrors tikinn-2.py).
        if container == "webm" and codec != "libsvtav1":
            codec = "libsvtav1"
        args = ["-i", local, "-map", "0:v:0", "-c:v", codec, "-crf", str(crf)]
        if codec == "libsvtav1":
            args += ["-preset", "6", "-map", "0:a:0?", "-c:a", "libopus", "-b:a", "96k"]
        else:
            args += ["-preset", "medium", "-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k"]
        args += ["-vf", _optimize_filter(maxdim)]
        if container == "mp4":
            args += ["-movflags", "+faststart"]
        args += ["-pix_fmt", "yuv420p", out_path]

        print(f"[{job_id}] transcoding ({container}/{codec}, crf={crf}, maxdim={maxdim or 'none'})", flush=True)
        _run_ffmpeg(args, timeout=1800)

        size = os.path.getsize(out_path)
        if size == 0:
            raise RuntimeError("ffmpeg produced empty output")

        cap = cv2.VideoCapture(out_path)
        out_fps = cap.get(cv2.CAP_PROP_FPS) or 0
        out_total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        duration = (out_total / out_fps) if out_fps and out_total else 0.0

        ct = {"mp4": "video/mp4", "webm": "video/webm", "mkv": "video/x-matroska"}.get(out_ext, "video/mp4")

        # Abort check + metadata heartbeat (409 here -> cancelled, stop cleanly).
        _req_ok("POST", f"/api/processor/optimize/{job_id}/meta",
                {"size": size, "duration": duration}, what="optimize meta")

        with open(out_path, "rb") as f:
            _put_r2_retry(optimized_key, f.read(), ct, "optimized video")

        _req_ok("POST", f"/api/processor/optimize/complete/{job_id}",
                {"size": size, "duration": duration}, what="optimize complete")
        print(f"[{job_id}] optimize complete: {size} bytes ({out_ext}/{codec})", flush=True)
    except JobAborted as e:
        print(f"[{job_id}] optimize aborted: {e}", flush=True)
    except Exception as e:
        print(f"[{job_id}] optimize ERROR: {e}", flush=True)
        _req("POST", f"/api/processor/optimize/fail/{job_id}", {"message": str(e)})
    finally:
        for p in (local, out_path):
            if p and os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass


def process_export(export_id):
    """Build a ZIP of frames/chunks from R2 and upload it back to R2."""
    print(f"[{export_id}] export claim", flush=True)
    status, data = _req("POST", f"/api/processor/exports/{export_id}/claim")
    if status != 200:
        print(f"[{export_id}] export claim failed {status}: {data}", flush=True)
        return

    tmpdir = None
    try:
        s, edata = _req("GET", f"/api/processor/exports/{export_id}")
        if s != 200:
            raise RuntimeError(f"fetch export failed HTTP {s}: {edata}")
        export_key = edata.get("exportKey")
        items = edata.get("items") or []
        if not export_key or not items:
            raise RuntimeError("export has no target key or items")

        tmpdir = tempfile.mkdtemp(prefix=f"frameforge_export_{export_id}_")
        zip_path = os.path.join(tmpdir, "export.zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for it in items:
                key = it.get("key")
                name = it.get("name") or os.path.basename(key or "item")
                item_path = os.path.join(tmpdir, name)
                _download_r2(key, item_path)
                zf.write(item_path, name)
                os.remove(item_path)

        size = os.path.getsize(zip_path)
        with open(zip_path, "rb") as f:
            _put_r2_retry(export_key, f.read(), "application/zip", "export zip")

        _req_ok("POST", f"/api/processor/exports/{export_id}/complete", {
            "r2Key": export_key,
            "fileSize": size,
            "count": len(items),
        }, what="export complete")
        print(f"[{export_id}] export complete: {len(items)} item(s), {size} bytes", flush=True)
    except JobAborted as e:
        print(f"[{export_id}] export aborted: {e}", flush=True)
        _req("POST", f"/api/processor/exports/{export_id}/fail", {"message": str(e)})
    except Exception as e:
        print(f"[{export_id}] export ERROR: {e}", flush=True)
        _req("POST", f"/api/processor/exports/{export_id}/fail", {"message": str(e)})
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


def process_frame_opt(batch_id):
    """Re-encode selected frame images (opt_batch) to a chosen format -> direct R2."""
    print(f"[{batch_id}] frameopt claim", flush=True)
    status, data = _req("POST", f"/api/processor/frameopt/claim/{batch_id}")
    if status != 200:
        print(f"[{batch_id}] frameopt claim failed {status}: {data}", flush=True)
        return
    batch = data.get("batch") or {}
    job = data.get("job") or {}
    frames = data.get("frames") or []
    if not batch or not frames:
        print(f"[{batch_id}] frameopt: no batch/frames in claim", flush=True)
        return

    job_id = batch.get("job_id") or job.get("id") or ""
    seg = _user_segment(job)
    fmt = batch.get("format") or "webp"
    quality = int(batch.get("quality") or 85)
    maxdim = batch.get("max_dim")
    if maxdim:
        maxdim = int(maxdim)

    tmpdir = tempfile.mkdtemp(prefix=f"frameforge_frameopt_{batch_id}_")
    processed = 0
    try:
        for fr in frames:
            fn = fr.get("frame_number")
            if not fn:
                continue
            print(f"[{batch_id}] frameopt {processed + 1}/{len(frames)} (frame {fn})", flush=True)
            s, sdata = _req("GET", f"/api/processor/frameopt/{batch_id}/source/{fn}")
            if s != 200:
                raise RuntimeError(f"source frame {fn} failed HTTP {s}: {sdata}")
            url = sdata.get("url")
            if not url:
                raise RuntimeError(f"no source URL for frame {fn}")

            src = os.path.join(tmpdir, f"src_{fn}.jpg")
            with requests.get(url, stream=True, timeout=300) as resp:
                resp.raise_for_status()
                with open(src, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1 << 20):
                        if chunk:
                            fh.write(chunk)

            img = Image.open(src)
            img.load()
            if maxdim:
                img = _smart_resize(img, maxdim)
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA")

            out_path = os.path.join(tmpdir, f"out_{fn}")
            ct = _save_image(img, fmt, quality, out_path)
            size = os.path.getsize(out_path)
            if size == 0:
                raise RuntimeError(f"frameopt produced empty output for frame {fn}")

            dst = config.optimized_frame_key(seg, job_id, fmt, fn)
            with open(out_path, "rb") as fh:
                _put_r2_retry(dst, fh.read(), ct, f"opt frame {fn}")
            os.remove(src)
            os.remove(out_path)

            processed += 1
            # Heartbeat + processed counter. 409 -> batch no longer processing.
            _req_ok("POST", f"/api/processor/frameopt/{batch_id}/meta",
                    {"processed": processed}, what="frameopt meta")

        _req_ok("POST", f"/api/processor/frameopt/complete/{batch_id}", {}, what="frameopt complete")
        print(f"[{batch_id}] frameopt complete: {processed}/{len(frames)}", flush=True)
    except JobAborted as e:
        print(f"[{batch_id}] frameopt aborted: {e}", flush=True)
    except Exception as e:
        print(f"[{batch_id}] frameopt ERROR: {e}", flush=True)
        _req("POST", f"/api/processor/frameopt/fail/{batch_id}", {"message": str(e)})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def main():
    once = "--once" in sys.argv
    print(f"FrameForge local runner — worker={BASE} poll={POLL_INTERVAL}s once={once}", flush=True)
    while True:
        try:
            jobs = get_queue()
            if jobs:
                print(f"queue: {len(jobs)} frame-job(s) -> {jobs}", flush=True)
            for jid in jobs:
                process_job(jid)

            chunk_jobs = get_chunk_queue()
            if chunk_jobs:
                print(f"chunk queue: {len(chunk_jobs)} job(s) -> {chunk_jobs}", flush=True)
            for jid in chunk_jobs:
                process_chunks(jid)

            exports = get_export_queue()
            if exports:
                print(f"export queue: {len(exports)} export(s) -> {exports}", flush=True)
            for eid in exports:
                process_export(eid)

            optimize_jobs = get_optimize_queue()
            if optimize_jobs:
                print(f"optimize queue: {len(optimize_jobs)} job(s) -> {optimize_jobs}", flush=True)
            for jid in optimize_jobs:
                process_optimize(jid)

            frameopts = get_frameopt_queue()
            if frameopts:
                print(f"frameopt queue: {len(frameopts)} batch(es) -> {frameopts}", flush=True)
            for bid in frameopts:
                process_frame_opt(bid)
        except Exception as e:
            print(f"poll error: {e}", flush=True)
        if once:
            return
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
