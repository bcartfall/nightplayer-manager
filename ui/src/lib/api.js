// Same origin by default (the manager serves this app). Set VITE_API_BASE to point elsewhere.
export const BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
export const url = (path) => (path ? BASE + path : null);

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the manager. Check that it is running.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  list: () => request('GET', '/api/videos'),
  add: (videoUrl) => request('POST', '/api/download', { url: videoUrl }),
  remove: (uuid) => request('DELETE', `/api/videos/${uuid}`),
};
