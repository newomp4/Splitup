"""Splitup — local Flask app that turns a long horizontal video into a folder
of vertical 1080x1920 clips.

Pipeline per clip:
    source -> (split into bg + fg)
    bg : scale-fill 1080x1920, gaussian blur, optional dim
    fg : scale to fg_w x fg_h (can overflow past 1080)
    optional drop shadow under fg
    overlay fg
    drawtext title at absolute (text_x, text_y)
    burn ASS captions with per-word pop-in at absolute (caption_x, caption_y)
    fps=30, yuv420p
    libx264 + aac
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file

# ---------- paths ----------
ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "bin"
UPLOADS = ROOT / "uploads"
OUTPUT = ROOT / "output"
TEMP = ROOT / "temp"
PRESETS = ROOT / "presets"
WHISPER_CACHE = BIN / "whisper-cache"

FFMPEG = str(BIN / "ffmpeg")
FFPROBE = str(BIN / "ffprobe")
FONT = str(BIN / "Inter-Bold.ttf")

for d in (UPLOADS, OUTPUT, TEMP, PRESETS, WHISPER_CACHE):
    d.mkdir(parents=True, exist_ok=True)

os.environ.setdefault("HF_HOME", str(WHISPER_CACHE))
os.environ.setdefault("XDG_CACHE_HOME", str(WHISPER_CACHE))

# ---------- defaults (also seed for factory presets) ----------
OUT_W, OUT_H = 1080, 1920

DEFAULT_SETTINGS = {
    "target": 60,
    "base_title": "My Clip",
    "fg_scale": 0.95,
    "blur": 25,
    "bg_dim": 0.0,
    "show_title": True,
    "text_size": 76,
    "text_color": "#ffffff",
    "text_x": OUT_W // 2,   # center of text
    "text_y": 200,          # top of text in 1080-frame px
    "text_box": True,
    "shadow": {
        "enabled": True,
        "blur": 55,
        "opacity": 0.85,
        "offset_x": 0,
        "offset_y": 18,
    },
    "captions": {
        "enabled": True,
        "model": "base.en",
        "font": "Inter",
        "size": 120,
        "color": "#ffffff",
        "outline_color": "#000000",
        "outline": 6,
        "shadow": 2,
        "caption_x": OUT_W // 2,
        "caption_y": OUT_H - 480,   # nicely above lower third
        "words_per_line": 1,
        "bold": True,
        "italic": False,
        "uppercase": True,
        "pop_in": True,
    },
}

# ---------- app ----------
app = Flask(
    __name__,
    template_folder=str(ROOT / "src" / "templates"),
    static_folder=str(ROOT / "src" / "static"),
)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024 * 1024

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()


# disable browser cache for everything — this is a local dev tool, no point
# letting an old app.js or HTML stick around after we ship a change
@app.after_request
def _no_cache(resp):
    resp.headers["Cache-Control"] = "no-store, no-cache, max-age=0, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp

TRANSCRIBE_JOBS: dict[str, dict] = {}
TRANSCRIBE_LOCK = threading.Lock()
WHISPER_MODEL = None


# ---------- helpers ----------
def find_source(vid: str) -> Path:
    for f in UPLOADS.iterdir():
        if f.stem == vid:
            return f
    raise FileNotFoundError(vid)


def probe(path: Path) -> dict:
    cmd = [
        FFPROBE, "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,duration",
        "-show_entries", "format=duration",
        "-of", "json", str(path),
    ]
    data = json.loads(subprocess.check_output(cmd))
    s = data["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    fps = round(float(num) / float(den), 2) if float(den) else 30.0
    duration = float(data["format"].get("duration") or s.get("duration") or 0)
    return {"width": s["width"], "height": s["height"], "fps": fps, "duration": duration}


def safe_filename(name: str) -> str:
    name = re.sub(r"[^\w\s\-]", "", name).strip()
    name = re.sub(r"\s+", "_", name)
    return name or "clip"


def build_cuts(duration: float, target: float, scenes: list[float]) -> list[float]:
    cuts = [0.0]
    while cuts[-1] < duration - 1.0:
        last = cuts[-1]
        ideal = last + target
        window_lo = last + max(target * 0.5, 5.0)
        window_hi = min(duration, last + target * 1.5)
        candidates = [s for s in scenes if window_lo <= s <= window_hi]
        if candidates:
            cuts.append(min(candidates, key=lambda s: abs(s - ideal)))
        else:
            cuts.append(min(duration, ideal))
    if cuts[-1] < duration:
        cuts[-1] = duration
    if len(cuts) >= 2 and (cuts[-1] - cuts[-2]) < max(2.0, target * 0.1):
        cuts[-2] = cuts[-1]
        cuts.pop()
    return cuts


def migrate(s: dict) -> dict:
    """Convert legacy text_pos+text_offset / position+margin_v to absolute Y.
    Idempotent — safe to run on already-migrated settings."""
    s = dict(s)
    if "text_y" not in s:
        pos = s.get("text_pos", "top")
        off = int(s.get("text_offset", 180))
        size = int(s.get("text_size", 76))
        if pos == "bottom":
            s["text_y"] = OUT_H - off - int(size * 1.4)
        elif pos == "center":
            s["text_y"] = (OUT_H - int(size * 1.4)) // 2
        else:
            s["text_y"] = off
    s["text_y"] = max(0, min(OUT_H - 50, int(s["text_y"])))
    s.setdefault("text_x", OUT_W // 2)

    cap = dict(s.get("captions") or {})
    if cap and "caption_y" not in cap:
        pos = cap.get("position", "center")
        mv = int(cap.get("margin_v", 700))
        size = int(cap.get("size", 110))
        if pos == "bottom":
            cap["caption_y"] = OUT_H - mv - size // 2
        elif pos == "top":
            cap["caption_y"] = mv + size // 2
        else:
            cap["caption_y"] = OUT_H // 2
    if cap:
        cap.setdefault("caption_x", OUT_W // 2)
        cap["caption_y"] = max(0, min(OUT_H, int(cap.get("caption_y", OUT_H // 2))))
        s["captions"] = cap
    return s


# ---------- factory presets ----------
def factory_presets() -> dict[str, dict]:
    """Bundled presets. Returned with __factory: true so the UI can mark them."""
    base = lambda **over: {**DEFAULT_SETTINGS, **over, "__factory": True}

    return {
        "TikTok Bold": base(
            base_title="My Clip",
            fg_scale=1.0,
            blur=30, bg_dim=0.10,
            text_size=84, text_color="#ffffff",
            text_x=OUT_W // 2, text_y=160,
            text_box=True,
            shadow={"enabled": True, "blur": 60, "opacity": 0.9, "offset_x": 0, "offset_y": 22},
            captions={
                "enabled": True, "model": "base.en", "font": "Inter",
                "size": 130, "color": "#ffffff", "outline_color": "#000000",
                "outline": 8, "shadow": 2,
                "caption_x": OUT_W // 2, "caption_y": OUT_H - 380,
                "words_per_line": 1, "bold": True, "italic": False,
                "uppercase": True, "pop_in": True,
            },
        ),
        "Reels Centered": base(
            base_title="My Clip",
            fg_scale=0.96, blur=20, bg_dim=0.0,
            text_size=70, text_color="#ffffff",
            text_x=OUT_W // 2, text_y=180, text_box=False,
            shadow={"enabled": True, "blur": 50, "opacity": 0.7, "offset_x": 0, "offset_y": 16},
            captions={
                "enabled": True, "model": "base.en", "font": "Inter",
                "size": 110, "color": "#ffffff", "outline_color": "#000000",
                "outline": 5, "shadow": 1,
                "caption_x": OUT_W // 2, "caption_y": OUT_H // 2,
                "words_per_line": 1, "bold": True, "italic": False,
                "uppercase": False, "pop_in": True,
            },
        ),
        "Hype Yellow": base(
            base_title="My Clip",
            fg_scale=1.05, blur=40, bg_dim=0.20,
            text_size=88, text_color="#ffe600",
            text_x=OUT_W // 2, text_y=150, text_box=True,
            shadow={"enabled": True, "blur": 70, "opacity": 0.92, "offset_x": 0, "offset_y": 24},
            captions={
                "enabled": True, "model": "base.en", "font": "Inter",
                "size": 140, "color": "#ffe600", "outline_color": "#000000",
                "outline": 9, "shadow": 3,
                "caption_x": OUT_W // 2, "caption_y": OUT_H - 420,
                "words_per_line": 1, "bold": True, "italic": False,
                "uppercase": True, "pop_in": True,
            },
        ),
        "Minimal Clean": base(
            base_title="My Clip",
            fg_scale=0.92, blur=18, bg_dim=0.0,
            show_title=False,
            text_size=60, text_color="#ffffff", text_box=False,
            text_x=OUT_W // 2, text_y=160,
            shadow={"enabled": True, "blur": 35, "opacity": 0.55, "offset_x": 0, "offset_y": 12},
            captions={
                "enabled": True, "model": "base.en", "font": "Inter",
                "size": 96, "color": "#ffffff", "outline_color": "#000000",
                "outline": 3, "shadow": 1,
                "caption_x": OUT_W // 2, "caption_y": OUT_H - 320,
                "words_per_line": 1, "bold": True, "italic": False,
                "uppercase": False, "pop_in": True,
            },
        ),
        "Podcast": base(
            base_title="My Clip",
            fg_scale=0.85, blur=45, bg_dim=0.30,
            text_size=72, text_color="#ffffff", text_box=True,
            text_x=OUT_W // 2, text_y=140,
            shadow={"enabled": True, "blur": 65, "opacity": 0.85, "offset_x": 0, "offset_y": 18},
            captions={
                "enabled": True, "model": "base.en", "font": "Inter",
                "size": 108, "color": "#ffffff", "outline_color": "#000000",
                "outline": 5, "shadow": 2,
                "caption_x": OUT_W // 2, "caption_y": OUT_H - 360,
                "words_per_line": 3, "bold": True, "italic": False,
                "uppercase": False, "pop_in": False,
            },
        ),
    }


# ---------- routes ----------
@app.route("/")
def index():
    # Bust the browser cache: append a query param that changes whenever
    # we touch app.js or style.css, so a redeploy never leaves a stale tab.
    js_v  = int((ROOT / "src" / "static" / "app.js").stat().st_mtime)
    css_v = int((ROOT / "src" / "static" / "style.css").stat().st_mtime)
    return render_template("index.html", js_v=js_v, css_v=css_v)


@app.route("/api/defaults")
def get_defaults():
    return jsonify(DEFAULT_SETTINGS)


@app.route("/api/upload", methods=["POST"])
def upload():
    f = request.files["video"]
    vid = uuid.uuid4().hex[:12]
    ext = Path(f.filename or "video.mp4").suffix.lower() or ".mp4"
    dest = UPLOADS / f"{vid}{ext}"
    f.save(dest)
    meta = probe(dest)
    return jsonify({"id": vid, "filename": dest.name, **meta})


@app.route("/api/source/<vid>")
def serve_source(vid):
    try:
        f = find_source(vid)
    except FileNotFoundError:
        return ("not found", 404)
    return send_file(f, conditional=True)


@app.route("/api/analyze", methods=["POST"])
def analyze():
    data = request.json or {}
    vid = data["id"]
    threshold = float(data.get("threshold", 0.35))
    src = find_source(vid)
    cmd = [
        FFMPEG, "-hide_banner", "-i", str(src),
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-an", "-f", "null", "-",
    ]
    p = subprocess.run(cmd, capture_output=True, text=True)
    timestamps = [float(m.group(1)) for m in re.finditer(r"pts_time:([\d.]+)", p.stderr)]
    return jsonify({"scene_changes": sorted(set(timestamps))})


@app.route("/api/segments", methods=["POST"])
def make_segments():
    data = request.json or {}
    duration = float(data["duration"])
    target = float(data["target"])
    scenes = data.get("scene_changes") or []
    base = data.get("title", "Clip")
    cuts = build_cuts(duration, target, scenes)
    segs = [
        {"start": cuts[i], "end": cuts[i + 1], "title": f"{base} Part {i + 1}"}
        for i in range(len(cuts) - 1)
    ]
    return jsonify({"segments": segs})


# ---------- transcription ----------
def words_cache_path(vid: str) -> Path:
    return TEMP / f"{vid}_words.json"


def get_whisper(model_size: str = "base.en"):
    global WHISPER_MODEL
    if WHISPER_MODEL is None or WHISPER_MODEL[0] != model_size:
        from faster_whisper import WhisperModel
        m = WhisperModel(
            model_size, device="cpu", compute_type="int8",
            download_root=str(WHISPER_CACHE),
        )
        WHISPER_MODEL = (model_size, m)
    return WHISPER_MODEL[1]


@app.route("/api/transcribe", methods=["POST"])
def start_transcribe():
    data = request.json or {}
    vid = data["id"]
    model_size = data.get("model", "base.en")

    if words_cache_path(vid).exists():
        return jsonify({"job_id": "cached", "cached": True})

    job_id = uuid.uuid4().hex[:12]
    with TRANSCRIBE_LOCK:
        TRANSCRIBE_JOBS[job_id] = {"status": "queued", "progress": 0.0, "msg": "starting"}
    threading.Thread(target=transcribe_job, args=(job_id, vid, model_size), daemon=True).start()
    return jsonify({"job_id": job_id, "cached": False})


@app.route("/api/transcribe/<job_id>")
def transcribe_status(job_id):
    if job_id == "cached":
        return jsonify({"status": "done"})
    with TRANSCRIBE_LOCK:
        return jsonify(TRANSCRIBE_JOBS.get(job_id, {"status": "unknown"}))


@app.route("/api/words/<vid>")
def get_words(vid):
    p = words_cache_path(vid)
    if not p.exists():
        return jsonify({"words": [], "ready": False})
    return jsonify({"words": json.loads(p.read_text()), "ready": True})


@app.route("/api/words/<vid>", methods=["DELETE"])
def clear_words(vid):
    p = words_cache_path(vid)
    if p.exists():
        p.unlink()
    audio = TEMP / f"{vid}.wav"
    if audio.exists():
        audio.unlink()
    return jsonify({"ok": True})


def transcribe_job(job_id: str, vid: str, model_size: str):
    def update(**kw):
        with TRANSCRIBE_LOCK:
            TRANSCRIBE_JOBS[job_id].update(kw)

    try:
        update(status="running", msg="loading model")
        src = find_source(vid)

        audio = TEMP / f"{vid}.wav"
        if not audio.exists():
            update(msg="extracting audio")
            subprocess.run(
                [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                 "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
                 "-c:a", "pcm_s16le", str(audio)],
                check=True,
            )

        update(msg="loading whisper (first run downloads ~150 MB)")
        model = get_whisper(model_size)

        update(msg="transcribing")
        meta = probe(src)
        total = meta.get("duration", 0) or 1.0

        segments, _ = model.transcribe(
            str(audio),
            word_timestamps=True,
            vad_filter=True,
            beam_size=1,
        )
        words: list[dict] = []
        for seg in segments:
            for w in (seg.words or []):
                words.append({"word": w.word.strip(), "start": float(w.start), "end": float(w.end)})
            update(progress=min(0.99, seg.end / total),
                   msg=f"transcribing {seg.end:.0f}s / {total:.0f}s")

        words_cache_path(vid).write_text(json.dumps(words))
        update(status="done", progress=1.0, msg="ready", count=len(words))
    except Exception as e:
        update(status="error", msg=str(e))


# ---------- ASS captions ----------
def hex_to_ass_color(hex_str: str) -> str:
    h = (hex_str or "#FFFFFF").lstrip("#")
    if len(h) == 3: h = "".join(c * 2 for c in h)
    h = (h + "ffffff")[:6]
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H00{b}{g}{r}".upper()


def ass_time(t: float) -> str:
    if t < 0: t = 0
    h = int(t // 3600); m = int((t % 3600) // 60); s = t - h * 3600 - m * 60
    return f"{h}:{m:02d}:{s:05.2f}"


def words_to_ass(words: list[dict], seg_start: float, seg_end: float, cap: dict) -> str:
    """Generate an ASS subtitle string. Uses absolute \\pos(x,y) for each line so
    positioning matches the draggable preview exactly. Optional pop-in via
    \\fscx/\\fscy + \\t() animation."""
    font = cap.get("font", "Inter")
    size = int(cap.get("size", 110))
    primary = hex_to_ass_color(cap.get("color", "#FFFFFF"))
    outline_color = hex_to_ass_color(cap.get("outline_color", "#000000"))
    outline_w = int(cap.get("outline", 4))
    shadow_d = int(cap.get("shadow", 2))
    bold = 1 if cap.get("bold", True) else 0
    italic = 1 if cap.get("italic", False) else 0
    cap_x = int(cap.get("caption_x", OUT_W // 2))
    cap_y = int(cap.get("caption_y", OUT_H // 2))
    wpl = max(1, int(cap.get("words_per_line", 1)))
    uppercase = bool(cap.get("uppercase", False))
    pop_in = bool(cap.get("pop_in", True))

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {OUT_W}
PlayResY: {OUT_H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{size},{primary},{outline_color},&H00000000,{bold},{italic},0,0,100,100,0,0,1,{outline_w},{shadow_d},5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    in_seg = [w for w in words if w["end"] > seg_start and w["start"] < seg_end]
    lines: list[str] = []

    def emit(text: str, start: float, end: float):
        if end - start < 0.05: end = start + 0.05
        if uppercase: text = text.upper()
        text = text.replace("\n", "\\N").replace("{", "(").replace("}", ")")
        prefix = f"\\pos({cap_x},{cap_y})"
        if pop_in:
            prefix += "\\fscx80\\fscy80\\t(0,140,\\fscx100\\fscy100)\\fad(60,0)"
        lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{{{prefix}}}{text}")

    if wpl == 1:
        for w in in_seg:
            emit(w["word"].strip(),
                 max(0.0, w["start"] - seg_start),
                 min(seg_end - seg_start, w["end"] - seg_start))
    else:
        for i in range(0, len(in_seg), wpl):
            grp = in_seg[i: i + wpl]
            if not grp: continue
            emit(" ".join(g["word"].strip() for g in grp),
                 max(0.0, grp[0]["start"] - seg_start),
                 min(seg_end - seg_start, grp[-1]["end"] - seg_start))

    return header + "\n".join(lines) + "\n"


# ---------- render ----------
@app.route("/api/render", methods=["POST"])
def start_render():
    data = request.json or {}
    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "queued",
            "done": 0, "total": len(data["segments"]),
            "current": "", "errors": [], "output_dir": "",
        }
    threading.Thread(
        target=render_job,
        args=(job_id, data["id"], data["segments"], migrate(data["settings"])),
        daemon=True,
    ).start()
    return jsonify({"job_id": job_id})


@app.route("/api/render/<job_id>")
def render_status(job_id):
    with JOBS_LOCK:
        return jsonify(JOBS.get(job_id, {"status": "unknown"}))


@app.route("/api/reveal", methods=["POST"])
def reveal():
    data = request.json or {}
    path = Path(data.get("path", str(OUTPUT)))
    if not path.exists():
        path = OUTPUT
    subprocess.Popen(["open", str(path)])
    return jsonify({"ok": True})


def render_job(job_id: str, vid: str, segments: list[dict], settings: dict):
    try:
        src = find_source(vid)
    except FileNotFoundError:
        with JOBS_LOCK:
            JOBS[job_id]["status"] = "error"
            JOBS[job_id]["errors"].append("source video missing")
        return

    src_meta = probe(src)
    src_w, src_h = src_meta["width"], src_meta["height"]

    base = settings.get("base_title", "Clip")
    out_dir = OUTPUT / safe_filename(base)
    out_dir.mkdir(parents=True, exist_ok=True)

    fg_scale = max(0.3, min(2.0, float(settings.get("fg_scale", 0.95))))
    blur = max(0.0, float(settings.get("blur", 25)))
    bg_dim = max(0.0, min(0.9, float(settings.get("bg_dim", 0.0))))

    text_size = int(settings.get("text_size", 76))
    text_color = settings.get("text_color", "white")
    text_x = int(settings.get("text_x", OUT_W // 2))
    text_y = int(settings.get("text_y", 200))
    text_box = bool(settings.get("text_box", True))
    show_title = bool(settings.get("show_title", True))

    sh = settings.get("shadow") or {}
    sh_on = bool(sh.get("enabled", True))
    sh_blur = max(1.0, float(sh.get("blur", 55)))
    sh_op = max(0.0, min(1.0, float(sh.get("opacity", 0.85))))
    sh_offx = int(sh.get("offset_x", 0))
    sh_offy = int(sh.get("offset_y", 18))

    cap = settings.get("captions") or {}
    cap_on = bool(cap.get("enabled", False))

    fg_w = int(OUT_W * fg_scale) & ~1
    fg_h = int(round(fg_w * src_h / src_w))
    if fg_h % 2: fg_h -= 1

    words: list[dict] = []
    if cap_on:
        wp = words_cache_path(vid)
        if wp.exists():
            words = json.loads(wp.read_text())

    with JOBS_LOCK:
        JOBS[job_id]["status"] = "running"
        JOBS[job_id]["output_dir"] = str(out_dir)

    for i, seg in enumerate(segments, 1):
        title = (seg.get("title") or f"{base} Part {i}").strip()
        start = float(seg["start"])
        dur = max(0.5, float(seg["end"]) - start)

        with JOBS_LOCK:
            JOBS[job_id]["current"] = title

        title_file = TEMP / f"{job_id}_{i}_title.txt"
        title_file.write_text(title, encoding="utf-8")

        ass_file: Path | None = None
        if cap_on and words:
            ass_file = TEMP / f"{job_id}_{i}.ass"
            ass_file.write_text(words_to_ass(words, start, float(seg["end"]), cap), encoding="utf-8")

        parts: list[str] = []

        bg_chain = (f"[0:v]split=2[bg][fg]; "
                    f"[bg]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,"
                    f"crop={OUT_W}:{OUT_H}")
        if blur > 0:   bg_chain += f",gblur=sigma={blur}"
        if bg_dim > 0: bg_chain += f",eq=brightness=-{bg_dim:.2f}"
        bg_chain += "[bgblur]"
        parts.append(bg_chain)

        parts.append(f"[fg]scale={fg_w}:{fg_h}[fgs]")

        if sh_on:
            sh_pad = max(int(sh_blur * 3), 20)
            parts.append(
                f"color=c=black@{sh_op:.2f}:size={fg_w}x{fg_h}:r=30:d={dur+1:.2f},"
                f"format=rgba,"
                f"pad=iw+2*{sh_pad}:ih+2*{sh_pad}:{sh_pad}:{sh_pad}:color=#00000000,"
                f"gblur=sigma={sh_blur}[shadow]"
            )
            parts.append(
                f"[bgblur][shadow]overlay="
                f"x=(W-({fg_w}+2*{sh_pad}))/2+{sh_offx}:"
                f"y=(H-({fg_h}+2*{sh_pad}))/2+{sh_offy}[bgshadow]"
            )
            bg_label = "bgshadow"
        else:
            bg_label = "bgblur"

        parts.append(
            f"[{bg_label}][fgs]overlay="
            f"x=(W-{fg_w})/2:"
            f"y=(H-{fg_h})/2[stage1]"
        )
        last = "stage1"

        if show_title:
            # text_x is intended center → drawtext x = text_x - text_w/2
            dt = (
                f"drawtext=fontfile='{FONT}':"
                f"textfile='{title_file}':"
                f"fontcolor={text_color}:"
                f"fontsize={text_size}:"
                f"x=({text_x}-text_w/2):y={text_y}"
            )
            if text_box:
                dt += ":box=1:boxcolor=black@0.45:boxborderw=24"
            parts.append(f"[{last}]{dt}[stage2]")
            last = "stage2"

        if ass_file:
            parts.append(f"[{last}]subtitles='{ass_file}':fontsdir='{BIN}'[stage3]")
            last = "stage3"

        parts.append(f"[{last}]fps=30,format=yuv420p[final]")
        filter_complex = "; ".join(parts)
        out_file = out_dir / f"{safe_filename(title)}.mp4"

        cmd = [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-ss", f"{start:.3f}", "-i", str(src),
            "-t", f"{dur:.3f}",
            "-filter_complex", filter_complex,
            "-map", "[final]", "-map", "0:a?",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            str(out_file),
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                with JOBS_LOCK:
                    JOBS[job_id]["errors"].append(f"{title}: {r.stderr.strip()[-500:]}")
        except Exception as e:
            with JOBS_LOCK:
                JOBS[job_id]["errors"].append(f"{title}: {e}")
        finally:
            for f in (title_file, ass_file):
                if f and f.exists():
                    try: f.unlink()
                    except OSError: pass

        with JOBS_LOCK:
            JOBS[job_id]["done"] = i

    with JOBS_LOCK:
        JOBS[job_id]["status"] = "done"


# ---------- presets ----------
@app.route("/api/presets", methods=["GET"])
def list_presets():
    factory = factory_presets()
    out = [{"name": n, "factory": True, "settings": s} for n, s in factory.items()]
    for f in sorted(PRESETS.glob("*.json")):
        if f.stem in factory:  # don't shadow factory names
            continue
        try:
            out.append({"name": f.stem, "factory": False, "settings": json.loads(f.read_text())})
        except Exception:
            pass
    return jsonify({"presets": out})


@app.route("/api/presets", methods=["POST"])
def save_preset_to_disk():
    data = request.json or {}
    name = safe_filename(data.get("name", "preset"))
    if name in factory_presets():
        return ("name reserved", 409)
    body = data.get("settings", {})
    (PRESETS / f"{name}.json").write_text(json.dumps(body, indent=2))
    return jsonify({"ok": True, "name": name})


@app.route("/api/presets/<name>", methods=["DELETE"])
def delete_preset(name):
    name = safe_filename(name)
    if name in factory_presets():
        return ("factory presets cannot be deleted", 409)
    p = PRESETS / f"{name}.json"
    if p.exists():
        p.unlink()
    return jsonify({"ok": True})


# ---------- main ----------
def main():
    print("[splitup] http://127.0.0.1:5005")
    try: webbrowser.open("http://127.0.0.1:5005")
    except Exception: pass
    app.run(host="127.0.0.1", port=5005, debug=False, threaded=True)


if __name__ == "__main__":
    main()
