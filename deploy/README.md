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
2. **Code.** On the Mac: `./deploy/bundle.sh`, then serve `deploy/out/` over HTTP.
   On the Pi: `mkdir -p /share/airwaves/app && curl -fsSL http://<mac-ip>:8000/airwaves.tgz | tar -xz -C /share/airwaves/app`
3. **Folders and settings.**
   `mkdir -p /share/airwaves/data /share/airwaves/spectrum /media/airwaves/atc /media/airwaves/noaa`
   `cp /share/airwaves/app/deploy/airwaves.env.example /share/airwaves/airwaves.env` and set `MQTT_PASS`.
4. **NOAA image** (once): `docker build -t airwaves-noaa:local /share/airwaves/app/deploy/noaa`
5. **Collector + dashboard** on port 8090:

   ```bash
   docker run -d --name airwaves-collector --restart unless-stopped --network host \
     --env-file /share/airwaves/airwaves.env \
     -e PORT=8090 -e ADSB_URL=http://127.0.0.1:8080/data -e CLIPS_ROOT=/clips \
     -e DATA_DIR=/airwaves/data -e WEB_DIR=/airwaves/app/web/dist \
     -v /mnt/data/supervisor/share/airwaves:/airwaves \
     -v /mnt/data/supervisor/media/airwaves:/clips \
     -w /airwaves/app node:26-alpine \
     sh -c "npm ci --omit=dev --no-audit --no-fund && exec node collector/src/index.ts"
   ```

6. **Scheduler** (owns the dongle; needs the Docker socket to start and stop decoders):

   ```bash
   docker run -d --name airwaves-scheduler --restart unless-stopped --network host \
     --env-file /share/airwaves/airwaves.env \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -v /mnt/data/supervisor/share/airwaves:/airwaves \
     -w /airwaves/app node:26-alpine \
     sh -c "npm ci --omit=dev --no-audit --no-fund && exec node scheduler/src/index.ts"
   ```

To pause the rotation and go back to plain ADS-B: `docker stop airwaves-scheduler`
(it restarts Ultrafeeder on the way out).
