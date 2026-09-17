const BASE_URL = 'https://oppai.stream'
const SEARCH_URL = `${BASE_URL}/actions/search.php`
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: `${BASE_URL}/`,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  const isRedirect =
    res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308
  if (!res.ok && !isRedirect) throw new Error(`HTTP ${res.status}: ${url}`)
  return text
}

function parseSearchResults(html) {
  const entries = []
  const re =
    /<div\s+class='in-grid episode-shown'\s+id='([^']+)'[^>]*idgt='([^']+)'[^>]*folder='([^']+)'[^>]*ep='([^']+)'[^>]*name='([^']+)'[^>]*desc='([^']*)'[^>]*>[\s\S]*?<a\s+href='(https?:\/\/oppai\.stream\/watch\?e=[^']+)'/g
  let m
  while ((m = re.exec(html)) !== null) {
    entries.push({
      id: m[1],
      idgt: m[2],
      folder: m[3],
      ep: m[4],
      name: m[5],
      desc: m[6],
      watchUrl: m[7],
    })
  }
  return entries
}

function folderToTitleSlug(folder) {
  return folder
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function titleSlugToFolder(slug) {
  return slug.replace(/-/g, ' ')
}

export const OP_ORDERS = ['recent', 'popular', 'views', 'rating', 'random']

export const OP_TAGS = [
  '4k',
  'ahegao',
  'anal',
  'armpitmasturbation',
  'bdsm',
  'bigboobs',
  'blackhair',
  'blondehair',
  'blowjob',
  'bluehair',
  'bondage',
  'boobjob',
  'brownhair',
  'censored',
  'comedy',
  'cosplay',
  'cowgirl',
  'creampie',
  'darkskin',
  'demon',
  'doggy',
  'dominantgirl',
  'doublepenetration',
  'elf',
  'facial',
  'fantasy',
  'filmed',
  'footjob',
  'futanari',
  'gangbang',
  'glasses',
  'greenhair',
  'gyaru',
  'handjob',
  'harem',
  'hd',
  'incest',
  'inflation',
  'loli',
  'maid',
  'masturbation',
  'milf',
  'mindbreak',
  'mindcontrol',
  'missionary',
  'monster',
  'nekomimi',
  'ntr',
  'nurse',
  'old',
  'orgy',
  'pinkhair',
  'plot',
  'ponytail',
  'pov',
  'pregnant',
  'publicsex',
  'purplehair',
  'rape',
  'redhair',
  'reverserape',
  'rimjob',
  'scat',
  'schoolgirl',
  'shorthair',
  'shota',
  'smallboobs',
  'softcore',
  'succubus',
  'swimsuit',
  'teacher',
  'tentacle',
  'threesome',
  'toys',
  'uglybastard',
  'uncensored',
  'vanilla',
  'virgin',
  'whitehair',
  'x-ray',
  'yuri',
]

function buildSeriesMap(entries) {
  const map = new Map()
  for (const e of entries) {
    const key = e.folder.toLowerCase()
    const existing = map.get(key) || []
    existing.push(e)
    map.set(key, existing)
  }
  return map
}

function bestMatch(series, query) {
  if (!series.length) return null
  const q = query.toLowerCase().trim()
  let best = series[0]
  let bestScore = -1
  for (const item of series) {
    const title = item.title.toLowerCase()
    let score = 0
    if (title === q) score = 3
    else if (title.startsWith(q)) score = 2
    else if (title.includes(q)) score = 1
    if (score > bestScore) {
      bestScore = score
      best = item
      if (score === 3) break
    }
  }
  return { ...best, score: bestScore }
}

export default function createProvider(ctx) {
  const cache = ctx.cache
  const log = ctx.logger

  async function browse(options) {
    try {
      const query = (options.query || '').trim()
      const page = Math.max(1, options.page || 1)
      const limit = Math.min(50, Math.max(1, options.limit || 24))
      const order = OP_ORDERS.includes(options.order || '') ? options.order : 'recent'
      const genres = (options.genres || '').trim()
      const blacklist = (options.blacklist || '').trim()
      const studio = (options.studio || '').trim()
      const cacheKey = `op_browse_${query}_${page}_${limit}_${order}_${genres}_${blacklist}_${studio}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const params = new URLSearchParams({
        text: query,
        order,
        page: String(page),
        limit: String(limit),
        genres,
        blacklist,
        studio,
        ibt: '0',
        swa: '1',
      })
      const html = await fetchText(`${SEARCH_URL}?${params.toString()}`)
      const entries = parseSearchResults(html)
      const totalMatch = html.match(/amo='(\d+)'/)
      const total = totalMatch ? parseInt(totalMatch[1]) : entries.length
      const seriesMap = buildSeriesMap(entries)
      const shows = Array.from(seriesMap.entries()).map(([key, eps]) => {
        const sorted = [...eps].sort((a, b) => parseFloat(a.ep) - parseFloat(b.ep))
        const first = sorted[0]
        return {
          _id: key,
          id: key,
          name: first.name,
          englishName: first.name,
          thumbnail: `https://myspacecat.pictures/${encodeURIComponent(first.folder)}/thumbnail_${first.ep}.png`,
          type: 'TV',
          year: null,
          isAdult: true,
          availableEpisodesDetail: {
            sub: sorted.map((e) => e.ep),
            dub: [],
          },
        }
      })
      const output = { shows, total, hasMore: page * limit < total }
      cache.set(cacheKey, output, 300)
      return output
    } catch (error) {
      log.error({ error }, '[OP] Browse failed')
      return { shows: [], total: 0, hasMore: false }
    }
  }

  async function search(options) {
    try {
      const query = (options.query || '').trim()
      if (!query) return []
      const cacheKey = `op_search_${query}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const url = `${SEARCH_URL}?text=${encodeURIComponent(query)}&order=recent&page=1&limit=23&genres=&blacklist=&studio=&ibt=0&swa=1`
      const html = await fetchText(url)
      const entries = parseSearchResults(html)
      if (entries.length === 0) return []
      const seriesMap = buildSeriesMap(entries)
      const uniqueSeries = Array.from(seriesMap.entries()).map(([key, eps]) => ({
        title: eps[0].name,
        key,
      }))
      const match = bestMatch(uniqueSeries, query) || uniqueSeries[0]
      const episodes = seriesMap.get(match.key) || []
      const first = episodes[0]
      const sortedEps = episodes
        .sort((a, b) => parseFloat(a.ep) - parseFloat(b.ep))
        .map((e) => e.ep)
      const thumbnailUrl = `https://myspacecat.pictures/${encodeURIComponent(first.folder)}/thumbnail_${first.ep}.png`
      const result = [
        {
          _id: match.key,
          id: match.key,
          name: first.name,
          englishName: first.name,
          thumbnail: thumbnailUrl,
          type: 'TV',
          year: null,
          availableEpisodesDetail: {
            sub: sortedEps,
            dub: [],
          },
        },
      ]
      cache.set(cacheKey, result, 300)
      return result
    } catch (error) {
      log.error({ error }, '[OP] Search failed')
      return []
    }
  }

  async function resolveShowId(title, romaji, mode) {
    const query = (romaji || title).trim()
    if (!query) return null
    const targets = [title, romaji].filter((t) => !!t)
    for (const variant of ctx.titleMatch.buildQueryVariants(title, romaji)) {
      const url = `${SEARCH_URL}?text=${encodeURIComponent(variant)}&order=recent&page=1&limit=23&genres=&blacklist=&studio=&ibt=0&swa=1`
      const html = await fetchText(url)
      const entries = parseSearchResults(html)
      if (entries.length === 0) continue
      const seriesMap = buildSeriesMap(entries)
      const nameCandidates = []
      for (const [key, eps] of seriesMap.entries()) {
        const seenNames = new Set()
        for (const ep of eps) {
          if (ep.name && !seenNames.has(ep.name.toLowerCase())) {
            seenNames.add(ep.name.toLowerCase())
            nameCandidates.push({ title: ep.name, key })
          }
        }
      }
      const match = ctx.titleMatch.pickBestMatch(nameCandidates, targets)
      if (match) {
        return match.item.key
      }
    }
    return null
  }

  async function getEpisodes(showId, mode) {
    try {
      if (!showId) return null
      const cacheKey = `op_eps_${showId}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const folder = titleSlugToFolder(showId)
      const compact = folder.toLowerCase().replace(/[^a-z0-9]/g, '')
      const searchEntries = async (text, limit) => {
        const url = `${SEARCH_URL}?text=${encodeURIComponent(text)}&order=recent&page=1&limit=${limit}&genres=&blacklist=&studio=&ibt=0&swa=1`
        const html = await fetchText(url)
        return parseSearchResults(html)
      }
      const words = folder
        .split(/\s+/)
        .filter((w) => w.length >= 3)
        .sort((a, b) => b.length - a.length)
      let matched = []
      for (const text of [folder, ...words]) {
        const entries = await searchEntries(text, 50)
        matched = entries.filter(
          (e) => e.folder.toLowerCase().replace(/[^a-z0-9]/g, '') === compact
        )
        if (matched.length > 0) break
      }
      if (matched.length === 0) return null
      matched.sort((a, b) => parseFloat(a.ep) - parseFloat(b.ep))
      const episodes = matched.map((e) => e.ep)
      const watchMap = {}
      for (const e of matched) {
        if (e.watchUrl) watchMap[e.ep] = e.watchUrl
      }
      cache.set(`op_watch_${showId}`, watchMap, 3600)
      const desc = matched[0]?.desc || ''
      const result = { episodes, description: desc }
      cache.set(cacheKey, result, 3600)
      return result
    } catch (error) {
      log.error({ error, showId }, '[OP] getEpisodes failed')
      return null
    }
  }

  async function getStreamUrls(showId, episodeNumber, mode) {
    try {
      const cacheKey = `op_stream_${showId}_${episodeNumber}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      let watchMap = cache.get(`op_watch_${showId}`)
      if (!watchMap) {
        await getEpisodes(showId)
        watchMap = cache.get(`op_watch_${showId}`)
      }
      const watchUrl = watchMap?.[episodeNumber]
      const folder = titleSlugToFolder(showId)
      const url =
        watchUrl ??
        `${BASE_URL}/watch?e=${encodeURIComponent(folderToTitleSlug(folder))}-${episodeNumber}`
      const html = await fetchText(url)
      const availResMatch = html.match(/var\s+availableres\s*=\s*(\{[^;]+\})/)
      const links = []
      if (availResMatch) {
        try {
          const raw = availResMatch[1].replace(/\\\//g, '/')
          const availRes = JSON.parse(raw)
          const qualityMap = {
            '720': '720p',
            '1080': '1080p',
            '4k': '4K',
          }
          for (const [key, videoUrl] of Object.entries(availRes)) {
            if (!videoUrl || !key) continue
            const label = qualityMap[key] || key
            links.push({ resolutionStr: label, link: videoUrl, hls: false })
          }
          const resOrder = { '720p': 1, '1080p': 2, '4K': 3 }
          links.sort(
            (a, b) => (resOrder[a.resolutionStr] || 99) - (resOrder[b.resolutionStr] || 99)
          )
        } catch {
        }
      }
      if (links.length === 0) {
        const sourceRe = /src="(https?:\/\/[^"]+\.(mp4|webm)[^"]*)"/gi
        let sourceMatch
        while ((sourceMatch = sourceRe.exec(html)) !== null) {
          const ext = sourceMatch[2].toLowerCase()
          links.push({
            resolutionStr: ext === 'mp4' ? '720p' : '1080p',
            link: sourceMatch[1],
            hls: false,
          })
        }
      }
      if (links.length === 0) return null
      const subtitles = []
      const subRe = /src='(https?:\/\/[^']+\.vtt[^']*)'[^>]*kind='subtitles'[^>]*srclang='([^']+)'/g
      let subMatch
      while ((subMatch = subRe.exec(html)) !== null) {
        subtitles.push({
          language: subMatch[2],
          label: subMatch[2].toUpperCase(),
          url: subMatch[1],
        })
      }
      const result = [
        {
          sourceName: 'OP (Direct)',
          links,
          subtitles: subtitles.length > 0 ? subtitles : undefined,
          type: 'player',
          actualEpisodeNumber: episodeNumber,
        },
      ]
      cache.set(cacheKey, result, 3600)
      return result
    } catch (error) {
      log.error({ error, showId, episodeNumber }, '[OP] getStreamUrls failed')
      return null
    }
  }

  return {
    name: 'Op',
    search,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
    browse,
  }
}
