#!/bin/bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$repo_dir/native/bin"
xcrun swiftc -O -target arm64-apple-macosx13.0 \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  "$repo_dir/native/Recorder.swift" -o "$repo_dir/native/bin/kite-recorder"
