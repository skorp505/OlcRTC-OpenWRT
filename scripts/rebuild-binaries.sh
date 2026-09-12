#!/usr/bin/env bash
# Rebuild olcrtc-linux-{amd64,arm64} binaries from upstream master.
# Used by .github/workflows/build-binaries.yml; can also run locally:
#   bash scripts/rebuild-binaries.sh <upstream-dir> <panel-dir>
set -euo pipefail

UPSTREAM="${1:-}"
PANEL="${2:-}"
[ -n "$UPSTREAM" ] && [ -n "$PANEL" ] || { echo "usage: rebuild-binaries.sh <upstream-dir> <panel-dir>" >&2; exit 2; }

command -v go >/dev/null 2>&1 || { echo "go not found" >&2; exit 2; }

[ -f "$UPSTREAM/go.mod" ] || { echo "missing $UPSTREAM/go.mod" >&2; exit 2; }
[ -f "$PANEL/panel-version" ] || { echo "missing $PANEL/panel-version" >&2; exit 2; }

UPSTREAM_SHA="$(git -C "$UPSTREAM" rev-parse HEAD)"
LAST_SHA="$(cat "$PANEL/.upstream-sha" 2>/dev/null || echo "")"

echo "upstream HEAD: $UPSTREAM_SHA"
echo "last built:    ${LAST_SHA:-<none>}"

if [ "$UPSTREAM_SHA" = "$LAST_SHA" ]; then
	echo "NO_CHANGE=1"
	exit 0
fi

echo "rebuilding binaries from upstream $UPSTREAM_SHA..."

cd "$UPSTREAM"
go mod download

echo "building linux/amd64..."
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$PANEL/olcrtc-linux-amd64" ./cmd/olcrtc
echo "building linux/arm64..."
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$PANEL/olcrtc-linux-arm64" ./cmd/olcrtc

echo "syncing names/surnames dictionaries..."
cp "$UPSTREAM/internal/names/data/names" "$PANEL/files/etc/olcrtc/data/names"
cp "$UPSTREAM/internal/names/data/surnames" "$PANEL/files/etc/olcrtc/data/surnames"

echo "NO_CHANGE=0"
exit 0