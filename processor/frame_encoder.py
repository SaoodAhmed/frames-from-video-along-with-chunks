"""Frame encoding: BGR numpy frame -> compressed JPEG bytes (full + thumbnail)."""

import io

import cv2
from PIL import Image, ImageEnhance

import config


def encode_frame(frame, sharpness: float = 1.0):
    """Return (full_jpeg_bytes, thumb_jpeg_bytes, (width, height)).

    Memory-friendly: only the current frame is materialised; JPEG bytes are
    released by the caller after upload.
    """
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)

    if sharpness != 1.0:
        pil = ImageEnhance.Sharpness(pil).enhance(sharpness)

    w, h = pil.size

    full_buf = io.BytesIO()
    pil.save(full_buf, "JPEG", quality=config.JPEG_QUALITY)

    thumb = pil.resize((config.BASE_THUMB_W, config.BASE_THUMB_H), Image.LANCZOS)
    thumb_buf = io.BytesIO()
    thumb.save(thumb_buf, "JPEG", quality=config.JPEG_QUALITY)

    return full_buf.getvalue(), thumb_buf.getvalue(), (w, h)
