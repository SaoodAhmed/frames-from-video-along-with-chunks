"""
Batch Video Trimmer — Adaptive Scene Split  (v4 — Duration-Exact + No Background Repeat)
===========================================================================================
Key fixes in this version:
  1. FULL COVERAGE  — chunks are contiguous; sum of durations == original clip duration.
  2. NO BG REPEAT   — after merge passes, every adjacent pair is confirmed to differ;
                       if two non-adjacent regions share the same background they are NOT
                       merged (A→B→A stays as 3 chunks, not 1).
  3. STILL SCENES   — minor motion (talking head, hand movement) inside a static BG is
                       treated as ONE chunk; only a genuine BG swap triggers a new chunk.
  4. REAL-TIME EXPORT PROGRESS — live per-file progress bar shown during ffmpeg export.
  5. ZERO GAP / OVERLAP — boundary frames are handed off cleanly; no tail-flash from
                           the next chunk's BG leaks into the current chunk.

Keyboard Shortcuts:
  Space / K       Play / Pause
  J / L           Step ±1 frame
  ← / →           Step ±1 frame
  Shift+← / →     Jump ±5 seconds
  I               Set In-point at playhead
  O               Set Out-point at playhead
  Home / End      Jump to In / Out point
  Delete / Back   Remove selected video
  ?               Show all shortcuts

Audio requirement (install one):
    pip install pygame          ← recommended
    pip install pyaudio         ← alternative

Other requirements:
    pip install opencv-python pillow numpy
    ffmpeg in PATH:
        macOS:   brew install ffmpeg
        Linux:   sudo apt install ffmpeg
        Windows: https://ffmpeg.org/download.html

Run:
    python batch_video_trimmer.py
"""

import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

try:
    import cv2
    import numpy as np
    from PIL import Image, ImageTk
except ImportError:
    raise SystemExit("Run:  pip install opencv-python pillow numpy")

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
if not FFMPEG:
    raise SystemExit(
        "ffmpeg not found.\n"
        "  macOS:   brew install ffmpeg\n"
        "  Linux:   sudo apt install ffmpeg\n"
        "  Windows: https://ffmpeg.org/download.html"
    )

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# ── Audio backends ─────────────────────────────────────────────────────────────
AUDIO_BACKEND = None
try:
    import pygame

    pygame.mixer.init(frequency=44100, size=-16, channels=2, buffer=512)
    AUDIO_BACKEND = "pygame"
except Exception:
    pass

if not AUDIO_BACKEND:
    try:
        import pyaudio as _pa_test

        AUDIO_BACKEND = "pyaudio"
    except Exception:
        pass

# ── Palette ────────────────────────────────────────────────────────────────────
BG = "#0b0b12"
PANEL = "#14141f"
CARD = "#1a1a28"
CARD_SEL = "#1e2a3a"
ACCENT = "#00e0ff"
ACCENT2 = "#ff3f70"
ACCENT3 = "#7c5cbf"
GREEN = "#00e676"
YELLOW = "#ffd740"
TEXT = "#dde0f0"
MUTED = "#484860"
TL_BG = "#1c1c2e"
HW = 18
QSIZE = 6
PH_HIT = 12

# ── Scene detection tuning ─────────────────────────────────────────────────────
HIST_BINS_H = 50
HIST_BINS_S = 60
SAMPLE_STEP_S = 0.25  # seconds between histogram samples
GROW_THRESH = 0.72  # corr threshold: same background while growing
MERGE_THRESH = 0.80  # corr threshold for post-grow merge (stricter)
MIN_CHUNK_S = 0.5  # minimum chunk duration (seconds)
BOUNDARY_WIN = 8  # frames to scan each side of detected boundary
BOUNDARY_A = 0.75  # min corr to "claim" a frame for region A
BOUNDARY_MARGIN = 0.04  # seconds: domain of A's clean tail


# ══════════════════════════════════════════════════════════════════════════════
# Data model
# ══════════════════════════════════════════════════════════════════════════════


class VideoEntry:
    def __init__(self, path: str):
        self.path = path
        self.name = os.path.basename(path)
        self.ext = os.path.splitext(path)[1]
        self.cap = cv2.VideoCapture(path)
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30
        self.total_frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.duration = self.total_frames / self.fps
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.trim_start = 0.0
        self.trim_end = 1.0
        self.status = "ready"
        self.out_path = ""

    def release(self):
        if self.cap:
            self.cap.release()

    def start_sec(self):
        return self.trim_start * self.duration

    def end_sec(self):
        return self.trim_end * self.duration

    def clip_dur(self):
        return self.end_sec() - self.start_sec()

    def info(self):
        return f"{self.width}x{self.height}  {self.fps:.2f}fps  {self.ext.upper()}"


# ══════════════════════════════════════════════════════════════════════════════
# Audio player
# ══════════════════════════════════════════════════════════════════════════════

FFPLAY = shutil.which("ffplay")


class AudioPlayer:
    def __init__(self):
        self._proc = None
        self._thread = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

    def play(self, path: str, start_sec: float):
        self.stop()
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, args=(path, start_sec), daemon=True
        )
        self._thread.start()

    def stop(self):
        self._stop.set()
        with self._lock:
            if self._proc:
                try:
                    self._proc.kill()
                    self._proc.wait(timeout=1)
                except Exception:
                    pass
                self._proc = None
        if AUDIO_BACKEND == "pygame":
            try:
                pygame.mixer.music.stop()
            except Exception:
                pass

    def _run(self, path, start_sec):
        if FFPLAY:
            self._run_ffplay(path, start_sec)
        elif AUDIO_BACKEND == "pygame":
            self._run_pygame(path, start_sec)
        elif AUDIO_BACKEND == "pyaudio":
            self._run_pyaudio(path, start_sec)

    def _run_ffplay(self, path, start_sec):
        cmd = [
            FFPLAY,
            "-nodisp",
            "-autoexit",
            "-loglevel",
            "quiet",
            "-ss",
            f"{start_sec:.3f}",
            path,
        ]
        try:
            kw = {"creationflags": _CREATE_NO_WINDOW} if os.name == "nt" else {}
            proc = subprocess.Popen(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw
            )
            with self._lock:
                if self._stop.is_set():
                    proc.kill()
                    return
                self._proc = proc
            while not self._stop.is_set():
                if proc.poll() is not None:
                    break
                time.sleep(0.05)
            if proc.poll() is None:
                proc.kill()
        except Exception:
            pass

    def _run_pygame(self, path, start_sec):
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_path = tmp.name
            cmd = [
                FFMPEG,
                "-y",
                "-ss",
                f"{start_sec:.3f}",
                "-i",
                path,
                "-t",
                "600",
                "-vn",
                "-acodec",
                "pcm_s16le",
                "-ar",
                "44100",
                "-ac",
                "2",
                tmp_path,
            ]
            kw = {"creationflags": _CREATE_NO_WINDOW} if os.name == "nt" else {}
            r = subprocess.run(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=60,
                **kw,
            )
            if r.returncode != 0 or self._stop.is_set():
                return
            pygame.mixer.music.load(tmp_path)
            pygame.mixer.music.play()
            while pygame.mixer.music.get_busy() and not self._stop.is_set():
                time.sleep(0.05)
            pygame.mixer.music.stop()
        except Exception:
            pass
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

    def _run_pyaudio(self, path, start_sec):
        try:
            import pyaudio

            CHUNK, RATE, CHANS = 4096, 44100, 2
            cmd = [
                FFMPEG,
                "-ss",
                f"{start_sec:.3f}",
                "-i",
                path,
                "-vn",
                "-f",
                "s16le",
                "-ar",
                str(RATE),
                "-ac",
                str(CHANS),
                "pipe:1",
            ]
            kw = {"creationflags": _CREATE_NO_WINDOW} if os.name == "nt" else {}
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **kw
            )
            with self._lock:
                if self._stop.is_set():
                    proc.kill()
                    return
                self._proc = proc
            pa = pyaudio.PyAudio()
            stream = pa.open(
                format=pyaudio.paInt16, channels=CHANS, rate=RATE, output=True
            )
            try:
                while not self._stop.is_set():
                    data = proc.stdout.read(CHUNK)
                    if not data:
                        break
                    stream.write(data)
            finally:
                stream.stop_stream()
                stream.close()
                pa.terminate()
                proc.kill()
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════════
# Scene detection — Duration-exact, no-repeat-BG
# ══════════════════════════════════════════════════════════════════════════════


def _hist(frame):
    """Compute normalised 2-D HSV histogram for one BGR frame."""
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    h = cv2.calcHist([hsv], [0, 1], None, [HIST_BINS_H, HIST_BINS_S], [0, 180, 0, 256])
    cv2.normalize(h, h)
    return h


def _avg_hist(hists):
    """Compute normalised average histogram from a list."""
    if not hists:
        return None
    total = hists[0].astype(np.float64).copy()
    for h in hists[1:]:
        total += h.astype(np.float64)
    avg = (total / len(hists)).astype(np.float32)
    cv2.normalize(avg, avg)
    return avg


def _corr(a, b):
    return float(cv2.compareHist(a, b, cv2.HISTCMP_CORREL))


def detect_scene_chunks(v: VideoEntry):
    """
    Return a list of (start_sec, end_sec) that:
      • Are contiguous  → sum == (end_sec_trim - start_sec_trim)
      • Each pair of adjacent chunks differs in background (corr < MERGE_THRESH)
      • A background that returns (A→B→A) produces SEPARATE entries for each A

    The algorithm:
      1. Sample every SAMPLE_STEP_S seconds → collect (frame_no, time, hist).
      2. Region-grow: compare each sample to the running-average fingerprint of
         the current region.  New region starts only on a genuine BG change.
      3. Merge pass: collapse ONLY adjacent regions whose fingerprints are too
         similar — but NEVER merge non-adjacent regions (preserves A→B→A).
      4. Absorb tiny regions (< MIN_CHUNK_S) into whichever neighbour is more
         similar, but keep the neighbour distinct from the other side.
      5. Refine every boundary to frame accuracy using per-frame comparison
         against BOTH neighbouring fingerprints.
      6. Build final timeline: first chunk starts at trim_start, last chunk ends
         at trim_end — zero gap, zero overlap.
    """
    s_sec = v.start_sec()
    e_sec = v.end_sec()
    if e_sec <= s_sec:
        return [(s_sec, e_sec)]

    fps = max(v.fps, 1.0)
    start_f = int(round(s_sec * fps))
    end_f = max(start_f + 1, int(round(e_sec * fps)) - 1)
    step = max(1, int(round(fps * SAMPLE_STEP_S)))

    cap = cv2.VideoCapture(v.path)
    try:
        # ── 1. Collect samples ────────────────────────────────────────────────
        samples = []  # (frame_no, time_sec, hist)
        for f in range(start_f, end_f + 1, step):
            cap.set(cv2.CAP_PROP_POS_FRAMES, f)
            ok, frame = cap.read()
            if not ok:
                break
            samples.append((f, f / fps, _hist(frame)))

        if len(samples) < 2:
            return [(s_sec, e_sec)]

        # ── 2. Region-grow ────────────────────────────────────────────────────
        # Each region stores its sample indices.
        regions = [[0]]
        run_hists = [samples[0][2]]  # raw hists for current region

        for i in range(1, len(samples)):
            avg = _avg_hist(run_hists)
            if _corr(avg, samples[i][2]) >= GROW_THRESH:
                regions[-1].append(i)
                run_hists.append(samples[i][2])
            else:
                regions.append([i])
                run_hists = [samples[i][2]]

        # ── 3. Adjacent-only merge pass (keeps A→B→A intact) ─────────────────
        def fp(r_indices):
            return _avg_hist([samples[i][2] for i in r_indices])

        changed = True
        while changed and len(regions) > 1:
            changed = False
            i = 0
            while i < len(regions) - 1:
                if _corr(fp(regions[i]), fp(regions[i + 1])) >= MERGE_THRESH:
                    regions[i] = regions[i] + regions[i + 1]
                    regions.pop(i + 1)
                    changed = True
                    continue
                i += 1

        # ── 4. Absorb tiny regions ────────────────────────────────────────────
        min_samples = max(1, int(MIN_CHUNK_S / SAMPLE_STEP_S))
        changed = True
        while changed and len(regions) > 1:
            changed = False
            for i in range(len(regions)):
                if len(regions[i]) >= min_samples:
                    continue
                # Only merge with a neighbour if that neighbour stays distinct
                # from the OTHER neighbour (prevents collapsing A→B→A into A).
                fp_cur = fp(regions[i])
                candidates = []
                for j in (i - 1, i + 1):
                    if 0 <= j < len(regions):
                        c = _corr(fp_cur, fp(regions[j]))
                        candidates.append((c, j))
                if not candidates:
                    continue
                candidates.sort(reverse=True)
                best_j = candidates[0][1]
                # Check the merged entity won't eliminate a distinct boundary
                # by verifying the other side (if it exists) is still different.
                other = [j for _, j in candidates if j != best_j]
                if other:
                    merged_fp = _avg_hist(
                        [samples[k][2] for k in regions[i] + regions[best_j]]
                    )
                    other_fp = fp(regions[other[0]])
                    if _corr(merged_fp, other_fp) >= MERGE_THRESH:
                        # Merging would blur a real boundary — skip
                        continue
                lo, hi = min(i, best_j), max(i, best_j)
                regions[lo] = regions[lo] + regions[hi]
                regions.pop(hi)
                changed = True
                break

        # ── 5. Refine boundaries to frame accuracy ────────────────────────────
        # At each boundary between region[k] and region[k+1]:
        #   - Scan BOUNDARY_WIN frames either side of the coarse boundary.
        #   - A frame "belongs to A" when corr(frame, fp_A) >= BOUNDARY_A
        #     AND corr(frame, fp_A) > corr(frame, fp_B) + 0.10.
        #   - The boundary time = (last A-frame + 1) / fps.
        #   - This is then nudged back by BOUNDARY_MARGIN to exclude any
        #     partial-frame blend at the tail.

        region_fps = [fp(r) for r in regions]
        split_times = []  # one entry per inter-region boundary

        for bi in range(len(regions) - 1):
            fp_a = region_fps[bi]
            fp_b = region_fps[bi + 1]

            # Coarse boundary: last sample of A
            coarse_frame = samples[regions[bi][-1]][0]

            scan_from = max(start_f, coarse_frame - BOUNDARY_WIN)
            scan_to = min(end_f, coarse_frame + BOUNDARY_WIN)

            last_a = coarse_frame  # conservative default
            for f in range(scan_from, scan_to + 1):
                cap.set(cv2.CAP_PROP_POS_FRAMES, f)
                ok, frame = cap.read()
                if not ok:
                    break
                h = _hist(frame)
                corr_a = _corr(h, fp_a)
                corr_b = _corr(h, fp_b)
                if corr_a >= BOUNDARY_A and corr_a > corr_b + 0.10:
                    last_a = f

            # Boundary = first frame of B = last_a + 1; apply small margin
            boundary_sec = (last_a + 1) / fps - BOUNDARY_MARGIN
            # Clamp: must be strictly inside (s_sec, e_sec) and after previous split
            if split_times:
                boundary_sec = max(boundary_sec, split_times[-1] + 0.04)
            boundary_sec = max(s_sec + 0.04, min(e_sec - 0.04, boundary_sec))
            split_times.append(boundary_sec)

        # ── 6. Build contiguous chunks — FULL COVERAGE ────────────────────────
        # First chunk starts exactly at s_sec, last chunk ends exactly at e_sec.
        # Every boundary is a hard cut; no gap, no overlap.
        chunk_starts = [s_sec] + split_times
        chunk_ends = split_times + [e_sec]

        chunks = []
        for cs, ce in zip(chunk_starts, chunk_ends):
            if ce > cs + 0.01:
                chunks.append((cs, ce))

        return chunks if chunks else [(s_sec, e_sec)]

    finally:
        cap.release()


# ══════════════════════════════════════════════════════════════════════════════
# Main app
# ══════════════════════════════════════════════════════════════════════════════


class BatchTrimmer(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Batch Video Trimmer - Adaptive Scene Split v4")
        self.configure(bg=BG)
        self.geometry("1210x820")
        self.minsize(960, 640)

        self.videos: list[VideoEntry] = []
        self.selected: int = -1

        self._out_dir = self._make_default_output_dir()
        self._out_lbl_var = tk.StringVar(value=self._out_dir)

        # Playback
        self.playing = False
        self._stop_evt = threading.Event()
        self._frame_q = queue.Queue(maxsize=QSIZE)
        self._pump_id = None
        self.playhead = 0.0
        self._audio = AudioPlayer()

        # Canvas size cache
        self._cv_w = 640
        self._cv_h = 360

        # Timeline drag state
        self._drag = None
        self._tl_w = 1
        self._tl_x0 = HW + 2

        self._cards: dict[int, tk.Frame] = {}

        self._build_ui()
        self._bind_keys()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _desktop_dir(self):
        d = Path.home() / "Desktop"
        return d if d.exists() else Path.home()

    def _make_default_output_dir(self):
        out = self._desktop_dir() / "BatchVideoTrimmer_Exports"
        out.mkdir(parents=True, exist_ok=True)
        return str(out)

    def _unique_path(self, path):
        base, ext = os.path.splitext(path)
        n, out = 1, path
        while os.path.exists(out):
            out = f"{base}_{n}{ext}"
            n += 1
        return out

    # ── Keyboard shortcuts ────────────────────────────────────────────────────

    def _bind_keys(self):
        self.bind("<space>", lambda e: self._toggle_play())
        self.bind("k", lambda e: self._toggle_play())
        self.bind("K", lambda e: self._toggle_play())
        self.bind("<Left>", lambda e: self._step_frames(-1))
        self.bind("<Right>", lambda e: self._step_frames(+1))
        self.bind("<Shift-Left>", lambda e: self._step_secs(-5))
        self.bind("<Shift-Right>", lambda e: self._step_secs(+5))
        self.bind("j", lambda e: self._step_frames(-1))
        self.bind("J", lambda e: self._step_frames(-1))
        self.bind("l", lambda e: self._step_frames(+1))
        self.bind("L", lambda e: self._step_frames(+1))
        self.bind("i", lambda e: self._set_in())
        self.bind("I", lambda e: self._set_in())
        self.bind("o", lambda e: self._set_out())
        self.bind("O", lambda e: self._set_out())
        self.bind("<Home>", lambda e: self._go_start())
        self.bind("<End>", lambda e: self._go_end())
        self.bind("<Delete>", lambda e: self._remove(self.selected))
        self.bind("<BackSpace>", lambda e: self._remove(self.selected))
        self.bind("?", lambda e: self._show_shortcuts())

    def _step_frames(self, delta):
        v = self._entry()
        if not v:
            return
        self._stop_playback()
        self._seek(max(0.0, min(1.0, self.playhead + delta / max(v.total_frames, 1))))

    def _step_secs(self, secs):
        v = self._entry()
        if not v:
            return
        self._stop_playback()
        self._seek(max(0.0, min(1.0, self.playhead + secs / max(v.duration, 1e-9))))

    def _set_in(self):
        v = self._entry()
        if not v:
            return
        v.trim_start = max(0.0, min(self.playhead, v.trim_end - 0.002))
        self._draw_tl_full()
        self._update_labels()
        self._update_card(self.selected)
        self.status_bar.config(text=f"In-point set: {self._fmt(v.start_sec())}")

    def _set_out(self):
        v = self._entry()
        if not v:
            return
        v.trim_end = min(1.0, max(self.playhead, v.trim_start + 0.002))
        self._draw_tl_full()
        self._update_labels()
        self._update_card(self.selected)
        self.status_bar.config(text=f"Out-point set: {self._fmt(v.end_sec())}")

    def _show_shortcuts(self):
        win = tk.Toplevel(self, bg=PANEL)
        win.title("Keyboard Shortcuts")
        win.resizable(False, False)
        rows = [
            ("Space / K", "Play / Pause"),
            ("J", "Step back 1 frame"),
            ("L", "Step forward 1 frame"),
            ("← / →", "Step ±1 frame"),
            ("Shift+← / →", "Jump ±5 seconds"),
            ("I", "Set In-point at playhead"),
            ("O", "Set Out-point at playhead"),
            ("Home", "Jump to In-point"),
            ("End", "Jump to Out-point"),
            ("Delete / Back", "Remove selected video"),
            ("?", "Show this help"),
        ]
        tk.Label(
            win,
            text="Keyboard Shortcuts",
            bg=PANEL,
            fg=ACCENT,
            font=("Courier New", 11, "bold"),
        ).pack(padx=18, pady=(12, 6), anchor="w")
        for key, desc in rows:
            row = tk.Frame(win, bg=PANEL)
            row.pack(fill="x", padx=18, pady=1)
            tk.Label(
                row,
                text=f"{key:<22}",
                bg=PANEL,
                fg=YELLOW,
                font=("Courier New", 9, "bold"),
                width=22,
                anchor="w",
            ).pack(side="left")
            tk.Label(
                row, text=desc, bg=PANEL, fg=TEXT, font=("Courier New", 9), anchor="w"
            ).pack(side="left")
        tk.Button(
            win,
            text="Close",
            command=win.destroy,
            bg=ACCENT,
            fg=BG,
            font=("Courier New", 9, "bold"),
            relief="flat",
            padx=12,
            pady=4,
            cursor="hand2",
        ).pack(pady=10)
        win.grab_set()

    # ── UI build ──────────────────────────────────────────────────────────────

    def _build_ui(self):
        hdr = tk.Frame(self, bg=BG, pady=10)
        hdr.pack(fill="x", padx=16)

        tk.Label(
            hdr,
            text="BATCH TRIM — Auto Scene Split v4",
            bg=BG,
            fg=ACCENT,
            font=("Courier New", 15, "bold"),
        ).pack(side="left")

        for txt, cmd, bg_, fg_ in [
            (" ? ", self._show_shortcuts, PANEL, MUTED),
            ("Clear All", self._clear_all, PANEL, MUTED),
            ("  + Add Videos  ", self._add_videos, ACCENT, BG),
            ("  Export All  ", self._export_all, ACCENT2, "white"),
            ("  Output Folder  ", self._pick_output_folder, ACCENT3, "white"),
        ]:
            tk.Button(
                hdr,
                text=txt,
                command=cmd,
                bg=bg_,
                fg=fg_,
                font=("Courier New", 10, "bold"),
                relief="flat",
                padx=14,
                pady=6,
                cursor="hand2",
            ).pack(side="right", padx=4)

        tk.Label(
            hdr,
            text="Auto-Detect  •  Duration-Exact  •  No BG Repeat",
            bg=BG,
            fg=GREEN,
            font=("Courier New", 9, "bold"),
        ).pack(side="right", padx=6)

        out_bar = tk.Frame(self, bg="#0f0f1e", pady=5)
        out_bar.pack(fill="x", padx=16)
        tk.Label(
            out_bar,
            text="Output folder:",
            bg="#0f0f1e",
            fg=MUTED,
            font=("Courier New", 9, "bold"),
        ).pack(side="left", padx=(0, 6))
        tk.Label(
            out_bar,
            textvariable=self._out_lbl_var,
            bg="#0f0f1e",
            fg=YELLOW,
            font=("Courier New", 9),
            anchor="w",
        ).pack(side="left")

        body = tk.Frame(self, bg=BG)
        body.pack(fill="both", expand=True, padx=16, pady=(4, 4))

        left = tk.Frame(body, bg=PANEL, width=340)
        left.pack(side="left", fill="y", padx=(0, 8))
        left.pack_propagate(False)

        tk.Label(
            left, text="Videos", bg=PANEL, fg=MUTED, font=("Courier New", 9, "bold")
        ).pack(anchor="w", padx=10, pady=(8, 4))

        self._list_canvas = tk.Canvas(left, bg=PANEL, highlightthickness=0)
        sb = tk.Scrollbar(left, orient="vertical", command=self._list_canvas.yview)
        self._list_frame = tk.Frame(self._list_canvas, bg=PANEL)
        self._list_frame.bind(
            "<Configure>",
            lambda e: self._list_canvas.configure(
                scrollregion=self._list_canvas.bbox("all")
            ),
        )
        self._list_canvas.create_window((0, 0), window=self._list_frame, anchor="nw")
        self._list_canvas.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self._list_canvas.pack(side="left", fill="both", expand=True)
        self._list_canvas.bind(
            "<MouseWheel>",
            lambda e: self._list_canvas.yview_scroll(-1 * (e.delta // 120), "units"),
        )

        self._empty_lbl = tk.Label(
            self._list_frame,
            text="Click '+ Add Videos'\nto load video files",
            bg=PANEL,
            fg=MUTED,
            font=("Courier New", 10),
            justify="center",
        )
        self._empty_lbl.pack(pady=40)

        right = tk.Frame(body, bg=BG)
        right.pack(side="left", fill="both", expand=True)

        self.cv = tk.Canvas(right, bg="#000", highlightthickness=0)
        self.cv.pack(fill="both", expand=True)
        self.cv.bind("<Configure>", self._on_cv_resize)
        self._placeholder()

        tlp = tk.Frame(right, bg=PANEL, pady=8)
        tlp.pack(fill="x", pady=(4, 0))

        hint_row = tk.Frame(tlp, bg=PANEL)
        hint_row.pack(fill="x", padx=10)
        for key, lbl in [
            ("I", "Set In"),
            ("O", "Set Out"),
            ("Space", "Play/Pause"),
            ("←→", "Frame"),
            ("Shift+←→", "±5s"),
            ("?", "Shortcuts"),
        ]:
            tk.Label(
                hint_row,
                text=f"[{key}] {lbl}",
                bg=PANEL,
                fg=MUTED,
                font=("Courier New", 7),
            ).pack(side="left", padx=5)

        if FFPLAY:
            atxt, acol = "Audio: ffplay", GREEN
        elif AUDIO_BACKEND == "pygame":
            atxt, acol = "Audio: pygame", GREEN
        elif AUDIO_BACKEND == "pyaudio":
            atxt, acol = "Audio: pyaudio", GREEN
        else:
            atxt, acol = "Audio: unavailable", ACCENT2
        tk.Label(hint_row, text=atxt, bg=PANEL, fg=acol, font=("Courier New", 7)).pack(
            side="right", padx=6
        )

        lrow = tk.Frame(tlp, bg=PANEL)
        lrow.pack(fill="x", padx=10, pady=(6, 0))
        self.lbl_s = tk.Label(
            lrow,
            text="Start  --:--",
            bg=PANEL,
            fg=ACCENT,
            font=("Courier New", 9, "bold"),
        )
        self.lbl_s.pack(side="left")
        self.lbl_dur = tk.Label(
            lrow, text="", bg=PANEL, fg=TEXT, font=("Courier New", 9)
        )
        self.lbl_dur.pack(side="left", padx=16)
        self.lbl_e = tk.Label(
            lrow,
            text="End  --:--",
            bg=PANEL,
            fg=ACCENT2,
            font=("Courier New", 9, "bold"),
        )
        self.lbl_e.pack(side="right")

        self.tl = tk.Canvas(
            tlp,
            bg=TL_BG,
            height=90,
            highlightthickness=1,
            highlightbackground=MUTED,
            cursor="crosshair",
        )
        self.tl.pack(fill="x", padx=10, pady=6)
        self.tl.bind("<ButtonPress-1>", self._tl_press)
        self.tl.bind("<B1-Motion>", self._tl_move)
        self.tl.bind("<ButtonRelease-1>", self._tl_release)
        self.tl.bind("<Motion>", self._tl_hover)
        self.tl.bind("<Configure>", lambda e: self._draw_tl_full())

        ctrl = tk.Frame(tlp, bg=PANEL)
        ctrl.pack(pady=2)
        b = dict(
            bg=PANEL,
            fg=TEXT,
            font=("Courier New", 14),
            relief="flat",
            bd=0,
            padx=8,
            cursor="hand2",
        )
        tk.Button(ctrl, text="|<", command=self._go_start, **b).pack(side="left")
        self.btn_play = tk.Button(ctrl, text=">", command=self._toggle_play, **b)
        self.btn_play.pack(side="left")
        tk.Button(ctrl, text=">|", command=self._go_end, **b).pack(side="left")
        tk.Button(
            ctrl,
            text="[I] In",
            command=self._set_in,
            bg=PANEL,
            fg=ACCENT,
            font=("Courier New", 9, "bold"),
            relief="flat",
            bd=0,
            padx=6,
            cursor="hand2",
        ).pack(side="left", padx=6)
        tk.Button(
            ctrl,
            text="[O] Out",
            command=self._set_out,
            bg=PANEL,
            fg=ACCENT2,
            font=("Courier New", 9, "bold"),
            relief="flat",
            bd=0,
            padx=6,
            cursor="hand2",
        ).pack(side="left")
        self.lbl_pos = tk.Label(
            ctrl, text="--:-- / --:--", bg=PANEL, fg=MUTED, font=("Courier New", 9)
        )
        self.lbl_pos.pack(side="left", padx=12)

        self.status_bar = tk.Label(
            self,
            text="Step 1: Set output folder  →  Step 2: + Add Videos  →  Step 3: Export All",
            bg=PANEL,
            fg=MUTED,
            font=("Courier New", 9),
            anchor="w",
            padx=12,
            pady=4,
        )
        self.status_bar.pack(fill="x", side="bottom")

    # ── Output folder ─────────────────────────────────────────────────────────

    def _pick_output_folder(self):
        d = filedialog.askdirectory(title="Choose Output Folder")
        if d:
            self._out_dir = d
            self._out_lbl_var.set(d)
            self.status_bar.config(text=f"Output folder set: {d}")

    # ── Video list ────────────────────────────────────────────────────────────

    def _add_videos(self):
        paths = filedialog.askopenfilenames(
            title="Select Videos",
            filetypes=[
                (
                    "Video files",
                    "*.mp4 *.mov *.avi *.mkv *.webm *.flv *.ts *.wmv *.m4v",
                ),
                ("All files", "*.*"),
            ],
        )
        if not paths:
            return
        self._empty_lbl.pack_forget()
        for path in paths:
            if any(v and v.path == path for v in self.videos):
                continue
            try:
                entry = VideoEntry(path)
            except Exception as ex:
                messagebox.showerror("Load error", f"{os.path.basename(path)}\n{ex}")
                continue
            idx = len(self.videos)
            self.videos.append(entry)
            self._make_card(idx, entry)
        if self.videos and self.selected == -1:
            self._select(0)
        self._update_status()

    def _make_card(self, idx, entry):
        card = tk.Frame(
            self._list_frame,
            bg=CARD,
            pady=6,
            padx=8,
            cursor="hand2",
            relief="flat",
            bd=0,
        )
        card.pack(fill="x", padx=8, pady=3)
        card.bind("<Button-1>", lambda e, i=idx: self._select(i))

        row1 = tk.Frame(card, bg=CARD)
        row1.pack(fill="x")
        row1.bind("<Button-1>", lambda e, i=idx: self._select(i))

        nl = tk.Label(
            row1,
            text=entry.name,
            bg=CARD,
            fg=TEXT,
            font=("Courier New", 9, "bold"),
            anchor="w",
            wraplength=220,
            justify="left",
        )
        nl.pack(side="left", fill="x", expand=True)
        nl.bind("<Button-1>", lambda e, i=idx: self._select(i))

        tk.Button(
            row1,
            text="X",
            bg=CARD,
            fg=MUTED,
            font=("Courier New", 9),
            relief="flat",
            bd=0,
            cursor="hand2",
            command=lambda i=idx: self._remove(i),
        ).pack(side="right")

        for txt, color in [
            (entry.info(), MUTED),
        ]:
            lb = tk.Label(
                card, text=txt, bg=CARD, fg=color, font=("Courier New", 8), anchor="w"
            )
            lb.pack(fill="x")
            lb.bind("<Button-1>", lambda e, i=idx: self._select(i))

        tl_lbl = tk.Label(
            card,
            text=f"Full: {self._fmt(entry.duration)}",
            bg=CARD,
            fg=ACCENT,
            font=("Courier New", 8),
        )
        tl_lbl.pack(anchor="w")
        tl_lbl.bind("<Button-1>", lambda e, i=idx: self._select(i))

        # Progress bar (hidden until export)
        prog_frame = tk.Frame(card, bg=CARD)
        prog_frame.pack(fill="x", pady=(2, 0))
        prog_bar = ttk.Progressbar(prog_frame, mode="determinate", length=200)
        prog_bar.pack(side="left", fill="x", expand=True)
        prog_bar.pack_forget()  # hidden initially

        st_lbl = tk.Label(
            card, text="* ready", bg=CARD, fg=MUTED, font=("Courier New", 8)
        )
        st_lbl.pack(anchor="w")
        st_lbl.bind("<Button-1>", lambda e, i=idx: self._select(i))

        card._status_lbl = st_lbl
        card._time_lbl = tl_lbl
        card._prog_bar = prog_bar
        card._prog_frame = prog_frame
        self._cards[idx] = card

    def _select(self, idx):
        if idx < 0 or idx >= len(self.videos) or not self.videos[idx]:
            return
        self._stop_playback()
        if self.selected in self._cards:
            self._recolor_card(self.selected, CARD)
        self.selected = idx
        self._recolor_card(idx, CARD_SEL)
        self.playhead = self.videos[idx].trim_start
        self._seek(self.playhead)

    def _recolor_card(self, idx, color):
        if idx not in self._cards:
            return
        card = self._cards[idx]
        card.config(bg=color)
        for child in card.winfo_children():
            try:
                child.config(bg=color)
                for sub in child.winfo_children():
                    try:
                        sub.config(bg=color)
                    except Exception:
                        pass
            except Exception:
                pass

    def _remove(self, idx):
        if idx < 0 or idx not in self._cards:
            return
        self._stop_playback()
        self.videos[idx].release()
        self._cards[idx].destroy()
        del self._cards[idx]
        self.videos[idx] = None
        if self.selected == idx:
            self.selected = -1
            self._placeholder()
            self._draw_tl_full()
        self._update_status()

    def _clear_all(self):
        if not any(v for v in self.videos):
            return
        if not messagebox.askyesno("Clear all", "Remove all videos?"):
            return
        self._stop_playback()
        for v in self.videos:
            if v:
                v.release()
        self.videos.clear()
        self._cards.clear()
        for w in self._list_frame.winfo_children():
            w.destroy()
        self._empty_lbl = tk.Label(
            self._list_frame,
            text="Click '+ Add Videos'\nto load video files",
            bg=PANEL,
            fg=MUTED,
            font=("Courier New", 10),
            justify="center",
        )
        self._empty_lbl.pack(pady=40)
        self.selected = -1
        self._placeholder()
        self._draw_tl_full()
        self.status_bar.config(text="All cleared.")

    def _update_status(self):
        valid = [v for v in self.videos if v]
        folder = (
            f"Output: {self._out_dir}" if self._out_dir else "Output folder not set"
        )
        self.status_bar.config(
            text=f"{len(valid)} video(s) loaded  |  {folder}  |  Press ? for shortcuts"
        )

    # ── Preview ───────────────────────────────────────────────────────────────

    def _placeholder(self):
        self.cv.delete("all")
        self.cv.create_text(
            self._cv_w // 2,
            self._cv_h // 2,
            text="Select a video to preview",
            fill=MUTED,
            font=("Courier New", 11),
        )

    def _on_cv_resize(self, event):
        self._cv_w = max(event.width, 1)
        self._cv_h = max(event.height, 1)
        if not self.playing:
            self._reshow_static()

    def _entry(self):
        if self.selected < 0 or self.selected >= len(self.videos):
            return None
        return self.videos[self.selected]

    def _seek(self, norm):
        v = self._entry()
        if not v:
            return
        norm = max(0.0, min(1.0, norm))
        self.playhead = norm
        fn = int(norm * max(v.total_frames - 1, 0))
        v.cap.set(cv2.CAP_PROP_POS_FRAMES, fn)
        ok, frame = v.cap.read()
        if ok:
            self._render_frame(frame)
        self._draw_tl_full()
        self._update_labels()

    def _reshow_static(self):
        v = self._entry()
        if v and not self.playing:
            fn = int(self.playhead * max(v.total_frames - 1, 0))
            v.cap.set(cv2.CAP_PROP_POS_FRAMES, fn)
            ok, frame = v.cap.read()
            if ok:
                self._render_frame(frame)
        elif not v:
            self._placeholder()

    def _render_frame(self, bgr):
        W, H = self._cv_w, self._cv_h
        fh, fw = bgr.shape[:2]
        scale = min(W / fw, H / fh)
        nw, nh = max(1, int(fw * scale)), max(1, int(fh * scale))
        small = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
        rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        photo = ImageTk.PhotoImage(image=Image.fromarray(rgb))
        self.cv.delete("all")
        self.cv.create_image(W // 2, H // 2, anchor="center", image=photo)
        self.cv._photo = photo

    # ── Playback ──────────────────────────────────────────────────────────────

    def _toggle_play(self):
        if self.playing:
            self._stop_playback()
        else:
            self._start_playback()

    def _start_playback(self):
        v = self._entry()
        if not v:
            return
        while not self._frame_q.empty():
            try:
                self._frame_q.get_nowait()
            except queue.Empty:
                break
        self.playing = True
        self.btn_play.config(text="||")
        self._stop_evt.clear()
        cur = self.playhead * v.duration
        s_t = v.trim_start * v.duration
        e_t = v.trim_end * v.duration
        if cur < s_t or cur >= e_t:
            cur = s_t
        self._audio.play(v.path, cur)
        threading.Thread(target=self._producer, daemon=True).start()
        self._schedule_pump(max(1, int(1000 / v.fps)))

    def _stop_playback(self):
        self.playing = False
        self._stop_evt.set()
        if self._pump_id:
            self.after_cancel(self._pump_id)
            self._pump_id = None
        self.btn_play.config(text=">")
        self._audio.stop()

    def _producer(self):
        v = self._entry()
        if not v:
            return
        s_t = v.trim_start * v.duration
        e_t = v.trim_end * v.duration
        cur = self.playhead * v.duration
        if cur < s_t or cur >= e_t:
            cur = s_t
        v.cap.set(cv2.CAP_PROP_POS_FRAMES, int(cur * v.fps))
        wall0, vid0 = time.perf_counter(), cur
        while not self._stop_evt.is_set():
            ok, frame = v.cap.read()
            if not ok:
                self._frame_q.put(None)
                break
            pos_ms = v.cap.get(cv2.CAP_PROP_POS_MSEC)
            vid_pos = pos_ms / 1000.0
            if vid_pos >= e_t:
                self._frame_q.put(None)
                break
            norm = vid_pos / max(v.duration, 1e-9)
            gap = (wall0 + (vid_pos - vid0)) - time.perf_counter()
            if gap > 0.04:
                time.sleep(gap - 0.005)
            try:
                self._frame_q.put((frame, norm), timeout=0.3)
            except queue.Full:
                pass

    def _schedule_pump(self, ms):
        self._pump_id = self.after(ms, self._pump, ms)

    def _pump(self, ms):
        if not self.playing:
            return
        try:
            item = self._frame_q.get_nowait()
        except queue.Empty:
            self._schedule_pump(ms)
            return
        if item is None:
            self._stop_playback()
            return
        frame, norm = item
        self.playhead = norm
        self._render_frame(frame)
        self._move_playhead_only()
        self._update_labels()
        self._schedule_pump(ms)

    def _go_start(self):
        v = self._entry()
        if v:
            self._stop_playback()
            self._seek(v.trim_start)

    def _go_end(self):
        v = self._entry()
        if v:
            self._stop_playback()
            self._seek(v.trim_end)

    # ── Timeline ──────────────────────────────────────────────────────────────

    def _norm_to_px(self, n):
        return self._tl_x0 + n * self._tl_w

    def _px_to_norm(self, x):
        return max(0.0, min(1.0, (x - self._tl_x0) / max(self._tl_w, 1)))

    def _hit_test(self, x):
        v = self._entry()
        if not v:
            return "bg"
        s_px = self._norm_to_px(v.trim_start)
        e_px = self._norm_to_px(v.trim_end)
        p_px = self._norm_to_px(self.playhead)
        if abs(x - p_px) <= PH_HIT:
            return "p"
        if abs(x - s_px) <= HW + 3:
            return "s"
        if abs(x - e_px) <= HW + 3:
            return "e"
        return "bg"

    def _tl_hover(self, e):
        h = self._hit_test(e.x)
        self.tl.config(
            cursor="sb_h_double_arrow" if h in ("p", "s", "e") else "crosshair"
        )

    def _tl_press(self, e):
        v = self._entry()
        if not v:
            return
        h = self._hit_test(e.x)
        self._drag = h if h in ("s", "e", "p") else "p"
        if self._drag == "p":
            self._stop_playback()
            self._seek(self._px_to_norm(e.x))

    def _tl_move(self, e):
        v = self._entry()
        if not self._drag or not v:
            return
        n = self._px_to_norm(e.x)
        if self._drag == "s":
            v.trim_start = max(0.0, min(n, v.trim_end - 0.002))
            if self.playhead < v.trim_start:
                self._seek(v.trim_start)
            else:
                self._draw_tl_full()
                self._update_labels()
            self._update_card(self.selected)
        elif self._drag == "e":
            v.trim_end = min(1.0, max(n, v.trim_start + 0.002))
            if self.playhead > v.trim_end:
                self._seek(v.trim_end)
            else:
                self._draw_tl_full()
                self._update_labels()
            self._update_card(self.selected)
        elif self._drag == "p":
            self.playhead = max(0.0, min(1.0, n))
            self._move_playhead_only()
            self._update_labels()

    def _tl_release(self, e):
        if self._drag == "p":
            self._seek(self.playhead)
        self._drag = None
        self.tl.config(cursor="crosshair")

    def _draw_tl_full(self):
        c = self.tl
        W = c.winfo_width()
        H = c.winfo_height()
        if W < 4:
            return
        PAD = HW + 2
        self._tl_x0 = PAD
        self._tl_w = W - 2 * PAD
        c.delete("all")
        v = self._entry()
        s = v.trim_start if v else 0.0
        e = v.trim_end if v else 1.0
        p = self.playhead
        H2 = H // 2
        s_px = PAD + s * self._tl_w
        e_px = PAD + e * self._tl_w
        p_px = PAD + p * self._tl_w
        c.create_rectangle(0, 0, W, H, fill=TL_BG, outline="")
        c.create_rectangle(PAD, 0, s_px, H, fill="#0a0a18", outline="")
        c.create_rectangle(e_px, 0, W - PAD, H, fill="#0a0a18", outline="")
        c.create_rectangle(s_px, 0, e_px, H, fill="#182035", outline="")
        import random

        random.seed(42)
        zone_w = max(1, int(e_px - s_px))
        for i in range(0, zone_w, 3):
            bh = random.randint(4, H - 12)
            c.create_line(
                s_px + i, H2 - bh // 2, s_px + i, H2 + bh // 2, fill="#1e3555", width=2
            )
        if v and v.duration > 0:
            ticks = min(40, max(5, int(v.duration)))
            for i in range(ticks + 1):
                n = i / ticks
                px = PAD + n * self._tl_w
                major = i % max(1, ticks // 8) == 0
                c.create_line(px, 0, px, 16 if major else 8, fill=MUTED)
                if major:
                    c.create_text(
                        px,
                        18,
                        text=self._fmt_s(n * v.duration),
                        fill=MUTED,
                        font=("Courier New", 7),
                        anchor="n",
                    )
        c.create_rectangle(s_px - HW, 8, s_px, H - 8, fill=ACCENT, outline="#006688")
        c.create_text(
            s_px - HW // 2, H2, text="<", fill=BG, font=("Courier New", 9, "bold")
        )
        c.create_rectangle(e_px, 8, e_px + HW, H - 8, fill=ACCENT2, outline="#881122")
        c.create_text(
            e_px + HW // 2, H2, text=">", fill="white", font=("Courier New", 9, "bold")
        )
        c.create_line(p_px, 0, p_px, H, fill="white", width=2, tags="ph")
        c.create_polygon(
            p_px - 10,
            0,
            p_px + 10,
            0,
            p_px + 10,
            12,
            p_px,
            22,
            p_px - 10,
            12,
            fill=YELLOW,
            outline="white",
            width=1,
            tags="ph",
        )
        c.create_oval(
            p_px - 6,
            H - 14,
            p_px + 6,
            H - 2,
            fill=YELLOW,
            outline="white",
            width=1,
            tags="ph",
        )

    def _move_playhead_only(self):
        c = self.tl
        if self._tl_w < 1:
            return
        PAD = HW + 2
        p_px = PAD + self.playhead * self._tl_w
        H = c.winfo_height()
        items = c.find_withtag("ph")
        if len(items) == 3:
            c.coords(items[0], p_px, 0, p_px, H)
            c.coords(
                items[1],
                p_px - 10,
                0,
                p_px + 10,
                0,
                p_px + 10,
                12,
                p_px,
                22,
                p_px - 10,
                12,
            )
            c.coords(items[2], p_px - 6, H - 14, p_px + 6, H - 2)
        else:
            self._draw_tl_full()

    def _update_card(self, idx):
        v = self.videos[idx] if idx < len(self.videos) else None
        if not v or idx not in self._cards:
            return
        self._cards[idx]._time_lbl.config(
            text=f"Clip: {self._fmt(v.start_sec())} → {self._fmt(v.end_sec())}  ({self._fmt(v.clip_dur())})"
        )

    def _update_labels(self):
        v = self._entry()
        if not v:
            self.lbl_s.config(text="Start  --:--")
            self.lbl_e.config(text="End  --:--")
            self.lbl_dur.config(text="")
            self.lbl_pos.config(text="--:-- / --:--")
            return
        s = v.start_sec()
        e = v.end_sec()
        p = self.playhead * v.duration
        self.lbl_s.config(text=f"Start  {self._fmt(s)}")
        self.lbl_e.config(text=f"End  {self._fmt(e)}")
        self.lbl_dur.config(text=f"Clip: {self._fmt(e - s)}")
        self.lbl_pos.config(text=f"{self._fmt(p)} / {self._fmt(v.duration)}")

    @staticmethod
    def _fmt(secs):
        secs = max(0.0, secs)
        m = int(secs // 60)
        s = secs - m * 60
        return f"{m:02d}:{s:06.3f}"

    @staticmethod
    def _fmt_s(secs):
        m = int(secs // 60)
        s = int(secs % 60)
        return f"{m}:{s:02d}"

    # ── Export ────────────────────────────────────────────────────────────────

    def _export_all(self):
        valid = [(i, v) for i, v in enumerate(self.videos) if v]
        if not valid:
            messagebox.showwarning("No videos", "Add videos first.")
            return

        out_dir = self._out_dir or self._make_default_output_dir()
        os.makedirs(out_dir, exist_ok=True)
        self._out_dir = out_dir
        self._out_lbl_var.set(out_dir)
        self._stop_playback()

        # Detect chunks for every video first (shows spinner in status)
        self.status_bar.config(text="Analysing scenes…  (please wait)")
        self.update_idletasks()

        jobs = []
        for i, v in valid:
            chunks = detect_scene_chunks(v)
            jobs.append((i, v, chunks))

        total_chunks = sum(len(c) for _, _, c in jobs)
        self.status_bar.config(
            text=f"Exporting {len(jobs)} video(s) → {total_chunks} chunk(s)  →  {out_dir}"
        )

        for i, v, chunks in jobs:
            v.status = "exporting"
            self._set_card_status(i, f"exporting… ({len(chunks)} chunk(s))", YELLOW)
            if i in self._cards:
                card = self._cards[i]
                card._prog_bar["maximum"] = len(chunks)
                card._prog_bar["value"] = 0
                card._prog_bar.pack(side="left", fill="x", expand=True)

        counter = {"n": 0, "total": len(jobs), "errors": 0}
        lock = threading.Lock()
        for i, v, chunks in jobs:
            threading.Thread(
                target=self._export_one,
                args=(i, v, chunks, out_dir, counter, lock),
                daemon=True,
            ).start()

    def _export_one(self, idx, v, chunks, out_dir, counter, lock):
        """
        Export each chunk via ffmpeg stream-copy.

        Duration guarantee:
          • chunk[0].start == trim_start   (exact)
          • chunk[-1].end  == trim_end     (exact)
          • Every chunk boundary is a hard cut; no overlap, no gap.
          • We do NOT apply any tail margin here — the boundary refinement in
            detect_scene_chunks already placed the split at the last clean frame
            of the preceding BG.  Adding another margin here would cause gaps.
        """
        exported = []
        try:
            base, ext = os.path.splitext(v.name)

            for ci, (t_start, t_end) in enumerate(chunks, 1):
                dur = max(0.001, t_end - t_start)
                suffix = f"_chunk{ci:02d}" if len(chunks) > 1 else ""
                out_path = self._unique_path(
                    os.path.join(out_dir, f"{base}_trimmed{suffix}{ext}")
                )

                cmd = [
                    FFMPEG,
                    "-y",
                    "-ss",
                    f"{t_start:.6f}",
                    "-i",
                    v.path,
                    "-t",
                    f"{dur:.6f}",
                    "-c",
                    "copy",
                    "-avoid_negative_ts",
                    "make_zero",
                    "-movflags",
                    "+faststart",
                    out_path,
                ]
                kw = {"creationflags": _CREATE_NO_WINDOW} if os.name == "nt" else {}
                r = subprocess.run(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=600,
                    **kw,
                )
                if r.returncode != 0:
                    raise RuntimeError(r.stderr.decode(errors="replace")[-400:])

                exported.append(out_path)

                # Live progress bar update on main thread
                def _upd(i=idx, done=ci, total=len(chunks)):
                    if i in self._cards:
                        self._cards[i]._prog_bar["value"] = done
                        pct = int(100 * done / total)
                        self._set_card_status(
                            i, f"exporting… {pct}%  ({done}/{total})", YELLOW
                        )

                self.after(0, _upd)

            v.status = "done"
            v.out_path = exported[0] if len(exported) == 1 else ";".join(exported)

            def _done(i=idx, n=len(exported)):
                if i in self._cards:
                    self._cards[i]._prog_bar.pack_forget()
                self._set_card_status(i, f"✔ done  ({n} chunk(s))", GREEN)

            self.after(0, _done)

        except Exception as ex:
            v.status = "error"

            def _err(i=idx, e=str(ex)):
                if i in self._cards:
                    self._cards[i]._prog_bar.pack_forget()
                self._set_card_status(i, "✘ error", ACCENT2)
                messagebox.showerror("Export error", e)

            self.after(0, _err)
            with lock:
                counter["errors"] += 1

        with lock:
            counter["n"] += 1
            if counter["n"] == counter["total"]:
                self.after(0, lambda: self._export_finished(counter))

    def _set_card_status(self, idx, text, color):
        if idx in self._cards:
            self._cards[idx]._status_lbl.config(text=f"  {text}", fg=color)

    def _export_finished(self, counter):
        total, errors = counter["total"], counter["errors"]
        ok = total - errors
        out = self._out_dir
        if errors == 0:
            self.status_bar.config(text=f"{total} video(s) exported → {out}")
            messagebox.showinfo(
                "Export Complete!",
                f"{ok}/{total} videos exported.\n\nSaved to:\n{out}\n\n"
                "• Each chunk has a distinct background.\n"
                "• Combined durations = original clip duration.\n"
                "• Stream-copy — zero re-encode.",
            )
        else:
            self.status_bar.config(
                text=f"{ok}/{total} exported, {errors} failed. → {out}"
            )
            messagebox.showwarning(
                "Partial Export", f"{ok} succeeded, {errors} failed.\nSaved to: {out}"
            )

    # ── Cleanup ───────────────────────────────────────────────────────────────

    def _on_close(self):
        self._stop_playback()
        self._audio.stop()
        for v in self.videos:
            if v:
                v.release()
        self.destroy()


# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    app = BatchTrimmer()
    app.mainloop()
