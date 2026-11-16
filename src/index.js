import { existsSync } from 'node:fs';
import { config } from './config.js';
import { openDb } from './db.js';
import { createHub } from './events.js';
import { loadPlugin } from './plugins/index.js';
import { createTracker } from './tracker.js';
import { createServer } from './server.js';
import { log } from './log.js';

const db = openDb(config.dbPath);
const hub = createHub();
const plugin = await loadPlugin(config.ytdlpUi, config);
const tracker = createTracker({ db, plugin, hub, config });
const server = createServer({ config, db, plugin, hub, tracker });

if (!existsSync(config.downloadPath)) {
  log.warn(`DOWNLOAD_PATH ${config.downloadPath} does not exist yet`);
}

server.listen(config.port, config.host, () => {
  const proto = config.tls.key ? 'https (h2 + http/1.1)' : 'http';
  log.info(`listening on ${proto}://${config.host}:${config.port}`);
  log.info(`yt-dlp UI plugin: ${plugin.name}; downloads: ${config.downloadPath}; db: ${config.dbPath}`);
  tracker.start();
});

function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  tracker.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
