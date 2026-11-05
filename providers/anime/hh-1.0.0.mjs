const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
const domains = ['https://hentaihaven.red', 'https://hentaihaven.com']
let activeBase = domains[0]

export const HH_GENRES = [
  '3d',
  'ahegao',
  'anal',
  'bdsm',
  'big-boobs',
  'blow-job',
  'blow-jow',
  'bondage',
  'boob-job',
  'breasts',
  'censored',
  'comedy',
  'cosplay',
  'cream-pie',
  'creampie',
  'dark-skin',
  'demon',
  'erotic-game',
  'facial',
  'fantasy',
  'filmed',
  'foot-job',
  'footjob',
  'futanari',
  'game',
  'gangbang',
  'glasses',
  'hand-job',
  'harem',
  'hd',
  'horror',
  'huge-breasts',
  'incest',
  'inflation',
  'lactation',
  'large-breasts',
  'loli',
  'magic',
  'maid',
  'masturbation',
  'milf',
  'mind-break',
  'mind-control',
  'monster',
  'nekomimi',
  'ntr',
  'nudity',
  'nurse',
  'oral',
  'orgy',
  'plot',
  'pornography',
  'pov',
  'pregnant',
  'public-sex',
  'rape',
  'reverse-rape',
  'rimjob',
  'safer-sex',
  'scat',
  'school-girl',
  'sex',
  'shota',
  'small-breasts',
  'softcore',
  'speculative-fiction',
  'swimsuit',
  'teacher',
  'tentacle',
  'threesome',
  'toys',
  'trap',
  'tsundere',
  'uncensored',
  'vanilla',
  'virgin',
  'watersports',
  'x-ray',
  'yaoi',
  'yuri',
]

async function fetchText(pathOrUrl, referer) {
  const isFull = /^https?:\/\//i.test(pathOrUrl)
  for (const b of isFull ? [''] : domains) {
    const url = isFull ? pathOrUrl : b + pathOrUrl
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: referer || (b ? b + '/' : undefined),
        },
        signal: AbortSignal.timeout(20000),
      })
      if (res.ok) {
        if (!isFull && b) activeBase = b
        return await res.text()
      }
    } catch {}
  }
  return null
}

function parseSearchCards(html) {
  const results = []
  const seen = {}
  const re =
    /href=["']https?:\/\/hentaihaven\.(?:red|com)\/watch\/([^"'\/]+)\/?["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["'][^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const slug = m[1]
    const thumb = m[2]
    const title = m[3]
      .replace(/<[^>]+>/g, '')
      .replace(/&#8217;/g, "'")
      .replace(/&#8211;/g, '-')
      .replace(/&amp;/g, '&')
      .trim()
    if (!slug || seen[slug]) continue
    seen[slug] = true
    results.push({ title: title || slug, name: title || slug, id: slug, thumbnail: thumb })
  }
  return results
}

function cleanSlug(showId) {
  return String(showId || '')
    .replace(/^https?:\/\/[^/]+\/watch\//i, '')
    .replace(/\/+$/, '')
    .trim()
}

function parseEpisodeLinks(html, slug) {
  const byNum = new Map()
  const re =
    /href=["'](https?:\/\/hentaihaven\.(?:red|com)\/watch\/([^"'\/]+)\/((?:episode|season)-(\d+))\/?)["']/gi
  let m
  while ((m = re.exec(html)) !== null) {
    if (m[2].toLowerCase() !== slug.toLowerCase()) continue
    const num = parseInt(m[4], 10) || 1
    if (!byNum.has(num)) byNum.set(num, { number: num, epSlug: m[3], url: m[1] })
  }
  return [...byNum.values()].sort((a, b) => a.number - b.number)
}

function rot13(s) {
  return String(s || '').replace(/[a-zA-Z]/g, (c) => {
    const b = c <= 'Z' ? 65 : 97
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b)
  })
}

export default function createProvider(ctx) {
  const log = ctx.logger

  async function search(options) {
    try {
      const query = String((options && options.query) || '').trim()
      const q = query
        .replace(/\b(?:the\s+animation|uncensored|censored)\b/gi, ' ')
        .replace(/[^\w\s]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (q.length < 2) return []
      const html = await fetchText('/?s=' + encodeURIComponent(q))
      if (!html) return []
      return parseSearchCards(html)
    } catch (error) {
      log.error({ error }, '[HH] search failed')
      return []
    }
  }

  async function browse(options = {}) {
    const query = String((options && options.query) || '').trim()
    const page = Math.max(1, parseInt(String((options && options.page) || '1'), 10) || 1)
    const genre = String((options && (options.genre || options.genres)) || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
    const q = query
      .replace(/\b(?:the\s+animation|uncensored|censored)\b/gi, ' ')
      .replace(/[^\w\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const queryPart = q ? '?s=' + encodeURIComponent(q) : ''
    let path
    if (genre) {
      path =
        page <= 1
          ? `/hentai/tag/${encodeURIComponent(genre)}/` + queryPart
          : `/hentai/tag/${encodeURIComponent(genre)}/page/${page}/` + queryPart
    } else {
      path =
        page <= 1 ? '/?s=' + encodeURIComponent(q) : `/page/${page}/?s=` + encodeURIComponent(q)
    }
    const html = await fetchText(path)
    if (!html) return { shows: [], hasMore: false }
    const shows = parseSearchCards(html).map((r) => ({ ...r, isAdult: true }))
    const hasMore = genre
      ? new RegExp(`/page/${page + 1}/`).test(html)
      : new RegExp(`/page/${page + 1}/\\?s`).test(html)
    return { shows, hasMore }
  }

  async function resolveShowId(title, _romaji) {
    try {
      const results = await search({ query: title })
      if (!results.length) return null
      const q = String(title).toLowerCase().trim()
      let best = results[0],
        bestScore = -1
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
      log.error({ error }, '[HH] resolveShowId failed')
      return null
    }
  }

  async function fetchEpisodeList(slug) {
    const html = await fetchText('/watch/' + slug + '/')
    if (!html) return []
    return parseEpisodeLinks(html, slug)
  }

  async function getEpisodes(showId, _mode = 'sub') {
    const slug = cleanSlug(showId)
    if (!slug) return null
    const cacheKey = `hh_eps_${slug}`
    const cached = ctx.cache.get(cacheKey)
    if (cached) return cached
    const list = await fetchEpisodeList(slug)
    const episodes = list.length ? list.map((e) => String(e.number)) : ['1']
    const result = { episodes, description: '' }
    ctx.cache.set(cacheKey, result, 3600)
    return result
  }

  async function resolveStream(slug, target) {
    const list = await fetchEpisodeList(slug)
    const hit = list.find((e) => String(e.number) === target)
    const epPath = hit ? hit.url : `/watch/${slug}/episode-${target}`
    const epHtml = await fetchText(epPath, activeBase + '/watch/' + slug + '/')
    if (!epHtml) return null
    const iframeMatch =
      /<iframe[^>]+src=["']([^"']*\/wp-content\/plugins\/player-logic\/player\.php\?([^"']+))["']/i.exec(
        epHtml
      )
    if (!iframeMatch) return null
    const iframeUrl = iframeMatch[1].startsWith('//') ? 'https:' + iframeMatch[1] : iframeMatch[1]
    let en = ''
    let iv = ''
    let apiUrl = activeBase + '/wp-content/plugins/player-logic/api.php'
    const dataMatch = /(?:^|&)data=([^&]+)/.exec(iframeMatch[2])
    if (dataMatch) {
      try {
        const decoded = Buffer.from(decodeURIComponent(dataMatch[1]), 'base64').toString('utf8')
        const parts = decoded.split(':|::|:')
        if (parts.length === 2 && parts[0] && parts[1]) {
          en = parts[0]
          iv = Buffer.from(parts[1], 'utf8').toString('base64')
        }
      } catch {}
    }
    if (!en || !iv) {
      const pHtml = await fetchText(iframeUrl, activeBase + '/')
      const tokenMatch =
        pHtml &&
        (/name=["']x-secure-token["']\s+content=["']([^"']+)["']/i.exec(pHtml) ||
          /content=["']([^"']+)["']\s+name=["']x-secure-token["']/i.exec(pHtml))
      if (!tokenMatch) return null
      try {
        let e = tokenMatch[1].replace(/^sha512-/, '')
        for (let k = 0; k < 3; k++) {
          e = rot13(e)
          e = Buffer.from(e.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8')
        }
        const cfg = JSON.parse(e)
        en = cfg.en
        iv = cfg.iv
        if (cfg.uri) {
          const uri = cfg.uri.startsWith('//') ? 'https:' + cfg.uri : cfg.uri
          apiUrl = uri.replace(/\/?$/, '/') + 'api.php'
        }
      } catch {
        return null
      }
    }
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: iframeUrl,
          Origin: activeBase,
        },
        body:
          'action=zarat_get_data_player_ajax&a=' +
          encodeURIComponent(en) +
          '&b=' +
          encodeURIComponent(iv),
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) return null
      const apiJson = await res.json()
      const sources = (apiJson && apiJson.data && apiJson.data.sources) || []
      const src = sources[0] && sources[0].src
      return src ? { m3u8Url: src, referer: activeBase + '/' } : null
    } catch (error) {
      log.warn({ error, slug, target }, '[HH] api.php failed')
      return null
    }
  }

  async function getStreamUrls(showId, episodeNumber, _mode = 'sub') {
    const slug = cleanSlug(showId)
    if (!slug) return null
    const target = String(episodeNumber || '1') === '0' ? '1' : String(episodeNumber || '1')
    const cacheKey = `hh_stream_${slug}_${target}`
    const cached = ctx.cache.get(cacheKey)
    if (cached) return cached
    const resolved = await resolveStream(slug, target)
    if (!resolved) return null
    const { m3u8Url, referer } = resolved
    const headers = { Referer: referer, Origin: activeBase }
    const links = []
    const subtitles = []
    const master = await fetchText(m3u8Url, referer)
    if (master) {
      const re = /#EXT-X-STREAM-INF:([^\n]*)\n(\S+)/g
      let m
      let idx = 0
      while ((m = re.exec(master)) !== null) {
        const i = idx++
        const height = m[1].match(/RESOLUTION=\d+x(\d+)/)?.[1]
        const label = (height ? height + 'p' : m[1].match(/NAME="([^"]+)"/)?.[1]) || ''
        if (!label) continue
        links.push({
          resolutionStr: label,
          link: ctx.proxyUrl(m3u8Url, referer) + '&variant=' + i,
          hls: true,
          headers,
        })
      }
      const baseUrl = m3u8Url.slice(0, m3u8Url.lastIndexOf('/') + 1)
      for (const line of master.split(/\r?\n/)) {
        if (!line.includes('TYPE=SUBTITLES')) continue
        const uriM = /URI="([^"]+)"/.exec(line)
        const langM = /LANGUAGE="([^"]+)"/.exec(line)
        const nameM = /NAME="([^"]+)"/.exec(line)
        if (!uriM) continue
        const subUrl = /^https?:\/\//i.test(uriM[1]) ? uriM[1] : new URL(uriM[1], baseUrl).href
        const lang = (langM && langM[1]) || 'en'
        subtitles.push({
          language: lang,
          label: (nameM && nameM[1]) || lang.toUpperCase(),
          url: subUrl,
        })
      }
    }
    links.push({ resolutionStr: 'Auto', link: ctx.proxyUrl(m3u8Url, referer), hls: true, headers })
    const result = [
      { sourceName: 'HentaiHaven', links, subtitles, type: 'player', actualEpisodeNumber: target },
    ]
    ctx.cache.set(cacheKey, result, 300)
    return result
  }

  return { name: 'HH', search, browse, getEpisodes, getStreamUrls, resolveShowId }
}
