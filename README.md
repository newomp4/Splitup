# Splitup

A local desktop tool that turns a long horizontal YouTube video into a folder of vertical (1080×1920, 30 fps) short clips with a Gaussian-blurred background, a centered foreground, and an editable text title per clip.

Drag in a video, hit **Detect scenes & build segments**, edit the per-clip titles, hit **Render all** — done.

![flow](https://img.shields.io/badge/flow-drop_→_split_→_render-lightgrey?style=flat-square)
![scope](https://img.shields.io/badge/runs-local_only-lightgrey?style=flat-square)

---

## Quick start (macOS)

```bash
cd /Users/owen/Downloads/Splitup
./run.sh
```

Then open <http://127.0.0.1:5005> (the launcher opens it for you).

The first run will download `ffmpeg`, `ffprobe`, and the Inter font into `./bin/` and create a Python virtual environment in `./.venv/`. **Everything stays inside this folder** — delete the folder, delete the app. No system installs, no Homebrew, no global Python packages.

## Features

- **Drag-and-drop a horizontal video** of any length.
- **Auto-split** at scene changes, target length tunable from 15 s to 180 s.
- **Vertical 1080×1920 @ 30 fps** output.
- **Blurred background** layer (Gaussian, sigma adjustable) — fills the frame, no black bars.
- **Centered foreground** layer — same audio, scale adjustable (40 %–100 %).
- **Editable title overlay** per clip: font size, color, position (top / center / bottom), offset, optional translucent box.
- **Live preview** in the editor — slide a knob and see it update.
- **Per-segment title editing** before render. Titles default to `My Clip Part 1`, `My Clip Part 2`, ….
- **Output**: a folder named after the base title containing `My_Clip_Part_1.mp4`, `My_Clip_Part_2.mp4`, ….

## Folder layout

```
Splitup/
├── run.sh              # one-shot setup + launcher
├── requirements.txt
├── src/
│   ├── app.py          # Flask backend + ffmpeg pipeline
│   ├── templates/      # HTML
│   └── static/         # CSS + JS frontend
├── bin/                # ← downloaded ffmpeg, ffprobe, font (created on first run)
├── .venv/              # ← Python virtualenv (created on first run)
├── uploads/            # ← source videos (created on first run)
├── output/             # ← rendered clip folders
└── temp/               # scratch files
```

`bin/`, `.venv/`, `uploads/`, `output/`, and `temp/` are gitignored. Delete any of them to reclaim space — the launcher rebuilds what it needs.

---

## How it works (the technical bit, for the curious)

This is a small **local web app**: a Python backend (Flask) that drives FFmpeg, plus a plain HTML/CSS/JS frontend that runs in your browser and talks to the backend over `127.0.0.1`. Nothing leaves your machine.

### 1. Upload & probe

When you drop a video, the file is uploaded to `./uploads/` and `ffprobe` reads its metadata (width, height, fps, duration). The browser then loads the same file via `/api/source/<id>` for live preview.

### 2. Scene detection

Clicking **Detect scenes** runs FFmpeg's built-in scene-change detector:

```
ffmpeg -i input.mp4 -vf "select='gt(scene,0.35)',showinfo" -an -f null -
```

This calculates a "scene change score" between every pair of frames and reports the timestamps where that score exceeds the threshold (~0.3–0.4 works well for typical YouTube content). You get back a list like `[12.3s, 47.8s, 110.2s, ...]`.

### 3. Building segments

Given those scene timestamps and your target clip length, the backend walks forward from t=0 and, at each step, picks the scene change that falls within `[0.5×, 1.5×]` of your target length. If no scene change is in that window, it makes a hard cut at exactly the target length. This gives you natural-feeling cuts that still respect your length preference.

### 4. Live preview (browser)

The preview pane is just two `<video>` elements stacked with CSS:
- **Background**: positioned to fill, with `filter: blur(15px)` and `transform: scale(1.15)` to hide the blurred edges.
- **Foreground**: centered, sized to a percentage of the container.
- **Text overlay**: an absolutely-positioned `<div>`.

The two videos share the same source URL and a `timeupdate` listener keeps them in sync. CSS blur is approximate but visually close to FFmpeg's `gblur` — enough to make decisions about layout.

### 5. Render (FFmpeg pipeline)

Each segment becomes one FFmpeg invocation. The filter graph for one clip looks like:

```
[0:v] split=2 [bg][fg];

[bg] scale=1080:1920:force_original_aspect_ratio=increase,
     crop=1080:1920,
     gblur=sigma=25,
     eq=brightness=-0.10           [bgblur];

[fg] scale=1026:-2                 [fgs];

[bgblur][fgs] overlay=(W-w)/2:(H-h)/2,
              drawtext=fontfile='bin/Inter-Bold.ttf':
                       textfile='temp/...txt':
                       fontcolor=white:fontsize=76:
                       x=(w-text_w)/2:y=180:
                       box=1:boxcolor=black@0.45:boxborderw=24,
              fps=30,format=yuv420p
```

Translation:
- `split=2` duplicates the video into two streams (background and foreground).
- The background is **scaled to fill** the 1080×1920 frame (`force_original_aspect_ratio=increase` + `crop`), so a 1920×1080 input becomes 3413×1920 then center-cropped to 1080×1920 — no letterboxing.
- `gblur=sigma=25` is the Gaussian blur. Higher sigma = blurrier.
- The foreground is scaled to a width that's a percentage of 1080 (`-2` means "auto-pick height to keep aspect ratio, rounded to even" — H.264 needs even dimensions).
- `overlay=(W-w)/2:(H-h)/2` centers the foreground on the blurred background.
- `drawtext` puts the title on top using a bundled Inter Bold font. The title is read from a temp text file (`textfile=…`) so we don't have to escape special characters in the title.
- `fps=30,format=yuv420p` enforces 30 fps and the pixel format every player understands.

The output is encoded with libx264 (CRF 20, "medium" preset — good balance of quality and speed) and AAC audio at 192 kbps. `+faststart` puts the MOV atoms at the front so the file streams smoothly.

### 6. Progress

Renders run on a background thread. The browser polls `/api/render/<job_id>` every 800 ms and updates the progress bar segment-by-segment.

---

## Tweaking

| Knob | Where | Effect |
|---|---|---|
| Scene threshold | `src/app.py` (`/api/analyze`, `threshold` default 0.35) | Lower → more cuts, higher → fewer |
| CRF (encode quality) | `src/app.py` (`render_job`, `crf 20`) | Lower CRF = larger file, higher quality |
| Encode preset | `src/app.py` (`-preset medium`) | `ultrafast` … `veryslow` — speed vs size |
| Output dimensions | `src/app.py` (`out_w`, `out_h`) | Change for other vertical formats |

## Cleanup

To wipe everything Splitup downloaded or generated:

```bash
rm -rf .venv bin uploads output temp
```

To wipe the entire project: just delete this folder.

## Notes & limits

- macOS only out of the box (FFmpeg binaries from [evermeet.cx](https://evermeet.cx/ffmpeg/) are universal2, so they run on both Apple Silicon and Intel).
- Source video should be horizontal (16:9 or similar) — that's what the layout assumes.
- Very long inputs (1 h+) produce a lot of clips and a long encode. Each clip takes roughly 0.3–0.6× real-time to render on Apple Silicon at the default settings.

## License

MIT.
