#!/bin/bash
# Clip name matches the collector's <template>_<YYYYMMDD>_<HHMMSS> pattern (UTC).
set -o pipefail
FREQ="${FREQ:-162.45M}"
RATE=22050
CLIP="/out/NOAA_$(date -u +%Y%m%d_%H%M%S).mp3"
# 60 s of 16-bit mono audio = RATE * 2 bytes * 60, encoded to 32 kbps MP3 (~240 KB).
rtl_fm -f "$FREQ" -M fm -s "$RATE" -g "${GAIN:-44.5}" - |
  tee -p >(head -c $((RATE * 2 * 60)) | lame --quiet -r -s 22.05 --bitwidth 16 --signed --little-endian -m m -b 32 - "$CLIP") |
  multimon-ng -q -t raw -a EAS - |
  grep --line-buffered 'EAS:' |
  mosquitto_pub -h 127.0.0.1 -u "$MQTT_USER" -P "$MQTT_PASS" -t airwaves/noaa/eas -l
