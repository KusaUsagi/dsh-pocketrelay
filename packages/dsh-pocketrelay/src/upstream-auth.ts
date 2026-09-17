/**
 * dsh-pocketrelay — upstream browser-session cookie bridge (DSH browserAuth).
 *
 * Modern dsh (`client-connection`) guards the web app behind an
 * authority-bound browser cookie: the index goes through `authorizeIndex` and
 * every `/api` RPC plus the event WebSocket pass a trust check that answers
 * 401 for a trusted-but-unauthenticated request. The host proxies the phone as
 * a plain loopback client, so its requests carry no cookie and the upstream
 * answers 401 — the phone's whole session dies on arrival.
 *
 * This mints, caches, and refreshes the cookie for the loopback authority in
 * process, using the `connection` service's `browserAuth` face, so the token
 * never leaves the desktop. When the running harness has no such service, every
 * accessor returns `undefined` and proxied traffic stays a pass-through.
 */
export interface BrowserConnectionAuthorizer {
  authenticatedUrl?(baseUrl: string): string
  authorizeIndex?(
    request: {
      method?: string
      url?: string
      headers: Readonly<Record<string, string | readonly string[] | undefined>> | Headers
    },
    response: {
      writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
      end(body?: string): unknown
    },
  ): boolean
}

export interface UpstreamCookieAuth {
  cookie(): string | undefined
  refresh(): void
}

const CORDIS_ORIGINAL = Symbol.for("cordis.original")

/**
 * Resolve the `browserAuth` authorizer from a `connection` service value.
 * A cordis `ctx.get` returns a tracing proxy; the raw service owns the
 * `browserAuth` instance, so walk the proxy's `cordis.original` first.
 */
export function resolveBrowserAuthorizer(
  service: unknown,
): BrowserConnectionAuthorizer | undefined {
  if (typeof service !== "object" || service === null) return undefined
  const record = service as Record<PropertyKey, unknown>
  const original = record[CORDIS_ORIGINAL]
  const target = typeof original === "object" && original !== null ? original : record
  const browserAuth = (target as { browserAuth?: BrowserConnectionAuthorizer })["browserAuth"]
  return typeof browserAuth === "object" && browserAuth !== null ? browserAuth : undefined
}

/**
 * Create the upstream cookie owner for a loopback origin.
 * @param origin - resolves the local dsh web origin (e.g. `http://127.0.0.1:3080`).
 * @param connection - resolves the `browserAuth` authorizer, absent on older harnesses.
 * @returns the cookie accessor/refresher (a no-op pass-through when unauthenticated).
 */
export function createUpstreamCookieAuth(
  origin: () => string,
  connection: () => BrowserConnectionAuthorizer | undefined,
): UpstreamCookieAuth {
  let cached: string | undefined

  const mint = (): string | undefined => {
    try {
      const auth = connection()
      if (auth === undefined) return undefined
      if (auth.authorizeIndex === undefined) return undefined
      const tokenUrl = auth.authenticatedUrl?.(origin())
      if (typeof tokenUrl !== "string") return undefined

      let url: URL
      try {
        url = new URL(tokenUrl)
      } catch {
        return undefined
      }

      let cookie: string | undefined
      auth.authorizeIndex(
        { method: "GET", url: url.pathname + url.search, headers: { host: url.host } },
        {
          writeHead(_status, headers) {
            const value = headers?.["set-cookie"]
            // Keep only the `name=value` pair: Set-Cookie attributes (Path,
            // HttpOnly, SameSite, ...) are not valid Cookie-header parts.
            if (typeof value === "string" && value !== "") {
              const pair = value.split(";", 1)[0]?.trim()
              if (pair !== undefined && pair !== "") cookie = pair
            }
          },
          end() {
            // token exchange handled by writeHead; nothing to drain
          },
        },
      )
      return cookie
    } catch {
      // Mint failure degrades to pass-through (upstream answers 401 itself);
      // never let the proxy die just because auth is absent.
      return undefined
    }
  }

  return {
    cookie(): string | undefined {
      if (cached === undefined) cached = mint()
      return cached
    },
    refresh(): void {
      cached = mint()
    },
  }
}
