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
- **Centered foreground** layer, same audio. Scale **40 %–200 %**, so you can also crop *past* the edges if you want a bigger framing.
- **Drop shadow** under the foreground — adjustable blur, opacity, X / Y offset.
- **Editable title overlay** per clip: size, color, position (top / center / bottom), offset, optional translucent box. *What you see in the preview is the size that renders.*
- **Word-by-word burned captions** (one-word style by default, or N words per line) using a local [faster-whisper](https://github.com/SYSTRAN/faster-whisper) Whisper model. Models are cached in `./bin/whisper-cache/`. Full styling: font size, color, outline color + width, shadow depth, position, vertical margin, bold, UPPERCASE.
- **Live preview** of every setting (CSS-based — sliders update instantly). Caption preview shows the active word in real time as the video plays.
- **Presets**: save your current settings to a local preset (lives in `./presets/`), or export as portable JSON for sharing or use in other programs. Last settings auto-restored on next launch.
- **Per-segment title editing** before render. Titles default to `My Clip Part 1`, `My Clip Part 2`, …
- **Output**: a folder named after the base title containing `My_Clip_Part_1.mp4`, `My_Clip_Part_2.mp4`, ….

## Folder layout

```
Splitup/
├── run.sh              # one-shot setup + launcher
├── requirements.txt
├── src/
│   ├── app.py          # Flask backend + ffmpeg pipeline + transcription
│   ├── templates/      # HTML
│   └── static/         # CSS + JS frontend
├── bin/
│   ├── ffmpeg, ffprobe, Inter-Bold.ttf
│   └── whisper-cache/  # ← Whisper model files live here
├── .venv/              # ← Python virtualenv
├── uploads/            # ← source videos
├── output/             # ← rendered clip folders
├── presets/            # ← saved JSON presets
└── temp/               # scratch files (transcripts cached here as <id>_words.json)
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

### 5. Captions (Whisper)

When captions are enabled, clicking **Transcribe** runs the audio through `faster-whisper` locally — it's a CTranslate2 port of OpenAI's Whisper, fast on CPU thanks to int8 quantization. The model file (default `base.en`, ~150 MB) is downloaded the first time and cached in `./bin/whisper-cache/`. The result is a list of `{word, start, end}` records, cached as JSON in `./temp/<video_id>_words.json` so re-renders are instant.

At render time, for each segment, the relevant words are written into a generated **ASS subtitle file** with timestamps re-based to start at zero (because each clip is rendered with `-ss segment_start`). FFmpeg's `subtitles=` filter (libass) burns them into the video.

The live caption preview in the browser is the same logic in JavaScript: a `timeupdate` listener finds which word's `[start, end]` range contains the current playback time and renders it on top of the preview with the user's chosen styling (CSS `text-shadow` is used to approximate the libass outline).

### 6. Drop shadow

The drop shadow under the foreground video is a small filter trick. We can't directly blur the alpha edge of the scaled foreground (that would soften the video too), so instead we synthesize a separate "shadow plate":

```
color=c=black@0.7:size=FG_W x FG_H:r=30:d=DUR,
format=rgba,
pad=iw+2*P:ih+2*P:P:P:color=#00000000,
gblur=sigma=BLUR
```

— a black rectangle the size of the foreground, padded with transparent margin, then Gaussian-blurred so the dark color spreads into the transparent area. The padded transparent margin gives the blur somewhere to fade *into*; without it, the blur just smears within the box and you don't get a soft edge. This shadow plate is overlaid first, then the (sharp) foreground is overlaid on top.

### 7. Render (FFmpeg pipeline)

Each segment becomes one FFmpeg invocation. With everything turned on, the filter graph for one clip looks roughly like:

```
[0:v] split=2 [bg][fg];

[bg]  scale=1080:1920:force_original_aspect_ratio=increase,
      crop=1080:1920,
      gblur=sigma=25                 [bgblur];

[fg]  scale=1026:576                  [fgs];

color=c=black@0.7:size=1026x576:r=30:d=N,format=rgba,
      pad=iw+90:ih+90:45:45:color=#00000000,
      gblur=sigma=30                 [shadow];

[bgblur][shadow]  overlay=...        [bgshadow];
[bgshadow][fgs]   overlay=...        [stage1];

[stage1] drawtext=fontfile='bin/Inter-Bold.ttf':textfile=...
         :fontcolor=white:fontsize=76:x=...:y=...
                                      [stage2];

[stage2] subtitles='temp/seg.ass':fontsdir='bin'
                                      [stage3];

[stage3] fps=30,format=yuv420p        [final]
```

Output is encoded with libx264 (CRF 20, "medium" preset) and AAC audio at 192 kbps. `+faststart` moves the MP4 metadata atoms to the start so the file plays as soon as it begins downloading.

### 8. Presets (JSON)

A preset is a JSON snapshot of every visual setting (foreground scale, blur, dim, title, drop shadow, captions, …). You can save them locally (`/api/presets`, written to `./presets/<name>.json`) or download as a portable file. Importing a JSON file just re-applies all settings into the form.

### 9. Progress

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

To wipe everything Splitup downloaded or generated (including the Whisper model):

```bash
rm -rf .venv bin uploads output temp presets
```

To wipe the entire project: just delete this folder.

## Notes & limits

- macOS only out of the box (FFmpeg binaries from [evermeet.cx](https://evermeet.cx/ffmpeg/) are universal2, so they run on both Apple Silicon and Intel).
- Source video should be horizontal (16:9 or similar) — that's what the layout assumes.
- Very long inputs (1 h+) produce a lot of clips and a long encode. Each clip takes roughly 0.3–0.6× real-time to render on Apple Silicon at the default settings.

## License

MIT.
