#!/usr/bin/env bash
# Verifies a packaged build: signature, Gatekeeper, plist sanity, and that the
# bundled ffmpeg/ffprobe/7za actually execute. The last one is the single
# most common breakage in this class of app (asar-packed binaries can't be
# exec'd; a dropped executable bit silently produces "cannot open").
set -euo pipefail

APP_PATH="${1:-release/mac-arm64/File Warper.app}"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

[ -d "$APP_PATH" ] || fail "app bundle not found at: $APP_PATH (run \`npm run dist\` first)"

echo "== codesign --verify =="
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo "== spctl --assess (expected to warn 'unsigned' for an ad-hoc build; must not report 'damaged') =="
if spctl --assess --type execute --verbose "$APP_PATH" 2>&1 | tee /tmp/filewarper-spctl.out; then
  echo "spctl accepted the app."
else
  if grep -qi 'damaged' /tmp/filewarper-spctl.out; then
    fail "Gatekeeper reports the app as damaged — check electron-builder.yml mac.identity is '-' (not null)."
  fi
  echo "spctl rejected as unsigned/unnotarized, which is expected for an ad-hoc build."
fi

PLIST="$APP_PATH/Contents/Info.plist"
echo "== plutil -lint =="
plutil -lint "$PLIST" || fail "Info.plist failed plutil -lint"

echo "== CFBundleDocumentTypes present =="
plutil -extract CFBundleDocumentTypes xml1 -o - "$PLIST" >/dev/null 2>&1 \
  || fail "CFBundleDocumentTypes missing from Info.plist — Finder 'Open With' won't offer this app"

BIN_DIR="$APP_PATH/Contents/Resources/bin"
echo "== bundled binaries are present, executable, and run =="
for name in ffmpeg ffprobe 7za; do
  bin="$BIN_DIR/$name"
  [ -e "$bin" ] || fail "$name missing from $BIN_DIR — did \`npm run vendor\` run before packaging?"
  [ -x "$bin" ] || fail "$name is not executable at $bin"
done

"$BIN_DIR/ffmpeg" -version >/dev/null 2>&1 || fail "bundled ffmpeg failed to run"
"$BIN_DIR/ffprobe" -version >/dev/null 2>&1 || fail "bundled ffprobe failed to run"
"$BIN_DIR/7za" >/dev/null 2>&1 || fail "bundled 7za failed to run"

echo "OK: $APP_PATH passed all checks."
