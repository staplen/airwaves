# Collector runtime: Node plus ffmpeg, which decodes MP3 clips so the feed can draw their real waveforms
# (collector/src/peaks.ts). The code itself is mounted from /share/airwaves/app, not copied in.
# Built by deploy/update.sh as airwaves-collector:local.
FROM node:26-alpine
RUN apk add --no-cache ffmpeg
