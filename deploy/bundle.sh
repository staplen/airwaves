#!/bin/bash
# Builds the dashboard and packs everything the Pi needs into deploy/out/airwaves.tgz.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build -w web >/dev/null
mkdir -p deploy/out
tar -czf deploy/out/airwaves.tgz \
  --exclude node_modules --exclude 'collector/data' --exclude 'deploy/out' --exclude .git --exclude '.claude' \
  package.json package-lock.json shared collector scheduler web/package.json web/dist deploy/noaa deploy/airwaves.env.example
echo "deploy/out/airwaves.tgz ($(du -h deploy/out/airwaves.tgz | cut -f1))"
