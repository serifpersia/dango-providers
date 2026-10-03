const BASE_URL = 'https://hentaini.com'
const API_URL = 'https://admin.hentaini.com/api'
const CDN_URL = 'https://admin.hentaini.com/uploads'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: BASE_URL + '/',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.text()
}

async function fetchApi(path) {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      headers: {
        'User-Agent': UA,
        Referer: BASE_URL + '/',
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

function imageUrl(path) {
  if (!path) return ''
  if (path.startsWith('http')) return path
  return `${CDN_URL}/${path}`
}

function parseNuxtData(html) {
  const match = html.match(/__NUXT_DATA__">\s*(\[.*?\])\s*<\//s)
  if (!match) return null
  let raw
  try {
    raw = JSON.parse(match[1])
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  const visited = new Set()
  function resolve(v) {
    if (typeof v === 'number' && v >= 0 && v < raw.length && Number.isInteger(v)) {
      if (visited.has(v)) return v
      visited.add(v)
      const result = resolve(raw[v])
      visited.delete(v)
      return result
    }
    if (Array.isArray(v)) {
      const wrapper = v[0]
      if (
        typeof wrapper === 'string' &&
        (wrapper === 'ShallowReactive' || wrapper === 'ShallowRef' || wrapper === 'EmptyRef')
      ) {
        return resolve(v[1])
      }
      return v.map(resolve)
    }
    if (v && typeof v === 'object') {
      const obj = {}
      for (const [k, val] of Object.entries(v)) {
        obj[k] = resolve(val)
      }
      return obj
    }
    return v
  }
  const resolved = resolve(raw)
  const extractEpisode = (obj) => {
    if (!obj || typeof obj !== 'object') return null
    const root = obj
    const entries = Array.isArray(root.data)
      ? root.data
      : root.data && typeof root.data === 'object'
        ? root.data.data
        : null
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (entry && typeof entry === 'object') {
          const e = entry
          if (typeof e.id === 'number' && typeof e.episode_number === 'number') {
            return e
          }
        }
      }
    }
    for (const val of Object.values(root)) {
      const result = extractEpisode(val)
      if (result) return result
    }
    return null
  }
  return extractEpisode(resolved)
}

function pickPoster(images) {
  if (!images || images.length === 0) return ''
  const named = (n) =>
    images.find((i) => (i.image_type?.name || '').toLowerCase() === n)?.path || ''
  return imageUrl(
    named('cover') ||
      named('poster') ||
      named('thumbnail') ||
      named('backdrop') ||
      images[0].path ||
      ''
  )
}

function extractSeriesCover(html) {
  const imgs = html.match(/<img[^>]+>/g) || []
  for (const img of imgs) {
    if (/aspect-\[2\/3\]/.test(img)) {
      const src = img.match(/src="([^"]+)"/)?.[1] || ''
      if (src.startsWith('http')) return src
    }
  }
  const cover = html.match(/https?:\/\/[^"'\s]*uploads\/[^"'\s]*cover[^"'\s]*/i)?.[0]
  if (cover) return cover
  const anyUpload = html.match(/https?:\/\/[^"'\s]*uploads\/[^"'\s]*\.(?:jpe?g|png|webp)/i)?.[0]
  return anyUpload || ''
}

async function fetchGenreFacets(cache, log) {
  const cacheKey = 'hn_genres'
  const cached = cache.get(cacheKey)
  if (cached) return cached
  try {
    const res = await fetch(`${API_URL}/genres?pagination[pageSize]=100`, {
      headers: { 'User-Agent': UA, Referer: `${BASE_URL}/` },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const json = await res.json()
    const genres = (json?.data || [])
      .filter((g) => g && g.url && g.name)
      .map((g) => ({ slug: String(g.url), name: String(g.name) }))
    if (genres.length > 0) cache.set(cacheKey, genres, 86400)
    return genres
  } catch (error) {
    log.error({ error }, '[HN] Genres fetch failed')
    return []
  }
}

export default function createProvider(ctx) {
  const cache = ctx.cache
  const log = ctx.logger
  const posterCache = new Map()

  function bestMatch(results, query) {
    if (!results.length) return null
    const q = query.toLowerCase().trim()
    let best = results[0]
    let bestScore = -1
    for (const item of results) {
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

  async function resolvePoster(slug, apiPoster) {
    if (apiPoster) return apiPoster
    const cached = posterCache.get(slug)
    if (cached !== undefined) return cached
    try {
      const html = await fetchText(`${BASE_URL}/h/${slug}`)
      const poster = extractSeriesCover(html)
      posterCache.set(slug, poster)
      return poster
    } catch {
      posterCache.set(slug, '')
      return ''
    }
  }

  async function browse(options) {
    try {
      const query = (options.query || '').trim()
      const genre = (options.genre || '').trim().toLowerCase()
      const sort = options.sort || ''
      const page = Math.max(1, options.page || 1)
      const pageSize = Math.min(20, Math.max(1, options.pageSize || 14))
      const params = new URLSearchParams()
      if (query) {
        params.set('filters[title][$containsi]', query)
      } else if (genre) {
        const facets = await fetchGenreFacets(cache, log)
        const hit = facets.find((g) => g.slug.toLowerCase() === genre)
        params.set('filters[genres][$containsi]', hit ? hit.name : genre.replace(/-/g, ' '))
      }
      params.set('pagination[page]', String(page))
      params.set('pagination[pageSize]', String(pageSize))
      if (sort) params.set('sort', sort)
      const fetchBrowse = () =>
        fetchApi(`/series?${params.toString()}`)
      let res = await fetchBrowse()
      if (!res?.data && sort) {
        params.delete('sort')
        res = await fetchApi(`/series?${params.toString()}`)
      }
      const items = res?.data || []
      const shows = await Promise.all(
        items.map(async (item) => ({
          _id: item.url,
          id: item.url,
          name: item.title,
          englishName: item.title_english || item.title,
          thumbnail: await resolvePoster(item.url, pickPoster(item.images)),
          type: 'TV',
          year: null,
          isAdult: true,
          availableEpisodesDetail: { sub: [], dub: [] },
        }))
      )
      const pagination = res?.meta?.pagination
      const hasMore =
        typeof pagination?.pageCount === 'number'
          ? page < pagination.pageCount
          : shows.length >= pageSize
      const total = typeof pagination?.total === 'number' ? pagination.total : undefined
      const genres = await fetchGenreFacets(cache, log)
      return {
        shows,
        hasMore,
        ...(total !== undefined ? { total } : {}),
        ...(genres.length > 0 ? { genres } : {}),
      }
    } catch (error) {
      log.error({ error }, '[HN] Browse failed')
      return { shows: [], hasMore: false, genres: [] }
    }
  }

  async function search(options) {
    try {
      const query = (options.query || '').trim()
      if (!query) return []
      const res = await fetchApi(
        `/series?filters[title][$containsi]=${encodeURIComponent(query)}&pagination[limit]=10`
      )
      const apiResults = (res?.data || []).map((item) => ({
        title: item.title,
        slug: item.url,
        poster: pickPoster(item.images),
        score: 0,
      }))
      if (apiResults.length === 0) return []
      const matched = bestMatch(apiResults, query) || apiResults[0]
      return [
        {
          _id: matched.slug,
          id: matched.slug,
          name: matched.title,
          englishName: matched.title,
          thumbnail: await resolvePoster(matched.slug, matched.poster),
          type: 'TV',
          year: null,
          availableEpisodesDetail: { sub: [], dub: [] },
        },
      ]
    } catch (error) {
      log.error({ error }, '[HN] Search failed')
      return []
    }
  }

  async function resolveShowId(title, romaji) {
    return ctx.resolveBestShowId(title, romaji, async (variant) => {
      const res = await fetchApi(
        `/series?filters[title][$containsi]=${encodeURIComponent(variant)}&pagination[limit]=10`
      )
      return (res?.data || []).map((item) => ({
        title: item.title || item.title_english,
        id: item.url,
      }))
    })
  }

  async function getEpisodes(showId, mode) {
    try {
      if (!showId) return null
      const html = await fetchText(`${BASE_URL}/h/${showId}`)
      const episodeRe = new RegExp(`/h/${showId}/(\\d+)`, 'g')
      const numbers = new Set()
      let m
      while ((m = episodeRe.exec(html)) !== null) {
        numbers.add(m[1])
      }
      const episodes = [...numbers].sort((a, b) => Number(a) - Number(b))
      return { episodes, description: '' }
    } catch (error) {
      log.error({ error, showId }, '[HN] getEpisodes failed')
      return null
    }
  }

  async function getStreamUrls(showId, episodeNumber, mode) {
    try {
      const episodeUrl = `${BASE_URL}/h/${showId}/${episodeNumber}`
      const html = await fetchText(episodeUrl)
      const m3u8Match = html.match(/https?:\/\/[^"' ]+\.m3u8[^"' ]*/i)
      if (!m3u8Match) return null
      let streamUrl = m3u8Match[0].replace(/\\+$/g, '').trim()
      streamUrl = streamUrl.replace(/\\"/g, '"').replace(/"$/g, '').replace(/\\\//g, '/')
      const links = [
        {
          resolutionStr: 'Auto',
          link: streamUrl,
          hls: true,
          headers: {
            Referer: BASE_URL + '/',
            Origin: BASE_URL,
            'User-Agent': UA,
          },
        },
      ]
      const result = [
        {
          sourceName: 'HN (Direct)',
          links,
          type: 'player',
          actualEpisodeNumber: episodeNumber,
        },
      ]
      const nuxtEntry = parseNuxtData(html)
      if (nuxtEntry && nuxtEntry.players) {
        try {
          const players = JSON.parse(nuxtEntry.players)
          if (Array.isArray(players)) {
            for (const p of players) {
              if (p.name === 'HLS' || !p.url) continue
              result.push({
                sourceName: `HN (${p.name})`,
                links: [{ resolutionStr: 'Auto', link: p.url, hls: false }],
                type: 'iframe',
                actualEpisodeNumber: episodeNumber,
              })
            }
          }
        } catch {
        }
      }
      return result
    } catch (error) {
      log.error({ error, showId, episodeNumber }, '[HN] getStreamUrls failed')
      return null
    }
  }

  return {
    name: 'HN',
    search,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
    browse,
  }
}
