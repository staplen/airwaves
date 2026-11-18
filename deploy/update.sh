#!/bin/sh
# Updates Airwaves on the Pi from GitHub. Run in the Advanced SSH & Web Terminal session:
#   sh /share/airwaves/app/deploy/update.sh
# First time (when /share/airwaves/app isn't a git checkout yet), it moves the old copy
# to /share/airwaves/app.old and clones the repo. Data and settings live outside app/.
set -eu

REPO=https://github.com/staplen/airwaves.git
APP=/share/airwaves/app            # path in the SSH session
HOST_APP=/mnt/data/supervisor/share/airwaves/app  # same folder as Docker sees it
STAMPS=/share/airwaves/.built      # remembers which version of each local image was built

command -v git >/dev/null || { echo "git is missing: run 'apk add git' first"; exit 1; }

if [ ! -d "$APP/.git" ]; then
  echo "== first run: cloning $REPO"
  [ -d "$APP" ] && rm -rf "$APP.old" && mv "$APP" "$APP.old" && echo "   (previous copy kept at $APP.old; delete it once everything works)"
  git clone --quiet "$REPO" "$APP"
else
  echo "== pulling latest"
  git -C "$APP" pull --ff-only --quiet
fi
echo "   now at $(git -C "$APP" log --oneline -1)"

echo "== building the dashboard"
docker run --rm -v "$HOST_APP:/app" -w /app node:26-alpine \
  sh -c "npm ci --no-audit --no-fund --loglevel=error && npm run build -w web --silent" >/dev/null
echo "   done"

# Rebuild a local decoder image only when its folder changed since the last build.
mkdir -p "$STAMPS"
for img in noaa hdradio; do
  tree=$(git -C "$APP" rev-parse "HEAD:deploy/$img")
  if [ "$(cat "$STAMPS/$img" 2>/dev/null)" != "$tree" ] || ! docker image inspect "airwaves-$img:local" >/dev/null 2>&1; then
    echo "== building airwaves-$img:local (this can take a few minutes)"
    docker build --quiet -t "airwaves-$img:local" "$APP/deploy/$img" >/dev/null
    echo "$tree" > "$STAMPS/$img"
  fi
done

echo "== restarting collector and scheduler"
docker restart airwaves-collector airwaves-scheduler >/dev/null
echo "== updated to $(git -C "$APP" log --oneline -1)"
