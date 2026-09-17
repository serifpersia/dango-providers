// Manual provider probe for dango-providers. Tests registry entries end to end:
// search -> resolve -> episodes -> streams (video),
// search -> detail -> chapters -> pages (manga), or
// tmdb lookup -> getSources / getEmbedUrl (tv).
//
// Usage:
//   node probe.mjs [ids...] [options]
//   node probe.mjs --list
//   node probe.mjs animegg kaa --title "Solo Leveling"
//   node probe.mjs animepahe --ua "..." --cookie "..."
//   node probe.mjs movybz --title "Breaking Bad" --type tv --season 1 --episode 1
//   node probe.mjs vixsrc --tmdb 27205 --type movie
//   node probe.mjs embedmaster --tmdb 1396 --type tv --season 1 --episode 1
//
// Statuses: PASS | FAIL | SKIP (nothing found, needs manual --title) |
// AUTH (site demands cookie, rerun with --cookie) |
// RATE-LIMITED (back off and rerun).
// Exit code is 1 when any provider FAILs, needs AUTH, or is RATE-LIMITED.
// No dependencies. cheerio is loaded lazily and only required when a
// tested provider calls ctx.cheerio (animepahe, animeya):
//   npm install cheerio
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import readline from 'node:readline'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const UA_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const args = process.argv.slice(2)
const opts = { ids: [], title: 'Naruto', episode: null, mode: 'sub', timeout: 25000 }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--list') opts.list = true
  else if (a === '--json') opts.json = true
  else if (a.startsWith('--title=')) opts.title = a.slice(8)
  else if (a === '--title') opts.title = args[++i]
  else if (a.startsWith('--episode=')) opts.episode = a.slice(10)
  else if (a === '--episode') opts.episode = args[++i]
  else if (a.startsWith('--mode=')) opts.mode = a.slice(7)
  else if (a === '--mode') opts.mode = args[++i]
  else if (a.startsWith('--ua=')) opts.ua = a.slice(5)
  else if (a === '--ua') opts.ua = args[++i]
  else if (a.startsWith('--cookie=')) opts.cookie = a.slice(9)
  else if (a === '--cookie') opts.cookie = args[++i]
  else if (a.startsWith('--timeout=')) opts.timeout = Number(a.slice(10))
  else if (a === '--timeout') opts.timeout = Number(args[++i])
  else if (a.startsWith('--tmdb=')) opts.tmdb = a.slice(7)
  else if (a === '--tmdb') opts.tmdb = args[++i]
  else if (a.startsWith('--type=')) opts.mediaType = a.slice(7)
  else if (a === '--type') opts.mediaType = args[++i]
  else if (a.startsWith('--season=')) opts.season = a.slice(9)
  else if (a === '--season') opts.season = args[++i]
  else if (a.startsWith('--server=')) opts.server = a.slice(9)
  else if (a === '--server') opts.server = args[++i]
  else if (a.startsWith('--')) {
    console.error(`unknown flag ${a}`)
    process.exit(2)
  } else {
    opts.ids.push(...a.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
  }
}
opts.mode = opts.mode === 'dub' ? 'dub' : 'sub'
if (process.env.PROBE_DEBUG) {
  console.error(`[debug] ua=${opts.ua ? `len=${opts.ua.length}` : 'MISSING'} cookie=${opts.cookie ? `len=${opts.cookie.length}` : 'MISSING'} title=${opts.title}`)
}

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8'))

if (opts.list) {
  for (const p of registry.providers) console.log(`${p.id} ${p.version} [${p.kind ?? 'anime'}]`)
  process.exit(0)
}

const wanted = opts.ids.length
  ? registry.providers.filter((p) => opts.ids.includes(String(p.id).toLowerCase()))
  : registry.providers
const missing = opts.ids.filter((id) => !wanted.some((p) => String(p.id).toLowerCase() === id))
for (const id of missing) console.error(`unknown provider id: ${id}`)
if (wanted.length === 0) process.exit(2)

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise((resolve) => rl.question(question, resolve))
  } finally {
    rl.close()
  }
}

if (wanted.some((p) => p.id === 'animepahe') && !opts.cookie && process.stdin.isTTY) {
  console.log('animepahe needs a User-Agent and cf_clearance cookie (empty = try without).')
  if (!opts.ua) opts.ua = (await ask('User-Agent: ')).trim() || undefined
  opts.cookie = (await ask('Cookie: ')).trim() || undefined
}

let cheerioMod = null
let gotScrapingMod = null
let gotScrapingTried = false
async function getCheerio() {
  if (!cheerioMod) {
    try {
      cheerioMod = await import('cheerio')
    } catch {
      throw new Error('cheerio is required for this provider: run `npm install cheerio`')
    }
  }
  return cheerioMod
}
async function getGotScraping() {
  if (!gotScrapingTried) {
    gotScrapingTried = true
    try {
      const m = await import('got-scraping')
      gotScrapingMod = m.gotScraping ?? m.default ?? null
    } catch {
      gotScrapingMod = null
    }
    if (!gotScrapingMod) {
      console.log('  [note] got-scraping not installed, plain fetch may fail Cloudflare (npm install got-scraping)')
    }
  }
  return gotScrapingMod
}

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildQueryVariants(title, romaji) {
  return [...new Set([title, romaji].filter((t) => t && String(t).trim()))]
}

function pickBestMatch(candidates, targets) {
  const norm = targets.map(normalizeTitle).filter(Boolean)
  let best = null
  for (const c of candidates) {
    const t = normalizeTitle(c.title)
    if (!t) continue
    let score = -1
    for (const q of norm) {
      if (t === q) score = Math.max(score, 3)
      else if (t.startsWith(q) || q.startsWith(t)) score = Math.max(score, 2)
      else if (t.includes(q) || q.includes(t)) score = Math.max(score, 1)
    }
    if (score > (best?.score ?? -1)) best = { item: c, score }
  }
  return best && best.score >= 0 ? best : null
}

function parseMalId(id) {
  if (typeof id === 'number') return id < 0 ? Math.abs(id) : null
  const s = String(id ?? '').trim()
  const prefixed = /^mal-(\d+)$/i.exec(s)
  if (prefixed) return parseInt(prefixed[1], 10)
  if (/^-\d+$/.test(s)) return Math.abs(parseInt(s, 10))
  return null
}

async function anilistRequest(query, vars) {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA_DEFAULT,
    },
    body: JSON.stringify({ query, variables: vars ?? {} }),
    signal: AbortSignal.timeout(opts.timeout),
  })
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`)
  return res.json()
}

async function searchAnilistByTitle(title) {
  const data = await anilistRequest(
    `query ($search: String) {
      Page(page: 1, perPage: 5) { media(search: $search, type: ANIME) { id title { romaji english native } } }
    }`,
    { search: title }
  )
  const media = data?.data?.Page?.media ?? []
  return media[0] ?? null
}

async function kitsuMetaByAnilistId(anilistId) {
  const res = await fetch(
    `https://kitsu.io/api/edge/mappings?filter[externalSite]=anilist%2Fanime&filter[externalId]=${anilistId}&include=item`,
    { headers: { Accept: 'application/vnd.api+json', 'User-Agent': UA_DEFAULT }, signal: AbortSignal.timeout(opts.timeout) }
  )
  if (!res.ok) return null
  const json = await res.json()
  const maps = Array.isArray(json?.data) ? json.data : []
  for (const m of maps) {
    if (m?.attributes?.externalSite === 'myanimelist/anime') {
      return { idMal: Number(m.attributes.externalId) || null }
    }
  }
  return null
}

function sanitizeCfClearance(raw) {
  if (!raw) return ''
  return String(raw).trim().replace(/^cf_clearance/i, '').replace(/^[:=]\s*/, '').replace(/["']/g, '').trim()
}

function buildCfClearanceCookie(raw) {
  const c = sanitizeCfClearance(raw)
  return c ? `cf_clearance=${c}` : ''
}

function aes256CbcDecryptJson(b64url, keyUtf8, ivUtf8) {
  let encrypted
  try {
    encrypted = Buffer.from(b64url, 'base64url')
  } catch {
    return null
  }
  if (!encrypted.length || encrypted.length % 16 !== 0) return null
  try {
    const key = Buffer.alloc(32)
    Buffer.from(keyUtf8).copy(key)
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivUtf8))
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'))
  } catch {
    return null
  }
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeCtx() {
  const TMDB_BASE = 'https://api.themoviedb.org/3'
  const TMDB_IMAGE = 'https://image.tmdb.org/t/p'
  const tmdbKey = process.env.TMDB_API_KEY || '9e7096a7575623aa30c66e9cc987e411'
  const store = new Map()
  const headers = { ua: opts.ua, cookie: opts.cookie, jasmr_ua: opts.ua, jasmr_cookie: opts.cookie }
  const timedFetch = (url, init) =>
    fetch(url, {
      ...init,
      headers: { 'User-Agent': UA_DEFAULT, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(opts.timeout),
    })
  return {
    cache: {
      get: (k) => store.get(k),
      set: (k, v) => void store.set(k, v),
    },
    logger: {
      info: () => {},
      warn: (...a) => console.log('  [warn]', ...a.map(String).slice(0, 2)),
      error: (...a) => console.log('  [error]', ...a.map(String).slice(0, 2)),
      debug: () => {},
    },
    fetchText: async (url, init) => {
      try {
        const res = await timedFetch(url, init)
        if (!res.ok) return null
        return await res.text()
      } catch {
        return null
      }
    },
    fetchJson: async (url, init) => {
      const res = await timedFetch(url, init)
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
      return res.json()
    },
    proxyUrl: (rawUrl, referer) =>
      `/api/proxy?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(referer)}`,
    userAgent: UA_DEFAULT,
    titleMatch: { buildQueryVariants, pickBestMatch },
    anilist: { request: anilistRequest, parseMalId, searchByTitle: searchAnilistByTitle },
    kitsu: { metaByAnilistId: kitsuMetaByAnilistId },
    tmdb: {
      base: TMDB_BASE,
      image: TMDB_IMAGE,
      get: async (tmdbPath) => {
        try {
          const sep = tmdbPath.includes('?') ? '&' : '?'
          const res = await timedFetch(`${TMDB_BASE}${tmdbPath}${sep}api_key=${tmdbKey}`)
          if (!res.ok) return null
          return res.json()
        } catch {
          return null
        }
      },
    },
    request: { get: (key) => headers[key] },
    cookies: { sanitizeCfClearance, buildCfClearanceCookie },
    crypto: {
      aes256CbcDecryptJson,
      hmacSha256Base64Url: (key, message) =>
        base64UrlEncode(crypto.createHmac('sha256', key).update(message).digest()),
    },
    scraping: {
      fetch: async (urlOrOptions, maybeOptions) => {
        const gs = await getGotScraping()
        if (process.env.PROBE_DEBUG) {
          console.error(`[debug] scraping via ${gs ? 'got-scraping' : 'plain-fetch'}: ${typeof urlOrOptions === 'string' ? urlOrOptions : urlOrOptions.url}`)
        }
        if (gs) {
          const res =
            typeof urlOrOptions === 'string'
              ? await gs(urlOrOptions, {
                  method: 'GET',
                  responseType: 'text',
                  throwHttpErrors: false,
                  ...(maybeOptions ?? {}),
                })
              : await gs({ responseType: 'text', throwHttpErrors: false, ...urlOrOptions })
          if (process.env.PROBE_DEBUG) {
            console.error(`[debug] scraping status: ${res.statusCode}`)
          }
          return { statusCode: res.statusCode, body: String(res.body ?? ''), headers: res.headers }
        }
        const o = typeof urlOrOptions === 'string' ? { url: urlOrOptions, ...(maybeOptions ?? {}) } : urlOrOptions
        const res = await timedFetch(o.url, { method: o.method ?? 'GET', headers: o.headers })
        if (process.env.PROBE_DEBUG) {
          console.error(`[debug] plain status: ${res.status}`)
        }
        return { statusCode: res.status, body: await res.text(), headers: Object.fromEntries(res.headers) }
      },
    },
    curl: {
      getJson: async (url, headers) => {
        const r = curlRaw(url, headers)
        if (!r || r.status !== 200) return null
        try {
          return JSON.parse(r.body)
        } catch {
          return null
        }
      },
      getText: async (url, headers) => {
        const r = curlRaw(url, headers)
        if (!r || r.status !== 200) return null
        return r.body
      },
    },
    cheerio: {
      load: (html) => {
        if (!cheerioMod) throw new Error('cheerio is required for this provider: run `npm install cheerio`')
        return cheerioMod.load(html)
      },
    },
  }
}

function curlRaw(url, headers) {
  const args = [
    '-sSL', '-A', UA_DEFAULT,
    ...Object.entries(headers ?? {}).flatMap(([k, v]) => ['-H', `${k}: ${v}`]),
    '--max-time', '15', '-w', '\n__HTTP_STATUS__%{http_code}', '--', url,
  ]
  let out
  try {
    out = execFileSync('curl', args, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
  } catch {
    return null
  }
  const m = out.match(/__HTTP_STATUS__(\d+)\s*$/)
  return { status: m ? parseInt(m[1], 10) : 0, body: m?.index !== undefined ? out.slice(0, m.index) : out }
}

function isAuthError(e) {
  return e?.message === 'AUTH_REQUIRED' || e?.status === 403
}

async function testVideo(p, factory) {
  const notes = []
  const search = await factory.search({ query: opts.title })
  if (!search || search.length === 0) return { status: 'SKIP', notes: [`no results for "${opts.title}"`] }
  notes.push(`search: ${search.length} hits`)
  const id = await factory.resolveShowId?.(opts.title)
  if (!id) return { status: 'FAIL', notes: [...notes, 'resolveShowId returned null'] }
  notes.push(`resolved: ${id}`)
  const eps = await factory.getEpisodes(id, opts.mode)
  if (!eps?.episodes?.length) return { status: 'FAIL', notes: [...notes, 'no episodes'] }
  notes.push(`episodes: ${eps.episodes.length}`)
  const ep = opts.episode ?? eps.episodes[0]
  const streams = await factory.getStreamUrls(id, String(ep), opts.mode)
  const links = (streams ?? []).reduce((n, s) => n + (s.links?.length ?? 0), 0)
  if (!streams?.length || links === 0) return { status: 'FAIL', notes: [...notes, `ep ${ep}: no streams`] }
  notes.push(`ep ${ep}: ${(streams ?? []).map((s) => `${s.sourceName}[${s.links?.length ?? 0}]`).join(' | ')}`)
  return { status: 'PASS', notes }
}

async function testManga(p, factory) {
  const notes = []
  const res = await factory.search({ query: opts.title, limit: 5 })
  if (!res?.items?.length) return { status: 'SKIP', notes: [`no results for "${opts.title}"`] }
  notes.push(`search: ${res.items.length} hits, first: ${res.items[0].title}`)
  const detail = await factory.getDetail(res.items[0].id)
  if (!detail) return { status: 'FAIL', notes: [...notes, 'getDetail returned null'] }
  notes.push(`detail: ${detail.chapters?.length ?? 0} chapters`)
  if (!detail.chapters?.length) return { status: 'PASS', notes: [...notes, 'no chapters to test pages'] }
  const readable = detail.chapters.filter((c) => !c.externalUrl).slice(0, 5)
  if (!readable.length) return { status: 'PASS', notes: [...notes, 'chapters are external-only'] }
  const pages = await factory.getPages(readable[0].id)
  if (!pages?.length) return { status: 'FAIL', notes: [...notes, `getPages empty (ch ${readable[0].number})`] }
  notes.push(`pages: ${pages.length} (ch ${readable[0].number})`)
  return { status: 'PASS', notes }
}

async function testTv(p, factory) {
  const notes = []
  const ctx = makeCtx()
  let tmdbId = opts.tmdb ? Number(opts.tmdb) : 0
  let mediaType = opts.mediaType === 'movie' ? 'movie' : opts.mediaType === 'tv' ? 'tv' : ''
  if (!tmdbId) {
    const found = await ctx.tmdb.get(`/search/multi?query=${encodeURIComponent(opts.title)}&page=1&include_adult=true`)
    const hit = (found?.results ?? []).find((r) => r.media_type === 'movie' || r.media_type === 'tv')
    if (!hit) return { status: 'SKIP', notes: [`no tmdb results for "${opts.title}"`] }
    tmdbId = hit.id
    if (!mediaType) mediaType = hit.media_type
    notes.push(`tmdb: ${hit.title || hit.name} (${hit.media_type} ${hit.id})`)
  }
  if (!mediaType) mediaType = 'tv'
  const details = await ctx.tmdb.get(`/${mediaType}/${tmdbId}?append_to_response=external_ids`)
  if (!details) return { status: 'FAIL', notes: [...notes, `tmdb ${mediaType}/${tmdbId} lookup failed`] }
  const media = {
    tmdbId,
    type: mediaType,
    season: Number(opts.season ?? 1) || 1,
    episode: Number(opts.episode ?? 1) || 1,
    title: details.title || details.name || '',
    year: (details.release_date || details.first_air_date || '').split('-')[0] || '',
    imdbId: details.external_ids?.imdb_id || details.imdb_id || '',
    totalSeasons: details.number_of_seasons || 1,
  }
  notes.push(`media: ${media.title} ${media.year} s${media.season}e${media.episode} imdb:${media.imdbId || 'n/a'}`)
  if (typeof factory.getSources === 'function') {
    const res = await factory.getSources(media, opts.server)
    if (!res?.sources?.length) return { status: 'FAIL', notes: [...notes, 'getSources returned no sources'] }
    const types = [...new Set(res.sources.map((s) => s.type))].join(',')
    notes.push(`sources: ${res.sources.length} (${types})${res.server ? ` via ${res.server}` : ''} audio:${(res.audioTracks ?? []).length} subs:${(res.subtitles ?? []).length}`)
    return { status: 'PASS', notes }
  }
  if (typeof factory.getEmbedUrl === 'function') {
    const url = await factory.getEmbedUrl(media)
    if (!url || !String(url).startsWith('http')) {
      return { status: 'FAIL', notes: [...notes, 'getEmbedUrl returned nothing usable'] }
    }
    notes.push(`embed: ${url}`)
    return { status: 'PASS', notes }
  }
  return { status: 'FAIL', notes: [...notes, 'neither getSources nor getEmbedUrl'] }
}

const results = []
for (const entry of wanted) {
  const file = path.join(ROOT, entry.entry)
  const fail = (detail) => ({ id: entry.id, version: entry.version, status: 'FAIL', notes: [detail] })
  try {
    if (!fs.existsSync(file)) {
      results.push(fail(`missing file ${entry.entry}`))
      continue
    }
    const bytes = fs.readFileSync(file)
    const actual = crypto.createHash('sha256').update(bytes).digest('hex')
    if (entry.sha256 && actual !== entry.sha256.toLowerCase()) {
      results.push(fail(`sha256 mismatch (registry ${entry.sha256.slice(0, 12)}… vs file ${actual.slice(0, 12)}…)`))
      continue
    }
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod.default !== 'function') {
      results.push(fail('missing default factory export'))
      continue
    }
    if (entry.id === 'animepahe' || entry.id === 'animeya') await getCheerio()
    const noteLines = [`sha ok${entry.sha256 ? '' : ' (unsigned)'}`]
    const factory = mod.default(makeCtx())
    if (entry.kind === 'manga') {
      const r = await testManga(entry, factory)
      results.push({ id: entry.id, version: entry.version, ...r, notes: [...noteLines, ...r.notes] })
    } else if (entry.kind === 'tv') {
      const r = await testTv(entry, factory)
      results.push({ id: entry.id, version: entry.version, ...r, notes: [...noteLines, ...r.notes] })
    } else {
      const r = await testVideo(entry, factory)
      results.push({ id: entry.id, version: entry.version, ...r, notes: [...noteLines, ...r.notes] })
    }
  } catch (e) {
    if (isAuthError(e)) {
      results.push({ id: entry.id, version: entry.version, status: 'AUTH', notes: ['site demands cookie — rerun with --cookie (and --ua)'] })
    } else if (String(e?.message ?? e).startsWith('HTTP 429')) {
      results.push({ id: entry.id, version: entry.version, status: 'RATE-LIMITED', notes: ['site throttled the probe — wait a minute and rerun'] })
    } else {
      results.push(fail(`${e?.message ?? e}`))
    }
  }
}

if (opts.json) {
  console.log(JSON.stringify(results, null, 2))
} else {
  const width = Math.max(...results.map((r) => r.id.length))
  for (const r of results) {
    console.log(`${r.status.padEnd(5)} ${r.id.padEnd(width)} ${r.version}`)
    for (const n of r.notes) console.log(`       ${n}`)
  }
  const counts = {}
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1
  console.log(`\n${results.length} tested: ` + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '))
}
process.exit(results.some((r) => r.status === 'FAIL' || r.status === 'AUTH' || r.status === 'RATE-LIMITED') ? 1 : 0)
