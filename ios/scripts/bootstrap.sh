#!/usr/bin/env bash
# One-time setup on a Mac: models, Xcode project (XcodeGen), pods (run by XcodeGen's postGenCommand).
set -euo pipefail
cd "$(dirname "$0")/.."
command -v xcodegen >/dev/null || { echo "Install XcodeGen: brew install xcodegen" >&2; exit 1; }
command -v pod >/dev/null || { echo "Install CocoaPods: brew install cocoapods" >&2; exit 1; }
bash scripts/fetch-models.sh
xcodegen generate
echo "Open HairTryOn.xcworkspace, set your signing team, and run on an iPhone with a TrueDepth camera."
