# dango-providers

Remote streaming-provider repository for [dango](https://github.com/serifpersia/dango).

dango fetches `registry.json` from here, verifies each entry's `sha256`,
and loads the provider modules (`.mjs`). Updating or fixing a provider
means pushing to this repo — no dango release needed.

## Layout

```text
registry.json
providers/
  anime/    video providers (animegg-1.0.1.mjs, ...)
  manga/    manga providers (mangadex-1.0.0.mjs, ...)
  asmr/     audio providers (jasmr-1.0.0.mjs)
  tv/       tv providers (later)
```

## registry.json

```json
{
  "version": 1,
  "updatedAt": "2026-09-17T00:00:00Z",
  "providers": [
    {
      "id": "kaa",
      "label": "KAA",
      "version": "1.0.0",
      "entry": "providers/kaa-1.0.0.mjs",
      "sha256": "<64 hex chars>",
      "mature": false,
      "sub": "soft",
      "tier": "direct",
      "modes": ["sub", "dub"],
      "enabledByDefault": true
    }
  ]
}
```

- `id`: lowercase `[a-z0-9-]`, unique. Same id as a built-in overrides it.
- `entry`: absolute `https://` URL or path relative to `registry.json`.
- `sha256`: hex digest of the exact `.mjs` bytes. Required.
- `mature`: adult-only provider (shown only for adult titles).
- `kind`: `anime` (default), `asmr`, `manga`, or `tv`. Non-anime
  providers are hidden from the anime player dropdown but still served
  by their own routes. Manga modules implement
  `search/getDetail/getChapters/getPages` instead of the video shape.
  TV modules implement `getSources(media, server?)` (direct) and/or
  `getEmbedUrl(media)` (embed), keyed by TMDB id — see below.
- `sub`: `soft | hard | mixed` subtitle type (omit for mature providers).
- `tier`: `direct | embed | cookie`.
- `modes`: subset of `["sub", "dub"]` (defaults to both).
- `browse` (optional, for providers with a `browse(options)` function):
  declares which browse filters dango's mature page renders —
  `{ "genre": true, "order": true, "studio": true, "sort": true,
  "pageSize": 24 }` (all keys optional; `pageSize` is the preferred
  results-per-page, default 14). Filter *values* (genre/tag/order
  lists) come from the module's string-array exports
  (`*_GENRES`, `*_TAGS` → genres, `*_ORDERS` → orders), which dango
  collects at load time — no registry change needed for those.
- `enabledByDefault`: `false` ships the provider disabled.

## Provider modules

Each `.mjs` must have a default factory export receiving the host context
and returning the standard provider object:

```js
export default function createProvider(ctx) {
  return {
    name: 'kaa',
    search: async (options) => [],
    getEpisodes: async (showId, mode) => null,
    getStreamUrls: async (showId, episode, mode) => null,
    resolveShowId: async (title) => null,
  }
}
```

TV modules (`kind: "tv"`, in `providers/tv/`) resolve streams by TMDB
id instead of searching. `media` is
`{ tmdbId, type: 'movie'|'tv', season, episode, title, year, imdbId,
totalSeasons }` (metadata backfilled by the route, never pass the TMDB
key — use `ctx.tmdb.get(path)` if you need more):

```js
export default function createProvider(ctx) {
  return {
    name: 'movybz',
    servers: ['miami', 'dallas'], // optional: tried in order, or the ?server= pick
    getSources: async (media, server) => ({
      sources: [{ url, quality, type: 'hls' }],
      audioTracks: [{ language, label }],
      subtitles: [{ language, label, url }], // optional
      referer: 'https://…', // optional, used for proxied playback
      server, // which server answered
    }),
    getEmbedUrl: async (media) => 'https://…', // embed tier instead
  }
}
```

The factory may only use `ctx` — no dango imports, no Node builtins:

- `ctx.cache.get(key)` / `ctx.cache.set(key, value, ttlSeconds?)`
- `ctx.logger.{info,warn,error,debug}(obj, msg?)`
- `ctx.fetchText(url, init?)` → `string | null`
- `ctx.fetchJson(url, init?)` → parsed JSON (throws on HTTP error)
- `ctx.tmdb.get(path)` → TMDB JSON or `null` (key handled server-side);
  `ctx.tmdb.base` / `ctx.tmdb.image` are the API/image roots
- `ctx.proxyUrl(rawUrl, referer)` → `/api/proxy?...` URL
- `ctx.userAgent`

Bump `version`, the filename, `registry.json: version`, and `sha256`
together on every change.

## probe.mjs

Manual end-to-end test for every registry entry (dango itself does no
runtime testing — fetch, verify, register only):

```sh
node probe.mjs --list
node probe.mjs                          # all providers
node probe.mjs animegg kaa --title "Solo Leveling"
node probe.mjs animepahe                # prompts for UA + cookie
node probe.mjs animepahe --ua "..." --cookie "..."
node probe.mjs mangadex --title "Naruto"
node probe.mjs wh --title "<some title>"
node probe.mjs movybz --title "Breaking Bad" --type tv --season 1 --episode 1
node probe.mjs vixsrc --tmdb 27205 --type movie
node probe.mjs embedmaster --tmdb 1396 --type tv
```

Options: `[ids...]`, `--title`, `--episode N`, `--mode sub|dub`,
`--ua`, `--cookie`, `--timeout MS`, `--json`, plus TV-only `--tmdb ID`
(skip title lookup), `--type movie|tv`, `--season N`, `--server NAME`
(direct multi-server providers like movybz). TV lookup needs a TMDB key:
set `TMDB_API_KEY` or it falls back to a public dev key. Exit code is 1
on any `FAIL`/`AUTH`/`RATE-LIMITED`.

Statuses: `PASS` | `FAIL` (+ reason) | `SKIP` (no results — rerun with a
better `--title`, e.g. mature providers) | `AUTH` (site demands a cookie)
| `RATE-LIMITED` (back off and rerun).

Notes:

- The probe mirrors dango's host context (cache, `fetchText`/`fetchJson`,
  AniList, Kitsu `idMal` lookup, per-request UA/cookie store, AES/HMAC
  helpers, system `curl`, `proxyUrl`). Two deliberate differences:
  `scraping.fetch` is plain `fetch` (no got-scraping fingerprints) and
  the title matcher is a compact equivalent of dango's `title-matching`.
- `cheerio` is loaded lazily and only needed for `animepahe`/`animeya`:
  `npm install cheerio`.

`sha256` must be computed over the exact bytes GitHub serves, which are
the LF-normalized blob bytes (enforced by `.gitattributes`). If your
editor writes CRLF, convert to LF first, then hash — hashing a CRLF
working copy produces a digest that will never match. Never use
PowerShell `>` redirection when extracting files for hashing (it
re-encodes to UTF-16); hash with `Get-FileHash` on the LF file or
`git cat-file` piped inside node, never through the shell.
