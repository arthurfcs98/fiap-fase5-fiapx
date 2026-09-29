#!/usr/bin/env bash
# Generates the sample videos used by the tests and by the examples.
#
#   tests/fixtures/generate.sh [output-dir]   test fixtures (not versioned, see .gitignore):
#     sample-ok.mp4        5 s H.264 test pattern (320x240, 25 fps, yuv420p). The worker extracts
#                          5 frames (fps=1) and the zip has 5 PNG entries.
#     sample-corrupt.mp4   A valid MP4 "ftyp" box followed by 64 KiB of random bytes. It passes the
#                          video-api magic-bytes check (detected as video/mp4, so the upload is
#                          accepted and queued), but ffprobe cannot read it ("moov atom not found"),
#                          so the worker fails it with P0001 INVALID_VIDEO. Purely random bytes
#                          would be refused at upload (400 V0002) and never reach the worker.
#
#   tests/fixtures/generate.sh --examples     versioned examples in examples/ (each < 2 MB):
#     sample-ok-5s.mp4     5 s, 320x240  -> 5 frames
#     sample-ok-10s.mp4    10 s, 640x360 -> 10 frames
#     sample-corrupt.mp4   same recipe as above -> FAILED P0001
#
# Needs ffmpeg + ffprobe (brew install ffmpeg | apt-get install ffmpeg | apk add ffmpeg).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

examples=false
if [[ "${1:-}" == "--examples" ]]; then
  examples=true
  out_dir="$repo_root/examples"
else
  out_dir="${1:-$script_dir}"
fi

for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool not found in PATH (brew install ffmpeg | apt-get install ffmpeg)" >&2
    exit 1
  fi
done
mkdir -p "$out_dir"

# libx264 is in the Homebrew, Debian/Ubuntu and Alpine builds; mpeg4 is the built-in fallback.
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libx264 '; then
  video_codec=(-c:v libx264 -pix_fmt yuv420p)
else
  video_codec=(-c:v mpeg4 -q:v 5 -pix_fmt yuv420p)
fi

# make_video <path> <seconds> <WxH>: readable H.264 test pattern, checked with ffprobe.
make_video() {
  local target="$1" seconds="$2" size="$3" duration
  ffmpeg -hide_banner -loglevel error -nostdin -y \
    -f lavfi -i "testsrc=duration=${seconds}:size=${size}:rate=25" \
    "${video_codec[@]}" -movflags +faststart -f mp4 "$target.tmp"
  mv -f "$target.tmp" "$target"
  duration="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$target")"
  case "$duration" in
    "$seconds" | "$seconds".* | "$((seconds - 1))".9*) ;;
    *)
      echo "error: $target has an unexpected duration ($duration s, expected $seconds s)" >&2
      exit 1
      ;;
  esac
  echo "  $(basename "$target")  $(wc -c <"$target" | tr -d ' ') bytes, ${duration} s (expect ${seconds} frames)"
}

# make_corrupt <path>: MP4 signature + random bytes (accepted by the API, unreadable by ffprobe).
make_corrupt() {
  local target="$1"
  {
    # ftyp box: size 32, major brand isom, minor 512, compatible isom iso2 avc1 mp41 (octal escapes).
    printf '\000\000\000\040ftypisom\000\000\002\000isomiso2avc1mp41'
    head -c 65536 /dev/urandom
  } >"$target.tmp"
  mv -f "$target.tmp" "$target"
  if ffprobe -v quiet "$target" >/dev/null 2>&1; then
    echo "error: ffprobe was able to read $target (it must be unreadable)" >&2
    exit 1
  fi
  echo "  $(basename "$target")  $(wc -c <"$target" | tr -d ' ') bytes (expect P0001 INVALID_VIDEO)"
}

echo "videos in $out_dir:"
if $examples; then
  make_video "$out_dir/sample-ok-5s.mp4" 5 320x240
  make_video "$out_dir/sample-ok-10s.mp4" 10 640x360
else
  make_video "$out_dir/sample-ok.mp4" 5 320x240
fi
make_corrupt "$out_dir/sample-corrupt.mp4"
