/**
 * Fetching a page somebody else chose.
 *
 * This lives in runtime/ rather than adapters/ on purpose. An adapter is a thing
 * that causes a consequence and may only be reached past the evaluator; reading
 * a public page causes nothing and is an L1 that needs no authorisation. Keeping
 * it here leaves adapters/ meaning exactly one thing, which is what the
 * invariant test relies on. It was in the wrong place first, and that test is
 * what noticed.
 *
 * This is the most dangerous thing in the codebase, and it does not look like
 * it. "Watch this competitor's price" hands the server a URL and asks it to
 * make a request, which is a request made from inside our network with our
 * credentials nearby. Left open it reads the cloud metadata endpoint, the
 * loopback interface, and anything else on the private side of the boundary.
 *
 * Four rules, and the third is the one people miss:
 *
 *   1. http and https only. file:, gopher: and data: are not addresses on the
 *      web, they are ways of asking a fetcher to read something local.
 *   2. The host must resolve to a public address. Not "look public": resolve.
 *      A name anybody can register can point at 127.0.0.1, and plenty do.
 *   3. Every redirect hop is checked again. Validating only the first hop is
 *      the same as not validating at all, because the answer to the first
 *      request can be a 302 pointing anywhere.
 *   4. Responses are capped. A page that never ends is a way to exhaust memory
 *      from the outside.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 12_000;

/** Address ranges that are ours, not theirs. */
function isPrivateAddress(address, family) {
  if (family === 6) {
    const a = address.toLowerCase();
    if (a === '::1' || a === '::') return true;
    if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true;
    // ::ffff:127.0.0.1 and friends: an IPv4 address wearing a hat.
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1], 4);
    return false;
  }

  const [a, b] = address.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;   // cloud metadata lives here
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;                  // multicast and reserved
  return false;
}

async function assertPublic(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${url.protocol} is not a web address`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // A literal address skips DNS, so check it directly rather than resolving it.
  if (isIP(host)) {
    if (isPrivateAddress(host, isIP(host))) throw new Error(`${host} is not a public address`);
    return;
  }

  let records;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new Error(`${host} does not resolve`);
  }

  // Every answer must be public. One private record among several is enough
  // for the connection to land there.
  for (const { address, family } of records) {
    if (isPrivateAddress(address, family)) {
      throw new Error(`${host} resolves to ${address}, which is not public`);
    }
  }
}

/**
 * @returns {{url: string, status: number, html: string, bytes: number}}
 */
export async function fetchPublicPage(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`"${input}" is not a URL`);
  }

  const signal = AbortSignal.timeout(TIMEOUT_MS);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);

    const res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: {
        // Some hosts refuse an unfamiliar agent outright, and Cloudflare in
        // particular answers a bare client with a 1010 that reads like a domain
        // problem and sends you looking in the wrong place.
        'user-agent': 'StandingOrder/0.1 (+https://standing-order-nu.vercel.app)',
        accept: 'text/html,application/xhtml+xml',
      },
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      continue;    // and round again, including the check
    }

    const reader = res.body?.getReader();
    let bytes = 0;
    const chunks = [];
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }

    const html = new TextDecoder('utf-8', { fatal: false })
      .decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));

    return { url: url.toString(), status: res.status, html, bytes };
  }

  throw new Error(`too many redirects from ${input}`);
}

// ── pulling something useful out of a page ──────────────────────────────────

const strip = (s) => s
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * A price, if the page states one.
 *
 * Structured data first, because a shop that publishes JSON-LD or Open Graph is
 * telling us the price rather than being guessed at. Only if there is none does
 * this fall back to reading currency out of the text, and it says which method
 * it used so a wrong answer can be traced to how it was found.
 */
export function extractPrice(html) {
  const jsonLd = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, block] of jsonLd) {
    try {
      const found = findOffer(JSON.parse(block));
      if (found) return { ...found, via: 'json-ld' };
    } catch { /* a malformed block is not worth failing the whole read over */ }
  }

  const meta = html.match(/<meta[^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount)["'][^>]+content=["']([^"']+)["']/i);
  if (meta) {
    const amount = Number(meta[1].replace(/[^\d.]/g, ''));
    if (Number.isFinite(amount)) return { amount, currency: null, via: 'meta' };
  }

  const text = strip(html);
  const money = text.match(/(?:NT\$|TWD|US\$|USD|＄|\$|£|€|¥)\s?([\d,]+(?:\.\d{1,2})?)/);
  if (money) {
    const amount = Number(money[1].replace(/,/g, ''));
    if (Number.isFinite(amount)) return { amount, currency: null, via: 'text' };
  }

  return null;
}

function findOffer(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findOffer(item);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;

  const offers = node.offers ?? (node['@type'] === 'Offer' ? node : null);
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (offer?.price !== undefined) {
    const amount = Number(String(offer.price).replace(/[^\d.]/g, ''));
    if (Number.isFinite(amount)) return { amount, currency: offer.priceCurrency ?? null };
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = findOffer(value);
      if (found) return found;
    }
  }
  return null;
}

export function extractTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return strip(og[1]).slice(0, 160);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? strip(title[1]).slice(0, 160) : null;
}

// ── reading a product ───────────────────────────────────────────────────────

/**
 * What a product page says about itself.
 *
 * Shopify serves `/products/<handle>.json` on every storefront by design, and a
 * large share of independent clothing brands run on Shopify. Reading that is not
 * scraping a page behind a shop's back; it is a published interface, and it
 * carries stock as well as price, which HTML almost never does.
 *
 * Everything else falls back to the page itself: structured data first, then
 * Open Graph, then currency in the text. Which route produced the answer is
 * reported, because a wrong price should be traceable to how it was found.
 */
export async function readProduct(input) {
  const url = new URL(input);

  if (/\/products\/[^/]+$/.test(url.pathname)) {
    // `.js` and `.json` are both public and they are not the same. Only `.js`
    // carries `available`; `.json` omits it entirely, and reading a missing
    // field as false turns "unknown" into "sold out", which is a number
    // somebody would act on. Measured, after doing exactly that.
    for (const ext of ['.js', '.json']) {
      try {
        const res = await fetchPublicPage(`${url.origin}${url.pathname}${ext}${url.search}`);
        const body = JSON.parse(res.html);
        const product = body.product ?? body;
        const variants = product?.variants ?? [];
        if (!variants.length) continue;

        const cheapest = variants.reduce((a, b) => Number(a.price) <= Number(b.price) ? a : b);
        const knowsStock = variants.some((v) => 'available' in v);

        return {
          via: `shopify${ext}`,
          title: product.title,
          // `.js` states price in cents, `.json` in the shop's units.
          price: ext === '.js' ? Number(cheapest.price) / 100 : Number(cheapest.price),
          currency: null,
          inStock: knowsStock ? variants.some((v) => v.available) : null,
          variantsInStock: knowsStock ? variants.filter((v) => v.available).length : null,
          variants: variants.length,
        };
      } catch {
        // Not a Shopify store, or it declined this shape. Try the next.
      }
    }
  }

  const page = await fetchPublicPage(input);
  const price = extractPrice(page.html);
  return {
    via: price?.via ?? 'none',
    title: extractTitle(page.html),
    price: price?.amount ?? null,
    currency: price?.currency ?? null,
    // HTML rarely states this plainly enough to be worth guessing at, and a
    // guessed stock level is worse than none: it is the number somebody would
    // act on.
    inStock: null,
    variantsInStock: null,
    variants: null,
  };
}
