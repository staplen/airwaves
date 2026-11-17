# Airwaves

A dashboard of everything one antenna and one cheap software-defined radio can hear:
aircraft (ADS-B), air traffic control audio, airline datalink (VDL2/ACARS), ships (AIS),
NOAA weather radio, tire-pressure sensors, utility meters and a spectrum sweep.

One RTL-SDR dongle can only listen to one slice of spectrum at a time, so a scheduler
rotates through decoders on a fixed loop and the dashboard shows the latest of everything,
with how fresh each source is.

```
antenna → RTL-SDR → scheduler ─ starts/stops one decoder container at a time
                                 readsb · RTLSDR-Airband · AIS-catcher · dumpvdl2 · rtl_433 · rtl_fm+multimon-ng · rtl_power
                                      │ MQTT / UDP / audio files
                                      ▼
                               collector (Node, SQLite) ──► dashboard (React + MapLibre)
```

## Layout

| Folder | What it is |
|---|---|
| `collector/` | Ingests decoder output, stores sightings and the feed, serves the API and dashboard |
| `scheduler/` | Rotates decoder containers via the Docker API; slot list in `scheduler/slots.json` |
| `web/` | Dashboard: frequency dial, live map, "Catches" feed, daily totals |
| `shared/` | Types shared by all three |
| `deploy/` | Running it on a Raspberry Pi with Home Assistant OS, plus the NOAA decoder image |

## Developing

Requires Node 24+ (TypeScript runs directly via Node's type stripping).

```bash
npm install
npm run dev:collector   # API on :4000, reads ADS-B from PI_HOST (default homeassistant.local)
npm run dev:web         # dashboard on :5173
```

Deployment notes are in [deploy/README.md](deploy/README.md).
