// Fetches every feed in feeds.json server-side (no browser CORS problem here at all), parses it,
// takes a small excerpt for each entry, and writes dist/digest.json — one small static file a browser
// can fetch directly with a permissive CORS header once GitHub Pages serves it.
//
// Never throws past main(): one feed failing (dead URL, timeout, malformed XML) is logged and skipped,
// never fatal to the run. An empty or unreachable feed just contributes nothing this run.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Parser from 'rss-parser';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST_DIR = resolve(ROOT, 'dist');

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ENTRIES_PER_FEED = 8;
const MAX_TOTAL_ITEMS = 100;
const TEASER_MAX_CHARS = 500;
const USER_AGENT = 'gop-news-digest/1 (+https://github.com/MutluIsik/gop-news-digest)';

const parser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: { 'User-Agent': USER_AGENT },
});

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const body = await response.text();
    return { ok: true, body };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text, maxChars) {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Best-effort: og:description or the first real paragraph, off the article's own page. Never throws. */
async function articleExcerpt(link) {
  if (!link) return null;
  const fetched = await fetchText(link, FETCH_TIMEOUT_MS);
  if (!fetched.ok) return null;
  const html = fetched.body;
  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  if (og?.[1]) return decodeEntities(truncate(og[1], TEASER_MAX_CHARS));
  const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (metaDesc?.[1]) return decodeEntities(truncate(metaDesc[1], TEASER_MAX_CHARS));
  return null;
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

/** Decodes numeric (`&#39;`, `&#x27;`) and the common named entities RSS/HTML text carries. */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|rdquo|ldquo|mdash|ndash|hellip);/g, (_m, name) => NAMED_ENTITIES[name]);
}

async function collectFeed(feed) {
  const fetched = await fetchText(feed.url, FETCH_TIMEOUT_MS);
  if (!fetched.ok) {
    console.warn(`[digest] ${feed.source}: fetch failed (${fetched.reason})`);
    return [];
  }
  let parsed;
  try {
    parsed = await parser.parseString(fetched.body);
  } catch (error) {
    console.warn(`[digest] ${feed.source}: parse failed (${error instanceof Error ? error.message : String(error)})`);
    return [];
  }
  const entries = (parsed.items ?? []).slice(0, MAX_ENTRIES_PER_FEED);
  const items = [];
  for (const entry of entries) {
    const headline = decodeEntities((entry.title ?? '').trim());
    if (headline.length === 0) continue;
    const link = typeof entry.link === 'string' && entry.link.length > 0 ? entry.link : null;
    const rssTeaser = entry.contentSnippet ?? entry.summary ?? entry.content ?? '';
    // Article-page enrichment is best-effort and never blocks the run — a slow or blocked page just
    // means this item keeps its RSS teaser, exactly the fallback the main game project already uses.
    const enriched = await articleExcerpt(link).catch(() => null);
    const teaser = enriched ?? (rssTeaser ? decodeEntities(truncate(rssTeaser, TEASER_MAX_CHARS)) : null);
    items.push({ source: feed.source, headline, link, teaser });
  }
  console.log(`[digest] ${feed.source}: ${items.length} entries`);
  return items;
}

async function main() {
  const feeds = JSON.parse(await readFile(resolve(ROOT, 'feeds.json'), 'utf8'));
  const results = await Promise.all(feeds.map((feed) => collectFeed(feed)));

  // Interleave rather than concatenate feed-by-feed, so one prolific feed cannot crowd out the rest
  // once MAX_TOTAL_ITEMS trims the list — the same fairness `NewsCollector`'s own rotating start index
  // gives the per-feed walk it stands in front of.
  const items = [];
  let index = 0;
  while (items.length < MAX_TOTAL_ITEMS && results.some((list) => index < list.length)) {
    for (const list of results) {
      if (index < list.length && items.length < MAX_TOTAL_ITEMS) items.push(list[index]);
    }
    index++;
  }

  const digest = { generatedAtMs: Date.now(), items };
  await mkdir(DIST_DIR, { recursive: true });
  await writeFile(resolve(DIST_DIR, 'digest.json'), JSON.stringify(digest), 'utf8');
  await writeFile(
    resolve(DIST_DIR, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>gop-news-digest</title>` +
      `<p>Published for <a href="https://github.com/MutluIsik/Game-of-People">Game of People</a>. ` +
      `See <a href="digest.json">digest.json</a> — ${items.length} items, generated ${new Date(digest.generatedAtMs).toISOString()}.</p>`,
    'utf8',
  );
  console.log(`[digest] wrote ${items.length} items from ${feeds.length} feeds.`);
}

main().catch((error) => {
  console.error('[digest] build failed:', error);
  process.exitCode = 1;
});
