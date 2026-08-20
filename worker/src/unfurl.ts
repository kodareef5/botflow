// Open Graph unfurling: fetch a url once, read the picture it advertises, and
// nothing else. The interesting part is not the parsing, it is refusing to
// fetch the wrong thing: see unfurlTarget in security.ts, and note that every
// redirect hop is judged again below.

import {
  MAX_IMAGE_BYTES,
  MAX_REDIRECTS,
  MAX_UNFURL_BYTES,
  UNFURL_TIMEOUT_MS,
  unfurlTarget,
} from './security.ts';
import { youtubeThumbnailUrl } from './youtube.ts';

export interface OgResult {
  image: string | null;
  title: string | null;
  site: string | null;
}

const UA = 'botflow-manager link preview (+https://github.com/kodareef5/botflow)';

/** Follow redirects by hand so each hop can be judged. Letting fetch follow
 *  them would mean only the first url was ever checked, and a public url that
 *  redirects into private space is the standard way past a naive guard. */
async function guardedFetch(start: URL, accept: string, allowPrivate: boolean): Promise<Response | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(UNFURL_TIMEOUT_MS),
      headers: { accept, 'user-agent': UA },
    });
    if (res.status < 300 || res.status > 399) return res;
    const location = res.headers.get('location');
    if (location === null) return res;
    let next: string;
    try {
      next = new URL(location, url).toString();
    } catch {
      return null;
    }
    const checked = unfurlTarget(next, allowPrivate);
    if (!checked.ok) return null;
    url = checked.url;
  }
  return null;
}

/** Read a body with a hard ceiling. A preview must never be able to pull an
 *  arbitrary amount of memory into the isolate. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** The page's own claim about how it should look when shared. Returns null
 *  when the url could not be fetched at all; a page with no og:image is a
 *  successful unfurl with no picture, so it is not retried forever. */
export async function fetchOg(raw: string, allowPrivate = false): Promise<OgResult | null> {
  const target = unfurlTarget(raw, allowPrivate);
  if (!target.ok) return null;
  // YouTube watch pages frequently return consent or bot-challenge markup to
  // server-side clients. Derive art only for a recognized official video URL;
  // fetchImage still judges and proxies the actual picture like every other
  // preview, so this does not create a browser-side third-party request.
  const youtubeImage = youtubeThumbnailUrl(target.url);
  if (youtubeImage !== null) return { image: youtubeImage, title: null, site: 'YouTube' };
  let res: Response | null;
  try {
    res = await guardedFetch(target.url, 'text/html,application/xhtml+xml', allowPrivate);
  } catch {
    return null;
  }
  if (res === null || !res.ok) return null;
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'text/html' && type !== 'application/xhtml+xml') return null;
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_UNFURL_BYTES) return null;

  const found: Record<string, string> = {};
  const take = (key: string) => ({
    element(el: Element) {
      const value = el.getAttribute('content');
      if (value !== null && value !== '' && found[key] === undefined) found[key] = value;
    },
  });
  // HTMLRewriter rather than a regex over markup: it is native to the runtime,
  // streams, and cannot be fooled by an attribute that merely looks like a tag.
  const rewritten = new HTMLRewriter()
    .on('meta[property="og:image"]', take('image'))
    .on('meta[property="og:image:secure_url"]', take('image'))
    .on('meta[name="twitter:image"]', take('image'))
    .on('meta[property="og:title"]', take('title'))
    .on('meta[property="og:site_name"]', take('site'))
    .transform(res);
  if ((await readCapped(rewritten, MAX_UNFURL_BYTES)) === null) return null;

  let image: string | null = null;
  if (found['image'] !== undefined) {
    // og:image may be relative, and whatever it resolves to is a second url
    // this worker is about to fetch, so it faces the same judgement.
    let absolute: string;
    try {
      absolute = new URL(found['image'], res.url || target.url.toString()).toString();
    } catch {
      absolute = '';
    }
    const checked = unfurlTarget(absolute, allowPrivate);
    if (checked.ok) image = checked.url.toString();
  }
  return {
    image,
    title: found['title'] ?? null,
    site: found['site'] ?? null,
  };
}

/** Fetch a picture the worker itself discovered, for the proxy. */
export async function fetchImage(raw: string, allowPrivate = false): Promise<{ body: Uint8Array; type: string } | null> {
  const target = unfurlTarget(raw, allowPrivate);
  if (!target.ok) return null;
  let res: Response | null;
  try {
    res = await guardedFetch(target.url, 'image/*', allowPrivate);
  } catch {
    return null;
  }
  if (res === null || !res.ok) return null;
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!type.startsWith('image/') || type === 'image/svg+xml') return null; // svg is script
  if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return null;
  const body = await readCapped(res, MAX_IMAGE_BYTES);
  return body === null ? null : { body, type };
}
