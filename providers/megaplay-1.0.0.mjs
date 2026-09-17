export default function createProvider(ctx) {
  const cache = ctx.cache
  const log = ctx.logger
  const megaPlayBase = 'https://megaplay.buzz/stream/ani'
  const megaPlayHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://megaplay.buzz/',
  }
  const mediaFields = `
    id
    idMal
    title { romaji english native }
    coverImage { large }
    format
    seasonYear
    episodes
    description
    status
    genres
    averageScore
  `
  const MEGAPLAY_CDN_TOKEN_KEY = 'MpCdnT0k3n!9f2K#xQ7vL5mR8wN1pY4s'
  const MEGAPLAY_CDN_TOKEN_TTL_SECONDS = 120

  function stripHtml(input) {
    if (!input) return ''
    return input
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
  }

  function toShow(media) {
    const id = media.id.toString()
    const title = media.title
    const name = title?.romaji || title?.english || title?.native || 'Unknown'
    return {
      _id: id,
      id,
      name,
      englishName: title?.english,
      nativeName: title?.native,
      names: {
        romaji: title?.romaji,
        english: title?.english,
        native: title?.native,
      },
      thumbnail: media.coverImage?.large,
      type: media.format,
      year: media.seasonYear ?? null,
      episodeCount: media.episodes ?? null,
      description: stripHtml(media.description),
      status: media.status,
      genres: media.genres?.map((g) => ({ name: g })),
      score: media.averageScore ?? null,
    }
  }

  function normalizeTitle(title) {
    return title
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function bestMatch(results, query) {
    const q = normalizeTitle(query)
    let best = results[0]
    let bestScore = -1
    for (const anime of results) {
      const title = anime.title ? normalizeTitle(anime.title.romaji || '') : ''
      const englishTitle = anime.title?.english ? normalizeTitle(anime.title.english) : ''
      const nativeTitle = anime.title?.native ? normalizeTitle(anime.title.native) : ''
      let score = -1
      if (title === q || englishTitle === q || nativeTitle === q) {
        score = 3
      } else if (title.startsWith(q) || englishTitle.startsWith(q) || nativeTitle.startsWith(q)) {
        score = 2
      } else if (title.includes(q) || englishTitle.includes(q) || nativeTitle.includes(q)) {
        score = 1
      }
      if (score > bestScore) {
        bestScore = score
        best = anime
        if (score === 3) break
      }
    }
    return best
  }

  async function search(options) {
    try {
      const rawQuery = options.query || ''
      const query = rawQuery.replace(/[""]/g, '').replace(/[']/g, '').replace(/\s+/g, ' ').trim()
      if (!query) return []
      const gql = `query ($q: String, $page: Int, $perPage: Int) {
        Page (page: $page, perPage: $perPage) {
          media (search: $q, type: ANIME) {
            ${mediaFields}
          }
        }
      }`
      const data = await ctx.anilist.request(gql, {
        q: query,
        page: 1,
        perPage: 20,
      })
      const media = data?.data?.Page?.media
      if (!media || media.length === 0) return []
      const results = media.map((m) => toShow(m))
      if (results.length > 0) {
        const best = bestMatch(media, query)
        const bestIndex = media.findIndex((m) => m.id === best.id)
        if (bestIndex > 0) {
          const [bestItem] = results.splice(bestIndex, 1)
          results.unshift(bestItem)
        }
      }
      return results
    } catch (error) {
      log.error({ error }, 'MegaPlay (AniList) search failed')
      return []
    }
  }

  async function resolveShowId(title, romaji, mode) {
    const results = await search({ query: title })
    return results[0]?._id || null
  }

  function isDirectId(showId) {
    return /^\d+$/.test(showId.trim())
  }

  async function getEpisodes(showId, mode) {
    try {
      if (!/^\d+$/.test(showId)) return null
      const cacheKey = `megaplay_eps_${showId}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const gql = `query ($id: Int) {
        Media (id: $id, type: ANIME) {
          episodes
          status
          idMal
        }
      }`
      const data = await ctx.anilist.request(gql, { id: Number(showId) })
      const media = data?.data?.Media
      if (!media) return null
      const episodeCount = media.episodes || 0
      let count = episodeCount
      if (count === 0) {
        if (media.status === 'RELEASING' || media.status === 'FINISHED') {
          count = 12
        }
      }
      const episodes = Array.from({ length: count }, (_, i) => (i + 1).toString())
      const result = {
        episodes,
        description: '',
      }
      cache.set(cacheKey, result, 86400)
      return result
    } catch (error) {
      log.error({ error, showId }, 'MegaPlay getEpisodes failed')
      return null
    }
  }

  function decodeScriptString(value) {
    return value.replace(
      /\\u([\dA-Fa-f]{4})|\\x([\dA-Fa-f]{2})|\\([\\'"bnfrtv0])/g,
      (_, unicode, hex, escaped) => {
        if (unicode) return String.fromCharCode(parseInt(unicode, 16))
        if (hex) return String.fromCharCode(parseInt(hex, 16))
        return (
          (
            { b: '\b', n: '\n', f: '\f', r: '\r', t: '\t', v: '\v', 0: '\0' }
          )[escaped] ?? escaped
        )
      }
    )
  }

  function getScriptStrings(script) {
    const strings = []
    let index = 0
    let previous = ''
    while (index < script.length) {
      const char = script[index]
      if (char === '/' && script[index + 1] === '/') {
        index = script.indexOf('\n', index + 2)
        if (index < 0) break
        continue
      }
      if (char === '/' && script[index + 1] === '*') {
        index = script.indexOf('*/', index + 2)
        if (index < 0) break
        index += 2
        continue
      }
      if (char === '/' && /[=(:,[!&|?{};]/.test(previous)) {
        index++
        let inClass = false
        while (index < script.length) {
          if (script[index] === '\\') {
            index += 2
            continue
          }
          if (script[index] === '[') inClass = true
          if (script[index] === ']') inClass = false
          if (script[index] === '/' && !inClass) {
            index++
            while (/[a-z]/i.test(script[index] ?? '')) index++
            break
          }
          index++
        }
        continue
      }
      if (char === "'" || char === '"') {
        const quote = char
        let value = ''
        index++
        while (index < script.length && script[index] !== quote) {
          if (script[index] === '\\' && index + 1 < script.length) value += script[index++]
          value += script[index++]
        }
        strings.push(decodeScriptString(value))
        index++
        continue
      }
      if (char === '`') {
        index++
        while (index < script.length && script[index] !== '`')
          index += script[index] === '\\' ? 2 : 1
        index++
        continue
      }
      if (!/\s/.test(char)) previous = char
      index++
    }
    return [...new Set(strings)]
  }

  async function getMegaPlayClientScript(pageUrl, html) {
    const cacheKey = 'megaplay_client_script'
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const scriptUrls = [...html.matchAll(/<script[^>]+src="([^"]+)"[^>]*>/gi)].map(
      (m) => new URL(m[1], pageUrl).href
    )
    const scripts = await Promise.all(
      scriptUrls.map(async (url) => {
        try {
          const res = await fetch(url, {
            headers: { ...megaPlayHeaders, Referer: pageUrl },
            signal: AbortSignal.timeout(15000),
          })
          if (!res.ok) return null
          return await res.text()
        } catch {
          return null
        }
      })
    )
    const script = scripts.find((s) => s && /getSources/i.test(s) && /AES-CBC/i.test(s)) ?? null
    if (script) cache.set(cacheKey, script, 86400)
    return script
  }

  function decryptMegaPlaySource(enc, script) {
    let encrypted
    try {
      encrypted = Buffer.from(enc, 'base64url')
    } catch {
      return null
    }
    if (!encrypted.length || encrypted.length % 16 !== 0) return null
    const tryPair = (keyValue, ivValue) => {
      const parsed = ctx.crypto.aes256CbcDecryptJson(enc, keyValue, ivValue)
      if (!parsed) return null
      const source = parsed?.file ?? parsed?.url
      return (typeof source === 'string' && source) ? source : null
    }
    const cachedPair = cache.get('megaplay_crypt_pair')
    if (cachedPair) {
      const hit = tryPair(cachedPair.keyValue, cachedPair.ivValue)
      if (hit) return hit
    }
    const values = getScriptStrings(script).filter(
      (s) => Buffer.byteLength(s) > 0 && Buffer.byteLength(s) <= 32
    )
    const ivs = values.filter((s) => Buffer.byteLength(s) === 16)
    for (const keyValue of values) {
      for (const ivValue of ivs) {
        const hit = tryPair(keyValue, ivValue)
        if (hit) {
          cache.set('megaplay_crypt_pair', { keyValue, ivValue }, 86400)
          return hit
        }
      }
    }
    return null
  }

  async function fetchMegaPlayData(fileId, pageUrl, clientScript) {
    const routes = clientScript
      ? getScriptStrings(clientScript)
          .filter((v) => /^stream\/getSources[\w/-]*$/i.test(v))
          .sort((a, b) => a.length - b.length)
      : []
    const legacy = routes[0] ?? 'stream/getSources'
    const modern = routes.find((r) => r !== legacy && r.startsWith(legacy)) ?? null
    const fetchRoute = async (route) => {
      if (!route) return null
      try {
        const url = new URL(route, 'https://megaplay.buzz/')
        url.searchParams.append('id', fileId)
        url.searchParams.append('id', fileId)
        const res = await fetch(url.href, {
          headers: {
            ...megaPlayHeaders,
            Referer: pageUrl,
            'X-Requested-With': 'XMLHttpRequest',
          },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) return null
        return (await res.json())
      } catch {
        return null
      }
    }
    const [modernData, legacyData] = await Promise.all([fetchRoute(modern), fetchRoute(legacy)])
    const data = modernData ?? legacyData
    if (!data) return null
    const directFile =
      (Array.isArray(data.sources) ? data.sources[0]?.file : data.sources?.file) ??
      (Array.isArray(legacyData?.sources) ? legacyData.sources[0]?.file : legacyData?.sources?.file)
    if (directFile) {
      return {
        sources: { file: directFile },
        tracks: modernData?.tracks ?? legacyData?.tracks,
      }
    }
    const enc = modernData && 'enc' in modernData ? modernData.enc : legacyData?.enc
    if (enc && clientScript) {
      const url = decryptMegaPlaySource(enc, clientScript)
      if (url) {
        return {
          sources: { file: url },
          tracks: modernData?.tracks ?? legacyData?.tracks,
        }
      }
      log.warn('[MegaPlay] enc decrypt failed')
    }
    return data
  }

  async function getMalId(anilistId) {
    const cacheKey = `megaplay_malid_${anilistId}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) return cached || null
    try {
      const gql = `query ($id: Int) {
        Media (id: $id, type: ANIME) {
          idMal
        }
      }`
      const data = await ctx.anilist.request(gql, {
        id: Number(anilistId),
      })
      const idMal = data?.data?.Media?.idMal
      if (idMal) {
        const result = String(idMal)
        cache.set(cacheKey, result, 86400)
        return result
      }
    } catch {
    }
    try {
      const fb = await ctx.kitsu.metaByAnilistId(Number(anilistId))
      if (fb?.idMal) {
        const result = String(fb.idMal)
        cache.set(cacheKey, result, 86400)
        return result
      }
    } catch {
    }
    cache.set(cacheKey, '', 3600)
    return null
  }

  function signNexabloomMasterUrl(masterUrl, ttlSeconds = MEGAPLAY_CDN_TOKEN_TTL_SECONDS) {
    const match = masterUrl.match(/\/([a-f0-9]{32})\/([a-f0-9]{32})\//i)
    if (!match) return masterUrl
    const path = `${match[1].toLowerCase()}/${match[2].toLowerCase()}`
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds
    const message = `${expires}|${path}`
    const signature = ctx.crypto.hmacSha256Base64Url(MEGAPLAY_CDN_TOKEN_KEY, message)
    const token = `${btoa(message).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${signature}`
    try {
      const parsed = new URL(masterUrl)
      parsed.searchParams.set('token', token)
      return parsed.href
    } catch {
      const separator = masterUrl.includes('?') ? '&' : '?'
      return `${masterUrl}${separator}token=${encodeURIComponent(token)}`
    }
  }

  async function tryFetchStream(showId, targetEpisode, mode, endpoint) {
    const base = megaPlayBase.replace('/ani', `/${endpoint}`)
    const streamPageUrl = `${base}/${showId}/${targetEpisode}/${mode}`
    const pageRes = await fetch(streamPageUrl, {
      headers: megaPlayHeaders,
    })
    if (!pageRes.ok) return null
    const html = await pageRes.text()
    const idMatch = html.match(/data-id="([0-9]+)"/)
    const extractedId = idMatch ? idMatch[1] : html.match(/<title>File ([0-9]+)/i)?.[1]
    if (!extractedId) return null
    const clientScript = await getMegaPlayClientScript(streamPageUrl, html)
    const data = await fetchMegaPlayData(extractedId, streamPageUrl, clientScript)
    if (!data) return null
    let sources = []
    if (Array.isArray(data.sources)) {
      sources = data.sources
    } else if (data.sources && 'file' in data.sources) {
      sources = [data.sources]
    }
    if (sources.length === 0) return null
    const links = []
    for (const s of sources) {
      if (s.file.includes('.m3u8')) {
        try {
          const signedMaster = signNexabloomMasterUrl(s.file)
          const masterRes = await fetch(signedMaster, {
            headers: {
              Referer: 'https://megaplay.buzz/',
              Origin: 'https://megaplay.buzz',
              'User-Agent': megaPlayHeaders['User-Agent'],
            },
            signal: AbortSignal.timeout(10000),
          })
          if (masterRes.ok) {
            const playlist = await masterRes.text()
            const variantRe = /#EXT-X-STREAM-INF:([^\n]*)\n(\S+)/g
            let m
            while ((m = variantRe.exec(playlist)) !== null) {
              const attrs = m[1]
              const label =
                attrs.match(/NAME="([^"]+)"/)?.[1] ||
                (attrs.match(/RESOLUTION=\d+x(\d+)/)?.[1] ?? '') + 'p' ||
                ''
              if (!label || label === 'p') continue
              const variantUrl = new URL(m[2], s.file).href
              links.push({
                resolutionStr: label,
                link: variantUrl,
                hls: true,
                headers: {
                  Referer: 'https://megaplay.buzz/',
                  'User-Agent': megaPlayHeaders['User-Agent'],
                },
              })
            }
          }
        } catch {
        }
        links.push({
          resolutionStr: 'Auto',
          link: s.file,
          hls: true,
          headers: {
            Referer: 'https://megaplay.buzz/',
            'User-Agent': megaPlayHeaders['User-Agent'],
          },
        })
      } else {
        links.push({
          resolutionStr: 'Auto',
          link: s.file,
          hls: false,
          headers: {
            Referer: 'https://megaplay.buzz/',
            'User-Agent': megaPlayHeaders['User-Agent'],
          },
        })
      }
    }
    const subtitles = (data.tracks || [])
      .filter((t) => {
        const kind = (t.kind || '').toLowerCase()
        return t.file && (!kind || kind.includes('caption') || kind.includes('sub'))
      })
      .map((t) => ({
        language: t.label || 'Unknown',
        label: t.label || 'Unknown',
        url: t.file,
      }))
    return [
      {
        sourceName: `MegaPlay (${mode.toUpperCase()})`,
        links,
        subtitles,
        type: 'player',
        actualEpisodeNumber: targetEpisode,
      },
      {
        sourceName: `MegaPlay (${mode.toUpperCase()}) [Fallback]`,
        links: [
          {
            link: streamPageUrl,
            resolutionStr: 'Auto',
            hls: false,
            headers: { Referer: 'https://megaplay.buzz/' },
          },
        ],
        subtitles: [],
        type: 'iframe',
        actualEpisodeNumber: targetEpisode,
      },
    ]
  }

  async function getStreamUrls(showId, episodeNumber, mode) {
    const malId = ctx.anilist.parseMalId(showId)
    const isAnilistId = /^\d+$/.test(showId)
    if (!isAnilistId && malId === null) return null
    let targetEpisode = episodeNumber
    if (episodeNumber === '0') {
      targetEpisode = '1'
    }
    try {
      const cacheKey = `megaplay_stream_${showId}_${targetEpisode}_${mode}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      let result
      if (!isAnilistId && malId !== null) {
        result = await tryFetchStream(String(malId), targetEpisode, mode, 'mal')
      } else {
        result = await tryFetchStream(showId, targetEpisode, mode, 'ani')
        if (!result) {
          const resolvedMalId = await getMalId(showId)
          if (resolvedMalId) {
            result = await tryFetchStream(resolvedMalId, targetEpisode, mode, 'mal')
          }
        }
      }
      if (result) {
        cache.set(cacheKey, result, 3600)
      }
      return result
    } catch (error) {
      log.error({ error, showId, episodeNumber, mode }, '[MegaPlay] getStreamUrls failed')
      return null
    }
  }

  return {
    name: 'MegaPlay',
    search,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
    isDirectId,
  }
}
