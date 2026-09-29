# dango-providers

Remote provider registry for [dango](https://github.com/serifpersia/dango).
dango fetches `registry.json`, verifies each `sha256`, loads the modules.
Push here to ship provider fixes — no dango release needed.

## Layout

```text
registry.json
ctx.d.ts
sha.mjs
probe.mjs
providers/
  anime/    video providers
  manga/    manga providers
  asmr/     audio providers
  tv/       tv providers
```

## registry.json

```json
{
  "version": 17,
  "updatedAt": "2026-09-19T12:00:00Z",
  "providers": [
    {
      "id": "kaa",
      "label": "KAA",
      "version": "1.0.0",
      "entry": "providers/anime/kaa-1.0.0.mjs",
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
  Omit it for template embeds (see `embedBase`).
- `embedBase`: `https://` base URL for `{base}/movie/{id}` +
  `{base}/tv/{id}/{season}/{episode}` TV embeds. No module file, no
  `sha256` — dango builds the provider from the registry row.
- `sha256`: hex digest of the exact `.mjs` bytes (LF-normalized). Required
  unless `embedBase` is set.
- `mature`: adult-only provider, shown only for adult titles.
- `kind`: `anime` (default), `asmr`, `manga`, or `tv`. Non-anime providers
  are hidden from the anime player dropdown. Manga modules implement
  `search/getDetail/getChapters/getPages`; TV modules implement
  `getSources(media, server?)` and/or `getEmbedUrl(media)`.
- `sub`: `soft | hard | mixed` (omit for mature providers).
- `tier`: `direct | embed | cookie`.
- `modes`: subset of `["sub", "dub"]` (defaults to both).
- `browse` (optional): declares which browse filters dango renders —
  `{ "genre": true, "order": true, "studio": true, "sort": true,
  "pageSize": 24 }`. Filter values come from the module's `*_GENRES`,
  `*_TAGS`, `*_ORDERS` string-array exports (no registry change needed).
- `enabledByDefault`: `false` ships the provider disabled.

`sha.mjs` verifies and writes hashes (zero deps):

```sh
node sha.mjs                  # verify every entry, exit 1 on mismatch
node sha.mjs kaa vixsrc       # verify specific ids only
node sha.mjs --write          # fill in computed shas, bump updatedAt
node sha.mjs --write --fix    # also convert CRLF working copies to LF first
```

## Provider modules

Default factory export receiving the host context:

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

TV modules resolve by TMDB id. `media` is
`{ tmdbId, type: 'movie'|'tv', season, episode, title, year, imdbId,
totalSeasons }` — never pass the TMDB key, use `ctx.tmdb.get(path)`:

```js
export default function createProvider(ctx) {
  return {
    name: 'movybz',
    servers: ['miami', 'dallas'],
    getSources: async (media, server) => ({
      sources: [{ url, quality, type: 'hls' }],
      audioTracks: [{ language, label }],
      subtitles: [{ language, label, url }],
      referer: 'https://…',
      server,
    }),
    getEmbedUrl: async (media) => 'https://…',
  }
}
```

The factory may only use `ctx` — no dango imports, no Node builtins.
Typed contract: `ctx.d.ts` mirrors dango's `createCtx`. Convert modules
on their next version bump only — never edit a pinned `.mjs` in place
(that breaks its `sha256`); new versions get:

```js
// @ts-check
/// <reference path="../../ctx.d.ts" />
export default function createProvider(
  /** @type {import('../../ctx.js').RemoteCtx} */ ctx
) {
```

Check new versions with `tsc --noEmit --allowJs --checkJs`. Keep `ctx.d.ts`
hand-synced on every `createCtx` change.

- `ctx.cache.get(key)` / `ctx.cache.set(key, value, ttlSeconds?)`
- `ctx.logger.{info,warn,error,debug}(obj, msg?)`
- `ctx.fetchText(url, init?)` → `string | null`
- `ctx.fetchJson(url, init?)` → parsed JSON (throws on HTTP error)
- `ctx.tmdb.get(path)` → TMDB JSON or `null`;
  `ctx.tmdb.base` / `ctx.tmdb.image` are the API/image roots
- `ctx.proxyUrl(rawUrl, referer)` → `/api/proxy?...` URL
- `ctx.userAgent`
- `ctx.titleMatch.buildQueryVariants(title, romaji?)` /
  `ctx.titleMatch.pickBestMatch(items, targets)`
- `ctx.resolveBestShowId(title, romaji?, searchFn)` — runs the
  variants loop for you; `searchFn(variant)` returns
  `[{ title, id }]`. Prefer it over a hand-rolled loop.
- `ctx.anilist.request(query, vars?)`, `ctx.anilist.parseMalId(id)`,
  `ctx.anilist.searchByTitle(title)`
- `ctx.kitsu.metaByAnilistId(anilistId)`
- `ctx.cookies.sanitizeCfClearance(raw)` /
  `ctx.cookies.buildCfClearanceCookie(raw)`
- `ctx.crypto.aes256CbcDecryptJson(b64url, keyUtf8, ivUtf8)` /
  `ctx.crypto.hmacSha256Base64Url(key, message)`
- `ctx.scraping.fetch(urlOrOptions, maybeOptions?)` →
  `{ statusCode, body, headers }`
- `ctx.curl.getJson(url, headers?)` / `ctx.curl.getText(url, headers?)` →
  `null` unless HTTP 200
- `ctx.cheerio.load(html)`

Per-request auth state — `ctx.request.get(key)`:

| key            | populated from client header | meaning when missing                   |
| -------------- | ---------------------------- | -------------------------------------- |
| `ua`           | `x-animepahe-ua`             | no animepahe UA (treat as logged out)  |
| `cookie`       | `x-animepahe-cookie`         | no animepahe cookie (AUTH_REQUIRED path) |
| `jasmr_ua`     | `x-jasmr-ua`                 | no jasmr UA                            |
| `jasmr_cookie` | `x-jasmr-cookie`             | no jasmr cookie (AUTH_REQUIRED path)   |

Only these four keys exist. Throw `new Error('AUTH_REQUIRED')` when a
site demands a missing cookie; dango maps it to the login modal.

Bump `version`, the filename, `registry.json: version`, and `sha256`
together on every change.

## probe.mjs

End-to-end test per registry entry (dango itself does no runtime testing):

```sh
node probe.mjs --list
node probe.mjs animegg kaa --title "Solo Leveling"
node probe.mjs animepahe --ua "..." --cookie "..."
node probe.mjs movybz --tmdb 27205 --type movie
```

Options: `[ids...]`, `--title`, `--episode N`, `--mode sub|dub`,
`--ua`, `--cookie`, `--timeout MS`, `--json`, TV-only `--tmdb ID`,
`--type movie|tv`, `--season N`, `--server NAME`. TV lookup needs
`TMDB_API_KEY` (falls back to a public dev key). Exit code 1 on any
`FAIL`/`AUTH`/`RATE-LIMITED`.

Statuses: `PASS` | `FAIL` (+ reason) | `SKIP` (no results — rerun with a
better `--title`) | `AUTH` (site demands a cookie) | `RATE-LIMITED`.

The probe mirrors dango's host context except `scraping.fetch` (plain
`fetch`, no got-scraping fingerprints) and the title matcher (compact
equivalent). `cheerio` loads lazily, needed only for `animepahe`/
`animeya`: `npm install cheerio`.
