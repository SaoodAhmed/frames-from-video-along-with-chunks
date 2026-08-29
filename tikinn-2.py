"""
PixelForge · Image & Video Converter — Tkinter Edition
Beautiful dark UI · Batch convert · compress · reorder · ZIP
Image + Video Optimizer · FFmpeg · Folder upload · AVIF
"""

import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import tkinter as tk
import zipfile
from tkinter import filedialog, messagebox, simpledialog, ttk

from PIL import Image, ImageTk

# ═══════════════════════════════════════════════════════════════════
#  THEME
# ═══════════════════════════════════════════════════════════════════
BG = "#0a0b10"
BG2 = "#0f1018"
PANEL = "#13141c"
CARD = "#1a1b26"
CARD_HOV = "#20212e"
BORDER = "#252636"
BORDER_HOV = "#3a3b52"
ACCENT = "#a8ff3e"
ACCENT_DIM = "#6aac1a"
ACCENT2 = "#ff6b6b"
BLUE = "#4fc3f7"
MUTED = "#555670"
MUTED2 = "#2e2f40"
TEXT = "#e2e4f0"
TEXT2 = "#9899b0"

FONT_HERO = ("Segoe UI", 22, "bold")
FONT_LABEL = ("Segoe UI", 8, "bold")
FONT_BODY = ("Segoe UI", 10)
FONT_BODY_B = ("Segoe UI", 10, "bold")
FONT_SMALL = ("Segoe UI", 8)
FONT_TINY = ("Segoe UI", 7)
FONT_BTN = ("Segoe UI", 10, "bold")
FONT_STAT = ("Segoe UI", 20, "bold")

THUMB_SIZE = 110
ROW_THUMB = 48

# ═══════════════════════════════════════════════════════════════════
#  DATA
# ═══════════════════════════════════════════════════════════════════
FORMATS = {
    "JPEG (.jpg)": ("JPEG", "jpg"),
    "WebP (.webp)": ("WEBP", "webp"),
    "AVIF (.avif)": ("AVIF", "avif"),
    "PNG (.png)": ("PNG", "png"),
    "BMP (.bmp)": ("BMP", "bmp"),
    "TIFF (.tiff)": ("TIFF", "tiff"),
    "GIF (.gif)": ("GIF", "gif"),
    "ICO (.ico)": ("ICO", "ico"),
}
QUALITY_PRESETS = {
    "Maximum — 95": 95,
    "High — 85 (default)": 85,
    "Balanced — 75": 75,
    "Web — 65": 65,
    "Compressed — 50": 50,
    "Custom...": None,
}
MAX_DIM_OPTIONS = {
    "Keep original": None,
    "4K  (3840 px)": 3840,
    "2K  (2560 px)": 2560,
    "Full HD (1920 px)": 1920,
    "HD  (1280 px)": 1280,
    "Web  (1024 px)": 1024,
    "Thumb (512 px)": 512,
}

# ── Video ──────────────────────────────────────────────────────────
VIDEO_EXTENSIONS = (
    # Common containers
    ".mp4", ".m4v", ".mov", ".qt", ".mkv", ".avi", ".wmv", ".asf", ".flv", ".f4v",
    ".webm", ".mpeg", ".mpg", ".mpe", ".mpv", ".m2v", ".vob", ".ts", ".mts", ".m2ts",
    ".mxf", ".3gp", ".3g2", ".ogv", ".ogm", ".ogx", ".rm", ".rmvb", ".divx", ".dat",
    ".dv", ".mod", ".tod", ".m2t", ".wtv", ".dvr-ms", ".mp2", ".m1v", ".nsv", ".nut",
    ".gxf", ".swf", ".amv", ".bik", ".smk", ".str", ".roq", ".y4m", ".hevc", ".h265",
    ".265", ".h264", ".264", ".avc", ".prores", ".dnxhd", ".r3d", ".braw", ".insv",
    ".lrv", ".360", ".f4p", ".f4a", ".f4b",
)
IMAGE_EXTENSIONS = (
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif",
    ".tiff", ".tif", ".ico", ".ppm", ".avif",
)
# Skip ffprobe/Pillow on obvious non-media during folder scans
NON_MEDIA_EXTENSIONS = (
    ".txt", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".rtf",
    ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".exe", ".dll", ".msi",
    ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".htm", ".css", ".scss", ".json",
    ".xml", ".yaml", ".yml", ".md", ".csv", ".log", ".ini", ".cfg", ".conf",
    ".db", ".sqlite", ".sqlite3", ".psd", ".ai", ".eps", ".svg", ".woff", ".woff2",
    ".ttf", ".otf", ".eot", ".mp3", ".wav", ".flac", ".aac", ".ogg", ".opus", ".m4a",
    ".wma", ".aiff", ".aif", ".cue", ".srt", ".ass", ".vtt", ".sub", ".idx",
    ".nfo", ".torrent", ".iso", ".img", ".bin", ".cue", ".apk", ".deb", ".rpm",
)
VIDEO_CODECS = {
    "H.264": "libx264",
    "AV1": "libsvtav1",
}
VIDEO_CONTAINERS = {
    "MP4 (.mp4)": "mp4",
    "MKV (.mkv)": "mkv",
    "WEBM (.webm)": "webm",
}
VIDEO_QUALITY_PRESETS = {
    "Maximum — CRF 18": 18,
    "High — CRF 23": 23,
    "Balanced — CRF 28": 28,
    "Web — CRF 32": 32,
    "Compressed — CRF 38": 38,
    "Custom...": None,
}
VIDEO_RES_OPTIONS = {
    "Keep Original": None,
    "4K  (3840 px)": 3840,
    "2K  (2560 px)": 2560,
    "1080p (1920 px)": 1920,
    "720p  (1280 px)": 1280,
    "480p  (854 px)": 854,
}
CONTAINER_CODEC_HINTS = {
    "mp4": "H.264",
    "webm": "AV1",
    "mkv": None,
}


# ═══════════════════════════════════════════════════════════════════
#  HELPERS
# ═══════════════════════════════════════════════════════════════════
def human_size(b):
    if b < 1024:
        return f"{b} B"
    if b < 1048576:
        return f"{b / 1024:.1f} KB"
    return f"{b / 1048576:.2f} MB"


def smart_resize(img, max_dim):
    if max_dim is None:
        return img
    w, h = img.size
    if w <= max_dim and h <= max_dim:
        return img
    r = max_dim / max(w, h)
    return img.resize((int(w * r), int(h * r)), Image.LANCZOS)


def convert_image(pil_img, target_fmt, quality, max_dim):
    img = smart_resize(pil_img.copy(), max_dim)
    if target_fmt == "JPEG":
        if img.mode == "RGBA":
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[-1])
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")
    elif target_fmt == "GIF":
        img = img.convert("P", palette=Image.ADAPTIVE)
    elif target_fmt == "ICO":
        img = img.convert("RGBA")
        img = img.resize((min(img.width, 256), min(img.height, 256)), Image.LANCZOS)
    elif target_fmt in ("PNG", "WEBP", "AVIF"):
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")
    else:
        if img.mode != "RGB":
            img = img.convert("RGB")
    buf = io.BytesIO()
    kw = {}
    if target_fmt == "JPEG":
        kw = dict(quality=quality, optimize=True, progressive=True)
    elif target_fmt == "WEBP":
        kw = dict(quality=quality, method=6, lossless=False)
    elif target_fmt == "AVIF":
        kw = dict(quality=quality, speed=7)
    elif target_fmt == "PNG":
        kw = dict(
            optimize=True, compress_level=max(1, min(9, int((100 - quality) / 11)))
        )
    elif target_fmt == "TIFF":
        kw = dict(compression="tiff_lzw")
    img.save(buf, format=target_fmt, **kw)
    return buf.getvalue()


def make_thumbnail(pil_img, size):
    t = pil_img.copy()
    t.thumbnail((size, size), Image.LANCZOS)
    if t.mode == "RGBA":
        bg = Image.new("RGB", t.size, (26, 27, 38))
        bg.paste(t, mask=t.split()[-1])
        t = bg
    elif t.mode != "RGB":
        t = t.convert("RGB")
    return t


def make_zip(zip_entries):
    """Write zip entries in the exact sequence provided."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in zip_entries:
            zf.writestr(name, data)
    return buf.getvalue()


def get_filename_without_ext(filename):
    """Extract filename without extension."""
    return os.path.splitext(filename)[0]


def _video_dialog_glob():
    """File-dialog glob for known video extensions."""
    return " ".join(f"*{ext}" for ext in VIDEO_EXTENSIONS)


def find_ffmpeg():
    return shutil.which("ffmpeg")


def find_ffprobe():
    return shutil.which("ffprobe")


def probe_has_video_stream(path, cache=None):
    """True if ffprobe finds at least one video stream (any container/codec)."""
    path = os.path.normcase(os.path.abspath(path))
    if cache is not None and path in cache:
        return cache[path]
    ffprobe = find_ffprobe()
    if not ffprobe:
        result = False
    else:
        try:
            cmd = [
                ffprobe, "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=codec_type", "-of", "csv=p=0", path,
            ]
            out = subprocess.check_output(
                cmd, stderr=subprocess.DEVNULL, text=True, timeout=30,
            ).strip()
            result = out == "video"
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
            result = False
    if cache is not None:
        cache[path] = result
    return result


def probe_is_image_file(path):
    """True if Pillow can open the file as a raster image."""
    try:
        with Image.open(path) as img:
            img.verify()
        return True
    except Exception:
        return False


def classify_media(path, probe_cache=None):
    """Return 'image', 'video', or None for a file path."""
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in NON_MEDIA_EXTENSIONS:
        return None
    if not os.path.isfile(path):
        return None

    # Unknown extension — ffprobe detects any FFmpeg-readable video
    if probe_has_video_stream(path, probe_cache):
        return "video"
    if probe_is_image_file(path):
        return "image"
    return None


def scan_media_folder(folder):
    """Recursively collect image and video paths from a folder."""
    images, videos = [], []
    probe_cache = {}
    try:
        for root, dirs, files in os.walk(folder):
            for file in sorted(files):
                full = os.path.join(root, file)
                kind = classify_media(full, probe_cache)
                if kind == "image":
                    images.append(full)
                elif kind == "video":
                    videos.append(full)
    except Exception as ex:
        print(f"Error reading folder: {ex}")
    return images, videos


def scan_media_paths(paths):
    """Split explicit file paths into images and videos."""
    images, videos = [], []
    probe_cache = {}
    for path in paths:
        kind = classify_media(path, probe_cache)
        if kind == "image":
            images.append(path)
        elif kind == "video":
            videos.append(path)
    return images, videos


def build_source_items(image_paths, video_paths):
    """Ordered source list: images first, then videos."""
    items = []
    for p in image_paths:
        items.append({"path": p, "type": "image"})
    for p in video_paths:
        items.append({"path": p, "type": "video"})
    return items


def human_duration(seconds):
    if seconds is None or seconds <= 0:
        return "0s"
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def get_video_info(path):
    """Return duration, width, height, size via ffprobe."""
    ffprobe = find_ffprobe()
    if not ffprobe:
        raise RuntimeError("ffprobe not found — install FFmpeg and add to PATH")
    cmd = [
        ffprobe, "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ]
    out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
    data = json.loads(out)
    duration = float(data.get("format", {}).get("duration", 0) or 0)
    width = height = 0
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            width = int(stream.get("width", 0) or 0)
            height = int(stream.get("height", 0) or 0)
            break
    return {
        "duration": duration,
        "width": width,
        "height": height,
        "resolution": f"{width}x{height}" if width and height else "—",
        "size": os.path.getsize(path),
    }


def generate_video_thumbnail(path, size=THUMB_SIZE):
    """Extract a frame and return PIL thumbnail (works for any FFmpeg input)."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found")
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        thumb_path = tmp.name
    try:
        for seek in ("00:00:01", "00:00:00"):
            cmd = [
                ffmpeg, "-y", "-ss", seek, "-i", path,
                "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", thumb_path,
            ]
            result = subprocess.run(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            if result.returncode == 0 and os.path.getsize(thumb_path) > 0:
                break
        else:
            raise RuntimeError("Could not extract video thumbnail")
        pil = Image.open(thumb_path)
        return make_thumbnail(pil, size)
    finally:
        if os.path.exists(thumb_path):
            os.remove(thumb_path)


def video_scale_filter(max_dim):
    if max_dim is None:
        return None
    return f"scale='min({max_dim},iw)':-2"


def convert_video(input_path, output_path, codec_key, container_ext, crf, max_dim,
                  progress_cb=None):
    """Convert/optimize a video with FFmpeg. Returns output file size."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found — install FFmpeg and add to PATH")

    encoder = VIDEO_CODECS[codec_key]
    cmd = [
        ffmpeg, "-y", "-i", input_path,
        "-map", "0:v:0", "-c:v", encoder, "-crf", str(crf),
        "-map", "0:a:0?",
    ]

    if encoder == "libx264":
        cmd += ["-preset", "medium", "-c:a", "aac", "-b:a", "128k"]
    else:
        cmd += ["-preset", "6", "-c:a", "libopus", "-b:a", "96k"]

    vf = video_scale_filter(max_dim)
    if vf:
        cmd += ["-vf", vf]

    if container_ext == "webm" and encoder == "libx264":
        cmd[cmd.index("-c:v") + 1] = "libsvtav1"
    if container_ext == "mp4":
        cmd += ["-movflags", "+faststart"]

    cmd.append(output_path)

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    duration = get_video_info(input_path)["duration"]
    time_re = re.compile(r"time=(\d+):(\d+):(\d+\.\d+)")
    stderr_lines = []
    for line in proc.stderr:
        stderr_lines.append(line)
        if progress_cb and duration > 0:
            m = time_re.search(line)
            if m:
                h, mi, sec = m.groups()
                cur = int(h) * 3600 + int(mi) * 60 + float(sec)
                progress_cb(min(99, cur / duration * 100))
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg failed:\n{''.join(stderr_lines)[-500:]}")

    if progress_cb:
        progress_cb(100)
    return os.path.getsize(output_path)


def video_stats(items):
    """Aggregate statistics for converted videos."""
    tot_orig = sum(c["orig_size"] for c in items)
    tot_new = sum(c["new_size"] for c in items)
    tot_dur = sum(c.get("duration", 0) for c in items)
    saved = tot_orig - tot_new
    pct = round((1 - tot_new / tot_orig) * 100, 1) if tot_orig else 0
    codec = items[0].get("codec", "—") if items else "—"
    return {
        "count": len(items),
        "duration": tot_dur,
        "orig_size": tot_orig,
        "new_size": tot_new,
        "saved_pct": pct,
        "saved_bytes": saved,
        "codec": codec,
    }


def make_zip_from_paths(zip_entries):
    """Write zip from (name, filepath) tuples preserving order."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, fpath in zip_entries:
            with open(fpath, "rb") as f:
                zf.writestr(name, f.read())
    return buf.getvalue()


def make_zip_mixed(entries):
    """Write zip from (name, payload, kind) where kind is 'bytes' or 'path'."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, payload, kind in entries:
            if kind == "path":
                with open(payload, "rb") as f:
                    zf.writestr(name, f.read())
            else:
                zf.writestr(name, payload)
    return buf.getvalue()


def video_zip_export(items, use_custom_order, ext):
    """Build ordered zip entry list for videos."""
    width = max(2, len(str(len(items))))
    entries = []
    for pos, item in enumerate(items):
        name = item["display_name"] if use_custom_order else item["original_name"]
        zip_name = f"{pos + 1:0{width}d}_{name}"
        entries.append((zip_name, item["output_path"]))
    return entries


# ═══════════════════════════════════════════════════════════════════
#  CUSTOM WIDGETS
# ═══════════════════════════════════════════════════════════════════


class HoverButton(tk.Label):
    """Flat clickable label that acts as a button."""

    def __init__(
        self,
        parent,
        text="",
        command=None,
        bg=CARD,
        fg=TEXT,
        hover_bg=CARD_HOV,
        active_bg=BORDER_HOV,
        font=FONT_BTN,
        padx=18,
        pady=8,
        **kw,
    ):
        super().__init__(
            parent,
            text=text,
            font=font,
            bg=bg,
            fg=fg,
            padx=padx,
            pady=pady,
            cursor="hand2",
            **kw,
        )
        self._bg = bg
        self._hover = hover_bg
        self._active = active_bg
        self._cmd = command
        self._enabled = True
        self.bind("<Enter>", self._on_enter)
        self.bind("<Leave>", self._on_leave)
        self.bind("<ButtonPress-1>", self._on_press)
        self.bind("<ButtonRelease-1>", self._on_release)

    def _on_enter(self, e):
        if self._enabled:
            self.config(bg=self._hover)

    def _on_leave(self, e):
        self.config(bg=self._bg if self._enabled else MUTED2)

    def _on_press(self, e):
        if self._enabled:
            self.config(bg=self._active)

    def _on_release(self, e):
        if not self._enabled:
            return
        self.config(bg=self._hover)
        if self._cmd:
            self._cmd()

    def set_enabled(self, yes):
        self._enabled = yes
        if yes:
            self.config(bg=self._bg, fg=TEXT, cursor="hand2")
        else:
            self.config(bg=MUTED2, fg=MUTED, cursor="arrow")


class AccentButton(HoverButton):
    def __init__(self, parent, text="", command=None, **kw):
        kw.setdefault("pady", 10)
        super().__init__(
            parent,
            text=text,
            command=command,
            bg=ACCENT,
            fg="#0a0b10",
            hover_bg="#bfff4a",
            active_bg="#8fdf1e",
            font=FONT_BTN,
            **kw,
        )

    def set_enabled(self, yes):
        self._enabled = yes
        if yes:
            self._bg = ACCENT
            self._hover = "#bfff4a"
            self._active = "#8fdf1e"
            self.config(bg=ACCENT, fg="#0a0b10", cursor="hand2")
        else:
            self._bg = MUTED2
            self._hover = MUTED2
            self._active = MUTED2
            self.config(bg=MUTED2, fg=MUTED, cursor="arrow")


class GhostButton(HoverButton):
    def __init__(self, parent, text="", command=None, **kw):
        kw.setdefault("pady", 6)
        super().__init__(
            parent,
            text=text,
            command=command,
            bg=PANEL,
            fg=TEXT2,
            hover_bg=CARD,
            active_bg=BORDER,
            font=FONT_BODY,
            **kw,
        )


# ═══════════════════════════════════════════════════════════════════
#  MAIN APP
# ═══════════════════════════════════════════════════════════════════


class PixelForge(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("PixelForge  ·  Image & Video Converter")
        self.geometry("1200x820")
        self.minsize(900, 640)
        self.configure(bg=BG)

        self._video_temp_dir = tempfile.mkdtemp(prefix="pixelforge_vid_")

        # App state
        self.source_items = []  # [{"path", "type": "image"|"video"}]
        self.converted = []
        self.image_order = []
        self.video_order = []
        self.original_image_order = []
        self.original_video_order = []
        self._photo_refs = []
        self._vg_photo_refs = []
        self._list_photos = []
        self._drag_src = None
        self._vid_drag_src = None
        self._list_src = None
        self._list_order_kind = None
        self._drag_ghost = None
        self._vid_drag_ghost = None
        self._list_ghost = None

        self._apply_styles()
        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ─── ttk styles ────────────────────────────────────────────────
    def _apply_styles(self):
        s = ttk.Style(self)
        s.theme_use("clam")

        s.configure("PF.TNotebook", background=BG, borderwidth=0)
        s.configure(
            "PF.TNotebook.Tab",
            background=BG2,
            foreground=TEXT2,
            font=FONT_BODY,
            padding=[22, 10],
            borderwidth=0,
        )
        s.map(
            "PF.TNotebook.Tab",
            background=[("selected", CARD)],
            foreground=[("selected", ACCENT)],
        )

        s.configure(
            "PF.TCombobox",
            fieldbackground=CARD,
            background=CARD,
            foreground=TEXT,
            selectforeground=TEXT,
            selectbackground=CARD,
            bordercolor=BORDER,
            arrowcolor=TEXT2,
            relief="flat",
            padding=6,
        )
        s.map(
            "PF.TCombobox",
            fieldbackground=[("readonly", CARD)],
            foreground=[("readonly", TEXT)],
            bordercolor=[("focus", ACCENT_DIM)],
        )

        s.configure(
            "PF.Horizontal.TScale",
            background=PANEL,
            troughcolor=CARD,
            sliderlength=16,
            sliderrelief="flat",
        )

        s.configure(
            "PF.Horizontal.TProgressbar",
            troughcolor=MUTED2,
            background=ACCENT,
            bordercolor=PANEL,
            lightcolor=ACCENT,
            darkcolor=ACCENT,
            thickness=5,
        )

        s.configure(
            "PF.Vertical.TScrollbar",
            background=MUTED2,
            troughcolor=BG,
            bordercolor=BG,
            arrowcolor=MUTED,
            relief="flat",
            width=7,
        )
        s.map("PF.Vertical.TScrollbar", background=[("active", BORDER_HOV)])

    # ─── Root layout ───────────────────────────────────────────────
    def _build_ui(self):
        self._build_titlebar()
        body = tk.Frame(self, bg=BG)
        body.pack(fill="both", expand=True)
        self._build_sidebar(body)
        tk.Frame(body, bg=BORDER, width=1).pack(side="left", fill="y")
        self._build_main(body)

    # ─── Title bar ─────────────────────────────────────────────────
    def _build_titlebar(self):
        bar = tk.Frame(self, bg=BG2, height=56)
        bar.pack(fill="x")
        bar.pack_propagate(False)

        left = tk.Frame(bar, bg=BG2)
        left.place(relx=0, rely=0.5, anchor="w", x=20)

        # Logo square
        lc = tk.Canvas(left, width=32, height=32, bg=BG2, highlightthickness=0)
        lc.pack(side="left")
        lc.create_rectangle(0, 0, 32, 32, fill=ACCENT, outline="")
        lc.create_text(16, 16, text="PF", fill="#0a0b10", font=("Segoe UI", 10, "bold"))

        tk.Label(
            left, text="  PixelForge", font=("Segoe UI", 15, "bold"), bg=BG2, fg=TEXT
        ).pack(side="left")
        tk.Label(
            left, text="  Image & Video Converter", font=("Segoe UI", 9), bg=BG2, fg=MUTED
        ).pack(side="left")

        right = tk.Frame(bar, bg=BG2)
        right.place(relx=1, rely=0.5, anchor="e", x=-20)
        for badge, color in [
            ("MEDIA", ACCENT), ("BATCH", ACCENT), ("FOLDER", BLUE), ("ZIP", TEXT2),
        ]:
            lbl = tk.Label(
                right,
                text=badge,
                font=("Segoe UI", 7, "bold"),
                bg=CARD,
                fg=color,
                padx=8,
                pady=3,
            )
            lbl.pack(side="left", padx=2)

        tk.Frame(self, bg=BORDER, height=1).pack(fill="x")

    # ─── Sidebar ───────────────────────────────────────────────────
    def _build_zip_footer(self, parent):
        """Pinned at sidebar bottom so Download ZIP is always visible."""
        footer = tk.Frame(parent, bg=PANEL)
        footer.pack(side="bottom", fill="x")

        tk.Frame(footer, bg=ACCENT_DIM, height=2).pack(fill="x")
        tk.Label(footer, text="DOWNLOAD ZIP", font=FONT_LABEL, bg=PANEL, fg=TEXT).pack(
            anchor="w", padx=18, pady=(10, 4)
        )

        self.zip_info_frame = tk.Frame(footer, bg=PANEL)
        self.zip_info_frame.pack(anchor="w", padx=18, pady=(0, 6), fill="x")

        self.zip_status = tk.Label(
            self.zip_info_frame,
            text="Waiting for conversion...",
            font=FONT_SMALL,
            bg=PANEL,
            fg=TEXT2,
        )
        self.zip_status.pack(anchor="w")

        self.zip_size = tk.Label(
            self.zip_info_frame, text="", font=FONT_TINY, bg=PANEL, fg=MUTED
        )
        self.zip_size.pack(anchor="w")

        self.zip_btn = AccentButton(
            footer, "Download ZIP", command=self._save_zip_with_rename, pady=12
        )
        self.zip_btn.pack(fill="x", padx=16, pady=(0, 14))
        self.zip_btn.set_enabled(False)

    def _build_sidebar(self, parent):
        sb = tk.Frame(parent, bg=PANEL, width=256)
        sb.pack(side="left", fill="y")
        sb.pack_propagate(False)

        self._build_zip_footer(sb)

        scroll_wrap = tk.Frame(sb, bg=PANEL)
        scroll_wrap.pack(side="top", fill="both", expand=True)

        sb_canvas = tk.Canvas(scroll_wrap, bg=PANEL, highlightthickness=0, width=248)
        sb_vsb = ttk.Scrollbar(
            scroll_wrap,
            orient="vertical",
            command=sb_canvas.yview,
            style="PF.Vertical.TScrollbar",
        )
        sb_canvas.configure(yscrollcommand=sb_vsb.set)
        sb_vsb.pack(side="right", fill="y")
        sb_canvas.pack(side="left", fill="both", expand=True)

        inner = tk.Frame(sb_canvas, bg=PANEL)
        self._sb_win = sb_canvas.create_window((0, 0), window=inner, anchor="nw")
        inner.bind(
            "<Configure>",
            lambda e: sb_canvas.configure(scrollregion=sb_canvas.bbox("all")),
        )
        sb_canvas.bind(
            "<Configure>",
            lambda e: sb_canvas.itemconfig(self._sb_win, width=e.width),
        )

        def _sb_wheel(e):
            sb_canvas.yview_scroll(int(-1 * (e.delta / 120)), "units")

        sb_canvas.bind("<Enter>", lambda e: sb_canvas.bind_all("<MouseWheel>", _sb_wheel))
        sb_canvas.bind("<Leave>", lambda e: sb_canvas.unbind_all("<MouseWheel>"))

        def section(text, pady_top=16, parent=None):
            p = parent or inner
            tk.Label(p, text=text, font=FONT_LABEL, bg=PANEL, fg=MUTED).pack(
                anchor="w", padx=18, pady=(pady_top, 4)
            )

        def combo(var, values, parent=None):
            p = parent or inner
            cb = ttk.Combobox(
                p,
                textvariable=var,
                values=values,
                state="readonly",
                style="PF.TCombobox",
                font=FONT_BODY,
            )
            cb.pack(fill="x", padx=16, pady=2)
            return cb

        def divider(parent=None):
            p = parent or inner
            tk.Frame(p, bg=BORDER, height=1).pack(fill="x", padx=16, pady=10)

        # ── Source media ──
        section("SOURCE MEDIA")
        self.up_btn = AccentButton(
            inner, "  +  Choose Media", command=self._browse_media, pady=10
        )
        self.up_btn.pack(fill="x", padx=16, pady=(2, 6))
        self.file_lbl = tk.Label(
            inner, text="No media selected", font=FONT_SMALL, bg=PANEL, fg=MUTED
        )
        self.file_lbl.pack(anchor="w", padx=18)

        divider()

        # ── Image settings ──
        section("IMAGE SETTINGS", pady_top=4)
        self.fmt_var = tk.StringVar(value=list(FORMATS.keys())[0])
        combo(self.fmt_var, list(FORMATS.keys()))
        self.fmt_var.trace_add("write", self._on_fmt_change)

        section("IMAGE QUALITY", pady_top=12)
        self.preset_var = tk.StringVar(value=list(QUALITY_PRESETS.keys())[1])
        preset_cb = combo(self.preset_var, list(QUALITY_PRESETS.keys()))
        preset_cb.bind("<<ComboboxSelected>>", self._on_preset)

        sr = tk.Frame(inner, bg=PANEL)
        sr.pack(fill="x", padx=16, pady=(6, 0))
        tk.Label(sr, text="Quality:", font=FONT_SMALL, bg=PANEL, fg=MUTED).pack(side="left")
        self.q_lbl = tk.Label(sr, text="85", font=FONT_BODY_B, bg=PANEL, fg=ACCENT, width=3)
        self.q_lbl.pack(side="right")
        self.q_var = tk.IntVar(value=85)
        self.q_slider = ttk.Scale(
            inner, from_=1, to=100, orient="horizontal",
            variable=self.q_var, style="PF.Horizontal.TScale", command=self._on_slider,
        )
        self.q_slider.set(85)
        self.q_slider.pack(fill="x", padx=16, pady=(2, 0))
        self.q_slider.config(state="disabled")

        self.png_info = tk.Label(
            inner,
            text="  i  PNG is lossless — quality sets\n     compression speed only.",
            font=FONT_TINY, bg=PANEL, fg=BLUE, justify="left",
        )
        self.avif_info = tk.Label(
            inner,
            text="  i  AVIF is modern · best compression\n     for photos & transparency.",
            font=FONT_TINY, bg=PANEL, fg=BLUE, justify="left",
        )

        section("IMAGE MAX SIZE", pady_top=12)
        self.dim_var = tk.StringVar(value=list(MAX_DIM_OPTIONS.keys())[0])
        combo(self.dim_var, list(MAX_DIM_OPTIONS.keys()))

        divider()

        # ── Video settings ──
        section("VIDEO SETTINGS", pady_top=4)
        self.vcodec_var = tk.StringVar(value=list(VIDEO_CODECS.keys())[0])
        combo(self.vcodec_var, list(VIDEO_CODECS.keys()))

        section("OUTPUT CONTAINER", pady_top=12)
        self.vcontainer_var = tk.StringVar(value=list(VIDEO_CONTAINERS.keys())[0])
        vcontainer_cb = combo(self.vcontainer_var, list(VIDEO_CONTAINERS.keys()))
        vcontainer_cb.bind("<<ComboboxSelected>>", self._on_vcontainer)

        section("VIDEO QUALITY (CRF)", pady_top=12)
        self.vpreset_var = tk.StringVar(value=list(VIDEO_QUALITY_PRESETS.keys())[1])
        vpreset_cb = combo(self.vpreset_var, list(VIDEO_QUALITY_PRESETS.keys()))
        vpreset_cb.bind("<<ComboboxSelected>>", self._on_vpreset)

        vsr = tk.Frame(inner, bg=PANEL)
        vsr.pack(fill="x", padx=16, pady=(6, 0))
        tk.Label(vsr, text="CRF:", font=FONT_SMALL, bg=PANEL, fg=MUTED).pack(side="left")
        self.vq_lbl = tk.Label(vsr, text="23", font=FONT_BODY_B, bg=PANEL, fg=ACCENT, width=3)
        self.vq_lbl.pack(side="right")
        self.vq_var = tk.IntVar(value=23)
        self.vq_slider = ttk.Scale(
            inner, from_=18, to=51, orient="horizontal",
            variable=self.vq_var, style="PF.Horizontal.TScale", command=self._on_vslider,
        )
        self.vq_slider.set(23)
        self.vq_slider.pack(fill="x", padx=16, pady=(2, 0))
        self.vq_slider.config(state="disabled")

        section("VIDEO RESOLUTION", pady_top=12)
        self.vres_var = tk.StringVar(value=list(VIDEO_RES_OPTIONS.keys())[0])
        combo(self.vres_var, list(VIDEO_RES_OPTIONS.keys()))

        divider()

        self.conv_btn = AccentButton(
            inner, "  Convert All Media", command=self._start_convert, pady=11
        )
        self.conv_btn.pack(fill="x", padx=16)
        self.conv_btn.set_enabled(False)

        # ── Shared progress + tips ──
        self.prog_var = tk.DoubleVar(value=0)
        self.prog_bar = ttk.Progressbar(
            inner, variable=self.prog_var, maximum=100, style="PF.Horizontal.TProgressbar"
        )
        self.prog_bar.pack(fill="x", padx=16, pady=(8, 2))
        self.prog_lbl = tk.Label(
            inner,
            text="",
            font=FONT_TINY,
            bg=PANEL,
            fg=MUTED,
            wraplength=218,
            justify="left",
        )
        self.prog_lbl.pack(anchor="w", padx=18, pady=(0, 8))

        # ── Tips card ──
        tip_card = tk.Frame(
            inner, bg=CARD, highlightbackground=BORDER, highlightthickness=1
        )
        tip_card.pack(fill="x", padx=16, pady=(0, 16))
        for icon, msg in [
            ("📁", "Folder accepts images & any FFmpeg video"),
            ("🖱", "Drag to reorder"),
            ("💾", "Rename ZIP before download"),
        ]:
            row = tk.Frame(tip_card, bg=CARD)
            row.pack(fill="x", padx=10, pady=5)
            tk.Label(row, text=icon, font=("Segoe UI", 11), bg=CARD, fg=ACCENT).pack(
                side="left"
            )
            tk.Label(
                row, text=f"  {msg}", font=FONT_TINY, bg=CARD, fg=TEXT2, anchor="w"
            ).pack(side="left")

    def _on_preset(self, _=None):
        q = QUALITY_PRESETS.get(self.preset_var.get())
        if q is None:
            self.q_slider.config(state="normal")
        else:
            self.q_slider.config(state="disabled")
            self.q_var.set(q)
            self.q_lbl.config(text=str(q))

    def _on_slider(self, val):
        self.q_lbl.config(text=str(int(float(val))))

    def _on_fmt_change(self, *_):
        fmt, _ = FORMATS[self.fmt_var.get()]
        if fmt == "PNG":
            self.png_info.pack(anchor="w", padx=18, pady=(4, 0))
            self.avif_info.pack_forget()
        elif fmt == "AVIF":
            self.avif_info.pack(anchor="w", padx=18, pady=(4, 0))
            self.png_info.pack_forget()
        else:
            self.png_info.pack_forget()
            self.avif_info.pack_forget()

    def _get_quality(self):
        q = QUALITY_PRESETS.get(self.preset_var.get())
        return q if q is not None else self.q_var.get()

    def _get_vquality(self):
        q = VIDEO_QUALITY_PRESETS.get(self.vpreset_var.get())
        return q if q is not None else self.vq_var.get()

    def _on_vpreset(self, _=None):
        q = VIDEO_QUALITY_PRESETS.get(self.vpreset_var.get())
        if q is None:
            self.vq_slider.config(state="normal")
        else:
            self.vq_slider.config(state="disabled")
            self.vq_var.set(q)
            self.vq_lbl.config(text=str(q))

    def _on_vslider(self, val):
        self.vq_lbl.config(text=str(int(float(val))))

    def _on_vcontainer(self, _=None):
        ext = VIDEO_CONTAINERS[self.vcontainer_var.get()]
        hint = CONTAINER_CODEC_HINTS.get(ext)
        if hint:
            self.vcodec_var.set(hint)

    def _on_close(self):
        if os.path.isdir(self._video_temp_dir):
            shutil.rmtree(self._video_temp_dir, ignore_errors=True)
        self.destroy()

    # ─── Main notebook ─────────────────────────────────────────────
    def _build_main(self, parent):
        main = tk.Frame(parent, bg=BG)
        main.pack(side="left", fill="both", expand=True)

        self.nb = ttk.Notebook(main, style="PF.TNotebook")
        self.nb.pack(fill="both", expand=True)

        self.tab_gallery = tk.Frame(self.nb, bg=BG)
        self.tab_video_gallery = tk.Frame(self.nb, bg=BG)
        self.tab_list = tk.Frame(self.nb, bg=BG)
        self.tab_stats = tk.Frame(self.nb, bg=BG)

        self.nb.add(self.tab_gallery, text="  🖼  Image Gallery  ")
        self.nb.add(self.tab_video_gallery, text="  🎬  Video Gallery  ")
        self.nb.add(self.tab_list, text="  ☰  File List  ")
        self.nb.add(self.tab_stats, text="  📊  Stats & Export  ")

        self._build_gallery_tab()
        self._build_video_gallery_tab()
        self._build_list_tab()
        self._build_stats_tab()

    # ─── Gallery tab ───────────────────────────────────────────────
    def _build_gallery_tab(self):
        infobar = tk.Frame(self.tab_gallery, bg=BG2, height=34)
        infobar.pack(fill="x")
        infobar.pack_propagate(False)
        tk.Label(
            infobar,
            text="  🖱  Drag image cards to reorder",
            font=FONT_SMALL,
            bg=BG2,
            fg=MUTED,
            anchor="w",
        ).pack(side="left", fill="y", padx=8)

        wrap = tk.Frame(self.tab_gallery, bg=BG)
        wrap.pack(fill="both", expand=True)
        self.g_canvas = tk.Canvas(wrap, bg=BG, highlightthickness=0)
        vsb = ttk.Scrollbar(
            wrap,
            orient="vertical",
            command=self.g_canvas.yview,
            style="PF.Vertical.TScrollbar",
        )
        self.g_canvas.configure(yscrollcommand=vsb.set)
        vsb.pack(side="right", fill="y")
        self.g_canvas.pack(side="left", fill="both", expand=True)

        self.g_inner = tk.Frame(self.g_canvas, bg=BG)
        self._g_win = self.g_canvas.create_window(
            (0, 0), window=self.g_inner, anchor="nw"
        )
        self.g_inner.bind(
            "<Configure>",
            lambda e: self.g_canvas.configure(scrollregion=self.g_canvas.bbox("all")),
        )
        self.g_canvas.bind("<Configure>", self._on_canvas_cfg)
        self.g_canvas.bind(
            "<MouseWheel>",
            lambda e: self.g_canvas.yview_scroll(int(-1 * (e.delta / 120)), "units"),
        )

        self._show_empty("image")

    def _build_video_gallery_tab(self):
        infobar = tk.Frame(self.tab_video_gallery, bg=BG2, height=34)
        infobar.pack(fill="x")
        infobar.pack_propagate(False)
        tk.Label(
            infobar,
            text="  🖱  Drag video cards to reorder · optimized output",
            font=FONT_SMALL,
            bg=BG2,
            fg=MUTED,
            anchor="w",
        ).pack(side="left", fill="y", padx=8)

        wrap = tk.Frame(self.tab_video_gallery, bg=BG)
        wrap.pack(fill="both", expand=True)
        self.vg_canvas = tk.Canvas(wrap, bg=BG, highlightthickness=0)
        vsb = ttk.Scrollbar(
            wrap,
            orient="vertical",
            command=self.vg_canvas.yview,
            style="PF.Vertical.TScrollbar",
        )
        self.vg_canvas.configure(yscrollcommand=vsb.set)
        vsb.pack(side="right", fill="y")
        self.vg_canvas.pack(side="left", fill="both", expand=True)

        self.vg_inner = tk.Frame(self.vg_canvas, bg=BG)
        self._vg_win = self.vg_canvas.create_window(
            (0, 0), window=self.vg_inner, anchor="nw"
        )
        self.vg_inner.bind(
            "<Configure>",
            lambda e: self.vg_canvas.configure(scrollregion=self.vg_canvas.bbox("all")),
        )
        self.vg_canvas.bind("<Configure>", self._on_vg_canvas_cfg)
        self.vg_canvas.bind(
            "<MouseWheel>",
            lambda e: self.vg_canvas.yview_scroll(int(-1 * (e.delta / 120)), "units"),
        )

        self._show_empty("video")

    def _on_vg_canvas_cfg(self, e):
        self.vg_canvas.itemconfig(self._vg_win, width=e.width)
        if self.converted:
            self._refresh_video_gallery()

    def _on_canvas_cfg(self, e):
        self.g_canvas.itemconfig(self._g_win, width=e.width)
        if self.converted:
            self._refresh_image_gallery()

    def _show_empty(self, kind="image"):
        inner = self.g_inner if kind == "image" else self.vg_inner
        icon = "🖼" if kind == "image" else "🎬"
        label = "images" if kind == "image" else "videos"
        for w in inner.winfo_children():
            w.destroy()
        h = tk.Frame(inner, bg=BG)
        h.pack(expand=True, pady=100)
        c = tk.Canvas(h, width=72, height=72, bg=BG, highlightthickness=0)
        c.pack()
        c.create_oval(6, 6, 66, 66, fill=CARD, outline=BORDER, width=2)
        c.create_text(36, 36, text=icon, font=("Segoe UI", 22))
        tk.Label(
            h, text=f"No {label} converted yet",
            font=("Segoe UI", 13, "bold"), bg=BG, fg=TEXT2,
        ).pack(pady=(10, 4))
        tk.Label(
            h,
            text="Convert media — results appear in the matching gallery tab.",
            font=FONT_SMALL, bg=BG, fg=MUTED,
        ).pack()

    def _render_gallery_cards(self, order, inner, photo_refs, bind_fn):
        """Render gallery cards for a given order list."""
        for w in inner.winfo_children():
            w.destroy()
        photo_refs.clear()

        if not order:
            return False

        canvas = self.g_canvas if inner is self.g_inner else self.vg_canvas
        cw = max(canvas.winfo_width(), 200)
        CARD_W = THUMB_SIZE + 44
        cols = max(1, (cw - 20) // (CARD_W + 14))

        for pos, idx in enumerate(order):
            c = self.converted[idx]
            col = pos % cols
            row = pos // cols
            red = (1 - c["new_size"] / c["orig_size"]) * 100 if c["orig_size"] else 0

            card = tk.Frame(
                inner, bg=CARD, highlightbackground=BORDER,
                highlightthickness=1, cursor="hand2",
            )
            card.grid(row=row, column=col, padx=7, pady=7, sticky="n")

            tf = tk.Frame(
                card, bg="#0d0e18", width=THUMB_SIZE + 22, height=THUMB_SIZE + 18
            )
            tf.pack(fill="x")
            tf.pack_propagate(False)

            photo = ImageTk.PhotoImage(c["thumb_pil"])
            photo_refs.append(photo)
            tk.Label(tf, image=photo, bg="#0d0e18", cursor="hand2").place(
                relx=0.5, rely=0.5, anchor="center"
            )

            tk.Label(
                tf, text=f" #{pos + 1} ", font=("Segoe UI", 8, "bold"),
                bg="#0a0b10", fg=ACCENT, padx=3, pady=1,
            ).place(x=5, y=5)
            badge = c.get("ext", "file").upper()
            type_icon = "🎬" if c.get("media_type") == "video" else "🖼"
            tk.Label(
                tf, text=f" {type_icon} {badge} ", font=FONT_TINY,
                bg=CARD, fg=TEXT2, padx=3, pady=1,
            ).place(relx=1, x=-5, y=5, anchor="ne")

            inf = tk.Frame(card, bg=CARD)
            inf.pack(fill="x", padx=10, pady=(6, 10))
            tk.Label(
                inf, text=c["display_name"], font=FONT_BODY_B, bg=CARD, fg=ACCENT
            ).pack(anchor="w")
            tk.Label(
                inf, text=c["orig_name"], font=FONT_TINY, bg=CARD, fg=MUTED,
                wraplength=THUMB_SIZE + 18, anchor="w", justify="left",
            ).pack(anchor="w")

            if c.get("media_type") == "video":
                tk.Label(
                    inf,
                    text=f"  {human_duration(c.get('duration', 0))}  ·  {c.get('resolution', '—')}",
                    font=FONT_TINY, bg=CARD, fg=BLUE, anchor="w",
                ).pack(anchor="w", pady=(2, 0))

            sr2 = tk.Frame(inf, bg=CARD)
            sr2.pack(anchor="w", pady=(4, 0))
            tk.Label(
                sr2, text=human_size(c["new_size"]), font=FONT_SMALL, bg=CARD, fg=TEXT2
            ).pack(side="left")
            rc = ACCENT if red >= 0 else ACCENT2
            tk.Label(
                sr2,
                text=f"  {'↓' if red >= 0 else '↑'}{abs(red):.1f}%",
                font=("Segoe UI", 8, "bold"), bg=CARD, fg=rc,
            ).pack(side="left")

            def _on_enter(e, w=card):
                w.config(highlightbackground=ACCENT_DIM)

            def _on_leave(e, w=card):
                w.config(highlightbackground=BORDER)

            card.bind("<Enter>", _on_enter)
            card.bind("<Leave>", _on_leave)

            widgets = (
                [card] + list(card.winfo_children())
                + [gc for ch in card.winfo_children() for gc in ch.winfo_children()]
            )
            for widget in widgets:
                bind_fn(widget, pos)
        return True

    def _refresh_image_gallery(self):
        if not self._render_gallery_cards(
            self.image_order, self.g_inner, self._photo_refs, self._bind_g
        ):
            self._show_empty("image")

    def _refresh_video_gallery(self):
        if not self._render_gallery_cards(
            self.video_order, self.vg_inner, self._vg_photo_refs, self._bind_vg
        ):
            self._show_empty("video")

    def _refresh_gallery(self):
        self._refresh_image_gallery()
        self._refresh_video_gallery()

    def _bind_g(self, w, pos):
        w.bind("<ButtonPress-1>", lambda e, p=pos: self._g_start(e, p))
        w.bind("<B1-Motion>", self._g_motion)
        w.bind("<ButtonRelease-1>", self._g_end)

    def _g_start(self, e, pos):
        self._drag_src = pos
        if self._drag_ghost:
            self._drag_ghost.destroy()
        g = tk.Toplevel(self)
        g.overrideredirect(True)
        g.attributes("-alpha", 0.9)
        g.geometry(f"+{e.x_root + 16}+{e.y_root + 10}")
        f = tk.Frame(g, bg=ACCENT, padx=14, pady=8)
        f.pack()
        idx = self.image_order[pos]
        tk.Label(
            f,
            text=f"Moving  {self.converted[idx]['display_name']}",
            font=FONT_BTN, bg=ACCENT, fg="#0a0b10",
        ).pack()
        self._drag_ghost = g

    def _g_motion(self, e):
        if self._drag_ghost:
            self._drag_ghost.geometry(f"+{e.x_root + 16}+{e.y_root + 10}")

    def _g_end(self, e):
        if self._drag_ghost:
            self._drag_ghost.destroy()
            self._drag_ghost = None
        src = self._drag_src
        self._drag_src = None
        if src is None:
            return
        cw = max(self.g_canvas.winfo_width(), 200)
        CARD_W = THUMB_SIZE + 44
        cols = max(1, (cw - 20) // (CARD_W + 14))
        for widget in self.g_inner.winfo_children():
            gi = widget.grid_info()
            if "row" not in gi:
                continue
            wx = widget.winfo_rootx()
            wy = widget.winfo_rooty()
            ww = widget.winfo_width()
            wh = widget.winfo_height()
            if wx <= e.x_root <= wx + ww and wy <= e.y_root <= wy + wh:
                dst = int(gi["row"]) * cols + int(gi["column"])
                if dst != src:
                    self._move_in_order("image", src, dst)
                return

    def _bind_vg(self, w, pos):
        w.bind("<ButtonPress-1>", lambda e, p=pos: self._vg_start(e, p))
        w.bind("<B1-Motion>", self._vg_motion)
        w.bind("<ButtonRelease-1>", self._vg_end)

    def _vg_start(self, e, pos):
        self._vid_drag_src = pos
        if self._vid_drag_ghost:
            self._vid_drag_ghost.destroy()
        g = tk.Toplevel(self)
        g.overrideredirect(True)
        g.attributes("-alpha", 0.9)
        g.geometry(f"+{e.x_root + 16}+{e.y_root + 10}")
        f = tk.Frame(g, bg=ACCENT, padx=14, pady=8)
        f.pack()
        idx = self.video_order[pos]
        tk.Label(
            f,
            text=f"Moving  {self.converted[idx]['display_name']}",
            font=FONT_BTN, bg=ACCENT, fg="#0a0b10",
        ).pack()
        self._vid_drag_ghost = g

    def _vg_motion(self, e):
        if self._vid_drag_ghost:
            self._vid_drag_ghost.geometry(f"+{e.x_root + 16}+{e.y_root + 10}")

    def _vg_end(self, e):
        if self._vid_drag_ghost:
            self._vid_drag_ghost.destroy()
            self._vid_drag_ghost = None
        src = self._vid_drag_src
        self._vid_drag_src = None
        if src is None:
            return
        cw = max(self.vg_canvas.winfo_width(), 200)
        CARD_W = THUMB_SIZE + 44
        cols = max(1, (cw - 20) // (CARD_W + 14))
        for widget in self.vg_inner.winfo_children():
            gi = widget.grid_info()
            if "row" not in gi:
                continue
            wx = widget.winfo_rootx()
            wy = widget.winfo_rooty()
            ww = widget.winfo_width()
            wh = widget.winfo_height()
            if wx <= e.x_root <= wx + ww and wy <= e.y_root <= wy + wh:
                dst = int(gi["row"]) * cols + int(gi["column"])
                if dst != src:
                    self._move_in_order("video", src, dst)
                return

    # ─── List tab ──────────────────────────────────────────────────
    def _build_list_tab(self):
        infobar = tk.Frame(self.tab_list, bg=BG2, height=34)
        infobar.pack(fill="x")
        infobar.pack_propagate(False)
        tk.Label(
            infobar,
            text="  🖱  Drag rows up/down to reorder",
            font=FONT_SMALL,
            bg=BG2,
            fg=MUTED,
            anchor="w",
        ).pack(side="left", fill="y", padx=8)

        wrap = tk.Frame(self.tab_list, bg=BG)
        wrap.pack(fill="both", expand=True)
        self.l_canvas = tk.Canvas(wrap, bg=BG, highlightthickness=0)
        vsb = ttk.Scrollbar(
            wrap,
            orient="vertical",
            command=self.l_canvas.yview,
            style="PF.Vertical.TScrollbar",
        )
        self.l_canvas.configure(yscrollcommand=vsb.set)
        vsb.pack(side="right", fill="y")
        self.l_canvas.pack(side="left", fill="both", expand=True)

        self.l_inner = tk.Frame(self.l_canvas, bg=BG)
        self._l_win = self.l_canvas.create_window(
            (0, 0), window=self.l_inner, anchor="nw"
        )
        self.l_inner.bind(
            "<Configure>",
            lambda e: self.l_canvas.configure(scrollregion=self.l_canvas.bbox("all")),
        )
        self.l_canvas.bind(
            "<Configure>",
            lambda e: self.l_canvas.itemconfig(self._l_win, width=e.width),
        )
        self.l_canvas.bind(
            "<MouseWheel>",
            lambda e: self.l_canvas.yview_scroll(int(-1 * (e.delta / 120)), "units"),
        )

    def _refresh_list(self):
        for w in self.l_inner.winfo_children():
            w.destroy()
        self._list_photos.clear()

        if not self.converted:
            tk.Label(
                self.l_inner,
                text="No media converted yet.",
                font=FONT_BODY,
                bg=BG,
                fg=MUTED,
            ).pack(pady=40)
            return

        # Column headers
        hdr = tk.Frame(self.l_inner, bg=BG2)
        hdr.pack(fill="x", padx=12, pady=(8, 4))
        for col_text, side, w in [
            ("", "left", 60),
            ("#", "left", 70),
            ("Filename", "left", 0),
            ("Original", "right", 80),
            ("Converted", "right", 80),
            ("Saving", "right", 70),
        ]:
            kw = {"side": side, "padx": 4}
            if w:
                kw["width"] = w
            if side == "left" and w == 0:
                kw["fill"] = "x"
                kw["expand"] = True
            tk.Label(
                hdr,
                text=col_text.upper(),
                font=FONT_TINY,
                bg=BG2,
                fg=MUTED,
                anchor=side,
            ).pack(**kw)

        for kind, order_list, title in [
            ("image", self.image_order, "IMAGES"),
            ("video", self.video_order, "VIDEOS"),
        ]:
            if not order_list:
                continue
            tk.Label(
                self.l_inner, text=title, font=FONT_LABEL, bg=BG, fg=MUTED,
            ).pack(anchor="w", padx=14, pady=(10, 4))

            for pos, idx in enumerate(order_list):
                c = self.converted[idx]
                red = (1 - c["new_size"] / c["orig_size"]) * 100 if c["orig_size"] else 0
                rc = ACCENT if red >= 0 else ACCENT2
                rt = f"{'↓' if red >= 0 else '↑'}{abs(red):.1f}%"

                row = tk.Frame(
                    self.l_inner,
                    bg=CARD,
                    highlightbackground=BORDER,
                    highlightthickness=1,
                    cursor="sb_v_double_arrow",
                )
                row._order_kind = kind
                row.pack(fill="x", padx=12, pady=3)

                ab = tk.Frame(row, bg=ACCENT_DIM, width=3)
                ab.pack(side="left", fill="y")

                tk.Label(
                    row, text="⋮⋮", font=("Segoe UI", 12), bg=CARD, fg=MUTED2, padx=8
                ).pack(side="left")

                photo = ImageTk.PhotoImage(c["list_thumb"])
                self._list_photos.append(photo)
                tk.Label(row, image=photo, bg=CARD).pack(side="left", pady=6, padx=(0, 10))

                nc = tk.Frame(row, bg=CARD)
                nc.pack(side="left", fill="x", expand=True)
                tk.Label(
                    nc, text=c["display_name"], font=FONT_BODY_B, bg=CARD, fg=ACCENT, anchor="w",
                ).pack(anchor="w")
                tk.Label(
                    nc, text=c["orig_name"], font=FONT_SMALL, bg=CARD, fg=MUTED, anchor="w"
                ).pack(anchor="w")
                if c.get("media_type") == "video":
                    tk.Label(
                        nc,
                        text=f"{human_duration(c.get('duration', 0))}  ·  {c.get('resolution', '—')}",
                        font=FONT_TINY, bg=CARD, fg=BLUE, anchor="w",
                    ).pack(anchor="w")

                sc = tk.Frame(row, bg=CARD)
                sc.pack(side="right", padx=14)
                tk.Label(
                    sc, text=human_size(c["orig_size"]), font=FONT_SMALL,
                    bg=CARD, fg=MUTED, anchor="e",
                ).pack(anchor="e")
                sr3 = tk.Frame(sc, bg=CARD)
                sr3.pack(anchor="e")
                tk.Label(
                    sr3, text=human_size(c["new_size"]), font=FONT_SMALL, bg=CARD, fg=TEXT2
                ).pack(side="left")
                tk.Label(
                    sr3, text=f"  {rt}", font=("Segoe UI", 8, "bold"), bg=CARD, fg=rc
                ).pack(side="left")

                all_children = (
                    [row, ab] + list(row.winfo_children())
                    + [gc for ch in row.winfo_children() for gc in ch.winfo_children()]
                )

                def _enter(e, w=row, a=ab, kids=all_children):
                    w.config(bg=CARD_HOV, highlightbackground=ACCENT_DIM)
                    a.config(bg=ACCENT)
                    for k in kids:
                        try:
                            k.config(bg=CARD_HOV)
                        except Exception:
                            pass

                def _leave(e, w=row, a=ab, kids=all_children):
                    w.config(bg=CARD, highlightbackground=BORDER)
                    a.config(bg=ACCENT_DIM)
                    for k in kids:
                        try:
                            k.config(bg=CARD)
                        except Exception:
                            pass

                row.bind("<Enter>", _enter)
                row.bind("<Leave>", _leave)

                for widget in all_children:
                    self._bind_l(widget, pos, kind)

    def _bind_l(self, w, pos, kind):
        w.bind("<ButtonPress-1>", lambda e, p=pos, k=kind: self._l_start(e, p, k))
        w.bind("<B1-Motion>", self._l_motion)
        w.bind("<ButtonRelease-1>", self._l_end)

    def _l_start(self, e, pos, kind):
        self._list_src = pos
        self._list_order_kind = kind
        if self._list_ghost:
            self._list_ghost.destroy()
        g = tk.Toplevel(self)
        g.overrideredirect(True)
        g.attributes("-alpha", 0.88)
        g.geometry(f"+{e.x_root + 12}+{e.y_root + 6}")
        f = tk.Frame(g, bg=CARD, padx=14, pady=8)
        f.pack()
        order_list = self.image_order if kind == "image" else self.video_order
        display_name = self.converted[order_list[pos]]["display_name"]
        tk.Label(f, text="⋮⋮ ", font=("Segoe UI", 12), bg=CARD, fg=ACCENT).pack(side="left")
        tk.Label(
            f, text=f"Moving {display_name}", font=FONT_BTN, bg=CARD, fg=TEXT
        ).pack(side="left")
        self._list_ghost = g

    def _l_motion(self, e):
        if self._list_ghost:
            self._list_ghost.geometry(f"+{e.x_root + 12}+{e.y_root + 6}")
        rows = self.l_inner.winfo_children()
        for i, row in enumerate(rows):
            if not hasattr(row, "config"):
                continue
            try:
                ry = row.winfo_rooty()
                rh = row.winfo_height()
                row.config(
                    highlightbackground=ACCENT if ry <= e.y_root <= ry + rh else BORDER
                )
            except:
                pass

    def _l_end(self, e):
        if self._list_ghost:
            self._list_ghost.destroy()
            self._list_ghost = None
        for row in self.l_inner.winfo_children():
            try:
                row.config(highlightbackground=BORDER)
            except:
                pass
        src = self._list_src
        kind = self._list_order_kind
        self._list_src = None
        self._list_order_kind = None
        if src is None or kind is None:
            return
        rows = [
            r
            for r in self.l_inner.winfo_children()
            if r.winfo_class() == "Frame"
            and r.cget("highlightthickness") == 1
            and getattr(r, "_order_kind", None) == kind
        ]
        for dst, row in enumerate(rows):
            ry = row.winfo_rooty()
            rh = row.winfo_height()
            if ry <= e.y_root <= ry + rh:
                if dst != src:
                    self._move_in_order(kind, src, dst)
                return

    # ─── Stats tab ─────────────────────────────────────────────────
    def _build_stats_tab(self):
        wrap = tk.Frame(self.tab_stats, bg=BG)
        wrap.pack(fill="both", expand=True)
        sv = ttk.Scrollbar(wrap, orient="vertical", style="PF.Vertical.TScrollbar")
        self.s_canvas = tk.Canvas(
            wrap, bg=BG, highlightthickness=0, yscrollcommand=sv.set
        )
        sv.config(command=self.s_canvas.yview)
        sv.pack(side="right", fill="y")
        self.s_canvas.pack(fill="both", expand=True)

        self.s_inner = tk.Frame(self.s_canvas, bg=BG)
        self._s_win = self.s_canvas.create_window(
            (0, 0), window=self.s_inner, anchor="nw"
        )
        self.s_inner.bind(
            "<Configure>",
            lambda e: self.s_canvas.configure(scrollregion=self.s_canvas.bbox("all")),
        )
        self.s_canvas.bind(
            "<Configure>",
            lambda e: self.s_canvas.itemconfig(self._s_win, width=e.width),
        )
        self.s_canvas.bind(
            "<MouseWheel>",
            lambda e: self.s_canvas.yview_scroll(int(-1 * (e.delta / 120)), "units"),
        )

        tk.Label(
            self.s_inner,
            text="Convert files to see stats here.",
            font=FONT_BODY,
            bg=BG,
            fg=MUTED,
        ).pack(pady=60)

    def _refresh_stats(self):
        for w in self.s_inner.winfo_children():
            w.destroy()

        if not self.converted:
            tk.Label(
                self.s_inner, text="Convert media to see stats here.",
                font=FONT_BODY, bg=BG, fg=MUTED,
            ).pack(pady=60)
            return

        images = [c for c in self.converted if c.get("media_type") == "image"]
        videos = [c for c in self.converted if c.get("media_type") == "video"]
        tot_orig = sum(c["orig_size"] for c in self.converted)
        tot_new = sum(c["new_size"] for c in self.converted)
        saved = tot_orig - tot_new
        pct = round((1 - tot_new / tot_orig) * 100, 1) if tot_orig else 0
        tot_dur = sum(c.get("duration", 0) for c in videos)
        codecs = sorted({c.get("codec", "") for c in videos if c.get("codec")})
        codec_txt = ", ".join(codecs) if codecs else "—"

        tk.Label(self.s_inner, text="SUMMARY", font=FONT_LABEL, bg=BG, fg=MUTED).pack(
            anchor="w", padx=22, pady=(22, 8)
        )
        sc = tk.Frame(self.s_inner, bg=BG)
        sc.pack(fill="x", padx=16)
        cards = [
            ("🖼", "Images", str(len(images)), TEXT),
            ("🎬", "Videos", str(len(videos)), TEXT),
            ("⏱", "Duration", human_duration(tot_dur) if videos else "—", TEXT2),
            ("📂", "Original", human_size(tot_orig), TEXT2),
            ("✅", "Output", human_size(tot_new), TEXT2),
            ("📉", "Saved", f"{pct}%", ACCENT if saved >= 0 else ACCENT2),
        ]
        if videos:
            cards.append(("🔧", "Codec", codec_txt, BLUE))
        for icon, label, value, color in cards:
            box = tk.Frame(sc, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
            box.pack(side="left", padx=3, pady=4, ipadx=8, ipady=10, fill="x", expand=True)
            tk.Label(box, text=icon, font=("Segoe UI", 16), bg=CARD, fg=color).pack()
            tk.Label(box, text=value, font=("Segoe UI", 12, "bold"), bg=CARD, fg=color).pack()
            tk.Label(box, text=label, font=FONT_TINY, bg=CARD, fg=MUTED).pack()

        tk.Frame(self.s_inner, bg=BORDER, height=1).pack(fill="x", padx=16, pady=14)
        tk.Label(self.s_inner, text="DOWNLOAD", font=FONT_LABEL, bg=BG, fg=MUTED).pack(
            anchor="w", padx=22, pady=(0, 6)
        )
        zc = tk.Frame(self.s_inner, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
        zc.pack(fill="x", padx=16, pady=(0, 16))
        zi = tk.Frame(zc, bg=CARD)
        zi.pack(fill="x", padx=16, pady=14)
        tk.Label(
            zi, text="ZIP Download is in Sidebar", font=FONT_BODY_B, bg=CARD, fg=TEXT,
        ).pack(anchor="w")
        tk.Label(
            zi, text="Click Download ZIP — choose custom or original order",
            font=FONT_SMALL, bg=CARD, fg=MUTED,
        ).pack(anchor="w", pady=(2, 0))

        tk.Frame(self.s_inner, bg=BORDER, height=1).pack(fill="x", padx=16, pady=8)
        tk.Label(
            self.s_inner, text="INDIVIDUAL FILES", font=FONT_LABEL, bg=BG, fg=MUTED
        ).pack(anchor="w", padx=22, pady=(0, 8))
        gf = tk.Frame(self.s_inner, bg=BG)
        gf.pack(fill="x", padx=14, pady=(0, 20))
        COLS = 4
        all_idx = self.image_order + self.video_order
        for pos, idx in enumerate(all_idx):
            c = self.converted[idx]
            icon = "🎬" if c.get("media_type") == "video" else "🖼"
            btn = GhostButton(
                gf, f"{icon}  {c['display_name']}",
                command=lambda i=idx: self._save_single(i),
                padx=10, pady=7,
            )
            btn.grid(row=pos // COLS, column=pos % COLS, padx=4, pady=4, sticky="ew")
        for ci in range(COLS):
            gf.columnconfigure(ci, weight=1)

    # ─── Browse & convert ──────────────────────────────────────────
    def _browse_media(self):
        """Browse folder or files — images and videos together."""
        choice = messagebox.askyesnocancel(
            "Upload Method",
            "Yes: Select a Folder (images + videos)\n"
            "No: Select Individual Files\nCancel: Cancel",
            parent=self,
        )
        if choice is None:
            return

        if choice:
            folder = filedialog.askdirectory(title="Select Media Folder")
            if not folder:
                return
            images, videos = scan_media_folder(folder)
        else:
            paths = filedialog.askopenfilenames(
                title="Select Images and/or Videos",
                filetypes=[
                    ("All media (auto-detect)", "*.*"),
                    (
                        "Images",
                        "*.png *.jpg *.jpeg *.webp *.bmp *.gif *.tiff *.tif "
                        "*.ico *.ppm *.avif",
                    ),
                    ("Videos (known extensions)", _video_dialog_glob()),
                    ("All files", "*.*"),
                ],
            )
            if not paths:
                return
            images, videos = scan_media_paths(list(paths))

        if not images and not videos:
            messagebox.showwarning(
                "No Media Found",
                "No supported images or videos were found.\n\n"
                "Videos: any format FFmpeg can read (MP4, MOV, MKV, AVI, WEBM, "
                "M2TS, MXF, etc.) — unknown extensions are detected automatically.",
                parent=self,
            )
            return

        if videos and not find_ffmpeg():
            messagebox.showwarning(
                "FFmpeg Not Found",
                f"Found {len(videos)} video(s) but FFmpeg is not in PATH.\n\n"
                "Videos will fail until FFmpeg is installed.\n"
                "Images can still be converted.",
                parent=self,
            )

        self._set_media_sources(images, videos)

    def _set_media_sources(self, image_paths, video_paths):
        self.source_items = build_source_items(image_paths, video_paths)
        ni, nv = len(image_paths), len(video_paths)
        parts = []
        if ni:
            parts.append(f"{ni} image{'s' if ni > 1 else ''}")
        if nv:
            parts.append(f"{nv} video{'s' if nv > 1 else ''}")
        self.file_lbl.config(text=f"  ✓  {' + '.join(parts)} selected", fg=ACCENT)
        self.conv_btn.set_enabled(True)
        self.converted = []
        self.image_order = []
        self.video_order = []
        self.original_image_order = []
        self.original_video_order = []
        self.zip_btn.set_enabled(False)
        self.zip_status.config(text="Waiting for conversion...", fg=TEXT2)
        self.zip_size.config(text="")
        self._refresh_all()

    def _start_convert(self):
        if not self.source_items:
            messagebox.showwarning("No Media", "Select images and/or videos first.", parent=self)
            return
        has_videos = any(x["type"] == "video" for x in self.source_items)
        if has_videos and not find_ffmpeg():
            messagebox.showerror(
                "FFmpeg Required",
                "Videos are selected but FFmpeg was not found in PATH.\n"
                "Install FFmpeg or remove videos from selection.",
                parent=self,
            )
            return
        if has_videos:
            ext = VIDEO_CONTAINERS[self.vcontainer_var.get()]
            if ext == "webm" and self.vcodec_var.get() != "AV1":
                messagebox.showwarning(
                    "Codec Adjusted", "WEBM requires AV1. Switching to AV1.", parent=self,
                )
                self.vcodec_var.set("AV1")
        self.conv_btn.set_enabled(False)
        self.prog_var.set(0)
        self.prog_lbl.config(text="Starting conversion…", fg=MUTED)
        threading.Thread(target=self._convert_thread, daemon=True).start()

    def _convert_thread(self):
        target_fmt, image_ext = FORMATS[self.fmt_var.get()]
        img_quality = self._get_quality()
        img_max_dim = MAX_DIM_OPTIONS[self.dim_var.get()]
        codec_key = self.vcodec_var.get()
        container_ext = VIDEO_CONTAINERS[self.vcontainer_var.get()]
        vid_crf = self._get_vquality()
        vid_max_dim = VIDEO_RES_OPTIONS[self.vres_var.get()]
        total = len(self.source_items)
        result = []
        errors = []

        for i, src in enumerate(self.source_items):
            path = src["path"]
            name = os.path.basename(path)
            name_no_ext = get_filename_without_ext(name)
            seq = i + 1

            self.after(
                0,
                lambda i=i, n=name, t=total: (
                    self.prog_var.set(i / t * 100),
                    self.prog_lbl.config(text=f"  {i + 1}/{t}  {n}", fg=MUTED),
                ),
            )

            try:
                if src["type"] == "image":
                    display_name = f"{name_no_ext}_{seq}.{image_ext}"
                    pil = Image.open(path)
                    orig = os.path.getsize(path)
                    data = convert_image(pil, target_fmt, img_quality, img_max_dim)
                    thumb = make_thumbnail(pil, THUMB_SIZE)
                    lthumb = make_thumbnail(pil, ROW_THUMB)
                    result.append({
                        "media_type": "image",
                        "orig_name": name,
                        "stem": name_no_ext,
                        "original_name": display_name,
                        "display_name": display_name,
                        "ext": image_ext,
                        "data": data,
                        "orig_size": orig,
                        "new_size": len(data),
                        "thumb_pil": thumb,
                        "list_thumb": lthumb,
                    })
                else:
                    display_name = f"{name_no_ext}_{seq}.{container_ext}"
                    out_path = os.path.join(self._video_temp_dir, f"pf_{i}_{display_name}")

                    def report_progress(pct, idx=i, n=name, t=total):
                        base = idx / t * 100
                        self.after(
                            0,
                            lambda b=base, p=pct, nm=n, ix=idx: (
                                self.prog_var.set(b + p / t),
                                self.prog_lbl.config(
                                    text=f"  {ix + 1}/{t}  {nm}  ({int(p)}%)", fg=MUTED
                                ),
                            ),
                        )

                    info = get_video_info(path)
                    thumb = generate_video_thumbnail(path, THUMB_SIZE)
                    lthumb = generate_video_thumbnail(path, ROW_THUMB)
                    new_size = convert_video(
                        path, out_path, codec_key, container_ext, vid_crf, vid_max_dim,
                        progress_cb=report_progress,
                    )
                    result.append({
                        "media_type": "video",
                        "orig_name": name,
                        "stem": name_no_ext,
                        "original_name": display_name,
                        "display_name": display_name,
                        "ext": container_ext,
                        "output_path": out_path,
                        "orig_size": info["size"],
                        "new_size": new_size,
                        "duration": info["duration"],
                        "resolution": info["resolution"],
                        "codec": codec_key,
                        "thumb_pil": thumb,
                        "list_thumb": lthumb,
                    })
            except Exception as ex:
                errors.append(f"{name}: {ex}")
                print(f"Skip {path}: {ex}")

        self.after(0, self._done, result, errors)

    def _sync_type_orders(self, result=None):
        items = result if result is not None else self.converted
        self.image_order = [i for i, c in enumerate(items) if c.get("media_type") == "image"]
        self.video_order = [i for i, c in enumerate(items) if c.get("media_type") == "video"]
        self.original_image_order = list(self.image_order)
        self.original_video_order = list(self.video_order)

    def _done(self, result, errors=None):
        errors = errors or []
        self.converted = result
        self._sync_type_orders(result)
        self.prog_var.set(100)

        if result:
            self._update_display_names()
            preview = []
            for idx in (self.image_order + self.video_order)[:3]:
                preview.append(self.converted[idx]["display_name"])
            names = " · ".join(preview)
            if len(result) > 3:
                names += f" · +{len(result) - 3} more"
            ni = len(self.image_order)
            nv = len(self.video_order)
            self.prog_lbl.config(
                text=f"  ✓  {ni} image(s), {nv} video(s)  —  {names}", fg=ACCENT
            )
            tot_size = sum(c["new_size"] for c in self.converted)
            self.zip_status.config(text="Ready to download!", fg=ACCENT)
            self.zip_size.config(
                text=f"{len(result)} files · {human_size(tot_size)}", fg=TEXT2
            )
            self.zip_btn.set_enabled(True)
        else:
            self.prog_lbl.config(text="  ✗  Conversion failed", fg=ACCENT2)

        self.conv_btn.set_enabled(True)
        self._refresh_all()
        if self.image_order:
            self.nb.select(0)
        elif self.video_order:
            self.nb.select(1)

        if errors and not result:
            messagebox.showerror(
                "Conversion Failed",
                "No files were converted.\n\n" + "\n".join(errors[:8]),
                parent=self,
            )
        elif errors:
            messagebox.showwarning(
                "Partial Success",
                f"Converted {len(result)} file(s).\n"
                f"{len(errors)} failed:\n\n" + "\n".join(errors[:6]),
                parent=self,
            )
        elif not result:
            messagebox.showwarning("Nothing Converted", "No files were converted.", parent=self)

    def _update_display_names(self):
        """Renumber filenames per gallery order (images and videos separately)."""
        for pos, idx in enumerate(self.image_order):
            item = self.converted[idx]
            item["display_name"] = f"{item['stem']}_{pos + 1}.{item['ext']}"
        for pos, idx in enumerate(self.video_order):
            item = self.converted[idx]
            item["display_name"] = f"{item['stem']}_{pos + 1}.{item['ext']}"

    def _order_list(self, kind):
        if kind == "image":
            return self.image_order
        return self.video_order

    def _original_order_list(self, kind):
        if kind == "image":
            return self.original_image_order
        return self.original_video_order

    def _move_in_order(self, kind, src, dst):
        order_list = self._order_list(kind)
        if src == dst or not (0 <= src < len(order_list) and 0 <= dst < len(order_list)):
            return
        moved = order_list.pop(src)
        order_list.insert(dst, moved)
        self._update_display_names()
        self._refresh_all()

    def _zip_entries(self, use_custom_order=True):
        """Build zip with images/ and videos/ folders."""
        self._update_display_names()
        entries = []

        img_seq = (
            self.image_order if use_custom_order else self.original_image_order
        )
        vid_seq = (
            self.video_order if use_custom_order else self.original_video_order
        )

        iw = max(2, len(str(len(img_seq)))) if img_seq else 2
        vw = max(2, len(str(len(vid_seq)))) if vid_seq else 2

        for pos, idx in enumerate(img_seq):
            item = self.converted[idx]
            fname = item["display_name"] if use_custom_order else item["original_name"]
            zip_name = f"images/{pos + 1:0{iw}d}_{fname}"
            entries.append((zip_name, item["data"], "bytes"))

        for pos, idx in enumerate(vid_seq):
            item = self.converted[idx]
            fname = item["display_name"] if use_custom_order else item["original_name"]
            zip_name = f"videos/{pos + 1:0{vw}d}_{fname}"
            entries.append((zip_name, item["output_path"], "path"))

        return entries

    def _zip_entries_single_type(self, kind, use_custom_order=True):
        """Fallback: zip one media type only."""
        self._update_display_names()
        seq = (
            self._order_list(kind) if use_custom_order else self._original_order_list(kind)
        )
        folder = "images" if kind == "image" else "videos"
        width = max(2, len(str(len(seq)))) if seq else 2
        entries = []
        for pos, idx in enumerate(seq):
            item = self.converted[idx]
            fname = item["display_name"] if use_custom_order else item["original_name"]
            zip_name = f"{pos + 1:0{width}d}_{fname}"
            if kind == "video":
                entries.append((zip_name, item["output_path"], "path"))
            else:
                entries.append((zip_name, item["data"], "bytes"))
        return folder, entries

    def _write_zip(self, entries):
        return make_zip_mixed(entries)

    def _refresh_all(self):
        self._refresh_gallery()
        self._refresh_list()
        self._refresh_stats()

    # ─── Save ──────────────────────────────────────────────────────
    def _save_zip_with_rename(self):
        """Save ZIP with user-chosen filename."""
        if not self.converted:
            messagebox.showwarning("No Files", "Convert media first", parent=self)
            return

        use_custom_order = messagebox.askyesno(
            "ZIP Order",
            "Use your customized order?\n\n"
            "Yes = files in the order you set by drag-and-drop\n"
            "No = files in the original conversion order",
            parent=self,
        )

        # Ask user for ZIP filename
        default_name = "pixelforge_converted"
        zip_name = simpledialog.askstring(
            "ZIP Filename",
            "Enter ZIP filename (without .zip extension):",
            initialvalue=default_name,
            parent=self,
        )

        if zip_name is None:  # User cancelled
            return

        if not zip_name.strip():
            zip_name = default_name

        # Remove any .zip extension if user added it
        if zip_name.lower().endswith(".zip"):
            zip_name = zip_name[:-4]

        # Get download location
        path = filedialog.asksaveasfilename(
            defaultextension=".zip",
            filetypes=[("ZIP file", "*.zip"), ("All files", "*.*")],
            initialfile=f"{zip_name}.zip",
            title="Save ZIP File",
        )

        if path:
            if not path.lower().endswith(".zip"):
                path = f"{path}.zip"
            entries = self._zip_entries(use_custom_order=use_custom_order)
            if not entries:
                messagebox.showwarning("Empty ZIP", "No files to export.", parent=self)
                return
            try:
                data = self._write_zip(entries)
                with open(path, "wb") as f:
                    f.write(data)
                order_label = "customized order" if use_custom_order else "original order"
                order_preview = "\n".join(
                    f"  {name}" for name, *_ in entries
                )
                messagebox.showinfo(
                    "Saved ✓",
                    f"ZIP saved ({order_label})!\n\n"
                    f"📦  {os.path.basename(path)}\n"
                    f"📊  {len(entries)} files\n"
                    f"💾  {human_size(len(data))}\n\n"
                    f"Structure:\n  images/  ({len(self.image_order)} files)\n"
                    f"  videos/  ({len(self.video_order)} files)\n\n"
                    f"Contents:\n{order_preview}",
                    parent=self,
                )
            except Exception as ex:
                if messagebox.askyesno(
                    "Combined ZIP Failed",
                    f"Could not create combined ZIP:\n{ex}\n\n"
                    "Save separate ZIP files for images and videos instead?",
                    parent=self,
                ):
                    self._save_separate_zips(use_custom_order, os.path.dirname(path))

    def _save_single(self, idx):
        """Save individual file using its current ordered name."""
        item = self.converted[idx]
        display_name = item["display_name"]
        ext = item["ext"]
        path = filedialog.asksaveasfilename(
            defaultextension=f".{ext}",
            filetypes=[(ext.upper(), f"*.{ext}"), ("All files", "*.*")],
            initialfile=display_name,
            title=f"Save {display_name}",
        )
        if not path:
            return
        if item.get("media_type") == "video":
            shutil.copy2(item["output_path"], path)
        else:
            with open(path, "wb") as f:
                f.write(item["data"])
        messagebox.showinfo("Saved ✓", f"Saved:\n{os.path.basename(path)}")

    def _save_separate_zips(self, use_custom_order, folder):
        """Fallback: save images.zip and videos.zip separately."""
        saved = []
        base = os.path.join(folder, "pixelforge")
        for kind in ("image", "video"):
            seq = self._order_list(kind) if use_custom_order else self._original_order_list(kind)
            if not seq:
                continue
            label, entries = self._zip_entries_single_type(kind, use_custom_order)
            suffix = "images" if kind == "image" else "videos"
            out = f"{base}_{suffix}.zip"
            data = self._write_zip(entries)
            with open(out, "wb") as f:
                f.write(data)
            saved.append(f"{os.path.basename(out)} ({len(entries)} files)")
        if saved:
            messagebox.showinfo(
                "Separate ZIPs Saved",
                "Saved:\n\n" + "\n".join(f"  • {s}" for s in saved),
                parent=self,
            )


# ─── Entry ─────────────────────────────────────────────────────────
if __name__ == "__main__":
    app = PixelForge()
    app.mainloop()
