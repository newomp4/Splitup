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

mkdir -p "$BIN" "$ROOT/uploads" "$ROOT/output" "$ROOT/temp"

# 1. Python venv (kept inside project dir)
if [ ! -d "$VENV" ]; then
  echo "[setup] creating Python venv in .venv ..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip --quiet
  "$VENV/bin/pip" install -r requirements.txt --quiet
fi

# 2. ffmpeg + ffprobe (universal macOS binaries from evermeet.cx)
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

# 3. Bundled font for the text overlay (Inter Bold, free OFL license)
if [ ! -f "$FONT" ]; then
  echo "[setup] downloading font ..."
  curl -fL --silent --show-error \
    "https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-700-normal.ttf" \
    -o "$FONT"
fi

# 4. Run
echo "[run] launching Splitup at http://127.0.0.1:5005"
exec "$VENV/bin/python" -m src.app
