const API = 'https://api2.wing.st'
const SITE = 'https://cinejoy.pk'
const SERVERS = ['Light', 'Lisbon', 'Nebula', 'Comet', 'Zenith']
const AAD_PREFIX = new TextEncoder().encode('lumen-gate-v2')
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: `${SITE}/`,
}

let wasmModule

function loadWasm() {
  if (!wasmModule) {
    wasmModule = (async () => {
      const res = await fetch(`${API}/crush.wasm`, {
        headers: { ...HEADERS, Accept: 'application/wasm' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) throw new Error(`CineJoy wasm HTTP ${res.status}`)
      return WebAssembly.compile(await res.arrayBuffer())
    })().catch((err) => {
      wasmModule = null
      throw err
    })
  }
  return wasmModule
}

async function sealRequest(request) {
  const wasm = await loadWasm()
  const { exports } = await WebAssembly.instantiate(wasm, {})
  const req = new TextEncoder().encode(JSON.stringify(request))
  const outSize = req.length + 512
  const reqPtr = exports.alloc(req.length)
  const noncePtr = exports.alloc(44)
  const outPtr = exports.alloc(outSize)
  try {
    const memory = new Uint8Array(exports.memory.buffer)
    memory.set(req, reqPtr)
    memory.fill(0, noncePtr, noncePtr + 44)
    const len = exports.seal_request(reqPtr, req.length, noncePtr, 44, outPtr, outSize)
    if (len <= 98 || len > outSize) throw new Error('CineJoy seal failed')
    const out = new Uint8Array(exports.memory.buffer, outPtr, len).slice()
    return {
      responseKey: out.subarray(0, 32),
      keyId: out[32],
      ephemeralPublic: out.subarray(33, 98),
      body: out.subarray(98),
    }
  } finally {
    exports.dealloc(reqPtr, req.length)
    exports.dealloc(noncePtr, 44)
    exports.dealloc(outPtr, outSize)
  }
}

async function openResponse(sealed, response) {
  const aad = new Uint8Array(AAD_PREFIX.length + 3 + sealed.ephemeralPublic.length)
  aad.set(AAD_PREFIX, 0)
  aad.set([0, 2, sealed.keyId], AAD_PREFIX.length)
  aad.set(sealed.ephemeralPublic, AAD_PREFIX.length + 3)
  const key = await crypto.subtle.importKey('raw', sealed.responseKey, 'AES-GCM', false, [
    'decrypt',
  ])
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: response.subarray(0, 12),
      additionalData: aad,
      tagLength: 128,
    },
    key,
    response.subarray(12)
  )
  return JSON.parse(new TextDecoder().decode(plain))
}

export default function createProvider(_ctx) {
  async function getSources(media, server) {
    const tmdb = String(media?.tmdbId ?? '')
    if (!/^\d+$/.test(tmdb)) return null
    const isMovie = media.type === 'movie'
    const type = isMovie ? 'movie' : 'series'
    const candidates = server && SERVERS.includes(server) ? [server] : SERVERS
    for (const name of candidates) {
      try {
        const payload = isMovie
          ? { tmdb }
          : {
              tmdb,
              season: String(media.season || 1),
              episode: String(media.episode || 1),
            }
        const sealed = await sealRequest({ path: `/${name}/${type}`, payload })
        const res = await fetch(`${API}/g`, {
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'text/plain;charset=UTF-8' },
          body: sealed.body,
          signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) continue
        const data = await openResponse(sealed, new Uint8Array(await res.arrayBuffer()))
        const streams = data?.data?.stream
        if (!Array.isArray(streams)) continue
        const sources = []
        const subtitles = []
        const seenQualities = new Set()
        for (const stream of streams) {
          if (!stream?.playlist) continue
          const hls = stream.type === 'hls' || stream.playlist.includes('.m3u8')
          if (hls) {
            try {
              const pl = await fetch(stream.playlist, {
                headers: { ...HEADERS, Origin: SITE, Accept: '*/*' },
                signal: AbortSignal.timeout(10000),
              })
              if (pl.ok) {
                const body = await pl.text()
                let index = -1
                for (const line of body.split('\n')) {
                  if (!line.startsWith('#EXT-X-STREAM-INF')) continue
                  index += 1
                  const height = parseInt(line.match(/RESOLUTION=\d+x(\d+)/)?.[1] ?? '', 10)
                  if (!height || seenQualities.has(height)) continue
                  seenQualities.add(height)
                  sources.push({
                    url: `${stream.playlist}#v=${index}`,
                    quality: `${height}p`,
                    type: 'hls',
                  })
                }
              }
            } catch {}
          }
          if (!sources.length) {
            sources.push({ url: stream.playlist, quality: 'Auto', type: hls ? 'hls' : 'mp4' })
          }
          for (const caption of stream.captions || []) {
            if (!caption?.url) continue
            const language = caption.language || 'und'
            subtitles.push({ language, label: language.toUpperCase(), url: caption.url })
          }
        }
        if (!sources.length) continue
        sources.sort((a, b) => parseInt(b.quality, 10) - parseInt(a.quality, 10))
        return { sources, subtitles, referer: `${SITE}/`, server: name }
      } catch {
        // try the next server
      }
    }
    return null
  }

  return { name: 'cinejoy', servers: [...SERVERS], getSources }
}
