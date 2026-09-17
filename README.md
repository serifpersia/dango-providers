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
- `kind`: `anime` (default), `asmr`, or `manga`. Non-anime providers are
  hidden from the anime player dropdown but still served by their own
  routes. Manga modules implement
  `search/getDetail/getChapters/getPages` instead of the video shape.
- `sub`: `soft | hard | mixed` subtitle type (omit for mature providers).
- `tier`: `direct | embed | cookie`.
- `modes`: subset of `["sub", "dub"]` (defaults to both).
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

The factory may only use `ctx` — no dango imports, no Node builtins:

- `ctx.cache.get(key)` / `ctx.cache.set(key, value, ttlSeconds?)`
- `ctx.logger.{info,warn,error,debug}(obj, msg?)`
- `ctx.fetchText(url, init?)` → `string | null`
- `ctx.fetchJson(url, init?)` → parsed JSON (throws on HTTP error)
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
```

Options: `[ids...]`, `--title`, `--episode N`, `--mode sub|dub`,
`--ua`, `--cookie`, `--timeout MS`, `--json`. Exit code is 1 on any
`FAIL`/`AUTH`.

Statuses: `PASS` | `FAIL` (+ reason) | `SKIP` (no results — rerun with a
better `--title`, e.g. mature providers) | `AUTH` (site demands a cookie).

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
