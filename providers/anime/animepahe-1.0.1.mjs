export default function createProvider(ctx) {
  const cache = ctx.cache
  const log = ctx.logger
  const BASE_URL = 'https://animepahe.pw'
  const API_URL = 'https://animepahe.pw/api'

  async function getRequestHeaders(isApi = false, customUaOverride, customCookieOverride) {
    const customUa = customUaOverride || ctx.request.get('ua')
    const customCookie = customCookieOverride || ctx.request.get('cookie')

    const userAgent =
      customUa ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
    let cookieStr = ''

    if (customCookie) {
      let sanitized = customCookie.trim()
      sanitized = sanitized.replace(/^cf_clearance/i, '')
      sanitized = sanitized.replace(/^[:=]\s*/, '')
      sanitized = sanitized.replace(/["']/g, '').trim()

      cookieStr = `cf_clearance=${sanitized}`
    }

    const headers = {
      'User-Agent': userAgent,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: `${BASE_URL}/`,
      Origin: BASE_URL,
      Cookie: cookieStr,
    }

    if (isApi) {
      headers['X-Requested-With'] = 'XMLHttpRequest'
      headers['Accept'] = 'application/json, text/javascript, */*; q=0.01'
    }

    return headers
  }

  async function fetchText(url, isApi = false, ua, cookie) {
    const headers = await getRequestHeaders(isApi, ua, cookie)
    for (let attempt = 0; ; attempt++) {
      let response
      try {
        response = await ctx.scraping.fetch(url, {
          method: 'GET',
          headers,
          responseType: 'text',
        })
      } catch (error) {
        if (error.message === 'AUTH_REQUIRED') throw error
        log.error({ url, error: error.message }, 'AnimePahe Fetch failed')
        throw error
      }

      const text = response.body

      if (response.statusCode === 200) return text
      if (response.statusCode === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        continue
      }
      if (response.statusCode === 429) {
        const error = new Error('HTTP 429')
        log.error({ url, error: error.message }, 'AnimePahe rate limited')
        throw error
      }
      if (response.statusCode === 403 || text.includes('Cloudflare')) {
        const error = new Error('AUTH_REQUIRED')
        error.status = 403
        throw error
      }
      const error = new Error(`HTTP ${response.statusCode}`)
      log.error({ url, error: error.message }, 'AnimePahe Fetch failed')
      throw error
    }
  }

  async function fetchJson(url, ua, cookie) {
    const data = await fetchText(url, true, ua, cookie)
    try {
      return JSON.parse(data)
    } catch {
      log.error({ url }, 'Failed to parse AnimePahe JSON')
      return null
    }
  }

  async function search(options) {
    try {
      const q = options.query || ''
      const url = `${API_URL}?m=search&q=${encodeURIComponent(q)}`
      const data = await fetchJson(url)
      if (!data) return []

      const items = data.data || data.results || data.items || []
      return items.map((a) => ({
        _id: a.session,
        id: a.session,
        name: a.title || a.name || '',
        englishName: a.title,
        thumbnail: a.poster || a.image,
        type: a.type,
        year: a.year,
        session: a.session,
      }))
    } catch (e) {
      if (e.message === 'AUTH_REQUIRED') throw e
      return []
    }
  }

  async function getEpisodes(showId, _mode, ua, cookie) {
    try {
      const firstPageUrl = `${API_URL}?m=release&id=${showId}&sort=episode_asc&page=1`
      const firstPageData = await fetchJson(firstPageUrl, ua, cookie)
      if (!firstPageData) return null

      let episodes = firstPageData.data || firstPageData.results || []
      const lastPage = Number(firstPageData.last_page || firstPageData.lastPage || 1)

      for (let p = 2; p <= lastPage; p++) {
        const pageUrl = `${API_URL}?m=release&id=${showId}&sort=episode_asc&page=${p}`
        const pageData = await fetchJson(pageUrl, ua, cookie)
        if (pageData) {
          episodes = episodes.concat(pageData.data || pageData.results || [])
        }
      }

      const episodeMap = {}
      const epDetails = []

      episodes.forEach((ep) => {
        const epNum = (ep.episode ?? ep.number ?? '').toString()
        if (epNum) {
          episodeMap[epNum] = ep.session || ep.release_session || ''
          epDetails.push({ number: epNum, title: ep.title })
        }
      })

      cache.set(`animepahe_epmap_${showId}`, episodeMap, 86400)

      return {
        episodes: epDetails
          .sort((a, b) => Number(a.number) - Number(b.number))
          .map((e) => e.number),
        availableEpisodesDetail: epDetails,
        description: '',
      }
    } catch (e) {
      if (e.message === 'AUTH_REQUIRED') throw e
      return null
    }
  }

  async function getEpisodeSession(showId, episodeNumber) {
    const cacheKey = `animepahe_epmap_${showId}`
    let cachedMap = cache.get(cacheKey)

    if (!cachedMap) {
      await getEpisodes(showId, 'sub')
      cachedMap = cache.get(cacheKey)
    }

    if (!cachedMap) return null
    if (cachedMap[episodeNumber]) return cachedMap[episodeNumber]

    const target = parseFloat(episodeNumber)
    const keys = Object.keys(cachedMap)

    for (const key of keys) {
      if (parseFloat(key) === target) return cachedMap[key]
    }

    const sorted = keys.sort((a, b) => Number(a) - Number(b))
    const first = Number(sorted[0])

    if (target < first) {
      const idx = Math.floor(target) - 1
      if (idx >= 0 && idx < sorted.length) return cachedMap[sorted[idx]]
    }

    return null
  }

  async function getStreamUrls(showId, episodeNumber, mode) {
    try {
      const epSession = await getEpisodeSession(showId, episodeNumber)
      if (!epSession) return null

      const sources = await getSources(showId, epSession)
      const modeTag = mode.toUpperCase()

      const isDubSource = (audio) => audio.includes('eng') || audio.includes('dub')

      const rawCookie = ctx.request.get('cookie') || ''
      const reqUa = ctx.request.get('ua')
      const cookieValue = ctx.cookies.sanitizeCfClearance(rawCookie)

      const matched = sources.filter((src) => {
        const audio = (src.audio || '').toLowerCase()
        return (isDubSource(audio) ? 'dub' : 'sub') === mode
      })
      if (matched.length === 0) return null

      const variantLabel = (src) => {
        const quality = src.quality || 'Auto'
        return src.fansub ? `${quality} · ${src.fansub}` : quality
      }

      const embedLinkFor = (src) =>
        cookieValue
          ? `/api/embed-proxy?url=${encodeURIComponent(src.url)}&cookie=${encodeURIComponent(cookieValue)}`
          : `/api/embed-proxy?url=${encodeURIComponent(src.url)}`

      const resolved = await Promise.all(
        matched.map(async (src) => {
          try {
            const r = await resolveKwik(src.url, reqUa, rawCookie)
            if (!r.m3u8) return null
            const directLink = cookieValue
              ? `/api/proxy?url=${encodeURIComponent(r.m3u8)}&referer=${encodeURIComponent(r.referer)}&cookie=${encodeURIComponent(cookieValue)}`
              : `/api/proxy?url=${encodeURIComponent(r.m3u8)}&referer=${encodeURIComponent(r.referer)}`
            return { src, directLink }
          } catch (e) {
            log.error(
              { url: src.url, error: e.message },
              '[AnimePahe] direct resolve failed'
            )
            return null
          }
        })
      )

      const byQualityDesc = (a, b) =>
        (parseInt(b.resolutionStr) || 0) - (parseInt(a.resolutionStr) || 0)

      const directLinks = resolved
        .filter((r) => r !== null)
        .map(({ src, directLink }) => ({
          resolutionStr: variantLabel(src),
          link: directLink,
          hls: true,
        }))
        .sort(byQualityDesc)

      const iframeLinks = matched
        .map((src) => ({
          resolutionStr: variantLabel(src),
          link: embedLinkFor(src),
          hls: false,
        }))
        .sort(byQualityDesc)

      const results = []
      if (directLinks.length > 0) {
        results.push({
          sourceName: `Direct (${modeTag})`,
          links: directLinks,
          type: 'player',
          actualEpisodeNumber: episodeNumber,
        })
      }
      if (iframeLinks.length > 0) {
        results.push({
          sourceName: `Fallback (${modeTag})`,
          links: iframeLinks,
          type: 'iframe',
          actualEpisodeNumber: episodeNumber,
        })
      }

      return results.length > 0 ? results : null
    } catch (e) {
      if (e.message === 'AUTH_REQUIRED') throw e
      return null
    }
  }

  async function getSources(animeSession, episodeSession) {
    try {
      const playUrl = `${BASE_URL}/play/${animeSession}/${episodeSession}`
      const html = await fetchText(playUrl)
      const $ = ctx.cheerio.load(html)

      const sources = []

      $('[data-src]').each((_, el) => {
        const src = $(el).attr('data-src')?.trim()
        if (!src || !/kwik/i.test(src)) return

        const res = $(el).attr('data-resolution') || $(el).attr('data-res')
        sources.push({
          url: src,
          quality: res ? (res.endsWith('p') ? res : `${res}p`) : null,
          fansub: $(el).attr('data-fansub') ?? null,
          audio: $(el).attr('data-audio') ?? null,
        })
      })

      const unique = Array.from(new Map(sources.map((s) => [s.url, s])).values())
      unique.sort((a, b) => {
        const qa = parseInt(a.quality || '0') || 0
        const qb = parseInt(b.quality || '0') || 0
        return qb - qa
      })

      return unique
    } catch {
      return []
    }
  }

  async function resolveKwik(kwikUrl, ua, cookie) {
    try {
      const headers = {
        'User-Agent':
          ua ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL,
      }

      const resp = await ctx.scraping.fetch({
        url: kwikUrl,
        method: 'GET',
        headers,
        responseType: 'text',
        timeout: { request: 30000 },
        followRedirect: true,
        throwHttpErrors: false,
      })
      if (resp.statusCode !== 200) {
        return { m3u8: '', referer: kwikUrl }
      }
      const html = resp.body

      let searchFrom = 0
      while (true) {
        const evalStart = html.indexOf('eval(function(p,a,c,k,e,d)', searchFrom)
        if (evalStart === -1) break
        let depth = 0
        let parenEnd = -1
        for (let i = evalStart + 4; i < html.length; i++) {
          if (html[i] === '(') depth++
          else if (html[i] === ')') {
            depth--
            if (depth === 0) {
              parenEnd = i
              break
            }
          }
        }
        if (parenEnd === -1) {
          searchFrom = evalStart + 1
          continue
        }
        try {
          const result = eval(html.slice(evalStart + 4, parenEnd + 1))
          if (typeof result === 'string') {
            const m = result.match(/source\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/)
            if (m) return { m3u8: m[1], referer: kwikUrl }
          }
        } catch {
        }
        searchFrom = parenEnd + 1
      }
      return { m3u8: '', referer: kwikUrl }
    } catch (e) {
      log.error({ kwikUrl, error: e.message }, '[AnimePahe] resolveKwik failed')
      return { m3u8: '', referer: kwikUrl }
    }
  }

  async function getShowMeta(showId, ua, cookie) {
    try {
      const url = `${BASE_URL}/anime/${showId}`
      const html = await fetchText(url, false, ua, cookie)

      const $ = ctx.cheerio.load(html)
      const metadata = {
        _id: showId,
        id: showId,
        names: {},
      }

      const cleanText = (text) => {
        if (!text) return null
        return text.replace(/\s+/g, ' ').trim()
      }

      const titleText =
        cleanText($('.anime-header h1 > span').text()) ||
        cleanText($('.anime-header h1').text()) ||
        ''
      metadata.name = titleText
      metadata.englishName = titleText
      metadata.names.english = titleText

      const romaji = cleanText($('.anime-header h2.japanese').text())
      if (romaji) {
        metadata.names.romaji = romaji
      }

      const posterDiv = $('.anime-poster')
      if (posterDiv.length) {
        const img = posterDiv.find('img')
        if (img.length) {
          metadata.thumbnail = img.attr('data-src') || img.attr('src')
        }
      }

      const synopsisDiv = $('.anime-synopsis')
      if (synopsisDiv.length) {
        metadata.description = cleanText(synopsisDiv.text()) || undefined
      }

      const infoBox = {}
      const infoDiv = $('.anime-info')
      if (infoDiv.length) {
        infoDiv.find('p').each((_, el) => {
          const p = $(el)
          const fullText = cleanText(p.text())
          if (!fullText) return

          const colonIdx = fullText.indexOf(':')
          if (colonIdx === -1) return

          const label = fullText.substring(0, colonIdx).trim()

          if (label === 'External Links' || label === 'Themes' || label === 'Demographic') {
            const items = []
            p.find('a').each((_, aEl) => {
              items.push({
                name: cleanText($(aEl).text()) || '',
                url: $(aEl).attr('href'),
              })
            })
            infoBox[label] = items
          } else {
            const value = fullText.substring(colonIdx + 1).trim()
            infoBox[label] = value
          }
        })
      }

      if (typeof infoBox['Japanese'] === 'string') {
        metadata.nativeName = infoBox['Japanese']
        metadata.names.native = infoBox['Japanese']
      }

      if (typeof infoBox['Synonyms'] === 'string') {
        metadata.names.synonyms = infoBox['Synonyms'].split(',').map((s) => s.trim())
      }

      if (typeof infoBox['Type'] === 'string') {
        metadata.type = infoBox['Type']
      }

      const epsStr =
        typeof infoBox['Episodes'] === 'string'
          ? infoBox['Episodes']
          : typeof infoBox['Episode'] === 'string'
            ? infoBox['Episode']
            : undefined
      if (epsStr && epsStr !== '?') {
        const parsedEps = parseInt(epsStr, 10)
        if (!isNaN(parsedEps)) {
          metadata.episodeCount = parsedEps
        }
      }

      if (typeof infoBox['Duration'] === 'string') {
        metadata.episodeDuration = infoBox['Duration']
      }
      if (typeof infoBox['Status'] === 'string') {
        metadata.status = infoBox['Status']
      }

      const parseDateStr = (dateStr) => {
        if (!dateStr) return null
        const parsed = Date.parse(dateStr)
        if (isNaN(parsed)) return null
        const dateObj = new Date(parsed)
        return {
          year: dateObj.getFullYear(),
          month: dateObj.getMonth(),
          date: dateObj.getDate(),
        }
      }

      const airedStr = typeof infoBox['Aired'] === 'string' ? infoBox['Aired'] : undefined
      if (airedStr) {
        const dates = airedStr.split(/\s+to\s+/)
        const start = parseDateStr(dates[0])
        if (start) {
          metadata.airedStart = start
        }
        if (dates[1] && dates[1] !== '?') {
          const end = parseDateStr(dates[1])
          if (end) {
            metadata.airedEnd = end
          }
        }
      }

      const seasonStr = typeof infoBox['Season'] === 'string' ? infoBox['Season'] : undefined
      if (seasonStr) {
        const parts = seasonStr.split(' ')
        const seasonName = parts[0]
        const yearMatch = seasonStr.match(/\d{4}/)
        const yearVal = yearMatch ? parseInt(yearMatch[0], 10) : undefined
        if (yearVal) {
          metadata.year = yearVal
        }
        metadata.season = {
          season: seasonName,
          year: yearVal,
        }
      } else if (typeof infoBox['Aired'] === 'string') {
        const yearMatch = infoBox['Aired'].match(/\d{4}/)
        if (yearMatch) {
          metadata.year = parseInt(yearMatch[0], 10)
        }
      }

      if (typeof infoBox['Studios'] === 'string') {
        metadata.studios = infoBox['Studios'].split(',').map((s) => ({ name: s.trim() }))
      }

      const themes = infoBox['Themes'] ?? []
      const demographic = infoBox['Demographic'] ?? []
      metadata.tags = [
        ...themes.map((t) => ({ name: t.name })),
        ...demographic.map((d) => ({ name: d.name })),
      ]

      const genreDiv = $('.anime-genre')
      if (genreDiv.length) {
        metadata.genres = genreDiv
          .find('a')
          .map((_, el) => ({ name: cleanText($(el).text()) || '' }))
          .get()
      }

      return metadata
    } catch (e) {
      if (e.message === 'AUTH_REQUIRED') throw e
      log.error({ showId, error: e.message }, 'Failed to fetch AnimePahe metadata')
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
    name: 'AnimePahe',
    search,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
    getShowMeta,
  }
}
