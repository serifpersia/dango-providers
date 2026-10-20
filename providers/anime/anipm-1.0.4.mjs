const BASE = 'https://ani.pm'
const EMBED_ORIGIN = 'https://embed.settlar.io'

export default function createProvider(ctx) {
  const log = ctx.logger

  function toShow(item) {
    const id = item.anilistId ? String(item.anilistId) : `settlar:${item.id}`
    return {
      _id: id,
      id,
      name: item.title,
      englishName: item.providerTitles?.[0] !== item.title ? item.providerTitles?.[0] : undefined,
      nativeName: item.native,
      names: {
        romaji: item.title,
        english: item.providerTitles?.find((t) => /^[\x20-\x7e]+$/.test(t)),
        native: item.native,
      },
      thumbnail: item.poster ? new URL(item.poster, BASE).href : undefined,
      type: item.type,
      year: item.year ?? null,
      episodeCount: item.episodeCount ?? null,
      description: item.synopsis ?? '',
      status: item.status,
      genres: item.genres?.map((name) => ({ name })),
      studios: item.studios?.map((name) => ({ name })),
      score: item.score ?? null,
      isAdult: item.rating === 'Rx',
    }
  }

  async function search(options) {
    const query = (options.query || '').trim()
    if (!query) return []
    try {
      const data = await ctx.fetchJson(`${BASE}/api/anime/search?q=${encodeURIComponent(query)}`)
      return (data?.items || []).map(toShow)
    } catch (error) {
      log.error({ error }, '[AniPM] search failed')
      return []
    }
  }

  async function resolveShowId(title, romaji) {
    return ctx.resolveBestShowId(title, romaji, async (variant) => {
      const results = await search({ query: variant })
      return results.map((show) => ({ title: show.name, id: show._id }))
    })
  }

  function isDirectId(showId) {
    return /^\d+$/.test(showId.trim())
  }

  function bootstrapUrl(showId, episode, mode) {
    const source = showId.startsWith('settlar:')
      ? `settlar/${showId.slice('settlar:'.length)}`
      : /^\d+$/.test(showId)
        ? `anilist/${showId}`
        : null
    if (!source) return null
    return `${BASE}/api/anime/playback-bootstrap/${source}?ep=${encodeURIComponent(episode)}&lang=${mode}&backup=1`
  }

  async function getBootstrap(showId, episode, mode) {
    const url = bootstrapUrl(showId, episode, mode)
    if (!url) return null
    try {
      const data = await ctx.fetchJson(url)
      return data?.core ? data : null
    } catch {
      return null
    }
  }

  async function getEpisodes(showId, mode = 'sub') {
    const cacheKey = `anipm_eps_${showId}_${mode}`
    const cached = ctx.cache.get(cacheKey)
    if (cached) return cached
    const lang = mode === 'dub' ? 'dub' : 'sub'
    const data = (await getBootstrap(showId, '1', lang)) || (await getBootstrap(showId, '1', 'sub'))
    const episodes = (data?.core?.episodes || [])
      .filter((ep) => ep[data.effectiveLanguage === 'dub' ? 'dub' : 'sub'] !== false)
      .map((ep) => String(ep.number))
    if (episodes.length === 0) return null
    const result = { episodes, description: '' }
    ctx.cache.set(cacheKey, result, 3600)
    return result
  }

  async function resolveChannel(selection, episode, channel) {
    try {
      const session = await ctx.fetchJson(
        `${BASE}/api/anime/settlar/session?selection=${encodeURIComponent(selection)}&provider=anipm&ep=${encodeURIComponent(episode)}&channel=${channel}&telemetry=0`
      )
      if (!session?.embedUrl) return null
      const token = new URL(session.embedUrl).searchParams.get('t')
      if (!token) return null
      const res = await ctx.scraping.fetch({
        url: `${EMBED_ORIGIN}/api/embed/session?t=${encodeURIComponent(token)}`,
        headers: {
          Accept: 'application/json',
          Referer: session.embedUrl,
          Origin: EMBED_ORIGIN,
        },
        timeout: { request: 20000 },
        followRedirect: true,
      })
      if (res.statusCode !== 200) return null
      const data = JSON.parse(res.body)
      if (data?.kind !== 'hls' || !data?.source) return null
      return data
    } catch (error) {
      log.warn({ error, episode, channel }, '[AniPM] channel resolve failed')
      return null
    }
  }

  async function fetchVariants(source) {
    try {
      const res = await ctx.scraping.fetch({
        url: source,
        headers: { Accept: '*/*', Referer: EMBED_ORIGIN },
        timeout: { request: 20000 },
      })
      if (res.statusCode !== 200) return []
      const variants = []
      const re = /#EXT-X-STREAM-INF:([^\n]*)\n(\S+)/g
      let m
      let idx = 0
      while ((m = re.exec(res.body)) !== null) {
        const i = idx++
        const label =
          m[1].match(/NAME="([^"]+)"/)?.[1] || (m[1].match(/RESOLUTION=\d+x(\d+)/)?.[1] ?? '') + 'p'
        if (!label || label === 'p') continue
        variants.push({
          resolutionStr: label,
          link: `${ctx.proxyUrl(source, EMBED_ORIGIN)}&variant=${i}`,
          hls: true,
          headers: { Referer: EMBED_ORIGIN },
        })
      }
      return variants
    } catch {
      return []
    }
  }

  async function getStreamUrls(showId, episodeNumber, mode = 'sub') {
    const targetEpisode = episodeNumber === '0' ? '1' : episodeNumber
    const cacheKey = `anipm_stream_${showId}_${targetEpisode}_${mode}`
    const cached = ctx.cache.get(cacheKey)
    if (cached) return cached
    const data =
      (await getBootstrap(showId, targetEpisode, mode === 'dub' ? 'dub' : 'sub')) ||
      (await getBootstrap(showId, targetEpisode, 'sub'))
    if (!data?.settlarSelection) return null
    const lang = data.effectiveLanguage === 'dub' ? 'dub' : 'sub'
    const flags = data.anipmPackages?.episodes?.[targetEpisode]
    const channels =
      lang === 'dub'
        ? [
            ['dub', 'DUB'],
            ['dubhard', 'DUB HARDSUB'],
            ['dubcr', 'CR DUB'],
          ]
        : [
            ['sub', 'SUB'],
            ['subhard', 'HARDSUB'],
            ['subcr', 'CR SUB'],
          ]
    const enabled = channels.filter(([channel]) =>
      flags ? flags[channel] === true : !channel.endsWith('cr')
    )
    const streams = await Promise.all(
      enabled.map(async ([channel, label]) => {
        const stream = await resolveChannel(data.settlarSelection, targetEpisode, channel)
        if (!stream) return null
        return {
          sourceName: `AniPM (${label})`,
          links: [
            ...(await fetchVariants(stream.source)),
            {
              resolutionStr: 'Auto',
              link: ctx.proxyUrl(stream.source, EMBED_ORIGIN),
              hls: true,
              headers: { Referer: EMBED_ORIGIN },
            },
          ],
          subtitles: (stream.subtitles || []).map((sub) => ({
            language: sub.srclang || sub.label,
            label: sub.label,
            url: sub.url,
          })),
          type: 'player',
          actualEpisodeNumber: targetEpisode,
        }
      })
    )
    const backup = data.backupEmbed
    if (backup?.available && String(backup.episode) === String(targetEpisode) && backup.url) {
      streams.push({
        sourceName: 'AniPM (BACKUP)',
        links: [
          {
            resolutionStr: 'Auto',
            link: backup.url,
            hls: false,
            headers: { Referer: 'https://megaplay.buzz/' },
          },
        ],
        subtitles: [],
        type: 'iframe',
        actualEpisodeNumber: targetEpisode,
      })
    }
    const result = streams.filter(Boolean)
    if (result.length === 0) return null
    ctx.cache.set(cacheKey, result, 300)
    return result
  }

  return {
    name: 'AniPM',
    search,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
    isDirectId,
  }
}
