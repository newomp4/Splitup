"""Splitup — local Flask app that turns a long horizontal video into a folder
of vertical 1080x1920 clips with a Gaussian-blurred background, a centered
foreground, and an editable text overlay per clip.

Everything self-contained inside the project folder (./bin, ./.venv, ./uploads,
./output, ./temp). Delete the folder = delete the app.
"""
from __future__ import annotations

import json
import re
import subprocess
import threading
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file, send_from_directory

# ---------- paths ----------
ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "bin"
UPLOADS = ROOT / "uploads"
OUTPUT = ROOT / "output"
TEMP = ROOT / "temp"

FFMPEG = str(BIN / "ffmpeg")
FFPROBE = str(BIN / "ffprobe")
FONT = str(BIN / "Inter-Bold.ttf")

for d in (UPLOADS, OUTPUT, TEMP):
    d.mkdir(parents=True, exist_ok=True)

# ---------- app ----------
app = Flask(
    __name__,
    template_folder=str(ROOT / "src" / "templates"),
    static_folder=str(ROOT / "src" / "static"),
)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024 * 1024  # 10 GB cap

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()


# ---------- helpers ----------
def find_source(vid: str) -> Path:
    for f in UPLOADS.iterdir():
        if f.stem == vid:
            return f
    raise FileNotFoundError(vid)


def probe(path: Path) -> dict:
    """Return width, height, fps, duration via ffprobe."""
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
    """Greedy splitter. Walks from 0; at each step picks the scene change in
    [0.5x, 1.5x] of target ahead, otherwise hard-cuts at exactly target."""
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
    # drop a tiny tail
    if len(cuts) >= 2 and (cuts[-1] - cuts[-2]) < max(2.0, target * 0.1):
        cuts[-2] = cuts[-1]
        cuts.pop()
    return cuts


# ---------- routes ----------
@app.route("/")
def index():
    return render_template("index.html")


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
    """Run ffmpeg's scene detection. Returns timestamps of likely cut points."""
    data = request.json or {}
    vid = data["id"]
    threshold = float(data.get("threshold", 0.35))
    src = find_source(vid)

    cmd = [
        FFMPEG, "-hide_banner",
        "-i", str(src),
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


@app.route("/api/render", methods=["POST"])
def start_render():
    data = request.json or {}
    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "queued",
            "done": 0,
            "total": len(data["segments"]),
            "current": "",
            "errors": [],
            "output_dir": "",
        }
    threading.Thread(
        target=render_job,
        args=(job_id, data["id"], data["segments"], data["settings"]),
        daemon=True,
    ).start()
    return jsonify({"job_id": job_id})


@app.route("/api/render/<job_id>")
def render_status(job_id):
    with JOBS_LOCK:
        return jsonify(JOBS.get(job_id, {"status": "unknown"}))


@app.route("/api/reveal", methods=["POST"])
def reveal():
    """Open Finder at the output folder."""
    data = request.json or {}
    path = Path(data.get("path", str(OUTPUT)))
    if not path.exists():
        path = OUTPUT
    subprocess.Popen(["open", str(path)])
    return jsonify({"ok": True})


# ---------- render ----------
def render_job(job_id: str, vid: str, segments: list[dict], settings: dict):
    """Render one clip per segment using a single ffmpeg invocation each.
    Filter chain:
      input -> split -> [bg: scale-to-fill, crop, gaussian blur]
                     -> [fg: scale to fg_scale * 1080 width]
      overlay fg centered, then drawtext for the title.
    """
    try:
        src = find_source(vid)
    except FileNotFoundError:
        with JOBS_LOCK:
            JOBS[job_id]["status"] = "error"
            JOBS[job_id]["errors"].append("source video missing")
        return

    base = settings.get("base_title", "Clip")
    out_dir = OUTPUT / safe_filename(base)
    out_dir.mkdir(parents=True, exist_ok=True)

    fg_scale = max(0.3, min(1.0, float(settings.get("fg_scale", 0.95))))
    blur = max(0.0, float(settings.get("blur", 25)))
    bg_dim = max(0.0, min(0.9, float(settings.get("bg_dim", 0.0))))
    text_size = int(settings.get("text_size", 76))
    text_color = settings.get("text_color", "white")
    text_pos = settings.get("text_pos", "top")  # top | center | bottom
    text_offset = int(settings.get("text_offset", 180))
    text_box = bool(settings.get("text_box", True))

    out_w, out_h = 1080, 1920
    fg_w = int(out_w * fg_scale) & ~1  # round to even

    if text_pos == "top":
        ty = f"{text_offset}"
    elif text_pos == "bottom":
        ty = f"h-text_h-{text_offset}"
    else:
        ty = "(h-text_h)/2"

    with JOBS_LOCK:
        JOBS[job_id]["status"] = "running"
        JOBS[job_id]["output_dir"] = str(out_dir)

    for i, seg in enumerate(segments, 1):
        title = (seg.get("title") or f"{base} Part {i}").strip()
        start = float(seg["start"])
        dur = max(0.5, float(seg["end"]) - start)

        with JOBS_LOCK:
            JOBS[job_id]["current"] = title

        # textfile= avoids drawtext escaping pain entirely
        text_file = TEMP / f"{job_id}_{i}.txt"
        text_file.write_text(title, encoding="utf-8")

        bg_chain = (
            f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{out_h}"
        )
        if blur > 0:
            bg_chain += f",gblur=sigma={blur}"
        if bg_dim > 0:
            bg_chain += f",eq=brightness=-{bg_dim:.2f}"

        drawtext = (
            f"drawtext=fontfile='{FONT}':"
            f"textfile='{text_file}':"
            f"reload=0:"
            f"fontcolor={text_color}:"
            f"fontsize={text_size}:"
            f"x=(w-text_w)/2:y={ty}"
        )
        if text_box:
            drawtext += ":box=1:boxcolor=black@0.45:boxborderw=24"

        filter_complex = (
            f"[0:v]split=2[bg][fg];"
            f"[bg]{bg_chain}[bgblur];"
            f"[fg]scale={fg_w}:-2[fgs];"
            f"[bgblur][fgs]overlay=(W-w)/2:(H-h)/2,"
            f"{drawtext},"
            f"fps=30,format=yuv420p"
        )

        out_file = out_dir / f"{safe_filename(title)}.mp4"
        cmd = [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-ss", f"{start:.3f}", "-i", str(src),
            "-t", f"{dur:.3f}",
            "-filter_complex", filter_complex,
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            str(out_file),
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                with JOBS_LOCK:
                    JOBS[job_id]["errors"].append(
                        f"{title}: {r.stderr.strip()[-400:]}"
                    )
        except Exception as e:
            with JOBS_LOCK:
                JOBS[job_id]["errors"].append(f"{title}: {e}")
        finally:
            try:
                text_file.unlink()
            except OSError:
                pass

        with JOBS_LOCK:
            JOBS[job_id]["done"] = i

    with JOBS_LOCK:
        JOBS[job_id]["status"] = "done"


# ---------- main ----------
def main():
    print("[splitup] http://127.0.0.1:5005")
    try:
        webbrowser.open("http://127.0.0.1:5005")
    except Exception:
        pass
    app.run(host="127.0.0.1", port=5005, debug=False, threaded=True)


if __name__ == "__main__":
    main()
