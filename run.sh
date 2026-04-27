#!/usr/bin/env bash
# Splitup launcher — sets up everything inside the project folder, then runs.
set -e
cd "$(dirname "$0")"

ROOT="$(pwd)"
VENV="$ROOT/.venv"
BIN="$ROOT/bin"
FFMPEG="$BIN/ffmpeg"
FFPROBE="$BIN/ffprobe"
FONT="$BIN/Inter-Bold.ttf"
WHISPER_CACHE="$BIN/whisper-cache"

mkdir -p "$BIN" "$WHISPER_CACHE" "$ROOT/uploads" "$ROOT/output" "$ROOT/temp" "$ROOT/presets"

# 1. Python venv
if [ ! -d "$VENV" ]; then
  echo "[setup] creating Python venv in .venv ..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip --quiet
fi

# Always reconcile deps — cheap if up to date
"$VENV/bin/pip" install -q -r requirements.txt

# 2. ffmpeg + ffprobe (universal macOS binaries)
if [ ! -x "$FFMPEG" ]; then
  echo "[setup] downloading ffmpeg ..."
  curl -fL --silent --show-error "https://evermeet.cx/ffmpeg/getrelease/zip" -o "$BIN/ffmpeg.zip"
  unzip -q -o "$BIN/ffmpeg.zip" -d "$BIN/"
  rm -f "$BIN/ffmpeg.zip"
  chmod +x "$FFMPEG"
fi

if [ ! -x "$FFPROBE" ]; then
  echo "[setup] downloading ffprobe ..."
  curl -fL --silent --show-error "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" -o "$BIN/ffprobe.zip"
  unzip -q -o "$BIN/ffprobe.zip" -d "$BIN/"
  rm -f "$BIN/ffprobe.zip"
  chmod +x "$FFPROBE"
fi

# 3. Bundled font
if [ ! -f "$FONT" ]; then
  echo "[setup] downloading font ..."
  curl -fL --silent --show-error \
    "https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-700-normal.ttf" \
    -o "$FONT"
fi

# 4. Run — point HuggingFace cache into project folder so model files stay contained
export HF_HOME="$WHISPER_CACHE"
export XDG_CACHE_HOME="$WHISPER_CACHE"

echo "[run] launching Splitup at http://127.0.0.1:5005"
exec "$VENV/bin/python" -m src.app
