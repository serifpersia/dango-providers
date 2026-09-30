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
      const $ = ctx.cheerio.load(html)

      const results = []
      const seen = new Set()

      $('a[href^="/watch/"]').each((_, a) => {
        const slug = ($(a).attr('href') || '').split('/watch/')[1]?.split(/[?#]/)[0]
        if (!slug || seen.has(slug)) return
        if (!slug.includes('-') && slug.length > 12) return
        seen.add(slug)
        const img = $(a).find('img').first()
        const title =
          img.attr('alt')?.trim() || $(a).find('h3').first().text().trim() || 'Unknown'
        const cover = img.attr('src') || ''
        const count = parseInt($(a).find('[data-slot="badge"]').first().text().trim(), 10)
        const type = $(a).find('p.ml-auto').first().text().trim() || 'TV'
        const episodes = Array.from(
          { length: Number.isFinite(count) && count > 0 ? count : 1 },
          (_, i) => String(i + 1)
        )
        results.push({
          _id: slug,
          id: slug,
          name: title,
          englishName: title,
          thumbnail: cover,
          type,
          availableEpisodesDetail: {
            sub: episodes,
            dub: episodes,
          },
        })
      })
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

    try {
      const pageSize = 200
      let epTotal = 0
      for (let page = 1; ; page++) {
        const trpcUrl = `https://animeya.cc/api/trpc/episode.getAllEpisodesByMediaSlugWithPagination?batch=1&input=${encodeURIComponent(
          JSON.stringify({ 0: { json: { slug, page, pageSize } } })
        )}`
        const tRes = await fetchRetry(trpcUrl)
        const tData = (await tRes.json())?.[0]?.result?.data?.json
        const eps = Array.isArray(tData?.eps) ? tData.eps : []
        epTotal = Number(tData?.epsCount) || epTotal
        for (const ep of eps) {
          details.episodes.push({
            id: ep.id,
            episodeNumber: ep.episodeNumber,
            title: ep.title,
            isFiller: ep.isFiller,
          })
        }
        if (eps.length < pageSize || (epTotal > 0 && details.episodes.length >= epTotal)) break
      }
    } catch {
    }
    if (details.episodes.length === 0) {
      const epRe =
        /\\"id\\":(\d+),\\"isFiller\\":(true|false),\\"episodeNumber\\":(\d+),\\"title\\":\\"((?:[^"\\]|\\.)*)\\"/g
      let epMatch
      while ((epMatch = epRe.exec(html)) !== null) {
        let epTitle = epMatch[4]
        try {
          epTitle = JSON.parse(`"${epTitle}"`)
        } catch {
          epTitle = epTitle.replace(/\\n/g, ' ')
        }
        details.episodes.push({
          id: Number(epMatch[1]),
          episodeNumber: Number(epMatch[3]),
          title: epTitle,
          isFiller: epMatch[2] === 'true',
        })
      }
    }
    if (htmlTitle && !notFoundPage) details.title = htmlTitle.replace(/\s*\|\s*Animeya\s*$/i, '')
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

  async function resolveShowId(title, romaji) {
    return ctx.resolveBestShowId(title, romaji, async (variant) => {
      const results = await search({ query: variant })
      return results.map((r) => ({
        title: r.name || r.englishName || '',
        id: r.id || r._id || '',
      }))
    })
  }

  return {
    name: 'Animeya',
    search,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
  }
}
