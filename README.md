# Nightplayer Manager

A zero-dependency Node.js API that downloads YouTube videos and Twitch VODs/clips with yt-dlp, either the copy built into its own Docker image (`ytdlp` plugin, self-hosted) or a yt-dlp web UI (YTPTube). It remembers them in its own SQLite database, and streams the files back with HTTP Range support. This is meant to be used with `nightplayer` for downloading and manager videos.

Requires **Node 22.13+** (uses built-in `node:sqlite`, `node:http2` and `fetch`). No `npm install` needed.

```
cp .env.example .env     # edit it
npm start
npm test                 # end-to-end test against a mock YTPTube
```

## Web UI

A dark-theme Vue 3 + Tailwind app in `ui/`, served by the manager itself at `/` once built (the Docker image builds it for you).

```
cd ui && npm install && npm run build     # then open http://localhost:3001/
cd ui && npm run dev                      # hot reload on :5173, proxies /api to http://localhost:3001 (VITE_PROXY to change)
```

* **Downloads** – add a link; every running download is a card in a grid with thumbnail, title, description, length and live progress, speed and ETA over its `links.events` stream. The thumbnail turns from grey to colour as the download advances. At most four event streams are open at once (browsers allow ~6 HTTP/1.1 connections per origin); the rest are covered by a 2 s poll of `GET /api/videos`.
* **Library** – finished downloads in a grid with search, play, delete and a jump to the storyboard.
* **SBB viewer** – drop an `.sbb` file or pick one from the library. Shows header fields, index, health checks, a scrubber that previews every stored image with its timestamp, and a sheet browser. Parsing happens in the browser.

The UI needs two additions to the API, listed below: `GET /api/videos` and `GET /api/videos/{uuid}/thumbnail`. Set `UI_PATH` to serve a build from elsewhere.

## Configuration (.env)

| Variable | Default | Purpose |
|---|---|---|
| `HOST`, `PORT` | `0.0.0.0`, `3000` | Where the API listens |
| `DOWNLOAD_PATH` | `/mnt/media/yt-dlp/downloads` | Where videos live. **Must be the same folder YTPTube writes to.** |
| `YTDLP_UI` | `ytptube` | Plugin to use (a file in `src/plugins/`): `ytdlp` or `ytptube` |
| `YTPTUBE_URL` | `http://127.0.0.1:8081` | YTPTube base URL |
| `YTPTUBE_USER` / `YTPTUBE_PASSWORD` | – | If YTPTube has basic auth on |
| `YTPTUBE_PRESET` / `_FOLDER` / `_TEMPLATE` | – | Optional per-download YTPTube settings |
| `YTPTUBE_DOWNLOAD_PATH` | `/downloads` | The downloads folder *as YTPTube sees it* (Docker) |
| `DB_PATH` | `./data/gateway.db` | The gateway's SQLite file |
| `POLL_INTERVAL_MS` | `1500` | How often active downloads are checked |
| `TLS_KEY` / `TLS_CERT` | – | Set both to serve HTTP/2 (+ HTTP/1.1 fallback) directly |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` |
| `STORYBOARD` | `1` | Set `0` to stop generating `.sbb` storyboard files |
| `UI_PATH` | `./ui/dist` | Folder with the built web UI |
| `FFMPEG_BIN` | `ffmpeg` | ffmpeg used for storyboards (already in the Docker image) |

**About HTTP/2:** browsers only speak h2 over TLS, so Node serves h2 only when `TLS_KEY`/`TLS_CERT` are set. Without them it serves HTTP/1.1, which is the right choice behind a reverse proxy (Caddy, nginx, Traefik) that terminates TLS and speaks h2 to the browser. Range requests behave identically on both.

## API

### `POST /api/download`
```json
{ "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
```
Accepts a single YouTube video (watch, youtu.be, shorts, live, embed) or a Twitch VOD (`/videos/ID`) or clip. Playlist parameters are stripped; channels/live channels are rejected with `400`.

* New video → `202` and a row is created.
* Already known (matched by platform + video ID, so different URL spellings are the same video) → `200` with `"existing": true`. **Nothing is downloaded again.**
* Exception: if the earlier attempt ended in `error`/`cancelled`, or the file is gone from disk, it is re-queued (`202`, `"retried": true`) under the same uuid.

```json
{
  "existing": false,
  "uuid": "6f0c…",
  "status": "queued",
  "percent": 0,
  "title": null,
  "links": { "self": "/api/videos/6f0c…", "stream": null, "events": "/api/videos/6f0c…/events" }
}
```

### `GET /api/videos?status=active|finished|failed|all`
`{ "items": [...], "count": n }`, newest first. Each item is the same JSON as `GET /api/videos/{uuid}`.

### `GET /api/videos/{uuid}/thumbnail`
The video's thumbnail, stored in the database (`404` if none). It comes from the thumbnail URL yt-dlp/YTPTube reports, or, once the video is finished, from an image next to the file or a frame grabbed with ffmpeg. `links.thumbnail` is `null` until it exists.

### `GET /api/videos/{uuid}`
Title, description, `duration` (s), `status` (`queued | downloading | finished | error | cancelled`), `percent`, `speed` (bytes/s), `eta` (s), `error`, `fileSize`. `links.events` is present while downloading, `links.stream` once finished. `links.storyboard` is `/api/videos/{uuid}/storyboard` once the storyboard file exists, otherwise `null` (see below).

### `GET /api/videos/{uuid}/events` (Server-Sent Events)
Sends a `progress` event immediately and on every change (payload = the same JSON as above), then a `done` event (finished / error / cancelled) and closes. `deleted` is sent if the video is deleted meanwhile.
```js
const es = new EventSource(`/api/videos/${uuid}/events`);
es.addEventListener('progress', (e) => console.log(JSON.parse(e.data).percent));
es.addEventListener('done', () => es.close());
```

### `GET /api/videos/{uuid}/stream`
Serves the file for a `<video src>` tag: `Accept-Ranges: bytes`, `206 Partial Content` for `bytes=a-b`, `a-` and `-n`, `416` when unsatisfiable, `HEAD`, `ETag`/`If-Range`. Returns `409` while still downloading and `410` if the file vanished.
```html
<video controls src="https://host/api/videos/6f0c…/stream"></video>
```

### `GET /api/videos/{uuid}/storyboard`
Serves the video's storyboard (`.sbb`) file, with the same Range support as `/stream`; `404` if there is none. After a download finishes, the gateway creates the storyboard in the background (one at a time, using ffmpeg), so `links.storyboard` is `null` for a short while after `status` becomes `finished`; poll `GET /api/videos/{uuid}` to see it appear. (The `done` SSE event is sent before that, so it still shows `null`.) The file is stored next to the video (`Title [id].sbb`) and is removed with it. Finished videos that have none (downloaded earlier, or interrupted by a restart) are queued on startup. A video ffmpeg cannot read simply has no storyboard (see the log).

**.sbb format** (little-endian): a small 160x90 image is taken every 10 s and packed 10x10 into 1600x900 JPEG sheets.
```
0   8  magic 53 54 4F 52 59 73 62 1A     32  4  rows per sheet (10)
8   4  version (0)                       36  4  columns per sheet (10)
12  4  sheet count                       40  24 reserved (0)
16  4  small image width (160)           64  20 x count: u32 index, u32 offset, u32 size, f64 seconds covered
20  4  small image height (90)           then a 20 byte terminator (u32 0xFFFFFFFF, u32 end offset, u32 0, f64 0)
24  8  fps of small images (f64, 0.1)    then the JPEG sheets back to back
```

### `DELETE /api/videos/{uuid}`
Cancels the download if running, deletes the file (and same-name `.info.json`/thumbnail/subtitle/`.sbb` sidecars, plus an emptied channel folder) from disk, removes it from YTPTube's history, and removes the DB row. A later `POST /api/download` for the same URL downloads it afresh with a new uuid.

`GET /api/health` is a liveness check.

## Self-hosted yt-dlp (`YTDLP_UI=ytdlp`)

The image contains yt-dlp, ffmpeg and Node, and the `ytdlp` plugin (`src/plugins/ytdlp.js`) runs yt-dlp as a child process. No second container is needed:

```
docker compose -f compose.ytdlp.yaml up -d --build
node client/client.js --base http://localhost:3000     # from any other machine
```

* Same plugin contract and the same HTTP endpoints as every other plugin: `add`, `status`, `remove`, `info`.
* Files go to `DOWNLOAD_PATH` (default template `Title [id].mp4`, max 1080p, mp4 preferred so browsers can play it). Partial files live in `DOWNLOAD_PATH/.ytdlp-tmp/<job>/` and are removed on completion, failure or delete.
* `YTDLP_CONCURRENCY` (default 2) limits parallel downloads; extra ones show as `queued`.
* Jobs are saved in `YTDLP_STATE_DIR` (`/data/ytdlp` in compose), so downloads interrupted by a restart continue from their partial files.
* yt-dlp must be kept current because YouTube changes constantly: `docker compose -f compose.ytdlp.yaml build --pull --no-cache && docker compose -f compose.ytdlp.yaml up -d`. If YouTube answers "Sign in to confirm you're not a bot", export a cookies file and set `YTDLP_COOKIES`.
* Running outside Docker: install `yt-dlp` and `ffmpeg` yourself (and Node, or set `YTDLP_JS_RUNTIMES` to another supported runtime), then `YTDLP_UI=ytdlp npm start`.

## Clients

* `client/client.js` is a stand-alone client (runs on any machine, only needs HTTP access): it requests a video, follows progress over SSE, then saves the file locally. `node client/client.js [url] [--base http://host:3000] [--out ./downloads] [--delete]`. Defaults to the first YouTube video (`jNQXAC9IVRw`, 19 s).
* `client/tour.js` walks through every endpoint, including Range requests, and prints the results.

## Adding another yt-dlp UI

Drop a file in `src/plugins/` whose default export is `(config) => plugin`, then set `YTDLP_UI=<filename>`. The contract is documented at the top of `src/plugins/index.js`:

```js
export default function create(config) {
  return {
    name: 'myui',
    async add(url)        { /* start it */ return { externalId } },
    async status(id)      { /* null if unknown, else { state, percent, speed, eta, title,
                              description, error, fileCandidates, fileSize } */ },
    async remove(id, { removeFile }) { return { warnings: [] } },
    async info(url)       { /* optional: { title, description } */ },
  };
}
```
The gateway owns the DB, polling, SSE, file location checks and streaming; a plugin only translates to one UI's API. `fileCandidates` are paths relative to `DOWNLOAD_PATH`.

## Notes and limits

* **Auth:** the gateway has none (a `<video>` tag can't send headers). Keep it on a trusted network or behind a reverse proxy that authenticates.
* **YTPTube compatibility:** the plugin was written from YTPTube's published API docs (`/api/history`, `/api/history/live`, `/api/history/{id}`, `/api/yt-dlp/url/info`) and locates items in responses by id/URL rather than assuming one exact JSON shape. `npm test` uses a mock built from the same docs, so run one real download against your instance to confirm — failures will be visible in the logs and in the video's `error` field. If YTPTube's `filename` ends up somewhere other than under `DOWNLOAD_PATH`, the video is marked `error` with a message saying so.
* Progress is polled from YTPTube (not pushed), so updates arrive every `POLL_INTERVAL_MS`.
* In-flight downloads are resumed from SQLite after a gateway restart.
