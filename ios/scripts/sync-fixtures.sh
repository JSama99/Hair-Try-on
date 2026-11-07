#!/usr/bin/env bash
# Regenerate HairKit's cross-language fixtures from the web build (canonical face, head-fit expectations).
set -euo pipefail
cd "$(dirname "$0")/../../web"
node tools/make-canonical-face.mjs
node --input-type=module -e "
import {FACE_VERTICES} from './src/canonical-face.js';
import {fitHead} from './src/headfit.js';
import {writeFileSync} from 'fs';
const out={mediapipe:fitHead(FACE_VERTICES).toJSON(), arkit:fitHead(FACE_VERTICES,{preset:'arkit'}).toJSON(), calibrated:fitHead(FACE_VERTICES,{hairline:{hairline_front:1.05}}).toJSON(),
 note:'Expected HeadFitter output for the canonical face, written by ios/scripts/sync-fixtures.sh. Swift must match within 1e-12.'};
writeFileSync('../ios/Packages/HairKit/Tests/Fixtures/headfit_expected.json', JSON.stringify(out,null,1)+'\n');"
echo "fixtures synced"
