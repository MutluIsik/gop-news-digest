# gop-news-digest

A small scheduled job for [Game of People](https://github.com/MutluIsik/Game-of-People) (private repo).

The game can write missions from real news, classified by a small model into a game-theory dilemma.
Discovery used to mean a player's own browser walking a dozen publisher RSS feeds through a
rate-limited third-party CORS relay, because almost no publisher sends
`Access-Control-Allow-Origin` on a feed. That's inherently unreliable — the relay is a stranger's
free service with its own rate limits.

This repo removes the problem instead of routing around it. A GitHub Actions workflow fetches every
feed in [`feeds.json`](feeds.json) **server-side**, where there's no browser CORS restriction at all,
parses them, and publishes one small `digest.json` to GitHub Pages every 20 minutes — a single static
file that GitHub Pages serves with a permissive CORS header by construction. The game's client fetches
that one reliable URL first; if it's ever unreachable or stale, it falls back to fetching the feeds
directly exactly as before, so this can only make things more reliable, never less.

## Why a separate public repo

GitHub Pages only serves *public* repositories for free, and the main game repo is private. Nothing
here is sensitive: `feeds.json` is a list of public RSS feed URLs (kept in sync by hand with the main
repo's own `shard/config/newsFeeds.ts`), and `digest.json` is a list of public headlines and teasers
already published by their own outlets. No API key, no credential, nothing that identifies a player.

## Output

`https://mutluisik.github.io/gop-news-digest/digest.json`:

```json
{
  "generatedAtMs": 1234567890123,
  "items": [
    { "source": "TechCrunch", "headline": "…", "link": "https://…", "teaser": "…" }
  ]
}
```

## Running it locally

```bash
npm install
npm run build   # writes dist/digest.json
```
