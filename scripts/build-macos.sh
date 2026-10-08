#!/usr/bin/env bash
set -euo pipefail

# Builds a separate bundle only. Never installs or replaces the private Yunus OS app.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'The optional native shell must be built on macOS.' >&2
  exit 1
fi
command -v swiftc >/dev/null || { echo 'Install Xcode command line tools first.' >&2; exit 1; }
[[ -f "$ROOT/server.mjs" ]] || { echo 'Build requires the full community source checkout.' >&2; exit 1; }
mkdir -p "$ROOT/dist"
DEST="$ROOT/dist/Yunus OS Community.app"
if [[ -e "$DEST" ]]; then
  echo 'A previous dist bundle exists; move it aside before building again.' >&2
  exit 1
fi
WORK="$(mktemp -d "$ROOT/dist/.native-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/Yunus OS Community.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
swiftc -O -target "$(uname -m)-apple-macosx13.0" \
  "$ROOT/native/YunusOSCommunity.swift" -o "$APP/Contents/MacOS/YunusOSCommunity" \
  -framework Cocoa -framework WebKit -framework AVFoundation

# Explicit distribution allowlist. No config, runtime state, credentials or private data.
for FILE in server.mjs fixtures.mjs index.html package.json LICENSE README.md SECURITY.md; do
  [[ ! -f "$ROOT/$FILE" ]] || cp "$ROOT/$FILE" "$APP/Contents/Resources/app/$FILE"
done
for DIRECTORY in lib js css assets; do
  [[ ! -d "$ROOT/$DIRECTORY" ]] || cp -R "$ROOT/$DIRECTORY" "$APP/Contents/Resources/app/$DIRECTORY"
done
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Yunus OS Community</string>
  <key>CFBundleDisplayName</key><string>Yunus OS Community</string>
  <key>CFBundleIdentifier</key><string>io.github.yunusos.community</string>
  <key>CFBundleExecutable</key><string>YunusOSCommunity</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Record your voice when you choose to use local Whisper transcription.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --sign - "$APP"
mv "$APP" "$DEST"
echo "Built: $DEST"
echo 'Unsigned for distribution (ad-hoc signature only). Requires Node.js 22+. No installation performed.'
