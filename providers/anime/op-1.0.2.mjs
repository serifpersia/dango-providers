const BASE_URL = 'https://oppai.stream'
const SEARCH_API = `${BASE_URL}/api/search.php`
const STORAGE_BASE = `${BASE_URL}/videos`
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export const OP_ORDERS = [
  'recent',
  'old',
  'az',
  'za',
  'views',
  'views-asc',
  'rating',
  'rating-asc',
  'random',
]

export const OP_TAGS = [
  '4k',
  '3D',
  'Ahegao',
  'Beach',
  'Blood',
  'Censored',
  'Comedy',
  'Fantasy',
  'Filmed',
  'Gore',
  'Harem',
  'Horror',
  'Incest',
  'Lactation',
  'Mind Break',
  'Mind Control',
  'Monster',
  'POV',
  'Plot',
  'Softcore',
  'Tentacle',
  'Uncensored',
  'Vanilla',
  'Watersports',
  'X-Ray',
  'Yaoi',
  'Yuri',
  'Anal',
  'Armpit Masturbation',
  'BlowJob',
  'BoobJob',
  'Cowgirl',
  'Cunnilingus',
  'Doggy',
  'FootJob',
  'Groping',
  'HandJob',
  'Masturbation',
  'Missionary',
  'Prone Bone',
  'Rimjob',
  'Threesome',
  'Double Penetration',
  'Tripple Penetration',
  'Side Fucking',
  '69',
  'Golden Shower',
  'BDSM',
  'Bondage',
  'Creampie',
  'Facial',
  'Gangbang',
  'Girls Only',
  'NTR',
  'Orgy',
  'Public Sex',
  'Rape',
  'Reverse Gangbang',
  'Reverse Rape',
  'Toys',
  'Voyeurism',
  'Scat',
  'Inflation',
]

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  return match ? decodeHtml(match[1]) : ''
}

function parseCards(html) {
  const cards = []
  const anchorRe = /<a\s+([^>]*\bclass="[^"]*\bepisode\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/g
  let match
  while ((match = anchorRe.exec(html)) !== null) {
    const tag = match[1]
    const body = match[2]
    const folder = attr(tag, 'data-folder')
    const episode = attr(tag, 'epid') || attr(body, 'episode-number')
    const watchUrl = attr(tag, 'href')
    if (!folder || !episode || !watchUrl) continue

    const titleMatch = body.match(
      /<p[^>]*class="(?:[^"]*\s)?episode-title(?:\s[^"]*)?"[^>]*>([^<]*)<\/p>/
    )
    const altMatch = body.match(/alt="([^"]*)"/)
    const title = decodeHtml((titleMatch?.[1] || altMatch?.[1] || '').trim())
    const thumbMatch = body.match(/(?:data-src|src)="([^"]*\/thumbnail_[^"]+)"/)
    const suffix = `-${episode}`

    cards.push({
      folder,
      ep: episode,
      title,
      watchUrl,
      thumbnail: thumbMatch ? decodeHtml(thumbMatch[1]) : '',
      seriesKey: folder.endsWith(suffix) ? folder.slice(0, -suffix.length) : folder,
    })
  }
  return cards
}

function parseResolutions(value) {
  const formats = { 1: 'mp4', 2: 'webm' }
  const map = {}
  String(value || '')
    .split(',')
    .forEach((part) => {
      const [resolution, code] = part.split('-')
      if (!resolution || !code) return
      map[resolution] = formats[Number(code)] || 'mp4'
    })
  return map
}

function seriesQuery(showId) {
  return showId.replace(/-/g, ' ').replace(/~/g, '-')
}

function toShow(seriesKey, entries) {
  const episodes = [...entries].sort((a, b) => parseFloat(a.ep) - parseFloat(b.ep))
  const first = episodes[0]
  return {
    _id: seriesKey,
    id: seriesKey,
    name: first.title,
    englishName: first.title,
    thumbnail:
      first.thumbnail ||
      `${STORAGE_BASE}/${encodeURIComponent(first.folder)}/thumbnail_${first.ep}.png`,
    type: 'TV',
    year: null,
    isAdult: true,
    availableEpisodesDetail: {
      sub: episodes.map((entry) => entry.ep),
      dub: [],
    },
  }
}

function groupShows(cards) {
  const map = new Map()
  for (const card of cards) {
    const existing = map.get(card.seriesKey) || []
    existing.push(card)
    map.set(card.seriesKey, existing)
  }
  return Array.from(map.entries()).map(([key, entries]) => toShow(key, entries))
}

function bestMatch(shows, query) {
  if (!shows.length) return null
  const q = query.toLowerCase().trim()
  let best = shows[0]
  let bestScore = -1
  for (const show of shows) {
    const title = show.name.toLowerCase()
    let score = 0
    if (title === q) score = 3
    else if (title.startsWith(q)) score = 2
    else if (title.includes(q)) score = 1
    if (score > bestScore) {
      bestScore = score
      best = show
      if (score === 3) break
    }
  }
  return best
}

async function searchApi(params) {
  const body = new URLSearchParams({
    text: params.text || '',
    tags: params.tags || '',
    blacklist: params.blacklist || '',
    studios: params.studios || '',
    order: params.order || 'recent',
    limit: String(params.limit || 24),
    page: String(params.page || 1),
    classes: 'smaller-episode-gap',
    character_filters: '{}',
  })
  const res = await fetch(SEARCH_API, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: `${BASE_URL}/search`,
      Accept: 'text/html,*/*',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${SEARCH_API}`)
  const html = await res.text()
  const cards = parseCards(html)
  const totalMatch = html.match(/class='results-num'[^>]*>(\d+)</)
  const total = totalMatch ? Number(totalMatch[1]) : cards.length
  return { cards, total }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: `${BASE_URL}/`,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) return null
  return res.text()
}

export default function createProvider(ctx) {
  const cache = ctx.cache
  const log = ctx.logger

  async function browse(options) {
    try {
      const query = (options.query || '').trim()
      const page = Math.max(1, options.page || 1)
      const limit = Math.min(100, Math.max(1, options.limit || options.pageSize || 24))
      const order = OP_ORDERS.includes(options.order || '') ? options.order : 'recent'
      const genres = (options.genre || options.genres || '').trim()
      const blacklist = (options.blacklist || '').trim()
      const studio = (options.studio || '').trim()
      const cacheKey = `op_browse_${query}_${page}_${limit}_${order}_${genres}_${blacklist}_${studio}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      const { cards, total } = await searchApi({
        text: query,
        tags: genres,
        blacklist,
        studios: studio,
        order,
        page,
        limit,
      })
      const output = { shows: groupShows(cards), total, hasMore: page * limit < total }
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

      const { cards } = await searchApi({ text: query, order: 'recent', limit: 24 })
      if (cards.length === 0) return []
      const shows = groupShows(cards)
      const result = [bestMatch(shows, query)]
      cache.set(cacheKey, result, 300)
      return result
    } catch (error) {
      log.error({ error }, '[OP] Search failed')
      return []
    }
  }

  async function resolveShowId(title, romaji) {
    return ctx.resolveBestShowId(title, romaji, async (variant) => {
      const { cards } = await searchApi({ text: variant, order: 'recent', limit: 24 })
      return groupShows(cards).map((show) => ({ title: show.name, id: show.id }))
    })
  }

  async function getEpisodes(showId, _mode) {
    try {
      if (!showId) return null
      const cacheKey = `op_eps_${showId}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      const text = seriesQuery(showId)
      const words = text.split(/\s+/).filter(Boolean)
      const queries = [text]
      for (const count of [4, 3, 2]) {
        if (words.length > count) queries.push(words.slice(0, count).join(' '))
      }

      let matched = []
      for (const query of queries) {
        const all = []
        let total = Infinity
        for (let page = 1; page <= 10 && all.length < total; page++) {
          const { cards, total: found } = await searchApi({
            text: query,
            order: 'recent',
            page,
            limit: 100,
          })
          total = found
          if (cards.length === 0) break
          all.push(...cards)
        }
        matched = all.filter((card) => card.seriesKey === showId)
        if (matched.length === 0) {
          matched = all.filter((card) => card.folder.startsWith(`${showId}-`))
        }
        if (matched.length > 0) break
      }
      if (matched.length === 0) return null

      const byEpisode = new Map()
      for (const card of matched) {
        if (!byEpisode.has(card.ep)) byEpisode.set(card.ep, card)
      }
      const sorted = Array.from(byEpisode.values()).sort(
        (a, b) => parseFloat(a.ep) - parseFloat(b.ep)
      )
      const watchMap = {}
      for (const card of sorted) watchMap[card.ep] = card
      cache.set(`op_watch_${showId}`, watchMap, 3600)

      const result = { episodes: sorted.map((card) => card.ep), description: '' }
      cache.set(cacheKey, result, 3600)
      return result
    } catch (error) {
      log.error({ error, showId }, '[OP] getEpisodes failed')
      return null
    }
  }

  async function getStreamUrls(showId, episodeNumber, _mode) {
    try {
      const episode = String(episodeNumber)
      const cacheKey = `op_stream_${showId}_${episode}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      let watchMap = cache.get(`op_watch_${showId}`)
      if (!watchMap) {
        await getEpisodes(showId, 'sub')
        watchMap = cache.get(`op_watch_${showId}`)
      }
      const entry = watchMap?.[episode]
      const folder = entry?.folder || `${showId}-${episode}`
      const watchUrl =
        entry?.watchUrl ||
        `${BASE_URL}/watch/${encodeURIComponent(`${entry?.title || seriesQuery(showId)}-${episode}`)}`

      const html = await fetchText(watchUrl)
      if (!html) return null

      const folderMatch = html.match(/var folder = "([^"]*)"/)
      const actualFolder = folderMatch?.[1] || folder
      const resMatch = html.match(/var res = "([^"]*)"/)
      const resolutions = parseResolutions(resMatch?.[1] || '')
      const base = `${STORAGE_BASE}/${encodeURIComponent(actualFolder)}`

      const ext = resolutions['4k'] === 'mp4' ? 'mp4' : 'webm'
      const links = [{ resolutionStr: 'Auto', link: `${base}/ep.${ext}`, hls: false }]

      const subtitles = []
      const trackRe = /<track\b[^>]*>/g
      let track
      while ((track = trackRe.exec(html)) !== null) {
        const src = attr(track[0], 'src')
        if (!/\.vtt(\?|$)/i.test(src)) continue
        const lang = attr(track[0], 'srclang') || 'en'
        subtitles.push({
          language: lang,
          label: attr(track[0], 'label') || lang.toUpperCase(),
          url: src,
        })
      }

      const result = [
        {
          sourceName: 'OP (Direct)',
          links,
          subtitles: subtitles.length > 0 ? subtitles : undefined,
          type: 'player',
          actualEpisodeNumber: episode,
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
