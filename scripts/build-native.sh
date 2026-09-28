#!/bin/bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$repo_dir/native/bin"
xcrun swiftc -O -target arm64-apple-macosx13.0 \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  "$repo_dir/native/Recorder.swift" -o "$repo_dir/native/bin/kite-recorder"
xcrun clang -O2 -Wall -Wextra -Werror -target arm64-apple-macosx13.0 \
  "$repo_dir/native/Launch.c" -o "$repo_dir/native/bin/kite-launch"
# A fixed identifier instead of the linker's hash-derived one. With the
# default ad-hoc identity (-), macOS still attributes permission grants to
# the responsible app, not to these binaries; set KITE_SIGN_IDENTITY to a
# certificate for a stable signature of their own.
sign_identity="${KITE_SIGN_IDENTITY:--}"
codesign --force --sign "$sign_identity" --identifier com.kite.sprite.recorder \
  "$repo_dir/native/bin/kite-recorder"
codesign --force --sign "$sign_identity" --identifier com.kite.sprite.launch \
  "$repo_dir/native/bin/kite-launch"
