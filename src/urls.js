const YT_ID = /^[\w-]{11}$/;

/**
 * Recognise a single YouTube video or Twitch VOD/clip and return a stable
 * identity used to de-duplicate downloads. Playlist/channel/live-channel URLs
 * are rejected on purpose.
 *
 * @returns {{source: string, sourceId: string, canonicalUrl: string} | null}
 */
export function parseVideoUrl(input) {
  let u;
  try {
    u = new URL(String(input ?? '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  // ---- YouTube ----
  if (host === 'youtu.be') {
    const id = parts[0];
    return id && YT_ID.test(id) ? yt(id) : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    let id = null;
    if (parts[0] === 'watch') id = u.searchParams.get('v');
    else if (['shorts', 'live', 'embed', 'v'].includes(parts[0])) id = parts[1];
    return id && YT_ID.test(id) ? yt(id) : null;
  }

  // ---- Twitch ----
  if (host === 'twitch.tv') {
    if (parts[0] === 'videos' && /^\d+$/.test(parts[1] ?? '')) return twitchVod(parts[1]);
    if (parts[1] === 'clip' && /^[\w-]+$/.test(parts[2] ?? '')) return twitchClip(parts[2]);
    return null;
  }
  if (host === 'clips.twitch.tv' && /^[\w-]+$/.test(parts[0] ?? '')) return twitchClip(parts[0]);

  return null;
}

const yt = (id) => ({ source: 'youtube', sourceId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` });
const twitchVod = (id) => ({ source: 'twitch', sourceId: id, canonicalUrl: `https://www.twitch.tv/videos/${id}` });
const twitchClip = (slug) => ({ source: 'twitch', sourceId: `clip:${slug}`, canonicalUrl: `https://clips.twitch.tv/${slug}` });
