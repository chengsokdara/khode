#!/usr/bin/env bash
# build-release.sh — official khode release builds.
#
# A plain (cross-)compile: khode bakes no secrets. Khateway auth is a
# user key or device sign-in (/login) at runtime, so every build from a
# clean checkout is a full build.
#
# Usage:
#   scripts/build-release.sh          # ./dist/khode
#   scripts/build-release.sh all      # cross-compile dist/khode-<os>-<arch>
set -euo pipefail

cd "$(dirname "$0")/.."

OUT=dist
mkdir -p "$OUT"

build() { # goos goarch output
  echo "==> building $3 (${1}/${2})"
  GOOS="$1" GOARCH="$2" CGO_ENABLED=0 go build -trimpath -o "$3" ./cmd/khode
}

if [ "${1:-}" = "all" ]; then
  for target in "darwin arm64" "darwin amd64" "linux amd64" "linux arm64"; do
    set -- $target
    build "$1" "$2" "$OUT/khode-$1-$2"
  done
else
  build "$(go env GOOS)" "$(go env GOARCH)" "$OUT/khode"
fi

echo
echo "Artifacts (sha256):"
shasum -a 256 "$OUT"/khode* | sed 's/^/  /'
