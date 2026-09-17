const MOVY_API = 'https://api.wecollege.net'
const MOVY_SERVERS = [
  'miami',
  'phoenix',
  'dallas',
  'seattle',
  'denver',
  'cancun',
  'atlanta',
  'houston',
  'portland',
  'austin',
  'munich',
  'berlin',
  'paris',
  'delhi',
]
const MOVY_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
]
const MOVY_MAGIC = [109, 118, 109, 49]
const MOVY_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.movy.bz/',
  Origin: 'https://www.movy.bz',
}

const movyIsEven = (e) => ((e * (e + 1)) & 1) === 0
function movyMix(e) {
  e >>>= 0
  e ^= e >>> 16
  e = Math.imul(e, 0x85ebca6b) >>> 0
  e ^= e >>> 13
  e = Math.imul(e, 0xc2b2ae35) >>> 0
  e ^= e >>> 16
  return e >>> 0
}
function movyShift(e, t) {
  return ((e >>>= 0), 0 === (t &= 31) ? e >>> 0 : ((e << t) | (e >>> (32 - t))) >>> 0)
}
function decodeMovyPayload(e, t, a) {
  const r = (function (e) {
    const t = e
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(4 * Math.ceil(e.length / 4), '=')
    return new Uint8Array(Buffer.from(t, 'base64'))
  })(e)
  const n = (function (e, t, a) {
    const s = (function (e, t) {
      const s = Array(61)
      let r =
        movyMix(
          (function (e) {
            let t = 0x811c9dc5
            for (let a = 0; a < e.length; a++) t = Math.imul(t ^ e.charCodeAt(a), 0x1000193) >>> 0
            return movyMix(t)
          })(e) ^ movyMix((t >>> 0) ^ 0x9e3779b9)
        ) >>> 0
      for (let e = 0; e < 8; e++) {
        if (movyIsEven(e)) {
          const t = r % 61
          r = movyShift((r + 0x9e3779b9) >>> 0, 7 + (7 & e))
          s[t] = (r ^ movyMix(r)) >>> 0
          r = movyMix((r + t) >>> 0)
        } else {
          s[e] = MOVY_K[15 & e]
        }
      }
      return { S: s, acc: movyMix(0xa5a5a5a5 ^ r) >>> 0 }
    })(e, t)
    const r = new Uint8Array(a)
    let n = 0
    for (let e = 0; e < a; ) {
      const t = (function (e, t) {
        const r = e.S
        let n = e.acc
        const i = n % 61
        const o = 0 - Number(i in r)
        const l = r[i] >>> 0
        const c = Math.imul(0x9e3779b9, t + 1) >>> 0
        const h = ((((n ^ ((l ^ c) >>> 0)) >>> 0) | (n & ((l ^ c) >>> 0) & o)) >>> 0) >>> 0
        n = movyMix(
          ((movyShift((h + n) >>> 0, 31 & i) ^ movyShift(n, 31 & Math.imul(i, 7))) + 0x9e3779b9) >>>
            0
        )
        r[i] = n >>> 0
        e.acc = n
        return n >>> 0
      })(s, n++)
      r[e++] = 255 & t
      if (e < a) r[e++] = (t >>> 8) & 255
      if (e < a) r[e++] = (t >>> 16) & 255
      if (e < a) r[e++] = (t >>> 24) & 255
    }
    return r
  })(String(t), a, r.length)
  for (let e = 0; e < r.length; e++) r[e] ^= n[e]
  for (let e = 0; e < MOVY_MAGIC.length; e++) {
    if (r[e] !== MOVY_MAGIC[e]) throw new Error('decrypt failed: bad seed or payload')
  }
  return Buffer.from(r.subarray(MOVY_MAGIC.length)).toString('utf8')
}

export default function createProvider(ctx) {
  const seedCache = new Map()
  const inflightSeeds = new Map()

  async function movyGetSeed(mediaId, forceRefresh = false) {
    const key = String(mediaId)
    const now = Date.now()
    if (!forceRefresh) {
      const cached = seedCache.get(key)
      if (cached && cached.expiresAt - 4000 > now) return cached.seed
    }
    if (inflightSeeds.has(key)) return await inflightSeeds.get(key)
    const promise = (async () => {
      try {
        const r = await fetch(`${MOVY_API}/seed?mediaId=${mediaId}`, {
          headers: MOVY_HEADERS,
          signal: AbortSignal.timeout(5000),
        })
        if (r.ok) {
          const data = await r.json()
          const ttl = data.ttlMs || 30000
          seedCache.set(key, { seed: data.seed, expiresAt: Date.now() + ttl })
          return data.seed
        }
        if (r.status === 429) {
          const cached = seedCache.get(key)
          if (cached) return cached.seed
        }
      } catch {
        const cached = seedCache.get(key)
        if (cached) return cached.seed
      } finally {
        inflightSeeds.delete(key)
      }
      return seedCache.get(key)?.seed || null
    })()
    inflightSeeds.set(key, promise)
    return await promise
  }

  async function tryMovyCity(city, baseParams, seed, numericTmdbId) {
    try {
      const params = new URLSearchParams({ ...baseParams, seed })
      const r = await fetch(`${MOVY_API}/${city}/sources?${params.toString()}`, {
        headers: MOVY_HEADERS,
        signal: AbortSignal.timeout(5000),
      })
      if (!r.ok) return null
      const encrypted = await r.text()
      let decrypted
      try {
        decrypted = decodeMovyPayload(encrypted, seed, numericTmdbId)
      } catch {
        const retrySeed = await movyGetSeed(numericTmdbId, true)
        if (!retrySeed) return null
        const retryParams = new URLSearchParams({ ...baseParams, seed: retrySeed })
        const retryResp = await fetch(`${MOVY_API}/${city}/sources?${retryParams.toString()}`, {
          headers: MOVY_HEADERS,
          signal: AbortSignal.timeout(5000),
        })
        if (!retryResp.ok) return null
        decrypted = decodeMovyPayload(await retryResp.text(), retrySeed, numericTmdbId)
      }
      const data = JSON.parse(decrypted)
      if (!Array.isArray(data.sources) || data.sources.length === 0) return null
      const validSources = data.sources.filter((s) => !(s.url || '').includes('.mpd'))
      if (validSources.length === 0) return null
      const sources = []
      const audioTracks = []
      for (const s of validSources) {
        const isHls = s.url.includes('.m3u8')
        const isMp4 = s.url.includes('.mp4')
        if (isHls) {
          try {
            const plRes = await fetch(s.url, {
              headers: {
                'User-Agent': MOVY_HEADERS['User-Agent'],
                Referer: 'https://www.movy.bz/',
                Origin: 'https://www.movy.bz',
              },
              signal: AbortSignal.timeout(6000),
            })
            if (!plRes.ok) continue
            const playlist = await plRes.text()
            if (!playlist.includes('#EXTM3U')) continue
            for (const line of playlist.split('\n')) {
              if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
                const language = line.match(/LANGUAGE="([^"]+)"/)?.[1] ?? 'unknown'
                const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'Audio'
                if (!audioTracks.find((t) => t.language === language && t.label === label)) {
                  audioTracks.push({ language, label })
                }
              }
            }
            const variantRegex =
              /#EXT-X-STREAM-INF:[^\n]*BANDWIDTH=(\d+)[^\n]*RESOLUTION=(\d+x\d+)[^\n]*(?:FRAME-RATE=([\d.]+))?[^\n]*\n([^\n]+)/g
            let match
            const variants = []
            while ((match = variantRegex.exec(playlist)) !== null) {
              const resParts = match[2].split('x')
              variants.push({
                bandwidth: parseInt(match[1], 10),
                width: parseInt(resParts[0], 10),
                height: parseInt(resParts[1], 10),
                frameRate: match[3] ? parseFloat(match[3]) : null,
                uri: match[4],
              })
            }
            if (variants.length > 0) {
              let hasValidVariant = false
              for (const v of variants) {
                const fullUrl = v.uri.startsWith('http') ? v.uri : new URL(v.uri, s.url).href
                try {
                  const headRes = await fetch(fullUrl, {
                    method: 'HEAD',
                    headers: {
                      'User-Agent': MOVY_HEADERS['User-Agent'],
                      Referer: 'https://www.movy.bz/',
                      Origin: 'https://www.movy.bz',
                    },
                    signal: AbortSignal.timeout(5000),
                  })
                  if (headRes.ok) {
                    hasValidVariant = true
                    break
                  }
                } catch {
                  // ignore
                }
              }
              if (hasValidVariant || variants.length > 0) {
                sources.push({ url: s.url, quality: s.quality || 'Auto', type: 'hls' })
              } else {
                continue
              }
            } else if (playlist.includes('#EXTINF')) {
              sources.push({ url: s.url, quality: s.quality || 'Auto', type: 'hls' })
            } else {
              continue
            }
          } catch {
            continue
          }
        } else {
          try {
            const headRes = await fetch(s.url, {
              method: 'HEAD',
              headers: {
                'User-Agent': MOVY_HEADERS['User-Agent'],
                Referer: 'https://www.movy.bz/',
                Origin: 'https://www.movy.bz',
              },
              signal: AbortSignal.timeout(5000),
            })
            if (!headRes.ok) continue
            sources.push({ url: s.url, quality: s.quality || 'Auto', type: isMp4 ? 'mp4' : 'hls' })
          } catch {
            continue
          }
        }
      }
      if (sources.length === 0) return null
      return { sources, audioTracks }
    } catch {
      return null
    }
  }

  async function getSources(media, server) {
    const numericTmdbId = Number(media.tmdbId)
    if (!numericTmdbId) return null
    const mediaType = media.type === 'movie' ? 'movie' : 'tv'
    const seed = await movyGetSeed(numericTmdbId)
    if (!seed) throw new Error('Seed unavailable')
    const baseParams = {
      title: media.title || '',
      mediaType,
      year: media.year || '',
      tmdbId: String(numericTmdbId),
      imdbId: media.imdbId || '',
      enc: '2',
      seed,
    }
    if (mediaType === 'tv') {
      baseParams.totalSeasons = String(media.totalSeasons || 1)
      baseParams.seasonId = String(media.season || 1)
      baseParams.episodeId = String(media.episode || 1)
    }
    const cities =
      server && MOVY_SERVERS.includes(server)
        ? [server]
        : MOVY_SERVERS
    for (const city of cities) {
      const result = await tryMovyCity(city, baseParams, seed, numericTmdbId)
      if (result) return { ...result, server: city }
    }
    return null
  }

  return { name: 'movybz', servers: [...MOVY_SERVERS], getSources }
}
