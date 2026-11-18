#!/bin/sh
# Updates Airwaves on the Pi from GitHub. Run in the Advanced SSH & Web Terminal session:
#   sh /share/airwaves/app/deploy/update.sh
# It also creates any missing folders and recreates the collector and scheduler, so new
# settings in /share/airwaves/airwaves.env take effect.
# First time (when /share/airwaves/app isn't a git checkout yet), it moves the old copy
# to /share/airwaves/app.old and clones the repo. Data and settings live outside app/.
set -eu

# Everything runs inside main(), which the shell reads in full before running anything.
# That matters because this script updates itself with git pull partway through.
main() {

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

mkdir -p /share/airwaves/data /share/airwaves/spectrum /share/airwaves/readsb /share/airwaves/hdradio/aas \
  /share/airwaves/sonde/log /media/airwaves/atc /media/airwaves/noaa /media/airwaves/radio
[ -f /share/airwaves/sonde/station.cfg ] || cp "$APP/deploy/sonde/station.cfg" /share/airwaves/sonde/station.cfg

echo "== installing packages and building the dashboard"
# Install once here (full install to build, then prune to runtime packages), so the collector and
# scheduler containers never run npm themselves: two installs in the same folder at once corrupt it.
docker run --rm -v "$HOST_APP:/app" -w /app node:26-alpine \
  sh -c "npm ci --no-audit --no-fund --loglevel=error && npm run build -w web --silent && npm prune --omit=dev --no-audit --no-fund --loglevel=error" >/dev/null
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

# Recreate (not just restart) so changes to airwaves.env are picked up.
echo "== recreating collector and scheduler"
ENVFILE=/share/airwaves/airwaves.env
SHARE=/mnt/data/supervisor/share/airwaves
MEDIA=/mnt/data/supervisor/media/airwaves
docker stop airwaves-scheduler >/dev/null 2>&1 || true  # graceful: frees the dongle
docker rm -f airwaves-collector airwaves-scheduler >/dev/null 2>&1 || true
docker run -d --name airwaves-collector --restart unless-stopped --network host --env-file "$ENVFILE" \
  -e PORT=8090 -e ADSB_URL=http://127.0.0.1:8080/data -e CLIPS_ROOT=/clips \
  -e DATA_DIR=/airwaves/data -e WEB_DIR=/airwaves/app/web/dist \
  -v "$SHARE:/airwaves" -v "$MEDIA:/clips" -w /airwaves/app node:26-alpine \
  node collector/src/index.ts >/dev/null
docker run -d --name airwaves-scheduler --restart unless-stopped --network host --env-file "$ENVFILE" \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$SHARE:/airwaves" -w /airwaves/app node:26-alpine \
  node scheduler/src/index.ts >/dev/null
echo "== updated to $(git -C "$APP" log --oneline -1)"
}

main "$@"
exit
