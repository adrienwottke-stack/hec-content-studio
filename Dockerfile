FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/install-asr.py /tmp/install-asr.py
RUN python3 -m venv /opt/asr && /opt/asr/bin/pip install --no-cache-dir vosk==0.3.45 \
    && python3 /tmp/install-asr.py && rm /tmp/install-asr.py
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4320 DATA_DIR=/app/data
ENV ASR_PYTHON=/opt/asr/bin/python ASR_MODEL_DIR=/opt/asr-models/vosk-model-small-de-0.15
EXPOSE 4320
CMD ["node", "server.mjs"]
