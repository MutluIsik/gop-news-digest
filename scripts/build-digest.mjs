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
// A hand-rolled entity table covering a dozen common names (`&rsquo;`, `&mdash;`, …) missed real ones
// in practice — `&ccedil;` ("ç") showed up undecoded in a live run, which is more than a display bug:
// an entity a publisher's meta tag decodes but its article body doesn't (or the reverse) makes two
// otherwise-identical sentences compare as different text, which is exactly what the duplicate-excerpt
// check below depends on comparing correctly. `he` covers the full HTML5 named/numeric entity set.
import he from 'he';
const decodeEntities = he.decode;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST_DIR = resolve(ROOT, 'dist');

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ENTRIES_PER_FEED = 8;
const MAX_TOTAL_ITEMS = 100;
const TEASER_MAX_CHARS = 700;
const MAX_PARAGRAPHS = 12;
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

/** Cut anything that is never article prose, before hunting through it for paragraphs. */
function stripNoiseElements(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function matchTag(html, tag) {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1] ?? null;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ');
}

/**
 * A meta-description tag is a one-sentence blurb a publisher writes *for social-media cards* — it is
 * frequently the exact same short text as the RSS feed's own `<description>`, so stopping here (as an
 * earlier version of this script did) fetches the whole article page and gets nothing the feed did not
 * already give away for free. The lead `<p>` tags inside `<article>`/`<main>` are what's actually worth
 * the fetch: real sentences from the article body a bare RSS teaser never carries. Mirrors
 * `ArticleExtractor.ts` in the main game repo (which cannot be imported across repositories, so this is
 * a deliberate re-implementation, not a copy) — same two sources, same "combine rather than choose"
 * call, same "never throws, `null` costs nothing" contract.
 *
 * **Drops a paragraph that repeats one already kept.** A live example: one publisher's markup has the
 * standfirst as two separate, byte-identical `<p>` tags (one likely for a layout this parser cannot
 * tell apart from the real one) — nothing to do with this script's own logic, a fact about that page's
 * markup, and every `<p>` in the landmark is fair game to have it. `seen` is normalized text, not raw
 * text, so the near-identical (not byte-identical) case still catches — the same comparison
 * `articleExcerpt` below uses against the description, applied one level in.
 */
function extractLeadParagraphs(html) {
  const landmark = matchTag(html, 'article') ?? matchTag(html, 'main') ?? html;
  const seen = new Set();
  const paragraphs = [];
  for (const match of landmark.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    if (paragraphs.length >= MAX_PARAGRAPHS) break;
    const text = decodeEntities(stripTags(match[1] ?? ''))
      .trim()
      .replace(/\s+/g, ' ');
    if (text.length === 0) continue;
    const key = normalizeForComparison(text);
    if (seen.has(key)) continue;
    seen.add(key);
    paragraphs.push(text);
  }
  if (paragraphs.length === 0) return null;
  return paragraphs.join(' ');
}

function extractMetaDescription(html) {
  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  if (og?.[1]) return decodeEntities(og[1]).trim();
  const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  if (metaDesc?.[1]) return decodeEntities(metaDesc[1]).trim();
  return null;
}

/**
 * Down to bare words, dropping every punctuation mark rather than trying to normalize quote styles.
 * A publisher's og:description and its own article body restate the same phrase in different
 * typography surprisingly often — straight `'Mommy's Home,'` in one, curly `“Mommy's Home,”` in the
 * other, same six words either way — so comparing punctuation at all just invites a false negative for
 * no benefit: two strings that agree on their sequence of words are a duplicate for this purpose
 * regardless of which quote character either one happened to use.
 */
function normalizeForComparison(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Best-effort excerpt off the article's own page: real lead-paragraph text, plus the meta description
 * **only when it says something the paragraphs do not already say**.
 *
 * A publisher's `og:description` is very often lifted verbatim from the article's own opening
 * sentence — the E! News sample that motivated this check restates it twice, word for word bar one
 * stray space. Concatenating both unconditionally (an earlier version of this script did, mirroring
 * `ArticleExtractor.ts`'s own "duplication costs nothing" call in the main game repo) spends a real
 * fraction of `TEASER_MAX_CHARS` repeating a fact rather than adding one — worse here than in that
 * design, which only ever restates in *one* sentence; some publishers restate across several. So this
 * diverges from that upstream design on purpose: if the normalized description text already appears
 * inside the normalized lead-paragraph text, the description is dropped and the paragraphs stand
 * alone, since they were always the longer, more complete supersede of the two.
 *
 * Never throws; `null` means the caller falls back to the RSS teaser, exactly as a failed fetch does.
 */
async function articleExcerpt(link) {
  if (!link) return null;
  const fetched = await fetchText(link, FETCH_TIMEOUT_MS);
  if (!fetched.ok) return null;
  const html = stripNoiseElements(fetched.body);
  const description = extractMetaDescription(html);
  const leadParagraphs = extractLeadParagraphs(html);
  const descriptionIsRedundant =
    description !== null &&
    leadParagraphs !== null &&
    normalizeForComparison(leadParagraphs).includes(normalizeForComparison(description));
  const parts = [descriptionIsRedundant ? null : description, leadParagraphs].filter(
    (part) => part && part.length > 0,
  );
  if (parts.length === 0) return null;
  return truncate(parts.join(' '), TEASER_MAX_CHARS);
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
