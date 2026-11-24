# Airwaves

A dashboard of everything one antenna and one cheap software-defined radio can hear from a house
near Washington, DC, grouped into seven families:

- **Air:** aircraft (ADS-B, plus UAT in beta), airline datalink (VDL2 and ACARS) and air traffic control audio
- **Sea:** ships and channel markers on the Potomac (AIS)
- **Weather:** NOAA Weather Radio clips and alert codes, and weather balloons (radiosondes)
- **Rail:** railroad radio audio and end-of-train devices
- **Amateur:** ham radio positions, messages and weather stations (APRS)
- **Broadcast:** HD Radio song info, clips, and the traffic and weather radar maps sent alongside the stations
- **Home:** tire-pressure sensors and other 315/433 MHz sensors (counts only, never IDs)

One RTL-SDR dongle can only listen to one slice of spectrum at a time, so a scheduler
rotates through decoders on a loop of several minutes. The dashboard shows the latest of
everything: a full-window map with the feed floating over it, and a footer with what's on
air now and each family's last 24 hours of activity (from a periodic `rtl_power` sweep).
On phones it works as a home-screen web app. Nothing comes from internet feeds; only map
tiles, fonts and (on the public site) a page-view counter load from the web.

```
antenna → RTL-SDR → scheduler ─ starts/stops one decoder container at a time
                                 readsb · dump978 · RTLSDR-Airband · dumpvdl2 · acarsdec · AIS-catcher · rtl_433
                                 radiosonde_auto_rx · nrsc5 · rtl_fm + multimon-ng · rtl_power
                                      │ MQTT / UDP / JSON + audio files
                                      ▼
                               collector (Node, SQLite) ──► dashboard (React + MapLibre)
                                      │
                                      └─ SFTP ──► read-only public copy (nicostaple.com/airwaves)
```

## Layout

| Folder | What it is |
|---|---|
| `collector/` | Ingests decoder output, stores sightings and the feed, serves the API and dashboard |
| `scheduler/` | Rotates decoder containers via the Docker API; slot list in `scheduler/slots.json` |
| `web/` | Dashboard: live map, feed, scanner footer, frequency dial and spectrum |
| `shared/` | Types shared by all three |
| `deploy/` | Running it on a Raspberry Pi with Home Assistant OS, plus the NOAA/APRS and HD Radio decoder images and RTLSDR-Airband configs |

## Developing

Requires Node 24+ (TypeScript runs directly via Node's type stripping).

```bash
npm install
npm run dev:collector   # API on :4000, reads ADS-B from PI_HOST (default homeassistant.local)
npm run dev:web         # dashboard on :5173
```

To work on the dashboard against the Pi's real data instead of a local collector:

```bash
API_TARGET=http://homeassistant.local:8090 npm run dev -w web
```

Deployment notes are in [deploy/README.md](deploy/README.md).
