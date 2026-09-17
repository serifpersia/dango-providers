const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export default function createProvider(ctx) {
  const cache = ctx.cache
  const log = ctx.logger
  const base = 'https://www.animegg.org'
  const mediaFields = `
    id
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

  function stripTags(input) {
    return stripHtml(input)
  }

  function attr(tag, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return tag.match(new RegExp(`\\b${escaped}=["']([^"']*)["']`, 'i'))?.[1] ?? ''
  }

  function normalizeTitle(title) {
    return title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function scoreCandidate(slug, text, query) {
    const q = normalizeTitle(query)
    const t = normalizeTitle(text)
    const s = normalizeTitle(slug.replace(/-/g, ' '))
    if (!q) return -1
    let score = -1
    for (const cand of [t, s]) {
      if (!cand) continue
      if (cand === q) score = Math.max(score, 3)
      else if (cand.startsWith(q) || q.startsWith(cand)) score = Math.max(score, 2)
      else if (cand.includes(q) || q.includes(cand)) score = Math.max(score, 1)
    }
    return score
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
      names: { romaji: title?.romaji, english: title?.english, native: title?.native },
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

  async function search(options) {
    try {
      const query = (options.query || '').replace(/\s+/g, ' ').trim()
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
      return (data?.data?.Page?.media ?? []).map((m) => toShow(m))
    } catch (error) {
      log.error({ error }, 'AnimeGG search failed')
      return []
    }
  }

  async function fetchHtml(url, referer) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,*/*',
          Referer: referer || `${base}/`,
        },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) return null
      return await res.text()
    } catch {
      return null
    }
  }

  async function searchSlugs(query) {
    const cacheKey = `animegg_search_${normalizeTitle(query)}`
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const html = await fetchHtml(`${base}/search/?q=${encodeURIComponent(query)}`)
    const results = []
    if (html) {
      for (const m of html.matchAll(
        /<a\b[^>]*class=["'][^"']*\bmse\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi
      )) {
        const tag = m[0].match(/<a\b[^>]*>/i)?.[0] ?? ''
        const href = attr(tag, 'href')
        const slug = href.match(/^\/series\/([^/?#]+)/)?.[1]
        if (!slug) continue
        const strong = m[0].match(/<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1]
        results.push({ slug, text: strong ? stripTags(strong) : slug.replace(/-/g, ' ') })
      }
    }
    cache.set(cacheKey, results, 86400)
    return results
  }

  async function resolveShowId(title) {
    try {
      const candidates = await searchSlugs(title)
      if (candidates.length === 0) return null
      let best = candidates[0]
      let bestScore = -1
      for (const c of candidates) {
        const score = scoreCandidate(c.slug, c.text, title)
        if (score > bestScore) {
          bestScore = score
          best = c
        }
      }
      return bestScore >= 0 ? best.slug : null
    } catch {
      return null
    }
  }

  async function scrapeSeries(slug) {
    const cacheKey = `animegg_series_${slug}`
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const html = await fetchHtml(`${base}/series/${slug}`)
    const episodes = []
    if (html) {
      for (const m of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
        const block = m[1]
        if (!/\banm_det_pop\b/.test(block)) continue
        const link = block.match(/<a\b[^>]*class=["'][^"']*anm_det_pop[^"']*["'][^>]*>/i)?.[0] ?? ''
        const href = attr(link, 'href').replace(/#.*$/, '').replace(/^\//, '')
        const strong = stripTags(block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1] ?? '')
        const numMatch = strong.match(/(\d+)-(\d+)\s*$/) || strong.match(/(\d+)\s*$/)
        if (!numMatch || !href) continue
        const number = parseInt(numMatch[1], 10)
        const title =
          stripTags(
            block.match(/<i\b[^>]*class=["'][^"']*anititle[^"']*["'][^>]*>([\s\S]*?)<\/i>/i)?.[1] ??
              ''
          ) || strong
        episodes.push({
          number,
          title,
          epSlug: href,
          hasSub: /\bbtn-subbed\b/.test(block),
          hasDub: /\bbtn-dubbed\b/.test(block),
        })
      }
    }
    episodes.sort((a, b) => a.number - b.number)
    const seen = new Set()
    const unique = episodes.filter((e) => (seen.has(e.number) ? false : (seen.add(e.number), true)))
    cache.set(cacheKey, unique, 3600)
    return unique
  }

  async function getEpisodes(showId) {
    try {
      if (!showId || /^\d+$/.test(showId)) return null
      const episodes = await scrapeSeries(showId)
      if (episodes.length === 0) return null
      return { episodes: episodes.map((e) => String(e.number)), description: '' }
    } catch (error) {
      log.error({ error, showId }, 'AnimeGG getEpisodes failed')
      return null
    }
  }

  async function scrapeEmbed(embedId) {
    const html = await fetchHtml(`${base}/embed/${embedId}`, base)
    if (!html) return []
    const m = html.match(/var\s+videoSources\s*=\s*(\[[\s\S]*?\]);/)
    if (!m) return []
    try {
      const asJson = m[1]
        .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
        .replace(/:\s*'([^']*)'/g, ': "$1"')
      const parsed = JSON.parse(asJson)
      return parsed
        .filter((s) => s.file)
        .map((s) => ({
          quality: s.label || 'unknown',
          url: s.file.startsWith('http') ? s.file : `${base}${s.file}`,
        }))
    } catch {
      return []
    }
  }

  async function getStreamUrls(showId, episodeNumber, mode = 'sub') {
    if (!showId || /^\d+$/.test(showId)) return null
    const targetEpisode = episodeNumber === '0' ? '1' : episodeNumber
    try {
      const cacheKey = `animegg_stream_${showId}_${targetEpisode}_${mode}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      const episodes = await scrapeSeries(showId)
      const ep = episodes.find((e) => e.number === Number(targetEpisode))
      if (!ep || (mode === 'sub' ? !ep.hasSub : !ep.hasDub)) return null

      const html = await fetchHtml(`${base}/${ep.epSlug}`, base)
      if (!html) return null
      const tabs = []
      for (const m of html.matchAll(/<a\b[^>]*data-toggle=["']tab["'][^>]*>/gi)) {
        const tag = m[0]
        const embedId = attr(tag, 'data-id')
        if (!embedId) continue
        const server = attr(tag, 'data-mirror') || 'AnimeGG'
        const version = attr(tag, 'data-version') || 'subbed'
        const normalized = version.startsWith('dub') ? 'dub' : 'sub'
        if (normalized === mode) tabs.push({ embedId, server, normalized })
      }
      if (tabs.length === 0) return null

      const links = []
      const iframeLinks = []
      for (const tab of tabs) {
        const embedUrl = `${base}/embed/${tab.embedId}`
        const sources = await scrapeEmbed(tab.embedId)
        if (sources.length === 0) {
          iframeLinks.push({
            link: embedUrl,
            resolutionStr: 'Auto',
            hls: false,
            headers: { Referer: `${base}/` },
          })
          continue
        }
        for (const s of sources) {
          links.push({
            resolutionStr: s.quality,
            link: s.url,
            hls: s.url.includes('.m3u8'),
            headers: { Referer: `${base}/`, 'User-Agent': UA },
          })
        }
        iframeLinks.push({
          link: embedUrl,
          resolutionStr: 'Auto',
          hls: false,
          headers: { Referer: `${base}/` },
        })
      }

      const sources = []
      if (links.length > 0) {
        sources.push({
          sourceName: `AnimeGG (${mode.toUpperCase()})`,
          links,
          subtitles: [],
          type: 'player',
          actualEpisodeNumber: targetEpisode,
        })
      }
      if (iframeLinks.length > 0) {
        sources.push({
          sourceName: `AnimeGG (${mode.toUpperCase()}) [Fallback]`,
          links: iframeLinks,
          subtitles: [],
          type: 'iframe',
          actualEpisodeNumber: targetEpisode,
        })
      }
      if (sources.length === 0) return null
      cache.set(cacheKey, sources, 600)
      return sources
    } catch (error) {
      log.error({ error, showId, episodeNumber, mode }, '[AnimeGG] getStreamUrls failed')
      return null
    }
  }

  return {
    name: 'AnimeGG',
    search,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
  }
}
