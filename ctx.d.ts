// ctx.d.ts — host context injected into provider modules.
// Mirrors dango's createCtx (server/src/providers/remote-loader.ts).
// Convert modules with // @ts-check (see README). No runtime impact.

export interface CtxCache {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown, ttlSeconds?: number): void
}

export interface CtxLogger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
  debug(obj: unknown, msg?: string): void
}

export interface MatchCandidate {
  title: string
}

export interface TitleMatcher {
  buildQueryVariants(title: string, romaji?: string): string[]
  pickBestMatch<TItem extends MatchCandidate>(
    items: TItem[],
    targets: string[],
    minScore?: number
  ): { item: TItem; score: number } | null
}

export interface AnilistResponse<T> {
  data?: T
  errors?: Array<{ message: string }>
}

export interface CtxRequestStore {
  get(key: RequestKey): string | undefined
}

// Exact per-request UA/cookie keys the server populates (see README).
// Missing keys mean the client never sent that header — treat as logged out.
export type RequestKey = 'ua' | 'cookie' | 'jasmr_ua' | 'jasmr_cookie'

export interface RemoteCtx {
  cache: CtxCache
  logger: CtxLogger
  fetchText(url: string, init?: Record<string, unknown>): Promise<string | null>
  fetchJson<T>(url: string, init?: Record<string, unknown>): Promise<T>
  proxyUrl(rawUrl: string, referer: string): string
  userAgent: string
  titleMatch: TitleMatcher
  anilist: {
    request<T>(query: string, vars?: Record<string, unknown>): Promise<AnilistResponse<T>>
    parseMalId(id: string | number): number | null
    searchByTitle(
      title: string
    ): Promise<{ id: number; title?: { romaji?: string; english?: string; native?: string } } | null>
  }
  kitsu: {
    metaByAnilistId(anilistId: number): Promise<unknown>
  }
  tmdb: {
    base: string
    image: string
    get<T>(path: string): Promise<T | null>
  }
  request: {
    get(key: string): string | undefined
  }
  cookies: {
    sanitizeCfClearance(raw: string | undefined | null): string
    buildCfClearanceCookie(raw: string | undefined | null): string
  }
  crypto: {
    aes256CbcDecryptJson(b64url: string, keyUtf8: string, ivUtf8: string): unknown
    hmacSha256Base64Url(key: string, message: string): string
  }
  scraping: {
    fetch(
      urlOrOptions: string | Record<string, unknown>,
      maybeOptions?: Record<string, unknown>
    ): Promise<{ statusCode: number; body: string; headers: unknown }>
  }
  curl: {
    getJson<T>(url: string, headers?: Record<string, string>): Promise<T | null>
    getText(url: string, headers?: Record<string, string>): Promise<string | null>
  }
  cheerio: {
    load(html: string): unknown
  }
}
