"""Job state management via the Cloudflare D1 HTTP query API.

The processor talks to D1 over HTTPS (it has no Worker binding), so every
state change is a guarded SQL UPDATE (WHERE status = 'X') to keep the
state machine consistent even with concurrent Workers/processors.
"""

import json
import urllib.request
import urllib.error

import config

D1_QUERY_URL = (
    f"https://api.cloudflare.com/client/v4/accounts/{config.D1_ACCOUNT_ID}"
    f"/d1/database/{config.D1_DATABASE_ID}/query"
)


def _query(sql: str, params=None):
    body = json.dumps({"sql": sql, "params": params or []}).encode("utf-8")
    req = urllib.request.Request(
        D1_QUERY_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {config.D1_API_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"D1 HTTP {e.code}: {e.read().decode()[:500]}") from e

    if not data.get("success"):
        raise RuntimeError(f"D1 error: {data.get('errors')}")
    stmt = data["result"][0]
    if not stmt.get("success"):
        raise RuntimeError(f"D1 statement error: {stmt.get('error') or stmt.get('meta')}")
    return stmt


def _first(sql: str, params=None):
    stmt = _query(sql, params)
    results = stmt.get("results") or []
    return results[0] if results else None


def _rows(sql: str, params=None):
    stmt = _query(sql, params)
    return stmt.get("results") or []


# ── Reads ────────────────────────────────────────────────────

def get_job(job_id: str):
    return _first("SELECT * FROM jobs WHERE id = ?", [job_id])


def get_export(export_id: str):
    return _first("SELECT * FROM exports WHERE id = ?", [export_id])


def get_frames(job_id: str, frame_ids=None):
    if frame_ids:
        ph = ",".join("?" * len(frame_ids))
        return _rows(
            f"SELECT * FROM frames WHERE job_id = ? AND deleted = 0 AND id IN ({ph}) ORDER BY frame_number",
            [job_id] + frame_ids,
        )
    return _rows(
        "SELECT * FROM frames WHERE job_id = ? AND deleted = 0 ORDER BY frame_number",
        [job_id],
    )


def get_queued_jobs():
    return _rows("SELECT id FROM jobs WHERE status = 'queued'")


def get_queued_exports():
    return _rows("SELECT id FROM exports WHERE status = 'queued'")


# ── State transitions (guarded) ──────────────────────────────

def claim_job(job_id: str) -> bool:
    """queued -> processing. Returns False if another worker claimed it."""
    stmt = _query(
        "UPDATE jobs SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'",
        [_now(), job_id],
    )
    return (stmt.get("meta") or {}).get("changes", 0) > 0


def update_progress(job_id: str, processed: int, total: int):
    """Only touch progress while the job is actually processing."""
    _query(
        "UPDATE jobs SET processed_frames = ?, total_source_frames = ?, updated_at = ? "
        "WHERE id = ? AND status = 'processing'",
        [processed, total, _now(), job_id],
    )


def complete_job(job_id: str, metadata: dict, extracted: int):
    _query(
        "UPDATE jobs SET status = 'completed', completed_at = ?, updated_at = ?, "
        "extracted_frames = ?, source_fps = ?, total_source_frames = ?, "
        "width = ?, height = ?, duration = ?, error_message = NULL "
        "WHERE id = ? AND status = 'processing'",
        [
            _now(),
            _now(),
            extracted,
            metadata.get("src_fps"),
            metadata.get("total"),
            metadata.get("width"),
            metadata.get("height"),
            metadata.get("duration"),
            job_id,
        ],
    )


def fail_job(job_id: str, message: str):
    _query(
        "UPDATE jobs SET status = 'failed', updated_at = ?, error_message = ? "
        "WHERE id = ? AND status IN ('processing', 'queued')",
        [_now(), message[:2000], job_id],
    )


def cancel_job(job_id: str):
    _query(
        "UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'processing'",
        [_now(), job_id],
    )


def insert_frame(job_id: str, fr: dict, full_key: str):
    import uuid

    _query(
        "INSERT INTO frames (id, job_id, frame_number, source_frame_number, timestamp, r2_key, width, height, deleted, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
        [
            str(uuid.uuid4()),
            job_id,
            fr["frame_number"],
            fr["source_frame_number"],
            fr["timestamp"],
            full_key,
            fr["width"],
            fr["height"],
            _now(),
        ],
    )


def claim_export(export_id: str) -> bool:
    stmt = _query(
        "UPDATE exports SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'",
        [_now(), export_id],
    )
    return (stmt.get("meta") or {}).get("changes", 0) > 0


def complete_export(export_id: str, r2_key: str, file_size: int, frame_count: int):
    _query(
        "UPDATE exports SET status = 'completed', completed_at = ?, updated_at = ?, "
        "r2_key = ?, file_size = ?, frame_count = ?, error_message = NULL "
        "WHERE id = ? AND status = 'processing'",
        [_now(), _now(), r2_key, file_size, frame_count, export_id],
    )


def fail_export(export_id: str, message: str):
    _query(
        "UPDATE exports SET status = 'failed', updated_at = ?, error_message = ? "
        "WHERE id = ? AND status IN ('processing', 'queued')",
        [_now(), message[:2000], export_id],
    )


def _now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
