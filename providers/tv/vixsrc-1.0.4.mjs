const BASE_URL = 'https://vixsrc.to'
const LIVE_CDN = 'vix-content.net'
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  Referer: BASE_URL,
  Origin: BASE_URL,
}

export default function createProvider(ctx) {
  const scraping = ctx?.scraping?.fetch ?? fetch

  async function getSources(media) {
    const numericTmdbId = Number(media.tmdbId)
    if (!numericTmdbId) return null
    const mediaType = media.type === 'movie' ? 'movie' : 'tv'
    try {
      const pageUrl =
        mediaType === 'movie'
          ? `${BASE_URL}/api/movie/${numericTmdbId}`
          : `${BASE_URL}/api/tv/${numericTmdbId}/${media.season || 1}/${media.episode || 1}`
      const apiRes = await fetch(pageUrl, {
        headers: HEADERS,
        signal: AbortSignal.timeout(10000),
      })
      if (!apiRes.ok) throw new Error(`VixSrc API HTTP ${apiRes.status}`)
      const apiData = await apiRes.json()
      if (!apiData?.src) return null
      const htmlUrl = BASE_URL + apiData.src
      const htmlRes = await fetch(htmlUrl, {
        headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml,*/*' },
        signal: AbortSignal.timeout(10000),
      })
      if (!htmlRes.ok) throw new Error(`VixSrc embed HTTP ${htmlRes.status}`)
      const html = await htmlRes.text()
      const token = html.match(/token["']\s*:\s*["']([^"']+)/)?.[1]
      const expires = html.match(/expires["']\s*:\s*["']([^"']+)/)?.[1]
      const playlist = html.match(/url\s*:\s*["']([^"']+)/)?.[1]
      if (!token || !expires || !playlist) return null
      const sep = playlist.includes('?') ? '&' : '?'
      const masterUrl = `${playlist}${sep}token=${token}&expires=${expires}&h=1`
      const plRes = await scraping({
        url: masterUrl,
        headers: { ...HEADERS, Referer: pageUrl, Accept: '*/*' },
        timeout: { request: 10000 },
      })
      if (plRes.statusCode !== 200) throw new Error(`VixSrc playlist HTTP ${plRes.statusCode}`)
      const playlistContent = plRes.body
      const sources = []
      const seen = new Set()
      const lines = playlistContent.split('\n')
      let streamIndex = -1
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue
        streamIndex++
        const height = parseInt(lines[i].match(/RESOLUTION=\d+x(\d+)/)?.[1] ?? '', 10)
        if (!height || seen.has(height)) continue
        seen.add(height)
        sources.push({
          url: `${masterUrl}#v=${streamIndex}`,
          quality: `${height}p`,
          type: 'hls',
        })
      }
      if (sources.length === 0) return null
      sources.sort((a, b) => parseInt(b.quality, 10) - parseInt(a.quality, 10))
      const audioTracks = []
      const subtitles = []
      for (const line of playlistContent.split('\n')) {
        if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
          const language = line.match(/LANGUAGE="([^"]+)"/)?.[1] ?? 'unknown'
          const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'Audio'
          audioTracks.push({ language, label })
        } else if (line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')) {
          const language = line.match(/LANGUAGE="([^"]+)"/)?.[1] ?? 'unknown'
          const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'Subs'
          const uri = line.match(/URI="([^"]+)"/)?.[1]
          if (uri) subtitles.push({ language, label, url: new URL(uri, masterUrl).href })
        }
      }
      return { sources, audioTracks, subtitles, referer: pageUrl }
    } catch {
      return null
    }
  }

  function rewritePlaylist(body) {
    return body
      .split('\n')
      .map((line) => {
        if (!line || line.startsWith('#')) return line
        return line
          .replace(/^(https:\/\/)(sc-[a-z0-9-]+)\.[^/]+/, `$1$2.${LIVE_CDN}`)
          .replace(/\.(html|m4s)(\?|$)/, '.ts$2')
      })
      .join('\n')
  }

  return { name: 'vixsrc', getSources, rewritePlaylist }
}
