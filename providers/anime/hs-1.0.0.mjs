const BASE_URL = 'https://hstream.moe'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const HS_GENRES = [
  '3d',
  '48fps',
  '4k',
  '4k-48fps',
  'ahegao',
  'anal',
  'bdsm',
  'bestiality',
  'big-boobs',
  'blow-job',
  'bondage',
  'boob-job',
  'censored',
  'comedy',
  'cosplay',
  'creampie',
  'dark-skin',
  'elf',
  'facial',
  'fantasy',
  'filmed',
  'foot-job',
  'futanari',
  'gangbang',
  'glasses',
  'gore',
  'hand-job',
  'harem',
  'horror',
  'incest',
  'inflation',
  'lactation',
  'lq',
  'maid',
  'masturbation',
  'milf',
  'mind-break',
  'mind-control',
  'monster',
  'nekomimi',
  'ntr',
  'nurse',
  'orc',
  'orgy',
  'pov',
  'pregnant',
  'public-sex',
  'rape',
  'reverse-rape',
  'rimjob',
  'scat',
  'school-girl',
  'small-boobs',
  'succubus',
  'swim-suit',
  'teacher',
  'tentacle',
  'threesome',
  'toys',
  'trap',
  'tsundere',
  'ugly-bastard',
  'uncensored',
  'vanilla',
  'virgin',
  'x-ray',
  'yuri',
]

export const HS_ORDERS = ['recently-released', 'recently-uploaded', 'view-count']

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function cleanSlug(showId) {
  return String(showId || '')
    .replace(/^https?:\/\/[^/]+\/hentai\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .trim()
}

function thumbnailUrl(slug) {
  return `${BASE_URL}/images/hentai/${slug}/cover-ep-1.webp`
}

function parseCards(html) {
  const cards = []
  const chunks = String(html).split('<div wire:key="episode-')
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]
    const id = chunk.match(/^(\d+)"/)?.[1]
    const slug = chunk.match(/href="https?:\/\/hstream\.moe\/hentai\/([^"?#]+)"/)?.[1]
    const heading = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1]
    if (!id || !slug || !heading) continue
    const title = decodeHtml(heading.replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim()
    const numbered = title.match(/^(.*?)\s+-\s+(\d+(?:\.\d+)?)$/)
    const episode = numbered ? Number(numbered[2]) : 1
    const seriesTitle = numbered ? numbered[1].trim() : title
    cards.push({
      id,
      slug,
      seriesSlug: slug.replace(/-\d+$/, ''),
      title,
      seriesTitle,
      episode,
      thumbnail: thumbnailUrl(slug.replace(/-\d+$/, '')),
    })
  }
  return cards
}

function groupCards(cards) {
  const map = new Map()
  for (const card of cards) {
    let show = map.get(card.seriesSlug)
    if (!show) {
      show = {
        _id: card.seriesSlug,
        id: card.seriesSlug,
        name: card.seriesTitle,
        englishName: card.seriesTitle,
        thumbnail: card.thumbnail,
        type: 'TV',
        year: null,
        isAdult: true,
        availableEpisodesDetail: { sub: [], dub: [] },
        episodes: new Set(),
      }
      map.set(card.seriesSlug, show)
    }
    if (!show.thumbnail) show.thumbnail = card.thumbnail
    show.episodes.add(String(card.episode))
  }
  return Array.from(map.values()).map((show) => {
    show.availableEpisodesDetail.sub = Array.from(show.episodes).sort(
      (a, b) => Number(a) - Number(b)
    )
    delete show.episodes
    return show
  })
}

function seriesEpisodes(html, slug) {
  const prefix = `/hentai/${slug}-`
  const numbers = new Set()
  const re = /href="https?:\/\/hstream\.moe(\/hentai\/[^"?#]+)"/g
  let match
  while ((match = re.exec(html)) !== null) {
    const path = match[1]
    if (!path.startsWith(prefix)) continue
    const number = path.slice(prefix.length)
    if (/^\d+(?:\.\d+)?$/.test(number)) numbers.add(number)
  }
  return Array.from(numbers).sort((a, b) => Number(a) - Number(b))
}

function pageDescription(html) {
  return decodeHtml(html.match(/<meta name="description" content="([^"]*)"/)?.[1] || '').trim()
}

function htmlHeaders(referer) {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: referer || BASE_URL + '/',
  }
}

async function fetchHtml(url, referer) {
  const res = await fetch(url, {
    headers: htmlHeaders(referer),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res
}

export default function createProvider(ctx) {
  const cache = ctx.cache
  const log = ctx.logger

  async function browse(options = {}) {
    try {
      const query = String(options.query || '').trim()
      const genre = String(options.genre || options.genres || '').trim()
      const studio = String(options.studio || '').trim()
      const order = HS_ORDERS.includes(options.order) ? options.order : ''
      const page = Math.max(1, Number(options.page) || 1)
      const cacheKey = `hs_browse_${query}_${genre}_${studio}_${order}_${page}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      const params = new URLSearchParams()
      if (query) params.set('search', query)
      if (genre) params.set('tags[0]', genre)
      if (studio) params.set('studios[0]', studio)
      if (order) params.set('order', order)
      if (page > 1) params.set('page', String(page))
      const url = `${BASE_URL}/search${params.size ? `?${params}` : ''}`
      const res = await fetchHtml(url)
      const cards = parseCards(await res.text())
      const output = { shows: groupCards(cards), hasMore: !query && cards.length >= 25 }
      cache.set(cacheKey, output, 300)
      return output
    } catch (error) {
      log.error({ error }, '[HS] Browse failed')
      return { shows: [], hasMore: false }
    }
  }

  async function search(options = {}) {
    try {
      const query = String(options.query || '').trim()
      if (!query) return []
      const cacheKey = `hs_search_${query}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const res = await fetchHtml(`${BASE_URL}/search?search=${encodeURIComponent(query)}`)
      const result = groupCards(parseCards(await res.text()))
      cache.set(cacheKey, result, 300)
      return result
    } catch (error) {
      log.error({ error }, '[HS] Search failed')
      return []
    }
  }

  async function resolveShowId(title, romaji) {
    return ctx.resolveBestShowId(title, romaji, async (variant) => {
      const shows = await search({ query: variant })
      return shows.map((show) => ({ title: show.name, id: show.id }))
    })
  }

  async function getEpisodes(showId, _mode) {
    try {
      let slug = cleanSlug(showId)
      if (!slug) return null
      const cacheKey = `hs_eps_${slug}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      let res = await fetchHtml(`${BASE_URL}/hentai/${slug}`)
      let html = await res.text()
      let episodes = seriesEpisodes(html, slug)
      if (episodes.length === 0 && /-\d+$/.test(slug)) {
        slug = slug.replace(/-\d+$/, '')
        res = await fetchHtml(`${BASE_URL}/hentai/${slug}`)
        html = await res.text()
        episodes = seriesEpisodes(html, slug)
      }
      if (episodes.length === 0) return null

      const result = { episodes, description: pageDescription(html) }
      cache.set(cacheKey, result, 3600)
      return result
    } catch (error) {
      log.error({ error, showId }, '[HS] getEpisodes failed')
      return null
    }
  }

  async function playerData(episodeUrl) {
    const res = await fetchHtml(episodeUrl)
    const html = await res.text()
    const episodeId = html.match(/id="e_id"[^>]*value="(\d+)"/)?.[1]
    if (!episodeId) return null

    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    const pairs = cookies.map((cookie) => cookie.split(';')[0])
    const cookieHeader = pairs.join('; ')
    const xsrf = pairs.find((pair) => pair.startsWith('XSRF-TOKEN='))
    if (!xsrf) return null

    const apiRes = await fetch(`${BASE_URL}/player/api`, {
      method: 'POST',
      headers: {
        ...htmlHeaders(episodeUrl),
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'X-XSRF-TOKEN': decodeURIComponent(xsrf.slice('XSRF-TOKEN='.length)),
        Origin: BASE_URL,
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ episode_id: Number(episodeId) }),
      signal: AbortSignal.timeout(20000),
    })
    if (!apiRes.ok) return null
    return apiRes.json()
  }

  async function getStreamUrls(showId, episodeNumber, _mode) {
    try {
      const slug = cleanSlug(showId)
      const episode = String(episodeNumber === '0' ? '1' : episodeNumber || '1')
      if (!slug) return null
      const cacheKey = `hs_stream_${slug}_${episode}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      const data = await playerData(`${BASE_URL}/hentai/${slug}-${episode}`)
      const domain = data?.stream_domains?.[0]
      if (!data?.stream_url || !domain) return null
      const base = `${domain.replace(/\/+$/, '')}/${data.stream_url.replace(/^\/+/, '')}`

      const referer = BASE_URL + '/'
      const headers = { Referer: referer, Origin: BASE_URL }
      const dashLink = (resolutionStr, path) => ({
        resolutionStr,
        link: `${base}/${path}/manifest.mpd`,
        hls: false,
        dash: true,
        headers,
      })
      const links = []
      if (data.interpolated_uhd === 1) links.push(dashLink('2160p48', '2160i'))
      links.push(dashLink('2160p', '2160'))
      if (data.interpolated === 1) links.push(dashLink('1080p48', '1080i'))
      links.push(dashLink('1080p', '1080'), dashLink('720p', '720'), {
        resolutionStr: '720p MP4',
        link: `${base}/x264.720p.mp4`,
        hls: false,
        headers,
      })
      const result = [
        {
          sourceName: 'HS (Direct)',
          links,
          subtitles: [
            {
              language: 'en',
              lang: 'en',
              label: 'English',
              url: `${base}/eng.vtt`,
            },
          ],
          type: 'player',
          actualEpisodeNumber: episode,
        },
      ]
      cache.set(cacheKey, result, 300)
      return result
    } catch (error) {
      log.error({ error, showId, episodeNumber }, '[HS] getStreamUrls failed')
      return null
    }
  }

  return {
    name: 'HS',
    search,
    browse,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
  }
}
