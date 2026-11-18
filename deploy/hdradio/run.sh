#!/bin/bash
# HD Radio slot: sweep + dwell + audio snippets.
#  SWEEP: tune every station in HD_STATIONS ("97.1:0 88.5:1" = MHz:program, 0 = HD1) in turn, just long
#         enough to read its name and what is playing, and keep a short MP3 snippet of the audio.
#  DWELL: then stay on one station (rotating every 20 min) for HD_DWELL_SEC to collect album art.
# The collector reads the .log / .mp3 files and the album art in /out/aas/<key>/.
set -u
read -r -a stations <<< "${HD_STATIONS:-}"
if [ "${#stations[@]}" -eq 0 ]; then
  echo "HD_STATIONS is empty; nothing to decode."
  exit 0
fi
SNIP="${HD_SNIPPET_SEC:-12}"
SWEEP_MAX="${HD_SWEEP_MAX_SEC:-25}"
NOSIG="${HD_NOSIGNAL_SEC:-10}"
DWELL="${HD_DWELL_SEC:-60}"
OUT=/out
CHILD=""

stop_child() {
  if [ -n "$CHILD" ]; then
    kill "$CHILD" 2>/dev/null
    wait "$CHILD" 2>/dev/null
    CHILD=""
  fi
}
trap stop_child EXIT
trap 'exit 1' INT TERM
mkdir -p "$OUT/tmp" "$OUT/aas"

# start_nrsc5 <key> <freq> <prog> <wav-or-/dev/null> <log>: starts nrsc5 in the background, sets CHILD.
start_nrsc5() {
  mkdir -p "$OUT/aas/$1"
  nrsc5 -l 1 -o "$4" --dump-aas-files "$OUT/aas/$1" "$2" "$3" > "$5" 2>&1 &
  CHILD=$!
}

# encode_tail <wav> <mp3>: last SNIP seconds of nrsc5's 44.1 kHz stereo 16-bit WAV as a mono 48 kbps MP3.
# Raw input is read as stereo; -a downmixes to mono (-m m would misread stereo as mono, at half speed).
encode_tail() {
  local wav="$1" mp3="$2" size data want extra
  size=$(wc -c < "$wav" 2>/dev/null || echo 0)
  [ "$size" -gt 50000 ] || return 0
  data=$((size - 44))
  want=$((SNIP * 176400))
  extra=0
  [ "$data" -gt "$want" ] && extra=$(( (data - want) / 4 * 4 ))
  if tail -c +$((45 + extra)) "$wav" | lame -S -r -s 44.1 --bitwidth 16 --signed --little-endian -a -b 48 - "$mp3.part"; then
    mv "$mp3.part" "$mp3"
  else
    rm -f "$mp3.part"
  fi
}

# ---- SWEEP ----
for st in "${stations[@]}"; do
  freq="${st%%:*}"
  prog="${st##*:}"
  [ "$prog" = "$st" ] && prog=0
  key="${freq}_${prog}"
  base="${key}_$(date -u +%Y%m%d_%H%M%S)"
  log="$OUT/$base.log"
  wav="$OUT/tmp/$key.wav"
  rm -f "$wav"
  echo "Sweep: ${freq} MHz HD$((prog + 1))"
  start_nrsc5 "$key" "$freq" "$prog" "$wav" "$log"
  start=$SECONDS
  both=""
  while kill -0 "$CHILD" 2>/dev/null; do
    sleep 0.5
    el=$((SECONDS - start))
    if grep -q "Title:" "$log" 2>/dev/null; then
      [ -n "$both" ] || both=$el
      if [ "$el" -ge $((SNIP + 3)) ]; then
        # Stop once the album art for the latest XHDR lot has arrived, there is no art lot, or time is up.
        artlot=$(grep "XHDR:" "$log" 2>/dev/null | tail -n 1 | awk '{print $NF}')
        case "$artlot" in ''|*[!0-9]*) artlot=0 ;; esac
        if [ "$artlot" -le 0 ] || grep -q "LOT file:.* lot=$artlot " "$log" 2>/dev/null || [ "$el" -ge "$SWEEP_MAX" ]; then
          break
        fi
      fi
    elif [ "$el" -ge "$NOSIG" ] && ! grep -Eq "Station name:|Title:|Audio" "$log" 2>/dev/null; then
      break # no HD signal here
    fi
    [ "$el" -ge "$SWEEP_MAX" ] && break
  done
  stop_child
  [ -f "$wav" ] && encode_tail "$wav" "$OUT/$base.mp3"
  rm -f "$wav"
done

# ---- DWELL ----
pick="${stations[$(( ($(date +%s) / 1200) % ${#stations[@]} ))]}"
freq="${pick%%:*}"
prog="${pick##*:}"
[ "$prog" = "$pick" ] && prog=0
key="${freq}_${prog}"
log="$OUT/${key}_$(date -u +%Y%m%d_%H%M%S).log"
echo "Dwell: ${freq} MHz HD$((prog + 1)) for ${DWELL} s"
start_nrsc5 "$key" "$freq" "$prog" /dev/null "$log"
start=$SECONDS
while kill -0 "$CHILD" 2>/dev/null && [ $((SECONDS - start)) -lt "$DWELL" ]; do
  sleep 0.5
done
stop_child
exit 0
