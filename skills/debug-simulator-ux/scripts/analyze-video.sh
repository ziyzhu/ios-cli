#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: analyze-video.sh <video> [output-directory]" >&2
  exit 2
fi

for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing required tool: $tool" >&2
    exit 1
  fi
done

video=$1
if [[ ! -f "$video" ]]; then
  echo "video not found: $video" >&2
  exit 1
fi

output=${2:-"${video%.*}-analysis"}
mkdir -p "$output"

ffprobe -v error \
  -show_entries format=filename,duration,size,bit_rate:stream=index,codec_name,width,height,r_frame_rate,avg_frame_rate,pix_fmt \
  -of json "$video" > "$output/metadata.json"

ffprobe -v error \
  -select_streams v:0 \
  -show_entries frame=best_effort_timestamp_time,pkt_duration_time \
  -of csv=p=0 "$video" > "$output/frame-times.csv"

ffmpeg -v error -y -i "$video" \
  -vf "fps=12,scale=240:-1,tile=6x6" \
  "$output/contact-sheet-%03d.png"

ffmpeg -v error -y -i "$video" -frames:v 1 "$output/first-frame.png"
ffmpeg -v error -y -sseof -0.05 -i "$video" -frames:v 1 "$output/last-frame.png"

printf 'analysis=%s\n' "$output"
printf 'metadata=%s\n' "$output/metadata.json"
printf 'frame_times=%s\n' "$output/frame-times.csv"
printf 'contact_sheets=%s\n' "$output/contact-sheet-*.png"
printf 'first_frame=%s\n' "$output/first-frame.png"
printf 'last_frame=%s\n' "$output/last-frame.png"
