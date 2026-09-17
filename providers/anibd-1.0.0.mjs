const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export default function createProvider(ctx) {
  const cache = ctx.cache
  const log = ctx.logger
  const base = 'https://epeng.animeapps.top'
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
      log.error({ error }, 'AniBD search failed')
      return []
    }
  }

  async function resolveShowId(title) {
    try {
      const hit = await ctx.anilist.searchByTitle(title)
      return hit ? String(hit.id) : null
    } catch {
      return null
    }
  }

  function isDirectId(showId) {
    return /^\d+$/.test(showId.trim())
  }

  async function fetchGroups(anilistId) {
    const cacheKey = `anibd_groups_${anilistId}`
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const res = await fetch(`${base}/api2.php?epid=${encodeURIComponent(anilistId)}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const data = await res.json().catch(() => [])
    const groups = Array.isArray(data) ? data : []
    cache.set(cacheKey, groups, 3600)
    return groups
  }

  async function getEpisodes(showId) {
    try {
      if (!/^\d+$/.test(showId)) return null
      const groups = await fetchGroups(showId)
      const numbers = new Set()
      for (const group of groups) {
        for (const ep of group.server_data ?? []) {
          const n = Number(ep.name ?? ep.slug)
          if (Number.isFinite(n) && n >= 1) numbers.add(String(Math.floor(n)))
        }
      }
      if (numbers.size === 0) return null
      return {
        episodes: [...numbers].sort((a, b) => Number(a) - Number(b)),
        description: '',
      }
    } catch (error) {
      log.error({ error, showId }, 'AniBD getEpisodes failed')
      return null
    }
  }

  function isDubGroup(group) {
    return /dub/i.test(group.server_name || '')
  }

  async function resolvePlayerHls(playerLink) {
    try {
      const origin = new URL(playerLink).origin
      const referer = `${origin}/`
      const res = await fetch(playerLink, {
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*', Referer: referer },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return null
      const html = await res.text()
      const match = html.match(/videoUrl\s*:\s*"([^"]+)"/)
      if (!match) return null
      const raw = match[1]
      const hls = /^https?:\/\//i.test(raw)
        ? raw
        : `${origin}${raw.startsWith('/') ? '' : '/'}${raw}`
      return { hls, referer }
    } catch {
      return null
    }
  }

  async function getStreamUrls(showId, episodeNumber, mode = 'sub') {
    if (!/^\d+$/.test(showId)) return null
    const targetEpisode = episodeNumber === '0' ? '1' : episodeNumber
    try {
      const cacheKey = `anibd_stream_${showId}_${targetEpisode}_${mode}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      const groups = await fetchGroups(showId)
      if (groups.length === 0) return null
      const wantDub = mode === 'dub'
      const matching = groups.filter((g) => isDubGroup(g) === wantDub)
      const candidates = matching.length > 0 ? matching : groups

      let providerLink = null
      for (const group of candidates) {
        const ep = (group.server_data ?? []).find(
          (e) => Number(e.name ?? e.slug) === Number(targetEpisode)
        )
        if (ep?.link) {
          providerLink = ep.link
          break
        }
      }
      if (!providerLink) return null

      const res = await fetch(`${base}/apilink.php?data=${encodeURIComponent(providerLink)}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return null
      const servers = await res.json().catch(() => [])
      if (!Array.isArray(servers) || servers.length === 0) return null

      const links = []
      const iframeLinks = []
      for (const entry of servers) {
        if (!entry?.link) continue
        const resolved = await resolvePlayerHls(entry.link)
        if (resolved) {
          links.push({
            resolutionStr: 'Auto',
            link: resolved.hls,
            hls: true,
            headers: { Referer: resolved.referer, 'User-Agent': UA },
          })
        } else {
          iframeLinks.push({
            link: entry.link,
            resolutionStr: 'Auto',
            hls: false,
            headers: { Referer: `${new URL(entry.link).origin}/` },
          })
        }
      }

      const sources = []
      if (links.length > 0) {
        sources.push({
          sourceName: `AniBD (${mode.toUpperCase()})`,
          links,
          subtitles: [],
          type: 'player',
          actualEpisodeNumber: targetEpisode,
        })
      }
      if (iframeLinks.length > 0) {
        sources.push({
          sourceName: `AniBD (${mode.toUpperCase()}) [Fallback]`,
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
      log.error({ error, showId, episodeNumber, mode }, '[AniBD] getStreamUrls failed')
      return null
    }
  }

  return {
    name: 'AniBD',
    search,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
    isDirectId,
  }
}
