import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env (real environment variables win over the file).
const envFile = process.env.ENV_FILE || '.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

const words = (v) => (v || '').split(/\s+/).filter(Boolean);

export const config = {
  host: env.HOST || '0.0.0.0',
  port: int(env.PORT, 3000),
  downloadPath: resolve(env.DOWNLOAD_PATH || '/mnt/media/yt-dlp/downloads'),
  dbPath: resolve(env.DB_PATH || './data/gateway.db'),
  ytdlpUi: (env.YTDLP_UI || 'ytptube').trim().toLowerCase(),
  pollIntervalMs: Math.max(250, int(env.POLL_INTERVAL_MS, 1500)),
  corsOrigin: env.CORS_ORIGIN || '*',
  tls: { key: env.TLS_KEY || '', cert: env.TLS_CERT || '' },
  storyboard: {
    // Build a .sbb storyboard next to each finished video (needs ffmpeg).
    enabled: !/^(0|false|no|off)$/i.test((env.STORYBOARD ?? '').trim()),
    ffmpeg: env.FFMPEG_BIN || 'ffmpeg',
    ffprobe: env.FFPROBE_BIN || 'ffprobe', // used to read the video length
  },
  ytdlp: {
    bin: env.YTDLP_BIN || 'yt-dlp',
    // Folder for the plugin's job files (resume after restart) and yt-dlp's cache.
    stateDir: resolve(env.YTDLP_STATE_DIR || resolve(env.DB_PATH || './data/gateway.db', '..', 'ytdlp')),
    format: env.YTDLP_FORMAT || 'bv*+ba/b',
    sort: env.YTDLP_SORT || 'res:1080,ext:mp4:m4a', // up to 1080p, prefer browser-playable mp4/m4a
    mergeFormat: env.YTDLP_MERGE_FORMAT || 'mp4',
    outputTemplate: env.YTDLP_OUTPUT_TEMPLATE || '%(title).150B [%(id)s].%(ext)s',
    concurrency: Math.max(1, int(env.YTDLP_CONCURRENCY, 2)),
    // yt-dlp needs a JavaScript runtime to solve YouTube's challenges; the image already has Node.
    jsRuntimes: env.YTDLP_JS_RUNTIMES ?? 'node',
    cookies: env.YTDLP_COOKIES || '',
    rateLimit: env.YTDLP_RATE_LIMIT || '',
    extraArgs: words(env.YTDLP_EXTRA_ARGS),
    infoTimeoutMs: 60_000,
  },
  ytptube: {
    url: env.YTPTUBE_URL || 'http://127.0.0.1:8081',
    user: env.YTPTUBE_USER || '',
    password: env.YTPTUBE_PASSWORD || '',
    preset: env.YTPTUBE_PRESET || '',
    folder: env.YTPTUBE_FOLDER || '',
    template: env.YTPTUBE_TEMPLATE || '',
    remoteDownloadPath: env.YTPTUBE_DOWNLOAD_PATH || '/downloads',
    timeoutMs: 15_000,
    infoTimeoutMs: 45_000,
  },
};
