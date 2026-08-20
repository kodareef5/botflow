// Pure YouTube URL recognition shared by preview discovery and the hosted
// cache. Watch HTML is often empty or consent-gated for server-side clients;
// the public thumbnail endpoint is deterministic once a real video id is
// known. This helper never fetches and accepts only URL forms YouTube owns.

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PAGE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);
const EMBED_HOSTS = new Set(['youtube-nocookie.com', 'www.youtube-nocookie.com']);

/** Extract a video id from official watch, short, live, embed, and short-link
 * forms. Recognition is intentionally strict: this result bypasses fetching
 * the page HTML, so lookalikes and unusual service ports must not qualify. */
export function youtubeVideoId(raw: string | URL): string | null {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const parts = url.pathname.split('/').filter(Boolean);
  let candidate: string | null = null;
  if (host === 'youtu.be' && parts.length === 1) {
    candidate = parts[0] ?? null;
  } else if (PAGE_HOSTS.has(host)) {
    if (parts.length === 1 && parts[0] === 'watch') candidate = url.searchParams.get('v');
    else if (parts.length === 2 && ['shorts', 'live', 'embed', 'v'].includes(parts[0] ?? '')) candidate = parts[1] ?? null;
  } else if (EMBED_HOSTS.has(host) && parts.length === 2 && parts[0] === 'embed') {
    candidate = parts[1] ?? null;
  }
  return candidate !== null && VIDEO_ID_RE.test(candidate) ? candidate : null;
}

/** Stable art for the same video; bytes are still fetched through the normal
 * guarded image proxy, including redirect, type, timeout, and size checks. */
export function youtubeThumbnailUrl(raw: string | URL): string | null {
  const id = youtubeVideoId(raw);
  return id === null ? null : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}
