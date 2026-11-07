#!/usr/bin/env bash
# Fetch the pinned segmentation models into App/Resources/Models, verifying SHA-256.
# Google's "latest" URL first; if it is unreachable or its bytes differ from the pin, the
# byte-identical npm copy. Never installs an unpinned file.
set -euo pipefail
cd "$(dirname "$0")/.."
# shasum on macOS, sha256sum on Linux CI
if command -v shasum >/dev/null; then check() { shasum -a 256 -c --status -; }; else check() { sha256sum -c --status -; }; fi
dir=App/Resources/Models
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
grep -v '^#' "$dir/models.lock" | while read -r file sha url npm; do
  [ -z "$file" ] && continue
  out="$dir/$file"
  if [ -f "$out" ] && echo "$sha  $out" | check 2>/dev/null; then echo "ok       $file"; continue; fi
  if curl -fsSL "$url" -o "$tmp/$file" 2>/dev/null && echo "$sha  $tmp/$file" | check; then
    mv "$tmp/$file" "$out"; echo "google   $file"; continue
  fi
  echo "note     $file: Google's copy is unreachable or differs from the pin; using the pinned npm copy" >&2
  pkg="${npm%%:*}"; inner="${npm#*:}"
  (cd "$tmp" && npm pack "$pkg" --silent >/dev/null && tar xzf ./*.tgz)
  cp "$tmp/package/$inner" "$tmp/$file"
  echo "$sha  $tmp/$file" | check || { echo "SHA-256 mismatch for $file from $pkg" >&2; exit 1; }
  mv "$tmp/$file" "$out"; rm -rf "$tmp/package" "$tmp"/*.tgz; echo "npm      $file"
done
