const BASE = 'https://anizone.to'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
const IDENTITY_TTL_SECONDS = 7 * 24 * 60 * 60
const NATIVE_PREFIX = 'anizone:'

export default function createProvider(ctx) {
  const cache = ctx.cache
  const log = ctx.logger
  const proxyUrl = ctx.proxyUrl

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function normalizeUrl(value) {
    return String(value || '').replace(/\\+\//g, '/')
  }

  function decodeEntities(value) {
    return String(value ?? '')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  }

  function decodeJsonArgument(raw) {
    if (!raw) return null
    const marker = '\x01U\x01'
    let value = String(raw).replace(/\\\\u([0-9a-fA-F]{4})/g, `${marker}$1`)
    value = value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    value = value.replace(/\x01U\x01([0-9a-fA-F]{4})/g, '\\u$1')
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  function norm(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '')
  }

  function bigrams(value) {
    const out = []
    for (let i = 0; i < value.length - 1; i++) out.push(value.slice(i, i + 2))
    return out
  }

  function diceCoeff(left, right) {
    const a = norm(left)
    const b = norm(right)
    if (!a || !b) return 0
    if (a === b) return 1
    const counts = new Map()
    for (const gram of bigrams(b)) counts.set(gram, (counts.get(gram) ?? 0) + 1)
    let hits = 0
    for (const gram of bigrams(a)) {
      const remaining = counts.get(gram) ?? 0
      if (remaining > 0) {
        hits++
        counts.set(gram, remaining - 1)
      }
    }
    return (2 * hits) / (bigrams(a).length + bigrams(b).length || 1)
  }

  function jsonArgument(html, name) {
    const pattern = new RegExp(`${escapeRegex(name)}\\s*:\\s*JSON\\.parse\\('((?:[^'\\\\]|\\\\.)*)'\\)`, 'i')
    return decodeJsonArgument(String(html).match(pattern)?.[1])
  }

  function playerData(html) {
    const match = String(html).match(/vidstackPlayer\s*\(\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)\s*\)/i)
    return decodeJsonArgument(match?.[1])
  }

  function responseCookies(response) {
    if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie()
    const value = response.headers.get('set-cookie')
    return value ? [value] : []
  }

  function mergeCookies(jar, values) {
    for (const value of values) {
      const match = String(value).match(/^\s*([^=;\s]+)=([^;]*)/)
      if (match) jar.set(match[1], match[2])
    }
    return jar
  }

  function cookieHeader(jar) {
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers,
      },
      signal: options.signal || AbortSignal.timeout(15000),
    })
    const raw = await response.text()
    if (!response.ok) {
      const error = new Error(`AniZone HTTP ${response.status}: ${url}`)
      error.rawBody = raw
      throw error
    }
    return { raw, cookies: responseCookies(response) }
  }

  async function fetchPage(path) {
    return request(`${BASE}${path}`, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${BASE}/`,
      },
    })
  }

  async function getMedia(anilistId) {
    const query = `query ($id: Int) {
      Media (id: $id, type: ANIME) {
        id
        title { romaji english native }
        synonyms
        format
        status
        episodes
        seasonYear
        startDate { year }
      }
    }`
    const data = await ctx.anilist.request(query, { id: Number(anilistId) })
    return data?.data?.Media ?? null
  }

  function buildTitles(media) {
    return [
      ...new Set(
        [media?.title?.english, media?.title?.romaji, media?.title?.native, ...(media?.synonyms ?? [])].filter(
          Boolean
        )
      ),
    ]
  }

  function pickTitle(titles) {
    return titles?.['1'] || titles?.['5'] || titles?.['8'] || Object.values(titles || {})[0] || ''
  }

  function titleValues(item) {
    return [...new Set([item?.main_title, ...Object.values(item?.title_list || {})].filter(Boolean))]
  }

  function formatName(value) {
    const type = String(value || '').toLowerCase()
    if (type.includes('special')) return 'special'
    if (type.includes('movie')) return 'movie'
    if (type.includes('ova')) return 'ova'
    if (type.includes('web') || type.includes('ona')) return 'ona'
    if (type.includes('tv')) return 'tv'
    return ''
  }

  function expectedFormat(value) {
    const format = String(value || '').toUpperCase()
    if (format === 'TV' || format === 'TV_SHORT') return 'tv'
    if (format === 'MOVIE') return 'movie'
    if (format === 'OVA') return 'ova'
    if (format === 'ONA') return 'ona'
    if (format === 'SPECIAL') return 'special'
    return ''
  }

  function searchQueries(titles) {
    const queries = new Set()
    for (const raw of titles.slice(0, 8)) {
      const title = String(raw || '').replace(/\s+/g, ' ').trim()
      if (!title) continue
      queries.add(title)
      const plain = title.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
      if (plain.length >= 3) queries.add(plain)
      const words = plain.split(/\s+/).filter(Boolean)
      if (words.length > 4) queries.add(words.slice(0, 4).join(' '))
      const family = plain
        .replace(/\b(?:the\s+)?final\s+chapters?\b/gi, ' ')
        .replace(/\bfinal\s+(?:arc|edition)\b/gi, ' ')
        .replace(/\b(?:kanketsu|kouhen|zenpen)\s*(?:hen)?\b/gi, ' ')
        .replace(/\b(?:the\s+)?movie\b/gi, ' ')
        .replace(/\b(?:season|part|cour|chapter)\s*(?:\d+|one|two|three|four|final)?\b/gi, ' ')
        .replace(/\b(?:final|special)\s*(?:\d+|one|two|three|four)?\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (family.length >= 3) queries.add(family)
    }
    return [...queries].filter((query) => query.length >= 3).slice(0, 8)
  }

  function parseSearchItems(html) {
    const items = jsonArgument(html, 'items')
    if (!Array.isArray(items)) return []
    return items
      .filter((item) => /^[a-z0-9-]+$/i.test(String(item?.slug || '')))
      .map((item) => ({
        slug: String(item.slug),
        title: pickTitle(item.title_list) || item.main_title || '',
        titles: titleValues(item),
        type: formatName(item.type),
        year: Number(item.start_year) || null,
        episodeCount: Number(item.episode_count) || 0,
      }))
      .filter((item) => item.title)
  }

  async function searchSite(query) {
    const { raw } = await fetchPage(`/anime?search=${encodeURIComponent(query)}`)
    return parseSearchItems(raw)
  }

  function candidateTitleScore(titles, candidate) {
    let best = 0
    for (const title of titles) {
      for (const value of candidate.titles) best = Math.max(best, diceCoeff(title, value))
    }
    return best
  }

  function coverageScore(candidate, expected, status) {
    if (!expected || expected < 1) return 0.5
    if (candidate.episodeCount < 1) return 0
    if (expected < 6) return 1
    const needed = status === 'FINISHED' ? Math.ceil(expected * 0.8) : Math.max(1, expected - 3)
    return Math.min(1, candidate.episodeCount / needed)
  }

  function validateCandidate(candidate, media, titles, expected) {
    const titleScore = candidateTitleScore(titles, candidate)
    const format = expectedFormat(media?.format)
    const year = Number(media?.startDate?.year ?? media?.seasonYear ?? 0) || null
    if (titleScore < 0.68) return null
    if (format && candidate.type && format !== candidate.type) return null
    if (year && candidate.year && year !== candidate.year) return null
    const coverage = coverageScore(candidate, expected, media?.status)
    if (expected >= 6 && coverage < 0.8) return null
    const score =
      titleScore * 0.72 +
      (format && candidate.type === format ? 0.14 : 0.07) +
      (year && candidate.year === year ? 0.1 : 0.04) +
      coverage * 0.04
    return { ...candidate, titleScore, coverage, score }
  }

  async function resolveSeries(anilistId) {
    const cacheKey = `anizone:identity:${anilistId}`
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const media = await getMedia(anilistId)
    if (!media) throw new Error(`AniZone: no AniList media for ${anilistId}`)
    const titles = buildTitles(media)
    const expected = media.episodes ?? null
    const discovered = new Map()
    await Promise.all(
      searchQueries(titles).map(async (query) => {
        try {
          for (const candidate of await searchSite(query)) {
            if (!discovered.has(candidate.slug)) discovered.set(candidate.slug, candidate)
          }
        } catch {
          // ignore
        }
      })
    )
    const valid = [...discovered.values()]
      .map((candidate) => validateCandidate(candidate, media, titles, expected))
      .filter(Boolean)
      .sort((left, right) => right.score - left.score)
    const selected = valid[0]
    const runnerUp = valid[1]
    if (!selected || selected.score < 0.82 || (runnerUp && selected.score - runnerUp.score < 0.08)) {
      throw new Error(`AniZone match not confident for AniList ${anilistId}`)
    }
    const data = { slug: selected.slug, title: selected.title, matchScore: selected.titleScore, score: selected.score }
    cache.set(cacheKey, data, IDENTITY_TTL_SECONDS)
    return data
  }

  function snapshot(html) {
    const match = [...String(html).matchAll(/wire:snapshot="([^"]*)"/gi)].find((item) =>
      item[1].includes('pages.anime-detail')
    )
    return match ? decodeEntities(match[1]) : ''
  }

  function cursor(html) {
    return String(html).match(/nextCursor:\s*'([^']+)'/i)?.[1] || null
  }

  function hasMore(html) {
    return /hasMore:\s*true/i.test(String(html))
  }

  function csrf(html) {
    return String(html).match(/csrf-token"\s+content="([^"]+)"/i)?.[1] || ''
  }

  function seconds(value) {
    const parts = String(value || '').match(/^(\d+):(\d{1,2})$/)
    if (!parts) return null
    return Number(parts[1]) * 60 + Number(parts[2])
  }

  function episodeNumber(item) {
    const direct = Number(item?.slug)
    if (Number.isFinite(direct) && direct > 0) return direct
    const fromUrl = normalizeUrl(item?.url).match(/\/(\d+)\/?$/)?.[1]
    const number = Number(fromUrl)
    return Number.isFinite(number) && number > 0 ? number : null
  }

  function parseEpisodes(items) {
    const seen = new Set()
    return items
      .map((item) => {
        const number = episodeNumber(item)
        if (!number || seen.has(number)) return null
        seen.add(number)
        return {
          number,
          sourceNumber: number,
          title: pickTitle(item.title_list) || `Episode ${number}`,
          duration: seconds(item.duration),
          description: item.summary || null,
          image: normalizeUrl(item.snapshot) || null,
          airDate: item.air_date || null,
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.number - right.number)
  }

  function initialPage(html, cookies) {
    const items = jsonArgument(html, 'items')
    const data = {
      items: Array.isArray(items) ? items : [],
      snapshot: snapshot(html),
      cursor: cursor(html),
      hasMore: hasMore(html),
      csrf: csrf(html),
      cookies: mergeCookies(new Map(), cookies),
    }
    if (!data.items.length || !data.snapshot || !data.csrf) {
      throw new Error('AniZone page payload not found')
    }
    return data
  }

  async function loadPage(state, slug) {
    const response = await request(`${BASE}/livewire/update`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'X-Livewire': '',
        'X-CSRF-TOKEN': state.csrf,
        'X-Requested-With': 'XMLHttpRequest',
        Origin: BASE,
        Referer: `${BASE}/anime/${slug}`,
        Cookie: cookieHeader(state.cookies),
      },
      body: JSON.stringify({
        components: [
          {
            snapshot: state.snapshot,
            updates: {},
            calls: [{ path: '', method: 'loadPage', params: [state.cursor] }],
          },
        ],
      }),
    })
    let payload
    try {
      payload = JSON.parse(response.raw)
    } catch {
      throw new Error('AniZone returned invalid Livewire JSON')
    }
    const component = payload?.components?.[0]
    const dispatch = component?.effects?.dispatches?.find((item) => item?.name === 'items-loaded')
    if (!component?.snapshot || !dispatch?.params || !Array.isArray(dispatch.params.items)) {
      throw new Error('AniZone page continuation payload not found')
    }
    return {
      items: dispatch.params.items,
      snapshot: component.snapshot,
      cursor: dispatch.params.nextCursor || null,
      hasMore: Boolean(dispatch.params.hasMore),
      csrf: state.csrf,
      cookies: mergeCookies(state.cookies, response.cookies),
    }
  }

  async function scrapeSeries(slug, limit, maxPages) {
    const initial = await fetchPage(`/anime/${slug}`)
    let state = initialPage(initial.raw, initial.cookies)
    const items = [...state.items]
    let pages = 1
    while (state.hasMore && state.cursor && items.length < limit && pages < maxPages) {
      state = await loadPage(state, slug)
      items.push(...state.items)
      pages++
    }
    const episodes = parseEpisodes(items)
    if (!episodes.length) throw new Error(`AniZone has no episodes for ${slug}`)
    return episodes
  }

  function nativeSlug(showId) {
    const s = String(showId || '')
    return s.startsWith(NATIVE_PREFIX) ? s.slice(NATIVE_PREFIX.length) : null
  }

  async function scrapeWatch(slug, episode) {
    const { raw } = await fetchPage(`/anime/${slug}/${episode}`)
    const player = playerData(raw)
    if (!player?.src) throw new Error(`AniZone player payload not found for episode ${episode}`)
    return {
      hls: normalizeUrl(player.src),
      subtitles: (Array.isArray(player.subtitles) ? player.subtitles : [])
        .filter((subtitle) => subtitle?.file)
        .map((subtitle) => ({
          url: normalizeUrl(subtitle.file),
          label: subtitle.title || subtitle.language || 'Unknown',
          language: subtitle.language || 'en',
        })),
    }
  }

  function toShow(item) {
    return {
      _id: `${NATIVE_PREFIX}${item.slug}`,
      name: item.title,
      englishName: item.title,
      year: item.year,
    }
  }

  async function search(options) {
    const query = String(options?.query || '').trim()
    if (!query) return []
    const discovered = new Map()
    await Promise.all(
      searchQueries([query]).map(async (q) => {
        try {
          for (const item of await searchSite(q)) {
            if (!discovered.has(item.slug)) discovered.set(item.slug, item)
          }
        } catch {
          // ignore
        }
      })
    )
    return [...discovered.values()]
      .map((item) => ({ item, score: candidateTitleScore([query], item) }))
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => toShow(item))
  }

  async function resolveShowId(title, romaji) {
    try {
      const targets = [...new Set([title, romaji].filter(Boolean))]
      if (!targets.length) return null
      const discovered = new Map()
      await Promise.all(
        targets.flatMap((t) => searchQueries([t])).map(async (q) => {
          try {
            for (const item of await searchSite(q)) {
              if (!discovered.has(item.slug)) discovered.set(item.slug, item)
            }
          } catch {
            // ignore
          }
        })
      )
      let best = null
      for (const item of discovered.values()) {
        const score = candidateTitleScore(targets, item)
        if (score >= 0.68 && (!best || score > best.score)) best = { item, score }
      }
      return best ? `${NATIVE_PREFIX}${best.item.slug}` : null
    } catch (e) {
      log.error({ error: e.message, title }, 'AniZone resolveShowId failed')
      return null
    }
  }

  function isDirectId(showId) {
    return String(showId || '').startsWith(NATIVE_PREFIX)
  }

  async function getEpisodes(showId, mode) {
    try {
      if (mode === 'dub') return null
      const slug = nativeSlug(showId)
      let episodes
      let expected = null
      let epSlug = slug
      if (slug) {
        episodes = await scrapeSeries(slug, Infinity, Infinity)
      } else if (/^\d+$/.test(String(showId || '').trim())) {
        const series = await resolveSeries(Number(showId))
        const media = await getMedia(Number(showId)).catch(() => null)
        expected = media?.episodes ?? null
        epSlug = series.slug
        episodes = await scrapeSeries(series.slug, expected ?? Infinity, Infinity)
      } else {
        return null
      }
      const list = expected ? episodes.filter((e) => e.number <= expected) : episodes
      if (!list.length) return null
      cache.set(
        `anizone_epmap_${epSlug ?? showId}`,
        Object.fromEntries(list.map((e) => [String(e.number), e.sourceNumber])),
        3600
      )
      return {
        episodes: list.map((e) => String(e.number)),
        description: '',
        availableEpisodesDetail: list.map((e) => ({ number: String(e.number), title: e.title })),
      }
    } catch (e) {
      log.error({ error: e.message, showId }, 'AniZone getEpisodes failed')
      return null
    }
  }

  async function getStreamUrls(showId, episodeNumber, mode) {
    try {
      if (mode === 'dub') return null
      const ep = String(episodeNumber || '')
      if (!ep) return null
      let slug = nativeSlug(showId)
      if (!slug) {
        if (!/^\d+$/.test(String(showId || '').trim())) return null
        slug = (await resolveSeries(Number(showId))).slug
      }
      const epmap = cache.get(`anizone_epmap_${slug}`) ?? cache.get(`anizone_epmap_${showId}`)
      let sourceNumber = epmap?.[ep]
      if (!sourceNumber) {
        const episodes = await scrapeSeries(slug, Infinity, Infinity)
        const found = episodes.find((e) => String(e.number) === ep)
        if (!found) return null
        sourceNumber = found.sourceNumber
      }
      const watch = await scrapeWatch(slug, sourceNumber)
      const link = proxyUrl(watch.hls, `${BASE}/`)
      return [
        {
          sourceName: 'AniZone',
          links: [
            {
              resolutionStr: 'Auto',
              link,
              hls: watch.hls.includes('.m3u8'),
              headers: { Referer: `${BASE}/` },
            },
          ],
          subtitles: watch.subtitles.length ? watch.subtitles : undefined,
        },
      ]
    } catch (e) {
      log.error({ error: e.message, showId, episodeNumber }, 'AniZone getStreamUrls failed')
      return null
    }
  }

  return { name: 'anizone', search, getEpisodes, getStreamUrls, resolveShowId, isDirectId }
}
