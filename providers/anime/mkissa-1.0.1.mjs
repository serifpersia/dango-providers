class MkissaResponse {
  static site(id) {
    const sites = {
      mkissa: { name: 'MKissa', url: 'https://mkissa.to/anime' },
      nexus: { name: 'Anime Nexus', url: 'https://anime.nexus/' },
    }
    if (!Object.prototype.hasOwnProperty.call(sites, id))
      throw new Error('Unsupported verification provider')
    return sites[id]
  }
  static required(id) {
    const site = this.site(id)
    const error = new Error(
      site.name +
        ': site verification is required. Open ' +
        site.url +
        ' and complete its check, then return to Dango and refresh the provider.'
    )
    error.code = 'VERIFICATION_REQUIRED'
    error.provider = id
    return error
  }
  static isChallenge(text) {
    return (
      typeof text === 'string' &&
      /__CF\$cv\$params|\/cdn-cgi\/challenge-platform\/|cf-chl-|<title>\s*Just a moment/i.test(text)
    )
  }
  static needsVerification(data) {
    const codes = [
      'NEED_CAPTCHA',
      'TURNSTILE_REQUIRED',
      'TURNSTILE_FAILED',
      'FALLBACK_REQUIRED',
      'ALTCHA_REQUIRED',
      'VERIFICATION_REQUIRED',
    ]
    if (!data || typeof data !== 'object') return false
    if (codes.includes(data.code)) return true
    return (
      Array.isArray(data.errors) &&
      data.errors.some(
        (error) =>
          error &&
          (codes.includes(error.code) ||
            codes.includes(error.extensions && error.extensions.code) ||
            (typeof error.message === 'string' &&
              /\b(?:NEED_CAPTCHA|TURNSTILE_REQUIRED|VERIFICATION_REQUIRED)\b/.test(error.message)))
      )
    )
  }
  static apiError(data, id) {
    if (this.needsVerification(data)) return this.required(id)
    const site = this.site(id)
    const stale =
      data &&
      Array.isArray(data.errors) &&
      data.errors.some(
        (error) =>
          error &&
          typeof error.message === 'string' &&
          /\bAA_CRYPTO_(?:STALE|EXPIRED|BUILD_MISMATCH)\b/.test(error.message)
      )
    const error = new Error(
      site.name +
        ': ' +
        (stale
          ? 'AA_CRYPTO_STALE; signing must be refreshed.'
          : 'upstream API rejected the request.')
    )
    error.code = stale ? 'SIGNING_STALE' : 'UPSTREAM_API_ERROR'
    return error
  }
  static async assertResponse(response, id) {
    if (response.ok) return
    let text = ''
    try {
      if (typeof response.text === 'function') text = await response.text()
    } catch {}
    let data
    try {
      data = JSON.parse(text)
    } catch {}
    if (this.isChallenge(text) || this.needsVerification(data)) throw this.required(id)
    const error = new Error(this.site(id).name + ': request failed (HTTP ' + response.status + ').')
    error.code = 'UPSTREAM_HTTP_ERROR'
    throw error
  }
  static async json(response, id) {
    await this.assertResponse(response, id)
    let data
    if (typeof response.text === 'function') {
      const text = await response.text()
      if (this.isChallenge(text)) throw this.required(id)
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(this.site(id).name + ': upstream returned invalid JSON.')
      }
    } else {
      try {
        data = await response.json()
      } catch {
        throw new Error(this.site(id).name + ': upstream returned invalid JSON.')
      }
    }
    if (this.needsVerification(data)) throw this.required(id)
    return data
  }
}

// Helpers for the signed and encrypted MKissa API protocol.
// No browser WebCrypto dependency. GCM decrypt verifies the authentication tag.
class MkissaCrypto {
  static utf8(value) {
    return Array.from(unescape(encodeURIComponent(value)), (c) => c.charCodeAt(0))
  }
  static text(bytes) {
    return decodeURIComponent(escape(bytes.map((b) => String.fromCharCode(b)).join('')))
  }
  static hex(bytes) {
    return bytes.map((b) => ('0' + b.toString(16)).slice(-2)).join('')
  }
  static base64(bytes) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let result = ''
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i],
        b = bytes[i + 1] || 0,
        c = bytes[i + 2] || 0
      result +=
        chars[a >> 2] +
        chars[((a & 3) << 4) | (b >> 4)] +
        (i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '=') +
        (i + 2 < bytes.length ? chars[c & 63] : '=')
    }
    return result
  }
  static unbase64(value) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    if (typeof value !== 'string' || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
      throw new Error('Invalid MKissa Base64')
    const result = []
    for (let i = 0; i < value.length; i += 4) {
      const a = chars.indexOf(value[i]),
        b = chars.indexOf(value[i + 1]),
        c = chars.indexOf(value[i + 2]),
        d = chars.indexOf(value[i + 3])
      result.push((a << 2) | (b >> 4))
      if (c >= 0) result.push(((b & 15) << 4) | (c >> 2))
      if (d >= 0) result.push(((c & 3) << 6) | d)
    }
    return result
  }
  static sha256(input) {
    const bytes = input.slice(),
      length = bytes.length
    bytes.push(128)
    while (bytes.length % 64 !== 56) bytes.push(0)
    const high = Math.floor(length / 536870912),
      low = (length * 8) >>> 0
    for (const word of [high, low])
      for (let j = 3; j >= 0; j--) bytes.push((word >>> (j * 8)) & 255)
    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
      0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
      0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
      0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
      0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
      0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
      0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
      0xc67178f2,
    ]
    const h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
      0x5be0cd19,
    ]
    const rotate = (v, n) => (v >>> n) | (v << (32 - n))
    for (let offset = 0; offset < bytes.length; offset += 64) {
      const w = []
      for (let i = 0; i < 16; i++) {
        let p = offset + i * 4
        w[i] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]
      }
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15],
          b = w[i - 2]
        w[i] =
          (w[i - 16] +
            (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
            w[i - 7] +
            (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) |
          0
      }
      let [a, b, c, d, e, f, g, j] = h
      for (let i = 0; i < 64; i++) {
        const t1 =
          (j +
            (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
            ((e & f) ^ (~e & g)) +
            k[i] +
            w[i]) |
          0
        const t2 =
          ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
        j = g
        g = f
        f = e
        e = (d + t1) | 0
        d = c
        c = b
        b = a
        a = (t1 + t2) | 0
      }
      ;[a, b, c, d, e, f, g, j].forEach((v, i) => (h[i] = (h[i] + v) | 0))
    }
    const output = []
    for (const word of h) for (let i = 3; i >= 0; i--) output.push((word >>> (i * 8)) & 255)
    return output
  }
  static hmac(key, message) {
    if (key.length > 64) key = this.sha256(key)
    key = key.slice()
    while (key.length < 64) key.push(0)
    return this.sha256(
      key.map((b) => b ^ 92).concat(this.sha256(key.map((b) => b ^ 54).concat(message)))
    )
  }
  static multiply(a, b) {
    let result = 0
    for (let i = 0; i < 8; i++) {
      if (b & 1) result ^= a
      a = ((a << 1) ^ (a & 128 ? 0x11b : 0)) & 255
      b >>>= 1
    }
    return result
  }
  static schedule(key) {
    if (key.length !== 32) throw new Error('MKissa AES key must be 32 bytes')
    const sbox = []
    for (let value = 0; value < 256; value++) {
      let inverse = 0
      if (value) {
        inverse = 1
        let base = value,
          power = 254
        while (power) {
          if (power & 1) inverse = this.multiply(inverse, base)
          base = this.multiply(base, base)
          power >>>= 1
        }
      }
      let s = inverse
      for (let i = 1; i <= 4; i++) s ^= ((inverse << i) | (inverse >> (8 - i))) & 255
      sbox[value] = s ^ 99
    }
    const expanded = key.slice()
    let rcon = 1
    while (expanded.length < 240) {
      let t = expanded.slice(-4),
        count = expanded.length
      if (count % 32 === 0) {
        t.push(t.shift())
        t = t.map((b) => sbox[b])
        t[0] ^= rcon
        rcon = this.multiply(rcon, 2)
      } else if (count % 32 === 16) t = t.map((b) => sbox[b])
      for (let i = 0; i < 4; i++) expanded.push(expanded[count + i - 32] ^ t[i])
    }
    return { expanded, sbox }
  }
  static aes(block, schedule) {
    let state = block.slice()
    const { expanded, sbox } = schedule
    for (let i = 0; i < 16; i++) state[i] ^= expanded[i]
    for (let round = 1; round <= 14; round++) {
      const previous = state.map((b) => sbox[b])
      for (let row = 0; row < 4; row++)
        for (let column = 0; column < 4; column++)
          state[column * 4 + row] = previous[((column + row) % 4) * 4 + row]
      if (round !== 14)
        for (let column = 0; column < 4; column++) {
          const p = column * 4,
            a = state.slice(p, p + 4),
            sum = a[0] ^ a[1] ^ a[2] ^ a[3]
          for (let row = 0; row < 4; row++)
            state[p + row] = a[row] ^ sum ^ this.multiply(a[row] ^ a[(row + 1) % 4], 2)
        }
      for (let i = 0; i < 16; i++) state[i] ^= expanded[round * 16 + i]
    }
    return state
  }
  static ghash(ciphertext, h) {
    let y = Array(16).fill(0)
    const blocks = ciphertext.slice()
    while (blocks.length % 16) blocks.push(0)
    const lengthBlock = Array(16).fill(0),
      bits = ciphertext.length * 8
    for (let i = 0; i < 8; i++) lengthBlock[15 - i] = Math.floor(bits / Math.pow(256, i)) & 255
    blocks.push(...lengthBlock)
    for (let offset = 0; offset < blocks.length; offset += 16) {
      const x = y.map((b, i) => b ^ blocks[offset + i])
      let z = Array(16).fill(0),
        v = h.slice()
      for (let bit = 0; bit < 128; bit++) {
        if ((x[bit >> 3] >> (7 - (bit & 7))) & 1) for (let i = 0; i < 16; i++) z[i] ^= v[i]
        const low = v[15] & 1
        for (let i = 15; i >= 0; i--) v[i] = (v[i] >>> 1) | (i ? (v[i - 1] & 1) << 7 : 0)
        if (low) v[0] ^= 225
      }
      y = z
    }
    return y
  }
  static gcm(key, nonce, input, decrypt) {
    if (nonce.length !== 12 || (decrypt && input.length < 16))
      throw new Error('Invalid MKissa GCM envelope')
    const schedule = this.schedule(key),
      zero = Array(16).fill(0),
      j0 = nonce.concat([0, 0, 0, 1])
    const body = decrypt ? input.slice(0, -16) : input.slice(),
      output = [],
      counter = j0.slice()
    for (let offset = 0; offset < body.length; offset += 16) {
      for (let i = 15; i >= 12; i--) {
        counter[i] = (counter[i] + 1) & 255
        if (counter[i]) break
      }
      const stream = this.aes(counter, schedule)
      for (let i = 0; i < 16 && offset + i < body.length; i++)
        output.push(body[offset + i] ^ stream[i])
    }
    const hash = this.ghash(decrypt ? body : output, this.aes(zero, schedule))
    const tag = this.aes(j0, schedule).map((b, i) => b ^ hash[i])
    if (decrypt) {
      let difference = 0
      for (let i = 0; i < 16; i++) difference |= tag[i] ^ input[input.length - 16 + i]
      if (difference) throw new Error('MKissa response authentication failed')
      return output
    }
    return output.concat(tag)
  }
}

// Handles MKissa API requests, signing, and encrypted responses.
class MkissaClient {
  constructor() {
    this.base = 'https://mkissa.to'
    this.api = 'https://api.mkissa.net'
    // Public MKissa client build 184 protocol (not an account credential).
    this.build = '184'
    this.mask = [
      163, 77, 136, 159, 65, 144, 229, 185, 106, 251, 0, 102, 63, 94, 160, 28, 70, 142, 147, 87,
      247, 151, 132, 108, 171, 205, 97, 58, 81, 114, 58, 243,
    ]
  }
  getSettings() {
    return {
      episodeServers: ['Auto', 'Mp4', 'Default', 'Fm-Hls', 'Ok'],
      supportsDub: true,
    }
  }
  async request(url, options) {
    const response = await fetch(
      url,
      Object.assign({ timeout: 25 }, options || {}, {
        headers: Object.assign(
          {
            'User-Agent': 'Mozilla/5.0',
            Referer: this.base + '/',
            Origin: this.base,
          },
          (options && options.headers) || {}
        ),
      })
    )
    if (url.startsWith(this.api + '/') || url.startsWith(this.base + '/'))
      await MkissaResponse.assertResponse(response, 'mkissa')
    else if (!response.ok) throw new Error('MKissa request failed: HTTP ' + response.status)
    return response
  }
  async bootstrap() {
    const C = MkissaCrypto,
      week = 604800000,
      now = Date.now(),
      current = Math.floor(now / week)
    const epochs = now - current * week < 86400000 ? [current - 1, current] : [current, current - 1]
    let failure
    for (const epoch of epochs) {
      try {
        const intermediate = C.hmac(this.mask, C.utf8('5m1AiH:' + this.build))
        const signature = C.hex(
          C.hmac(intermediate, C.utf8('mkissa.to/' + this.build + '/' + epoch + '/k7/mkissa'))
        )
        const response = await this.request(
          this.api + '/client-crypto/v1/bootstrap?buildId=' + this.build + '&k=k7',
          { headers: { 'x-build-id': this.build, 'x-aa-boot': signature } }
        )
        const data = await MkissaResponse.json(response, 'mkissa'),
          part = C.unbase64(data.partB)
        if (data.k !== 'k7' || !Number.isInteger(data.epoch) || part.length !== 32)
          throw new Error('MKissa bootstrap format changed')
        return { epoch: data.epoch, key: part.map((b, i) => b ^ this.mask[i]) }
      } catch (error) {
        if (error.code === 'VERIFICATION_REQUIRED') throw error
        failure = error
      }
    }
    throw new Error(
      'MKissa playback protocol is unavailable or its public client changed. ' + failure.message
    )
  }
  async graphql(query, variables, secured) {
    const C = MkissaCrypto
    for (let attempt = 0; attempt < (secured ? 2 : 1); attempt++) {
      const body = { query, variables: variables || {} },
        headers = { 'Content-Type': 'application/json' }
      let session
      if (secured) {
        session = await this.bootstrap()
        const qh = C.hex(C.sha256(C.utf8(query))),
          ts = Math.floor(Date.now() / 300000) * 300000
        const iv = C.sha256(
          C.utf8(session.epoch + ':' + this.build + ':' + qh + ':' + ts + ':k7')
        ).slice(0, 12)
        const message = C.utf8(
          JSON.stringify({
            v: 1,
            ts,
            epoch: session.epoch,
            buildId: this.build,
            qh,
            k: 'k7',
          })
        )
        body.extensions = {
          persistedQuery: { version: 1, sha256Hash: qh },
          k: 'k7',
          aaReq: C.base64([1].concat(iv, C.gcm(session.key, iv, message, false))),
        }
        headers['x-build-id'] = this.build
      }
      const data = await MkissaResponse.json(
        await this.request(this.api + '/api', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
        'mkissa'
      )
      if (data.errors && data.errors.length) {
        const error = MkissaResponse.apiError(data, 'mkissa')
        if (secured && attempt === 0 && error.code === 'SIGNING_STALE') continue
        throw error
      }
      if (!data.data) throw new Error('MKissa API returned no data')
      if (typeof data.data.tobeparsed === 'string') {
        if (!session) throw new Error('Unexpected encrypted MKissa response')
        const envelope = C.unbase64(data.data.tobeparsed)
        if (envelope.length < 29 || envelope[0] !== 1)
          throw new Error('Unsupported MKissa encryption envelope')
        return JSON.parse(
          C.text(C.gcm(session.key, envelope.slice(1, 13), envelope.slice(13), true))
        )
      }
      return data.data
    }
    throw new Error('MKissa playback signing could not be refreshed')
  }
  parseId(id) {
    const parts = String(id).split('|')
    if (parts.length !== 2 || !/^[a-zA-Z0-9]+$/.test(parts[0]) || !/^(sub|dub)$/.test(parts[1]))
      throw new Error('Invalid MKissa anime ID; search again.')
    return { show: parts[0], translation: parts[1] }
  }
  async search(opts) {
    const query = String(
      opts.query ||
        (opts.media && opts.media.englishTitle) ||
        (opts.media && opts.media.romajiTitle) ||
        ''
    ).trim()
    if (!query) return []
    const mode = opts.dub ? 'dub' : 'sub',
      results = [],
      seen = {}
    const gql =
      'query($search:SearchInput,$limit:Int,$page:Int,$translationType:VaildTranslationTypeEnumType){shows(search:$search,limit:$limit,page:$page,translationType:$translationType){pageInfo{total} edges{_id name englishName aniListId availableEpisodes}}}'
    for (let page = 1; page <= 100; page++) {
      const data = await this.graphql(gql, {
        search: {
          query,
          allowAdult: !!(opts.media && opts.media.isAdult),
          allowUnknown: false,
        },
        limit: 40,
        page,
        translationType: mode,
      })
      if (!data.shows || !Array.isArray(data.shows.edges))
        throw new Error('MKissa search response changed')
      const edges = data.shows.edges
      for (const item of edges) {
        if (
          !item._id ||
          seen[item._id] ||
          !item.availableEpisodes ||
          Number(item.availableEpisodes[mode]) <= 0
        )
          continue
        seen[item._id] = true
        results.push({
          id: item._id + '|' + mode,
          title: item.name || item.englishName || item._id,
          url: this.base + '/anime/' + item._id,
          subOrDub: mode,
          metadata: { anilistId: item.aniListId },
        })
      }
      const total = Number(data.shows.pageInfo && data.shows.pageInfo.total)
      if (edges.length < 40 || (Number.isFinite(total) && page * 40 >= total)) {
        // Dango resolves titles again, so prefer the AniList match when MKissa supplies one.

        const mediaId = Number(opts.media && opts.media.id)
        const exact =
          Number.isInteger(mediaId) && mediaId > 0
            ? results.filter((r) => Number(r.metadata.anilistId) === mediaId)
            : []
        return exact.length ? exact : results
      }
    }
    throw new Error('MKissa search pagination exceeded its limit')
  }
  async findEpisodes(id) {
    const item = this.parseId(id)
    const data = await this.graphql(
      'query($_id:String!){show(_id:$_id){_id availableEpisodesDetail}}',
      { _id: item.show }
    )
    const details = data.show && data.show.availableEpisodesDetail
    if (!details || !Array.isArray(details[item.translation]))
      throw new Error('MKissa episode response changed')
    const seen = {},
      episodes = []
    for (const value of details[item.translation]) {
      const number = Number(value)
      if (!Number.isInteger(number) || number < 0 || seen[number]) continue
      seen[number] = true
      episodes.push({
        id: id + '|' + number,
        number,
        title: 'Episode ' + number,
        url: this.base + '/anime/' + item.show + '/p-' + number + '-' + item.translation,
      })
    }
    return episodes.sort((a, b) => a.number - b.number)
  }
  async findEpisodeServer(episode, server) {
    const parts = String(episode.id).split('|'),
      item = this.parseId(parts.slice(0, 2).join('|'))
    if (parts.length !== 3 || !/^\d+$/.test(parts[2])) throw new Error('Invalid MKissa episode ID')
    const requested = !server || server === 'default' ? 'Auto' : server
    if (!this.getSettings().episodeServers.includes(requested))
      throw new Error('Unknown MKissa server: ' + requested)
    const query =
      'query($showId:String!,$translationType:VaildTranslationTypeEnumType!,$episodeString:String!){episode(showId:$showId,translationType:$translationType,episodeString:$episodeString){episodeString sourceUrls show{_id name countryOfOrigin}}}'
    const data = await this.graphql(
      query,
      {
        showId: item.show,
        translationType: item.translation,
        episodeString: parts[2],
      },
      true
    )
    if (!data.episode || !Array.isArray(data.episode.sourceUrls))
      throw new Error('MKissa source response changed')
    const sources = data.episode.sourceUrls.filter(
      (s) => requested === 'Auto' || s.sourceName === requested
    )
    // Prefer Default/YouTube, then MP4, with other providers afterward.
    const sourcePriority = (name) => {
      const value = String(name || '').toLowerCase()
      if (value === 'default') return 0
      if (value === 'yt' || value.includes('youtube')) return 1
      if (value === 'mp4') return 2
      if (value === 'ok') return 4
      return 3
    }
    sources.sort((a, b) => sourcePriority(a.sourceName) - sourcePriority(b.sourceName))
    const failures = []
    for (const source of sources) {
      if (source.sourceName?.toLowerCase() === 'ok') {
        let url = String(source.sourceUrl)
        if (/^--[a-f0-9]+$/i.test(url) && url.length > 2 && (url.length - 2) % 2 === 0) {
          const hex = url.slice(2)
          url = hex
            .match(/../g)
            .map((value) => String.fromCharCode(parseInt(value, 16) ^ 56))
            .join('')
        }
        return {
          server: source.sourceName,
          iframeUrl: url,
          headers: { Referer: this.base + '/anime/' + item.show },
        }
      }
      try {
        const result = await this.resolve(
          source.sourceUrl,
          source.sourceName,
          episode.url || this.base + '/'
        )
        if (!result.videoSources.length) throw new Error('No playable media')
        return {
          server: source.sourceName,
          headers: result.headers,
          videoSources: result.videoSources,
        }
      } catch (error) {
        failures.push(source.sourceName + ': ' + error.message)
      }
    }
    throw new Error(
      'MKissa could not resolve ' +
        requested +
        '. ' +
        (failures.join('; ') || 'This episode has no matching server')
    )
  }
  async findEpisodeServers(episode) {
    const parts = String(episode.id).split('|'),
      item = this.parseId(parts.slice(0, 2).join('|'))
    if (parts.length !== 3 || !/^[0-9]+(?:\.[0-9]+)?$/.test(parts[2]))
      throw new Error('Invalid MKissa episode ID')
    const query =
      'query($showId:String!,$translationType:VaildTranslationTypeEnumType!,$episodeString:String!){episode(showId:$showId,translationType:$translationType,episodeString:$episodeString){episodeString sourceUrls show{_id name countryOfOrigin}}}'
    const data = await this.graphql(
      query,
      {
        showId: item.show,
        translationType: item.translation,
        episodeString: parts[2],
      },
      true
    )
    if (!data.episode || !Array.isArray(data.episode.sourceUrls))
      throw new Error('MKissa source response changed')
    const sourcePriority = (name) => {
      const value = String(name || '').toLowerCase()
      if (value === 'default') return 0
      if (value === 'yt' || value.includes('youtube')) return 1
      if (value === 'mp4') return 2
      if (value === 'ok') return 4
      return 3
    }
    const sources = [...data.episode.sourceUrls]
      .filter((s) => s && s.sourceUrl)
      .sort((a, b) => sourcePriority(a.sourceName) - sourcePriority(b.sourceName))
    const output = []
    const iframeOutput = []
    const failures = []
    for (const source of sources) {
      let url = String(source.sourceUrl)
      if (/^--[a-f0-9]+$/i.test(url) && url.length > 2 && (url.length - 2) % 2 === 0) {
        const hex = url.slice(2)
        url = hex
          .match(/../g)
          .map((value) => String.fromCharCode(parseInt(value, 16) ^ 56))
          .join('')
      }
      const server = String(source.sourceName || 'Server')
      if (server.toLowerCase() === 'ok') {
        if (/^https?:\/\//i.test(url))
          iframeOutput.push({
            server,
            iframeUrl: url,
            headers: { Referer: this.base + '/anime/' + item.show },
          })
        continue
      }
      const sourceHeaders = { Referer: this.base + '/anime/' + item.show }
      try {
        const resolved = await this.resolve(
          source.sourceUrl,
          server,
          this.base + '/anime/' + item.show
        )
        if (resolved.videoSources.length) {
          output.push({
            server,
            headers: resolved.headers,
            videoSources: resolved.videoSources,
          })
          continue
        }
        if (/^https?:\/\//i.test(url) && this.type(url) === 'unknown')
          iframeOutput.push({ server, iframeUrl: url, headers: sourceHeaders })
      } catch (error) {
        failures.push(server + ': ' + error.message)
        if (/^https?:\/\//i.test(url) && this.type(url) === 'unknown')
          iframeOutput.push({ server, iframeUrl: url, headers: sourceHeaders })
      }
    }
    if (output.length === 0 && iframeOutput.length === 0)
      throw new Error('MKissa returned no usable source servers. ' + failures.join('; '))
    return [...output, ...iframeOutput]
  }
  entities(value) {
    return value
      .replace(/&quot;/g, '"')
      .replace(/&#(?:39|x27);/gi, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  }
  type(url) {
    return /\.m3u8(?:[?#]|$)/i.test(url) ? 'm3u8' : /\.mp4(?:[?#]|$)/i.test(url) ? 'mp4' : 'unknown'
  }
  async resolve(url, label, referer) {
    if (/^--[a-f0-9]+$/i.test(url || '')) {
      const hex = url.slice(2)
      if (hex.length % 2) throw new Error('Invalid MKissa source encoding')
      url = hex
        .match(/../g)
        .map((value) => String.fromCharCode(parseInt(value, 16) ^ 56))
        .join('')
    }
    if (/^\/apivtwo\/[a-z0-9/]+\?id=/i.test(url)) {
      const endpoint = 'https://filelotion.fyi' + url.replace('?id=', '.json?id=')
      const data = await (
        await this.request(endpoint, {
          headers: { Referer: 'https://filelotion.fyi/' },
        })
      ).json()
      if (!Array.isArray(data.links)) throw new Error('MKissa Default source format changed')
      const videoSources = []
      for (const link of data.links) {
        const media = link.link || link.url
        if (!/^https?:\/\//i.test(media || '')) continue
        const type = link.hls ? 'm3u8' : this.type(media)
        if (type === 'unknown') continue
        videoSources.push({
          url: media,
          type,
          quality:
            String(link.resolutionStr || link.resolution || 'Auto') +
            ' (Default) ' +
            (videoSources.length + 1),
          subtitles: [],
        })
      }
      return {
        headers: {
          Referer: 'https://filelotion.fyi/',
          'User-Agent': 'Mozilla/5.0',
        },
        videoSources,
      }
    }
    if (!/^https?:\/\//i.test(url || '')) throw new Error('Unsupported player URL')
    if (this.type(url) !== 'unknown')
      return {
        headers: { Referer: referer },
        videoSources: [{ url, type: this.type(url), quality: label, subtitles: [] }],
      }
    let html = await (await this.request(url, { headers: { Referer: referer } })).text()
    const videoSources = []
    html += '\n' + this.unpack(html)
    const pattern = /\b(?:file|src|source)\s*[:=]\s*["']([^"']+)["']/g
    let found
    while ((found = pattern.exec(html))) {
      const value = this.entities(found[1].replace(/\\\//g, '/'))
      if (/^https?:\/\//i.test(value) && this.type(value) !== 'unknown')
        videoSources.push({
          url: value,
          type: this.type(value),
          quality: label + ' ' + (videoSources.length + 1),
          subtitles: [],
        })
    }
    return {
      headers: { Referer: url, 'User-Agent': 'Mozilla/5.0' },
      videoSources: videoSources.filter(
        (s, i) => videoSources.findIndex((v) => v.url === s.url) === i
      ),
    }
  }
  unpack(html) {
    const match = html.match(
      /\}\s*\(\s*'((?:\\.|[^'\\])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/
    )
    if (!match) return ''
    const radix = Number(match[2]),
      count = Number(match[3])
    if (radix < 2 || radix > 62 || count > 100000) throw new Error('Unsupported packed player')
    const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\'),
      dictionary = unescape(match[4]).split('|'),
      alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
      lookup = {}
    const token = (n) =>
      n < radix ? alphabet[n] : token(Math.floor(n / radix)) + alphabet[n % radix]
    for (let n = 0; n < count; n++) if (dictionary[n]) lookup[token(n)] = dictionary[n]
    return unescape(match[1]).replace(/\b\w+\b/g, (word) => lookup[word] || word)
  }
}

export default function createProvider(ctx) {
  const mkissa = new MkissaClient()
  const log = ctx.logger
  const authRequired = () => Object.assign(new Error('AUTH_REQUIRED'), { provider: 'mkissa' })
  const isVerification = (err) => err?.code === 'VERIFICATION_REQUIRED'
  const originalGraphql = mkissa.graphql.bind(mkissa)
  mkissa.graphql = async (...args) => {
    try {
      return await originalGraphql(...args)
    } catch (err) {
      if (isVerification(err)) throw authRequired()
      throw err
    }
  }
  mkissa.request = async (url, options = {}) => {
    const { timeout = 25, ...init } = options
    const headers = {
      'User-Agent': 'Mozilla/5.0',
      Referer: mkissa.base + '/',
      Origin: mkissa.base,
      ...(options.headers || {}),
    }
    const response = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeout * 1000),
    })
    try {
      if (url.startsWith(mkissa.api + '/') || url.startsWith(mkissa.base + '/'))
        await MkissaResponse.assertResponse(response, 'mkissa')
      else if (!response.ok) throw new Error(`MKissa request failed: HTTP ${response.status}`)
    } catch (err) {
      if (response.status === 403 && !isVerification(err))
        throw Object.assign(new Error('MKissa verification required'), {
          code: 'VERIFICATION_REQUIRED',
        })
      throw err
    }
    return response
  }
  async function search(options = {}) {
    try {
      return (
        await mkissa.search({
          query: options.query,
          dub: options.mode === 'dub',
          media: {},
        })
      ).map((r) => ({
        _id: r.id,
        id: r.id,
        name: r.title,
        englishName: r.title,
        thumbnail: undefined,
        anilistId: r.metadata?.anilistId,
      }))
    } catch (err) {
      if (err?.message === 'AUTH_REQUIRED') throw err
      log.warn({ err }, 'MKissa search failed')
      return []
    }
  }
  return {
    name: 'MKissa',
    search,
    resolveShowId: async (title, romaji) =>
      ctx.resolveBestShowId(title, romaji, async (q) =>
        (await search({ query: q })).map((r) => ({ title: r.name, id: r.id }))
      ),
    isDirectId: (id) => /^[a-zA-Z0-9]+\|(sub|dub)$/.test(id),
    getEpisodes: async (id, mode = 'sub') => {
      try {
        const normalized = id.includes('|') ? id : `${id}|${mode}`
        const eps = await mkissa.findEpisodes(normalized)
        return {
          episodes: eps.map((e) => String(e.number)),
          availableEpisodesDetail: eps.map((e) => ({
            number: String(e.number),
            title: e.title,
          })),
          description: '',
        }
      } catch (err) {
        if (err?.message === 'AUTH_REQUIRED') throw err
        log.warn({ err, id }, 'MKissa episodes failed')
        return null
      }
    },
    getStreamUrls: async (id, episodeNumber, mode = 'sub') => {
      try {
        const normalized = id.includes('|') ? id : `${id}|${mode}`
        const results = await mkissa.findEpisodeServers({
          id: `${normalized}|${episodeNumber}`,
          url: `${mkissa.base}/`,
        })
        return results.map((result) =>
          result.iframeUrl
            ? {
                sourceName: `MKissa (${result.server})`,
                links: [
                  {
                    resolutionStr: 'iframe',
                    quality: 0,
                    link: result.iframeUrl,
                    hls: false,
                    headers: result.headers,
                  },
                ],
                type: 'iframe',
                actualEpisodeNumber: String(episodeNumber),
              }
            : {
                sourceName: `MKissa (${result.server})`,
                links: result.videoSources.map((s) => ({
                  resolutionStr: s.quality || 'Auto',
                  quality: 0,
                  link: s.url,
                  hls: s.type === 'm3u8',
                  headers: result.headers,
                })),
                type: 'player',
                actualEpisodeNumber: String(episodeNumber),
              }
        )
      } catch (err) {
        if (err?.message === 'AUTH_REQUIRED') throw err
        log.warn({ err, id, episodeNumber }, 'MKissa streams failed')
        return null
      }
    },
  }
}
