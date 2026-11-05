const BASE_URL = 'https://app.dehentai.com'
const API_URL = 'https://api.dehentai.com/v1'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

export const DH_TAGS = [
  'ahegao',
  'anal',
  'blow-job',
  'bondage',
  'creampie',
  'dark-skin',
  'double-penetration',
  'dub',
  'femdom',
  'fingering',
  'footjob',
  'forced',
  'futa',
  'glasses',
  'group',
  'hand-job',
  'harem',
  'humiliation',
  'impregnation',
  'incest',
  'lolicon',
  'maid',
  'masturbation',
  'mind-control',
  'monster-girls',
  'netorare',
  'nurse',
  'oppai',
  'oral',
  'orgy',
  'outdoors',
  'paizuri',
  'pantyhose',
  'pettanko',
  'public',
  'rape',
  'schoolgirl',
  'sex-toys',
  'stocking',
  'swimsuit',
  'teacher',
  'tentacles',
  'threesome',
  'tsundere',
  'uncensored',
  'urination',
  'vanilla',
  'xray',
  'yuri',
]

function parseEpisode(title) {
  const raw = String(title || '').trim()
  const m =
    /^(.*?)(?:\s*[-–—:]?\s*(?:episode|episodio|ep\.?)\s*(\d+(?:\.\d+)?))(?:\s+(?:english\s+)?subbed|\s+uncensored|\s+censored)?\s*$/i.exec(
      raw
    ) || /^(.*?)\s+(\d+)\s*$/.exec(raw)
  if (m && m[1].trim()) {
    const ep = parseFloat(m[2])
    if (ep > 0 && ep < 1000) {
      return { series: m[1].replace(/[-–—:\s]+$/, '').trim(), episode: ep }
    }
  }
  return { series: raw, episode: 1 }
}

async function apiJson(path, sessionId) {
  const res = await fetch(API_URL + path, {
    headers: {
      Accept: 'application/json',
      'Nc-Session-Id': sessionId,
      Origin: BASE_URL,
      Referer: BASE_URL + '/',
      'User-Agent': UA,
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error('DeHentai HTTP ' + res.status)
  const data = await res.json()
  if (data && data.message === 'Access denied') throw new Error('DeHentai access denied')
  return data
}

export default function createProvider(ctx) {
  const log = ctx.logger
  const sessionId = 'dango' + Math.random().toString(36).slice(2, 10)

  async function search(options) {
    try {
      const query = String((options && options.query) || '').trim()
      const q = query.replace(/[^\w\s\u3040-\u30ff\u4e00-\u9faf]+/g, ' ').trim()
      if (q.length < 3) return []
      const data = await apiJson(
        '/videos?field=title&query=' + encodeURIComponent(q) + '&page=1&sort=dt&order=desc',
        sessionId
      )
      const videos = (data && data.videos) || []
      if (!Array.isArray(videos) || videos.length === 0) return []
      const bySeries = {}
      const results = []
      for (const v of videos) {
        if (!v || !v.gid || !v.title) continue
        const parsed = parseEpisode(v.title)
        const key = parsed.series.toLowerCase()
        if (bySeries[key]) continue
        bySeries[key] = true
        results.push({
          title: parsed.series,
          id: String(v.gid) + '|' + encodeURIComponent(parsed.series),
        })
        if (results.length >= 25) break
      }
      return results
    } catch (error) {
      log.error({ error }, '[DeHentai] search failed')
      return []
    }
  }

  async function resolveShowId(title, _romaji) {
    try {
      const results = await search({ query: title })
      if (!results.length) return null
      const q = String(title).toLowerCase().trim()
      let best = results[0]
      let bestScore = -1
      for (const item of results) {
        const t = item.title.toLowerCase()
        let score = 0
        if (t === q) score = 3
        else if (t.startsWith(q)) score = 2
        else if (t.includes(q)) score = 1
        if (score > bestScore) {
          bestScore = score
          best = item
        }
      }
      return best.id
    } catch (error) {
      log.error({ error }, '[DeHentai] resolveShowId failed')
      return null
    }
  }

  async function getEpisodeEntries(showId) {
    const parts = String(showId || '').split('|')
    const seedGid = (parts[0] || '').trim()
    const seriesTitle = parts[1] ? decodeURIComponent(parts[1]) : ''
    if (!seedGid) return []
    const byEp = {}
    const addVideo = (v) => {
      if (!v || !v.gid || !v.title) return
      const parsed = parseEpisode(v.title)
      if (
        seriesTitle &&
        parsed.series.toLowerCase() !== seriesTitle.toLowerCase() &&
        v.gid !== seedGid
      )
        return
      const existing = byEp[parsed.episode]
      if (!existing) {
        byEp[parsed.episode] = {
          id: String(v.gid),
          number: parsed.episode,
          title: String(v.title),
        }
      }
    }
    if (seriesTitle.length >= 3) {
      try {
        const data = await apiJson(
          '/videos?field=title&query=' +
            encodeURIComponent(seriesTitle) +
            '&page=1&sort=dt&order=desc',
          sessionId
        )
        const list = (data && data.videos) || []
        for (const v of list) addVideo(v)
      } catch {}
    }
    if (Object.keys(byEp).length === 0) {
      const detail = await apiJson('/videos/' + encodeURIComponent(seedGid), sessionId)
      addVideo(detail)
      const sims = (detail && detail.similars) || []
      for (const s of sims) addVideo(s)
    }
    return Object.keys(byEp)
      .map((k) => byEp[k])
      .sort((a, b) => a.number - b.number)
  }

  async function getEpisodes(showId, _mode) {
    try {
      const entries = await getEpisodeEntries(showId)
      const episodes = entries.length ? entries.map((e) => String(e.number)) : ['1']
      return { episodes, description: '' }
    } catch (error) {
      log.error({ error, showId }, '[DeHentai] getEpisodes failed')
      return null
    }
  }

  async function getStreamUrls(showId, episodeNumber, _mode) {
    try {
      const entries = await getEpisodeEntries(showId)
      const ep = entries.find((e) => Number(e.number) === Number(episodeNumber))
      const gid = ep ? ep.id : String(showId).split('|')[0]
      const detail = await apiJson('/videos/' + encodeURIComponent(gid), sessionId)
      if (!detail || !detail.url) return null
      const host = String(detail.host || 'https://media.dehentai.com').replace(/\/+$/, '')
      const streamUrl = detail.url.startsWith('http') ? detail.url : host + detail.url
      return [
        {
          sourceName: 'DeHentai',
          links: [{ resolutionStr: 'Auto', link: streamUrl, hls: false }],
          type: 'player',
          actualEpisodeNumber: episodeNumber,
        },
      ]
    } catch (error) {
      log.error({ error, showId, episodeNumber }, '[DeHentai] getStreamUrls failed')
      return null
    }
  }

  async function browse(options) {
    try {
      const page = Math.max(1, (options && options.page) || 1)
      const query = String((options && options.query) || '').trim()
      const genre = String((options && (options.genre || options.genres)) || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
      let videos = []
      let pages = 1
      if (genre) {
        const data = await apiJson(
          '/videos?field=tags&query=' +
            encodeURIComponent(genre) +
            '&page=' +
            page +
            '&sort=dt&order=desc',
          sessionId
        )
        videos = (data && data.videos) || []
        pages = (data && data.pages) || page
      } else if (query.length >= 3) {
        const data = await apiJson(
          '/videos?field=title&query=' +
            encodeURIComponent(query) +
            '&page=' +
            page +
            '&sort=dt&order=desc',
          sessionId
        )
        videos = (data && data.videos) || []
        pages = (data && data.pages) || page
      } else {
        const data = await apiJson('/videos?page=' + page + '&sort=dt', sessionId)
        videos = (data && data.videos) || []
        pages = (data && data.pages) || page
      }
      const shows = videos.map((v) => ({
        id: String(v.gid) + '|' + encodeURIComponent(parseEpisode(v.title).series),
        name: parseEpisode(v.title).series,
        thumbnail: v.cover ? 'https://media.dehentai.com' + v.cover : '',
        isAdult: true,
        availableEpisodesDetail: { sub: [], dub: [] },
      }))
      // dedupe by name
      const seen = new Set()
      const unique = shows.filter((s) => {
        if (seen.has(s.name)) return false
        seen.add(s.name)
        return true
      })
      const hasMore = page < pages
      return { shows: unique, hasMore }
    } catch (error) {
      log.error({ error }, '[DH] browse failed')
      return { shows: [], hasMore: false }
    }
  }
  return {
    name: 'DeHentai',
    search,
    getEpisodes,
    getStreamUrls,
    resolveShowId,
    browse,
  }
}
