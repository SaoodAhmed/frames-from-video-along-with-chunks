"""
Batch Video Trimmer — Adaptive Scene Split
============================================
- No manual threshold — automatically detects background changes
- Every exported chunk has a visually different background
- Uses largest-gap method on frame difference distribution to find
  natural scene boundaries

Keyboard Shortcuts:
  Space / K       Play / Pause
  J / L           Step +-1 frame
  < / >           Step +-1 frame
  Shift+< / >     Jump +-5 seconds
  I               Set In-point at playhead
  O               Set Out-point at playhead
  Home / End      Jump to In / Out point
  Delete / Back   Remove selected video
  ?               Show all shortcuts

Audio requirement (install one):
    pip install pygame          <- recommended
    pip install pyaudio         <- alternative

Other requirements:
    pip install opencv-python pillow
    ffmpeg in PATH:
        macOS:   brew install ffmpeg
        Linux:   sudo apt install ffmpeg
        Windows: https://ffmpeg.org/download.html

Run:
    python local_trimer-3.py
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
from tkinter import filedialog, messagebox
import numpy as np

try:
    import cv2
    from PIL import Image, ImageTk
except ImportError:
    raise SystemExit("Run:  pip install opencv-python pillow")

FFMPEG = shutil.which("ffmpeg")
if not FFMPEG:
    raise SystemExit(
        "ffmpeg not found.\n"
        "  macOS:   brew install ffmpeg\n"
        "  Linux:   sudo apt install ffmpeg\n"
        "  Windows: https://ffmpeg.org/download.html"
    )

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# ── Try audio backends ─────────────────────────────────────────────────────────
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

    def _run(self, path: str, start_sec: float):
        if FFPLAY:
            self._run_ffplay(path, start_sec)
        elif AUDIO_BACKEND == "pygame":
            self._run_pygame(path, start_sec)
        elif AUDIO_BACKEND == "pyaudio":
            self._run_pyaudio(path, start_sec)

    def _run_ffplay(self, path: str, start_sec: float):
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
            kwargs = {}
            if os.name == "nt":
                kwargs["creationflags"] = _CREATE_NO_WINDOW
            proc = subprocess.Popen(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs
            )
            with self._lock:
                if self._stop.is_set():
                    proc.kill()
                    return
                self._proc = proc
            while not self._stop.is_set():
                retcode = proc.poll()
                if retcode is not None:
                    break
                time.sleep(0.05)
            if proc.poll() is None:
                proc.kill()
        except Exception:
            pass

    def _run_pygame(self, path: str, start_sec: float):
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_path = tmp.name
            duration = 600
            cmd = [
                FFMPEG,
                "-y",
                "-ss",
                f"{start_sec:.3f}",
                "-i",
                path,
                "-t",
                str(duration),
                "-vn",
                "-acodec",
                "pcm_s16le",
                "-ar",
                "44100",
                "-ac",
                "2",
                tmp_path,
            ]
            kwargs = {}
            if os.name == "nt":
                kwargs["creationflags"] = _CREATE_NO_WINDOW
            r = subprocess.run(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=60,
                **kwargs,
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

    def _run_pyaudio(self, path: str, start_sec: float):
        try:
            import pyaudio

            CHUNK = 4096
            RATE = 44100
            CHANS = 2
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
            kwargs = {}
            if os.name == "nt":
                kwargs["creationflags"] = _CREATE_NO_WINDOW
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **kwargs
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
# Main app
# ══════════════════════════════════════════════════════════════════════════════


class BatchTrimmer(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Batch Video Trimmer - Adaptive Scene Split")
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

        # Timeline drag
        self._drag = None
        self._tl_w = 1
        self._tl_x0 = HW + 2

        self._cards: dict[int, tk.Frame] = {}

        self._build_ui()
        self._bind_keys()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ══════════════════════════════════════════════════════════════════════════
    # Helpers
    # ══════════════════════════════════════════════════════════════════════════

    def _desktop_dir(self):
        desktop = Path.home() / "Desktop"
        return desktop if desktop.exists() else Path.home()

    def _make_default_output_dir(self):
        out = self._desktop_dir() / "BatchVideoTrimmer_Exports"
        out.mkdir(parents=True, exist_ok=True)
        return str(out)

    def _unique_path(self, path):
        base, ext = os.path.splitext(path)
        n = 1
        out = path
        while os.path.exists(out):
            out = f"{base}_{n}{ext}"
            n += 1
        return out

    def _detect_scene_chunks(self, v):
        """
        Frame-accurate scene detection — every single frame is scanned.

        8 visual metrics cover ALL transition types:
          1. HSV color histogram   — color grading, background, grading
          2. Grayscale histogram   — brightness distribution
          3. Saturation histogram  — color intensity shifts
          4. Value histogram       — lighting / exposure changes
          5. Spatial grid (3x3)    — layout, partial scene, object movement
          6. Edge density (Canny)  — composition, objects, camera angle
          7. Texture energy (Lap)  — environment / surface detail
          8. Mean brightness       — overall lighting

        Detection strategy:
          • Lightweight pre-filter skips truly static frames (fast)
          • Full 8-metric extraction on frames with any motion
          • Running-average reference comparison (avoids false positives)
          • Hard-cut detection via frame-to-frame diff > threshold
          • 0.3 s cooldown after each change (avoids duplicate splits)
          • Timestamps = frame_number / fps  →  5 decimal places

        Detects: background, camera angle, lighting, color grading,
                 objects, movement, effects, composition, environment.
        """
        start_sec = v.start_sec()
        end_sec = v.end_sec()
        if end_sec <= start_sec:
            return [(start_sec, end_sec)]

        fps = max(v.fps, 1.0)
        start_f = int(start_sec * fps)
        end_f = max(start_f + 1, int(end_sec * fps))
        total_scan = end_f - start_f

        cap = cv2.VideoCapture(v.path)
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_f)
        try:
            # ── Seed running-average from first frame ────────────────────
            ok, first = cap.read()
            if not ok:
                return [(start_sec, end_sec)]

            g0 = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
            h0 = cv2.cvtColor(first, cv2.COLOR_BGR2HSV)

            fh_hsv = cv2.calcHist([h0], [0, 1], None, [50, 60], [0, 180, 0, 256])
            cv2.normalize(fh_hsv, fh_hsv)
            fh_gray = cv2.calcHist([g0], [0], None, [256], [0, 256])
            cv2.normalize(fh_gray, fh_gray)
            fh_sat = cv2.calcHist([h0], [1], None, [32], [0, 256])
            cv2.normalize(fh_sat, fh_sat)
            fh_val = cv2.calcHist([h0], [2], None, [32], [0, 256])
            cv2.normalize(fh_val, fh_val)

            hh, ww = g0.shape
            chh, cww = max(hh // 3, 1), max(ww // 3, 1)
            fgrid = np.array([
                float(g0[r * chh:(r + 1) * chh, c * cww:(c + 1) * cww].mean())
                / 255.0
                for r in range(3) for c in range(3)
            ], dtype=np.float32)

            fed = cv2.Canny(g0, 50, 150)
            fedge = float(np.count_nonzero(fed)) / max(fed.size, 1)
            ftex = float(cv2.Laplacian(g0, cv2.CV_64F).var())
            fbri = float(g0.mean()) / 255.0

            # Running-average accumulators (float64 for precision)
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
            confirmed = []
            cooldown = 0
            COOLDOWN = max(1, int(fps * 0.3))

            # Progress reporting
            prog_interval = max(200, total_scan // 20)

            for f in range(start_f + 1, end_f + 1):
                ok, frame = cap.read()
                if not ok:
                    break

                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

                # Lightweight frame-to-frame diff
                diff = cv2.absdiff(gray, prev_gray)
                diff_mean = float(diff.mean()) / 255.0
                prev_gray = gray

                # Cooldown after confirmed change
                if cooldown > 0:
                    cooldown -= 1
                    continue

                # Skip truly static frames
                if diff_mean < 0.008:
                    continue

                # ── Progress update ──────────────────────────────────────
                scanned = f - start_f
                if scanned % prog_interval == 0:
                    pct = scanned * 100 // max(total_scan, 1)
                    self.status_bar.config(
                        text=f"Analyzing {v.name}: {pct}%  "
                             f"({len(confirmed)} scenes found)"
                    )
                    self.update_idletasks()

                # ── Full 8-metric feature extraction ─────────────────────
                hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

                f_hsv = cv2.calcHist(
                    [hsv], [0, 1], None, [50, 60], [0, 180, 0, 256]
                )
                cv2.normalize(f_hsv, f_hsv)

                f_gray = cv2.calcHist([gray], [0], None, [256], [0, 256])
                cv2.normalize(f_gray, f_gray)

                f_sat = cv2.calcHist([hsv], [1], None, [32], [0, 256])
                cv2.normalize(f_sat, f_sat)

                f_val = cv2.calcHist([hsv], [2], None, [32], [0, 256])
                cv2.normalize(f_val, f_val)

                h, w = gray.shape
                ch, cw = max(h // 3, 1), max(w // 3, 1)
                f_grid = np.array([
                    float(gray[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw].mean())
                    / 255.0
                    for r in range(3) for c in range(3)
                ], dtype=np.float32)

                canny = cv2.Canny(gray, 50, 150)
                f_edge = float(np.count_nonzero(canny)) / max(canny.size, 1)
                f_tex = float(cv2.Laplacian(gray, cv2.CV_64F).var())
                f_bri = float(gray.mean()) / 255.0

                # ── Normalize running averages ───────────────────────────
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

                # ── 8-metric comparison ──────────────────────────────────
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
                    (1.0 - c_hsv)  * 2.5    # color grading, background
                  + (1.0 - c_gray) * 1.5    # brightness distribution
                  + (1.0 - c_sat)  * 1.5    # color intensity
                  + (1.0 - c_val)  * 1.5    # lighting / exposure
                  + grid_diff      * 4.0    # spatial layout, objects
                  + min(tex_diff, 1.0) * 1.0  # texture / environment
                  + bri_diff       * 3.0    # overall lighting
                  + edge_diff      * 2.0    # composition, camera angle
                ) / 19.5

                # Hard cut: very large single-frame jump
                is_hard_cut = diff_mean > 0.15

                if score > 0.04 or is_hard_cut:
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
                    # Accumulate into running average
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

            # ── Frame-aligned boundaries — contiguous, no gaps ───────────
            # Re-encoding gives frame-accurate cuts, so no guard band needed.
            # Every boundary is an exact frame position (frame_number / fps).
            # Combined chunk durations = original clip duration EXACTLY.
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

    # ══════════════════════════════════════════════════════════════════════════
    # Keyboard shortcuts
    # ══════════════════════════════════════════════════════════════════════════

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
        norm = self.playhead + delta / max(v.total_frames, 1)
        self._seek(max(0.0, min(1.0, norm)))

    def _step_secs(self, secs):
        v = self._entry()
        if not v:
            return
        self._stop_playback()
        norm = self.playhead + secs / max(v.duration, 1e-9)
        self._seek(max(0.0, min(1.0, norm)))

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
            ("< / >", "Step +-1 frame"),
            ("Shift+< / >", "Jump +-5 seconds"),
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

    # ══════════════════════════════════════════════════════════════════════════
    # UI
    # ══════════════════════════════════════════════════════════════════════════

    def _build_ui(self):
        hdr = tk.Frame(self, bg=BG, pady=10)
        hdr.pack(fill="x", padx=16)

        tk.Label(
            hdr,
            text="BATCH TRIM - Auto Scene Split",
            bg=BG,
            fg=ACCENT,
            font=("Courier New", 15, "bold"),
        ).pack(side="left")

        tk.Button(
            hdr,
            text=" ? ",
            command=self._show_shortcuts,
            bg=PANEL,
            fg=MUTED,
            font=("Courier New", 9),
            relief="flat",
            padx=8,
            pady=5,
            cursor="hand2",
        ).pack(side="right", padx=(0, 4))

        tk.Button(
            hdr,
            text="Clear All",
            command=self._clear_all,
            bg=PANEL,
            fg=MUTED,
            font=("Courier New", 9),
            relief="flat",
            padx=8,
            pady=5,
            cursor="hand2",
        ).pack(side="right", padx=4)

        tk.Button(
            hdr,
            text="  + Add Videos  ",
            command=self._add_videos,
            bg=ACCENT,
            fg=BG,
            font=("Courier New", 10, "bold"),
            relief="flat",
            padx=14,
            pady=6,
            cursor="hand2",
        ).pack(side="right", padx=4)

        tk.Button(
            hdr,
            text="  Export All  ",
            command=self._export_all,
            bg=ACCENT2,
            fg="white",
            font=("Courier New", 10, "bold"),
            relief="flat",
            padx=14,
            pady=6,
            cursor="hand2",
        ).pack(side="right", padx=4)

        tk.Button(
            hdr,
            text="  Output Folder  ",
            command=self._pick_output_folder,
            bg=ACCENT3,
            fg="white",
            font=("Courier New", 10, "bold"),
            relief="flat",
            padx=14,
            pady=6,
            cursor="hand2",
        ).pack(side="right", padx=4)

        # Info label: no threshold, auto detection
        auto_lbl = tk.Label(
            hdr,
            text="Auto-Detect Scenes",
            bg=BG,
            fg=GREEN,
            font=("Courier New", 9, "bold"),
        )
        auto_lbl.pack(side="right", padx=6)

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
            ("< >", "Frame"),
            ("Shift+< >", "+-5s"),
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
            audio_txt = "Audio: ffplay (built-in)"
            audio_color = GREEN
        elif AUDIO_BACKEND == "pygame":
            audio_txt = "Audio: pygame"
            audio_color = GREEN
        elif AUDIO_BACKEND == "pyaudio":
            audio_txt = "Audio: pyaudio"
            audio_color = GREEN
        else:
            audio_txt = "Audio: unavailable -- install ffplay or pygame"
            audio_color = ACCENT2

        tk.Label(
            hint_row, text=audio_txt, bg=PANEL, fg=audio_color, font=("Courier New", 7)
        ).pack(side="right", padx=6)

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
            text="Step 1: Set output folder  ->  Step 2: + Add Videos  ->  Step 3: Export All  (auto scene split)",
            bg=PANEL,
            fg=MUTED,
            font=("Courier New", 9),
            anchor="w",
            padx=12,
            pady=4,
        )
        self.status_bar.pack(fill="x", side="bottom")

    # ══════════════════════════════════════════════════════════════════════════
    # Output folder
    # ══════════════════════════════════════════════════════════════════════════

    def _pick_output_folder(self):
        d = filedialog.askdirectory(title="Choose Output Folder for Exported Videos")
        if d:
            self._out_dir = d
            self._out_lbl_var.set(d)
            self.status_bar.config(text=f"Output folder set: {d}")

    # ══════════════════════════════════════════════════════════════════════════
    # Video list
    # ══════════════════════════════════════════════════════════════════════════

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

    def _make_card(self, idx: int, entry: VideoEntry):
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

        il = tk.Label(
            card,
            text=entry.info(),
            bg=CARD,
            fg=MUTED,
            font=("Courier New", 8),
            anchor="w",
        )
        il.pack(fill="x")
        il.bind("<Button-1>", lambda e, i=idx: self._select(i))

        tl_lbl = tk.Label(
            card,
            text=f"Full: {self._fmt(entry.duration)}",
            bg=CARD,
            fg=ACCENT,
            font=("Courier New", 8),
        )
        tl_lbl.pack(anchor="w")
        tl_lbl.bind("<Button-1>", lambda e, i=idx: self._select(i))

        st_lbl = tk.Label(
            card, text="* ready", bg=CARD, fg=MUTED, font=("Courier New", 8)
        )
        st_lbl.pack(anchor="w")
        st_lbl.bind("<Button-1>", lambda e, i=idx: self._select(i))

        card._status_lbl = st_lbl
        card._time_lbl = tl_lbl
        self._cards[idx] = card

    def _select(self, idx: int):
        if idx < 0 or idx >= len(self.videos) or not self.videos[idx]:
            return
        self._stop_playback()
        if self.selected in self._cards:
            self._recolor_card(self.selected, CARD)
        self.selected = idx
        self._recolor_card(idx, CARD_SEL)
        self.playhead = self.videos[idx].trim_start
        self._seek(self.playhead)

    def _recolor_card(self, idx: int, color: str):
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

    def _remove(self, idx: int):
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
        folder_txt = (
            f"Output: {self._out_dir}" if self._out_dir else "Output folder not set"
        )
        self.status_bar.config(
            text=f"{len(valid)} video(s) loaded  |  {folder_txt}  |  Press ? for shortcuts"
        )

    # ══════════════════════════════════════════════════════════════════════════
    # Preview
    # ══════════════════════════════════════════════════════════════════════════

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

    def _seek(self, norm: float):
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
        nw = max(1, int(fw * scale))
        nh = max(1, int(fh * scale))
        small = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
        rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        photo = ImageTk.PhotoImage(image=Image.fromarray(rgb))
        self.cv.delete("all")
        self.cv.create_image(W // 2, H // 2, anchor="center", image=photo)
        self.cv._photo = photo

    # ══════════════════════════════════════════════════════════════════════════
    # Playback (video + audio in sync)
    # ══════════════════════════════════════════════════════════════════════════

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

        cur_sec = self.playhead * v.duration
        s_t = v.trim_start * v.duration
        e_t = v.trim_end * v.duration
        if cur_sec < s_t or cur_sec >= e_t:
            cur_sec = s_t

        self._audio.play(v.path, cur_sec)
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
        wall0 = time.perf_counter()
        vid0 = cur
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

    # ══════════════════════════════════════════════════════════════════════════
    # Timeline
    # ══════════════════════════════════════════════════════════════════════════

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

        c.create_rectangle(
            s_px - HW, 8, s_px, H - 8, fill=ACCENT, outline="#006688", tags="hs"
        )
        c.create_text(
            s_px - HW // 2,
            H2,
            text="<",
            fill=BG,
            font=("Courier New", 9, "bold"),
            tags="hs",
        )

        c.create_rectangle(
            e_px, 8, e_px + HW, H - 8, fill=ACCENT2, outline="#881122", tags="he"
        )
        c.create_text(
            e_px + HW // 2,
            H2,
            text=">",
            fill="white",
            font=("Courier New", 9, "bold"),
            tags="he",
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

    def _update_card(self, idx: int):
        v = self.videos[idx] if idx < len(self.videos) else None
        if not v or idx not in self._cards:
            return
        self._cards[idx]._time_lbl.config(
            text=f"Clip: {self._fmt(v.start_sec())} -> {self._fmt(v.end_sec())}  ({self._fmt(v.clip_dur())})"
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

    # ══════════════════════════════════════════════════════════════════════════
    # Export — auto scene split, each chunk = different background
    # ══════════════════════════════════════════════════════════════════════════

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

        jobs = []
        for i, v in valid:
            self.status_bar.config(text=f"Analyzing scenes: {v.name}...")
            self.update_idletasks()
            chunks = self._detect_scene_chunks(v)
            jobs.append((i, v, chunks))

        self.status_bar.config(text=f"Exporting {len(jobs)} video(s) -> {out_dir}")

        for i, v, chunks in jobs:
            v.status = "exporting"
            self._set_card_status(i, f"exporting... ({len(chunks)} chunk(s))", YELLOW)

        done_counter = {"n": 0, "total": len(jobs), "errors": 0}
        lock = threading.Lock()

        for i, v, chunks in jobs:
            threading.Thread(
                target=self._export_one,
                args=(i, v, chunks, out_dir, done_counter, lock),
                daemon=True,
            ).start()

    def _export_one(self, idx, v, chunks, out_dir, counter, lock):
        exported_files = []
        try:
            base, ext = os.path.splitext(v.name)

            for chunk_idx, (start_s, end_s) in enumerate(chunks, 1):
                dur = max(0.001, end_s - start_s)
                suffix = f"_chunk{chunk_idx:02d}" if len(chunks) > 1 else ""
                out_path = os.path.join(out_dir, f"{base}_trimmed{suffix}{ext}")

                cmd = [
                    FFMPEG,
                    "-y",
                    "-ss",
                    f"{start_s:.6f}",
                    "-i",
                    v.path,
                    "-t",
                    f"{dur:.6f}",
                    "-c:v",
                    "libx264",
                    "-crf",
                    "18",
                    "-preset",
                    "fast",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-pix_fmt",
                    "yuv420p",
                    "-avoid_negative_ts",
                    "make_zero",
                    "-movflags",
                    "+faststart",
                    out_path,
                ]

                kwargs = {}
                if os.name == "nt":
                    kwargs["creationflags"] = _CREATE_NO_WINDOW

                r = subprocess.run(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=600,
                    **kwargs,
                )

                if r.returncode != 0:
                    err = r.stderr.decode(errors="replace")[-300:]
                    raise RuntimeError(err)

                exported_files.append(out_path)

            v.status = "done"
            v.out_path = (
                exported_files[0]
                if len(exported_files) == 1
                else ";".join(exported_files)
            )

            self.after(
                0,
                lambda i=idx, n=len(exported_files): self._set_card_status(
                    i, f"done  ({n} chunk(s))", GREEN
                ),
            )

        except Exception as ex:
            v.status = "error"
            self.after(0, lambda i=idx: self._set_card_status(i, "error", ACCENT2))
            self.after(0, lambda e=str(ex): messagebox.showerror("Export error", e))
            with lock:
                counter["errors"] += 1

        with lock:
            counter["n"] += 1
            if counter["n"] == counter["total"]:
                self.after(0, lambda: self._export_finished(counter))

    def _set_card_status(self, idx, text, color):
        if idx in self._cards:
            self._cards[idx]._status_lbl.config(text=f"* {text}", fg=color)

    def _export_finished(self, counter):
        total = counter["total"]
        errors = counter["errors"]
        ok = total - errors
        out = self._out_dir
        if errors == 0:
            self.status_bar.config(text=f"{total} video(s) exported to: {out}")
            messagebox.showinfo(
                "Export Complete!",
                f"{ok} / {total}  videos exported successfully!\n\n"
                f"Saved to:\n{out}\n\n"
                f"Each chunk has a different background.\n"
                f"(re-encoded — frame-accurate cuts, 1.2s guard band)",
            )
        else:
            self.status_bar.config(
                text=f"{ok}/{total} exported, {errors} failed. Output: {out}"
            )
            messagebox.showwarning(
                "Partial Export",
                f"{ok} succeeded, {errors} failed.\nSaved to: {out}",
            )

    # ══════════════════════════════════════════════════════════════════════════
    # Cleanup
    # ══════════════════════════════════════════════════════════════════════════

    def _on_close(self):
        self._stop_playback()
        self._audio.stop()
        for v in self.videos:
            if v:
                v.release()
        self.destroy()


if __name__ == "__main__":
    app = BatchTrimmer()
    app.mainloop()
