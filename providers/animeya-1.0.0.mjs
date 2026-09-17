export default function createProvider(ctx) {
  const cache = ctx.cache
  const log = ctx.logger

  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, healthiest/537.36) Chrome/120.0.0.0 Safari/537.36'
  const DEFAULT_CORS_HEADERS = {
    Referer: 'https://animeya.cc',
    Origin: 'https://animeya.cc',
    'User-Agent': UA,
  }

  async function fetchText(url, referer) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: referer || 'https://animeya.cc',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(30000),
    })
    return res.text()
  }

  function extractM3u8FromText(text) {
    const matches = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi) || []
    return Array.from(new Set(matches.map((m) => m.replace(/\\\//g, '/'))))
  }

  async function extractEpisodeHls(url) {
    if (!url) {
      return {
        sourceUrl: url,
        hls: [],
        inspected: [],
        cors: true,
        headers: DEFAULT_CORS_HEADERS,
        note: 'Missing url',
      }
    }

    const inspected = [url]
    const hls = new Set()

    try {
      const html = await fetchText(url)
      extractM3u8FromText(html).forEach((u) => hls.add(u))

      const $ = ctx.cheerio.load(html)
      const scriptBlob = $('script')
        .map((_, s) => $(s).html() || '')
        .get()
        .join('\n')
      extractM3u8FromText(scriptBlob).forEach((u) => hls.add(u))

      $('iframe[src], script[src], source[src], video source[src], a[href]').each((_, el) => {
        const raw = $(el).attr('src') || $(el).attr('href')
        if (!raw) return
        if (!/^https?:\/\//i.test(raw)) return
        if (/\.(js|css|png|jpg|jpeg|svg|woff2?|ttf|mp4)(\?|$)/i.test(raw)) return
        inspected.push(raw)
      })

      for (const candidate of Array.from(new Set(inspected)).slice(0, 12)) {
        if (candidate === url) continue
        try {
          const page = await fetchText(candidate, url)
          extractM3u8FromText(page).forEach((u) => hls.add(u))
        } catch {
        }
      }
    } catch {
    }

    return {
      sourceUrl: url,
      hls: Array.from(hls),
      inspected: Array.from(new Set(inspected)),
      cors: true,
      headers: DEFAULT_CORS_HEADERS,
    }
  }

  async function fetchRetry(url, options = {}, retries = 3) {
    let lastErr = null
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, {
          ...options,
          signal: AbortSignal.timeout(30000),
          headers: { ...options.headers, 'User-Agent': UA },
        })
        if (res.ok) return res
        if (res.status === 404) throw new Error('Status 404')
        lastErr = new Error(`Status ${res.status}`)
      } catch (e) {
        if (e instanceof Error && e.message === 'Status 404') throw e
        lastErr = e
      }
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 1000))
    }
    throw lastErr
  }

  function parseRSCStream(html) {
    const streamMap = new Map()
    const regex = /self\.__next_f\.push\(\[(\d+|0),"((?:[^"\\]|\\.)*)"\]\)/g
    let m
    while ((m = regex.exec(html)) !== null) {
      let raw = m[2]
      try {
        raw = JSON.parse(`"${raw}"`)
      } catch {
        raw = raw.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
      }
      if (typeof raw !== 'string') continue
      const idx = raw.indexOf(':')
      if (idx === -1) continue
      const id = raw.substring(0, idx)
      const val = raw.substring(idx + 1)
      try {
        streamMap.set(
          id,
          val.trim().startsWith('[') || val.trim().startsWith('{') ? JSON.parse(val) : val
        )
      } catch {
        streamMap.set(id, val)
      }
    }
    return streamMap
  }

  function resolveRSC(obj, streamMap, depth = 0) {
    if (depth > 20 || !obj) return obj
    if (typeof obj === 'string' && obj.startsWith('$L')) {
      const id = obj.substring(2)
      const resolved = streamMap.get(id)
      if (resolved) {
        return resolveRSC(resolved, streamMap, depth + 1)
      }
      return obj
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => resolveRSC(item, streamMap, depth))
    }
    if (typeof obj === 'object') {
      const record = obj
      const newObj = {}
      for (const key in record) {
        newObj[key] = resolveRSC(record[key], streamMap, depth)
      }
      return newObj
    }
    return obj
  }

  function deepSearch(obj, pred, results = []) {
    if (!obj || typeof obj !== 'object') return results
    try {
      const record = obj
      if (pred(record)) results.push(record)
      if (Array.isArray(obj)) {
        for (const x of obj) deepSearch(x, pred, results)
      } else {
        for (const k in record) deepSearch(record[k], pred, results)
      }
    } catch {
    }
    return results
  }

  function extractCard(node) {
    try {
      if (!node.href || typeof node.href !== 'string' || !node.href.startsWith('/watch/'))
        return null
      const slug = node.href.split('/watch/')[1]
      if (!slug) return null

      if (!slug.includes('-') && slug.length > 12) return null

      const props = { slug, title: 'Unknown', cover: '', type: 'TV' }
      const coverNodes = deepSearch(
        node,
        (o) =>
          !!(
            (o?.cover &&
              typeof o.cover === 'object' &&
              (typeof o.cover.extraLarge === 'string' ||
                typeof o.cover.large === 'string' ||
                typeof o.cover.medium === 'string')) ||
            typeof o?.image === 'string' ||
            typeof o?.bannerImage === 'string'
          )
      )
      const coverNode = coverNodes[0]
      if (coverNode?.cover && typeof coverNode.cover === 'object') {
        const c = coverNode.cover
        props.cover = c.extraLarge || c.large || c.medium || ''
      }
      if (!props.cover && typeof coverNode?.image === 'string') props.cover = coverNode.image
      if (!props.cover && typeof coverNode?.bannerImage === 'string')
        props.cover = coverNode.bannerImage

      const titleNodes = deepSearch(
        node,
        (o) =>
          !!(
            (o?.title &&
              typeof o.title === 'object' &&
              (typeof o.title.english === 'string' ||
                typeof o.title.romaji === 'string' ||
                typeof o.title.native === 'string')) ||
            typeof o?.name === 'string'
          )
      )
      const titleNode = titleNodes[0]
      if (titleNode?.title && typeof titleNode.title === 'object') {
        const t = titleNode.title
        props.title = t.english || t.romaji || t.native || 'Unknown'
      } else if (typeof titleNode?.name === 'string') {
        props.title = titleNode.name
      }

      if (!props.title || props.title === 'Unknown') {
        const potentialTitles = deepSearch(node, (o) => typeof o?.children === 'string')
        if (potentialTitles.length > 0) {
          props.title = potentialTitles[0].children
        }
      }

      if (!props.cover) {
        const serialized = JSON.stringify(node).replace(/\\\//g, '/')
        const m = serialized.match(/https?:\/\/[^"\s]+anilistcdn[^"\s]+\.(?:jpg|jpeg|png|webp)/i)
        if (m) props.cover = m[0]
      }

      const badgeNodes = deepSearch(
        node,
        (o) => !!(o?.['data-slot'] === 'badge' && Array.isArray(o?.children))
      )
      if (badgeNodes.length > 0) {
        const bn = badgeNodes[0]
        const count = bn.children.find((c) => typeof c === 'number')
        if (typeof count === 'number') props.episodes = count
      }
      if (!props.cover && !props.title) return null
      return props
    } catch {
      return null
    }
  }

  function cleanText(value) {
    return (value || '').replace(/\s+/g, ' ').trim()
  }

  function collectSubtitleTracks(value, fallbackLang = 'Subtitles') {
    const collected = []
    const seen = new Set()

    const walk = (node, inheritedLang) => {
      if (!node) return
      if (Array.isArray(node)) {
        for (const item of node) walk(item, inheritedLang)
        return
      }
      if (typeof node !== 'object') return

      const record = node
      const url = record.url ||
        record.src ||
        record.file ||
        record.subtitleUrl ||
        record.subUrl
      if (typeof url === 'string' && url.trim()) {
        const lang =
          String(
            record.lang || record.language || record.label || inheritedLang || fallbackLang
          ).trim() || fallbackLang
        const label = String(record.label || record.name || lang).trim() || lang
        const key = `${lang}|${label}|${url}`.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          collected.push({
            label,
            url: url.trim(),
            lang,
            kind: record.kind,
            file: typeof record.file === 'string' ? record.file.trim() : url.trim(),
          })
        }
      }

      for (const key of ['subtitles', 'subtitle', 'tracks', 'captions']) {
        const child = record[key]
        if (child)
          walk(
            child,
            String(record.lang || record.language || record.label || inheritedLang || fallbackLang)
          )
      }
    }

    walk(value)
    return collected
  }

  async function search(options) {
    const query = options.query || ''
    if (!query) return []

    const performSearch = async (q) => {
      const url = `https://animeya.cc/browser?search=${encodeURIComponent(q)}`
      const res = await fetchRetry(url)

      const html = await res.text()
      const rscMap = parseRSCStream(html)

      const results = []
      const seen = new Set()

      for (const rawObj of rscMap.values()) {
        const obj = resolveRSC(rawObj, rscMap)
        const mediasLists = deepSearch(obj, (o) => Array.isArray(o?.medias))
        for (const listNode of mediasLists) {
          const medias = listNode.medias
          for (const media of medias) {
            const slug = media.slug
            if (slug && !seen.has(slug)) {
              if (!slug.includes('-') && slug.length > 12) continue

              seen.add(slug)
              const titleNode = media.title
              const title =
                titleNode?.english ||
                titleNode?.romaji ||
                titleNode?.native ||
                'Unknown'
              const coverNode = media.coverImage
              const cover =
                coverNode?.extraLarge ||
                coverNode?.large ||
                coverNode?.medium ||
                ''

              const episodeCount = media.episodeCount || media.episodes || 0
              const episodes = Array.from({ length: episodeCount }, (_, i) => String(i + 1))

              results.push({
                _id: slug,
                id: slug,
                name: title,
                englishName: title,
                thumbnail: cover,
                type: media.format || 'TV',
                availableEpisodesDetail: {
                  sub: episodes,
                  dub: episodes,
                },
              })
            }
          }
        }

        if (results.length === 0) {
          deepSearch(
            obj,
            (o) => !!(o?.href && typeof o.href === 'string' && o.href.startsWith('/watch/'))
          ).forEach((n) => {
            const c = extractCard(n)
            if (c && !seen.has(c.slug)) {
              seen.add(c.slug)
              const episodes = Array.from({ length: c.episodes || 1 }, (_, i) => String(i + 1))
              results.push({
                _id: c.slug,
                id: c.slug,
                name: c.title,
                englishName: c.title,
                thumbnail: c.cover,
                type: c.type || 'TV',
                availableEpisodesDetail: {
                  sub: episodes,
                  dub: episodes,
                },
              })
            }
          })
        }
      }
      return results
    }

    try {
      let results = await performSearch(query)

      if (results.length === 0 && (query.includes('Season') || query.includes('season'))) {
        const fallbackQuery = query
          .replace(/\s+(?:Season|season)\s+\d+/gi, '')
          .replace(/\s+\d+(?:st|nd|rd|th)\s+(?:Season|season)/gi, '')
          .trim()

        if (fallbackQuery && fallbackQuery !== query) {
          results = await performSearch(fallbackQuery)
        }
      }

      if (results.length === 0) {
        const fallbackQuery = query.split(/[:(-]/)[0].trim()
        if (fallbackQuery && fallbackQuery !== query) {
          results = await performSearch(fallbackQuery)
        }
      }

      if (results.length === 0) {
        const fallbackQuery = query
          .replace(/\s+(?:Season|season)\s+\d+/gi, '')
          .replace(/\s+\d+(?:st|nd|rd|th)\s+(?:Season|season)/gi, '')
          .split(/[:(-]/)[0]
          .trim()

        if (fallbackQuery && fallbackQuery !== query) {
          results = await performSearch(fallbackQuery)
        }
      }

      return results
    } catch (error) {
      log.error({ err: error }, 'Animeya search failed')
      return []
    }
  }

  async function getInfoInternal(slug) {
    const res = await fetchRetry(`https://animeya.cc/watch/${slug}`)
    const html = await res.text()
    const rscMap = parseRSCStream(html)

    const details = {
      id: slug,
      title: slug,
      cover: '',
      description: '',
      episodes: [],
    }
    const htmlTitle = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || ''
    const ogImage =
      html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1]?.trim() || ''
    const ogDescription =
      html
        .match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)?.[1]
        ?.trim() || ''
    const metaDescription =
      html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)?.[1]?.trim() || ''
    const notFoundPage =
      /404:\s*This page could not be found\./i.test(htmlTitle) ||
      /404:\s*This page could not be found\./i.test(html)

    for (const rawObj of rscMap.values()) {
      const obj = resolveRSC(rawObj, rscMap)
      const epLists = deepSearch(
        obj,
        (o) =>
          !!(
            Array.isArray(o) &&
            o.length > 0 &&
            typeof o[0]?.episodeNumber === 'number'
          )
      )

      if (epLists.length > 0) {
        for (const list of epLists) {
          details.episodes.push(
            ...list.map((ep) => ({
              id: ep.id,
              episodeNumber: ep.episodeNumber,
              title: ep.title,
              isFiller: ep.isFiller,
            }))
          )
        }
      }
      if (details.title === slug && !notFoundPage) {
        const titleNodes = deepSearch(
          obj,
          (o) => !!(Array.isArray(o) && o[0] === '$' && o[1] === 'title')
        )
        if (titleNodes.length > 0) {
          const node = titleNodes[0][3]
          const t = node?.children
          if (t) details.title = t.replace(' | Animeya', '')
        }
      }
      if (!details.cover) {
        const coverNodes = deepSearch(
          obj,
          (o) =>
            !!(
              o?.cover &&
              typeof o.cover === 'object' &&
              (typeof o.cover.large === 'string' ||
                typeof o.cover.extraLarge === 'string')
            )
        )
        const cn = coverNodes[0]
        if (cn?.cover && typeof cn.cover === 'object') {
          const c = cn.cover
          details.cover = c.extraLarge || c.large || ''
        }
      }
      if (!details.description) {
        const md = deepSearch(
          obj,
          (o) => !!(Array.isArray(o) && o[0] === '$' && o[1] === 'meta' && o[2] === 'description')
        )
        if (md.length > 0) {
          const node = md[0][3]
          details.description = node?.content || ''
        }
      }
    }
    const unique = new Map()
    details.episodes.forEach((ep) => unique.set(ep.episodeNumber, ep))
    details.episodes = Array.from(unique.values()).sort((a, b) => a.episodeNumber - b.episodeNumber)
    if (!details.cover && ogImage) details.cover = ogImage
    if (!details.description) {
      const jsonDesc = html.match(/"description"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i)?.[1]
      if (jsonDesc) {
        try {
          details.description = cleanText(JSON.parse(`"${jsonDesc}"`))
        } catch {
          details.description = cleanText(jsonDesc.replace(/\\n/g, ' '))
        }
      }
    }
    if (!details.description) {
      details.description = cleanText(ogDescription || metaDescription)
    }
    if (notFoundPage && details.episodes.length === 0) throw new Error('Status 404')
    return details
  }

  async function getEpisodeSourcesInternal(episodeId) {
    const trpcUrl = `https://animeya.cc/api/trpc/episode.getEpisodeFullById?batch=1&input=${encodeURIComponent(
      JSON.stringify({ '0': { json: parseInt(episodeId, 10) } })
    )}`
    const res = await fetchRetry(trpcUrl)
    const json = await res.json()
    const firstResult = json[0]
    const result = firstResult?.result
    const data = result?.data
    const episodeData = data?.json

    if (!episodeData) throw new Error('Episode not found')
    const sources = (episodeData.players || []).map((p) => ({
      name: p.name || 'Unknown',
      url: p.url,
      type: p.type || (p.url?.includes('.m3u8') ? 'HLS' : 'EMBED'),
      quality: p.quality || '720p',
      langue: p.langue || 'ENG',
      subType: p.subType || 'NONE',
    }))
    const subtitles = [
      ...collectSubtitleTracks(episodeData.subtitles),
      ...collectSubtitleTracks(episodeData.tracks),
      ...collectSubtitleTracks(episodeData.players),
      ...(Array.isArray(episodeData.players)
        ? episodeData.players.flatMap((player) =>
            collectSubtitleTracks(player?.subtitles || player?.tracks || player?.captions)
          )
        : []),
    ]
    return {
      episode: {
        id: episodeData.id,
        title: episodeData.title,
        number: episodeData.episodeNumber,
      },
      sources,
      subtitles,
    }
  }

  async function getEpisodes(showId) {
    try {
      const cacheKey = `animeya_eps_${showId}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      const info = await getInfoInternal(showId)
      if (!info || !info.episodes) return null

      const episodes = info.episodes.map((ep) => String(ep.episodeNumber))
      const result = {
        episodes,
        description: info.description || '',
      }

      cache.set(cacheKey, result, 3600)
      return result
    } catch (error) {
      log.error({ err: error, showId }, 'Animeya getEpisodes failed')
      return null
    }
  }

  async function getStreamUrls(showId, episodeNumber, mode) {
    try {
      const info = await getInfoInternal(showId)
      let episode = info.episodes.find((ep) => String(ep.episodeNumber) === episodeNumber)

      if (!episode && episodeNumber === '0') {
        episode = info.episodes.find((ep) => String(ep.episodeNumber) === '1')
      }

      if (!episode || !episode.id) return null

      const sourcesData = await getEpisodeSourcesInternal(String(episode.id))
      const processedSources = []

      for (const source of sourcesData.sources) {
        const subType = (source.subType || '').toUpperCase()
        const langue = (source.langue || '').toUpperCase()

        const isDub = subType === 'DUB' || (subType === 'NONE' && langue === 'ENG')

        if (mode === 'dub' && !isDub) continue
        if (mode === 'sub' && isDub) continue

        if (source.type === 'HLS' || source.url.includes('.m3u8')) {
          processedSources.push({
            sourceName: source.name,
            type: 'player',
            links: [
              {
                resolutionStr: source.quality || 'Auto',
                link: source.url,
                hls: true,
                headers: {
                  Referer: 'https://animeya.cc',
                  'User-Agent': UA,
                },
              },
            ],
            subtitles: sourcesData.subtitles.map((s) => ({
              language: s.lang || 'English',
              label: s.label || 'English',
              url: s.url,
            })),
            actualEpisodeNumber: String(episode.episodeNumber),
          })
        } else if (source.name === 'Mp4') {
          try {
            const embedHtml = await fetchText(source.url, 'https://animeya.cc/')
            const match = embedHtml.match(/src:\s*"(https:\/\/.*?\.mp4)"/)
            if (match) {
              processedSources.push({
                sourceName: source.name,
                type: 'player',
                links: [
                  {
                    resolutionStr: 'Default',
                    link: match[1],
                    hls: false,
                    headers: { Referer: 'https://www.mp4upload.com/' },
                  },
                ],
                subtitles: sourcesData.subtitles.map((s) => ({
                  language: s.lang || 'English',
                  label: s.label || 'English',
                  url: s.url,
                })),
                actualEpisodeNumber: String(episode.episodeNumber),
              })
            } else {
              processedSources.push({
                sourceName: source.name,
                type: 'iframe',
                links: [{ resolutionStr: 'iframe', link: source.url, hls: false }],
                actualEpisodeNumber: String(episode.episodeNumber),
              })
            }
          } catch {
            processedSources.push({
              sourceName: source.name,
              type: 'iframe',
              links: [{ resolutionStr: 'iframe', link: source.url, hls: false }],
              actualEpisodeNumber: String(episode.episodeNumber),
            })
          }
        } else if (source.name === 'Ok') {
          processedSources.push({
            sourceName: source.name,
            type: 'iframe',
            links: [{ resolutionStr: 'iframe', link: source.url, hls: false }],
            actualEpisodeNumber: String(episode.episodeNumber),
          })
        } else if (
          source.type === 'EMBED' ||
          source.url.includes('iframe') ||
          source.url.includes('embed')
        ) {
          try {
            const extracted = await extractEpisodeHls(source.url)
            if (extracted && extracted.hls && extracted.hls.length > 0) {
              processedSources.push({
                sourceName: `${source.name} (Extracted)`,
                type: 'player',
                links: extracted.hls.map((hlsUrl) => ({
                  resolutionStr: 'Auto',
                  link: hlsUrl,
                  hls: true,
                  headers: extracted.headers,
                })),
                subtitles: sourcesData.subtitles.map((s) => ({
                  language: s.lang || 'English',
                  label: s.label || 'English',
                  url: s.url,
                })),
                actualEpisodeNumber: String(episode.episodeNumber),
              })
            } else {
              processedSources.push({
                sourceName: source.name,
                type: 'iframe',
                links: [
                  {
                    resolutionStr: 'iframe',
                    link: source.url,
                    hls: false,
                  },
                ],
                actualEpisodeNumber: String(episode.episodeNumber),
              })
            }
          } catch {
            processedSources.push({
              sourceName: source.name,
              type: 'iframe',
              links: [
                {
                  resolutionStr: 'iframe',
                  link: source.url,
                  hls: false,
                },
              ],
              actualEpisodeNumber: String(episode.episodeNumber),
            })
          }
        }
      }

      return processedSources.length > 0 ? processedSources : null
    } catch (error) {
      log.error({ err: error, showId, episodeNumber }, 'Animeya getStreamUrls failed')
      return null
    }
  }

  async function resolveShowId(title, romaji, mode) {
    const targets = [title, romaji].filter((t) => !!t && t.trim().length > 0)
    if (targets.length === 0) return null

    for (const variant of ctx.titleMatch.buildQueryVariants(title, romaji)) {
      let results
      try {
        results = await search({ query: variant })
      } catch {
        continue
      }
      if (results.length === 0) continue

      const candidates = results.map((r) => ({
        title: r.name || r.englishName || '',
        id: r.id || r._id || '',
      }))

      const matchResult = ctx.titleMatch.pickBestMatch(candidates, targets)
      if (matchResult) return matchResult.item.id
    }

    return null
  }

  return {
    name: 'Animeya',
    search,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
  }
}
