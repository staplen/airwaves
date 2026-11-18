#!/bin/bash
# Picks one station from HD_STATIONS ("97.1:0 88.5:1" = MHz:program, 0 = HD1), rotating every
# 20 minutes, and decodes it for up to 100 s. The collector reads the .log and album art.
set -u
read -r -a stations <<< "${HD_STATIONS:-}"
if [ "${#stations[@]}" -eq 0 ]; then
  echo "HD_STATIONS is empty; nothing to decode."
  exit 0
fi
pick="${stations[$(( ($(date +%s) / 1200) % ${#stations[@]} ))]}"
freq="${pick%%:*}"
prog="${pick##*:}"
[ "$prog" = "$pick" ] && prog=0
mkdir -p /out/aas
log="/out/${freq}_${prog}_$(date -u +%Y%m%d_%H%M%S).log"
echo "Decoding ${freq} MHz HD$((prog + 1))"
timeout 100 nrsc5 -l 1 -o /dev/null --dump-aas-files /out/aas "$freq" "$prog" > "$log" 2>&1
exit 0
