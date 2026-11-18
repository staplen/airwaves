# HD Radio slot: sweep the configured HD Radio stations with nrsc5, keeping logs, MP3 snippets and album art.
# Build once on the Pi:  docker build -t airwaves-hdradio:local /share/airwaves/app/deploy/hdradio
FROM debian:trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential cmake autoconf automake libtool patch \
    libao-dev libfftw3-dev librtlsdr-dev libusb-1.0-0-dev pkgconf ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# nrsc5 v3.2.0 (latest release when this was written)
RUN git clone --depth 1 --branch v3.2.0 https://github.com/theori-io/nrsc5 /src/nrsc5 \
    && cmake -S /src/nrsc5 -B /src/nrsc5/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
    && cmake --build /src/nrsc5/build -j"$(nproc)" \
    && cmake --install /src/nrsc5/build

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libao4 libfftw3-single3 librtlsdr2 libusb-1.0-0 lame \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/nrsc5 /usr/local/bin/nrsc5
COPY --from=build /usr/local/lib/ /usr/local/lib/
RUN ldconfig
COPY run.sh /run.sh
RUN chmod +x /run.sh
ENTRYPOINT ["/run.sh"]
