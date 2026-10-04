FROM oven/bun:1.3.9-alpine AS speech-builder

ARG WHISPER_CPP_VERSION=1.9.1
ARG WHISPER_MODEL_SHA256=1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b

RUN apk add --no-cache build-base cmake wget python3
WORKDIR /build
COPY scripts/whisper /instrument
RUN wget -qO whisper.tar.gz "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_CPP_VERSION}.tar.gz" \
  && tar -xzf whisper.tar.gz --strip-components=1 \
  && cp /instrument/minisago-timing.h include/ \
  && python3 /instrument/instrument.py \
  && cmake -S . -B build \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_OPENMP=OFF \
    -DGGML_NATIVE=OFF \
    -DGGML_CPU_ARM_ARCH=armv8-a \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_SERVER=ON \
  && cmake --build build --config Release --target whisper-server -j2 \
  && install -Dm755 build/bin/whisper-server /out/whisper-server
RUN wget -qO /out/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin \
  && echo "${WHISPER_MODEL_SHA256}  /out/ggml-small.bin" | sha256sum -c -

RUN wget -qO /out/ggml-silero.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin \
  && echo "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987  /out/ggml-silero.bin" | sha256sum -c -

FROM oven/bun:1.3.9-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.9-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY package.json bun.lock ./
RUN apk add --no-cache git
RUN apk add --no-cache ffmpeg libstdc++
RUN bun install --frozen-lockfile --production

COPY --from=builder --chown=bun:bun /app/src ./src
COPY --from=builder --chown=bun:bun /app/scripts/backfill-guild-memory.ts ./scripts/backfill-guild-memory.ts
COPY --from=builder --chown=bun:bun /app/contracts ./contracts
COPY --from=builder --chown=bun:bun /app/tsconfig.json ./tsconfig.json
COPY --from=speech-builder /out/whisper-server /usr/local/bin/whisper-server
COPY --from=speech-builder /out/ggml-small.bin /opt/minisago-models/ggml-small.bin
COPY --from=speech-builder /out/ggml-silero.bin /opt/minisago-models/ggml-silero.bin
RUN mkdir -p /app/state && chown -R bun:bun /app/state

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["bun", "run", "start"]
