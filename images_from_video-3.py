"""
FrameForge - Tkinter Video Frame Extractor  v3.1
===============================================
Run:  python images_from_video-2.py

Requirements:
    pip install opencv-python-headless Pillow numpy
    # tkinter ships with Python; on Ubuntu: sudo apt install python3-tk

Changelog v3.1:
  * MEMORY FIX: Full frames stored as compressed JPEG bytes instead of
    raw PIL Images (10-30x less RAM). Prevents crashes on "Every Frame"
    and high-fps modes.
  * Frame count safety: warns above 2000 frames, hard cap at 5000.
  * Progress throttle: updates every 50 source frames instead of every
    single frame, preventing GUI queue flooding.
  * Thumbnail auto-scaling: base thumbnails stored at 480px wide and
    resized to exact card dimensions using resize() (not thumbnail()),
    so switching columns always produces correctly-sized images.
  * Batch gallery rendering: cards created 30 at a time with after()
    callbacks, keeping the UI responsive during large extractions.
  * Debounced canvas resize: pending re-renders are cancelled before
    scheduling new ones, preventing stacking of redundant renders.
"""

import io
import os
import queue
import threading
import time
import tkinter as tk
import zipfile
from tkinter import filedialog, messagebox, ttk

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageTk

# ─────────────────────────── Colour Palette ──────────────────────────────────
BG = "#0d0d0f"
SURFACE = "#16161a"
CARD = "#1a1a20"
BORDER = "#2a2a32"
ACCENT = "#e8ff47"
ACCENT2 = "#47ffd4"
ACCENT3 = "#ff9f43"
ACCENT4 = "#a29bfe"
TEXT = "#f0f0f5"
MUTED = "#6b6b7a"
DANGER = "#ff4757"
WHITE = "#ffffff"
BTN_FG = "#0d0d0f"

FONT_MONO = ("Courier New", 9, "bold")
FONT_MONO_SM = ("Courier New", 8)
FONT_UI = ("Segoe UI", 10)
FONT_SUB = ("Segoe UI", 9)

BASE_THUMB_W = 480
BASE_THUMB_H = 270
MAX_FRAMES = 5000
WARN_FRAMES = 2000
PROGRESS_INTERVAL = 50
RENDER_BATCH = 30

# ─────────────────────────── Preset Definitions ───────────────────────────────
PRESETS = [
    ("Every Frame", "source", "Full fidelity — every single frame", ACCENT),
    ("10 fps", 10.0, "Fine detail — dense sampling, fast action", ACCENT),
    ("5 fps", 5.0, "High-rate — smooth motion coverage", ACCENT),
    ("3 fps", 3.0, "Motion detail — balanced speed & coverage", ACCENT3),
    ("2 fps", 2.0, "Action moments — good for dialogue/action", ACCENT3),
    ("1 fps", 1.0, "Key moments — one frame per second", ACCENT3),
    ("Smart Scene", "scene", "Scene cuts only — histogram-diff detection", ACCENT4),
    ("1 per 5 s", 0.2, "Scene level — broad story overview", ACCENT3),
    ("Thumb Strip", "auto", "Auto-scaled strip — quick overview", ACCENT2),
    ("Custom FPS", "custom", "You choose — enter any rate below", MUTED),
]

SCENE_THRESHOLD_DEFAULT = 30.0


def get_preset_fps(
    label: str, video_fps: float, duration: float, custom_val: float
) -> float:
    for name, val, *_ in PRESETS:
        if name == label:
            if val == "source":
                return video_fps
            if val == "auto":
                return round(min(2.0, max(0.2, 20.0 / max(duration, 1))), 2)
            if val == "custom":
                return custom_val
            if val == "scene":
                return -1.0
            return float(val)
    return 1.0


# ─────────────────────────── Helpers ─────────────────────────────────────────


def fmt_time(secs: float) -> str:
    m, s = divmod(int(secs), 60)
    ms = int((secs % 1) * 10)
    return f"{m:02d}:{s:02d}.{ms}"


def pil_to_bytes(img: Image.Image, quality: int = 92) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def compute_thumb_size(
    canvas_width: int, cols: int, gap: int = 10, padding: int = 8
) -> tuple[int, int]:
    total_gap = gap * (cols + 1)
    w = max(60, (canvas_width - total_gap - padding) // cols)
    h = int(w * 9 / 16)
    return w, h


def _hist_diff(prev_gray, curr_gray) -> float:
    hist_prev = cv2.calcHist([prev_gray], [0], None, [64], [0, 256])
    hist_curr = cv2.calcHist([curr_gray], [0], None, [64], [0, 256])
    cv2.normalize(hist_prev, hist_prev)
    cv2.normalize(hist_curr, hist_curr)
    dist = cv2.compareHist(hist_prev, hist_curr, cv2.HISTCMP_BHATTACHARYYA)
    return dist * 100.0


# ─────────────────────────── Frame Extractor (background thread) ──────────────


def extract_frames_thread(
    video_path: str,
    extract_fps: float,
    result_q: queue.Queue,
    sharpness: float = 1.0,
    scene_threshold: float = SCENE_THRESHOLD_DEFAULT,
    stop_event: threading.Event = None,
    max_frames: int = MAX_FRAMES,
):
    """Extract frames and push results onto *result_q*.

    Full frames are stored as compressed JPEG bytes (not PIL Images)
    to keep memory usage manageable. Thumbs are stored as PIL Images
    at BASE_THUMB_W x BASE_THUMB_H for later resizing.

    extract_fps == -1.0  ->  Smart Scene mode.
    """
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            result_q.put(("error", "Cannot open video file."))
            return

        src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        frames: list = []
        frame_no = 0
        scene_mode = extract_fps == -1.0
        last_progress = -PROGRESS_INTERVAL  # force first update

        if scene_mode:
            prev_gray = None
            first_frame_captured = False
        else:
            interval = max(1, int(round(src_fps / extract_fps)))

        while True:
            # Check cancellation
            if stop_event and stop_event.is_set():
                cap.release()
                result_q.put(("error", "Extraction cancelled."))
                return

            ret, frame = cap.read()
            if not ret:
                break

            should_capture = False

            if scene_mode:
                small = cv2.resize(frame, (160, 90))
                curr_gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

                if prev_gray is None or not first_frame_captured:
                    should_capture = True
                    first_frame_captured = True
                else:
                    diff = _hist_diff(prev_gray, curr_gray)
                    if diff >= scene_threshold:
                        should_capture = True

                prev_gray = curr_gray
            else:
                should_capture = frame_no % interval == 0

            if should_capture:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                full_pil = Image.fromarray(rgb)

                if sharpness != 1.0:
                    full_pil = ImageEnhance.Sharpness(full_pil).enhance(sharpness)

                # Store full frame as compressed JPEG bytes (not PIL Image)
                full_bytes = pil_to_bytes(full_pil, quality=92)
                full_size = (full_pil.width, full_pil.height)
                del full_pil  # free large PIL memory immediately

                # Create base thumbnail at fixed size for later scaling
                rgb_small = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                thumb_pil = Image.fromarray(rgb_small)
                thumb_pil = thumb_pil.resize(
                    (BASE_THUMB_W, BASE_THUMB_H), Image.LANCZOS
                )

                ts = frame_no / src_fps
                frames.append(
                    {
                        "idx": len(frames),
                        "frame_no": frame_no,
                        "ts": ts,
                        "thumb": thumb_pil,
                        "full_bytes": full_bytes,
                        "full_size": full_size,
                    }
                )

                # Throttled progress: only send every PROGRESS_INTERVAL frames
                if (frame_no - last_progress) >= PROGRESS_INTERVAL:
                    result_q.put(("progress", frame_no, total, len(frames)))
                    last_progress = frame_no

                # Hard cap
                if len(frames) >= max_frames:
                    result_q.put(("progress", frame_no, total, len(frames)))
                    break

            elif (frame_no - last_progress) >= PROGRESS_INTERVAL:
                result_q.put(("progress", frame_no, total, len(frames)))
                last_progress = frame_no

            frame_no += 1

        cap.release()
        result_q.put(("done", frames, len(frames) >= max_frames))
    except Exception as e:
        result_q.put(("error", str(e)))


# ─────────────────────────── Main Application ────────────────────────────────


class FrameForgeApp(tk.Tk):
    GAP = 8
    PADDING = 4

    def __init__(self):
        super().__init__()
        self.title("FrameForge  v3.1 · Video Frame Extractor")
        self.configure(bg=BG)
        self.geometry("1380x860")
        self.minsize(960, 640)

        # ── State ─────────────────────────────────────────────────────────────
        self.video_path: str = ""
        self.video_info: dict = {}
        self.frames: list = []
        self.selected: set = set()
        self.photo_cache: dict = {}
        self._extract_q: queue.Queue = queue.Queue()
        self._busy: bool = False
        self._render_after_id = None
        self._stop_event: threading.Event = None

        # Tkinter vars
        self.jpeg_quality = tk.IntVar(value=88)
        self.cols_var = tk.IntVar(value=4)
        self.fps_mode = tk.StringVar(value="1 fps")
        self.custom_fps_v = tk.DoubleVar(value=1.0)
        self.sharpness_var = tk.DoubleVar(value=1.0)
        self.scene_threshold_var = tk.DoubleVar(value=SCENE_THRESHOLD_DEFAULT)

        self._preview_win = None
        self._preview_frame = None

        self._build_ui()
        self._apply_ttk_styles()

        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ══════════════════════════ UI Construction ═══════════════════════════════

    def _build_ui(self):
        self.sidebar = tk.Frame(self, bg=SURFACE, width=300)
        self.sidebar.pack(side=tk.LEFT, fill=tk.Y)
        self.sidebar.pack_propagate(False)
        self._build_sidebar()

        main = tk.Frame(self, bg=BG)
        main.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self._build_header(main)
        self._build_toolbar(main)
        self._build_gallery(main)
        self._build_statusbar(main)

    # ── Sidebar ───────────────────────────────────────────────────────────────

    def _build_sidebar(self):
        sb = self.sidebar

        tk.Frame(sb, bg=ACCENT, height=3).pack(fill=tk.X)

        sb_canvas = tk.Canvas(sb, bg=SURFACE, highlightthickness=0)
        sb_vsb = tk.Scrollbar(
            sb,
            orient=tk.VERTICAL,
            command=sb_canvas.yview,
            bg=SURFACE,
            troughcolor=SURFACE,
        )
        sb_canvas.configure(yscrollcommand=sb_vsb.set)
        sb_vsb.pack(side=tk.RIGHT, fill=tk.Y)
        sb_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        inner = tk.Frame(sb_canvas, bg=SURFACE)
        win_id = sb_canvas.create_window((0, 0), window=inner, anchor="nw")
        inner.bind(
            "<Configure>",
            lambda e: sb_canvas.configure(scrollregion=sb_canvas.bbox("all")),
        )
        sb_canvas.bind(
            "<Configure>", lambda e: sb_canvas.itemconfig(win_id, width=e.width)
        )
        sb_canvas.bind(
            "<MouseWheel>",
            lambda e: sb_canvas.yview_scroll(-1 * (e.delta // 120), "units"),
        )

        s = inner

        # ── Upload ────────────────────────────────────────────────────────
        self._sect(s, "CONFIGURATION")
        self._btn(s, "  Upload Video", self._browse_video, ACCENT, BTN_FG).pack(
            fill=tk.X, padx=14, pady=4
        )
        self.lbl_video = tk.Label(
            s,
            text="No file selected",
            bg=SURFACE,
            fg=MUTED,
            font=FONT_MONO_SM,
            wraplength=250,
            justify=tk.LEFT,
        )
        self.lbl_video.pack(anchor="w", padx=14, pady=(0, 6))

        self._sep(s)

        # ── Video Info ────────────────────────────────────────────────────
        self._sect(s, "VIDEO INFO")
        self._info_labels = {}
        for key in ("Resolution", "Source FPS", "Duration", "Total Frames"):
            row = tk.Frame(s, bg=SURFACE)
            row.pack(fill=tk.X, padx=14, pady=1)
            tk.Label(
                row,
                text=key + ":",
                bg=SURFACE,
                fg=MUTED,
                font=FONT_MONO_SM,
                width=13,
                anchor="w",
            ).pack(side=tk.LEFT)
            lbl = tk.Label(
                row, text="—", bg=SURFACE, fg=TEXT, font=FONT_MONO_SM, anchor="w"
            )
            lbl.pack(side=tk.LEFT)
            self._info_labels[key] = lbl

        self._sep(s)

        # ── Extraction Presets ────────────────────────────────────────────
        self._sect(s, "EXTRACTION RATE")

        self.lbl_preset_desc = tk.Label(
            s,
            text="",
            bg=SURFACE,
            fg=ACCENT,
            font=FONT_MONO_SM,
            wraplength=260,
            justify=tk.LEFT,
        )
        self.lbl_preset_desc.pack(anchor="w", padx=14, pady=(0, 4))

        self.rec_btns = {}
        for name, val, desc, color in PRESETS:
            row = tk.Frame(s, bg=SURFACE)
            row.pack(fill=tk.X, padx=8, pady=1)

            rb = tk.Radiobutton(
                row,
                text=name,
                variable=self.fps_mode,
                value=name,
                bg=SURFACE,
                fg=TEXT,
                selectcolor=SURFACE,
                activebackground=SURFACE,
                activeforeground=color,
                font=FONT_UI,
                anchor="w",
                command=lambda n=name, d=desc: self._on_mode_change(n, d),
            )
            rb.pack(side=tk.LEFT)

            badge_text = f"{val} fps" if isinstance(val, float) else f"({val})"
            badge = tk.Label(
                row,
                text=badge_text,
                bg=BORDER,
                fg=color,
                font=FONT_MONO_SM,
                padx=4,
                pady=1,
            )
            badge.pack(side=tk.RIGHT, padx=4)

            self.rec_btns[name] = {"rb": rb, "badge": badge, "desc": desc}

        self.custom_frame = tk.Frame(s, bg=SURFACE)
        tk.Label(
            self.custom_frame, text="FPS:", bg=SURFACE, fg=TEXT, font=FONT_UI
        ).pack(side=tk.LEFT, padx=(14, 4))
        self.spin_fps = tk.Spinbox(
            self.custom_frame,
            from_=0.1,
            to=120.0,
            increment=0.5,
            textvariable=self.custom_fps_v,
            width=7,
            bg=CARD,
            fg=ACCENT,
            insertbackground=ACCENT,
            font=FONT_MONO,
            relief="flat",
            highlightbackground=BORDER,
            highlightthickness=1,
        )
        self.spin_fps.pack(side=tk.LEFT, padx=4)

        self.scene_frame = tk.Frame(s, bg=SURFACE)

        tk.Label(
            self.scene_frame,
            text="Sensitivity:",
            bg=SURFACE,
            fg=ACCENT4,
            font=FONT_MONO_SM,
        ).pack(anchor="w", padx=14, pady=(4, 0))

        sc_inner = tk.Frame(self.scene_frame, bg=SURFACE)
        sc_inner.pack(fill=tk.X, padx=14, pady=(0, 4))

        tk.Label(sc_inner, text="Subtle", bg=SURFACE, fg=MUTED, font=FONT_MONO_SM).pack(
            side=tk.LEFT
        )
        self.slider_scene = tk.Scale(
            sc_inner,
            from_=5.0,
            to=80.0,
            resolution=1.0,
            orient=tk.HORIZONTAL,
            variable=self.scene_threshold_var,
            bg=SURFACE,
            fg=TEXT,
            troughcolor=BORDER,
            activebackground=ACCENT4,
            highlightthickness=0,
            length=120,
            sliderlength=14,
            showvalue=False,
            command=lambda _: self._update_scene_label(),
        )
        self.slider_scene.pack(side=tk.LEFT)
        tk.Label(sc_inner, text="Cuts", bg=SURFACE, fg=MUTED, font=FONT_MONO_SM).pack(
            side=tk.LEFT
        )

        self.lbl_scene_val = tk.Label(
            self.scene_frame,
            text="",
            bg=SURFACE,
            fg=ACCENT4,
            font=FONT_MONO_SM,
        )
        self.lbl_scene_val.pack(anchor="e", padx=14)
        self._update_scene_label()

        self._sep(s)

        # ── Image Enhancement ─────────────────────────────────────────────
        self._sect(s, "IMAGE SHARPNESS")
        sh_row = tk.Frame(s, bg=SURFACE)
        sh_row.pack(fill=tk.X, padx=14, pady=4)
        tk.Label(sh_row, text="Soft", bg=SURFACE, fg=MUTED, font=FONT_MONO_SM).pack(
            side=tk.LEFT
        )
        self.slider_sharp = tk.Scale(
            sh_row,
            from_=0.5,
            to=3.0,
            resolution=0.1,
            orient=tk.HORIZONTAL,
            variable=self.sharpness_var,
            bg=SURFACE,
            fg=TEXT,
            troughcolor=BORDER,
            activebackground=ACCENT,
            highlightthickness=0,
            length=140,
            sliderlength=14,
            showvalue=False,
        )
        self.slider_sharp.pack(side=tk.LEFT)
        tk.Label(sh_row, text="Sharp", bg=SURFACE, fg=MUTED, font=FONT_MONO_SM).pack(
            side=tk.LEFT
        )
        self.lbl_sharp = tk.Label(
            s,
            textvariable=self.sharpness_var,
            bg=SURFACE,
            fg=ACCENT2,
            font=FONT_MONO_SM,
        )
        self.lbl_sharp.pack(anchor="e", padx=14)

        self._sep(s)

        # ── Grid Columns ──────────────────────────────────────────────────
        self._sect(s, "GRID COLUMNS")
        col_row = tk.Frame(s, bg=SURFACE)
        col_row.pack(fill=tk.X, padx=14, pady=4)
        for c in (2, 3, 4, 5, 6):
            b = tk.Radiobutton(
                col_row,
                text=str(c),
                variable=self.cols_var,
                value=c,
                bg=SURFACE,
                fg=TEXT,
                selectcolor=SURFACE,
                activebackground=SURFACE,
                activeforeground=ACCENT,
                font=FONT_MONO,
                command=self._relayout,
            )
            b.pack(side=tk.LEFT, padx=5)

        self._sep(s)

        # ── JPEG Quality ──────────────────────────────────────────────────
        self._sect(s, "JPEG QUALITY")
        q_row = tk.Frame(s, bg=SURFACE)
        q_row.pack(fill=tk.X, padx=14, pady=4)
        self.slider_q = tk.Scale(
            q_row,
            from_=50,
            to=100,
            orient=tk.HORIZONTAL,
            variable=self.jpeg_quality,
            bg=SURFACE,
            fg=TEXT,
            troughcolor=BORDER,
            activebackground=ACCENT,
            highlightthickness=0,
            length=160,
            sliderlength=14,
        )
        self.slider_q.pack(side=tk.LEFT)
        tk.Label(
            q_row,
            textvariable=self.jpeg_quality,
            bg=SURFACE,
            fg=ACCENT,
            font=FONT_MONO,
            width=3,
        ).pack(side=tk.LEFT)

        self._sep(s)

        # ── Extract Button ────────────────────────────────────────────────
        self._btn(s, "  Extract Frames", self._start_extraction, ACCENT, BTN_FG).pack(
            fill=tk.X, padx=14, pady=6
        )

        self.progress_var = tk.DoubleVar(value=0)
        self.progressbar = ttk.Progressbar(
            s,
            variable=self.progress_var,
            maximum=100,
            mode="determinate",
            style="FF.Horizontal.TProgressbar",
        )
        self.progressbar.pack(fill=tk.X, padx=14, pady=(0, 2))

        self.lbl_progress = tk.Label(
            s, text="", bg=SURFACE, fg=MUTED, font=FONT_MONO_SM
        )
        self.lbl_progress.pack(anchor="w", padx=14, pady=(0, 8))

    # ── Header ────────────────────────────────────────────────────────────────

    def _build_header(self, parent):
        hdr = tk.Frame(parent, bg=CARD, height=68)
        hdr.pack(fill=tk.X)
        hdr.pack_propagate(False)

        inner = tk.Frame(hdr, bg=CARD)
        inner.pack(side=tk.LEFT, padx=20, pady=14)
        tk.Label(
            inner, text="Frame", bg=CARD, fg=TEXT, font=("Courier New", 22, "bold")
        ).pack(side=tk.LEFT)
        tk.Label(
            inner, text="Forge", bg=CARD, fg=ACCENT, font=("Courier New", 22, "bold")
        ).pack(side=tk.LEFT)
        tk.Label(inner, text="  v3.1", bg=CARD, fg=MUTED, font=("Courier New", 10)).pack(
            side=tk.LEFT, pady=8
        )
        tk.Label(
            hdr,
            text="Upload · Extract · Preview · Download",
            bg=CARD,
            fg=MUTED,
            font=FONT_SUB,
        ).pack(side=tk.LEFT, padx=8)

        self.lbl_stat = tk.Label(hdr, text="", bg=CARD, fg=ACCENT, font=FONT_MONO_SM)
        self.lbl_stat.pack(side=tk.RIGHT, padx=20)

    # ── Toolbar ───────────────────────────────────────────────────────────────

    def _build_toolbar(self, parent):
        tb = tk.Frame(parent, bg=SURFACE, height=42)
        tb.pack(fill=tk.X, padx=8, pady=(5, 0))
        tb.pack_propagate(False)

        self._btn(tb, "All", self._select_all, BORDER, TEXT, True).pack(
            side=tk.LEFT, padx=3, pady=5
        )
        self._btn(tb, "None", self._deselect_all, BORDER, TEXT, True).pack(
            side=tk.LEFT, padx=3, pady=5
        )
        self._btn(tb, "Delete", self._delete_selected, DANGER, WHITE, True).pack(
            side=tk.LEFT, padx=3, pady=5
        )

        tk.Frame(tb, bg=BORDER, width=1).pack(side=tk.LEFT, fill=tk.Y, padx=6, pady=6)

        self._btn(tb, "ZIP All", self._download_all_zip, ACCENT2, BTN_FG, True).pack(
            side=tk.LEFT, padx=3, pady=5
        )
        self._btn(
            tb, "ZIP Selected", self._download_sel_zip, ACCENT, BTN_FG, True
        ).pack(side=tk.LEFT, padx=3, pady=5)

        self.lbl_sel_count = tk.Label(
            tb, text="0 selected", bg=SURFACE, fg=MUTED, font=FONT_MONO_SM
        )
        self.lbl_sel_count.pack(side=tk.RIGHT, padx=12)

    # ── Gallery ───────────────────────────────────────────────────────────────

    def _build_gallery(self, parent):
        wrap = tk.Frame(parent, bg=BG)
        wrap.pack(fill=tk.BOTH, expand=True, padx=6, pady=5)

        self.canvas = tk.Canvas(wrap, bg=BG, highlightthickness=0, yscrollincrement=2)
        vsb = tk.Scrollbar(
            wrap,
            orient=tk.VERTICAL,
            command=self.canvas.yview,
            bg=SURFACE,
            troughcolor=SURFACE,
        )
        self.canvas.configure(yscrollcommand=vsb.set)
        vsb.pack(side=tk.RIGHT, fill=tk.Y)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self.gallery_inner = tk.Frame(self.canvas, bg=BG)
        self._win_id = self.canvas.create_window(
            (0, 0), window=self.gallery_inner, anchor="nw"
        )

        self.gallery_inner.bind("<Configure>", self._on_gallery_cfg)
        self.canvas.bind("<Configure>", self._on_canvas_resize)
        self.canvas.bind("<MouseWheel>", self._on_scroll)
        self.canvas.bind("<Button-4>", self._on_scroll)
        self.canvas.bind("<Button-5>", self._on_scroll)

        self._show_placeholder()

    def _build_statusbar(self, parent):
        sb = tk.Frame(parent, bg=SURFACE, height=22)
        sb.pack(fill=tk.X, side=tk.BOTTOM)
        sb.pack_propagate(False)
        self.lbl_status = tk.Label(
            sb,
            text="Ready — upload a video to begin.",
            bg=SURFACE,
            fg=MUTED,
            font=FONT_MONO_SM,
            anchor="w",
        )
        self.lbl_status.pack(side=tk.LEFT, padx=10)

    # ── Widget helpers ────────────────────────────────────────────────────────

    def _btn(self, parent, text, cmd, bg=ACCENT, fg=BTN_FG, flat=False):
        b = tk.Button(
            parent,
            text=text,
            command=cmd,
            bg=bg,
            fg=fg,
            activebackground=ACCENT2,
            activeforeground=BTN_FG,
            relief="flat",
            font=FONT_MONO_SM if flat else FONT_MONO,
            padx=8,
            pady=3,
            cursor="hand2",
            highlightthickness=0,
            bd=0,
        )
        b.bind("<Enter>", lambda e: b.config(bg=ACCENT2, fg=BTN_FG))
        b.bind("<Leave>", lambda e: b.config(bg=bg, fg=fg))
        return b

    def _sep(self, parent):
        tk.Frame(parent, bg=BORDER, height=1).pack(fill=tk.X, padx=12, pady=5)

    def _sect(self, parent, label):
        tk.Label(
            parent, text=label, bg=SURFACE, fg=MUTED, font=("Courier New", 8, "bold")
        ).pack(anchor="w", padx=14, pady=(10, 2))

    def _apply_ttk_styles(self):
        s = ttk.Style(self)
        s.theme_use("clam")
        s.configure(
            "FF.Horizontal.TProgressbar",
            troughcolor=BORDER,
            background=ACCENT,
            bordercolor=BORDER,
            lightcolor=ACCENT,
            darkcolor=ACCENT,
        )

    # ── Placeholder ───────────────────────────────────────────────────────────

    def _show_placeholder(self):
        for w in self.gallery_inner.winfo_children():
            w.destroy()
        tk.Label(
            self.gallery_inner,
            text="Upload a video and click Extract Frames",
            bg=BG,
            fg=MUTED,
            font=("Segoe UI", 13),
            justify=tk.CENTER,
        ).pack(expand=True, pady=100)

    # ══════════════════════════ Logic ═════════════════════════════════════════

    def _on_close(self):
        """Clean up on window close."""
        if self._stop_event:
            self._stop_event.set()
        if self._render_after_id:
            self.after_cancel(self._render_after_id)
        self.destroy()

    def _browse_video(self):
        path = filedialog.askopenfilename(
            title="Select Video File",
            filetypes=[
                ("Video files", "*.mp4 *.mov *.avi *.mkv *.webm"),
                ("All files", "*.*"),
            ],
        )
        if not path:
            return
        self.video_path = path
        self.lbl_video.config(text=os.path.basename(path), fg=ACCENT)

        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        tot = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        dur = tot / fps
        cap.release()

        self.video_info = {"fps": fps, "total": tot, "w": w, "h": h, "dur": dur}
        self._info_labels["Resolution"].config(text=f"{w}x{h}")
        self._info_labels["Source FPS"].config(text=f"{fps:.2f}")
        self._info_labels["Duration"].config(text=fmt_time(dur))
        self._info_labels["Total Frames"].config(text=f"{tot:,}")

        for name, val, desc, color in PRESETS:
            if val == "custom":
                continue
            if val == "scene":
                badge_text = f"(scene detect | ~{int(dur * 0.5)}-{int(dur * 2)} frames)"
                self.rec_btns[name]["badge"].config(text=badge_text, fg=color)
            else:
                efps = get_preset_fps(name, fps, dur, self.custom_fps_v.get())
                est = int(dur * efps)
                badge_text = f"{efps:.2f} fps | ~{est} frames"
                self.rec_btns[name]["badge"].config(text=badge_text, fg=color)

        self._set_status(
            f"Loaded: {os.path.basename(path)}  |  {w}x{h}  |  "
            f"{fps:.2f} fps  |  {fmt_time(dur)}"
        )

    def _on_mode_change(self, name: str, desc: str):
        self.lbl_preset_desc.config(text=desc)
        if name == "Custom FPS":
            self.custom_frame.pack(fill=tk.X, pady=(0, 4))
        else:
            self.custom_frame.pack_forget()

        if name == "Smart Scene":
            self.scene_frame.pack(fill=tk.X, pady=(0, 4))
        else:
            self.scene_frame.pack_forget()

    def _update_scene_label(self):
        v = self.scene_threshold_var.get()
        if v <= 15:
            hint = "very sensitive"
        elif v <= 30:
            hint = "balanced"
        elif v <= 50:
            hint = "hard cuts only"
        else:
            hint = "major changes only"
        self.lbl_scene_val.config(text=f"threshold {v:.0f}  ({hint})")

    def _get_extract_fps(self) -> float:
        info = self.video_info
        return get_preset_fps(
            self.fps_mode.get(),
            info.get("fps", 30.0),
            info.get("dur", 0.0),
            self.custom_fps_v.get(),
        )

    def _decode_full(self, frame: dict) -> Image.Image:
        """Decompress a full-resolution frame from stored JPEG bytes."""
        return Image.open(io.BytesIO(frame["full_bytes"])).copy()

    # ── Extraction ────────────────────────────────────────────────────────────

    def _start_extraction(self):
        if not self.video_path:
            messagebox.showwarning("No Video", "Upload a video first.")
            return
        if self._busy:
            return

        fps = self._get_extract_fps()

        # Estimate frame count and warn for large extractions
        if fps > 0:
            est = int(self.video_info.get("dur", 0) * fps)
            if est > MAX_FRAMES:
                messagebox.showwarning(
                    "Too Many Frames",
                    f"Estimated ~{est:,} frames (max {MAX_FRAMES:,}).\n"
                    f"Choose a lower rate or shorter video.",
                )
                return
            if est > WARN_FRAMES:
                if not messagebox.askyesno(
                    "Large Extraction",
                    f"Estimated ~{est:,} frames will be extracted.\n"
                    "This may take a while. Continue?",
                ):
                    return

        self.frames = []
        self.selected = set()
        self.photo_cache = {}

        # Cancel any pending gallery render
        self._cancel_pending_render()
        self._show_placeholder()

        self._busy = True
        self.progress_var.set(0)
        self.lbl_progress.config(text="")

        if fps == -1.0:
            mode_str = f"Smart Scene  (threshold {self.scene_threshold_var.get():.0f})"
        else:
            mode_str = f"{fps:.2f} fps"
        self._set_status(
            f"Extracting — {mode_str}  |  sharpness x{self.sharpness_var.get():.1f} ..."
        )

        self._stop_event = threading.Event()
        t = threading.Thread(
            target=extract_frames_thread,
            args=(
                self.video_path,
                fps,
                self._extract_q,
                self.sharpness_var.get(),
                self.scene_threshold_var.get(),
                self._stop_event,
                MAX_FRAMES,
            ),
            daemon=True,
        )
        t.start()
        self.after(100, self._poll_extraction)

    def _poll_extraction(self):
        try:
            while True:
                msg = self._extract_q.get_nowait()
                if msg[0] == "progress":
                    _, fn, total, extracted = msg
                    pct = (fn / max(total, 1)) * 100
                    self.progress_var.set(min(pct, 100))
                    self.lbl_progress.config(
                        text=f"{fn}/{total} source frames | {extracted} extracted"
                    )
                elif msg[0] == "done":
                    self.frames = msg[1]
                    capped = msg[2] if len(msg) > 2 else False
                    self._busy = False
                    self.progress_var.set(100)
                    cap_note = f" (capped at {MAX_FRAMES})" if capped else ""
                    self.lbl_progress.config(
                        text=f"Done — {len(self.frames)} frames extracted{cap_note}"
                    )
                    self._render_gallery()
                    self._update_stat()
                    self._set_status(
                        f"Done — {len(self.frames)} frames extracted{cap_note}"
                    )
                    return
                elif msg[0] == "error":
                    self._busy = False
                    self._set_status(f"Error: {msg[1]}")
                    messagebox.showerror("Extraction Error", msg[1])
                    return
        except queue.Empty:
            pass
        if self._busy:
            self.after(100, self._poll_extraction)

    # ── Gallery Rendering ─────────────────────────────────────────────────────

    def _cancel_pending_render(self):
        if self._render_after_id:
            self.after_cancel(self._render_after_id)
            self._render_after_id = None

    def _render_gallery(self):
        self._cancel_pending_render()

        for w in self.gallery_inner.winfo_children():
            w.destroy()
        self.photo_cache = {}

        if not self.frames:
            self._show_placeholder()
            return

        cols = self.cols_var.get()
        cw = self.canvas.winfo_width() or 900
        tw, th = compute_thumb_size(cw, cols, self.GAP, self.PADDING)

        # Configure grid columns for uniform sizing
        for c in range(cols):
            self.gallery_inner.columnconfigure(c, minsize=tw + self.GAP, weight=0)

        # Render in batches to keep UI responsive
        def _batch(start):
            if start >= len(self.frames):
                self.gallery_inner.update_idletasks()
                self._update_sel_label()
                self._update_stat()
                self._render_after_id = None
                return

            end = min(start + RENDER_BATCH, len(self.frames))
            for i in range(start, end):
                frame = self.frames[i]
                r, c = divmod(i, cols)
                self._make_card(frame, r, c, tw, th)

            self.gallery_inner.update_idletasks()
            self._render_after_id = self.after(5, _batch, end)

        _batch(0)

    def _make_card(self, frame, row, col, tw, th):
        idx = frame["idx"]

        card = tk.Frame(
            self.gallery_inner,
            bg=CARD,
            bd=0,
            highlightbackground=BORDER,
            highlightthickness=1,
            cursor="hand2",
        )
        card.grid(
            row=row, column=col, padx=self.GAP // 2, pady=self.GAP // 2, sticky="nw"
        )

        # Resize base thumbnail to exact target size (allows both up & down scaling)
        thumb = frame["thumb"].resize((tw, th), Image.LANCZOS)
        tk_img = ImageTk.PhotoImage(thumb)
        self.photo_cache[idx] = tk_img

        lbl_img = tk.Label(card, image=tk_img, bg=CARD, cursor="hand2")
        lbl_img.pack()

        bar = tk.Frame(card, bg=SURFACE)
        bar.pack(fill=tk.X)

        var = tk.BooleanVar(value=(idx in self.selected))
        frame["_var"] = var
        frame["_card"] = card

        def _toggle(i=idx, v=var, c=card):
            if v.get():
                self.selected.add(i)
            else:
                self.selected.discard(i)
            self._highlight_card(c, v.get())
            self._update_sel_label()

        chk = tk.Checkbutton(
            bar,
            variable=var,
            command=_toggle,
            bg=SURFACE,
            activebackground=SURFACE,
            selectcolor=SURFACE,
            fg=ACCENT,
            highlightthickness=0,
            bd=0,
        )
        chk.pack(side=tk.LEFT, padx=2)

        ts_str = fmt_time(frame["ts"])
        tk.Label(
            bar, text=f"#{idx:04d} {ts_str}", bg=SURFACE, fg=MUTED, font=FONT_MONO_SM
        ).pack(side=tk.LEFT)

        tk.Button(
            bar,
            text="View",
            bg=SURFACE,
            fg=TEXT,
            font=("Segoe UI", 8),
            relief="flat",
            bd=0,
            cursor="hand2",
            padx=3,
            command=lambda i=idx: self._open_preview(i),
        ).pack(side=tk.RIGHT, padx=2)

        lbl_img.bind(
            "<Button-1>",
            lambda e, i=idx, v=var, c=card: (
                v.set(not v.get()),
                self.selected.add(i) if v.get() else self.selected.discard(i),
                self._highlight_card(c, v.get()),
                self._update_sel_label(),
            ),
        )
        lbl_img.bind("<Double-Button-1>", lambda e, i=idx: self._open_preview(i))

        self._highlight_card(card, idx in self.selected)

    def _highlight_card(self, card, selected: bool):
        card.config(
            highlightbackground=ACCENT if selected else BORDER,
            highlightthickness=2 if selected else 1,
        )

    def _relayout(self):
        if self.frames:
            self._cancel_pending_render()
            self._render_gallery()

    # ── Full-screen Preview Window ────────────────────────────────────────────

    def _open_preview(self, idx: int):
        frame = next((f for f in self.frames if f["idx"] == idx), None)
        if not frame:
            return

        if self._preview_win and self._preview_win.winfo_exists():
            self._preview_win.destroy()

        win = tk.Toplevel(self, bg=BG)
        win.title(f"Preview  |  Frame #{idx}  |  {fmt_time(frame['ts'])}")
        win.geometry("1100x720")
        win.minsize(600, 400)
        self._preview_win = win
        self._preview_frame = frame

        img_frame = tk.Frame(win, bg=BG)
        img_frame.pack(fill=tk.BOTH, expand=True, padx=0, pady=0)

        self._prev_lbl = tk.Label(img_frame, bg=BG)
        self._prev_lbl.pack(fill=tk.BOTH, expand=True)

        ctrl = tk.Frame(win, bg=SURFACE, height=48)
        ctrl.pack(fill=tk.X, side=tk.BOTTOM)
        ctrl.pack_propagate(False)

        self._btn(ctrl, "< Prev", lambda: self._prev_nav(-1), BORDER, TEXT, True).pack(
            side=tk.LEFT, padx=6, pady=8
        )
        self._btn(ctrl, "Next >", lambda: self._prev_nav(+1), BORDER, TEXT, True).pack(
            side=tk.LEFT, padx=0, pady=8
        )

        self._prev_info = tk.Label(
            ctrl, text="", bg=SURFACE, fg=MUTED, font=FONT_MONO_SM
        )
        self._prev_info.pack(side=tk.LEFT, padx=12)

        tk.Label(ctrl, text="Sharpen:", bg=SURFACE, fg=MUTED, font=FONT_MONO_SM).pack(
            side=tk.LEFT, padx=(12, 2)
        )
        self._prev_sharp = tk.DoubleVar(value=1.0)
        sh_sl = tk.Scale(
            ctrl,
            from_=0.5,
            to=3.0,
            resolution=0.1,
            orient=tk.HORIZONTAL,
            variable=self._prev_sharp,
            bg=SURFACE,
            fg=TEXT,
            troughcolor=BORDER,
            activebackground=ACCENT2,
            highlightthickness=0,
            length=100,
            sliderlength=12,
            showvalue=False,
            command=lambda _: self._prev_refresh(),
        )
        sh_sl.pack(side=tk.LEFT)

        def _dl():
            p = filedialog.asksaveasfilename(
                defaultextension=".jpg",
                initialfile=f"frame_{idx:04d}.jpg",
                filetypes=[("JPEG", "*.jpg")],
            )
            if p:
                full_img = self._decode_full(self._preview_frame)
                sv = self._prev_sharp.get()
                if sv != 1.0:
                    full_img = ImageEnhance.Sharpness(full_img).enhance(sv)
                full_img.save(p, "JPEG", quality=self.jpeg_quality.get())
                self._set_status(f"Saved: {os.path.basename(p)}")

        self._btn(ctrl, "Download JPEG", _dl, ACCENT, BTN_FG, True).pack(
            side=tk.RIGHT, padx=6, pady=8
        )
        self._btn(ctrl, "Close", win.destroy, DANGER, WHITE, True).pack(
            side=tk.RIGHT, padx=0, pady=8
        )

        win.bind("<Configure>", lambda e: self._prev_refresh())
        win.bind("<Left>", lambda e: self._prev_nav(-1))
        win.bind("<Right>", lambda e: self._prev_nav(+1))
        win.focus_set()

        self._prev_refresh()

    def _prev_refresh(self):
        win = self._preview_win
        if not win or not win.winfo_exists():
            return
        frame = self._preview_frame
        if not frame:
            return

        aw = max(win.winfo_width() - 4, 200)
        ah = max(win.winfo_height() - 52, 200)

        img = self._decode_full(frame)
        sv = self._prev_sharp.get()
        if sv != 1.0:
            img = ImageEnhance.Sharpness(img).enhance(sv)
        img.thumbnail((aw, ah), Image.LANCZOS)

        tk_img = ImageTk.PhotoImage(img)
        self._prev_lbl.config(image=tk_img)
        self._prev_lbl.image = tk_img

        fw, fh = frame["full_size"]
        self._prev_info.config(
            text=f"#{frame['idx']:04d}   {fmt_time(frame['ts'])}   "
            f"{fw}x{fh} px   ->   {img.width}x{img.height} preview"
        )

    def _prev_nav(self, delta: int):
        if not self._preview_frame:
            return
        cur = self._preview_frame["idx"]
        new = cur + delta
        if 0 <= new < len(self.frames):
            self._preview_frame = self.frames[new]
            self._preview_win.title(
                f"Preview  |  Frame #{new}  |  {fmt_time(self._preview_frame['ts'])}"
            )
            self._prev_refresh()

    # ── Selection ops ─────────────────────────────────────────────────────────

    def _select_all(self):
        self.selected = {f["idx"] for f in self.frames}
        self._sync_cards()
        self._update_sel_label()

    def _deselect_all(self):
        self.selected = set()
        self._sync_cards()
        self._update_sel_label()

    def _sync_cards(self):
        for f in self.frames:
            v, c = f.get("_var"), f.get("_card")
            if v and c:
                v.set(f["idx"] in self.selected)
                self._highlight_card(c, f["idx"] in self.selected)

    def _delete_selected(self):
        if not self.selected:
            messagebox.showinfo("Nothing selected", "Select frames first.")
            return
        n = len(self.selected)
        if not messagebox.askyesno("Delete", f"Remove {n} frame(s) from gallery?"):
            return
        self.frames = [f for f in self.frames if f["idx"] not in self.selected]
        for i, f in enumerate(self.frames):
            f["idx"] = i
        self.selected = set()
        self.photo_cache = {}
        self._render_gallery()
        self._update_stat()
        self._set_status(f"Deleted {n} frame(s).")

    # ── Downloads ─────────────────────────────────────────────────────────────

    def _build_zip(self, indices=None) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in self.frames:
                if indices is None or f["idx"] in indices:
                    ts = f"{f['ts']:.3f}".replace(".", "_")
                    nm = f"frame_{f['idx']:04d}_t{ts}s.jpg"
                    zf.writestr(nm, f["full_bytes"])
        return buf.getvalue()

    def _download_all_zip(self):
        if not self.frames:
            messagebox.showinfo("Empty", "No frames to download.")
            return
        p = filedialog.asksaveasfilename(
            defaultextension=".zip",
            initialfile="frames_all.zip",
            filetypes=[("ZIP", "*.zip")],
        )
        if p:
            self._set_status("Building ZIP...")
            self.update_idletasks()
            data = self._build_zip()
            with open(p, "wb") as fh:
                fh.write(data)
            self._set_status(f"Saved {len(self.frames)} frames -> {os.path.basename(p)}")

    def _download_sel_zip(self):
        if not self.selected:
            messagebox.showinfo("Nothing selected", "Select frames first.")
            return
        p = filedialog.asksaveasfilename(
            defaultextension=".zip",
            initialfile="frames_selected.zip",
            filetypes=[("ZIP", "*.zip")],
        )
        if p:
            self._set_status("Building ZIP...")
            self.update_idletasks()
            data = self._build_zip(self.selected)
            with open(p, "wb") as fh:
                fh.write(data)
            self._set_status(
                f"Saved {len(self.selected)} selected -> {os.path.basename(p)}"
            )

    # ── Canvas helpers ────────────────────────────────────────────────────────

    def _on_gallery_cfg(self, _):
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    def _on_canvas_resize(self, event):
        self.canvas.itemconfig(self._win_id, width=event.width)
        if self.frames:
            self._cancel_pending_render()
            self._render_after_id = self.after(250, self._render_gallery)

    def _on_scroll(self, event):
        if event.num == 4:
            self.canvas.yview_scroll(-2, "units")
        elif event.num == 5:
            self.canvas.yview_scroll(2, "units")
        else:
            self.canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

    # ── Labels ────────────────────────────────────────────────────────────────

    def _update_sel_label(self):
        n = len(self.selected)
        self.lbl_sel_count.config(text=f"{n} selected")

    def _update_stat(self):
        n = len(self.frames)
        c = self.cols_var.get()
        self.lbl_stat.config(text=f"{n} frames  |  {c} cols")

    def _set_status(self, msg: str):
        self.lbl_status.config(text=msg)


# ─── Entry point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    app = FrameForgeApp()
    app.mainloop()
