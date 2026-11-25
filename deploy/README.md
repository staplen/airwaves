# Running Airwaves on the Pi (Home Assistant OS)

Everything runs as plain Docker containers next to Home Assistant, the same way
Ultrafeeder does. Run these in the Advanced SSH & Web Terminal session.

Home Assistant OS path mapping (the SSH session runs in its own container):

| In SSH     | On the host (for `docker run -v`) |
|------------|-----------------------------------|
| `/share`   | `/mnt/data/supervisor/share`      |
| `/media`   | `/mnt/data/supervisor/media`      |

1. **MQTT login.** Mosquitto broker add-on → Configuration → `logins`: add
   `username: airwaves` with a password. Save and restart the add-on.
2. **Code.** `git clone https://github.com/staplen/airwaves.git /share/airwaves/app`
   (install git first with `apk add git` if the SSH add-on lacks it).
3. **Settings.**
   `cp /share/airwaves/app/deploy/airwaves.env.example /share/airwaves/airwaves.env` and fill in
   `MQTT_PASS`, `HOME_LAT`/`HOME_LON` (receiver location, used only on the Pi) and `HD_STATIONS`.
   Optionally set `PUBLIC_HOME_LAT`/`PUBLIC_HOME_LON` (where the public site draws the receiver), `GAS_METER_ID`, and
   `HOME_ELEV_FT` (ground elevation in feet, so "What was that?" gives heights above you).
4. **Build** the dashboard and local decoder images: `sh /share/airwaves/app/deploy/update.sh`.
   It also creates the data and audio folders under `/share/airwaves` and `/media/airwaves`, and copies
   `deploy/sonde/station.cfg` (uploads disabled) into place. The first run of the HD Radio image
   compiles nrsc5 and takes several minutes on a Pi 4.
5. **Collector + dashboard** on port 8090:

   ```bash
   docker run -d --name airwaves-collector --restart unless-stopped --network host \
     --env-file /share/airwaves/airwaves.env \
     -e PORT=8090 -e ADSB_URL=http://127.0.0.1:8080/data -e CLIPS_ROOT=/clips \
     -e DATA_DIR=/airwaves/data -e WEB_DIR=/airwaves/app/web/dist \
     -v /mnt/data/supervisor/share/airwaves:/airwaves \
     -v /mnt/data/supervisor/media/airwaves:/clips \
     -w /airwaves/app node:26-alpine \
     node collector/src/index.ts
   ```

6. **Scheduler** (owns the dongle; needs the Docker socket to start and stop decoders):

   ```bash
   docker run -d --name airwaves-scheduler --restart unless-stopped --network host \
     --env-file /share/airwaves/airwaves.env \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -v /mnt/data/supervisor/share/airwaves:/airwaves \
     -w /airwaves/app node:26-alpine \
     node scheduler/src/index.ts
   ```

**Updating:** `sh /share/airwaves/app/deploy/update.sh` pulls from GitHub, rebuilds the dashboard,
rebuilds a local decoder image only if its `deploy/` folder changed, and restarts the collector and
scheduler. (`deploy/bundle.sh` still makes a tarball if you ever need to update without GitHub.)

**ADS-B** runs as a light `readsb` slot that writes JSON to `/share/airwaves/readsb`; the collector
reads those files and falls back to Ultrafeeder's port 8080 if they're missing. Ultrafeeder is the
"standby" container: the scheduler stops it at start and starts it again when the scheduler stops.

Storage stays bounded: the collector deletes audio clips (ATC, NOAA, rail radio, HD Radio) after 24 hours, folds
each spectrum sweep into the database and deletes the CSV, and keeps 7 days of feed,
daily counts and spectrum in SQLite; HD Radio album art is also deleted after 24 hours.

To pause the rotation and go back to plain ADS-B: `docker stop airwaves-scheduler`
(it restarts Ultrafeeder on the way out).

## Public copy (nicostaple.com/airwaves)

Set `PUBLISH_HOST`, `PUBLISH_USER` and `PUBLISH_PASS` in `airwaves.env` (see the commented
`PUBLISH_*` lines in `airwaves.env.example`) and restart the collector. It then keeps one SFTP
connection to the web host and, every `PUBLISH_EVERY_SEC` (60 s), uploads a read-only copy:

- **Dashboard:** on start it compares a hash of `web/dist/index.html` with `version.txt` on the
  server and uploads the whole build (assets first, `index.html` last) plus an `.htaccess` only when
  it changed. Run `update.sh` as usual and the next collector restart publishes the new build.
- **Data:** `data/snapshot.json`, `data/feed.json` (last 100 items), `data/overlays.json`, and
  `data/spectrum.json` every 10 minutes. Each file is uploaded as `<name>.tmp` and renamed, so
  visitors never see a partial file. The page polls them every 30 s and shows "Last updated N min
  ago" if the copy stops updating.
- **Media:** clips, album art and map tiles referenced by the data are uploaded to `clips/`, `art/`
  and `maps/`. Remote files older than 24 hours are deleted every 10 minutes.
- **Always the public view:** no distances and never the real home location, whatever the local dashboard
  shows. The receiver is drawn at `PUBLIC_HOME_LAT`/`PUBLIC_HOME_LON` if set, otherwise at the real location
  snapped to a ~5 km grid and moved by a fixed secret offset.
- Network errors are logged and retried with backoff (5 s up to 5 min); the collector keeps running.

**IONOS setup:** create the folder (e.g. `airwaves`) in the web space of nicostaple.com, give it an
SFTP user whose root is that folder (so `PUBLISH_DIR=/`), and it is served at
`https://nicostaple.com/airwaves/`. The built site uses only relative URLs, so it works under that
sub-path. A browser decides between live and published mode by address: port 8090, `*.local`,
`localhost` and the dev server are live; anything else is the published copy (add `?mode=live` or
`?mode=static` to force one).
