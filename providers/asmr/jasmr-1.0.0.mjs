const BASE_URL = 'https://japaneseasmr.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

function parseRatingFromClasses(classAttr) {
  const classes = ` ${classAttr} `
  if (classes.includes(' category-sfw ')) return { rating: 'SFW', isAdult: false }
  if (classes.includes(' category-r-15 ')) return { rating: 'R-15', isAdult: false }
  if (classes.includes(' category-maniax ')) return { rating: 'R-18', isAdult: true }
  return { rating: '', isAdult: true }
}

function decodeEntities(text) {
  return text
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code) => {
      try {
        if (code.startsWith('#x') || code.startsWith('#X')) {
          return String.fromCodePoint(parseInt(code.slice(2), 16))
        }
        if (code.startsWith('#')) {
          return String.fromCodePoint(parseInt(code.slice(1), 10))
        }
        const entities = {
          amp: '&',
          lt: '<',
          gt: '>',
          quot: '"',
          apos: "'",
          nbsp: ' ',
          hellip: '\u2026',
          mdash: '\u2014',
          ndash: '\u2013',
        }
        const lower = code.toLowerCase()
        return entities[lower] ?? match
      } catch {
        return match
      }
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function isCloudflareChallenge(status, text) {
  if (status === 403 || status === 503) return true
  if (/Just a moment/i.test(text)) return true
  if (/challenge-platform\/h\//i.test(text)) return true
  return false
}

function parseArchivePosts(html) {
  const works = []
  const seen = new Set()
  const chunks = html.split('<li class="site-archive-post').slice(1)
  for (const rawChunk of chunks) {
    const classEnd = rawChunk.indexOf('">')
    const classAttr = classEnd === -1 ? '' : rawChunk.slice(0, classEnd)
    const { rating, isAdult } = parseRatingFromClasses(classAttr)
    const end = rawChunk.indexOf('</li>')
    const chunk = end === -1 ? rawChunk : rawChunk.slice(0, end)
    const titleMatch = chunk.match(
      /<h2 class="entry-title"><a href="([^"]+)">([\s\S]*?)<\/a><\/h2>/
    )
    if (!titleMatch) continue
    const postUrl = titleMatch[1]
    const postIdMatch = postUrl.match(/\/(\d+)\/?/)
    if (!postIdMatch) continue
    const thumbMatch = chunk.match(/data-src="(https:\/\/pic\.weeabo0\.xyz\/[^"]+?)"/)
    let rjCode = ''
    if (thumbMatch) {
      const rjFromThumb = thumbMatch[1].match(/RJ\d{5,}/i)
      if (rjFromThumb) rjCode = rjFromThumb[0].toUpperCase()
    }
    if (!rjCode) {
      const rjFromText = chunk.match(/\[(RJ\d{5,})\]/i)
      if (rjFromText) rjCode = rjFromText[1].toUpperCase()
    }
    if (!rjCode) continue
    const cvMatch = chunk.match(/CV:\s*([^<]+)</)
    const metaMatch = chunk.match(/\[(\d{6})\]\[([^\]]+)\]/)
    const work = {
      rjCode,
      postId: postIdMatch[1],
      title: decodeEntities(titleMatch[2]),
      thumbnail: thumbMatch ? thumbMatch[1] : '',
      cv: cvMatch ? decodeEntities(cvMatch[1]) : undefined,
      circle: metaMatch ? decodeEntities(metaMatch[2]) : undefined,
      releaseDate: metaMatch ? metaMatch[1] : undefined,
      rating,
      isAdult,
    }
    if (seen.has(work.rjCode)) continue
    seen.add(work.rjCode)
    works.push(work)
  }
  return works
}

function hasNextPage(html, page) {
  return html.includes(`/${page + 1}/"`) || html.includes(`/page/${page + 1}/`)
}

const ARCHIVE_PATHS = {
  sfw: 'category/rating/sfw',
  'r-15': 'category/rating/r-15',
  'r-18': 'category/rating/maniax',
  yuri: 'tag/yuri-girls-love',
  otokonoko: 'category/otokonoko',
  futanari: 'category/futanari',
  'r-18g': 'category/rating/extreme',
}

function buildArchiveUrl(query, page, sort, archiveKey) {
  const params = new URLSearchParams()
  if (query) params.set('s', query)
  switch (sort) {
    case 'oldest':
      params.set('orderby', 'date')
      params.set('order', 'asc')
      break
    case 'title_asc':
      params.set('orderby', 'title')
      params.set('order', 'asc')
      break
    case 'title_desc':
      params.set('orderby', 'title')
      params.set('order', 'desc')
      break
    case 'popular_recent':
      params.set('orderby', 'post_views')
      params.set('order', 'desc')
      params.set('date', 'recent')
      break
    case 'popular_week':
      params.set('orderby', 'post_views')
      params.set('order', 'desc')
      params.set('date', 'week')
      break
    case 'popular_month':
      params.set('orderby', 'post_views')
      params.set('order', 'desc')
      params.set('date', 'month')
      break
    case 'popular_6_months':
      params.set('orderby', 'post_views')
      params.set('order', 'desc')
      params.set('date', '6_months')
      break
    case 'popular_year':
      params.set('orderby', 'post_views')
      params.set('order', 'desc')
      params.set('date', 'year')
      break
    case 'popular':
      params.set('orderby', 'post_views')
      params.set('order', 'desc')
      break
    case 'comments_week':
      params.set('orderby', 'comment_count')
      params.set('order', 'desc')
      params.set('date', 'week')
      break
    case 'comments_month':
      params.set('orderby', 'comment_count')
      params.set('order', 'desc')
      params.set('date', 'month')
      break
    case 'comments_year':
      params.set('orderby', 'comment_count')
      params.set('order', 'desc')
      params.set('date', 'year')
      break
    case 'comments':
      params.set('orderby', 'comment_count')
      params.set('order', 'desc')
      break
    case 'random':
      params.set('orderby', 'rand')
      break
    default:
      break
  }
  const queryString = params.toString()
  const archivePath = archiveKey ? ARCHIVE_PATHS[archiveKey] : undefined
  const basePath = archivePath ? `${BASE_URL}/${archivePath}` : BASE_URL
  const pageSuffix = page > 1 ? `/page/${page}/` : '/'
  return queryString ? `${basePath}${pageSuffix}?${queryString}` : `${basePath}${pageSuffix}`
}

function parseTags(html) {
  const matches = Array.from(
    html.matchAll(/<a href="https:\/\/japaneseasmr\.com\/tag\/[^"]+"[^>]*>([^<]+)<\/a>/g)
  ).map((m) => decodeEntities(m[1]))
  return Array.from(new Set(matches)).slice(0, 15)
}

function parseChapters(html) {
  const table =
    html.match(/id="plyr-chapter-playlist"[\s\S]*?<\/table>/)?.[0] ??
    html.match(/id="basic-chapter-playlist"[\s\S]*?<\/table>/)?.[0] ??
    ''
  const chapters = []
  const seen = new Set()
  const re =
    /data-value="(\d+)"[^>]*>[^<]*<\/a>\s*<\/td>\s*<td class="chapter_list chapter_title">\s*<a[^>]*?data-track-title="([^"]*)"/g
  for (const m of html.matchAll(re)) {
    const time = parseInt(m[1], 10)
    const label = decodeEntities(m[2])
    if (!Number.isFinite(time) || !label) continue
    const key = `${time}|${label}`
    if (seen.has(key)) continue
    seen.add(key)
    chapters.push({ time, label })
  }
  return chapters
}

export default function createProvider(ctx) {
  const cache = ctx.cache
  const log = ctx.logger

  async function fetchText(url) {
    const ua = ctx.request.get('jasmr_ua') || UA
    const rawCookie = ctx.request.get('jasmr_cookie')
    const cookieHeader = rawCookie ? ctx.cookies.buildCfClearanceCookie(rawCookie) : ''
    const res = await fetch(url, {
      headers: {
        'User-Agent': ua,
        Referer: `${BASE_URL}/`,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    if (res.status !== 200 || isCloudflareChallenge(res.status, text)) {
      if (isCloudflareChallenge(res.status, text)) {
        throw Object.assign(new Error('AUTH_REQUIRED'), { status: 403 })
      }
      throw new Error(`HTTP ${res.status}: ${url}`)
    }
    return text
  }

  function toProxyImage(url) {
    if (!url) return ''
    const cookie = ctx.request.get('jasmr_cookie')
    const ua = ctx.request.get('jasmr_ua')
    let u = `/api/image-proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(
      `${BASE_URL}/`
    )}`
    if (cookie) u += `&cookie=${encodeURIComponent(cookie)}`
    if (ua) u += `&ua=${encodeURIComponent(ua)}`
    return u
  }

  function toShow(work) {
    return {
      _id: work.rjCode,
      id: work.rjCode,
      name: work.title,
      englishName: work.title,
      nativeName: work.title,
      thumbnail: toProxyImage(work.thumbnail),
      description: [
        work.circle ? `Circle: ${work.circle}` : '',
        work.cv ? `CV: ${work.cv}` : '',
        work.releaseDate ? `Released: ${work.releaseDate}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      type: 'TV',
      rating: work.rating || (work.isAdult ? 'R-18' : ''),
      isAdult: work.isAdult,
      availableEpisodesDetail: { sub: ['1'], dub: [] },
      availableEpisodes: { sub: 1 },
    }
  }

  async function fetchArchive(query, page, sort, archiveKey) {
    const url = buildArchiveUrl(query, page, sort, archiveKey)
    const html = await fetchText(url)
    return { works: parseArchivePosts(html), hasNext: hasNextPage(html, page) }
  }

  async function browse(options) {
    try {
      const query = (options.query || '').trim()
      const page = options.page && options.page > 0 ? options.page : 1
      const sort = options.sort || undefined
      const archiveKey =
        options.rating && ARCHIVE_PATHS[options.rating] ? options.rating : undefined
      const noCache = sort === 'random'
      const cacheKey = `jasmr_browse_${query || '__latest__'}_${page}_${sort || '__default__'}_${
        archiveKey || '__all__'
      }`
      if (!noCache) {
        const cached = cache.get(cacheKey)
        if (cached) return cached
      }
      const { works, hasNext } = await fetchArchive(query, page, sort, archiveKey)
      const result = { shows: works.map(toShow), hasNext }
      if (!noCache) cache.set(cacheKey, result, 300)
      return result
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') throw error
      log.error({ error }, '[JAsmr] Browse failed')
      return { shows: [], hasNext: false }
    }
  }

  async function search(options) {
    const { shows } = await browse(options)
    return shows
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

  async function getWorkMeta(rjCode) {
    const cacheKey = `jasmr_meta_${rjCode}`
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const html = await fetchText(`${BASE_URL}/?s=${encodeURIComponent(rjCode)}`)
    const work = parseArchivePosts(html).find((w) => w.rjCode === rjCode) || null
    if (work) cache.set(cacheKey, work, 3600)
    return work
  }

  async function getPostHtml(rjCode) {
    const meta = await getWorkMeta(rjCode)
    if (!meta) return null
    const cacheKey = `jasmr_post_${meta.postId}`
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const html = await fetchText(`${BASE_URL}/${meta.postId}/`)
    cache.set(cacheKey, html, 600)
    return html
  }

  async function getEpisodes(showId, mode) {
    try {
      const rjCode = showId.trim().toUpperCase()
      if (!/^RJ\d{5,}$/.test(rjCode)) return null
      const cacheKey = `jasmr_eps_${rjCode}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      let description = ''
      try {
        const meta = await getWorkMeta(rjCode)
        if (meta) {
          description = [
            meta.circle ? `Circle: ${meta.circle}` : '',
            meta.cv ? `CV: ${meta.cv}` : '',
            meta.releaseDate ? `Released: ${meta.releaseDate}` : '',
          ]
            .filter(Boolean)
            .join('\n')
          const postHtml = await getPostHtml(rjCode)
          if (postHtml) {
            const tags = parseTags(postHtml)
            if (tags.length > 0) {
              description += `\nTags: ${tags.join(', ')}`
            }
          }
        }
      } catch (err) {
        log.warn({ err, rjCode }, '[JAsmr] Work meta lookup failed')
      }
      const result = { episodes: ['1'], description }
      cache.set(cacheKey, result, 1800)
      return result
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') throw error
      log.error({ error, showId }, '[JAsmr] getEpisodes failed')
      return null
    }
  }

  async function getImages(rjCodeRaw) {
    try {
      const rjCode = rjCodeRaw.trim().toUpperCase()
      if (!/^RJ\d{5,}$/.test(rjCode)) return []
      const cacheKey = `jasmr_images_${rjCode}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const postHtml = await getPostHtml(rjCode)
      if (!postHtml) return []
      const matches = Array.from(
        postHtml.matchAll(/href="(https:\/\/img\.weeabo0\.xyz\/[^"]+?\.(?:jpg|jpeg|png|webp))"/g)
      ).map((m) => m[1])
      const images = Array.from(new Set(matches))
        .filter((url) => !url.includes('_img_main'))
        .slice(0, 30)
        .map(toProxyImage)
      cache.set(cacheKey, images, 3600)
      return images
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') throw error
      log.error({ error, rjCode: rjCodeRaw }, '[JAsmr] getImages failed')
      return []
    }
  }

  async function getChapters(rjCodeRaw) {
    try {
      const rjCode = rjCodeRaw.trim().toUpperCase()
      if (!/^RJ\d{5,}$/.test(rjCode)) return []
      const cacheKey = `jasmr_chapters_${rjCode}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const postHtml = await getPostHtml(rjCode)
      if (!postHtml) return []
      const chapters = parseChapters(postHtml)
      cache.set(cacheKey, chapters, 3600)
      return chapters
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') throw error
      log.error({ error, rjCode: rjCodeRaw }, '[JAsmr] getChapters failed')
      return []
    }
  }

  async function getStreamUrls(showId, episodeNumber, mode) {
    try {
      const rjCode = showId.trim().toUpperCase()
      if (!/^RJ\d{5,}$/.test(rjCode)) {
        log.warn({ showId }, '[JAsmr] Invalid RJ code')
        return null
      }
      const cacheKey = `jasmr_stream_${rjCode}_${episodeNumber}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const meta = await getWorkMeta(rjCode)
      if (!meta) {
        log.warn({ rjCode }, '[JAsmr] Could not resolve post page')
        return null
      }
      const html = (await getPostHtml(rjCode)) || ''
      const jasmrCookie = ctx.request.get('jasmr_cookie')
      const jasmrUa = ctx.request.get('jasmr_ua')
      const toProxy = (rawUrl) => {
        let u = `/api/proxy?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(
          `${BASE_URL}/`
        )}`
        if (jasmrCookie) u += `&cookie=${encodeURIComponent(jasmrCookie)}`
        if (jasmrUa) u += `&ua=${encodeURIComponent(jasmrUa)}`
        return u
      }
      const links = []
      const m3u8Match = html.match(/<source src="(https:\/\/v\.weeab0o\.xyz\/[^"]+\.m3u8)"/)
      const audioSrcMatch = html.match(/audioSrc\s*=\s*'(https:\/\/[^']+\.m3u8)'/)
      const streamUrl = m3u8Match?.[1] || audioSrcMatch?.[1]
      if (streamUrl) {
        links.push({ resolutionStr: 'Audio', link: toProxy(streamUrl), hls: true })
      } else {
        const mp3Matches = Array.from(
          html.matchAll(/<source src="(https:\/\/v\.weeab0o\.xyz\/[^"]+\.mp3)"/g)
        ).map((m) => m[1])
        const uniqueMp3s = Array.from(new Set(mp3Matches))
        if (uniqueMp3s.length === 0) {
          log.warn(
            { rjCode, postId: meta.postId },
            '[JAsmr] No audio sources found on post page'
          )
          return null
        }
        uniqueMp3s.forEach((mp3Url, i) => {
          links.push({ resolutionStr: `Track ${i + 1}`, link: toProxy(mp3Url), hls: false })
        })
      }
      const result = [
        {
          sourceName: 'JAsmr',
          links,
          type: 'player',
          actualEpisodeNumber: episodeNumber || '1',
        },
      ]
      cache.set(cacheKey, result, 3600)
      return result
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') throw error
      log.error({ error, showId, episodeNumber }, '[JAsmr] getStreamUrls failed')
      return null
    }
  }

  return {
    name: 'JAsmr',
    search,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
    browse,
    getImages,
    getChapters,
  }
}
