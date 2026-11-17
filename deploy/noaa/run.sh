#!/bin/bash
# Clip name matches the collector's <template>_<YYYYMMDD>_<HHMMSS> pattern (UTC).
set -o pipefail
FREQ="${FREQ:-162.45M}"
CLIP="/out/NOAA_$(date -u +%Y%m%d_%H%M%S).wav"
rtl_fm -f "$FREQ" -M fm -s 22050 -g "${GAIN:-44.5}" - |
  tee -p >(sox -q -t raw -r 22050 -e signed -b 16 -c 1 - "$CLIP" trim 0 60) |
  multimon-ng -q -t raw -a EAS - |
  grep --line-buffered 'EAS:' |
  mosquitto_pub -h 127.0.0.1 -u "$MQTT_USER" -P "$MQTT_PASS" -t airwaves/noaa/eas -l
