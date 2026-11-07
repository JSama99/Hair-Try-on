#!/usr/bin/env bash
# Fetch the pinned ML assets listed in assets.lock from npm and verify SHA-256.
# Usage: bash tools/fetch-assets.sh   (writes web/assets/<path>)
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
grep -v '^#' assets.lock | while read -r dest sha pkg inner _; do
  [ -z "$dest" ] && continue
  out="assets/$dest"
  if [ -f "$out" ] && echo "$sha  $out" | sha256sum -c --quiet - 2>/dev/null; then
    echo "ok      $dest"; continue
  fi
  dir="$tmp/$(echo "$pkg" | tr '/@' '__')"
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    (cd "$dir" && npm pack "$pkg" --silent >/dev/null && tar xzf ./*.tgz)
  fi
  mkdir -p "$(dirname "$out")"
  cp "$dir/package/$inner" "$out"
  if ! echo "$sha  $out" | sha256sum -c --quiet -; then
    echo "SHA-256 mismatch for $dest (from $pkg) — refusing to use an unpinned file" >&2
    rm -f "$out"; exit 1
  fi
  echo "fetched $dest"
done
