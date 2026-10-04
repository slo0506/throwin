/**
 * A reference image for an Ask's target: the og:image (or twitter:image) of a page the
 * research cited, or of a link the user shared. Retailers and marketplaces publish these
 * for link previews, so they're usually a clean product shot.
 *
 * The server fetches pages chosen by web search, so it only follows public https URLs: no
 * IP literals, no localhost and no private-network names. An image counts only when the URL
 * really serves an image.
 */

const PAGE_TIMEOUT_MS = 4000;
const MAX_PAGES = 4;
/** The head of a page is enough to find its meta tags. */
const MAX_HTML_BYTES = 400_000;
const MAX_IMAGE_BYTES = 8_000_000;

/** Public https only. Exported for tests. */
export function isPublicHttps(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host === "localhost" || !host.includes(".")) return false;
  return !/\.(local|localhost|internal|lan|home|corp|test|invalid)$/.test(host);
}

/** The og:image or twitter:image in a page's HTML, resolved against the page URL. */
export function metaImage(html: string, pageUrl: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (key !== "og:image" && key !== "og:image:secure_url" && key !== "twitter:image") continue;
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!content) continue;
    try {
      return new URL(content.replace(/&amp;/g, "&"), pageUrl).toString();
    } catch {}
  }
  return null;
}

async function readText(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function isImage(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      headers: { Accept: "image/*" },
    });
    const type = res.headers.get("content-type") ?? "";
    const length = Number(res.headers.get("content-length") ?? "0");
    await res.body?.cancel().catch(() => {});
    return (
      res.ok &&
      type.startsWith("image/") &&
      length <= MAX_IMAGE_BYTES &&
      isPublicHttps(res.url || url)
    );
  } catch {
    return false;
  }
}

/** The first usable product image among these pages, or null. Never throws. */
export async function findProductImage(
  pages: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const candidates = [...new Set(pages)].filter(isPublicHttps).slice(0, MAX_PAGES);
  for (const page of candidates) {
    try {
      const res = await fetchImpl(page, {
        redirect: "follow",
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; ThrowInBot/1.0)" },
      });
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) continue;
      // A redirect may have landed somewhere we don't follow.
      if (!isPublicHttps(res.url || page)) continue;
      const image = metaImage(await readText(res, MAX_HTML_BYTES), res.url || page);
      if (image && isPublicHttps(image) && (await isImage(image, fetchImpl))) return image;
    } catch {
      // Slow, blocked or broken pages just don't give an image.
    }
  }
  return null;
}

/**
 * Brave's image search, for when no page gives an image. Returns the first result whose
 * original image verifies, else Brave's own thumbnail of the first result (served from
 * Brave's image proxy, so it stays up). Null on any failure. Never throws.
 */
export async function braveImageSearch(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const url = new URL("https://api.search.brave.com/res/v1/images/search");
    url.searchParams.set("q", query.slice(0, 200));
    url.searchParams.set("count", "5");
    url.searchParams.set("safesearch", "strict");
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      results?: { properties?: { url?: unknown }; thumbnail?: { src?: unknown } }[];
    };
    const results = body.results ?? [];
    for (const r of results.slice(0, 3)) {
      const original = typeof r.properties?.url === "string" ? r.properties.url : null;
      if (original && isPublicHttps(original) && (await isImage(original, fetchImpl))) {
        return original;
      }
    }
    const thumb = results[0]?.thumbnail?.src;
    return typeof thumb === "string" && isPublicHttps(thumb) ? thumb : null;
  } catch {
    return null;
  }
}
