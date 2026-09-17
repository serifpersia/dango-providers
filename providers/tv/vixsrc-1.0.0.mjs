const BASE_URL = 'https://vixsrc.to'
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  Referer: BASE_URL,
  Origin: BASE_URL,
}

export default function createProvider(ctx) {
  const log = ctx.logger

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
      const plRes = await fetch(masterUrl, {
        headers: { ...HEADERS, Referer: pageUrl },
        signal: AbortSignal.timeout(10000),
      })
      if (!plRes.ok) throw new Error(`VixSrc playlist HTTP ${plRes.status}`)
      const playlistContent = await plRes.text()
      const regex = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)[^\n]*\n([^\n]+)/g
      let match
      let bestResolution = 0
      while ((match = regex.exec(playlistContent)) !== null) {
        const resVal = parseInt(match[1], 10)
        if (resVal > bestResolution) bestResolution = resVal
      }
      const sources =
        bestResolution > 0 ? [{ url: masterUrl, quality: `${bestResolution}p`, type: 'hls' }] : []
      if (sources.length === 0) return null
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
    } catch (err) {
      log.debug({ err: String(err), tmdbId: media.tmdbId }, 'vixsrc sources failed')
      return null
    }
  }

  return { name: 'vixsrc', getSources }
}
