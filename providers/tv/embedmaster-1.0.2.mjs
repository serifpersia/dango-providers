import vm from 'node:vm'

const LINK = 'https://embedmaster.link'
const ORIGIN = 'https://embdmstrplayer.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TIMEOUT = 15000
const SAMPLES = 8
const MIN_HEALTH = 0.6

function decodeConfig(html) {
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const hit = m[1].match(
      /var \w+="([A-Za-z0-9+/=]+)"\s*,\s*\w+=\[([\d,]+)\]\s*,\s*\w+=(\d+)\s*;\s*var \w+=atob\(/
    )
    if (!hit) continue
    const bytes = Buffer.from(hit[1], 'base64')
    const key = hit[2].split(',').map(Number)
    const seed = Number(hit[3])
    let plain = ''
    for (let i = 0; i < bytes.length; i++) {
      plain += String.fromCharCode(bytes[i] ^ ((seed + key[i % key.length] + i) & 255))
    }
    const cfg = (decodeURIComponent(escape(plain)).match(/__EM_PLAYER__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/) || [])[1]
    if (cfg) return JSON.parse(cfg)
  }
  throw new Error('no __EM_PLAYER__ config found')
}

async function getConfig(media) {
  const path =
    media.type === 'movie'
      ? `/movie/${media.tmdbId}`
      : `/tv/${media.tmdbId}/${media.season || 1}/${media.episode || 1}`
  const link = await fetch(LINK + path, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT) })
  if (!link.ok) throw new Error(`embed lookup HTTP ${link.status}`)
  const page = await fetch(link.url, {
    method: 'POST',
    headers: { 'User-Agent': UA, Referer: link.url, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'tr=1',
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!page.ok) throw new Error(`player page HTTP ${page.status}`)
  return decodeConfig(await page.text())
}

async function getFeed(cfg) {
  let last = null
  for (const base of [cfg.feedUrl, cfg.feedUrlBackup].filter(Boolean)) {
    try {
      const res = await fetch(base + encodeURIComponent(cfg.scrapeToken), {
        headers: { 'User-Agent': UA, Referer: ORIGIN, Accept: 'application/x-ndjson' },
        signal: AbortSignal.timeout(TIMEOUT),
      })
      if (!res.ok) {
        last = new Error(`feed HTTP ${res.status}`)
        continue
      }
      const rows = (await res.text())
        .replace(/^\s+/, '')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return null
          }
        })
        .filter((r) => r && r.type === 'server' && r.source_url)
      if (rows.length) return rows
      last = new Error('feed empty')
    } catch (e) {
      last = e
    }
  }
  throw last ?? new Error('feed failed')
}

let sandbox = null
async function getSandbox(cfg) {
  if (sandbox) return sandbox
  const res = await fetch(`${ORIGIN}/v2/assets/js/em-crypto.min.js`, {
    headers: { 'User-Agent': UA, Referer: ORIGIN },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`em-crypto HTTP ${res.status}`)

  function XHR() {
    this._h = {}
  }
  XHR.prototype.open = function (_m, u) {
    this._url = u
  }
  XHR.prototype.setRequestHeader = function (k, v) {
    this._h[k] = v
  }
  XHR.prototype.abort = function () {}
  XHR.prototype.send = function () {
    fetch(this._url, { headers: this._h })
      .then(async (r) => {
        this.readyState = 4
        this.status = r.status
        this.responseText = await r.text()
        this.onreadystatechange?.()
      })
      .catch(() => {
        this.readyState = 4
        this.status = 0
        this.onreadystatechange?.()
      })
  }

  const ctx = vm.createContext({
    XMLHttpRequest: XHR,
    console,
    location: { href: cfg.feedUrl },
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    atob,
    btoa,
    crypto: globalThis.crypto,
    Uint8Array,
    ArrayBuffer,
  })
  ctx.globalThis = ctx
  ctx.window = ctx
  ctx.self = ctx
  ctx.__EM_PLAYER__ = cfg
  vm.runInContext(await res.text(), ctx, { filename: 'em-crypto.min.js' })
  sandbox = ctx
  return ctx
}

async function resolve(ctx, cfg, row) {
  const url = `${new URL(cfg.resolveUrl, ORIGIN).href}?src=${encodeURIComponent(row.source_url)}`
  const data = await new Promise((done) => {
    ctx.EMFetch(url, (err, d) => done(err ? null : d))
  })
  if (!data || !data.ok || !data.url) return null
  return {
    url: data.url,
    type: data.type === 'progressive' ? 'mp4' : 'hls',
    qualities: Array.isArray(data.qualities) ? data.qualities : [],
    subtitles: Array.isArray(data.subtitles)
      ? data.subtitles.map((t) => ({ language: t.lang || 'und', label: t.label || t.lang || 'Sub', url: t.url }))
      : [],
  }
}

async function playlistVariants(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: ORIGIN },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) return null
  const body = await res.text()
  if (!body.includes('#EXTM3U')) return null
  const out = []
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const attrs = lines[i].match(/^#EXT-X-STREAM-INF:(.*)$/)?.[1]
    if (!attrs) continue
    const uri = lines[i + 1]?.trim()
    if (!uri || uri.startsWith('#')) continue
    out.push({
      label: attrs.match(/RESOLUTION=\d+x(\d+)/)?.[1] ? `${attrs.match(/RESOLUTION=\d+x(\d+)/)[1]}p` : 'auto',
      url: new URL(uri, res.url || url).href,
      height: Number(attrs.match(/RESOLUTION=\d+x(\d+)/)?.[1] || 0),
    })
  }
  return out
}

async function playlistSegments(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: ORIGIN },
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!res.ok) return null
    const out = []
    for (const line of (await res.text()).split('\n')) {
      const t = line.trim()
      if (t && !t.startsWith('#')) out.push(new URL(t, res.url || url).href)
      if (out.length >= SAMPLES) break
    }
    return out
  } catch {
    return null
  }
}

async function isHealthy(probe) {
  if (!probe || !probe.length) return true
  const results = await Promise.all(
    probe.map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Referer: ORIGIN },
          signal: AbortSignal.timeout(TIMEOUT),
        })
        const ok = res.ok
        await res.body?.cancel()
        return ok
      } catch {
        return false
      }
    })
  )
  return results.filter(Boolean).length / results.length >= MIN_HEALTH
}

async function buildSources(row, cfg) {
  const ctx = await getSandbox(cfg)
  ctx.__EM_PLAYER__ = cfg
  const hit = await resolve(ctx, cfg, row)
  if (!hit) return null

  const sources = []
  let probe = null
  if (hit.type === 'hls') {
    const variants = await playlistVariants(hit.url)
    if (!variants) return null
    sources.push({ url: hit.url, quality: 'Auto', type: 'hls' })
    for (const v of variants.sort((a, b) => b.height - a.height)) {
      sources.push({ url: v.url, quality: v.label, type: 'hls' })
    }
    probe = await playlistSegments(sources[1] ? sources[1].url : hit.url)
  } else {
    const head = await fetch(hit.url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA, Referer: ORIGIN },
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!head.ok) return null
    sources.push({ url: hit.url, quality: 'Auto', type: 'mp4' })
    for (const q of hit.qualities) sources.push({ url: q.url, quality: q.label, type: 'mp4' })
  }
  return { sources, subtitles: hit.subtitles, probe }
}

export default function createProvider() {
  async function getSources(media, server) {
    if (!Number(media.tmdbId)) return null
    let cfg
    let feed
    try {
      cfg = await getConfig(media)
      feed = await getFeed(cfg)
    } catch {
      return null
    }

    const direct = feed.filter((r) => (cfg.kinds?.[String(r.source_type)] || 'direct') === 'direct')
    if (!direct.length) return null

    const pick = server
      ? direct.filter((r) => r.source_name === server || r.source_name.toLowerCase() === server.toLowerCase())
      : []
    const candidates = pick.length ? pick : direct
    for (const row of candidates) {
      const built = await buildSources(row, cfg)
      if (built && built.sources.length && (await isHealthy(built.probe))) {
        return { sources: built.sources, subtitles: built.subtitles, referer: ORIGIN, server: row.source_name }
      }
    }
    return null
  }

  return { name: 'embedmaster', getSources }
}
