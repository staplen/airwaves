# NOAA weather radio slot: record a 60-second clip and forward SAME alert headers to MQTT.
# Build once on the Pi:  docker build -t airwaves-noaa:local /share/airwaves/app/deploy/noaa
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends rtl-sdr multimon-ng sox mosquitto-clients \
    && rm -rf /var/lib/apt/lists/*
COPY run.sh /run.sh
RUN chmod +x /run.sh
ENTRYPOINT ["/run.sh"]
