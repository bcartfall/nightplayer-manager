# Build Vue + Tailwind frontend
FROM node:22-alpine AS ui
WORKDIR /ui
COPY ui/package.json ui/package.json ./
RUN npm install
COPY ui/ ./
RUN npm run build

FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DOWNLOAD_PATH=/downloads \
    DB_PATH=/data/gateway.db \
    HOME=/tmp \
    PATH="/opt/yt-dlp/bin:$PATH"

# yt-dlp for the self-hosted `ytdlp` plugin. ffmpeg merges video+audio streams.
# Node (already in this image) is what yt-dlp uses as its JavaScript runtime for YouTube.
# yt-dlp breaks whenever YouTube changes, so rebuild regularly to pick up the latest:
#   docker compose build --pull --no-cache
# (or pin one with --build-arg YTDLP_VERSION=2026.10.26)
ARG YTDLP_VERSION=
RUN apk add --no-cache python3 py3-pip ffmpeg ca-certificates \
 && python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]${YTDLP_VERSION:+==$YTDLP_VERSION}" \
 && yt-dlp --version

WORKDIR /app

# No npm dependencies, so there is no npm install step.
COPY package.json ./
COPY src ./src
COPY --from=ui /ui/dist ./ui/dist

# /data holds the SQLite DB; world-writable so any uid set via compose `user:` can use it.
RUN mkdir -p /data /downloads && chmod 777 /data /downloads

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "src/index.js"]
