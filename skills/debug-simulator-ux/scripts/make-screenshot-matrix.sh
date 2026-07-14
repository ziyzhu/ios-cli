#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "usage: make-screenshot-matrix.sh <output.png> <columns> <image> <image> [...]" >&2
  exit 2
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "missing required tool: magick" >&2
  exit 1
fi

output=$1
columns=$2
shift 2

if ! [[ $columns =~ ^[1-9][0-9]*$ ]]; then
  echo "columns must be a positive integer" >&2
  exit 2
fi

for image in "$@"; do
  if [[ ! -f $image ]]; then
    echo "image not found: $image" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$output")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cells=()
index=0
for image in "$@"; do
  cell=$(printf '%s/cell-%03d.png' "$work" "$index")
  magick "$image" -thumbnail '241x524>' -background white -gravity center -extent 261x544 "$cell"
  cells+=("$cell")
  index=$((index + 1))
done

remainder=$((index % columns))
if (( remainder != 0 )); then
  missing=$((columns - remainder))
  for ((i = 0; i < missing; i++)); do
    cell=$(printf '%s/cell-%03d.png' "$work" "$index")
    magick -size 261x544 canvas:white "$cell"
    cells+=("$cell")
    index=$((index + 1))
  done
fi

rows=()
row=0
for ((start = 0; start < index; start += columns)); do
  row_file=$(printf '%s/row-%03d.png' "$work" "$row")
  magick "${cells[@]:start:columns}" +append "$row_file"
  rows+=("$row_file")
  row=$((row + 1))
done

magick "${rows[@]}" -append "$output"
printf 'matrix=%s\n' "$output"
