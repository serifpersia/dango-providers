const STREAM_SERVERS = ['megaplay', 'zokoanime', 'animegg']

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SITE_BASE = 'https://justanime.to'
const DEFAULT_API_BASE = 'https://core.justanime.to/api'

export default function createProvider(ctx) {
  const cache = ctx.cache
  const log = ctx.logger

  function apiBase() {
    return (process.env.JUSTANIME_API_BASE || DEFAULT_API_BASE).trim().replace(/\/+$/, '')
  }

  async function getApi(path) {
    const url = new URL(path.replace(/^\/+/, ''), `${apiBase()}/`)
    const res = await fetch(url.href, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Origin: SITE_BASE,
        Referer: `${SITE_BASE}/`,
      },
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`Status ${res.status}`)
    const value = await res.json()
    if (value?.error) {
      throw new Error(typeof value.error === 'string' ? value.error : value.error.message)
    }
    return value
  }

  function toShow(card) {
    if (!card || card.id == null) return null
    const title = card.title?.english || card.title?.romaji || ''
    if (!title) return null
    return {
      _id: String(card.id),
      id: String(card.id),
      anilistId: card.id,
      name: title,
      englishName: card.title?.english || undefined,
      names: {
        english: card.title?.english || undefined,
        romaji: card.title?.romaji || undefined,
      },
      thumbnail: card.cover,
      type: card.format || card.type,
      year: card.seasonYear ?? card.year ?? null,
    }
  }

  function qualityNum(value) {
    const m = String(value || '').match(/(360|480|720|1080|2160)/)
    return m ? parseInt(m[1], 10) : 0
  }

  async function search(options) {
    try {
      const query = (options.query || '').trim()
      if (!query) return []
      const data = await getApi(
        `/search?query=${encodeURIComponent(query)}&page=${options.page && options.page > 0 ? options.page : 1}`
      )
      return (data.results || []).map((c) => toShow(c)).filter((s) => s !== null)
    } catch (e) {
      log.error({ err: e }, 'JustAnime search failed')
      return []
    }
  }

  async function resolveShowId(title, romaji) {
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

  function isDirectId(showId) {
    return /^\d+$/.test(showId.trim())
  }

  async function getEpisodes(showId) {
    try {
      const id = showId.trim()
      if (!/^\d+$/.test(id)) return null
      const cacheKey = `justanime_eps_${id}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      const first = await getApi(
        `/anime/${encodeURIComponent(id)}/episodes?page=1`
      )
      const totalPages = Math.max(1, Number(first.totalPages) || 1)
      const rest = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) =>
          getApi(
            `/anime/${encodeURIComponent(id)}/episodes?page=${i + 2}`
          )
        )
      )
      const seen = new Map()
      for (const page of [first, ...rest]) {
        for (const ep of page.episodes || []) {
          const n = String(ep.number)
          if (!n || seen.has(n)) continue
          seen.set(n, {
            number: n,
            title: ep.title && !/^episode\s+[\d.]+$/i.test(ep.title) ? ep.title : undefined,
          })
        }
      }
      const details = [...seen.values()].sort((a, b) => Number(a.number) - Number(b.number))
      if (details.length === 0) return null
      const result = {
        episodes: details.map((d) => d.number),
        availableEpisodesDetail: details,
        description: '',
      }
      cache.set(cacheKey, result, 3600)
      return result
    } catch (e) {
      log.error({ err: e, showId }, 'JustAnime getEpisodes failed')
      return null
    }
  }

  async function getStreamUrls(showId, episodeNumber, mode = 'sub') {
    try {
      const id = showId.trim()
      if (!/^\d+$/.test(id)) return null
      const ep = episodeNumber.trim()
      if (!ep) return null
      const cacheKey = `justanime_stream_${id}_${ep}_${mode}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      const settled = await Promise.allSettled(
        STREAM_SERVERS.map((server) =>
          getApi(
            `/watch/${encodeURIComponent(id)}/episode/${encodeURIComponent(ep)}/${server}`
          ).then((data) => ({ server, data }))
        )
      )
      const result = []
      for (const entry of settled) {
        if (entry.status !== 'fulfilled') continue
        const { server, data } = entry.value
        const track = mode === 'dub' ? data.dub : data.sub
        const sources = track?.sources || []
        const links = sources
          .filter((s) => s && s.url)
          .map((s) => {
            const q = qualityNum(s.quality)
            const hls = s.isM3U8 === true || /\.m3u8(?:[?#]|$)/i.test(s.url)
            return {
              resolutionStr: q ? `${q}p` : 'Auto',
              quality: q,
              link: s.url,
              hls,
              referer: s.headers?.Referer || track?.headers?.Referer || 'https://www.animegg.org/',
            }
          })
          .sort((a, b) => b.quality - a.quality)
          .map(({ resolutionStr, link, hls, referer }) => ({
            resolutionStr,
            link,
            hls,
            headers: { Referer: referer },
          }))
        if (links.length === 0) continue
        const subtitles = [...(track?.subtitles || []), ...(track?.tracks || [])]
          .filter((s) => s && s.file)
          .map((s) => ({
            language: s.label && /english/i.test(s.label) ? 'en' : s.label || 'en',
            label: s.label || 'English',
            url: s.file,
          }))
        const seen = new Set()
        const uniqueSubtitles = subtitles.filter((s) =>
          seen.has(s.url) ? false : (seen.add(s.url), true)
        )
        result.push({
          sourceName: `JustAnime · ${server} (${mode.toUpperCase()})`,
          links,
          subtitles: uniqueSubtitles.length > 0 ? uniqueSubtitles : undefined,
          type: 'player',
          actualEpisodeNumber: ep,
        })
      }
      if (result.length === 0) return null
      cache.set(cacheKey, result, 1800)
      return result
    } catch (e) {
      log.error({ err: e, showId, episodeNumber }, 'JustAnime getStreamUrls failed')
      return null
    }
  }

  return {
    name: 'JustAnime',
    search,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
    isDirectId,
  }
}
