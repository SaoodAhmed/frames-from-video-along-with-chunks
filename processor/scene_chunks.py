"""Scene-change chunk detection — ported from local_trimer-6.py (Batch Video Trimmer).

Frame-accurate adaptive scene split:
  * No manual threshold — automatically detects background changes.
  * Every exported chunk has a visually different background.
  * Uses the running-average reference method to find natural boundaries.

Algorithm (faithful port of local_trimer-6.py `_detect_scene_chunks`):
  1. Every single frame is scanned (frame-accurate).
  2. A lightweight pre-filter (frame-to-frame absdiff < 0.008) skips static frames.
  3. On frames with motion, 8 visual metrics are extracted:
        HSV 2-D histogram (color grading / background)
        grayscale histogram (brightness distribution)
        saturation histogram (color intensity)
        value histogram (lighting / exposure)
        3x3 spatial grid means (layout / objects / movement)
        Canny edge density (composition / camera angle)
        Laplacian texture energy (environment / surface detail)
        mean brightness (overall lighting)
  4. A weighted score vs a running-average reference decides a scene change.
  5. A hard single-frame cut (diff > 0.15) also confirms a boundary.
  6. A 0.3 s cooldown after each change avoids duplicate splits.
  7. Boundaries are frame numbers / fps, contiguous and gap-free.

Returns a list of contiguous (start_sec, end_sec) chunks covering [start_sec, end_sec].
"""

import cv2
import numpy as np

# ── Tunables (mirror local_trimer-6.py) ───────────────────────────────────────
HIST_BINS_H = 50
HIST_BINS_S = 60
GRAY_BINS = 256
SAT_VAL_BINS = 32
CANNY_LO = 50
CANNY_HI = 150
STATIC_DIFF = 0.008      # absdiff mean below this -> frame skipped (static)
HARD_CUT_DIFF = 0.15     # absdiff mean above this -> forced scene boundary
SCORE_THRESHOLD = 0.04   # weighted score above this -> scene change
COOLDOWN_S = 0.3         # seconds of cooldown after a confirmed change
# Metric weights (each reflects importance in detecting a visual change)
W_HSV = 2.5
W_GRAY = 1.5
W_SAT = 1.5
W_VAL = 1.5
W_GRID = 4.0
W_TEX = 1.0
W_BRI = 3.0
W_EDGE = 2.0


def _hsv_hist(hsv):
    h = cv2.calcHist([hsv], [0, 1], None, [HIST_BINS_H, HIST_BINS_S], [0, 180, 0, 256])
    cv2.normalize(h, h)
    return h


def _gray_hist(gray):
    h = cv2.calcHist([gray], [0], None, [GRAY_BINS], [0, 256])
    cv2.normalize(h, h)
    return h


def _sat_hist(hsv):
    h = cv2.calcHist([hsv], [1], None, [SAT_VAL_BINS], [0, 256])
    cv2.normalize(h, h)
    return h


def _val_hist(hsv):
    h = cv2.calcHist([hsv], [2], None, [SAT_VAL_BINS], [0, 256])
    cv2.normalize(h, h)
    return h


def _grid3x3(gray):
    hh, ww = gray.shape
    chh, cww = max(hh // 3, 1), max(ww // 3, 1)
    return np.array(
        [
            float(gray[r * chh:(r + 1) * chh, c * cww:(c + 1) * cww].mean()) / 255.0
            for r in range(3) for c in range(3)
        ],
        dtype=np.float32,
    )


def _edge_density(gray):
    e = cv2.Canny(gray, CANNY_LO, CANNY_HI)
    return float(np.count_nonzero(e)) / max(e.size, 1)


def _texture_energy(gray):
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def detect_scene_chunks(video_path, fps, start_sec=0.0, end_sec=None, progress=None):
    """
    Return [(start_sec, end_sec), ...] for `video_path`.

    fps: source frames-per-second (used to map frames <-> seconds).
    start_sec/end_sec: trim window; end_sec defaults to the video duration.
    progress: optional callable(percent: float) invoked occasionally.
    """
    if end_sec is None:
        cap0 = cv2.VideoCapture(video_path)
        total = int(cap0.get(cv2.CAP_PROP_FRAME_COUNT))
        cap0.release()
        end_sec = (total / fps) if (total and fps) else 0.0

    if end_sec <= start_sec:
        return [(start_sec, end_sec)]

    fps = max(fps, 1.0)
    start_f = int(start_sec * fps)
    end_f = max(start_f + 1, int(end_sec * fps))
    total_scan = end_f - start_f

    cap = cv2.VideoCapture(video_path)
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_f)
    try:
        # ── Seed running averages from the first frame ────────────────────
        ok, first = cap.read()
        if not ok:
            return [(start_sec, end_sec)]

        g0 = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
        h0 = cv2.cvtColor(first, cv2.COLOR_BGR2HSV)

        fh_hsv = _hsv_hist(h0)
        fh_gray = _gray_hist(g0)
        fh_sat = _sat_hist(h0)
        fh_val = _val_hist(h0)
        fgrid = _grid3x3(g0)
        fedge = _edge_density(g0)
        ftex = _texture_energy(g0)
        fbri = float(g0.mean()) / 255.0

        ra_hsv = fh_hsv.astype(float).copy()
        ra_gray = fh_gray.astype(float).copy()
        ra_sat = fh_sat.astype(float).copy()
        ra_val = fh_val.astype(float).copy()
        ra_grid = fgrid.astype(float).copy()
        ra_edge = float(fedge)
        ra_tex = float(ftex)
        ra_bri = float(fbri)
        ra_n = 1

        prev_gray = g0
        confirmed = []  # (frame_no, time_sec)
        cooldown = 0
        COOLDOWN = max(1, int(fps * COOLDOWN_S))

        prog_interval = max(200, total_scan // 20)

        for f in range(start_f + 1, end_f + 1):
            ok, frame = cap.read()
            if not ok:
                break

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            # Lightweight frame-to-frame diff (static-frame pre-filter)
            diff = cv2.absdiff(gray, prev_gray)
            diff_mean = float(diff.mean()) / 255.0
            prev_gray = gray

            # Cooldown after a confirmed change
            if cooldown > 0:
                cooldown -= 1
                continue

            # Skip truly static frames (fast path)
            if diff_mean < STATIC_DIFF:
                continue

            scanned = f - start_f
            if scanned % prog_interval == 0 and progress:
                progress(scanned * 100 // max(total_scan, 1))

            # ── Full 8-metric feature extraction ──────────────────────────
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

            f_hsv = _hsv_hist(hsv)
            f_gray = _gray_hist(gray)
            f_sat = _sat_hist(hsv)
            f_val = _val_hist(hsv)
            f_grid = _grid3x3(gray)
            f_edge = _edge_density(gray)
            f_tex = _texture_energy(gray)
            f_bri = float(gray.mean()) / 255.0

            # ── Normalize running averages ────────────────────────────────
            n = ra_n
            dt = fh_hsv.dtype

            a_hsv = (ra_hsv / n).astype(dt)
            cv2.normalize(a_hsv, a_hsv)
            a_gray = (ra_gray / n).astype(dt)
            cv2.normalize(a_gray, a_gray)
            a_sat = (ra_sat / n).astype(dt)
            cv2.normalize(a_sat, a_sat)
            a_val = (ra_val / n).astype(dt)
            cv2.normalize(a_val, a_val)

            a_grid = ra_grid / n
            a_bri = ra_bri / n
            a_edge = ra_edge / n
            a_tex = ra_tex / n

            # ── 8-metric comparison ───────────────────────────────────────
            c_hsv = cv2.compareHist(a_hsv, f_hsv, cv2.HISTCMP_CORREL)
            c_gray = cv2.compareHist(a_gray, f_gray, cv2.HISTCMP_CORREL)
            c_sat = cv2.compareHist(a_sat, f_sat, cv2.HISTCMP_CORREL)
            c_val = cv2.compareHist(a_val, f_val, cv2.HISTCMP_CORREL)

            grid_diff = float(np.mean(np.abs(a_grid - f_grid)))
            bri_diff = abs(a_bri - f_bri)
            edge_diff = abs(a_edge - f_edge)
            tex_max = max(a_tex, f_tex, 1.0)
            tex_diff = abs(a_tex - f_tex) / tex_max

            # Weighted score (each weight reflects metric importance)
            score = (
                (1.0 - c_hsv) * W_HSV
                + (1.0 - c_gray) * W_GRAY
                + (1.0 - c_sat) * W_SAT
                + (1.0 - c_val) * W_VAL
                + grid_diff * W_GRID
                + min(tex_diff, 1.0) * W_TEX
                + bri_diff * W_BRI
                + edge_diff * W_EDGE
            ) / 19.5

            # Hard cut: very large single-frame jump
            is_hard_cut = diff_mean > HARD_CUT_DIFF

            if score > SCORE_THRESHOLD or is_hard_cut:
                confirmed.append((f, round(f / fps, 5)))
                # Reset reference to the new scene
                ra_hsv = f_hsv.astype(float).copy()
                ra_gray = f_gray.astype(float).copy()
                ra_sat = f_sat.astype(float).copy()
                ra_val = f_val.astype(float).copy()
                ra_grid = f_grid.astype(float).copy()
                ra_edge = float(f_edge)
                ra_tex = float(f_tex)
                ra_bri = float(f_bri)
                ra_n = 1
                cooldown = COOLDOWN
            else:
                # Accumulate into the running average
                ra_hsv += f_hsv.astype(float)
                ra_gray += f_gray.astype(float)
                ra_sat += f_sat.astype(float)
                ra_val += f_val.astype(float)
                ra_grid += f_grid.astype(float)
                ra_edge += float(f_edge)
                ra_tex += float(f_tex)
                ra_bri += float(f_bri)
                ra_n += 1

        if not confirmed:
            return [(start_sec, end_sec)]

        # ── Frame-aligned boundaries — contiguous, no gaps ────────────────
        f_start = round(start_f / fps, 5)
        f_end = round(end_f / fps, 5)

        boundaries = [f_start]
        for _, t in confirmed:
            boundaries.append(t)
        boundaries.append(f_end)

        chunks = []
        for i in range(len(boundaries) - 1):
            ts = boundaries[i]
            te = boundaries[i + 1]
            if te > ts + 0.01:
                chunks.append((round(ts, 5), round(te, 5)))

        return chunks if chunks else [(f_start, f_end)]

    finally:
        cap.release()
